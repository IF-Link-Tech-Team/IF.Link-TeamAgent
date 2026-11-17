# Contributing

This repository is a DSH bundle: `src/` is the plugin, `docs/` explains it, `tests/` holds the rules. The test suite is the contract — almost every convention here is enforced by a spec, so read the failure instead of guessing.

## Run it

```bash
pnpm install
pnpm check      # typecheck, then the tests, then the build
pnpm test       # tests only; `pnpm test -- tests/views.spec.ts` for one file
pnpm typecheck  # tsc --noEmit
```

To run a checkout against a real DSH profile, follow [SETUP.md](SETUP.md) or the manual path in [006 Deployment](docs/006-deployment.md). A profile points at this checkout through `cordis.patch.yml`; restarting the profile is what makes a change visible.

## The three tests that fail when you skip the paperwork

| Test | What it refuses |
| --- | --- |
| `tests/docs.spec.ts` | A `src/` file missing from the module table of [007 Architecture](docs/007-architecture.md), a broken local link, a numbered document that links forward |
| `tests/class-docs.spec.ts` | A `class` without a JSDoc block directly above it |
| `tests/locales.spec.ts` | A panel string that exists in one language only, or with different placeholders |

If you add a module, add its row in 007. If you add a class, document it in one sentence that says what it owns. If you add a panel string, add both languages.

## Change a setting

A setting is one field with four ends; touch all of them in one commit.

1. **Schema** — `src/policy.ts`: the field, its default, its bounds, and its description. This is the only place the value is validated.
2. **Effect** — the component that reads it (`src/app/settings.ts` reads blocks; `runtime.ts` wires them; Sources read their own instance).
3. **Panel** — the block in `src/client/eval.tsx`, `execution.tsx`, `source.tsx` or `deployment.tsx`, with a `hint` that says what changes when the value changes.
4. **Test** — one assertion in `tests/settings.spec.ts` (or the component's spec) that fails if the default or the bound drifts.

Persisted settings are versioned: a save carries the revision it was read at, and an older revision is refused rather than merged. Do not add a second place that writes a block.

## Add a Source

[008 Cookbook](docs/008-cookbook.md) walks through it end to end: the kind, its instance schema, its trigger building, its Channel, and the registration. Read it before writing code; a Source that filters in its own `receive` instead of its `scope` is the mistake that document exists to prevent.

## Five invariants

1. **One writer.** Domain aggregates are written by `Engine` and its parts only. Application code sends commands; it never mutates a Ticket or a Thread.
2. **Core does no I/O.** `src/core` imports nothing outside itself but Node's hashing. Time, network, files and the database live behind ports at the boundary.
3. **A Source filters once, in `scope`.** Live events, history pages and polls go through the same rule. Never drop a Trigger in `receive` and again in the Policy.
4. **Fewest concepts.** A new business need is a field or a rule, not a new entity. `SourceKind` carries runtime facts; panel descriptions do not belong on it.
5. **Events are facts.** A domain event records what happened. Whether a person is told is a consumer's decision, not the emitter's.

When a change seems to need an exception to one of these, write the reason in the commit message. Three of the refactors in 2026 came from exactly that: the exception was the bug.

## Do not

- **Change `package.json` `name`, the bundle id, or the profile name.** Client loaders, installed profiles and state directories all key off them. A rename is a migration, not a text edit.
- **Rename a persisted field without migrating.** Settings, KV keys and stored JSON outlive a release. Read the old name once, write the new one, and delete the reader a release later (see `KV.legacy`).
- **Let an adapter hold a rule.** `app/commands.ts`, HTTP handlers and tools parse arguments, name the origin and map errors. The decision itself belongs to `Engine`.
- **Mix a rename with a behavior change.** A rename commit changes no `if`.

## Commits and review

One concern per commit or PR: a rename, a move, a fix, a feature. A rename that also changes behavior cannot be reviewed, and reverting it takes the behavior with it.

Name the commit for what changed and why, in the repository's language (Chinese for this team's work, English for upstream-facing changes). If the change touches a persisted shape or a public interface, say how an existing deployment keeps working.
