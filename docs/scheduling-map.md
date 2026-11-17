# Scheduling map: where this bundle reads the clock

Card 8 of the cleanup plan asks for one `Clock`. Before adding one, this map lists every place that reads time, what it reads it for, and which seam it should use. The rule it applies: **a clock is worth injecting where a test needs to decide the time, not everywhere `Date` appears.**

## The five kinds of time read

| Kind | What it does | Persisted? | Seam today |
|---|---|---|---|
| 1. Domain timestamps | `createdAt`, `updatedAt`, `ended.at`, report and decision times written by the Engine's parts | Yes, in SQLite | `Engine` options `now`; parts call `now()` |
| 2. Windows and labels | "the last hour", `dayAgo`, `today`, "N minutes ago" in views and cards | No | `Date.now()` / `new Date()` at the call site |
| 3. Poll cursors and cadences | GitHub `since`, Feishu history cursors, the Scheduler's tick and next-fire time | Cursors yes, cadence no | Source-local, mostly passing `now` into pure helpers |
| 4. Retries, backoff, cooldowns | Effects retry delays, ModelRouter cooldown and probe, Outbox pacing | Attempt counts only | `Date.now()` and `setTimeout` |
| 5. Record metadata | Settings `savedAt`, receipt `dropped.at`, health `at` | Yes, human-facing | `new Date().toISOString()` |

## Where each one lives

**Kind 1 — one seam already exists.** `src/core/part.ts` reads `this.options.now?.() ?? new Date().toISOString()`. Every aggregate write goes through it, so a test that needs a fixed domain time passes `now` to `Engine`. Nothing else should decide a domain timestamp.

**Kind 2 — keep as it is.** `src/app/views/*`, `src/client/text.ts` and `src/app/cards.ts` turn a timestamp into words at render time. A test that needs a stable "3 hours ago" already passes the reference time to the formatter; injecting a clock here would add a parameter to every call for no new behaviour.

**Kind 3 — each Source owns its own.** `src/sources/github.ts` (cursors), `src/sources/feishu/{history,threads,topics}.ts` (sweep windows), `src/sources/scheduler.ts` (tick, grace, next fire). Their pure helpers (`scheduler-job.ts`) already take `now`, which is what makes the rules testable; the loops read `Date.now()` once per pass and hand it down. The Scheduler is the one that would benefit from an injected clock, because its `setInterval` is the only timer whose cadence a test cannot shorten.

**Kind 4 — leave wall-clock.** `Effects` retries, `ModelRouter` cooldown and probe, and `Outbox` pacing are tested with fake timers; a Clock there would duplicate what the test harness already controls, and would make a retry's real elapsed time depend on a caller. **This is the part of the plan that should not be built**: a Clock threaded into the retry path is a clock that can lie about how long a provider was failing.

**Kind 5 — leave wall-clock.** These are audit facts about when a row was written. A fake value here would make the history wrong.

## The decision

1. **Do build** `src/app/clock.ts`: `interface Clock { now(): number }` and `systemClock`, constructed by `Runtime` and passed to `Engine` as `now`. It replaces the implicit default with an explicit, testable seam and nothing else changes.
2. **Do not build** a clock service, a `ctx.clock`, or a global. Two components that need the same time should receive the same value, not fetch it from a singleton.
3. **Do not thread** a clock into `Effects`, `ModelRouter`, `Outbox`, or the Sources' loops. Their time is either tested with fake timers (kind 4) or owned by a Source whose pure helpers already take `now` (kind 3).
4. **The Scheduler**, if it ever needs a shorter tick in a test, gets `tickMs` as a constructor option of its loop, not a Clock. A cadence is configuration, not time.

## Consequences for card 8

The card shrinks to: one small module, one wiring line in `Runtime`, and the note above about what not to do. The high risk the plan assigned to it came from imagining a Clock everywhere; at the seam it is worth having, it is twelve lines.
