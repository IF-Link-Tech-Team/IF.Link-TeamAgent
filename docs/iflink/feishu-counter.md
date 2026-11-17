# 飞书 API 请求计数器

> 2026-11-16 上线。工具在 `tools/feishu-counter/`，状态目录 `~/.dsh/feishu-counter/`，
> systemd user unit `feishu-counter.service`。

## 1. 为什么要有它

编排进程自己记着每天发了多少次飞书 CLI 调用（KV `feishu-calls:<日期>`），但它看不见三类东西：

| 看不见的 | 例子 |
|---|---|
| 一次 CLI 调用内部的翻页 | `im +chat-list --page-all` 打 7 个 HTTP 请求，它记 1 |
| 别人的调用 | 工单会话里的 `lark-user`、周期任务、人在终端敲的 `lark-cli` |
| 认证与心跳 | 每个 CLI 进程各一次 `/oauth/v3/token`、`/accounts/status/heartbeat` |

2026-11 的额度事故把这件事推到了台面：管理后台显示本月 100 万次用了 96.6%，
而编排进程自己记的每天只有几百次——两个数根本不是一个东西。要判断"还剩多少、还能撑几天"，
需要的是一个和后台口径一致、又不依赖应用埋点的数。

## 2. 它怎么工作

```
lark-cli（任意进程）
   │ HTTPS_PROXY=http://127.0.0.1:1808x
   ▼
feishu-counter（本地 CONNECT 代理）
   ├─ 应答 200，用本地 CA 为该域名现场签一张证书，终止 TLS
   ├─ 解析请求行：域名 / 方法 / 路径 / 状态 / 耗时 / 请求方
   ├─ 转发上游（上游证书照常校验）
   └─ 写一行进 counter.sqlite，响应原样回给客户端
```

三个要素：

1. **不改应用代码。** 只看网络，所以任何进程只要继承了 `HTTPS_PROXY` 就自动被计数。
2. **归因靠端口。** 18081 编排、18082 工单、18083 周期任务、18080 其余（人在终端）。包装脚本
   按自己被谁调用选端口。试过 `SO_PEERCRED`（对 TCP 返回 pid 0）和扫 `/proc/*/fd` 找 socket inode
   （会话各有自己的 PID 命名空间，服务端看不到），两条都不行。
3. **事件流不走代理。** WebSocket 是长期连接、不计次，而且进了代理之后消费端会卡在"没就绪"。
   包装脚本见到 `event` 子命令直接 exec 绕开。

## 3. 哪些调用算额度

依据《自建应用 API 调用量上限调整说明》：认证及授权、事件订阅、通讯录、人事、招聘、绩效、智能门禁、
应用引擎、AI 能力、智能伙伴创建平台这几类 OpenAPI **不占用每月调用量**，其余都算。

| 我们常打的 | 归类 | 计入 |
|---|---|---|
| `/oauth/v3/token`、`/accounts/status/heartbeat` | 认证及授权 | 否 |
| `/callback/ws/endpoint`、`/event/v1/connection`、WebSocket 升级 | 事件订阅 | 否 |
| `/contact/v3/**`、群成员列表 | 通讯录 | 否 |
| `/im/v1/messages`（历史、mget、搜索、回复、表情） | 消息与群组 | **是** |
| `/drive/**`、`/docs_ai/**` | 云文档 | **是** |
| `/application/v6/**`、`/bot/v3/info` | 应用与机器人 | **是** |

实测一天里认证与心跳占了大头（每次 CLI 调用各一个），但它们**不占额度**。所以对外报数、
设阈值、和后台对数，一律用"计入额度"那一列。

## 4. 数据

`~/.dsh/feishu-counter/counter.sqlite`，表 `request`，一行一个 HTTP 请求：

| 列 | 含义 |
|---|---|
| `at` / `day` / `hour` | 本地时间、日期、小时 |
| `host` / `method` / `path` | 域名、方法、去掉查询串的路径 |
| `status` / `ms` | 上游状态码、这次往返耗时 |
| `req_bytes` / `resp_bytes` | 请求与响应字节数 |
| `pid` / `ppid` / `role` / `cmd` | 调用方（端口归因给 `role`） |
| `kind` | `api` 业务、`token` 认证、`stream` 长连接 |

只到端点级，不解析响应体，不存消息内容。写入在单独线程里、WAL 模式，代理不会因落盘变慢。

CA 私钥在 `~/.dsh/feishu-counter/ca.key`（0600），一年一换；`certs/` 里是按域名缓存的证书，删掉会自动重签。

## 5. 怎么用

```bash
cd ~/TeamAgent/dsh-superagent/tools/feishu-counter

./report.py                 # 最近两天：计入额度 / 不计入 / 合计 / 编排自记 / 差
./report.py -n 7 --by role  # 一周，按调用方
./quota.py                  # 今天计入多少、哪些被剔除了
./quota.py --num            # 只打印计入的那个数（巡检用）
./quota.py --day 2026-11-15 --json
```

`report.py` 的"差"＝网络层计入额度次数 − 编排自记。正数说明还有别的进程在调，或者一次调用翻了多页。
两列本来就不该相等，差值是线索，不是错误。

## 6. 部署

```bash
cd tools/feishu-counter
chmod +x counter.py ca.sh report.py quota.py
./ca.sh                                    # 生成 CA 与"系统 CA + 自签 CA"的合并信任包
cp feishu-counter.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now feishu-counter.service
```

包装脚本 `~/.local/bin/lark-bot`、`lark-user` 负责三件事：按父进程的工作目录选端口、
探测端口是否在听（不在就直连）、导出 `HTTPS_PROXY` / `SSL_CERT_FILE` / `NO_PROXY`。
`SSL_CERT_FILE` 必须是合并包——它会覆盖整个信任库，只放自签 CA 会让别的 HTTPS 调用全挂。

验证：

```bash
lark-bot im +chat-list --page-size 3 >/dev/null
./report.py | head -5        # 当天应出现 GET /open-apis/im/v1/chats
```

## 7. 巡检集成

`BuildTeamAgent/teamagent-monitor.sh` 的"飞书额度"一项读 `quota.py --num`：

- 提醒线 `FEISHU_DAILY_WARN`，默认 **2000**
- 报警线 `FEISHU_DAILY_FAIL`，默认 **2400**（＝当时的日预算本身）

两条线是按"剩余额度 ÷ 剩余天数"定的，2026-11-16 的上下文是：总额度 100 万，已用 96.6%，
剩 34,245 次、14 天，摊下来 2,400/天。计数器没有数据时，巡检退回编排自记数并注明，不会误报。

## 8. 已知限制

- **只覆盖走包装脚本的调用。** 绕开包装脚本、又没继承环境变量的 `lark-cli` 不会被计数。
- **代理是单点。** 它挂了而调用方仍带着 `HTTPS_PROXY`，那些调用会失败；包装脚本的端口探测避免了这个
  场景，直接把变量写进 unit 的部署没有这层保护。
- **事件流不计数**（见 2.3），这是有意的。
- **假设 lark-cli 认 `SSL_CERT_FILE`**（Go 标准库行为，1.0.100 实测可用）。将来若改成证书固定，
  代理会退化成一串连接错误，那时应回退到只统计 CONNECT 次数。
- **不清理历史。** 一行一个请求，量级约每天 2,000 行；一年约 70 万行，需要时手工按 `day` 删除。
- **`app_versions` 每次 CLI 启动查一次**，约 40 次/天，计入额度。要省得从 CLI 侧找开关。

## 9. 排障与回滚

| 现象 | 先看 | 处理 |
|---|---|---|
| 报告里没有新数据 | `systemctl --user status feishu-counter` | 重启 unit；`--port` 是否被占 |
| lark-cli 报证书错误 | `~/.dsh/feishu-counter/bundle.pem` 是否存在 | 重跑 `ca.sh` |
| 数字明显偏少 | 包装脚本是否被改回直连 | 检查 `lark-bot` 里的端口探测与 `HTTPS_PROXY` |
| 表变大 | `select day, count(*) from request group by day` | 删除旧日期行 |

停用：`systemctl --user disable --now feishu-counter.service`，删掉包装脚本里的那几行即可
（代理没起时它们本来就会直连）；数据与 CA 在 `~/.dsh/feishu-counter`，删目录即彻底清除。

## 10. 2026-11 的账（写在这里，免得下次又从零推）

- 管理后台：本月上限 100 万，11-16 已用 965,755（96.6%），12-01 重置。
- 剩余 34,245 次、14 天 → 日预算约 2,400 次。
- 改造后的日常消耗（计入额度）：约 1,300–1,500 次/天，余量约 40%。
- 透支发生在 P1 之前：那时"一轮 309 次、6.6 分钟一轮、217 轮/天"≈ 6.7 万次/天，
  11-05 到 11-12 几天就烧掉了几十万。现在的 1,300/天对 96.6% 几乎没有贡献。
- 由此得出的口径：**报数只用"计入额度"，认证和心跳不算**。
