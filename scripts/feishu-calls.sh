#!/usr/bin/env bash
# 飞书 API 调用量：按天读出累计和分项。
#
# 数据来自运行库里的 feishu-calls:<本地日期> 记录（src/sources/feishu-loops.ts 每轮写入），
# 所以重启不会丢；服务没跑的日子不会有记录，脚本也就不列。
#
# 用法：
#   scripts/feishu-calls.sh              最近 7 天
#   scripts/feishu-calls.sh -n 30        最近 30 天
#   scripts/feishu-calls.sh --json       机器可读
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DB=${FEISHU_CALLS_DB:-$HOME/.dsh/state/superagent/orchestrator.sqlite}
DAYS=7
JSON=0

while (( $# )); do
  case "$1" in
    -n|--days) DAYS=${2:?需要一个天数}; shift 2 ;;
    --json) JSON=1; shift ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

[[ -f $DB ]] || { echo "找不到运行库：$DB" >&2; exit 1; }

python3 - "$DB" "$DAYS" "$JSON" <<'PY'
import datetime, json, sqlite3, sys, unicodedata

db, days, as_json = sys.argv[1], int(sys.argv[2]), sys.argv[3] == '1'
# 今天还在跑，按它折算会把日用量严重低估，所以预测只用已经过完的日子。
today = datetime.date.today().isoformat()
# 只读打开：服务在跑的时候不能锁库。
con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
rows = con.execute("select key, value from kv where key like 'feishu-calls:%' order by key").fetchall()
con.close()

records = []
for key, value in rows:
    try:
        day = key.split(':', 1)[1]
        data = json.loads(value)
        records.append({'day': day, 'total': int(data.get('total', 0)), 'rounds': int(data.get('rounds', 0)),
                        'byCommand': data.get('byCommand') or {}, 'bySite': data.get('bySite')})
    except (ValueError, TypeError, json.JSONDecodeError):
        continue
records = records[-days:]

if not records:
    print('还没有记录。服务每跑完一轮就会写一条 feishu-calls:<日期>，先让它跑几分钟。')
    raise SystemExit(0)

if as_json:
    print(json.dumps(records, ensure_ascii=False, indent=1))
    raise SystemExit(0)

# 分项的名称对齐一下宽度，并把总量和轮次放到表头行。
names = sorted({name for record in records for name in record['byCommand']})
width = max([len(name) for name in names] + [8])
totals = {name: sum(record['byCommand'].get(name, 0) for record in records) for name in names}

print(f"{'日期':<12}{'调用':>8}{'轮次':>8}{'每轮':>8}")
for record in records:
    per = record['total'] / record['rounds'] if record['rounds'] else 0
    mark = '  (进行中)' if record['day'] == today else ''
    print(f"{record['day']:<12}{record['total']:>8}{record['rounds']:>8}{per:>8.1f}{mark}")

grand = sum(record['total'] for record in records)
span = len(records)
print(f"\n{span} 天合计 {grand} 次，平均 {grand / span:.0f} 次/天")

if names:
    print(f"\n{'按子命令':<{width}}{'次数':>8}{'占比':>8}")
    for name in sorted(totals, key=lambda item: -totals[item]):
        share = totals[name] / grand * 100 if grand else 0
        print(f"{name:<{width}}{totals[name]:>8}{share:>7.1f}%")
    # Before 2026-11-13 a round stored the largest process counter instead of adding its own split, so those records'
    # parts do not sum to their totals. Say so rather than letting a reader read the shares as the whole day's spend.
    split = sum(totals.values())
    if grand and split < grand * 0.95:
        print(f"（注意：这些记录的分项合计只有 {split} 次，少于总数 {grand} 次——"
              "2026-11-13 之前的分项按进程计数器取最大值写入，重启后会丢；此后的记录才逐轮累加。）")

# 调用是从哪儿发出的：同一个 `api GET` 可能是兜底扫描、线程轮询，也可能是工单读上下文，只有这一列分得开。
# 2026-11-13 18:30 之前的记录没有这一项，读成"没测过"，不要当成 0。
SITES = {'sweep': '兜底扫描（会话/话题历史）', 'thread': '线程轮询', 'read': '工单按需读取',
        'write': '发送与回执', 'chats': '会话/成员元数据', 'other': '其他/未标注'}
measured = [record for record in records if record['bySite']]
if measured:
    sites = {}
    for record in measured:
        for name, count in record['bySite'].items():
            sites[name] = sites.get(name, 0) + count
    covered = sum(record['total'] for record in measured)

    # 中文是双宽字符，按字符数补空格会让列歪掉；按显示宽度补，左右对齐都走这一个函数。
    def width(text):
        return sum(2 if unicodedata.east_asian_width(char) in 'WF' else 1 for char in text)
    def cell(text, size, right=False):
        fill = ' ' * max(0, size - width(text))
        return fill + text if right else text + fill
    site_width = max([width(label) for label in SITES.values()] + [8])
    # 占比以"已经按出口计过的那部分"为分母：上线之前的调用没有出口，算进来会把每一行都压小。
    counted = sum(sites.values()) or 1
    print(f"\n{cell('按出口', site_width)}{cell('次数', 8, True)}{cell('占比', 8, True)}")
    for name in sorted(sites, key=lambda item: -sites[item]):
        label = cell(SITES.get(name, name), site_width)
        share = f'{sites[name] / counted * 100:.1f}%'
        print(f"{label}{cell(str(sites[name]), 8, True)}{cell(share, 8, True)}")
    missing = covered - sum(sites.values())
    if missing > 0:
        print(f"（有 {missing} 次发生在这一项上线之前，未计入分出口。）")

# 每月额度是 100 万次；预测只按已经过完的日子，今天还没跑完。
done = [record for record in records if record['day'] != today]
if done:
    average = sum(record['total'] for record in done) / len(done)
    monthly = average * 30
    print(f"\n按 {len(done)} 个完整日子的均值 {average:.0f} 次/天 折算：每月约 {monthly / 10000:.1f} 万次"
          f"（免费额度 100 万/月，占 {monthly / 10000:.0f}%），100 万次可用 {1000000 / average:.0f} 天")
else:
    print("\n还没有走完一整天，先不折算月用量；等明天再看。")
PY
