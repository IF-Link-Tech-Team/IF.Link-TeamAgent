# 飞书 API 请求计数器（本地网络层）

数这台机器**实际发出**的飞书 HTTP 请求，不依赖编排进程里的埋点。

## 为什么不用应用内计数

编排进程里的计数器数的是"自己发出的 CLI 调用"，看不到三类东西：

| 看不到的 | 例子 |
|---|---|
| 一次 CLI 调用内部的翻页 | `im +chat-list --page-all` 打 7 个 HTTP 请求，计 1 |
| 别人的调用 | 工单会话里的 `lark-user`、dreaming 任务、人在终端敲的 `lark-cli` |
| 认证请求 | 每个进程一次 `/oauth/v3/token` |

代理数的是 HTTP 请求本身，所以这三类都在里面。代价是它只知道"谁调、调了哪个端点"，不知道"为什么调"
（兜底扫描还是线程轮询），那部分仍然靠编排进程的分出口计数。两边一起看才完整。

## 怎么工作

```
lark-cli ──HTTPS_PROXY──▶ 127.0.0.1:18080（本代理）
                            ├─ CONNECT 200，用本地 CA 给目标域名现场签一张证书
                            ├─ 终止 TLS，解析请求行
                            ├─ 转发上游（真实证书校验不变）
                            ├─ 写一行：时间 / 域名 / 方法 / 路径 / 状态 / 耗时 / pid / 调用方角色
                            └─ 响应原样回给客户端
```

- **归因**（走过的弯路记在这里）：先试 `SO_PEERCRED`，它对 TCP 连接返回 pid 0；再试
  `/proc/net/tcp` 查 socket inode 再扫 `/proc/*/fd`，服务端也找不到持有者——因为这个 agent 的每个会话
  都跑在自己的 PID 命名空间里（bwrap `--unshare-pid`），服务端根本看不见它们的进程。最后落到
  "一个端口一个身份"：包装脚本按自己被谁调用选端口，服务端按监听端口记身份。两端都不依赖对方的能力。
- **长连接不走代理**：事件流是 WebSocket，建立在一条长期连接上，不是计次接口；代理在它上面反而容易拖出
  握手问题（实测把它塞进代理后，消费端会卡在"没就绪"，而直连一秒内就 ready）。所以包装脚本看到
  `event` 子命令就直接 exec，绕开代理。少数的 `/callback/ws/endpoint` 请求仍然会被计数。
- **归因按端口**：编排 18081、工单 18082、周期任务 18083、其余 18080。客户端不需要发任何标记，
  服务端也不需要看进程树。
- **降级**：某个域名签不出证书时，这条隧道按字节直通——请求照常成功，只是没被计数。宁可少记，不能把
  lark-cli 弄挂。

## 安装

```bash
cd ~/TeamAgent/dsh-superagent-prototype-IF.Link/tools/feishu-counter
chmod +x counter.py ca.sh report.py
./ca.sh                                   # 生成 CA + 合并信任包（系统 CA 也在里面）
mkdir -p ~/.config/systemd/user
cp feishu-counter.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now feishu-counter.service
```

然后让 `lark-cli` 走代理。两个包装脚本 `~/.local/bin/lark-bot`、`~/.local/bin/lark-user` 已经这么做了
（先探测端口，代理没起就照常直连，不会因为代理挂了而调不通）：

```sh
if exec 3<>/dev/tcp/127.0.0.1/18080 2>/dev/null; then
  exec 3>&-
  export HTTPS_PROXY=http://127.0.0.1:18080
  export SSL_CERT_FILE="$HOME/.dsh/feishu-counter/bundle.pem"
  export NO_PROXY=127.0.0.1,localhost
fi
```

> 想覆盖所有子进程（例如工单里直接 `lark-cli` 而不是走包装脚本），也可以把上面三个变量写进
> `dsh-superagent.service` 的 `Environment=`。代价是那个进程里所有 HTTPS 流量都会经过代理；
> `SSL_CERT_FILE` 已经是合并包，别的服务不会因此失败。

## 验证

```bash
lark-bot im +chat-list --page-size 3 >/dev/null
./report.py            # 当天应出现 GET /open-apis/im/v1/chats
```

跨天的对照表里，"编排自记"一列来自 `~/.dsh/state/superagent/orchestrator.sqlite` 的
`feishu-calls:<日期>`，最后一列是差。差值不是错误，是口径差异，看 `--by role` 就知道差在谁身上。

## 额度口径（计入 / 不计入）

飞书文档写明：认证及授权、事件订阅、通讯录、人事、招聘、绩效、智能门禁、应用引擎、AI 能力、智能伙伴
这几类 OpenAPI **不占用每月调用量**。`quota.py` 按这张表把请求分成两堆：

```bash
./quota.py                # 今天：计入 / 不计入，各自多少
./quota.py --num          # 只打印计入的那个数（巡检用）
./report.py               # 两天对照表，"计入额度"一列才和后台对得上
```

实测一天里认证与心跳占了大头（每次 CLI 调用 1 个 token + 1 个心跳），但它们**不计入额度**，
所以真正要盯的是"计入额度"那一列。

## 数据

- `~/.dsh/feishu-counter/counter.sqlite`：一行一个请求，WAL 模式，写入在单独线程里。
- `~/.dsh/feishu-counter/ca.key`：**CA 私钥，0600**。它能冒充本机看到的飞书流量，别外拷。
- `~/.dsh/feishu-counter/certs/`：按域名缓存的证书，删掉会自动重签。

## 卸载

```bash
systemctl --user disable --now feishu-counter.service
rm ~/.config/systemd/user/feishu-counter.service
# 还原包装脚本（去掉那 6 行），或者保留——代理没起时它们本来就会直连
rm -rf ~/.dsh/feishu-counter
```

## 已知限制

- 只覆盖设置了 `HTTPS_PROXY` 的进程。绕开包装脚本、又没继承环境变量的调用不会被计数。
- 代理是单点：它挂了、而调用方仍然带着 `HTTPS_PROXY`，那些调用会失败。包装脚本的端口探测避免了这一点，
  直接写环境的部署没有这层保护。
- 假设 lark-cli 认 `SSL_CERT_FILE`（Go 标准库行为，2026-11-16 实测 1.0.100 可用）。将来若改成证书固定，
  代理会退化成一串连接错误——那时应回退到只统计 CONNECT 次数。
- 只统计到"端点"层，不解析响应体，不存消息内容。
