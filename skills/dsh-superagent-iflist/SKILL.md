---
name: dsh-superagent-iflist
description: 把一条飞书消息整理成一张 Plane 工作项确认卡；只做任务管理，不执行任务。
---

# IF.List task intake

IF.List is a **task-management** channel, not an execution agent. Your only job is to turn one message into
one Plane work item, then let the person confirm it. Do not do the requested work, do not research/design/
code/write it, do not open its links, and do not load a task-specific skill.

## One command

For an IF.List ticket, the relay carries `trigger.from` (union_id), `trigger.chat`, `trigger.addressed`,
`trigger.date` and (when available) `trigger.source_url`. Run the wrapper once:

```bash
iflist-propose \
  --ticket "<ticket id>" --title "<short action/outcome>" --project "<IDENTIFIER|name>" \
  --from "<trigger.from>" --chat "<trigger.chat>" --addressed "<trigger.addressed>" \
  --date "<trigger.date>" \
  --to "<names or ids, comma-separated; omit if unknown>" \
  --invite "<people to add to the project, comma-separated; optional>" \
  --start today|tomorrow|YYYY-MM-DD|none --due YYYY-MM-DD|none \
  --priority none|low|medium|high|urgent \
  --why "<1–3 sentences of context; include the source link if present>"
```

It fills owner/chat/direct/date and runs `iflist task propose --form` once. Do **not** call `whois`,
`project list`, `project people` or `task get` first; the service resolves them.

## Fields

- **Title**: summarize what the work item is, as a short action/outcome. Keep out dates, people, priority,
  project name, links, rationale and parenthetical explanations; no plan, no “我要”.
- **Project**: the project named or clearly implied; if genuinely unclear, leave the card for the person.
- **Assignees**: zero/one/several project people. Use `self`/the requester only for “我要/我来/帮我”;
  use named people when named; otherwise omit. Never add extra people by default.
- **Project invitees**: only people explicitly asked to join the project; pass `--invite`. They are not assignees
  unless also selected as such. The card keeps this as free text, and confirmation adds logged-in people best-effort.
- **Start / due**: only stated dates; due >= start. “今天/明天/两天后/下周三” are relative to
  `trigger.date` (Asia/Shanghai).
- **Priority**: only stated; 次高=high, 最高/紧急=urgent, 中等=medium, 低=low.
- **Description**: only the details that do not belong in the title: context, scope/constraints, source link,
  and one or two sentences clarifying an ambiguous reference. Fill only what is obvious from the message or
  thread; never plan the work, invent acceptance criteria, or repeat the title. Omit it if there is nothing
  beyond the title.
- **Source**: when `trigger.source_url` exists, pass `--source "<url>"` so the Plane item links back.
- **Detail is not a second title**: if the description would only paraphrase the title, leave it empty.

## Administrative requests

Only when a person explicitly asks to **create a project, cycle or module**, not as an execution task:
use `project create`, `cycle create` or `module create` above, then report the created id/name once.
Do not turn the admin request into a work-item card. After creating it, send one short result with
`iflist say --chat "<trigger.chat>" --text "..."`. For read-only status use `project summary`,
`cycle list` or `module list`.

## Boundaries

- The card is the confirmation. Do not send an additional “建好了/收到” text after creating it.
- If a field is unclear, leave it empty; the form lets the person choose. Do not guess a person or project.
- If the card command fails, report the concrete error once; do not retry blindly or start doing the task.
- Do not use `task cancel`, `task get` or repeated `orchestrator_report`.
