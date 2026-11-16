#!/usr/bin/env bash
# 生成本机计数代理的 CA、证书链和一份"系统 CA + 自签 CA"的合并信任包。
#
# 只在没有 CA 时生成，重复跑是安全的。CA 私钥决定谁能冒充本机看到的 HTTPS 流量，
# 所以它 0600、只签发给这台代理，一年一换：
#   rm -rf ~/.dsh/feishu-counter/ca.* ~/.dsh/feishu-counter/certs && ca.sh
set -euo pipefail

STATE=${FEISHU_COUNTER_STATE:-$HOME/.dsh/feishu-counter}
SYSTEM_BUNDLE=${FEISHU_COUNTER_SYSTEM_CA:-/etc/ssl/certs/ca-certificates.crt}
mkdir -p "$STATE/certs"

if [[ -f $STATE/ca.key && -f $STATE/ca.crt ]]; then
  echo "CA 已存在：$STATE/ca.crt"
else
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 365 \
    -keyout "$STATE/ca.key" -out "$STATE/ca.crt" \
    -subj "/CN=IFLink TeamAgent local Feishu counter" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "extendedKeyUsage=serverAuth" 2>/dev/null
  chmod 600 "$STATE/ca.key"
  echo "CA 已生成：$STATE/ca.crt"
fi

# lark-cli（Go）用 SSL_CERT_FILE 覆盖整个信任库，所以这里必须把系统 CA 一起带上，
# 否则它去连别的 HTTPS 服务会全部失败。
cat "$SYSTEM_BUNDLE" "$STATE/ca.crt" > "$STATE/bundle.pem"
chmod 644 "$STATE/bundle.pem"
echo "信任包：$STATE/bundle.pem（$(grep -c 'BEGIN CERTIFICATE' "$STATE/bundle.pem") 张证书）"

cat <<EOF

下一步：
  1) 起代理：systemctl --user enable --now feishu-counter.service
  2) 让 lark-cli 走代理（包装脚本已经这么做，检查一下）：
       HTTPS_PROXY=http://127.0.0.1:18080
       SSL_CERT_FILE=$STATE/bundle.pem
       NO_PROXY=127.0.0.1,localhost
  3) 验证：lark-bot im +chat-list --page-size 3 >/dev/null && counter.py -h 看数据
EOF
