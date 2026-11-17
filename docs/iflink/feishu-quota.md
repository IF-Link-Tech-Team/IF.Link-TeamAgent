# 飞书 API 额度与调用计数

更新：2026-11-17 · 合并原「计数器」与「省额度清单」两篇

> 数字都是快照，标了日期；口径和命令才是长期有效的。报数只用「计入额度」，认证和心跳不算。

## 一、统计的是什么

飞书按**租户**统计 OpenAPI 的每月调用量：同一租户下所有自建应用合并计算，每月 1 日重置。
2026-11 的官方口径：

| 项 | 内容 |
|---|---|
| 免费额度 | 基础免费版 100 万次/月 |
| 计入 | IM 消息与群组、云文档、应用与机器人信息等业务接口 |
| 不计入 | 认证及授权、事件订阅、通讯录、人事/招聘/绩效、门禁、应用引擎、AI 能力、智能伙伴 |
| 超量 | HTTP 429 + `99991403`，计入额度的调用全部失败 |
| 预警 | 用到 90% / 100% 给管理员和开发者推卡片 |
| 查询 | 管理后台 → 费用中心 → 权益数据 → API 调用次数 |
| 频控 | 另一回事：IM 读接口约 1000 次/分钟、50 次/秒；我们的日均约 2,000 次，不是瓶颈 |

我们常打的接口：

| 接口 | 归类 | 计入 |
|---|---|---|
| `/oauth/v3/token`、`/accounts/status/heartbeat` | 认证及授权 | 否 |
| `/callback/ws/endpoint`、WebSocket 升级 | 事件订阅 | 否 |
| `/contact/v3/**` | 通讯录 | 否 |
| `/im/v1/messages`（历史、mget、搜索、回复、表情） | 消息与群组 | **是** |
| `/drive/**`、`/docs_ai/**` | 云文档 | **是** |
| `/application/v6/**`、`/bot/v3/info` | 应用与机器人 | **是** |

分类以 `tools/feishu-counter/quota.py` 的路径表为准：列出的前缀不计，其余都算。没见过的接口先按「计入」看，别按「应该不计」估。

超量时事件流和认证还能用，坏的是读消息、发回复、云文档这些计入额度的调用——也就是能收到消息，但干不了活。

**2026-11-16 后台快照**：本月 1,000,000 次，已用 965,755（96.6%），12 月 1 日重置；剩 34,245 次、14 天，日预算约 2,400 次。
96.6% 主要是第一轮改造（P1）之前烧的：当时一轮 309 次、6.6 分钟一轮、217 轮/天 ≈ 6.7 万次/天，11-05 到 11-12 就烧掉几十万。P1 首日还因默认值单位写错（分钟当毫秒）反弹过一次，11-12 修复后才降下来。

## 二、三套计数，口径不同

| 口径 | 数什么 | 归因 | 看不到 | 在哪看 |
|---|---|---|---|---|
| 应用内 `feishu-calls:<日期>` | 编排进程发出的 CLI 调用 | `byCommand` + `bySite` | 翻页、别的进程、认证与心跳 | 健康行、日志、state sqlite |
| 网络层 `counter.sqlite` | 本机实际发出的 HTTP 请求 | 监听端口 → 角色 | 绕开代理的调用、事件流 | `quota.py` / `report.py` |
| 管理后台 | 租户真实额度 | 无 | 不实时，只有月总量 | 费用中心 |

三个数不该相等，差值就是线索。2026-11-17 的例子（截至 21:28）：

| 指标 | 数 |
|---|---|
| 网络层计入额度 | 2,193 |
| 网络层不计入（认证） | 3,922 |
| 应用内自记 CLI 调用 | 1,937 |
| 差（网络 − 应用） | +256，来自翻页、`cli` 角色的 170 次等 |

一次 CLI 调用在网络上通常 3 个请求：1 个 token、1 个 heartbeat、1 个业务请求（翻页时更多）。前两个不占额度，所以对外报数只用「计入额度」。

## 三、应用内计数：bySite 与 byCommand

KV key：`feishu-calls:<YYYY-MM-DD>`，存在 `~/.dsh/state/superagent/orchestrator.sqlite` 的 `kv` 表：

| 字段 | 含义 |
|---|---|
| `total` | 当天 CLI 调用总数 |
| `rounds` | 当天轮数 |
| `byCommand` | 按子命令：`im +chat-list`、`api GET`、`im +threads-messages-list`… |
| `bySite` | 按调用位置：`sweep` / `thread` / `read` / `write` / `chats` / `other` |

`byCommand` 说明「调了什么」，`bySite` 说明「为什么调」——同一个 `api GET` 可能是兜底扫描、线程轮询，也可能是 agent 读上下文。
`bySite` 从 2026-11-13 18:30 起才有；更早的记录没有这个键，读作「未测量」，不是 0。

日志与健康行：

```bash
journalctl --user -u dsh-superagent.service --since today | grep '\[feishu\] round'
# [feishu] round 42: 7 API call(s), 1937 today (2026-11-17)
```

面板的 Feishu 健康明细带 `; N API calls this round, M today`。旧文档里的 `N API calls since the last chat sweep` 已经不存在。

2026-11-17 的 `bySite` 分布：`thread` 1,373、`sweep` 407、`read` 117、`chats` 22、`write` 18。线程轮询是最大单项，占七成。

## 四、网络层：看当前用量

```bash
cd ~/TeamAgent/dsh-superagent/tools/feishu-counter

./quota.py                 # 今天：计入 / 不计入，各多少
./quota.py --num           # 只打印计入的那个数（巡检用）
./quota.py --day 2026-11-17 --json
./report.py                # 最近两天：计入 / 不计入 / 合计 / 编排自记 / 差
./report.py -n 7 --by role # 一周，按调用方
```

`report.py` 的「差」= 网络层计入额度 − 编排自记。正数说明还有别的进程在调，或一次调用翻了多页。两列本来就不该相等。

巡检：`~/TeamAgent/ops/scripts/teamagent-monitor.sh` 的「飞书额度」一项读 `quota.py --num`：

| 变量 | 默认 | 含义 |
|---|---|---|
| `FEISHU_DAILY_WARN` | 2,000 | 提醒线 |
| `FEISHU_DAILY_FAIL` | 2,400 | 报警线（≈ 2026-11-16 算出的日预算） |

计数器没有数据时，巡检退回应用内自记数并注明，不会误报。

## 五、2026-11 的账（快照）

| 日期 | 应用内 CLI 调用 | 网络层计入 | 说明 |
|---|---|---|---|
| 11-13 | 1,320 | — | 计数代理未上线 |
| 11-14 | 1,320 | — | |
| 11-15 | 681 | — | |
| 11-16 | 1,805 | 1,962 | 代理首日 |
| 11-17 | 1,937 | 2,193 | 截至 21:28，未过完 |

- 旧文档说「改造后约 1,300–1,500 次/天」，与代理上线后的实测不符：11-16、11-17 两天是 1,800–2,200 次/天。
- 11-17 网络层计入 2,193（截至 21:28），已越过 2,000 的提醒线；按同速粗算全天约 2,450，会压着 2,400 的报警线。按 11-16 的剩余额度算，撑到 12 月 1 日缓冲不足一成。
- 最大单项是线程轮询（`threadPollMinutes`，2026-11-17 线上 120 分钟，来自 unit 的 `Environment=`）。这是现在最值得调的旋钮，代价是线程回复最坏延迟 2 小时。
- 面板 → 设置 → 来源 → 飞书 → 高级也能改这些节奏。保存后以面板值为准；环境变量只作为新配置的默认值，不再覆盖已保存的值。

## 六、counter 服务怎么跑

```
lark-cli（任意进程）
   │ HTTPS_PROXY=http://127.0.0.1:1808x
   ▼
feishu-counter（本地 CONNECT 代理）
   ├─ 用本地 CA 为域名现场签证书，终止 TLS
   ├─ 解析请求行：域名 / 方法 / 路径 / 状态 / 耗时 / 调用方
   ├─ 转发上游（上游证书照常校验）
   └─ 写一行进 counter.sqlite，响应原样回给客户端
```

- **不改应用代码**：只看网络，任何进程继承 `HTTPS_PROXY` 就被计数。
- **归因靠端口**：18081 编排、18082 工单、18083 周期任务、18080 其余（人在终端）。包装脚本按父进程的工作目录选端口；各会话有独立的 PID 命名空间，`SO_PEERCRED` / `/proc/*/fd` 找不到调用者，所以不用那两条。
- **事件流不走代理**：WebSocket 是长期连接、不计次；包装脚本见到 `event` 子命令直接 exec。

| 项 | 位置 |
|---|---|
| systemd unit（源） | `~/TeamAgent/ops/systemd/feishu-counter.service` |
| 守护进程代码 | `~/TeamAgent/dsh-superagent/tools/feishu-counter/counter.py` |
| 状态与数据 | `~/.dsh/feishu-counter/`（`counter.sqlite`、`ca.key` 0600、`certs/`） |
| 端口 | 18080–18083，仅回环 |

部署走运维仓：

```bash
cd ~/TeamAgent/ops
scripts/install-host.sh --dry-run   # 看要改什么
scripts/install-host.sh --apply     # 铺 unit + daemon-reload
systemctl --user enable --now feishu-counter.service
```

首次还要生成 CA 与合并信任包：

```bash
cd ~/TeamAgent/dsh-superagent/tools/feishu-counter
chmod +x counter.py ca.sh report.py quota.py
./ca.sh
```

包装脚本 `~/.local/bin/lark-bot`、`lark-user` 负责选端口、探测代理是否在听（不在就直连），并导出 `HTTPS_PROXY` / `SSL_CERT_FILE` / `NO_PROXY`。`SSL_CERT_FILE` 必须是「系统 CA + 自签 CA」的合并包，只放自签 CA 会让别的 HTTPS 调用全挂。

验证：

```bash
lark-bot im +chat-list --page-size 3 >/dev/null
./report.py | grep -m1 '/open-apis/im/v1/chats'
```

排障：

| 现象 | 先看 | 处理 |
|---|---|---|
| 报告没有新数据 | `systemctl --user status feishu-counter` | 重启 unit；查 `--port` 是否被占 |
| lark-cli 报证书错误 | `~/.dsh/feishu-counter/bundle.pem` 是否存在 | 重跑 `ca.sh` |
| 数字偏少 | 包装脚本是否被改回直连 | 检查端口探测与 `HTTPS_PROXY` |
| 表变大 | `select day, count(*) from request group by day` | 按 `day` 删旧行 |

## 七、已知限制

- **只覆盖走包装脚本 / 继承 `HTTPS_PROXY` 的调用。** 绕开代理的 `lark-cli` 不计，其他机器上的调用也不计。
- **应用内计数更窄。** 一次 CLI 调用内部的翻页只记 1 次；工单会话、周期任务、人敲的 `lark-cli` 都不在它的视野里。
- **代理是单点。** 它挂了而调用方仍带着 `HTTPS_PROXY`，那些调用会失败；包装脚本的端口探测避免了这一点，直接把变量写进 unit 的部署没有这层保护。
- **事件流不计数**（有意）。WebSocket 直连，只有 `/callback/ws/endpoint` 这类握手请求会落一行，且按事件订阅排除。
- **证书假设。** 代理依赖 lark-cli 认 `SSL_CERT_FILE`（Go 标准库行为，2026-11-16 在 1.0.100 实测可用）。若将来改成证书固定，代理会退化成一串连接错误；签不出证书的域名按字节直通，请求成功但不计数。
- **非飞书域名也会落库。** 代理看的是所有走它的 HTTPS；`quota.py` 按路径排除已知类别，未识别的域名默认算「计入」，比如 CLI 的 npm 版本检查。
- **不清理历史。** 约 2,000 行/天，一年约 70 万行；需要时手工按 `day` 删除。
- **只到端点层。** 不解析响应体，不存消息内容。
