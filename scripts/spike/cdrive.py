#!/usr/bin/env python3
"""Spike driver: runs the real `claude` CLI in stream-json mode and logs every event."""
import json, subprocess, sys, threading, time, uuid, os, queue

LOG = sys.argv[1]
SCENARIO = sys.argv[2]
EXTRA = sys.argv[3:]

events = []
cond = threading.Condition()
logf = open(LOG, "w")
t0 = time.time()


def log(direction, obj):
    rec = {"t": round(time.time() - t0, 3), "dir": direction, "msg": obj}
    logf.write(json.dumps(rec, ensure_ascii=False) + "\n")
    logf.flush()


def spawn(args):
    cmd = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json",
           "--verbose"] + args
    log("spawn", cmd)
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, bufsize=1)

    def rd():
        for line in p.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                obj = {"_raw": line}
            log("out", obj)
            with cond:
                events.append(obj)
                cond.notify_all()
        with cond:
            events.append({"type": "_eof"})
            cond.notify_all()

    def rderr():
        for line in p.stderr:
            log("err", line.rstrip())

    threading.Thread(target=rd, daemon=True).start()
    threading.Thread(target=rderr, daemon=True).start()
    return p


def send(p, obj):
    log("in", obj)
    p.stdin.write(json.dumps(obj) + "\n")
    p.stdin.flush()


rid = 0


def ctrl(p, subtype, **kw):
    global rid
    rid += 1
    r = f"req_{rid}"
    send(p, {"type": "control_request", "request_id": r, "request": {"subtype": subtype, **kw}})
    return wait(lambda e: e.get("type") == "control_response" and e.get("response", {}).get("request_id") == r, 60)


def user(p, text):
    send(p, {"type": "user", "message": {"role": "user", "content": text}, "parent_tool_use_id": None,
             "session_id": ""})


cursor = 0


def wait(pred, timeout=180, auto_allow=True, on_perm=None):
    """Wait for event matching pred; auto-answers can_use_tool requests."""
    global cursor
    end = time.time() + timeout
    while True:
        with cond:
            while cursor >= len(events):
                left = end - time.time()
                if left <= 0:
                    return None
                cond.wait(left)
            e = events[cursor]
            cursor += 1
        if e.get("type") == "control_request" and e.get("request", {}).get("subtype") == "can_use_tool":
            req = e["request"]
            beh = on_perm(req) if on_perm else "allow"
            resp = {"behavior": "allow", "updatedInput": req.get("input", {})} if beh == "allow" else \
                {"behavior": "deny", "message": "denied by spike"}
            send(PROC, {"type": "control_response", "response": {"subtype": "success",
                                                                  "request_id": e["request_id"],
                                                                  "response": resp}})
        if e.get("type") == "_eof":
            return e
        if pred(e):
            return e


def is_result(e):
    return e.get("type") == "result"


PROC = None

if SCENARIO == "basic":
    sid = EXTRA[0]
    PROC = spawn(["--model", "haiku", "--permission-mode", "manual", "--session-id", sid,
                  "--include-partial-messages"])
    ctrl(PROC, "initialize", hooks=None)
    ctrl(PROC, "get_context_usage")
    ctrl(PROC, "list_models")
    user(PROC, "Run this exact bash command with the Bash tool: `echo hello-spike && ls -la`. "
               "Then create file note.txt containing the word spike. Then reply with one short sentence.")
    wait(is_result, 240)
    ctrl(PROC, "set_model", model="sonnet")
    user(PROC, "Which model are you? Answer in 5 words max.")
    wait(is_result, 120)
    ctrl(PROC, "get_context_usage")
    PROC.stdin.close()
    PROC.wait(30)

elif SCENARIO == "resume":
    sid = EXTRA[0]
    PROC = spawn(["--model", "haiku", "--permission-mode", "manual", "--resume", sid])
    ctrl(PROC, "initialize", hooks=None)
    user(PROC, "What word did you write into note.txt earlier? Answer with the word only.")
    wait(is_result, 120)
    PROC.stdin.close()
    PROC.wait(30)

elif SCENARIO == "interrupt":
    sid = EXTRA[0]
    PROC = spawn(["--model", "haiku", "--permission-mode", "manual", "--resume", sid])
    ctrl(PROC, "initialize", hooks=None)
    user(PROC, "Run the bash command `sleep 60 && echo done` with the Bash tool and wait for it.")
    wait(lambda e: e.get("type") == "assistant" and any(
        c.get("type") == "tool_use" for c in e.get("message", {}).get("content", [])), 120)
    time.sleep(3)
    ctrl(PROC, "interrupt")
    wait(is_result, 60)
    # queue a message mid-run: send two user messages quickly
    user(PROC, "Say A.")
    user(PROC, "Say B.")
    wait(is_result, 60)
    wait(is_result, 60)
    PROC.stdin.close()
    PROC.wait(30)

elif SCENARIO == "background":
    sid = EXTRA[0]
    PROC = spawn(["--model", "haiku", "--permission-mode", "bypassPermissions", "--resume", sid,
                  "--allow-dangerously-skip-permissions"])
    ctrl(PROC, "initialize", hooks=None)
    user(PROC, "Start the bash command `for i in 1 2 3 4 5; do echo tick $i; sleep 3; done` in the "
               "background (run_in_background=true). Do not wait for it; immediately reply 'started'.")
    wait(is_result, 120)
    time.sleep(4)
    ctrl(PROC, "background_tasks")
    wait(lambda e: e.get("subtype") == "task_notification", 40)
    wait(is_result, 120)  # CLI may auto-start a turn on notification
    user(PROC, "Start `sleep 300` in the background (run_in_background=true) and reply 'ok'.")
    wait(is_result, 120)
    st = [e for e in events if e.get("subtype") == "task_started"]
    if st:
        ctrl(PROC, "stop_task", task_id=st[-1]["task_id"])
    wait(lambda e: False, 8)
    PROC.stdin.close()
    PROC.wait(30)

elif SCENARIO == "perm":
    sid = EXTRA[0]
    PROC = spawn(["--model", "haiku", "--permission-mode", "manual", "--resume", sid,
                  "--permission-prompt-tool", "stdio"])
    ctrl(PROC, "initialize", hooks=None)
    user(PROC, "Create file note.txt containing the word spike (Write tool). Then run `rm note.txt` "
               "with the Bash tool. Report both outcomes in one sentence.")
    wait(is_result, 120, on_perm=lambda req: "deny" if req.get("tool_name") == "Bash" else "allow")
    PROC.stdin.close()
    PROC.wait(30)

elif SCENARIO == "think":
    sid = EXTRA[0]
    PROC = spawn(["--model", "sonnet", "--resume", sid, "--effort", "high",
                  "--settings", json.dumps({"showThinkingSummaries": True})])
    ctrl(PROC, "initialize", hooks=None)
    user(PROC, "Think step by step: what is 17*23? Answer with the number only.")
    wait(is_result, 120)
    ctrl(PROC, "apply_flag_settings", settings={"effortLevel": "low"})
    user(PROC, "Now 19*21? Number only.")
    wait(is_result, 120)
    PROC.stdin.close()
    PROC.wait(30)

elif SCENARIO == "deny":
    sid = EXTRA[0]
    PROC = spawn(["--model", "haiku", "--permission-mode", "manual", "--resume", sid])
    ctrl(PROC, "initialize", hooks=None)
    user(PROC, "Delete note.txt using the Bash tool (rm note.txt).")
    wait(is_result, 120, on_perm=lambda req: "deny")
    PROC.stdin.close()
    PROC.wait(30)

logf.close()
print("done", SCENARIO)
