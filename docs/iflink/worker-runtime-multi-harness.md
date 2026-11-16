# Worker 运行时解耦：让 Router 留在 DSH，让 Worker 自由选 Harness

> 状态：设计稿，2026-11-15。基于当前仓库代码（`src/executor/dsh.ts`、`src/app/sessions.ts`、`src/app/model-router.ts`）与 2026-11 的 CLI 生态调研。
> 结论先行：**方向成立，切口不是重写 Engine，而是把 Executor 从“一个 DSH 实现”改成“一个调度器 + 多个运行时适配器”；模型选择按“任务类型 → 厂商、任务难度 → 厂商内型号”的两维表来，表由团队在面板里手动维护，Router 只判断类型和难度；在写代码之前先用 10 道真实题做一次同题对比，确认 DSH 对非 DeepSeek 模型的差距值得三周工程量。**
>
> **实施状态（2026-11-16）**：按团队决定跳过 P0 同题对照，直接进入接入。配置 schema、`DispatchExecutor`、`AcpExecutor`、MCP bridge、路由解析和面板编辑器已经落地，`pnpm check` 通过；`dispatch.enabled` 仍为 `false`，所以默认行为不变。Kimi Code CLI 2.5.3、Antigravity CLI 1.5.9、Claude Code 2.1.325 与 `claude-agent-acp` 0.107.0 已安装，三台 CLI 的登录尚未完成；线上服务尚未重启。

---

## 一、判断：哪些成立，哪些需要先验证

### 成立的部分

1. **域模型早就把 Executor 划在外面了。** `docs/001-domain.md` 明确写“The Executor, with its Sessions and directories, is outside the domain and connects through Assignments.” `src/core/ports.ts` 里的 `Executor` 只有三个方法：`start`、`deliver`、`stop`。这意味着替换执行层不需要动 Ticket / Mandate / Subscription / Eval 任何规则。
2. **外部 harness 的协议在 2026 年收敛了。** ACP（Agent Client Protocol）+ MCP + headless JSON 三件套已经覆盖 Claude Code、Kimi Code、Antigravity CLI、Codex、Cursor、Copilot、Qwen、OpenCode。不需要为每个 CLI 写一套私有协议。
3. **模型和 harness 的 co-design 是真实的。** Claude Code 的 system prompt、工具 schema、上下文压缩、权限交互是围绕 Claude 调的；Kimi Code 围绕 Kimi 调；Antigravity 围绕 Gemini 调；DSH 围绕 DeepSeek 调。同一个模型换 harness，效果有差距，这符合工程直觉。

### 需要先验证、不能当成前提的部分

1. **“非 DeepSeek 模型在 DSH 上效果差”目前没有你们自己的对照数据。** `docs/iflink/model-fallback-plan.md` 里出现过 `kimi-coding / k3` 的例子，但当前 `~/.dsh/profiles/superagent/cordis.patch.yml` 只配了 DeepSeek 系 provider。也就是说，这个判断更可能来自体感或别处经验，而不是这套系统的运行记录。
2. **差距可能不在“harness”，而在 prompt / 工具 schema / 上下文策略。** DSH 的 worker preset 是通用 coding preset（`cordis.patch.yml`），persona 是 `You are a coding agent powered by the {{model}} model.`，工具描述和压缩阈值都是按 DeepSeek 的偏好设的。换一套 prompt 和工具描述，可能就能补上很大一块，成本只有外部 harness 的十分之一。
3. **外部 harness 的隐性成本被低估了。** 认证（订阅 OAuth 在无头服务器上会过期）、配额（订阅套餐通常不欢迎自动化）、进程与内存（每个 CLI 200–500MB）、转录与可观测性（DSH Web UI 看不到外部 Session）、权限与隔离（每个 CLI 的权限模型不同）、升级（Kimi CLI 不到一年就归档、换成了 Kimi Code CLI）。这些不是“接一下”的量级。

### 我的判断

**值得做，但要按“先验证、再解耦、后智能”的顺序做；第一版不要做“模型按难度自动挑”的智能路由，因为难度判断和质量反馈都还没有数据支撑。** 先把“能换 harness”这件事做扎实，路由用可解释的“类型 → 厂商 / 难度 → 型号”手动表，等跑出数据再让 Router 参与判断。

---

## 二、现状：三层结构与真正的耦合点

### 2.1 三层

| 层 | 代码 | 职责 | 是否要动 |
| --- | --- | --- | --- |
| 域 / Engine | `src/core/*` | Trigger、Thread、Eval、Mandate、Ticket、Assignment、Subscription | **不动** |
| 执行器 | `src/executor/dsh.ts`（709 行）、`src/app/sessions.ts` | 一单一 Session 一目录、并发槽、launch/delivery effect、报告与 turn end | **要改** |
| 模型与路由 | `src/app/role-models.ts`、`src/app/model-router.ts`、`src/policy.ts` | 每角色一个主模型 + 备用链 + 熔断 + 探活 | **要扩展** |

### 2.2 真正的耦合点

`DshExecutor` 不是一个“通用的执行器”，它是**围绕 DSH Session 的生命周期写的一套编排**。它依赖 DSH 的这些东西：

| 依赖 | 用途 | 外部 harness 是否有对应物 |
| --- | --- | --- |
| `Sessions.ensure` + `agentPreset` | 创建 `worker-<ticket>` Session，选 preset | ACP `session/new` / CLI 进程 |
| `agent/status` idle | turn 结束、handoff、后台工作 | ACP `session/prompt` resolve / 进程退出 |
| `session/event` `user/message` | `inputsRead` 的读标记 | **没有**，要近似 |
| `agent/error` | 传输/模型失败分类与重试 | 退出码 / ACP error / stderr |
| `ctx.jobs` / `ctx.subagents` | 30 分钟后台上限、停止子代理 | **没有**，只能杀进程组 |
| `agent.ctx.tools.register` | `orchestrator_report` 等 6 个工具 | **MCP** |
| `agent.ctx.systemPrompt.section` | 注入 worker prompt | ACP `systemPrompt` / `AGENTS.md` |
| `agent.inbox` | 中途投递 / steer | 排队到下一轮 |
| `WorkerSlots` + `Effects` | 并发与持久化队列 | 可复用 |

**关键结论：Engine 不需要改；`Executor` 端口也不需要改。要改的是“Executor 的实现方式”——从单一实现变成一个按运行时分发的实现。**

---

## 三、目标架构

```
DSH 主 Session（Router，仍然是 DSH）
  │  accept: { type, difficulty, needs?, why? }
  ▼
Dispatch 选路（确定性代码，不调模型）
  │  type：规则/来源固定 > Router 判断 > 默认
  │  → 该类型的家族顺序（kimi / deepseek / anthropic / google …）
  │  difficulty（S/M/L）→ 家族内的具体模型
  ▼
Route = { family, model, runtime, account, effort, limits }
  │
  ├─ runtime=dsh        → DshExecutor（进程内，现状）
  ├─ runtime=acp        → AcpWorkerRuntime（Claude Code / Kimi Code / Antigravity / …）
  └─ runtime=cli        → HeadlessCliRuntime（只有 -p 的兜底）
        │
        ▼
  Worker Session（工单目录内）
    ├─ 系统提示：ACP systemPrompt 或 AGENTS.md / CLAUDE.md
    ├─ 工具：teamagent MCP（orchestrator_report / ack / read / follow / handback）
    ├─ 转录：NDJSON 落盘，面板可读
    └─ turn end / report / 失败 → 回到 Engine
```

### 3.1 术语（三个新概念 + 一个配置细节）

| 术语 | 中文 | 含义 |
| --- | --- | --- |
| Worker Runtime | 运行时 | 托管 worker session 的 harness：`dsh`、`claude-code`、`kimi-code`、`antigravity` |
| Runtime Profile | 运行时配置 | 怎么启动它：命令、参数模板、环境、认证方式、prompt 注入方式、模型参数 |
| Task Type | 任务类型 | `research` / `writing` / `creative` / `code` / `ops` / `coordination` / `chat`，团队可增删；决定厂商顺序 |
| Family | 厂商/模型家族 | `kimi` / `deepseek` / `anthropic` / `google` …，一个家族有自己的 S/M/L 型号和默认 harness |
| Route | 路由 | 解析后的具体组合：`family × model × harness × account × effort`，是熔断和审计的最小单位 |

### 3.2 为什么 Route 不是“模型 → harness”的函数

因为同一个模型可以跑在不同 harness、不同账号上，效果和成本都不一样：

- Claude 模型可以走 Anthropic API + DSH，也可以走 Claude Code（订阅或 API key），还可以走 Antigravity（它的模型目录里有 Claude）。
- Kimi Code 也支持接其他兼容 provider。
- DeepSeek 模型可以走 DSH、走网关、走自建 vLLM。

所以 harness 不能由模型名推断，必须是**型号条目上的显式字段**（默认 + 按型号覆盖），不是 `if model == claude then claude-code`。这也正好满足“对应关系可以手动设置”。

### 3.3 四个候选 harness 的能力对照（2026-11）

| 能力 | DSH | Claude Code | Kimi Code | Antigravity CLI |
| --- | --- | --- | --- | --- |
| 非交互入口 | 内置 | `claude -p --bare` | `kimi -p` | `agy -p` |
| 会话协议 | 进程内 API | ACP 适配器 / stream-json | `kimi acp` / stream-json | `agy acp` / stream-json |
| MCP | 原生工具 | `--mcp-config` / ACP | `--mcp-config-file` / ACP | `/mcp` / ACP |
| 系统提示注入 | 原生 | `--append-system-prompt-file` / ACP | AGENTS.md / agent file / ACP | AGENTS.md / rules / ACP |
| 恢复会话 | 原生 | `--resume` / ACP load | `--session` / ACP | `--conversation` / ACP |
| 中途转向 | inbox steer | stream-json 输入 / ACP cancel | 排队（cancel 重开） | 排队（cancel 重开） |
| 权限模型 | preset + danger-full-access | permission modes / skip | yolo / auto / plan | modes / sandbox / skip |
| 用量与成本 | 内部统计 | `total_cost_usd` | stream-json usage | `/usage`、ACP usage |
| 后台任务/子代理 | jobs + subagents | 后台命令 / subagents | subagents | subagents / swarm |
| 认证 | API key | 订阅 OAuth 或 API key | 订阅 OAuth 或 API key | Google 登录 / API key |
| 适合的角色 | 默认、便宜、工具最全 | 硬编码、重构、长任务 | 中文长文、性价比 | 浏览器/UI 验证、多代理 |

这张表决定了路由表怎么排：**不是“谁最强”，而是“这类活谁最合适、最稳、最便宜”。**

---

## 四、七个关键设计决策

### 4.1 协议：ACP 优先，headless JSON 兜底，不碰 PTY

**选 ACP 的理由**：一套 JSON-RPC 覆盖 `initialize`、`session/new`、`session/prompt`、`session/cancel`、`session/load` / `session/resume`、`session/request_permission`、MCP server 声明、`systemPrompt`、`usage_update`（含 token 与 cost）、模型等 `configOptions`。`session/new` 的 `cwd` 就是工单目录。目前原生支持或经官方适配支持的包括：

| Harness | ACP 入口 | 备注 |
| --- | --- | --- |
| Claude Code | `@agentclientprotocol/claude-agent-acp`（官方 ACP 组织维护，有独立二进制） | 也可用原生 `claude -p --bare` |
| Kimi Code | `kimi acp` | 同时有 `kimi -p` headless |
| Antigravity CLI | `agy acp` | 同时有 `agy -p --output-format stream-json` |
| Codex / Cursor / Copilot / Qwen / OpenCode | 各自 ACP 适配 | 后续可加，不改架构 |

**不选 PTY / TUI 抓屏**：脆弱、不可测、随版本漂移。

**实现方式**：client 端用官方 `@agentclientprotocol/sdk` 的 `ClientSideConnection`，不手写 JSON-RPC；MCP server 可以用 `@modelcontextprotocol/sdk`，也可以手写（工具就 6 个），relay 保持零依赖。

**保留一个 headless CLI 适配器**：给只有 `-p`、没有 ACP 的 CLI 用，或给需要 `--input-format stream-json` 流式输入的 Claude Code 用。第一版可以不写，ACP 够用。

**明确不做的**：为每个 CLI 写一套原生 JSON 适配器。N 个 CLI × 每周更新 = 维护地狱。

### 4.2 工具：一个 MCP bridge，不重写工具

外部 harness 看不到 DSH 的 `agent.ctx.tools`。但它们都支持 MCP：

- ACP：`session/new` 的 `mcpServers`，stdio 是必须支持的传输。
- Claude Code：`--mcp-config`。
- Kimi Code：`--mcp-config-file`。
- Antigravity：`/mcp` 或配置文件。

做法：

1. 插件内起一个 **Unix socket MCP server**（`<stateDir>/runtime.sock`，0700 目录），实现 `initialize` / `tools/list` / `tools/call`。
2. 随包发一个**极薄的 stdio relay**（`lib/worker-mcp.js`，约 100 行，零依赖）：把 stdin 的 NDJSON 原样转到 socket，把 socket 的响应写回 stdout；启动时先发一行握手 `{"token": "...", "ticket": "..."}`。
3. 工具集与 `src/app/tools/executor.ts` 一一对应：`orchestrator_report`、`orchestrator_ack`、`orchestrator_read`、`orchestrator_thread_follow`、`orchestrator_thread_unrelated`、`orchestrator_trigger_handback`。schema 复用现有 Zod 定义，描述改成 harness 中立的话术。
4. 插件按 token 解出 ticket，拒绝已结束的工单，记录调用与用量。

**好处**：所有 harness 用同一套权威工具；授权、回复、报告仍然只经过 Engine；不需要为每个 harness 写 DSH 插件。

### 4.3 Prompt：systemPrompt 优先，AGENTS.md 兜底

- ACP 1.x 有 `systemPrompt` 能力位（`append` / `override`），但不是每个 agent 都实现，要探测。
- 通用兜底：在工单目录写 `AGENTS.md`（Kimi / Antigravity / Codex 读）和 `CLAUDE.md`（Claude Code 读），用 marker 块追加，不覆盖仓库原有内容。工单目录是一次性 worktree，不需要还原。
- 复用的文本：`Prompts.compose(config, 'worker', environment)` + `mandateInstructions` + 新增的 **Runtime contract** 段。
- Runtime contract 只写外部 harness 需要知道的事：工具在 `teamagent` MCP 里；结束前必须 `orchestrator_report`；不得越权合并/关闭/对外承诺；长命令放后台；需要人时 report `blocked` 并给 `human_action`。
- **不要把 worker prompt 塞进每条 user message**：浪费 token、容易被后续消息稀释、缓存也失效。
- **第一条 prompt 与 DSH 保持同构**：还是 `{ticket_id, title, assignment, trigger, batch}` 这一套，后续 Input 也用同样的形状；这样 worker prompt、mandate 说明和测试语料可以两边复用，不会因为“换个 harness 就换一套消息格式”而漂移。

### 4.4 完成判定：turn end + report + 兜底

外部 harness 没有 DSH 的 `agent/status idle`，要自己定义“一轮结束”：

| 信号 | 处理 |
| --- | --- |
| ACP `session/prompt` 返回 `stopReason` | 一轮结束（`end_turn` / `max_tokens` / `max_turn_requests` / `refusal` / `cancelled`） |
| `orchestrator_report` 工具调用 | 立刻写 Engine.report；`ready/blocked/failed/dropped` 触发 handoff |
| 进程退出码非 0 / ACP 错误 | 失败分类：传输类重试，其余 `failed` |
| 一轮结束但没有 report | 用最后一条 agent 消息合成 `waiting`（与 `dsh.ts` 的 `workerIdle` 行为对齐），有实质内容时 relay 给主 Session |
| 超过 wall clock 上限 | `session/cancel` + 杀进程组，报 `waiting` 并注明超时 |

**不能让“没 report”变成静默 idle。** 这是外部 harness 最容易掉链子的地方，必须有兜底。

### 4.5 失败与恢复：把 DSH 的语义映射过去

| Engine 事实 | DSH 今天 | 外部 harness 映射 | 降级说明 |
| --- | --- | --- | --- |
| `assignmentStarted` | Session 创建 + 首条消息投递 | ACP `session/new` + 首条 prompt 被接受 | 无 |
| `inputsDelivered` | 进 DSH inbox | 进 supervisor 的持久化队列（写 `inbox.ndjson`） | 投递即“已交付”，但可能排到下一轮 |
| `inputsRead` | `user/message` 事件 | prompt 发出时记“claimed”，report/turn end 后调 `inputsRead` | 与 DSH 的“读后要有 report 或 turn end 才算读”对齐 |
| `turnEnded` | agent idle 且无后台工作 | `session/prompt` resolve | 无 |
| `report` | 工具调用 | MCP 工具调用 | 无 |
| `failed` | `agent/error` | 退出码 / ACP error / 超时 / 认证失败 | 需要分类表 |
| `retry` | `transient()` + 退避 | 同一套分类 + 退避 | 无 |
| `stop` | cancel turn + 杀 jobs/subagents | `session/cancel` + SIGTERM 进程组，宽限后 SIGKILL | 子代理由 harness 自理 |
| 重启恢复 | Session 持久化 + 恢复注记 | ACP `session/load` / `session/resume`（若支持），否则新 session + `handoff.md` | 上下文有损 |
| 30 分钟后台上限 | `ctx.jobs` / `subagents` | 每轮 wall clock 上限，杀进程组 | 无子代理级控制 |
| handoff | 释放 slot，保留 Report | cancel turn + 释放 slot | 无 |
| 中途 steer | inbox 随时插入 | 排队到下一轮；紧急时“打断并投递” | **有损** |

### 4.6 并发、配额、隔离

- **并发**：`WorkerSlots` 从 `DshExecutor` 里提出来，变成共享服务；总上限仍是 `maxWorkers`，每个 runtime 可以再设一个子上限（外部 CLI 更吃内存）。
- **配额**：每条 Route 可设 `maxTurns`、`maxWallMinutes`、`maxCostUsd`（Claude Code 的 `total_cost_usd` / ACP `usage_update` 能给）。超限就停，报 `waiting` 或 `failed`。
- **隔离**：每个 runtime 一个独立 `HOME` / 配置目录（Claude `CLAUDE_CONFIG_DIR`、Kimi `KIMI_CODE_HOME`、Antigravity `~/.gemini/antigravity-cli`），避免和运维自己的登录态互相污染，也方便多账号。
- **身份**：继续用 `worker-bin` 的 PATH shim（`gh`、`lark-cli`、blocked commands）。这是进程级的，外部 harness 一样继承。**这是现有实现里最值钱的一块，不要绕过。**
- **秘密**：API key 走 0600 的 env 文件或 keyring，不放进 argv（`ps` 能看到）。
- **最终边界**：专用 OS 用户或容器。`danger-full-access` 对 DSH 和外部 harness 是一样宽的；外部 CLI 还会自己装 hook、写 home，容器更省心。
- **进程生命周期**：一个 Assignment 一个 ACP 子进程；Assignment 结束就 `session/close` 并退出，下次用 `session/load` 恢复。stdout 走协议，stderr 落 `<ticket>/.teamagent/runtime.log`，排障时先看它。`session/cancel` 后给 10 秒宽限，仍不退出再对进程组 SIGTERM，最后 SIGKILL。

### 4.7 工单目录是持久状态，Session 是一次性的

这是让“换 harness”成立的前提。外部 harness 的 session 存在它自己的 home 里，格式不透明、版本一升可能就读不了；不能把它当唯一状态。做法：

- 每次 turn end / report，supervisor 往 `<ticket>/.teamagent/handoff.md` 写一段：这次做了什么、改了哪些文件、测试结果、没解决的问题、转录路径。
- 换 runtime、崩溃恢复、升级 CLI，都从 `handoff.md` + git 工作区 + 转录接手，而不是指望“把上一个 session 原样搬过来”。
- ACP 的 `session/load` 只是锦上添花：能恢复就恢复，不能恢复就开新 session，把 `handoff.md` 作为第一条上下文。

这样外部 harness 是“一双手”，不是“一个不可替换的黑盒”。**没有这条，多 harness 就只是多几个更难恢复的 DSH Session。**

---

## 五、路由：任务类型决定厂商，难度决定型号

### 5.1 为什么不是一个难度梯度

用 `tier`（light / standard / deep）把“能力”压成一个全局顺序是错的：编程和设计不在同一把尺子上，Kimi 的“强”和 DeepSeek 的“强”也不是同一种强。正确的结构是两维：

```
任务类型（type） ──→ 厂商/模型家族（family，有序）
                          │
任务难度（difficulty） ──→ 该家族内的具体模型（S / M / L）
                          │
                    模型 → Harness（默认 + 可覆盖）
```

- **类型决定家族**：`creative` → Kimi 优先；`writing` → Claude/Kimi（技术文档重准确，社区文稿可把 Kimi 提前）；`code` → DeepSeek 优先；`research` → Anthropic 或 DeepSeek；`ops` → DSH（凭据在本机）。
- **难度决定型号**：同一家族里 `S / M / L` 对应小 / 中 / 大模型（例如 Kimi K2.8 / K3）。
- **Harness 跟着模型走**：模型条目上写默认 harness；同一模型能在多个 harness 里跑时，在这里覆盖。

这样就没有“全局难度排序”这回事，只有“这个类型下，这个难度该用哪家的哪个型号”。

### 5.2 Router 只输出 type + difficulty

在 `orchestrator_route` 的 accept 项里加几个可选字段：

```jsonc
{
  "kind": "accept",
  "trigger_id": "…",
  "title": "…",
  "type": "creative",            // 必须是团队维护的类型表里的 id
  "difficulty": "S | M | L",     // 按该类型的 rubric 判断
  "needs": ["vision"],           // 可选：browser / vision / long-context 等能力标签
  "why": "≤15 词"                // 可选：给人和审计看
}
```

- **type**：优先用命中的 Policy rule / 来源 / label 固定的类型；规则没给时，由 Router 判断；不在类型表里就退回默认类型。**不确定就输出 `unknown`，不要猜**——猜错类型比走默认类型更糟。
- **difficulty**：按 `prompts/routing.md` 里该类型的 S/M/L 定义判断。
- **needs**：只用于过滤 harness 的能力（比如需要浏览器 → Google/Antigravity）；第一版可以只做 `browser`。
- **不输出 vendor / model / harness**：这些由表决定，见 5.3。

Router 不再输出 `risk` 这种跨类型的抽象；风险应该体现在**类型**和**难度**上（“涉及钱/权限的对外文案”就是 `creative` + `L`），或者由规则固定。

### 5.3 三张手动维护的表

**表 1：类型 → 家族（有序）**

| type | 家族顺序 | 说明 |
| --- | --- | --- |
| `research` | anthropic → deepseek → kimi | 调研、核查、对比、找资料 |
| `creative` | kimi → anthropic → deepseek | 设计、文案、新闻稿、推文、海报 |
| `writing` | anthropic → kimi → deepseek | 文档、指南、模板、归档；技术文档重准确 |
| `code` | deepseek → anthropic → kimi | 实现、修 bug、重构、脚本 |
| `ops` | deepseek → kimi | 服务器、账号、接入、数据 |
| `coordination` | deepseek → kimi | 待办、活动、排期、群运营 |
| `chat` | deepseek | 轻回复、转达 |

这 7 类是按 2026-11-11 至 11-15 的 29 张真实工单归纳的：`research` 10、`writing` 7、`creative` 1、`code` 3、`ops` 2、`coordination` 3、`chat` 3。`research + writing + creative` 约 62%，纯代码约 10%。`creative` 这周只有 1 张，但 11-08 至 11-10 有一批新闻稿、推文和海报，放到 8 天看约 10 张——别被 5 天的样本骗了。样本小，只作方向；跨类型任务按主类型记。

`ui` / 浏览器验证不单列类型，用 `needs: ["browser"]` 表达。`creative` 和 `writing` 分开，是因为 Kimi 在创意类更值得单独一条路由；如果跑下来两者没差别，合并成一条也只是删一行。

**表 2：家族 × 难度 → 模型**

| family | S | M | L | 默认 harness |
| --- | --- | --- | --- | --- |
| `kimi` | kimi-k2.8 | kimi-k2.8 | kimi-k3 | kimi-code |
| `deepseek` | deepseek-v4.1-flash | deepseek-v4.1 | deepseek-v4.1 | dsh |
| `anthropic` | claude-haiku | claude-sonnet | claude-opus | claude-code |
| `google` | gemini-flash | gemini-pro | gemini-pro | antigravity |

**表 3：模型 → harness 覆盖（可选）**

模型条目上写 `harness`，覆盖家族的默认；同一个模型有多个 harness（比如 Claude 走 Claude Code 或 Antigravity）时，在这里选。没写就用家族的默认。

> 表里的 model id 只是示例，实际按你们买的账号和当时的模型目录填。

S/M/L 是起点，不是教条：一家厂商超过三个型号时，可以扩成 4–5 档，或者把“快/思考”这类差异放进 `models` 的 `effort`/`variant` 元数据。**不要为了装下更多型号再加一个全局 tier**——那会把刚拆开的两维又压回去。

### 5.4 解析算法（确定性，可测）

```
1. type：规则/来源固定 > Router 判断 > 默认类型
2. families = type.families（有序）
3. difficulty：Router 判断 > 规则默认 > M
4. 对每个 family：
     model = family.models[difficulty]（空格取最近的已填档）
     harness = model.harness ?? family.harness
     若健康/配额/能力都通过 → 选中
     否则同家族先升一档（S→M→L）再试，然后换下一个 family
5. 全不可用 → 全局默认（DSH/DeepSeek），标记 degraded
6. 记录 Decision.dispatch = { type, difficulty, needs, family, model, harness, why, degraded }
```

关键点：

- **同家族内升级优先**（S→M→L），这样风格和工具习惯不变，只是换更大/更贵的型号。
- **跨家族是降级**，要标记；设计任务掉到 DeepSeek 可能文案变差，团队可以选择某类型 `strict`。第一版 `strict` 只改变审计理由和告警，仍回退 DSH，避免工单卡死；后续再改成挂起等人。
- **全不可用时回 DSH/DeepSeek**，保证工单不会因为路由表配错而卡死。
- **每一跳都记录原因**，面板能看到“为什么最后用了它”。

### 5.5 混合类型与能力标签

- 一个任务只给一个**主类型**；跨类型的部分用 `needs` 表达，例如“设计一个落地页”是 `creative` + `needs: ["browser"]`（要截图验证），不是同时属于 `creative` 和 `code`。
- 如果当前家族的 harness 满足不了 `needs`，在家族列表里跳过，或者用一张 `capability → family` 的小表指定（`browser → google`）。
- 第一版不做“类型权重向量”：一个主类型 + 能力标签足够解释，也足够可控。

### 5.6 难度 rubric 要按类型写

同一个 S 在 `code` 和 `creative` 里不是一回事。`prompts/routing.md` 里每个类型给三行定义，例如：

- `code`：S 单文件/明确修复；M 几个文件 + 测试；L 跨模块/方案不确定。
- `creative`：S 改文案/间距；M 新页面/新组件；L 新视觉体系/活动主视觉。
- `writing`：S 改一段话/补一个链接；M 写/改一篇文档；L 多篇整合/对外长文。
- `research`：S 查一个事实；M 对比几个方案；L 多源调研 + 结论。

这段文字是 Router 判断难度的依据，也是团队调整路由的主要抓手；它和表 1/2 一起构成“模型偏好”。

**它应该是生成段，不是手写 prompt。** `runtime/routing` 从 `Settings.dispatch` 的 `types`（id / name / description / rubric / family 顺序）自动生成，团队在面板改完表，下一次请求就生效，不需要再去 Prompts 页同步一份文字。自由补充的偏好（“中文文案宁可慢一点也要 Kimi”）可以放在同一个 part 的覆盖文本里。生成段放在 prompt 末尾、和 `runtime/policy` 相邻，这样改表才变，平时不碎前缀缓存。

### 5.7 这张表就是“模型偏好”

- 团队不用在 prompt 里写模型名；**表本身就是偏好**，改完下一次 accept 生效。
- 每个单元格可以写一句备注（“K3 中文长文更稳”“Opus 贵，只在 L 用”），面板显示，不进模型上下文。
- 模型目录可以从 CLI 自动发现（Kimi `provider list --json`、Antigravity `agy models`、DSH `models`），再手动指派，减少手写错 ID。
- 每个模型可以标 `cost` / `context` / `tags`，面板显示；路由算法第一版只用健康、配额、`needs`，不自动算性价比。
- 面板允许人改一张工单的类型/难度；每次手改记一条，月底看“Router 判错成什么”的混淆矩阵，回来修 rubric 或加一条规则。这是路由表越用越准的唯一办法。

### 5.8 面板怎么画

不新开一套概念，放在 **Execution → Routing**：

1. **类型卡片**：左边是类型列表，可增删改；每个类型编辑 `description`、三档 rubric、家族顺序（拖动排序）。
2. **家族 × 难度表**：中间是每个家族一行，S/M/L 三个下拉；下拉里是该家族可用的模型。行尾显示 harness 和健康点。
3. **模型详情**：点某个模型，编辑默认 harness、effort、成本标签、备注。
4. **解析预览**：输入“类型 + 难度 + needs”，实时显示会选中哪条 route、为什么、当前是否健康。这是验收“表配对了没有”的最快方式。
5. **Ticket 页**：显示 `type · difficulty · family/model · harness`，以及“为什么”；允许人工改 route 或 pin 一个模型，记一条 Decision 审计。

这比“一个全局难度条”多两张表，但每张表都对应一个团队真的会维护的判断：**这类活归谁、这家哪个型号、这个型号跑在哪。**

---

## 六、数据与配置

### 6.1 新增 Settings 块

> 下面 JSON 里的 provider / model / 价格只是示例，写进配置时要按当时的模型目录和你们实际买的账号来填。

```jsonc
// Settings.runtimes
{
  "dsh":         { "enabled": true },
  "claude-code": {
    "enabled": true,
    "protocol": "acp",                     // acp | headless
    "command": "/home/agent/.local/bin/claude-agent-acp",
    "args": [],
    "env": { "CLAUDE_CONFIG_DIR": "/home/agent/.claude-agent" },
    "secretsFile": "/home/agent/.config/teamagent/anthropic.env",
    "promptInjection": "agents-md",        // acp-system | agents-md | both
    "promptFiles": ["CLAUDE.md"],
    "modelArg": null,                      // 若走 session configOptions 则留空
    "concurrency": 2,
    "maxWallMinutes": 60
  },
  "kimi-code": { "protocol": "acp", "command": "/home/agent/.local/bin/kimi", "args": ["acp"], "...": "..." },
  "antigravity": { "protocol": "acp", "command": "/home/agent/.local/bin/agy", "args": ["acp"], "...": "..." }
}
```

```jsonc
// Settings.dispatch
{
  "enabled": false,                         // 关闭时行为与现在完全一致
  "defaultType": "code",
  "fallbackFamily": "deepseek",
  "types": [
    {
      "id": "creative",
      "name": "设计/文案",
      "description": "视觉、文案、新闻稿、推文、海报",
      "families": ["kimi", "anthropic", "deepseek"],   // 有序：第一个不行换下一个
      "rubric": {
        "S": "改文案、间距、小图",
        "M": "新页面、新组件、活动配图",
        "L": "新视觉体系、活动主视觉、对外长文"
      },
      "strict": false                        // true = 跨家族回退写成问题；v1 仍回退 DSH
    },
    {
      "id": "writing",
      "name": "文档",
      "description": "文档、指南、模板、归档",
      "families": ["anthropic", "kimi", "deepseek"],   // 技术文档重准确；社区文稿可把 kimi 提前
      "rubric": {
        "S": "改一段话、补一个链接",
        "M": "写/改一篇文档",
        "L": "多篇整合、对外长文"
      },
      "strict": false
    },
    {
      "id": "code",
      "name": "代码",
      "families": ["deepseek", "anthropic", "kimi"],
      "rubric": {
        "S": "单文件、明确修复",
        "M": "几个文件 + 测试",
        "L": "跨模块、方案不确定"
      }
    }
    // 其余 research / ops / coordination / chat 同理，示例只列三类
  ],
  "families": {
    "kimi": {
      "label": "Kimi",
      "harness": "kimi-code",
      "models": { "S": "kimi-k2.8", "M": "kimi-k2.8", "L": "kimi-k3" }
    },
    "deepseek": {
      "label": "DeepSeek",
      "harness": "dsh",
      "models": { "S": "deepseek-v4.1-flash", "M": "deepseek-v4.1", "L": "deepseek-v4.1" }
    },
    "anthropic": {
      "label": "Anthropic",
      "harness": "claude-code",
      "models": { "S": "claude-haiku", "M": "claude-sonnet", "L": "claude-opus" },
      "harnessByModel": { "claude-opus": "claude-code" }   // 可选：按型号覆盖 harness
    },
    "google": {
      "label": "Google",
      "harness": "antigravity",
      "models": { "S": "gemini-flash", "M": "gemini-pro", "L": "gemini-pro" }
    }
  },
  "models": {
    // 型号级元数据：effort / 成本标签 / 备注 / 预算上限；不填就用家族默认
    "kimi-k3":      { "effort": "high", "cost": "$$",  "note": "中文长文更稳" },
    "claude-opus":  { "effort": "high", "cost": "$$$", "maxCostUsd": 8 }
  },
  "capabilityFamilies": {
    "browser": ["google"],
    "vision": ["google", "anthropic"]
  },
  "rules": [
    { "when": { "label": "docs" }, "type": "writing" },
    { "when": { "label": "design" }, "type": "creative" },
    { "when": { "source": "feishu", "chat": "品牌运营组" }, "type": "creative" }
  ],
  "escalateAfter": 2
}
```

> 类型/家族的 `description`、`rubric` 和顺序是团队判断的载体；自然语言的补充说明放在 `prompts/routing.md`（prompt part `runtime/routing`），由 Router 读。表本身是 Settings，因为它要被 host 强制执行和校验。
> `models` 里的 `cost`/`note` 只给人和面板看，不进 Router 的上下文；路由器只用健康、配额和 `capabilityFamilies`。

### 6.2 Ticket / Assignment 上的字段（都可选，老数据不用迁移）

```ts
interface Execution {
  name: string
  directory: string
  assignment: string
  type?: string                 // 任务类型
  difficulty?: 'S' | 'M' | 'L'
  family?: string               // kimi / deepseek / anthropic / google
  runtime?: 'dsh' | 'claude-code' | 'kimi-code' | 'antigravity' | string
  routeId?: string              // 解析后的路由标识，用于审计与熔断
  model?: string
  nativeSessionId?: string
  transcript?: string          // 相对工单目录
  handoff?: string             // 换 runtime 时的交班说明
}

interface Assignment {
  // 现有字段…
  family?: string
  runtime?: string
  model?: string
  usage?: { inputTokens?: number; outputTokens?: number; cost?: number; currency?: string }
  turns?: number
}
```

`Ticket.execution` 和 `Assignment` 都是 JSON 列，加可选字段不需要 SQL 迁移；`SCHEMA_VERSION` 不用动。

**兼容**：`executor.model` / `executor.fallbacks` 保留，作为 `dsh` runtime 的默认 route。`dispatch.enabled=false` 时完全走它，行为和现在一致；打开后它只是 `dsh` 那条 route 的配置来源。

**Dispatch 的插入点很关键**：Engine 在 `Tickets.create` 里调用 `prepareTicket`（现在由 `DshExecutor.prepare` 提供，见 `src/core/tickets.ts:49`），拿到 ticket 后立刻 `executor.start`。所以选路要发生在 `prepare` 里：dispatcher 的 `prepare` 读取 accept outcome 里的 `type / difficulty / needs`，按类型表和家族表解析出 `family / model / harness`，把 `type / difficulty / family / model / runtime` 写进 `execution`，再走统一的目录命名。这样 `start` 读 `ticket.execution.runtime` 就能分发，不需要改 Engine 的调用顺序。

`Decision` 也加一个可选的 `dispatch` 记录（`type / difficulty / needs / family / model / harness / why / degraded`），用于面板解释和事后复盘；老 Decision 没有这个字段，解析时当空即可。

### 6.3 KV 新键

| 键 | 内容 |
| --- | --- |
| `runtime-token:<ticket>` | MCP relay 的一次性 token（工单结束即删） |
| `runtime-session:<ticket>` | `{ runtime, nativeSessionId, createdAt }`，重启恢复用 |
| `runtime-health:<id>` | 最近一次启动/认证结果，面板显示 |

---

## 七、面板与可观测性

外部 harness 的 Session 不在 DSH Web UI 里，这是产品取舍。补偿方式：

| 位置 | 新增内容 |
| --- | --- |
| Execution → Runtimes | 每个 runtime 一张卡：启用、命令、版本、认证状态、并发/在用、最近错误、“检查”按钮（跑一个极小 prompt 或 `--version`） |
| Execution → Routing | 类型卡片（description / rubric / 家族顺序）、家族 × S/M/L 模型表、模型详情（默认 harness / effort / 成本 / 备注）、解析预览、升级阈值；补充说明链到 Prompts |
| Ticket 页 | `type · difficulty · family/model · runtime` 徽标、“为什么是这个模型”、turn 数、耗时、成本、**转录**（NDJSON 渲染成可读消息，支持下载） |
| Decision 卡 | 选路理由（type / difficulty / needs / family / model / harness / degraded） |
| Overview / health | `worker:<runtime>` 健康项；认证过期、连续启动失败进系统问题 |

转录是必须做的，不是可选项：没有它，出问题时只能 SSH 上服务器翻日志，团队里没人愿意做第二次。

**两个要提前接受的产品降级**：

- 人在面板里**不能直接进外部 Session 打字**（DSH 可以）。替代是 `orchestrator_ticket_note`、面板的“打断并投递”、以及读转录。如果这条不能接受，外部 runtime 就只能用在不需要人中途接管的活上。
- Ticket 页原来那个“打开 worker Session”的按钮，对非 DSH runtime 要换成“看转录”；不要把用户带到一个不存在的 DSH Session。

另外，`orchestrator_read models` 增加 `types` / `families` / `models` 和当前健康，让 Router 和人在同一个视图里看到“现在有什么可用”；价格、备注等敏感信息只给面板，不进模型上下文。Ticket 页允许人工 pin / 改 route，并记一条 Decision 审计。

---

## 八、安全与运维

1. **身份**：`worker-bin` shim 继续生效（`gh`、`lark-cli`、blocked commands）。外部 harness 通过 `PATH` 继承，不需要它自觉。
2. **权限**：作为 ACP client，我们可以统一回答 `session/request_permission`（工作区内读写放行，工作区外/危险命令拒绝）。但这不是安全边界，**真正的边界是 OS 用户/容器**。
3. **秘密**：API key 用 0600 env 文件或 keyring；不要 `--api-key` 放命令行。
4. **数据外发**：外部 harness 会把工单上下文发到对应厂商（Anthropic / Moonshot / Google）。飞书私聊内容、成员信息、内部文档要按团队的数据边界决定允许哪些来源的工单走外部 runtime。这是产品/合规问题，不只是技术问题。
5. **供应链**：关闭 CLI 自动更新，pin 版本，升级窗口手动做；每个 runtime 的启动参数做契约测试（用假 CLI 回放 ACP 消息）。
6. **成本**：每 route 上限 + 每日预算 + 熔断；外部 harness 的 token 计费和 DSH 不是一套，面板要分开显示。
7. **容量**：外部 CLI 更吃内存，`maxWorkers` 之外再加每 runtime 上限；工单目录和 CLI 缓存要定期清理。

---

## 九、分期计划

### P0：同题对比（1.5–2 天）——go / no-go

**做什么**

1. 在 agent 主机上装三个 CLI，隔离 HOME / 配置目录：
   - Claude Code：`claude --version`，`claude -p --bare` 用 `ANTHROPIC_API_KEY`（`--bare` 不读订阅 OAuth）。
   - Kimi Code：`kimi login`（设备码，适合无头），`kimi -p "..." --output-format stream-json`。注意 `-p` 模式默认走 `auto` 权限，且 `--prompt` 不能和 `--yolo/--auto/--plan` 同用。
   - Antigravity：`agy acp --login`（打印 URL），`agy -p "..." --output-format stream-json`。
2. 从最近 30 天真实工单里挑 10 道（5 飞书、5 GitHub），写成固定题面 + 验收 rubric。
3. 每道题在干净 worktree 里跑：DSH+DeepSeek（基线）、DSH+Claude（如果 provider 配得通）、Claude Code、Kimi Code、Antigravity（只跑适合的题）。
4. 记录：完成度 0/1/2、人工盲评 1–5、time-to-ready、token/成本、turn 数、report 合规、人工介入次数。

**产出**：一张对比表 + 是否继续的结论 + 初始“类型 → 家族 / 家族 × 难度 → 型号”表。

**kill criteria（写死，避免自我说服）**

- 强模型（各家族的 L 档）的成功率/质量相对 DSH 基线提升 < 20%，且时间没有明显优势 → **不做外部 harness**，转做 DSH 内的 per-model prompt/tool profile（见备选 B）。
- report 合规率 < 80%（调完 prompt 后）→ 不规模化，最多做“外部 harness 当工具”的轻量用法。
- 认证/配额在 3 天内无法稳定自动化 → 先只接 API key 能覆盖的 runtime。

### P1：骨架（4–5 天）

- `WorkerRuntime` 接口 + `ExecutorDispatcher`（注册 `launch` / `delivery` effect，按 `ticket.execution.runtime` 分发）。
- `DshExecutor` 改造：暴露 `launch` / `deliver` / `stop`，不再自己注册 effect；`WorkerSlots` 提成共享服务。
- `AcpWorkerRuntime`：spawn、`initialize`、`session/new`（带 MCP + systemPrompt）、`session/prompt`、`session/cancel`、`session/load`、权限应答、`usage_update`、转录落盘。
- MCP server + stdio relay + token 鉴权。
- prompt 注入（systemPrompt → AGENTS.md 兜底）+ runtime contract 段。
- turn end / report / 无 report 兜底 / 失败分类 / 重启恢复。

**只接 1 个 runtime，工单手动 pin。** 验收：一张真实工单端到端跑通（launch → ack → 改代码 → 开 PR → report ready → 面板可见转录）；重启后能恢复；启动失败能回退 DSH；现有测试全绿。

### P2：路由与面板（3–4 天）

- `Settings.runtimes` / `Settings.dispatch` schema、校验、保存历史。
- `DispatchSelector` + 默认矩阵 + 硬规则 + Router accept 字段 + Decision 记录。
- 面板：Runtimes、Routing、Ticket 徽标/转录、Decision 理由。
- `prompts/routing.md` + `prompts/dispatch.md` 小改。

**验收**：同一句话在开关 `dispatch` 两种状态下行为可复现；规则改完下一次 accept 生效；面板能解释“为什么选它”；`dispatch=false` 时零回归。

### P3：加固 + 第二个 runtime（3–4 天）

- 隔离（独立 HOME、专用 OS 用户/容器）、配额、认证探测、契约测试、升级 runbook。
- 接第二个 runtime，验证“路由表 + 熔断 + 升级”不是只对一个 CLI 有效。
- 文档：更新 001/003/004/005/006/007，新增排障手册。

**验收**：连续 7 天、N 张真实工单，无人工干预；成本在预算内；至少一次故障自动回退且有人能看到原因。

**总计 12–15 个工作日（1 人），加缓冲 3–4 周。P0 是唯一的 go/no-go 点。**

---

## 十、验收指标

| 指标 | 定义 | 目标 |
| --- | --- | --- |
| 完成率 | 工单最终 `ready` 或按预期 `dropped` | ≥ DSH 基线 |
| 一次通过率 | 不需要人工返工 | 不低于基线 |
| 质量盲评 | 人工 1–5 分 | 强模型档（L）≥ 基线 +1 |
| time-to-ready | accept 到 `ready` | 强模型档 ≤ 基线 |
| 成本 | 每张工单 token/美元 | 在预算内，S 档显著低于基线 |
| report 合规 | 有显式 report 的 turn 占比 | ≥ 95% |
| 恢复 | 重启/崩溃后能继续 | 100% 可恢复或明确失败 |
| 路由准确率 | 人工抽检“这个模型合适吗” | ≥ 80% |

---

## 十一、风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 前提不成立（差距没那么大） | 白做三周 | P0 对照 + kill criteria；备选 B 作为对照臂 |
| ACP 实现参差（systemPrompt / resume / model config 缺失） | 适配器到处特判 | 能力探测 + 降级路径；只依赖 baseline 能力 |
| 认证/配额不稳定（订阅 OAuth 过期） | 工单随机失败 | 优先 API key；认证健康探测；失败回退 DSH |
| report 纪律差 | 工单卡住/静默 | prompt + MCP + turn end 兜底 + 看门狗；合规率进验收 |
| 失去中途 steer | 人的紧急修正要等一轮 | 排队；面板提供“打断并投递”；文档写清 |
| 外部 CLI 内存/进程泄漏 | 主机被拖垮 | 每 runtime 并发上限、wall clock、进程组清理、定期重启 |
| 安全边界变宽 | 误操作/数据外发 | 专用 OS 用户/容器；PATH shim；按来源限制哪些工单可走外部 |
| CLI 版本漂移 | 适配器坏 | pin 版本 + 契约测试（假 CLI 回放）+ 升级窗口 |
| 转录缺失导致不可运维 | 出问题无法定位 | 转录落盘 + 面板渲染，P1 就做 |
| 路由表拍脑袋 | 选错模型，成本/质量双输 | 先规则后智能；记录每次选择；每月复盘一次 |

---

## 十二、备选方案与否决理由

| 方案 | 做法 | 评价 |
| --- | --- | --- |
| **A（推荐）** | Executor 调度器 + ACP 适配器 + MCP 工具面 + 类型/难度路由表 | 改动面可控，保留 Engine；能逐步接 harness |
| B | 留在 DSH，给每个模型做一套 prompt/tool profile（persona、工具描述、压缩阈值、输出格式） | 最便宜，1–2 天可试；应作为 P0 的对照臂。如果它能补上大部分差距，A 的优先级下降 |
| C | 外部 harness 当工具：DSH worker 调 `claude -p` / `kimi -p` 做子任务 | 1 天可试，适合“某一类子任务借用别家模型”；没有长会话、没有 steering、上下文会膨胀 |
| D | 把编排搬出 DSH（Temporal / 自研 supervisor） | 否决：丢掉现有 Engine、面板、Source、记忆，收益不匹配 |
| E | PTY 包装 TUI / 抓屏 | 否决：脆弱、不可测 |

---

## 十三、代码改动清单

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `src/core/ports.ts` | 不动 | `Executor` 三方法足够 |
| `src/executor/dispatch.ts` | 新增 | 注册 effect、按 runtime 分发、共享 slot |
| `src/executor/runtime.ts` | 新增 | `WorkerRuntime` 接口、能力描述、事件类型 |
| `src/executor/dsh.ts` | 改 | 暴露 launch/deliver/stop；effect 注册上移；行为不变 |
| `src/executor/acp/*.ts` | 新增 | ACP client、进程管理、权限应答、转录、usage |
| `src/executor/headless.ts` | 可选新增 | `-p` 兜底适配器 |
| `src/executor/mcp-relay.ts` | 新增 | stdio ↔ Unix socket 的薄 relay（独立 entry） |
| `src/app/mcp-server.ts` | 新增 | socket 上的 MCP server、token→ticket、工具转发 |
| `src/app/dispatch.ts` | 新增 | 类型/家族/难度解析、健康与降级 |
| `src/policy.ts` | 改 | `runtimes` / `dispatch` schema；rule 加 `type` |
| `src/app/runtime.ts` | 改 | wiring：dispatcher、runtime registry、health |
| `src/app/sessions.ts` | 小改 | 仅 DSH 路径；`ensure` 不变 |
| `src/app/views/*`、`src/client/*` | 改 | Runtimes/Routing/Ticket 转录/Decision 理由 |
| `prompts/routing.md` | 新增 | 团队可编辑的偏好文本 |
| `prompts/worker.md`、`prompts/dispatch.md` | 小改 | runtime contract；accept 字段说明 |
| `tsdown.config.ts` | 改 | 新增 `worker-mcp` entry |
| `docs/001/003/004/005/006/007` | 改 | 术语、运行时、面板、部署、模块表 |
| `tests/*` | 新增 | ACP 适配器、relay、dispatch、registry、面板、契约回放 |

**三个容易被忽略的维护成本：**

- `tests/docs.spec.ts` 要求 `007-architecture.md` 的模块表和测试表覆盖所有模块/测试——新增文件必须同步更新 007，否则测试红。
- `tests/model-surface.spec.ts` 有每个角色的 prompt 体积预算——新增 `runtime/routing` 段可能超预算，要一并调整或压缩。
- `tests/class-docs.spec.ts` 要求每个 class 有 JSDoc。

---

## 十四、待拍板

1. **第一个接哪个 runtime？** 我建议 Kimi Code（`kimi login` 设备码适合无头、中文场景多、成本低）或 Claude Code（能力上限最高、ACP 适配成熟）。取决于你们手上有的账号/额度。
2. **认证走订阅还是 API key？** 自动化场景我建议 API key；订阅 OAuth 在服务器上过期是常态。
3. **Router 只给 type + difficulty，还是允许直接点某个模型？** 我建议默认只给前两者，具体型号由表决定；人工可以在面板上对单张工单 pin 一个模型，但不让 Router 在 prompt 里点名。
4. **外部 worker 的权限**：与 DSH 同等（可 push、开 PR），还是先在测试仓库只读/草稿？我建议同等，但先在非生产仓库跑两周。
5. **能接受“外部 Session 不在 DSH Web UI，只能在面板看转录”吗？** 这是产品取舍；如果不能接受，就要考虑把外部 runtime 的 Session 也镜像进 DSH（成本高很多）。
6. **每张工单/每天的预算上限**是多少？这决定 `maxCostUsd` 和路由默认值。

---

## 十五、一句话总结

**Router 留在 DSH、Worker 解耦，这个方向是对的；真正的创新点不是“多接几个 CLI”，而是把路由拆成两维：任务类型决定厂商，任务难度决定厂商内的型号，型号再绑定 harness。Router 只判断类型和难度，表由团队在面板里手动维护；host 负责健康、配额、降级和审计。先做 P0 对照，再谈自动路由；先让一张工单在 Kimi/Claude 上完整跑通，再谈多 harness 编排。**
