#!/usr/bin/env python3
"""读出本机计数代理落下的请求，按额度口径分开，并和编排进程自己记的调用量对照。

    report.py                 最近两天
    report.py -n 7            最近一周
    report.py --by role       调用方
    report.py --json          机器可读

"计入额度"按 `quota.py` 的分类：飞书文档列出的认证及授权、事件订阅、通讯录等不计入每月调用量。
"编排自记"是编排进程自己数的 CLI 调用（KV `feishu-calls:<日期>`），口径更窄——只看得到自己的轮询，
看不到工单会话、文档检索，和一次调用内部的翻页，所以两列本来就不该相等。
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from quota import classify, summarise  # noqa: E402

DEFAULT_STATE = os.path.expanduser('~/.dsh/feishu-counter')
ORCHESTRATOR = os.path.expanduser('~/.dsh/state/superagent/orchestrator.sqlite')


def width(text: str) -> int:
    return sum(2 if ord(char) > 0x2E80 else 1 for char in text)


def cell(text: str, size: int, right: bool = False) -> str:
    fill = ' ' * max(0, size - width(text))
    return fill + text if right else text + fill


def table(title: str, rows: list[tuple[str, int]], label: str = '次数') -> None:
    if not rows:
        return
    left = max([width(row[0]) for row in rows] + [width(title), 6])
    base = sum(count for _, count in rows) or 1
    print(f"\n{cell(title, left)}{cell(label, 8, True)}{cell('占比', 8, True)}")
    for name, count in rows:
        print(f"{cell(name, left)}{cell(str(count), 8, True)}{cell(f'{count / base * 100:.1f}%', 8, True)}")


def read_app(db: str) -> dict[str, int]:
    if not os.path.exists(db):
        return {}
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    try:
        rows = con.execute("select key, value from kv where key like 'feishu-calls:%'").fetchall()
    finally:
        con.close()
    out: dict[str, int] = {}
    for key, value in rows:
        try:
            out[key.split(':', 1)[1]] = int(json.loads(value).get('total', 0))
        except (ValueError, TypeError):
            continue
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('-n', '--days', type=int, default=2)
    parser.add_argument('--state', default=os.environ.get('FEISHU_COUNTER_STATE') or DEFAULT_STATE)
    parser.add_argument('--orchestrator', default=ORCHESTRATOR)
    parser.add_argument('--by', choices=['role', 'path', 'host'], default='path')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    db = os.path.join(args.state, 'counter.sqlite')
    if not os.path.exists(db):
        print(f'还没有数据：{db} 不存在。先起代理，再让 lark-cli 走它一次。')
        return 1
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    days = [row[0] for row in con.execute('select distinct day from request order by day desc limit ?', (args.days,))]
    days.reverse()
    app = read_app(args.orchestrator)
    summary = {day: summarise(db, day) for day in days}

    if args.json:
        print(json.dumps({'days': [summary[day] | {'orchestrator': app.get(day)} for day in days]}, ensure_ascii=False))
        return 0

    print(f"{'日期':<12}{'计入额度':>10}{'不计入':>8}{'合计':>8}{'编排自记':>10}{'差':>8}")
    for day in days:
        s = summary[day]
        recorded = app.get(day)
        delta = '' if recorded is None else f"{s['counted'] - recorded:+d}"
        print(f"{day:<12}{s['counted']:>10}{sum(s['excluded'].values()):>8}{s['total']:>8}"
              f"{(recorded if recorded is not None else '-'):>10}{delta:>8}")
    print('（"差"＝网络层计入额度次数 − 编排自记：正数说明还有别的进程在调，或一次调用翻了多页。）')

    latest = days[-1] if days else None
    if latest:
        print(f"\n—— {latest} 明细（只统计计入额度的请求）——")
        rows = con.execute('select host, path, role, kind from request where day=?', (latest,)).fetchall()
        counted = [(host, path, role) for host, path, role, kind in rows
                   if classify(host or '', path or '', kind or 'api')[0]]
        by_path: dict[str, int] = {}
        for _, path, _role in counted:
            by_path[path or '/'] = by_path.get(path or '/', 0) + 1
        table('端点', sorted(by_path.items(), key=lambda item: -item[1])[:12])
        if args.by != 'path':
            index = 0 if args.by == 'host' else 2
            by_key: dict[str, int] = {}
            for row in counted:
                by_key[row[index] or '-'] = by_key.get(row[index] or '-', 0) + 1
            table({'role': '调用方', 'host': '域名'}[args.by],
                  sorted(by_key.items(), key=lambda item: -item[1])[:10])
        hours = con.execute('select hour, count(*) from request where day=? group by hour order by hour', (latest,)).fetchall()
        print('\n分时（全部请求）：' + '  '.join(f'{hour:02d}点 {count}' for hour, count in hours if count))
        if summary[latest]['excluded']:
            parts = '，'.join(f'{name} {count}' for name, count in
                              sorted(summary[latest]['excluded'].items(), key=lambda item: -item[1]))
            print(f'不计入额度：{parts}')
        first, last = con.execute('select min(at), max(at) from request where day=?', (latest,)).fetchone()
        print(f'计数窗口：{first} → {last}')
    con.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
