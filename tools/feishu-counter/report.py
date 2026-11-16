#!/usr/bin/env python3
"""读出本机计数代理落下的请求，和编排进程自己记的调用量对照。

    report.py                 最近两天，按天 + 端点 + 调用方
    report.py -n 7            最近一周
    report.py --by hour       某天的分时

两边的口径不一样，对照表就是给这件事用的：代理数的是 HTTP 请求（含翻页、token、别的进程），
编排进程数的是自己发出的 CLI 调用。差多少、差在哪，看最后那张表。
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys

DEFAULT_STATE = os.path.expanduser('~/.dsh/feishu-counter')
ORCHESTRATOR = os.path.expanduser('~/.dsh/state/superagent/orchestrator.sqlite')


def width(text: str) -> int:
    return sum(2 if ord(char) > 0x2E80 else 1 for char in text)


def cell(text: str, size: int, right: bool = False) -> str:
    fill = ' ' * max(0, size - width(text))
    return fill + text if right else text + fill


def table(title: str, rows: list[tuple[str, int]], total: int | None = None, label: str = '次数') -> None:
    if not rows:
        return
    left = max([width(row[0]) for row in rows] + [width(title), 6])
    print(f"\n{cell(title, left)}{cell(label, 8, True)}{cell('占比', 8, True)}")
    base = total if total is not None else (sum(count for _, count in rows) or 1)
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
    import json
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
    args = parser.parse_args()

    db = os.path.join(args.state, 'counter.sqlite')
    if not os.path.exists(db):
        print(f'还没有数据：{db} 不存在。先起代理，再让 lark-cli 走它一次。')
        return 1
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    days = [row[0] for row in con.execute('select distinct day from request order by day desc limit ?', (args.days,))]
    days.reverse()
    app = read_app(args.orchestrator)

    print(f"{'日期':<12}{'HTTP 请求':>10}{'接口':>8}{'token':>8}{'长连接':>8}{'编排自记':>10}{'差':>8}")
    for day in days:
        row = con.execute("select count(*), sum(kind='api'), sum(kind='token'), sum(kind='stream')"
                          ' from request where day=?', (day,)).fetchone()
        total, api, token, stream = (value or 0 for value in row)
        recorded = app.get(day)
        delta = '' if recorded is None else f'{total - recorded:+d}'
        print(f"{day:<12}{total:>10}{api:>8}{token:>8}{stream:>8}{(recorded if recorded is not None else '-'):>10}{delta:>8}")

    latest = days[-1] if days else None
    if latest:
        print(f"\n—— {latest} 明细（只算接口请求，不含 token 和长连接）——")
        rows = con.execute("select path, count(*) from request where day=? and kind='api'"
                           ' group by path order by 2 desc limit 15', (latest,)).fetchall()
        table('端点', [(path, count) for path, count in rows])
        if args.by != 'path':
            column = {'role': 'role', 'host': 'host'}[args.by]
            rows = con.execute(f"select {column}, count(*) from request where day=? and kind='api'"
                               f' group by {column} order by 2 desc limit 10', (latest,)).fetchall()
            table({'role': '调用方', 'host': '域名'}[args.by], [(name or '-', count) for name, count in rows])
        rows = con.execute("select hour, count(*) from request where day=? and kind='api' group by hour order by hour",
                           (latest,)).fetchall()
        print('\n分时：' + '  '.join(f'{hour:02d}点 {count}' for hour, count in rows if count))
        first, last = con.execute('select min(at), max(at) from request where day=?', (latest,)).fetchone()
        print(f'\n计数窗口：{first} → {last}；与"编排自记"的差只在这个窗口内才有意义。')
    con.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
