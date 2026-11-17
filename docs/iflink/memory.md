# Team memory: layers, writers, reads

更新：2026-11-17 · 两份 11-09 的记忆设计稿合并为此文，事实按当前代码与运维脚本核对

Team memory is the small set of facts an agent needs before it decides anything: who the team is, what each
project line is doing now, and what happened when. It is not a transcript archive — messages, ticket reports
and decisions stay in SQLite and are searched, not copied.

## 1. What it is

Four layers. The two files that hold shared memory have exactly one writer.

| Layer | Holds | Lives in | Written by | Read by |
|---|---|---|---|---|
| L0 raw facts | every received message, Trigger, Ticket, Decision, Outbox entry | `orchestrator.sqlite` | Sources and Engine, automatically | anyone, by search |
| L1 drafts | what one Ticket learned that the next one needs | `memory/drafts/inbox/` | that Ticket's worker, once | Dreaming only |
| L2 long-term memory | conventions, project state, reusable skills | `memory/TEAM.md`, `memory/PROJECTS.md`, `skills/` | **Dreaming**, plus a worker adding a skill | main Session on demand; workers from their snapshot |
| L3 timeline | what happened in one window | `memory/journal/` | **Dreaming only**, history backfill included | search, or a direct read |

**TEAM and PROJECTS have one writer.** Every failure this design fixed came from breaking that rule: five
Tickets appending to one journal entry in a week, and two files pinned at their character limit with a Ticket a
day re-wording them to save five characters.

Small wins: in the Anthropic study we borrowed from, ten memory files of 43k characters earned 4 badges and 413
files of 978k earned 1; TEAM plus PROJECTS is about 8k characters — one read at the start of a Ticket, no index
file needed.

## 2. Storage and writers

```text
~/TeamAgent/ops/                      # the ops repository, outside dsh-superagent
├── memory/
│   ├── TEAM.md  PROJECTS.md  HEADINGS.md  DRAFT.md  README.md
│   ├── journal/2026-11-11_11-12.md   # one file per window, append-only
│   ├── drafts/inbox/<ticket8>-<title>.md
│   ├── drafts/.consumed/<window>/    # archived only after a successful Dreaming run
│   ├── .versions/<stamp>/memory/…    # pre-write snapshots
│   ├── .journal/<stamp>.diff|.json   # what each commit changed, and by whom
│   ├── .rejected/<stamp>.log         # commits stopped by the injection scan
│   ├── .dreams/<window>/report.md    # what a run changed, dropped or left open
│   └── .retired/                     # retired rules, kept for reference
└── skills/<name>/SKILL.md
~/TeamAgent/.dream-state/last         # cursor of the last successful run
```

`memoryDir` is deployment config (`src/deployment.ts`), defaulting to `<stateDir>/memory`; here it points at
`~/TeamAgent/ops/memory`. Changing it is a deployment change — the memory files have to move with it.

| File | Holds | Limit (chars) | Writer |
|---|---|---|---|
| `TEAM.md` | organisation, conventions, who owns what, where information lives | 2,000 | Dreaming |
| `PROJECTS.md` | each project line's **now**: stage, owner, milestone, deadline, risk, key links | 8,000 | Dreaming |
| `journal/<start>_<end>.md` | decisions, numbers, reasons, disagreements, who said it | 1,500 for a two-day window, 2,400 longer | Dreaming |
| `HEADINGS.md` | canonical headings, aliases, status, change log | 4,000 | Dreaming; merging or deleting a line needs a person |
| `drafts/inbox/<ticket8>-<title>.md` | one Ticket's findings, staging only | 8,000 (rule, not enforced) | that Ticket's worker |
| `skills/<name>/SKILL.md` | one reusable procedure: when to use it, how, where it hurts | 12,000 | worker creates, Dreaming merges |
| `PEOPLE.md` | optional collaboration preferences; not present today | 1,500 | Dreaming |

Who may write what:

| Who | May write | Cannot |
|---|---|---|
| Ticket worker | one draft in `drafts/inbox/`; a new skill, or a few lines of an existing one | `TEAM.md`, `PROJECTS.md`, `journal/`, other skills |
| Dreaming | `TEAM.md`, `PROJECTS.md`, `journal/`, `HEADINGS.md`, merging skills | raw L0; moving drafts, which the script archives |
| a person | anything, directly | — |
| `memory-commit.sh` | only the complete file it is handed, after its checks | drafts, which never go through it |

A Ticket cannot fix memory because it has no global view and ends when it ends; it writes a draft and the next
cycle decides. That is the whole point of the split.

One fact, one place — the three files are three views, not three sizes:

| File | View | Holds |
|---|---|---|
| `TEAM.md` | long-lived | organisation, conventions, owners, where information lives |
| `PROJECTS.md` | **now** | stage, owner, current milestone and deadline, risk, key link per project line |
| `journal/` | **then** | one time point's decisions, numbers, reasons, disagreements, source links |

The test: "will this change by next period?" → PROJECTS. "Is this one point in time?" → journal. The same
decision leaves a conclusion plus a pointer in PROJECTS and the process plus evidence in journal.

Keeping it small is three actions, not a character budget:

| Action | Rule |
|---|---|
| replace | one fact appears once; an update rewrites that line, never appends a second copy |
| sink | process, reasons and number detail go to journal; PROJECTS keeps the conclusion and a pointer |
| delete | expired, finished and superseded lines are removed, not archived |

Dreaming also checks shape: the three longest PROJECTS sections must stay under 50% of the file and no single
section over 1,200 characters, or the low-heat ones become one line plus a pointer.

Entry format, one fact per line so it can be replaced alone:

```markdown
## 项目｜第二课堂
- 阶段：项目制试点，3 个班在跑（确认于 2026-11-05，来源：工单 db749f9b）
- 负责人：…
- 待办：2026-11-28 出结项报告
- 风险：排课与教务系统冲突，未定
```

- last confirmed date and source on every line that can go stale;
- only what holds across sessions — one-off progress stays in the Ticket report;
- uncertain facts say `未确认`, never a guess phrased as fact;
- no transcripts, no judgement about people, no credentials.

## 3. Reads and search

### Read order

Starting a Ticket is a fixed action, not "read when needed":

1. `memory/TEAM.md` in full — about 2k characters of hard conventions.
2. `memory/PROJECTS.md` — `grep -n "^## " memory/PROJECTS.md` first, then read the 1–2 sections this Ticket touches.
3. History: `orchestrator_read journal` for the entry list, then 1–2 entries; or `grep -rn "词" memory/journal/`.
4. Nothing readable means proceed as if there is no memory. Never guess.

Journal has no index file: the list is computed from file names and each file's first `# ` heading, so there is
nothing to keep in sync.

### Resources

Code: `src/app/resources.ts`. Both roles read these: the main Session reads the live directory, a worker reads
`memory/…` from its snapshot while `journal/…` is the live entry.

| Resource | Returns |
|---|---|
| `memory` | `{ files: [{ file, chars, updated, read }] }` for every `*.md` directly in the memory directory |
| `memory/<file>` | one file as a page: `total_chars`, `next_offset`, `text` |
| `journal` | `{ entries: [{ file, title, chars, updated, read }] }`, newest first |
| `journal/<file>` | one entry, same pagination |

A page is 4,000 characters by default, so an 8,000-character PROJECTS takes two calls; follow `next_offset`
instead of re-reading from zero. Served names must match `^[A-Za-z0-9_-]+\.md$` — no subdirectory, no `..`.
A missing memory directory is an empty list, not an error: memory is optional and saying so beats failing.

### What the heartbeat parses

The daily beat never reads the whole memory. It builds a 600-character card (`src/sources/scheduler-job.ts`)
from a few machine-readable shapes:

| Block | Source |
|---|---|
| `## 未决草稿` | up to two drafts and their unresolved item |
| `## 要回来跟进` | draft follow-ups whose date has come, up to three |
| `## 临近截止` | `- 待办：` / `- 风险：` / `- 截止：` lines from PROJECTS within ±7 days, up to three |
| `## 记忆 N 前有更新` | TEAM, PROJECTS or HEADINGS changed since the last beat; detail stays behind `orchestrator_read memory` |

The date must follow the colon directly — `- 待办：2026-11-16 …`. A date mentioned elsewhere in the line is
evidence, not a deadline. Nothing else in memory is parsed by code; the rest is prose for a reader.

### Search

```text
orchestrator_search { query, in?, limit? } → { matches: [{ kind, ref, at, snippet, read }] }
```

| Field | Values |
|---|---|
| `in` | `ticket`, `trigger`, `decision`, `journal`; omit to search all four |
| `limit` | 1–50, default 10 |
| `read` | the resource for `orchestrator_read`, such as `ticket/ab5e94f2` |

Snippets are for choosing; the record is read separately, so a long report never lands in context twice.

- **Main Session only.** Workers have no search tool; they read the snapshot or grep the ops directory.
- Index: `search_fts`, FTS5 with `tokenize='trigram'`, columns `body`, `kind`, `ref`, `at` (`src/app/store.ts`).
- Indexed text: the trigger's text, a ticket's title plus its last report summary, a decision's reasons, and a
  journal entry whole.
- Three characters or more: the query is quoted as one phrase, ranked, and the snippet is marked with `[` `]`.
  Shorter queries cannot match a trigram, so they scan for the substring and order by time instead of rank.
- Tickets, Triggers and Decisions are indexed in the same transaction that writes them. On open, a migrated
  database or an indexed-vs-row count mismatch rebuilds the whole index.
- Journal entries are re-indexed before each search when files changed by name, size or mtime. No timer, no daemon.
- FTS syntax in user text is searched for, not interpreted: quotes are doubled before the match.

Where to look:

| Question | Go to |
|---|---|
| What was decided or concluded | `orchestrator_search` |
| What was actually said | `lark-user im +messages-search` |
| How a project line evolved | `memory-timeline.sh` |

### Timeline

`~/TeamAgent/ops/scripts/memory-timeline.sh <word> [--brief]`

- Resolves the word against `memory/HEADINGS.md`: canonical heading plus every alias, longest match wins.
- Prints the matching journal sections in date order; `--brief` prints only date and heading.
- `HEADINGS.md` holds 17 project lines, 7 group lines and a catch-all `其他`, one row each:
  heading | aliases | status | note, plus a change log. A rename moves the old name into aliases and adds a log
  line; old entries are never edited. Merging two lines or deleting a row needs a person.
- `memory-timeline.sh 词来` also finds entries written as 中转站; `memory-timeline.sh "VIA 黑客松"` reaches the
  April records of IF.Land.

## 4. Limits and the commit gate

`~/TeamAgent/ops/scripts/memory-commit.sh` is the only accepted way to write shared memory. It takes a
complete new file, never a patch:

```bash
~/TeamAgent/ops/scripts/memory-commit.sh \
  --file memory/PROJECTS.md \
  --from /tmp/PROJECTS.md \
  --source dream/2026-11-15_11-16 \
  --reason "合并 5 份草稿：IF.Light 赛程、词来计费、展板"
```

`--source` is mandatory; it and an optional `--reason` are recorded. Accepted paths are `memory/*.md`,
`memory/journal/*.md` and `skills/<name>/SKILL.md`; anything else, or a `..`, exits 4 before any scan.

| # | Check | On failure |
|---|---|---|
| 1 | diff the target against the new file; scan **added lines only** | exit 2; matched lines echoed and appended to `.rejected/<stamp>.log` |
| 2 | character limit for that path | exit 3; the current file echoed back, so the caller merges instead of appending |
| 3 | snapshot the old file to `.versions/<stamp>/<path>` | — |
| 4 | write through a temporary file and `mv`; record `.journal/<stamp>.diff` and `.json` | exit 5 |

The scan rejects one line at a time, each with a reason: wording that grants the Agent authority or drops human
confirmation, "ignore previous instructions", unconditional acceptance of requests, identity override
(`你现在是…`, `system prompt`), credentials (`sk-…`, private keys, `password:`), long base64 blobs, invisible
characters. Constraints on people are fine; permissions for the Agent are not.

`.journal/<stamp>.json` records `at`, `file`, `source`, `reason`, `chars` and `limit`; its `.diff` holds the
changed lines the daily digest prints. `.versions/` keeps one file snapshot per commit: `--list` shows stamps and files,
`--rollback <stamp>` restores every file in that stamp. The gate has its own eight-case test script,
`~/TeamAgent/ops/scripts/test-memory-commit.sh`, which runs on a temporary root and never touches real memory.

A person may edit the files directly; the next commit snapshots whatever is on disk. There is no approval step.

## 5. The ticket snapshot

| Question | Answer |
|---|---|
| What | a copy of `TEAM.md`, `PROJECTS.md` and, when present, `PEOPLE.md` |
| Where | `workspace/<ticket>/memory/`, beside the Ticket's own files |
| Who | the runtime, once, while the workspace is prepared |
| Does it change | no — the copy is never refreshed for the life of the Ticket |
| Missing directory | the Ticket gets no snapshot and still starts |
| What it buys | premises do not drift mid-Ticket, and you can see afterwards what it read |
| Conflict | the live `memory/` wins; read it when the snapshot and the facts disagree |

`SNAPSHOT_FILES` and `copyMemory` live in `src/executor/workspace.ts` and are shared by every worker runtime.
Not copied: `journal/`, `drafts/`, `HEADINGS.md`, `DRAFT.md`, `.versions/`. A worker that needs history reads
journal entries through `orchestrator_read journal`, greps `~/TeamAgent/ops/memory/journal/`, or runs
`memory-timeline.sh`; it has no `orchestrator_search`.

The snapshot is at most one cycle stale, by design: only Dreaming writes L2, and only at a window boundary, so
a Ticket can no longer read a file that someone else is halfway through changing.

## 6. Cadence and the Dreaming run

| Period | Range | Granularity | Produced by |
|---|---|---|---|
| history | 2026-04-01 – 11-08 | one entry per week, 32 entries | the retired journal profile, history mode |
| now | from 2026-11-09 | one entry per two days, 4 entries so far | Dreaming |

The file name is the window itself — `2026-11-11_11-12.md`, never an ISO week number. The journal profile,
the four `journal-*.sh` scripts, their three systemd units and `.journal-state/` are retired; `dsh --profile
journal` no longer starts. `dream.sh` under `--profile dreamer` is the single scheduled writer, fired by
`teamagent-dreaming.timer` at 08:30, and the script decides whether two days have actually passed.

```text
window = [.dream-state/last + 1 day, today]
fewer than 2 days since the last run → do nothing
an entry already covers the window   → do not rewrite it; merge drafts and tidy skills only
round finished                       → archive drafts, advance the cursor
round failed                         → keep drafts and cursor; the next run retries
```

Only a successful round advances `.dream-state/last`, so a failure costs a retry, never data.

Inputs: drafts (read up to 40k characters), group messages from the local `trigger` table via
`memory-messages.sh <from> <to>` (no Feishu API), TEAM and PROJECTS in full, the last two journal entries,
`HEADINGS.md`, the skill list and the previous `.dreams/<window>/report.md`. Documents, minutes and private
chats still come through `lark-user` (`docs +fetch`, `minutes +detail`, `im +chat-list --types p2p`), and only
the parts with a person, a date, a decision or a number survive the filter — chatter, emoji, bot noise and
threads without a conclusion are dropped.

Six actions: correct every draft against the source → promote stable facts and current state → write the
window's journal entry → keep sections small → tidy skills → archive drafts and patch Tickets that wrote none
into `patched.md`, with a human-readable `report.md`. Conflicting facts resolve in this order: the latest
first-hand material, then the latest meeting notes, then the old memory line.

Keep the cap the journal runs learned: ≤40 `lark-user` calls, ≤5 documents and ≤5 minutes per window,
transcripts only to settle a conflict. `dream.sh` also holds a run to 5,400 seconds; needing more is a sign the
window was too wide.

Drafts:

- one file per Ticket, flat: `drafts/inbox/<ticket8>-<title>.md`; template `drafts/_TEMPLATE.md`, rules
  `DRAFT.md`, limit 8,000 characters;
- sections: 值得留下的 / 我原来想错了 / 下次能复用的做法 / 没解决 / 要回来跟进 / 建议改动;
- write when completed, definitely when blocked (where it stuck, what was missing, who can unblock), usually
  nothing for dropped;
- dated follow-ups under `## 要回来跟进` reach the heartbeat once due; anything longer than two days also goes
  into 建议改动 as `- 待办：2026-11-16 …`;
- drafts bypass the gate — staging, not shared memory — and no Ticket ever reads another Ticket's draft;
- `dream.sh` archives inbox to `.consumed/<window>/` only after a successful round; nothing prunes those files
  yet, so the 30-day retention is a rule rather than a script;
- if the inbox is not writable, a `draft.md` in the Ticket directory is collected on the next run.

Journal entries:

- headings come only from `HEADINGS.md`, one dated fact per line (`- 11-04 初评公示，80 队进复评`), no empty
  sections, no evaluation, no process;
- 1,500 characters for a two-day window; over the limit the gate refuses the write and the entry is rewritten,
  never truncated;
- append-only: a correction goes into the next entry or PROJECTS, never into an old file.

Skills:

- flat, `<root>/<name>/SKILL.md`, discovered at exactly two levels — no subdirectories, so grouping is by name;
- name by family (`feishu-*`, `iflink-*`, `newapi-*`), description = family + when to use + what it delivers +
  one pitfall, because the first 60 characters decide whether a model picks it;
- a worker may add one or fix a few lines; merges and retirements are proposed in the report and executed by a
  person.

## 7. Known limits and what it does not do

| Limit | Detail |
|---|---|
| One writer means delay | a Ticket cannot fix a stale PROJECTS line; it writes a draft and waits for the next cycle (≤2 days) |
| The snapshot goes stale | up to one cycle old by design, never refreshed mid-Ticket |
| Reads are paged | 4,000 characters per call; an 8,000-character PROJECTS needs two |
| Short queries are slower | under 3 characters search scans substrings and orders by time, not rank |
| Journal is immutable | a correction goes into the next entry or PROJECTS; old entries are never edited |
| Drafts are write-once | workers never read them, so half-checked facts cannot flow back |
| Headings need a person | merging two lines or deleting a row is manual; automatic renames must leave a change-log line |
| Skills are flat | discovery is exactly `<root>/<name>/SKILL.md`; no subdirectory, so grouping relies on name and description |
| Destructive skill work is proposed | merges and retirements go into the report, a person executes them |
| The monitor is partial | the daily digest lists yesterday's commits (time, source, file, changed lines) and the rejected-commit count; it does not watch draft backlog or the memory ratio |

Not doing:

| Not done | Why, and when to revisit |
|---|---|
| An injection layer or a `MEMORY.md` index file | ≈8k characters fits one read, and in a sample of 11 Tickets all 11 read their snapshot — reading was never the problem. Revisit above 15,000 characters, or when PROJECTS must split into ≥3 files |
| Vector or semantic search | keyword search is enough at this volume; revisit when different wordings for the same thing really lose matches |
| An LLM summary of search results | snippets plus ids are cheaper and let the model choose what to read |
| Memory inside Eval | admission has to stay predictable |
| Mutable text in the system prompt | prefix cache: one byte changed at the top invalidates the whole prefix; only a fixed pointer to `memory/` belongs there |
| A worker writing shared memory | even one line |
| A Ticket writing a journal entry | one window, one entry, one writer |
| Unattended merging or retiring of skills | proposed in the report, executed by a person |
