#!/usr/bin/env python3
"""Turn a Herdr terminal's agent conversation into JSON the convo-reader mod draws.

    extract.py <terminal-address>

Claude Code: finds the session the terminal's process runs (<config>/sessions/<pid>.json,
for every ~/.claude* config dir), reads its transcript JSONL and prints
{"kind": "transcript", "title", "path", "turns": [{"role", "parts": [...]}]}.
Anything else: {"kind": "screen", "title", "text"} from `hc read --lines`.
"""
import glob
import json
import os
import re
import subprocess
import sys

HOME = os.path.expanduser("~")
SCREEN_LINES = 4000
TOOL_RESULT_CHARS = 1200


def hc_json(*args):
    out = subprocess.run(["hc", *args, "--json"], capture_output=True, text=True, timeout=20)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or "hc failed")
    return json.loads(out.stdout)


def child_pids(pid):
    try:
        out = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True, timeout=5).stdout
        return [int(p) for p in out.split()]
    except Exception:
        return []


def find_session(pids):
    """The Claude session file for any of these pids (and their children), newest first."""
    seen, queue = set(), list(pids)
    while queue and len(seen) < 64:
        pid = queue.pop(0)
        if pid in seen:
            continue
        seen.add(pid)
        for path in glob.glob(os.path.join(HOME, ".claude*", "sessions", f"{pid}.json")):
            try:
                with open(path) as f:
                    meta = json.load(f)
                return os.path.dirname(os.path.dirname(path)), meta
            except Exception:
                pass
        queue.extend(child_pids(pid))
    return None, None


def transcript_path(config_dir, meta):
    sid = meta.get("sessionId")
    if not sid:
        return None
    cwd = meta.get("cwd") or ""
    direct = os.path.join(config_dir, "projects", re.sub(r"[^A-Za-z0-9]", "-", cwd), f"{sid}.jsonl")
    if os.path.exists(direct):
        return direct
    hits = glob.glob(os.path.join(config_dir, "projects", "*", f"{sid}.jsonl"))
    return hits[0] if hits else None


# ---- transcript -----------------------------------------------------------------

REMINDER = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
TAG = lambda name: re.compile(rf"<{name}>(.*?)</{name}>", re.S)
CMD_NAME, CMD_ARGS, CMD_OUT = TAG("command-name"), TAG("command-args"), TAG("local-command-stdout")
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def clean_user_text(s):
    s = REMINDER.sub("", s)
    if "<local-command-caveat>" in s:
        return None
    m = CMD_NAME.search(s)
    if m:
        args = CMD_ARGS.search(s)
        a = args.group(1).strip() if args else ""
        return {"kind": "command", "text": f"{m.group(1).strip()} {a}".strip()}
    m = CMD_OUT.search(s)
    if m:
        out = ANSI.sub("", m.group(1)).strip()
        return {"kind": "note", "text": out} if out else None
    if s.lstrip().startswith("<") and re.match(r"\s*<[a-z-]+>", s) and s.rstrip().endswith(">"):
        return None  # other harness wrappers (bash-input, task notifications...)
    s = s.strip()
    return {"kind": "text", "text": s} if s else None


def tool_summary(name, inp):
    inp = inp or {}
    for key in ("description", "command", "file_path", "pattern", "query", "url", "prompt", "skill", "path"):
        v = inp.get(key)
        if isinstance(v, str) and v.strip():
            v = v.strip().splitlines()[0]
            return v[:160] + ("…" if len(v) > 160 else "")
    return ""


def result_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def read_transcript(path):
    turns, tools, title, seen = [], {}, None, set()

    def push(role, part):
        if turns and turns[-1]["role"] == role:
            turns[-1]["parts"].append(part)
        else:
            turns.append({"role": role, "parts": [part]})

    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                d = json.loads(line)
            except Exception:
                continue
            t = d.get("type")
            if t in ("ai-title", "summary", "custom-title"):
                title = d.get("aiTitle") or d.get("customTitle") or d.get("summary") or title
                continue
            if t not in ("user", "assistant") or d.get("isSidechain") or d.get("isMeta"):
                continue
            uid = d.get("uuid")
            if uid in seen:
                continue
            seen.add(uid)
            content = (d.get("message") or {}).get("content")
            if t == "user":
                if isinstance(content, str):
                    part = clean_user_text(content)
                    if part:
                        push("user", part)
                    continue
                for b in content or []:
                    bt = b.get("type")
                    if bt == "text":
                        part = clean_user_text(b.get("text", ""))
                        if part:
                            push("user", part)
                    elif bt == "image":
                        push("user", {"kind": "note", "text": "[image]"})
                    elif bt == "tool_result":
                        tool = tools.get(b.get("tool_use_id"))
                        if tool is not None:
                            txt = ANSI.sub("", result_text(b.get("content"))).strip()
                            tool["error"] = bool(b.get("is_error"))
                            tool["result"] = txt[:TOOL_RESULT_CHARS] + ("\n…" if len(txt) > TOOL_RESULT_CHARS else "")
            else:
                for b in content or []:
                    bt = b.get("type")
                    if bt == "text" and b.get("text", "").strip():
                        push("assistant", {"kind": "text", "text": b["text"].strip()})
                    elif bt == "tool_use":
                        tool = {"kind": "tool", "name": b.get("name", "tool"), "text": tool_summary(b.get("name"), b.get("input"))}
                        tools[b.get("id")] = tool
                        push("assistant", tool)
    return title, turns


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"kind": "error", "text": "usage: extract.py <terminal>"}))
        return
    addr = sys.argv[1]
    try:
        info = hc_json("get", addr)
    except Exception as e:
        print(json.dumps({"kind": "error", "text": f"Can't find terminal {addr}: {e}"}))
        return
    pids = [p for p in ((info.get("foreground") or {}).get("pid"), info.get("pid")) if p]
    config_dir, meta = find_session(pids)
    path = transcript_path(config_dir, meta) if meta else None
    if path:
        title, turns = read_transcript(path)
        print(json.dumps({"kind": "transcript", "title": title or meta.get("name") or info.get("title"),
                          "path": path, "cwd": meta.get("cwd"), "turns": turns}))
        return
    out = subprocess.run(["hc", "read", addr, "--lines", str(SCREEN_LINES)], capture_output=True, text=True, timeout=20)
    print(json.dumps({"kind": "screen", "title": info.get("title") or addr, "text": ANSI.sub("", out.stdout)}))


if __name__ == "__main__":
    main()
