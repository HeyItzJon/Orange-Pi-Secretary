// scheduler.js
//
// Cadence matched to how fast each source actually changes, instead of v1's
// "everything, every two hours, forever".
//
//   calendar  — a few times a day. Free of AI entirely.
//   email     — a few times a day. Usually free too, because most runs find
//               no new message ids and stop before spending a token.
//   money     — once, after the close.
//   notes     — once a day. It's a filesystem walk.
//   brief     — composed once each morning, plus after any manual refresh.
//
// Times are expressed in your timezone, checked once a minute. No cron
// dependency, no timezone surprises on the Pi.

import { logger } from "./log.js";
import { runSources, buildBrief } from "../brief/compose.js";
import { getMeta, setMeta } from "./store.js";

const log = logger("scheduler");

function localParts(tz, at = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    hhmm: `${p.hour}:${p.minute}`,
    day: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday,
  };
}

/** Has this named job already run today (in local time)? */
async function alreadyRanToday(name, day) {
  return (await getMeta(`ranOn_${name}`, null)) === day;
}

async function recordRan(name, day) {
  await setMeta(`ranOn_${name}`, day);
}

export function startScheduler(config) {
  const tz = config.timezone || "America/Toronto";
  const s = config.schedule || {};

  const pullTimes = s.pullTimes || ["06:30", "12:30", "18:30"];
  const briefTime = s.briefTime || "06:40";
  const moneyTime = s.moneyTime || "17:15";
  const notesTime = s.notesTime || "06:20";

  let lastTick = null;

  async function tick() {
    const { hhmm, day } = localParts(tz);
    if (hhmm === lastTick) return; // same minute, nothing to do
    lastTick = hhmm;

    try {
      if (pullTimes.includes(hhmm)) {
        log.info(`scheduled pull (${hhmm})`);
        await runSources(config, { only: ["calendar", "email"] });
      }

      if (hhmm === notesTime && !(await alreadyRanToday("notes", day))) {
        await runSources(config, { only: "notes" });
        await recordRan("notes", day);
      }

      if (hhmm === moneyTime && !(await alreadyRanToday("money", day))) {
        await runSources(config, { only: "money" });
        await recordRan("money", day);
      }

      if (hhmm === briefTime && !(await alreadyRanToday("brief", day))) {
        log.info("composing morning brief");
        await buildBrief(config, { narrate: true });
        await recordRan("brief", day);
      }
    } catch (err) {
      log.error(`tick failed: ${err.message}`);
    }
  }

  const timer = setInterval(tick, 30_000);
  timer.unref?.();

  log.info(
    `scheduler up (${tz}) — pulls ${pullTimes.join(", ")} · brief ${briefTime} · money ${moneyTime}`
  );

  return () => clearInterval(timer);
}
