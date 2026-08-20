#!/usr/bin/env python3
"""
Stack-chan → Agent A Workspace Write Test
The real bar: Stack-chan (simulated in harness) writes a file to Agent A's workspace
AS the agent-a agent profile, through the OpenClaw Gateway.

This proves the full binding:
  Stack-chan firmware → Gateway (openclaw/agent-a) → Agent A agent → workspace write
"""

import json
import time
import sys
import os
import urllib.request
import urllib.error

GATEWAY_URL = "http://127.0.0.1:18789/v1/chat/completions"
GATEWAY_AUTH = "Bearer <your-gateway-password>"
MODEL = "openclaw/agent-a"
WORKSPACE = "/Users/<your-host>/openclaw-workspaces/agent-a"
HANDSHAKE_FILE = f"{WORKSPACE}/stackchan-node/test-harness/STACKCHAN_HANDSHAKE.txt"

GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"

def log(msg, level="INFO"):
    ts = time.strftime("%H:%M:%S")
    color = CYAN
    if level == "PASS": color = GREEN
    elif level == "FAIL": color = RED
    elif level == "WARN": color = YELLOW
    print(f"[{ts}] {color}{level}{RESET} {msg}")

def send_chat(messages, model=MODEL, timeout=120):
    payload = json.dumps({
        "model": model,
        "stream": False,
        "messages": messages
    }).encode("utf-8")
    
    req = urllib.request.Request(GATEWAY_URL, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", GATEWAY_AUTH)
    
    try:
        start = time.time()
        resp = urllib.request.urlopen(req, timeout=timeout)
        elapsed = time.time() - start
        body = resp.read().decode("utf-8")
        return json.loads(body), elapsed, None
    except urllib.error.HTTPError as e:
        elapsed = time.time() - start
        body = e.read().decode("utf-8") if e.fp else ""
        return None, elapsed, f"HTTP {e.code}: {body[:300]}"
    except Exception as e:
        return None, 0, str(e)

def strip_emoji(text):
    cleaned = ""
    for ch in text:
        cp = ord(ch)
        if cp >= 0x1F000: continue
        if 0x2700 <= cp <= 0x27BF: continue
        if 0x2600 <= cp <= 0x26FF: continue
        if 0x2300 <= cp <= 0x23FF: continue
        if 0x2460 <= cp <= 0x24FF: continue
        if 0x25A0 <= cp <= 0x25FF: continue
        if 0xFE00 <= cp <= 0xFE0F: continue
        cleaned += ch
    cleaned = cleaned.replace("\n", " ").replace("\r", " ")
    cleaned = cleaned.replace("**", "").replace("__", "")
    if len(cleaned) > 200:
        cut = cleaned.rfind(" ", 0, 200)
        if cut < 100: cut = 200
        cleaned = cleaned[:cut]
    return cleaned.strip()

def main():
    print(f"\n{BOLD}{'='*60}{RESET}")
    print(f"{BOLD}  Stack-chan → Agent A Workspace Write Test{RESET}")
    print(f"{BOLD}  The Bar: Stack-chan writes to Agent A's workspace AS agent-a{RESET}")
    print(f"{BOLD}{'='*60}{RESET}\n")
    
    passed = 0
    failed = 0
    
    # ── Step 1: Verify workspace exists ───────────────────────────
    print(f"{BOLD}Step 1: Verify Agent A's workspace exists{RESET}")
    if os.path.isdir(WORKSPACE):
        log(f"Workspace found: {WORKSPACE}", "PASS")
        passed += 1
    else:
        log(f"Workspace NOT found: {WORKSPACE}", "FAIL")
        failed += 1
        print(f"\n{BOLD}RESULT: {RED}FAIL{RESET} — workspace missing\n")
        sys.exit(1)
    
    # ── Step 2: Clean slate — remove any old handshake file ────────
    print(f"\n{BOLD}Step 2: Clean slate — remove old handshake file{RESET}")
    if os.path.exists(HANDSHAKE_FILE):
        os.remove(HANDSHAKE_FILE)
        log(f"Removed old: {HANDSHAKE_FILE}", "PASS")
    else:
        log(f"No old file to remove (clean)", "PASS")
    passed += 1
    
    # ── Step 3: Stack-chan sends chat request to Gateway ──────────
    # This simulates exactly what OpenClawClient::chat() does:
    # Build messages array with system prompts + user message
    # POST to http://<host>:<port>/v1/chat/completions
    # Model: openclaw/agent-a (the agent binding)
    print(f"\n{BOLD}Step 3: Stack-chan sends write request through Gateway{RESET}")
    print(f"  Model: {MODEL}")
    print(f"  Endpoint: {GATEWAY_URL}")
    print(f"  Target file: {HANDSHAKE_FILE}")
    
    # Build firmware-style message array
    messages = [
        {"role": "system", "content": "You are Agent A, a household operations director."},
        {"role": "system", "content": "User Info: Stack-chan robot test harness."},
        {"role": "user", "content": f"Write a file at {HANDSHAKE_FILE} with exactly this content (no extra formatting):\n\nStack-chan handshake successful.\nWritten by Agent A via openclaw/agent-a model.\nTimestamp: 2026-08-18.\nAgent: agent-a\nWorkspace: {WORKSPACE}\n\nThen tell me you wrote it."}
    ]
    
    log(f"Sending {len(messages)} messages to Gateway...")
    resp, elapsed, err = send_chat(messages, timeout=120)
    
    if err:
        log(f"Gateway request failed: {err}", "FAIL")
        failed += 1
        print(f"\n{BOLD}RESULT: {RED}FAIL{RESET}\n")
        sys.exit(1)
    
    # Parse response firmware-style
    try:
        raw_content = resp["choices"][0]["message"]["content"]
        tts_text = strip_emoji(raw_content)
    except (KeyError, IndexError):
        log(f"Failed to parse Gateway response", "FAIL")
        failed += 1
        sys.exit(1)
    
    log(f"Gateway responded in {elapsed:.1f}s")
    log(f"Agent A said: \"{tts_text[:150]}\"")
    passed += 1
    
    # ── Step 4: Verify the file was ACTUALLY written to disk ───────
    print(f"\n{BOLD}Step 4: Verify file exists on disk{RESET}")
    time.sleep(1)  # Give filesystem a moment
    
    if os.path.exists(HANDSHAKE_FILE):
        file_size = os.path.getsize(HANDSHAKE_FILE)
        with open(HANDSHAKE_FILE, 'r') as f:
            content = f.read()
        
        log(f"File exists! ({file_size} bytes)", "PASS")
        log(f"Content:\n{content}", "PASS")
        
        # Verify content contains expected markers
        checks = [
            ("Stack-chan handshake" in content, "Contains 'Stack-chan handshake'"),
            ("agent-a" in content.lower(), "Contains 'agent-a' agent identifier"),
            ("openclaw/agent-a" in content, "Contains model string 'openclaw/agent-a'"),
            ("2026-08-18" in content, "Contains timestamp"),
            (file_size > 50, f"File size > 50 bytes ({file_size})"),
        ]
        
        all_ok = True
        for check, desc in checks:
            if check:
                log(f"  ✓ {desc}", "PASS")
            else:
                log(f"  ✗ {desc}", "FAIL")
                all_ok = False
        
        if all_ok:
            passed += 1
        else:
            failed += 1
    else:
        log(f"File does NOT exist: {HANDSHAKE_FILE}", "FAIL")
        failed += 1
    
    # ── Step 5: Read it back through the Gateway (proves read+write) ─
    print(f"\n{BOLD}Step 5: Read the file back through Gateway (read + write proven){RESET}")
    
    messages2 = [
        {"role": "system", "content": "You are Agent A, a household operations director."},
        {"role": "user", "content": f"Read the file at {HANDSHAKE_FILE} and tell me the first line."}
    ]
    
    resp2, elapsed2, err2 = send_chat(messages2, timeout=60)
    
    if err2:
        log(f"Read-back failed: {err2}", "WARN")
    else:
        try:
            readback = strip_emoji(resp2["choices"][0]["message"]["content"])
            log(f"Read back in {elapsed2:.1f}s: \"{readback[:100]}\"", "PASS")
            
            if "stack-chan handshake" in readback.lower():
                log(f"File content verified through Gateway ✓", "PASS")
                passed += 1
            else:
                log(f"Content doesn't match expected", "WARN")
        except Exception:
            log(f"Could not parse read-back response", "WARN")
    
    # ── Result ─────────────────────────────────────────────────────
    print(f"\n{BOLD}{'='*60}{RESET}")
    print(f"{BOLD}  RESULT{RESET}")
    print(f"{BOLD}{'='*60}{RESET}")
    print(f"  {GREEN}Passed: {passed}{RESET}")
    print(f"  {RED}Failed: {failed}{RESET}")
    
    if failed == 0:
        print(f"\n  {GREEN}{BOLD}✅ BAR MET{RESET}")
        print(f"  {GREEN}Stack-chan → Gateway (openclaw/agent-a) → Agent A agent → workspace write{RESET}")
        print(f"  {GREEN}File written: {HANDSHAKE_FILE}{RESET}")
        print(f"  {GREEN}Agent binding: CONFIRMED{RESET}")
    else:
        print(f"\n  {RED}{BOLD}❌ BAR NOT MET{RESET}")
    
    print(f"\n{'='*60}\n")
    sys.exit(0 if failed == 0 else 1)

if __name__ == "__main__":
    main()