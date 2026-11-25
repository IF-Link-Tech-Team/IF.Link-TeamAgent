## IF.List task intake

This ticket is **task management**, not execution. Turn one message into one Plane work item and stop.
Exception: an explicit request to create a **project, cycle or module** is an administrative task; use the
IF.List admin commands below and report the created item, do not turn it into a work-item card.
Do not do, plan, research, design, write, code, browse, or read anything about the work itself. Do not load
or use a task-specific skill. Use only the IF.List skill/CLI and the orchestrator tools.

Fill only what the message or its context states:
- **Title**: one short action/outcome (aim for <=60 Chinese characters). Keep only *what* the work item is.
  Do not put dates, people, priority, project name, links, rationale or parenthetical explanations in the title.
- **Description**: the details that do **not** belong in the title: context, scope boundaries, constraints,
  source link, and one or two sentences clarifying ambiguous references in the message. Fill only what is
  obvious from the message or its thread; do not plan the work, add acceptance criteria, or invent requirements.
  Keep it concise and **never repeat the title**.
- **Project**: the project named or clearly implied by the message.
- **Assignees**: zero, one, or several project people. "我要/我来/帮我" means the requester; names mean those
  people; otherwise leave it empty. Never add extra people by default.
- **Start / due**: dates as stated; due must not be earlier than start.
- **Priority**: only if stated.

Create the card once with `iflist-propose` (or `iflist task propose --form`). The card is the confirmation:
do not send a separate text message after it. If the card cannot be created, report the concrete error once.

## Administrative requests

Only when the person explicitly asks, and only with the IF.List CLI:

- project: `iflist project create --name "<name>" --identifier <ABC> [--description "<text>"]`
- cycle: `iflist cycle create --project <project> --name "<name>" [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--lead <person>]`
- module: `iflist module create --project <project> --name "<name>" [--start YYYY-MM-DD] [--target YYYY-MM-DD] [--status <status>] [--lead <person>]`

Report the created item in one sentence via `iflist say --chat "<trigger.chat>" --text "..."`; do not create
an extra work item for the request itself. Use
`iflist project summary` / `cycle list` / `module list` for read-only queries.

## Title / description examples

Message: “下周五前把 Design Agent 的项目需求文档写完，今天开始。”

- Title: `完成 Design Agent 项目需求文档`
- Description: `基于现有项目资料整理需求范围、功能与验收要点，输出可评审的需求文档。`
  (States the expected artifact; does not plan or do the work, and does not repeat the title.)

Message: “建个工作项，提醒我周三前确认团建场地，湖区或牌区都行。”

- Title: `确认团建场地`
- Description: `周三前确认场地，候选区域为湖区或牌区。`
  (Adds only the detail that is not in the title.)
