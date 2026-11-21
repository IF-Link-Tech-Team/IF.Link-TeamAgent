# IF.List Agent 要不要独立：一次红队分析

> 2026-11-21。对象：IF.List 机器人（私聊 / 群内 @）与 dsh-superagent 的边界。
> 先按“我现在的判断可能是错的”来攻击，再给结论。相关文档：[000-philosophy](../000-philosophy.md)、
> [001-domain](../001-domain.md)、[team-agent-framework](team-agent-framework.md)、
> [model-token-cost](model-token-cost.md)、[requirements](requirements.md)。

## 1. 问题

现在的显式请求（私聊或群内 @）也走 Team Agent 的 main Session 评估；main 接单后
才起 Worker，Worker 再调 `iflist task propose` 发卡。慢的时候一条 DM 要 1–3 分钟。

一个自然的替代方案：

> IF.List Agent 自己就是一个独立 Agent。它有自己的 skill / MCP / CLI；收到私聊或 @
> 就自己做结构化抽取、发卡、建单。没有 @ 的静默消息才交给 Team Agent，由 Team Agent
> 判断是否要给 IF.List Agent 派任务。

这个方案的核心不是“多一个进程”，而是**把显式请求从 Team Agent 的 Eval 里拿出去**。

## 2. 先假设独立方案是对的：最强论证

1. **main 是长会话，不是收费站。** `model-token-cost.md` 记录 router 8 天 3,398 次调用、
   上下文从 1.7 万涨到 80 万，65% 的 token 花在它身上；一次显式请求也要等它读一大段历史。
   卡片创建只需要“文本 → 字段”，不该为全局协调付这个成本。
2. **显式请求不需要“评估要不要接”。** `000-philosophy.md` 说“被请求时才行动”；私聊/@
   已经是明确请求。还要经过一层“这算不算活”的模型判断，是把授权问题误当成了语义问题。
3. **独立 Agent 的失败半径更小。** main 的 provider 抖动、上下文膨胀、工具循环，都会
   阻塞发卡；一个只做“一次模型调用 + 一次 CLI”的进程，失败就是一张卡没发，重试即可。
4. **独立 Agent 可复用。** 同样的能力可以给别的 IM、别的团队、别的入口用；Team Agent
   只负责“没有 @ 时该不该主动介入”和复杂任务。
5. **职责更干净。** IF.List Agent 懂 IF.List/Plane 的字段和卡片；Team Agent 懂团队记忆、
   跨群上下文、主动规则。各自用自己最懂的东西，不需要一个通用 Worker 去学 IF.List 的 CLI。

如果只看到这里，独立方案是明显的赢家。

## 3. 红队：独立方案会死在哪里

### 3.1 刚刚发生的反例：群消息被正确判重，独立 Agent 会建重复单

2026-11-21 14:18，测试群 @IF.List Agent：

> 我下周五之前把 design agent 的项目需求文档写完，今天就开始吧

同一件事在 14:04 已经通过私聊提过。Team Agent 的 main 在 14:18:56 判了 `ignore`：
`routed` 到已有 ticket `9773f4…`，理由是同一请求今天已由 iflist 渠道处理并建了
`DESIGNAI-14`。所以群里没有新卡——这是**正确的判重**，只是没有给群里任何反馈。

一个没有 Team Agent 工单/议题历史的独立 IF.List Agent，会看到一句完整的任务描述，
大概率再建一张卡、再建一条 Plane 工作项。用户得到的是“快了”，但多了一条重复工作项。

这正是 `001-domain.md` 里 Thread/Subscription/Eval 存在的理由：判重不是文本相似度，
而是“这个 Thread 上已经有哪些 Ticket、哪些已结束、哪些人已经确认过”。

### 3.2 Subscription / follow-up 会丢

Team Agent 的 Subscription 让后续讨论**不再 @ 也能扇出到原 Ticket**（`001-domain.md`）。
独立 Agent 如果按“每条消息一张卡”处理，后续“改一下截止”“这个先别做”就没有归属，
要么建新卡，要么必须重新实现一套线程/订阅。我们刚为了私聊隔离把 DM 线程改成
per-message，已经牺牲了一部分连续性；再拆一层会把剩下的也丢掉。

### 3.3 授权和审计不是可选项

Team Agent 的 gate 决定谁可以发起工作、以什么强度、依据哪条 Policy；Mandate 记录
Policy 版本和来源。`001-domain.md` 明确“只有 Eval 能创建 Ticket”。独立 Agent 要么
重实现这套（重复且容易漂移），要么绕过它（团队机器人不可接受）。

卡片创建看起来低风险，但一旦独立 Agent 还能改 assignee、due、state、关闭工作项，
它就需要同一套授权。现在只做“建卡”是暂时的，边界会漂移。

### 3.4 跨来源上下文会断

`requirements.md` 要求同一件事可以在飞书、GitHub、微信之间连续推进。独立 IF.List
Agent 只看得到 IF.List；它不知道同一项目在 GitHub 的 issue、在另一个群的讨论、在
team memory 里的风险。它可以建一张“看起来对”的卡，但可能是重复、冲突或过期的。

### 3.5 同一个 bot 的意图路由仍然存在

用户不会先判断“这是建卡还是问状态”。@ 一句“DESIGNAI-14 现在怎样了”仍然需要
Team Agent/Plane 查询；独立 Agent 只做建卡，就会把这类请求再转回 Team Agent。
于是你仍然需要一个 dispatcher——只是从 main 换成了一个更小的分类器；如果分类器
继续长大，最后又长成一个小 main。

### 3.6 双通道竞态

IF.List 服务已经有一条 quick 正则路径，Team Agent Source 又有一条 LLM 直通；
再加一个独立 Agent，会有三条路径同时看同一条消息。必须精确规定“谁拥有这条消息”，
否则就是双卡、双回复、双建单。当前靠“quick 命中就不入 inbox”解决；独立 Agent 需要
一个新的 claim/lease 协议。

### 3.7 运维成本

两个模型配置、两套凭据、两套审计、两次发布/重启、两种故障模式。用户现在痛的是
“慢”，不是“服务太少”；多一个自主 Agent 很可能把故障面变大，而不是把 p95 变小。


## 3.5 反过来红队：控制面方案自己会死在哪

上面的反例能杀死“独立自主 Agent”，但不能直接证明“所有显式请求都必须留在
Team Agent 里”。控制面方案也有自己的死法：

1. **单点故障。** Team Agent 进程挂了/模型路由熔断/DB 锁住，IF.List 私聊也发不出卡；
   独立 intake 至少还能发一张“已收到，稍后处理”的卡。
2. **每一张卡都付控制面的税。** 如果判重/审计 API 要 300ms、Source 轮询要 2s，
   独立进程本可以 1.5s 出卡，却被拖到 4–6s；速度目标会被“治理”反噬。
3. **两套快路径已经重复。** 现在 IF.List 服务有正则快路径，Team Agent Source 有 LLM
   直通；两条都要维护、都可能误判。独立 Agent 反而可以只保留一套。
4. **模型/凭据耦合。** Source 直通借用 Team Agent 的 eval 模型；如果 Team Agent 的
   模型配置坏了，直通也坏了。独立 Agent 可以用自己的小模型/降级模型。
5. **判重可能被高估。** 大多数私聊建卡是低频、低风险；为了少数重复单，让所有卡都
   走一遍 Team Agent 的查重，可能不划算。更好的做法是“先发卡，卡上显示可能重复，
   由人决定”，而不是阻塞。
6. **产品边界。** 如果 IF.List Agent 要给别的团队用，Team Agent 的控制面是 IFLink
   特有的（成员、Policy、记忆），独立产品不该依赖它。

所以真正的分水岭不是“独立 vs 集成”，而是：**判重/审计是否值得进入每一张卡的
热路径。** 如果答案是“值得”，控制面胜；如果“不值得，或者可以异步”，独立 intake
更快。

## 4. 关键区分：独立“执行路径”≠ 独立“Agent”

独立方案真正想解决的问题是：

- 显式请求不要过 main 的 75s；
- 不要为一张卡起 17–21 个 step 的 Worker；
- 字段抽取只做一次。

这些都可以在**不拆掉控制面**的前提下做到：

```text
                    ┌─────────────────────────────┐
私聊 / @  ─────────→│ Reactive lane（无 main/Worker）│
                    │ 1 次结构化抽取 → 1 次 propose │
                    └──────────────┬──────────────┘
                                   │ 先查重 /  claim
                    ┌──────────────▼──────────────┐
                    │ Team Agent 控制面             │
                    │ Policy / Ticket / Thread /    │
                    │ Subscription / 审计 / 判重     │
                    └──────────────┬──────────────┘
                                   │
没有 @ / 复杂 / 低置信 ────────────→│ main + Worker（原流程）
```

也就是：**把“执行”拆出去，把“治理和状态”留下。** 这不是“接到 main 里”，而是
“不让 main 成为建卡的必经之路”。

我们已经在做这条路径：

- IF.List 服务内：模板快路径，1.3–1.6s；
- Team Agent Source 内：自然语言一次模型抽取 + 一次 `iflist task propose`，约 3–6s；
- 群内 @ 也走同一条，发私聊确认卡，建单后回群公告；
- 只有低置信度/复杂请求才回退 main/Worker。

这证明“快”不需要第二个自主 Agent；需要的是**一条无 Session、无工具循环的窄执行路径**。

## 5. 什么时候独立 Agent 才是对的

不是永远不拆。满足以下条件时，独立 IF.List Agent 是更好的选择：

| 条件 | 为什么 |
|---|---|
| IF.List Agent 是给多个团队/租户的产品，不是 IFLink 内部一个入口 | 需要独立的安全/计费/发布边界 |
| 它只做“创建/更新 Plane item”，不需要团队记忆、跨来源上下文、主动判断 | 控制面可以退化成一个薄 API |
| 它接受“可能重复建单”，或者能调用 Team Agent 的判重 API | 否则会制造重复工作项 |
| Team Agent main 长期不可用/不可优化，而显式请求必须独立可用 | 故障隔离优先于统一治理 |
| 有明确的 claim/lease 协议，保证同一条消息只有一个执行者 | 否则双卡/双回复 |

如果这些条件不成立（IFLink 当前就是不成立），独立 Agent 的收益主要是“少一跳”，
代价是判重、连续性、授权、跨来源、运维五件事。

## 6. 重新评估后的建议

**不建议**把 IF.List Agent 做成一个有自己记忆、自己 Policy、自己线程模型的独立
自主 Agent。**建议**保留一个 Team Agent 控制面，把显式建卡做成一个**无状态 intake
能力**：

1. **一个 intake 契约**：输入 `text + actor + channel + thread`，输出
   `{fields, confidence, duplicate_of?, claim}`；内部一次模型调用，不建 Session。
2. **一个执行入口**：IF.List 服务或 Team Agent Source 都可以调用同一个 intake；
   regex 只做前置快路径，不再维护第二套语义。
3. **判重前置**：发卡前查 Team Agent 的 ticket/issue/proposal（同一项目 + 相似标题 +
   时间窗口）；命中就回“已在 DESIGNAI-14”，不建新卡。
4. **审计旁路**：intake 把 `trigger`/`decision=intake` 写进 Team Agent 的审计，哪怕
   不建 Ticket；这样判重、统计、复盘仍然完整。
5. **一条消息一个 owner**：quick 命中 → 不入 inbox；Source 直通 → 不 receive；
   main 只处理没有被前两者认领的消息。
6. **如果以后要独立部署**：把 intake 包成 MCP/HTTP 服务，Team Agent 和独立 IF.List
   Agent 共用同一个判重/审计 API；这时“独立 Agent”只是 intake 的一个客户端，
   不是第二套大脑。

一句话：**要拆的是执行路径，不是团队 Agent 的大脑。** 除非 IF.List Agent 变成独立
产品，否则“一个控制面 + 两条执行 lane”比“两个自主 Agent”更快、更稳、更少重复。

## 7. 已落地：`iflist-intake` 任务分类

按上面的“拆执行、不拆大脑”，2026-11-21 已新增：

| 配置 | 值 |
|---|---|
| dispatch type | `iflist-intake`（IF.List 建卡抽取） |
| family | `cilai-default`，label `HY4 Flash`，harness `dsh` |
| models S/M/L | `hy4-flash` / `hy4-flash` / `hy4-flash` |
| model metadata | `effort: off`（low 实测超时，见下） |
| dispatch.enabled | 仍为 `false`（不改变 Worker 路由） |

Source 的 `ctx.complete(prompt, 1500, 'iflist-intake')` 用这个分类取
`provider=cilai-default / model=hy4-flash / effort=off`；取不到才回退 eval 模型。

实测 `low` 会先输出约 1655 字符 reasoning，900 token 直接 max-tokens；
调到 3000 token 又在 12s 内跑不完。`off` 才能在一次调用里稳定返回 JSON。
它只做一次 completion，不创建 Worker Session。

同时给抽取 prompt 加了最近 24h 工单；模型返回 `duplicate_of` 时直接回
“这条已经在「标题」”，不再发重复卡。这样“快车道”也保留了判重，而不是绕开它。
