---
name: dsh-superagent-iflist
description: 把一件事落成 Plane 工作项、派给人、或给人发任务卡时使用（iflist CLI）。
---

Task channel between this team and Plane. Use it when a ticket needs a durable item for a **person** to do later: a step you finished that someone must own, a follow-up promised in a thread, a plan whose parts belong to different people, or a decision that is a task rather than work you can finish now.

Do not use it to park work you should do yourself, to record ideas nobody agreed to, to assign blame, or to send a status update. A ticket you cannot finish is not a reason to create one: report the blocker instead.

## The CLI

`iflist` talks to the IF.List service, which owns the Feishu app, the card templates and the Plane token. Credentials live in `~/.config/iflist/config.json` (mode 600): read them never, print them never. Never call the Feishu or Plane APIs directly for task cards.

```
iflist whois <open_id|名字|plane_uuid>
iflist task propose --ticket <ticket id> --title "一句话" --project <IDENTIFIER|名字|uuid> [--here] [--owner <人>]
                    [--to <人>[,<人>]] [--due YYYY-MM-DD] [--priority none|low|medium|high|urgent]
                    [--why "为什么要建这条"] [--source <原消息链接>] [--form] [--dry-run]
iflist task cancel <proposal id>      # 撤回还没人处理的提议，卡片变成"已跳过"
                    [--start YYYY-MM-DD]
iflist issue update  <ABC-12> [--state <名字|组>] [--to <人>] [--due] [--priority] [--title]
iflist issue assign  <ABC-12> --to <人>
iflist project list
iflist project people <项目>
iflist workspace-people
```

Always pass `--ticket` with the id from your assignment, and `--source` with the original message link when the request came from a thread: it is what lets a person check the claim months later.

`--title` is the issue name a human reads in Plane. Write it as an action ("整理 11 月报名表并回填二课群"), not as a subject ("报名表").

`--to` accepts a Feishu `open_id`, a person's Chinese name, or a Plane user uuid; `iflist whois` resolves all three. If the person cannot be resolved the command **fails instead of guessing** — leave `--to` off and let the card ask a human, do not retry with a different name.

`--dry-run` resolves everything and prints the card JSON without sending it. Use it when you are unsure whether the project or the person is right.

## Reading the result

Every command prints JSON on stdout. `{"ok":false,"code":"...","message":"..."}` goes to stderr with a non-zero exit:

| exit | code | what to do |
|---|---|---|
| 0 | — | done |
| 2 | bad_request | the arguments are wrong; fix them, do not retry blindly |
| 3 | identity / ambiguous / not_in_workspace / not_in_project | the person has no Plane account or is not on the project. Report it; do not pick someone else |
| 4 | plane / not_found | Plane refused or the item is gone. Report the detail |
| 6 | forbidden | the bot lacks permission (usually adding people to a project or creating projects). Ask a person |
| 7 | quota | this ticket or today has too many proposals. Stop proposing and report |

## When the person spoke to the IF.List bot

A ticket whose source is `iflist` came from a direct message to the IF.List bot or from an @mention of it. The person
expects the answer from that same bot: the Source sends your reply through it automatically, so answer normally and never
post to Feishu yourself.

A request that arrived through the IF.List bot is **always** proposed with `--form`. Never create it directly.

Two things the card is for, and both are required:

- **Confirming** what the person said, filled in where the request settled it (`--title`, `--project`, `--to`, `--start`, `--due`).
- **Asking** for what the request did not settle: leave that flag out and let the card's field sit empty. Never invent an
  assignee or a date to look complete, and never drop a date the person gave ("今天开始" is `--start`, "周五前" is `--due`).
The person is talking to that bot and expects the card back in the same conversation; a silent create leaves them with no
answer until your report, and the report is text, not the item. `--form` is the prefilled card: they fix only what is
missing and submit once. There is no direct-create command: every item passes through that card. 

`iflist inbox` and `iflist say` are the Source's own plumbing; do not call them for conversations a Ticket already carries.

## Where the card goes, and who may press it

**A group message never gets a card in the group first.** When the thing was said in a group, `--here` sends the
confirmation card **privately to whoever said it** (they refine or drop it without an audience), and only after they
confirm does the item appear, as an announcement card in the original group listing who it is for. That is the same shape
as the card people already get when something is assigned to them.

A direct message has no announcement: `--here` sends the card back into that direct message.

`--owner` is the person who confirms; when omitted the Source fills in whoever spoke. Only that person's click counts —
anyone else gets a refusal, so a forwarded card cannot be confirmed by a bystander.

`--to a,b` assigns several people at once — a meeting, a team outing, a task several people share. With more than one
assignee the card is the three-button proposal, not the form.

## What a proposal is

`task propose` sends a card to the person: it shows the title, project, assignee, due date and why, with three buttons — 建单 / 要改 / 不用. Nothing exists in Plane until someone presses 建单; then the same card becomes a receipt with a deep link. With 要改 they get one form (project, person, due, priority, one note), and submitting creates the item.

So after a successful propose you are done: **do not wait for the answer, do not poll, and do not create the item yourself.** Report that a card was sent and to whom.

Proposing the same thing twice is idempotent — the second call returns `duplicated: true` without sending another card. Limits: 3 proposals per ticket per day, 60 per day overall.

## Red lines

- Never invent an assignee, a due date or a project. If the source does not settle it, leave it out and let the card ask.
- Never create a Plane item for work you were asked to do yourself. That is scope escape, not delegation.
- Never send a task card to a group to "notify" people; the card goes to one person, or it does not go.

- Do not assign anything to someone who is not already on that project: Plane silently drops the assignee and the item looks unassigned.
