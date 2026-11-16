#!/usr/bin/env python3
"""把计数器里的请求按飞书额度口径分成"计入"和"不计入"。

依据《自建应用 API 调用量上限调整说明》(open.feishu.cn/document/platform-notices/platform-updates-/custom-app-api-call-limit)：
认证及授权、事件订阅、通讯录、人事、招聘、绩效、智能门禁、应用引擎、AI 能力、智能伙伴创建平台
这几类 OpenAPI 不占用每月调用量，其余都算。

    quota.py                 今天
    quota.py --day 2026-11-15
    quota.py --json          机器可读
    quota.py --num           只打印计入的那一个数（巡检用）
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys

DEFAULT_STATE = os.path.expanduser('~/.dsh/feishu-counter')

# 文档里列出的"不计入调用量"的业务。路径前缀按开放平台目录归。
EXCLUDED = (
    ('认证及授权', ('/oauth/', '/open-apis/auth/', '/open-apis/passport/', '/open-apis/suite/')),
    ('事件订阅', ('/callback/ws', '/open-apis/event/')),
    ('通讯录', ('/open-apis/contact/',)),
    ('人事/招聘/绩效', ('/open-apis/ehr/', '/open-apis/corehr/', '/open-apis/hire/', '/open-apis/performance/')),
    ('智能门禁', ('/open-apis/acs/',)),
    ('应用引擎', ('/open-apis/apaas/',)),
    ('AI 能力', ('/open-apis/optical_char_recognition/', '/open-apis/speech_to_text/', '/open-apis/ai/')),
    ('智能伙伴', ('/open-apis/aily/',)),
)
# 心跳和 token 打在 accounts.feishu.cn 上，归认证。
AUTH_HOSTS = ('accounts.feishu.cn',)


def classify(host: str, path: str, kind: str = 'api') -> tuple[bool, str]:
    """Return (counts_against_quota, category). A WebSocket that upgraded is an event-subscription call."""
    if kind == 'stream':
        return False, '事件订阅'
    if host in AUTH_HOSTS:
        return False, '认证及授权'
    for name, prefixes in EXCLUDED:
        if any(path.startswith(prefix) for prefix in prefixes):
            return False, name
    return True, '计入额度'


def summarise(db: str, day: str) -> dict:
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    try:
        rows = con.execute('select host, path, kind from request where day=?', (day,)).fetchall()
    finally:
        con.close()
    counted = 0
    excluded: dict[str, int] = {}
    for host, path, kind in rows:
        ok, category = classify(host or '', path or '', kind or 'api')
        if ok:
            counted += 1
        else:
            excluded[category] = excluded.get(category, 0) + 1
    return {'day': day, 'counted': counted, 'excluded': excluded,
            'total': counted + sum(excluded.values())}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--day', default='today')
    parser.add_argument('--state', default=os.environ.get('FEISHU_COUNTER_STATE') or DEFAULT_STATE)
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--num', action='store_true')
    args = parser.parse_args()
    import datetime
    day = datetime.date.today().isoformat() if args.day == 'today' else args.day
    db = os.path.join(args.state, 'counter.sqlite')
    if not os.path.exists(db):
        print(f'没有计数器数据：{db}', file=sys.stderr)
        return 1
    result = summarise(db, day)
    if args.num:
        print(result['counted'])
        return 0
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
        return 0
    print(f"{result['day']}  计入额度 {result['counted']}  不计入 {sum(result['excluded'].values())}  合计 {result['total']}")
    for name, count in sorted(result['excluded'].items(), key=lambda item: -item[1]):
        print(f"  {name:<12}{count:>6}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
