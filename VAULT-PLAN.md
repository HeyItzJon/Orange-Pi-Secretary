# Bringing the vault in properly

**The four sources, and that's the whole list:**

| Source | What it gives | Status |
|---|---|---|
| **Gmail** | mail that matches your rules | working |
| **Google Calendar** | your 7 calendars | working |
| **Finance** | holdings, prices, rules | working |
| **Obsidian vault** | *currently only one narrow thing* | **barely started** |

Nothing else gets added as a source. Everything from the integrations list —
weather, transit, Brightspace, push — either feeds one of these four or is a
delivery channel. Four is the whole surface area.

---

## What the vault does today (and why it felt like noise)

Right now it does exactly one thing: find notes in `Areas/Projects`,
`Projects` and `Areas/Finances` that have unfinished `- [ ]` tasks and haven't
been edited in 10+ days, then show the first task as a "loose thread."

That's a nag, not an integration. It reads file *timestamps*, not file
*content*. It can't see a due date, a tag, or a priority, because it never
looks for them. That's why "notes" didn't mean anything to you — it was
surfacing the fact that a file was old, which is rarely the interesting thing.

---

## The shift: read structure, not timestamps

You already encode meaning in your vault — folders, tags, task syntax,
frontmatter. The system should read what you already write rather than ask you
to adopt anything new.

Everything below flows into the **same item pipeline** as email and calendar,
which means it gets categories, domains, ranking, memory, and Done/Later for
free. No new UI, no new concepts.

---

## Tier 1 — the three that matter

### 1. Dated tasks become real items · ~3 hours

If you write due dates in tasks — either Obsidian Tasks syntax
(`- [ ] Draft lab report 📅 2026-09-02`) or Dataview inline fields
(`- [ ] Draft lab report [due:: 2026-09-02]`) — those become **dated items**
with urgency, escalation and a place in the right lane.

This is the big one. It converts the vault from "here's an old file" into a
genuine deadline source that sits alongside your calendar. It's also the
foundation for syllabus parsing writing its output somewhere useful.

**Worth deciding:** which syntax you want to standardise on. I'd suggest
Obsidian Tasks' emoji format if you use that plugin, plain `[due:: date]` if
you don't. Either is a one-line parser change; mixing both is fine too.

### 2. Tags route to lanes · ~1 hour

A note or task tagged `#work`, `#school`, `#uav` routes to that lane directly,
overriding folder inference. You get explicit control when the folder is
ambiguous, and it costs you nothing because you already tag.

Config gains a `tagRoutes` map: `{"#uav": "projects", "#coop": "career"}`.

### 3. The brief writes itself into the vault · ~2 hours

Each morning, append the brief to your daily note (or a
`Areas/Briefs/2026-08-19.md`). Three things fall out of this:

- **It's on your phone already** — Obsidian Sync does the delivery, so you get
  mobile access with zero new infrastructure and no push service.
- **It's searchable history** — "what was I worried about in September?"
- **It's linkable** — you can `[[link]]` from a brief item into the project note.

Cheapest possible mobile story. Worth doing before ntfy, honestly.

---

## Tier 2 — once Tier 1 is bedded in

### 4. Frontmatter promotes a note into the brief · ~2 hours

```yaml
---
status: active
domain: projects
due: 2026-09-15
---
```

Any note with `status: active` becomes a tracked item. This is the deliberate
version of #1 — you decide what the system watches instead of it guessing from
mtime. Ideal for "this project is live right now, keep it in front of me."

### 5. A real Projects lane · ~2 hours

Instead of one stale task per note, each active project note contributes a
single item showing **what it's waiting on** — the next unchecked task, plus
how many remain. `UAV airframe · next: order carbon spar · 6 open`.

That's a project dashboard, and it's what the Projects lane should have been.

### 6. Capture from the brief back into the vault · ~2 hours

A "→ vault" button on any row appends it to today's daily note with a link
back to the source. Closes the loop: things you see in the brief can become
things you think about in the vault.

---

## Tier 3 — later, if it earns it

- **Linked context** — an email mentioning `MSE 3401` or `UAV` links to the
  matching vault note, so the brief row carries your own notes with it.
- **Reading queue** — `#toread` notes surface one at a time when a lane is
  quiet, rather than never.
- **Investment notes** — your `Areas/Finances/Investments` notes already hold
  ACB and thesis per holding. The Finance lane could show *your own thesis*
  next to a price move, which is far more useful than the price move alone.

That last one is the sleeper. You already write down why you own things; the
dashboard currently doesn't know.

---

## What I'd change first

**#3 (brief → daily note), then #1 (dated tasks), then #2 (tags).**

#3 first because it's the cheapest path to having the brief with you when
you're not at the laptop, and it uses infrastructure you already pay for.
#1 second because it's the one that makes the vault genuinely load-bearing.

About six hours for all three.

---

## Two questions before I build any of it

1. **Do you use the Obsidian Tasks plugin**, and if so do you write dates as
   `📅 2026-09-02`? That decides the parser.
2. **Where should the brief land** — appended to your existing daily note, or
   its own `Areas/Briefs/` folder? Appending is friendlier if you already keep
   daily notes; a separate folder is cleaner if you don't.
