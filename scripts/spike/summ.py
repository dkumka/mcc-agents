#!/usr/bin/env python3
"""Compact summary of a spike log: one line per event, long fields truncated."""
import json, sys

MAX = int(sys.argv[2]) if len(sys.argv) > 2 else 300


def short(o, n=MAX):
    s = json.dumps(o, ensure_ascii=False)
    return s if len(s) <= n else s[:n] + f"...(+{len(s) - n})"


for line in open(sys.argv[1]):
    r = json.loads(line)
    m = r["msg"]
    d = r["dir"]
    if d == "out" and isinstance(m, dict):
        t = m.get("type")
        if t == "stream_event":
            ev = m.get("event", {})
            et = ev.get("type")
            if et in ("content_block_delta",):
                continue
            print(r["t"], "out stream_event", et, short(ev.get("content_block") or ev.get("delta") or "", 120))
            continue
        sub = m.get("subtype") or (m.get("request") or {}).get("subtype") or (m.get("response") or {}).get("subtype")
        print(r["t"], d, t, sub, short(m))
    else:
        print(r["t"], d, short(m))
