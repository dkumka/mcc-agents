#!/usr/bin/env python3
"""Spike driver for `codex app-server` (JSON-RPC over stdio). Logs every message."""
import json, subprocess, sys, threading, time

LOG = sys.argv[1]
SCENARIO = sys.argv[2]
EXTRA = sys.argv[3:]
logf = open(LOG, "w")
t0 = time.time()
msgs = []
cond = threading.Condition()


def log(d, o):
    logf.write(json.dumps({"t": round(time.time() - t0, 3), "dir": d, "msg": o}, ensure_ascii=False) + "\n")
    logf.flush()


p = subprocess.Popen(["codex", "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.PIPE, text=True, bufsize=1)


def rd():
    for line in p.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            o = {"_raw": line}
        log("out", o)
        with cond:
            msgs.append(o)
            cond.notify_all()


def rde():
    for line in p.stderr:
        log("err", line.rstrip())


threading.Thread(target=rd, daemon=True).start()
threading.Thread(target=rde, daemon=True).start()
nid = 0


def send(o):
    log("in", o)
    p.stdin.write(json.dumps(o) + "\n")
    p.stdin.flush()


cur = 0
DECIDE = {"default": "accept"}


def pump(pred, timeout):
    """Process messages until pred matches; answers approval requests per DECIDE."""
    global cur
    end = time.time() + timeout
    while True:
        with cond:
            while cur >= len(msgs):
                left = end - time.time()
                if left <= 0:
                    return None
                cond.wait(left)
            m = msgs[cur]
            cur += 1
        meth = m.get("method", "")
        if "id" in m and meth.endswith("requestApproval"):
            dec = DECIDE.get(meth, DECIDE["default"])
            send({"id": m["id"], "result": {"decision": dec}})
        if pred(m):
            return m


def req(method, params=None, timeout=60):
    global nid
    nid += 1
    i = nid
    send({"method": method, "id": i, "params": params or {}})
    return pump(lambda m: m.get("id") == i and ("result" in m or "error" in m), timeout)


def turn(thread_id, text, timeout=240, **kw):
    r = req("turn/start", {"threadId": thread_id, "input": [{"type": "text", "text": text, "text_elements": []}], **kw})
    return r, pump(lambda m: m.get("method") == "turn/completed", timeout)


req("initialize", {"clientInfo": {"name": "mcc_agents_spike", "title": "mcc agents spike", "version": "0.0.1"},
                   "capabilities": None})
send({"method": "initialized"})

if SCENARIO == "basic":
    req("account/read", {})
    req("account/rateLimits/read")
    req("model/list", {})
    r = req("thread/start", {"cwd": "/tmp/agent-spike/proj", "model": EXTRA[0] if EXTRA else None,
                             "approvalPolicy": "untrusted", "sandbox": "danger-full-access"})
    tid = r["result"]["thread"]["id"]
    open("/tmp/agent-spike/codex-tid", "w").write(tid)
    turn(tid, "Run the shell command `echo hello-codex && ls` and then create file codex.txt with the text hi. "
              "Reply in one short sentence.")
    DECIDE["default"] = "decline"
    turn(tid, "Now delete codex.txt with `rm codex.txt`. Report the outcome in one sentence.")
    # interrupt
    DECIDE["default"] = "accept"
    r = req("turn/start", {"threadId": tid, "input": [{"type": "text", "text": "Run `sleep 30; echo z` and wait.",
                                                       "text_elements": []}]})
    turn_id = r["result"]["turn"]["id"]
    pump(lambda m: m.get("method") == "item/started" and m["params"]["item"].get("type") == "commandExecution", 120)
    time.sleep(3)
    req("turn/interrupt", {"threadId": tid, "turnId": turn_id})
    pump(lambda m: m.get("method") == "turn/completed", 60)
    req("account/rateLimits/read")

elif SCENARIO == "resume":
    tid = open("/tmp/agent-spike/codex-tid").read().strip()
    req("thread/list", {"limit": 5})
    r = req("thread/resume", {"threadId": tid, "excludeTurns": True})
    req("thread/turns/list", {"threadId": tid})
    turn(tid, "What text did you write into codex.txt? Answer with the text only.", effort="low")

p.stdin.close()
time.sleep(1)
p.terminate()
logf.close()
print("done", SCENARIO)
