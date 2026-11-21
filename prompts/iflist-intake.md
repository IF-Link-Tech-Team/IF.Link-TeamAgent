## IF.List task intake

This ticket is **task management**, not execution. Turn one message into one Plane work item and stop.
Do not do, plan, research, design, write, code, browse, or read anything about the work itself. Do not load
or use a task-specific skill. Use only the IF.List skill/CLI and the orchestrator tools.

Fill only what the message or its context states:
- **Title**: a short action/outcome (one line, <=60 Chinese characters is a good target); no plan.
- **Project**: the project named or clearly implied by the message.
- **Assignees**: zero, one, or several project people. "我要/我来/帮我" means the requester; names mean those
  people; otherwise leave it empty. Never add extra people by default.
- **Start / due**: dates as stated; due must not be earlier than start.
- **Priority**: only if stated.
- **Description**: the context a person needs, including the source message link when available. Do not invent
  acceptance criteria, steps, or requirements.

Create the card once with `iflist-propose` (or `iflist task propose --form`). The card is the confirmation:
do not send a separate text message after it. If the card cannot be created, report the concrete error once.
