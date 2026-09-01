// scheduler.js
//
// Every source, every 15 minutes.
//
// The old cadence — calendar and email three times a day, money once after
// the close — was built for a panel on a shelf that you glanced at twice a
// morning. For something you open on your phone between classes, a number
// that's six hours old is worse than no number, because it looks current.
//
// What that costs, per day: 96 calendar pulls (free), 96 email pulls (almost
// always free — the message ids haven't changed so nothing is fetched), 96
// Yahoo batches (free), 96 filesystem walks (free). The model is the only
// thing that costs money, and it is not on this clock: priorities are cached
// against a hash of the open work, so it only runs when the work itself
// changes. Typically a handful of times a day.
//
// Times are checked in your timezone. No cron dependency, no timezone
// surprises when this moves to the Pi.

import { logger } from "./log.js";
import { runSources, buildBrief } from "../brief/compose.js";
import { getMeta, setMeta, prune, bumpRemindCounts } from "./store.js";
import { SOURCES } from "./sources.js";

const log = logger("scheduler");

function localParts(tz, at = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(at).map((x) => [x.type, x.value])
  );
  return {
    hhmm: `${p.hour}:${p.minute}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    day: `${p.year}-${p.month}-${p.day}`,
  };
}

export function startScheduler(config) {
  const tz = config.timezone || "America/Toronto";

  let lastTick = null;
  let running = false;

  async function tick() {
    // Read fresh every tick (20s) rather than hoisting once at startup —
    // round 53's System page can change config.schedule.pullEveryMinutes
    // live (POST /api/config/pull-frequency, see server.js), by editing
    // the same config object in place. Re-reading here is what makes that
    // take effect within a tick or two instead of needing a restart.
    const s = config.schedule || {};
    const every = Math.max(1, s.pullEveryMinutes ?? 15);
    const briefTime = s.briefTime || "06:40";

    const { hhmm, minutes, day } = localParts(tz);
    if (hhmm === lastTick) return;
    lastTick = hhmm;

    // A slow pull must never stack on top of the next one. Yahoo going quiet
    // for 90 seconds shouldn't queue six overlapping refreshes behind it.
    if (running) { log.warn("previous pull still running — skipping this slot"); return; }

    const due = minutes % every === 0;
    const briefDue = hhmm === briefTime && (await getMeta("ranOn_brief", null)) !== day;
    if (!due && !briefDue) return;

    running = true;
    try {
      if (due) {
        await runSources(config, { only: SOURCES });
        // Recompose so the API serves the new data immediately, but don't pay
        // for a narration line every quarter hour.
        await buildBrief(config, { narrate: false });
      }
      if (briefDue) {
        log.info("composing morning brief");
        await buildBrief(config, { narrate: true });
        await setMeta("ranOn_brief", day);
        // Once a day, piggybacked on the brief slot rather than its own
        // clock — a hygiene sweep doesn't need to run every 15 minutes, and
        // this is the one guaranteed once-a-day moment. (This used to only
        // ever run from the manual `npm run brief`/run-once.js path via
        // runFullCycle — never from the actual always-on scheduler, so
        // config.brief.retainDays silently did nothing on a live server.)
        const removed = await prune({
          maxAgeDays: config.brief?.retainDays ?? 90,
          brightspaceMaxPastDays: config.brightspace?.maxPastDays ?? 14,
        });
        if (removed) log.info(`daily prune: removed ${removed} stale item(s)`);
        // Once-a-day reminder bump for Tracked items — see lib/store.js's
        // bumpRemindCounts() for why this lives here (once a day, not on
        // every page read) rather than inside buildTracked() itself.
        const bumped = await bumpRemindCounts(day);
        if (bumped) log.info(`daily remind bump: ${bumped} tracked item(s)`);
      }
    } catch (err) {
      log.error(`tick failed: ${err.message}`);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, 20_000);
  timer.unref?.();
  tick();                                   // don't wait up to 15 min after a restart

  const bootEvery = Math.max(1, config.schedule?.pullEveryMinutes ?? 15);
  const bootBriefTime = config.schedule?.briefTime || "06:40";
  log.info(`scheduler up (${tz}) — all sources every ${bootEvery} min · brief ${bootBriefTime}`);
  return () => clearInterval(timer);
}
