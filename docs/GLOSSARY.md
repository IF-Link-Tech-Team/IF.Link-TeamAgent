# Glossary

One name per concept, in code and in docs. Two spellings of one thing cost a reader a search each time; a word with two meanings costs a wrong assumption.

## Product and repositories

| Concept | Spelling | Not |
| --- | --- | --- |
| Product, as the panel and documents name it | IF.Link Team Agent | IFLink Agent, Superagent, 超级智能体 |
| Code repository on GitHub | `IF.Link-TeamAgent` | prototype, `dsh-superagent-prototype-IF.Link`, "the code repo" |
| Its checkout directory and package name | `dsh-superagent` | using the GitHub name for the path or the package; loaders and state directories key off both |
| Operations repository, checked out as `ops/` | `teamagent-ops` | TeamAgent repo |
| The platform it runs on | DSH, first written "DeepSeek Harness (DSH)" | mixing the two words |

## Domain

| Concept | Chinese | Code | Not |
| --- | --- | --- | --- |
| The one Session that evaluates and replies | 主会话 | `mainSession`, `mainSessionId` | master, router, assessor, orchestrator (outside prompts) |
| A Session that runs one Assignment | 执行会话 | `worker` | executorSession; `agent` when a Session is meant |
| The domain types | 领域模型 | `domain` (`src/core/domain.ts`) | model |
| The language model | 模型 | `llm`, `llmRoute` | `model` on its own |
| A unit of authorized work | 工单 | `ticket` | task, workItem |
| Triggers in time order | 话题 | `thread` | topic (inside the Feishu implementation only) |
| An emoji added to a message | 表情 | `reaction` | mark, gesture, emoji (inside the Feishu implementation only) |
| What produces Triggers | 来源 | `source` + `kind`/`instance` | plugin, watch (package export names excepted) |
| What runs an Assignment | 执行器 | `executor` | runtime |
| The agent runtime underneath | 运行时 | `harness` | runtime |
| A narrow interface a class needs from its caller | — | `*Deps` | `*Host`, except `SourceHost`, `HttpHost`, `MainToolsHost`, `ExecutorToolsHost`, `ExecutorHost` |
| A status badge in the panel | 标记 | `mark` (`src/client/marks.ts`) | reaction |

## Operations

| Concept | Rule | Example |
| --- | --- | --- |
| Operations units | `teamagent-*` | `teamagent-check.timer` |
| Product units | `dsh-*` | `dsh-superagent.service`, `dsh-web.service` |
| Scripts | verb-noun | `check-service.sh`, `monitor-system.sh` |
| Memory scripts | `memory-<verb>.sh` | `memory-commit.sh` |

Paths live only in the operations repository: code documents write `~/TeamAgent/ops` and `~/TeamAgent/dsh-superagent`.
