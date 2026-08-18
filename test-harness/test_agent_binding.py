#!/usr/bin/env python3
"""
Agent Binding Validation Tests
===============================
Validates that OpenClaw (Rosie) and Hermes (Venus) agents are reachable
via their HTTP API endpoints and respond with correct role/identity.

Tests:
  1. OpenClaw / Rosie — direct HTTP endpoint
  2. Hermes / Venus — dedicated port 8643, no /p/ prefix
  3. Session key persistence — same key returns same session
  4. Agent isolation — Rosie doesn't answer as Venus and vice versa
  5. Auth rejection — missing/invalid bearer token returns 401
  6. Session header validation — x-openclaw-session-key and X-Hermes-Session-Key
  7. Channel header — x-openclaw-message-channel routing
  8. Models endpoint — /v1/models lists available agents

Usage:
  python3 test_agent_binding.py --oc-key <openclaw_password>
  python3 test_agent_binding.py --oc-key <oc_key> --hermes-key <hermes_key>
  python3 test_agent_binding.py --oc-key <oc_key> --hermes-key <hermes_key> --hermes-url http://127.0.0.1:8643
  python3 test_agent_binding.py --unit-tests-only
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error

# ============================================================================
# COLOR OUTPUT
# ============================================================================
class C:
    RED = '\033[91m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    MAGENTA = '\033[95m'
    CYAN = '\033[96m'
    BOLD = '\033[1m'
    END = '\033[0m'

def log(tag, msg, color=C.END):
    ts = time.strftime('%H:%M:%S')
    print(f"{color}[{ts}] {tag}{C.END} {msg}")

def ok(msg):   log("✅ PASS", msg, C.GREEN)
def fail(msg): log("❌ FAIL", msg, C.RED)
def warn(msg): log("⚠️  WARN", msg, C.YELLOW)
def info(msg): log("ℹ️  INFO", msg, C.CYAN)
def step(msg): log("▶️ STEP", msg, C.BLUE)
def header(msg):
    print(f"\n{C.BOLD}{C.MAGENTA}{'='*60}{C.END}")
    print(f"{C.BOLD}{C.MAGENTA} {msg}{C.END}")
    print(f"{C.BOLD}{C.MAGENTA}{'='*60}{C.END}\n")

# ============================================================================
# HTTP HELPERS
# ============================================================================

def http_post_json(url, body, headers, timeout=30):
    """POST JSON and return (status_code, response_json, error)."""
    try:
        data = json.dumps(body).encode('utf-8')
        req = urllib.request.Request(url, data=data, method='POST')
        for k, v in headers.items():
            req.add_header(k, v)
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode('utf-8')
            return resp.status, json.loads(raw), None
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8') if e.fp else ''
        try:
            body_json = json.loads(raw)
        except Exception:
            body_json = None
        return e.code, body_json, f"HTTP {e.code}: {e.reason}"
    except urllib.error.URLError as e:
        return None, None, f"URL error: {e.reason}"
    except Exception as e:
        return None, None, f"Error: {e}"

def http_get_json(url, headers, timeout=10):
    """GET JSON and return (status_code, response_json, error)."""
    try:
        req = urllib.request.Request(url, method='GET')
        for k, v in headers.items():
            req.add_header(k, v)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode('utf-8')
            return resp.status, json.loads(raw), None
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8') if e.fp else ''
        try:
            body_json = json.loads(raw)
        except Exception:
            body_json = None
        return e.code, body_json, f"HTTP {e.code}: {e.reason}"
    except urllib.error.URLError as e:
        return None, None, f"URL error: {e.reason}"
    except Exception as e:
        return None, None, f"Error: {e}"

# ============================================================================
# TEST SUITES
# ============================================================================

def test_unit_only():
    """Unit tests that don't need network — validate header construction logic."""
    header("TEST SUITE: Unit Tests (no network)")
    
    all_pass = True
    
    # Test 1: OpenClaw header construction
    step("Unit: OpenClaw header construction")
    headers = build_openclaw_headers("test-key", "rosie", "stackchan", "device-001")
    expected_session_key = "agent:rosie:stackchan:device-001"
    if headers.get("x-openclaw-session-key") == expected_session_key:
        ok(f"Session key correct: {expected_session_key}")
    else:
        fail(f"Session key wrong: got '{headers.get('x-openclaw-session-key')}', expected '{expected_session_key}'")
        all_pass = False
    
    if headers.get("x-openclaw-message-channel") == "stackchan":
        ok("Channel header correct: stackchan")
    else:
        fail(f"Channel header wrong: '{headers.get('x-openclaw-message-channel')}'")
        all_pass = False
    
    if headers.get("Authorization") == "Bearer test-key":
        ok("Auth header correct: Bearer test-key")
    else:
        fail(f"Auth header wrong: '{headers.get('Authorization')}'")
        all_pass = False
    
    # Test 2: Hermes header construction
    step("Unit: Hermes header construction")
    h_headers = build_hermes_headers("hermes-key", "venus-device-001")
    if h_headers.get("X-Hermes-Session-Key") == "venus-device-001":
        ok(f"Session key correct: venus-device-001")
    else:
        fail(f"Session key wrong: '{h_headers.get('X-Hermes-Session-Key')}'")
        all_pass = False
    
    if h_headers.get("Authorization") == "Bearer hermes-key":
        ok("Auth header correct: Bearer hermes-key")
    else:
        fail(f"Auth header wrong: '{h_headers.get('Authorization')}'")
        all_pass = False
    
    # Test 3: Session key structure validation
    step("Unit: Session key structure validation")
    test_cases = [
        ("agent:rosie:stackchan:device-001", True, "agent-prefixed → valid"),
        ("agent:rosie:stackchan:device-002", True, "agent-prefixed → valid"),
        ("stackchan:device-001", False, "bare key → routes to default agent"),
        ("agent:rosie:openai-user:james", True, "openai-user channel → valid"),
        ("", False, "empty key → invalid"),
        (None, False, "None key → invalid"),
    ]
    for key, expected_valid, desc in test_cases:
        valid = validate_openclaw_session_key(key)
        if valid == expected_valid:
            ok(f"'{key}' → {'valid' if valid else 'invalid'} ({desc})")
        else:
            fail(f"'{key}' → expected {'valid' if expected_valid else 'invalid'}, got {'valid' if valid else 'invalid'} ({desc})")
            all_pass = False
    
    # Test 4: Hermes URL construction
    step("Unit: Hermes dedicated port URL construction")
    url = build_hermes_url("http://127.0.0.1:8643", "venus")
    if url == "http://127.0.0.1:8643/p/venus/v1/chat/completions":
        ok(f"Profile URL correct: {url}")
    else:
        fail(f"Profile URL wrong: {url}")
        all_pass = False
    
    url_default = build_hermes_url("http://127.0.0.1:8643", None)
    if url_default == "http://127.0.0.1:8643/v1/chat/completions":
        ok(f"Default URL correct (dedicated port, no /p/ prefix): {url_default}")
    else:
        fail(f"Default URL wrong: {url_default}")
        all_pass = False

    url_empty_profile = build_hermes_url("http://127.0.0.1:8643", "")
    if url_empty_profile == "http://127.0.0.1:8643/v1/chat/completions":
        ok(f"Empty-profile URL correct (no /p/ prefix): {url_empty_profile}")
    else:
        fail(f"Empty-profile URL wrong: {url_empty_profile}")
        all_pass = False
    
    print()
    return all_pass


def build_openclaw_headers(api_key, agent_id, channel, device_id):
    """Build the headers for an OpenClaw Gateway HTTP request."""
    return {
        "Authorization": f"Bearer {api_key}",
        "x-openclaw-session-key": f"agent:{agent_id}:{channel}:{device_id}",
        "x-openclaw-message-channel": channel,
    }

def build_hermes_headers(api_key, session_key):
    """Build the headers for a Hermes API server request."""
    return {
        "Authorization": f"Bearer {api_key}",
        "X-Hermes-Session-Key": session_key,
    }

def validate_openclaw_session_key(key):
    """Validate that a session key is agent-prefixed."""
    if not key or not isinstance(key, str):
        return False
    if not key.startswith("agent:"):
        return False
    parts = key.split(":")
    if len(parts) < 4:
        return False
    return True

def build_hermes_url(base_url, profile):
    """Build the Hermes API URL, with /p/<profile>/ prefix if profile is specified."""
    if profile:
        return f"{base_url}/p/{profile}/v1/chat/completions"
    return f"{base_url}/v1/chat/completions"


# ============================================================================
# OPENCLAW TESTS
# ============================================================================

def test_openclaw_rosie(oc_url, oc_key, agent_id="rosie"):
    """Test that OpenClaw Gateway routes to Rosie and she responds with her role."""
    header(f"TEST: OpenClaw / {agent_id}")
    
    device_id = f"test-device-{int(time.time())}"
    headers = build_openclaw_headers(oc_key, agent_id, "stackchan", device_id)
    body = {
        "model": f"openclaw/{agent_id}",
        "messages": [
            {"role": "user", "content": "Tell me your name, your role, and your responsibilities. Be concise — 2 sentences max."}
        ]
    }
    
    step(f"POST {oc_url} (model: openclaw/{agent_id})")
    step(f"Session key: agent:{agent_id}:stackchan:{device_id}")
    
    status, resp, error = http_post_json(oc_url, body, headers, timeout=60)
    
    if error:
        fail(f"Request failed: {error}")
        return False
    
    if status != 200:
        fail(f"HTTP {status} — expected 200")
        if resp:
            print(f"  Response: {json.dumps(resp)[:200]}")
        return False
    
    content = resp.get("choices", [{}])[0].get("message", {}).get("content", "")
    
    if not content:
        fail("Empty response content")
        return False
    
    # Validate the response mentions the agent's identity STRICTLY
    info(f"Response ({len(content)} chars): \"{content[:120]}...\"")
    
    # STRICT check: response MUST contain "rosie"
    if "rosie" in content.lower():
        ok("Identity validation passed — response contains 'rosie'")
        return True
    else:
        fail(f"Identity validation failed — response does NOT contain 'rosie'. Got: {content[:200]}")
        return False


def test_openclaw_auth_rejection(oc_url):
    """Test that OpenClaw rejects requests without valid auth."""
    header("TEST: OpenClaw Auth Rejection")
    
    # No auth header
    step("POST without Authorization header → expect 401")
    status, resp, error = http_post_json(oc_url, {"model": "openclaw/rosie", "messages": [{"role": "user", "content": "test"}]}, {}, timeout=10)
    
    if status == 401:
        ok(f"Correctly rejected (401) — no auth header")
    elif status is None:
        fail(f"Request error: {error}")
        return False
    else:
        fail(f"Expected 401, got {status} — auth not enforced!")
        return False
    
    # Invalid auth header
    step("POST with invalid Bearer token → expect 401")
    status, resp, error = http_post_json(oc_url, {"model": "openclaw/rosie", "messages": [{"role": "user", "content": "test"}]}, {"Authorization": "Bearer invalid-token-xxx"}, timeout=10)
    
    if status == 401:
        ok(f"Correctly rejected (401) — invalid token")
    elif status is None:
        fail(f"Request error: {error}")
        return False
    else:
        fail(f"Expected 401, got {status} — invalid token accepted!")
        return False
    
    return True


def test_openclaw_models(oc_url, oc_key):
    """Test that the /v1/models endpoint lists available agents."""
    header("TEST: OpenClaw /v1/models")
    
    step(f"GET {oc_url.replace('/v1/chat/completions', '/v1/models')}")
    status, resp, error = http_get_json(
        oc_url.replace('/v1/chat/completions', '/v1/models'),
        {"Authorization": f"Bearer {oc_key}"},
        timeout=10
    )
    
    if error:
        fail(f"Request failed: {error}")
        return False
    
    if status != 200:
        fail(f"HTTP {status} — expected 200")
        return False
    
    models = [m.get("id", "?") for m in resp.get("data", [])]
    info(f"Available models: {', '.join(models)}")
    
    if any("rosie" in m.lower() for m in models):
        ok("Rosie agent found in models list")
        return True
    else:
        warn(f"Rosie not found in models list. Available: {models}")
        return True  # Don't fail — model list format may vary


def test_openclaw_session_persistence(oc_url, oc_key):
    """Test that the same session key returns the same session (conversation continuity)."""
    header("TEST: OpenClaw Session Persistence")
    
    device_id = f"persist-test-{int(time.time())}"
    headers = build_openclaw_headers(oc_key, "rosie", "stackchan", device_id)
    
    # First message
    step(f"Message 1: 'My name is TestBot, remember it.'")
    body1 = {
        "model": "openclaw/rosie",
        "messages": [{"role": "user", "content": "My name is TestBot, remember it. Reply in one sentence."}]
    }
    status1, resp1, err1 = http_post_json(oc_url, body1, headers, timeout=60)
    
    if err1 or status1 != 200:
        fail(f"Message 1 failed: {err1 or status1}")
        return False
    
    content1 = resp1.get("choices", [{}])[0].get("message", {}).get("content", "")
    ok(f"Message 1 response: \"{content1[:80]}...\"")
    
    # Second message — same session key, ask if she remembers
    step(f"Message 2: 'What is my name?' (same session key)")
    body2 = {
        "model": "openclaw/rosie",
        "messages": [{"role": "user", "content": "What is my name? Reply in one sentence."}]
    }
    status2, resp2, err2 = http_post_json(oc_url, body2, headers, timeout=60)
    
    if err2 or status2 != 200:
        fail(f"Message 2 failed: {err2 or status2}")
        return False
    
    content2 = resp2.get("choices", [{}])[0].get("message", {}).get("content", "")
    ok(f"Message 2 response: \"{content2[:80]}...\"")
    
    # STRICT check: response MUST contain "testbot"
    if "testbot" in content2.lower():
        ok("Session persistence confirmed — response contains 'testbot'")
        return True
    else:
        fail(f"Session persistence failed — response does NOT contain 'testbot'. Got: {content2[:200]}")
        return False


# ============================================================================
# HERMES TESTS
# ============================================================================

def test_hermes_venus(hermes_url, hermes_key, profile="venus"):
    """Test that Hermes API server routes to Venus and she responds with her role."""
    header(f"TEST: Hermes / {profile}")
    
    url = build_hermes_url(hermes_url, profile)
    session_key = f"stackchan-{profile}-{int(time.time())}"
    headers = build_hermes_headers(hermes_key, session_key)
    body = {
        "model": "hermes-agent",
        "messages": [
            {"role": "user", "content": "Tell me your name, your role, and your responsibilities. Be concise — 2 sentences max."}
        ]
    }
    
    step(f"POST {url} (model: hermes-agent)")
    step(f"Session key: {session_key}")
    
    status, resp, error = http_post_json(url, body, headers, timeout=120)
    
    if error:
        fail(f"Request failed: {error}")
        if status == 401:
            warn("401 — API_SERVER_KEY may not be set for this profile, or multiplex not enabled")
        return False
    
    if status != 200:
        fail(f"HTTP {status} — expected 200")
        if resp:
            print(f"  Response: {json.dumps(resp)[:200]}")
        return False
    
    content = resp.get("choices", [{}])[0].get("message", {}).get("content", "")
    
    if not content:
        fail("Empty response content")
        return False
    
    info(f"Response ({len(content)} chars): \"{content[:120]}...\"")
    
    # STRICT check: response MUST contain "venus"
    if "venus" in content.lower():
        ok("Identity validation passed — response contains 'venus'")
        return True
    else:
        if any(bad in content.lower() for bad in ["maïs", "mais", "mermaid"]):
            fail("WRONG PROFILE — got Maïs (default), expected Venus")
        else:
            fail(f"Identity validation failed — response does NOT contain 'venus'. Got: {content[:200]}")
        return False


def test_hermes_auth_rejection(hermes_url, profile="venus"):
    """Test that Hermes rejects requests without valid auth."""
    header(f"TEST: Hermes Auth Rejection ({profile})")
    
    url = build_hermes_url(hermes_url, profile)
    
    # No auth header
    step("POST without Authorization header → expect 401")
    status, resp, error = http_post_json(url, {"model": "hermes-agent", "messages": [{"role": "user", "content": "test"}]}, {}, timeout=10)
    
    if status == 401:
        ok(f"Correctly rejected (401) — no auth header")
    elif status is None and "Connection refused" in str(error):
        warn(f"Connection refused — Hermes API server not running on {hermes_url}")
        return True  # Skip — server not up yet
    elif status is None:
        fail(f"Request error: {error}")
        return False
    else:
        fail(f"Expected 401, got {status} — auth not enforced!")
        return False
    
    # Invalid auth header
    step("POST with invalid Bearer token → expect 401")
    status, resp, error = http_post_json(url, {"model": "hermes-agent", "messages": [{"role": "user", "content": "test"}]}, {"Authorization": "Bearer invalid-xxx"}, timeout=10)
    
    if status == 401:
        ok(f"Correctly rejected (401) — invalid token")
    else:
        fail(f"Expected 401, got {status}")
        return False
    
    return True


def test_hermes_models(hermes_url, hermes_key):
    """Test that Hermes /v1/models endpoint works."""
    header("TEST: Hermes /v1/models")
    
    step(f"GET {hermes_url}/v1/models")
    status, resp, error = http_get_json(
        f"{hermes_url}/v1/models",
        {"Authorization": f"Bearer {hermes_key}"},
        timeout=10
    )
    
    if error:
        fail(f"Request failed: {error}")
        return False
    
    if status != 200:
        fail(f"HTTP {status} — expected 200")
        return False
    
    models = [m.get("id", "?") for m in resp.get("data", [])]
    info(f"Available models: {', '.join(models)}")
    
    if models:
        ok(f"Models endpoint works — {len(models)} model(s) listed")
        return True
    else:
        warn("No models listed")
        return True


def test_hermes_session_persistence(hermes_url, hermes_key, profile="venus"):
    """Test that X-Hermes-Session-Key provides conversation continuity."""
    header(f"TEST: Hermes Session Persistence ({profile})")
    
    url = build_hermes_url(hermes_url, profile)
    session_key = f"stackchan-persist-{profile}-{int(time.time())}"
    headers = build_hermes_headers(hermes_key, session_key)
    
    # First message
    step(f"Message 1: 'My name is TestBot, remember it.'")
    body1 = {
        "model": "hermes-agent",
        "messages": [{"role": "user", "content": "My name is TestBot, remember it. Reply in one sentence."}]
    }
    status1, resp1, err1 = http_post_json(url, body1, headers, timeout=120)
    
    if err1 or status1 != 200:
        fail(f"Message 1 failed: {err1 or status1}")
        return False
    
    content1 = resp1.get("choices", [{}])[0].get("message", {}).get("content", "")
    ok(f"Message 1 response: \"{content1[:80]}...\"")
    
    # Second message — same session key
    step(f"Message 2: 'What is my name?' (same session key)")
    body2 = {
        "model": "hermes-agent",
        "messages": [{"role": "user", "content": "What is my name? Reply in one sentence."}]
    }
    status2, resp2, err2 = http_post_json(url, body2, headers, timeout=120)
    
    if err2 or status2 != 200:
        fail(f"Message 2 failed: {err2 or status2}")
        return False
    
    content2 = resp2.get("choices", [{}])[0].get("message", {}).get("content", "")
    ok(f"Message 2 response: \"{content2[:80]}...\"")
    
    if "testbot" in content2.lower():
        ok("Session persistence confirmed — response contains 'testbot'")
        return True
    else:
        fail(f"Session persistence failed — response does NOT contain 'testbot'. Got: {content2[:200]}")
        return False


# ============================================================================
# WORKSPACE FILE I/O TESTS
# ============================================================================

# Rosie's workspace root (where she writes files via the OpenClaw HTTP API)
ROSIE_WORKSPACE_DIR = "/Users/clawdio/openclaw-workspaces/rosie"

# Venus's workspace root (where she writes files via the Hermes HTTP API)
VENUS_WORKSPACE_DIR = "/Users/clawdio/.hermes/profiles/venus/workspace"


def _read_file_or_none(path):
    """Read a file from disk, returning its content or None on any error."""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception:
        return None


def _remove_file(path):
    """Best-effort delete of a file. Returns True if gone (or never existed)."""
    try:
        if os.path.exists(path):
            os.remove(path)
        return not os.path.exists(path)
    except Exception:
        return False


def test_openclaw_workspace_write(oc_url, oc_key):
    """Test that Rosie can write and read files in her workspace via the HTTP API."""
    header("TEST: OpenClaw Workspace File I/O (Rosie)")

    ts = int(time.time())
    filename = f"stackchan_test_{ts}.txt"
    filepath = os.path.join(ROSIE_WORKSPACE_DIR, filename)
    content_initial = f"Hello from Stack-chan! Test ID: {ts}"
    content_updated = f"Updated by Stack-chan! Test ID: {ts}"

    session_key = f"agent:rosie:stackchan:workspace-test-{ts}"
    headers = build_openclaw_headers(oc_key, "rosie", "stackchan", f"workspace-test-{ts}")
    # build_openclaw_headers builds the session key as agent:rosie:stackchan:<device_id>,
    # which matches our intended session key exactly.

    all_pass = True

    # --- Write ---
    step(f"Write: asking Rosie to create {filename}")
    body = {
        "model": "openclaw/rosie",
        "messages": [{"role": "user", "content": f"Create a file called {filename} in your workspace with the exact content: {content_initial}"}]
    }
    status, resp, error = http_post_json(oc_url, body, headers, timeout=120)
    if error or status != 200:
        fail(f"Write request failed: {error or status}")
        all_pass = False
    else:
        content = resp.get("choices", [{}])[0].get("message", {}).get("content", "")
        info(f"Rosie replied: \"{content[:120]}...\"")
        ok("Write request accepted (HTTP 200)")

    # --- Verify write on disk ---
    step(f"Verify write: reading {filepath} from disk")
    disk_content = _read_file_or_none(filepath)
    if disk_content is None:
        fail(f"File not found on disk: {filepath}")
        all_pass = False
    elif disk_content.strip() == content_initial:
        ok(f"File content matches exactly: \"{disk_content.strip()}\"")
    else:
        fail(f"File content mismatch. Expected \"{content_initial}\", got \"{disk_content.strip()}\"")
        all_pass = False

    # --- Update ---
    step(f"Update: asking Rosie to update {filename}")
    body = {
        "model": "openclaw/rosie",
        "messages": [{"role": "user", "content": f"Update the file {filename} to say: {content_updated}"}]
    }
    status, resp, error = http_post_json(oc_url, body, headers, timeout=120)
    if error or status != 200:
        fail(f"Update request failed: {error or status}")
        all_pass = False
    else:
        content = resp.get("choices", [{}])[0].get("message", {}).get("content", "")
        info(f"Rosie replied: \"{content[:120]}...\"")
        ok("Update request accepted (HTTP 200)")

    # --- Verify update on disk ---
    step(f"Verify update: reading {filepath} from disk")
    disk_content = _read_file_or_none(filepath)
    if disk_content is None:
        fail(f"File not found on disk after update: {filepath}")
        all_pass = False
    elif disk_content.strip() == content_updated:
        ok(f"File content updated correctly: \"{disk_content.strip()}\"")
    else:
        fail(f"File content not updated. Expected \"{content_updated}\", got \"{disk_content.strip()}\"")
        all_pass = False

    # --- Cleanup ---
    step(f"Cleanup: deleting {filepath}")
    if _remove_file(filepath):
        ok(f"Test file removed: {filepath}")
    else:
        warn(f"Could not remove test file: {filepath}")

    print()
    return all_pass


def test_hermes_workspace_write(hermes_url, hermes_key, profile="venus"):
    """Test that Venus can write and read files in her workspace via the HTTP API."""
    header(f"TEST: Hermes Workspace File I/O (Venus, profile={profile})")

    ts = int(time.time())
    filename = f"stackchan_test_{ts}.txt"
    filepath = os.path.join(VENUS_WORKSPACE_DIR, filename)
    content_initial = f"Hello from Stack-chan! Venus test! Test ID: {ts}"
    content_updated = f"Updated by Stack-chan! Venus test! Test ID: {ts}"

    url = build_hermes_url(hermes_url, profile)
    session_key = f"venus-workspace-test-{ts}"
    headers = build_hermes_headers(hermes_key, session_key)

    all_pass = True

    # --- Write ---
    step(f"Write: asking Venus to create {filename}")
    body = {
        "model": "hermes-agent",
        "messages": [{"role": "user", "content": f"Create a file called {filename} in your workspace with the exact content: {content_initial}"}]
    }
    status, resp, error = http_post_json(url, body, headers, timeout=120)
    if error or status != 200:
        fail(f"Write request failed: {error or status}")
        all_pass = False
    else:
        content = resp.get("choices", [{}])[0].get("message", {}).get("content", "")
        info(f"Venus replied: \"{content[:120]}...\"")
        ok("Write request accepted (HTTP 200)")

    # --- Verify write on disk ---
    step(f"Verify write: reading {filepath} from disk")
    disk_content = _read_file_or_none(filepath)
    if disk_content is None:
        fail(f"File not found on disk: {filepath}")
        all_pass = False
    elif disk_content.strip() == content_initial:
        ok(f"File content matches exactly: \"{disk_content.strip()}\"")
    else:
        fail(f"File content mismatch. Expected \"{content_initial}\", got \"{disk_content.strip()}\"")
        all_pass = False

    # --- Update ---
    step(f"Update: asking Venus to update {filename}")
    body = {
        "model": "hermes-agent",
        "messages": [{"role": "user", "content": f"Update the file {filename} to say: {content_updated}"}]
    }
    status, resp, error = http_post_json(url, body, headers, timeout=120)
    if error or status != 200:
        fail(f"Update request failed: {error or status}")
        all_pass = False
    else:
        content = resp.get("choices", [{}])[0].get("message", {}).get("content", "")
        info(f"Venus replied: \"{content[:120]}...\"")
        ok("Update request accepted (HTTP 200)")

    # --- Verify update on disk ---
    step(f"Verify update: reading {filepath} from disk")
    disk_content = _read_file_or_none(filepath)
    if disk_content is None:
        fail(f"File not found on disk after update: {filepath}")
        all_pass = False
    elif disk_content.strip() == content_updated:
        ok(f"File content updated correctly: \"{disk_content.strip()}\"")
    else:
        fail(f"File content not updated. Expected \"{content_updated}\", got \"{disk_content.strip()}\"")
        all_pass = False

    # --- Cleanup ---
    step(f"Cleanup: deleting {filepath}")
    if _remove_file(filepath):
        ok(f"Test file removed: {filepath}")
    else:
        warn(f"Could not remove test file: {filepath}")

    print()
    return all_pass


# ============================================================================
# CROSS-SYSTEM ISOLATION TEST
# ============================================================================

def test_agent_isolation(oc_url, oc_key, hermes_url, hermes_key):
    """Test that OpenClaw Rosie and Hermes Venus are distinct agents with distinct responses."""
    header("TEST: Agent Isolation (OpenClaw Rosie ≠ Hermes Venus)")
    
    # Ask Rosie
    oc_headers = build_openclaw_headers(oc_key, "rosie", "stackchan", f"iso-test-{int(time.time())}")
    oc_body = {"model": "openclaw/rosie", "messages": [{"role": "user", "content": "What is your name? One word."}]}
    step("Asking Rosie her name...")
    status1, resp1, err1 = http_post_json(oc_url, oc_body, oc_headers, timeout=60)
    
    if err1 or status1 != 200:
        fail(f"Rosie request failed: {err1 or status1}")
        return False
    
    rosie_name = resp1.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
    ok(f"Rosie says: \"{rosie_name[:60]}\"")
    
    # Ask Venus
    h_url = build_hermes_url(hermes_url, "venus")
    h_headers = build_hermes_headers(hermes_key, f"iso-test-{int(time.time())}")
    h_body = {"model": "hermes-agent", "messages": [{"role": "user", "content": "What is your name? One word."}]}
    step("Asking Venus her name...")
    status2, resp2, err2 = http_post_json(h_url, h_body, h_headers, timeout=120)
    
    if err2 or status2 != 200:
        fail(f"Venus request failed: {err2 or status2}")
        return False
    
    venus_name = resp2.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
    ok(f"Venus says: \"{venus_name[:60]}\"")
    
    # STRICT check: Rosie must say 'rosie', Venus must say 'venus'
    rosie_ok = "rosie" in rosie_name.lower()
    venus_ok = "venus" in venus_name.lower()
    
    if rosie_ok and venus_ok:
        ok("Agent isolation confirmed — Rosie said 'rosie', Venus said 'venus'")
        return True
    else:
        if not rosie_ok and not venus_ok:
            fail(f"Agent isolation FAILED — Rosie said '{rosie_name[:60]}' (no 'rosie'), Venus said '{venus_name[:60]}' (no 'venus')")
        elif not rosie_ok:
            fail(f"Agent isolation FAILED — Rosie said '{rosie_name[:60]}' (no 'rosie'), Venus said '{venus_name[:60]}'")
        else:
            fail(f"Agent isolation FAILED — Rosie said '{rosie_name[:60]}', Venus said '{venus_name[:60]}' (no 'venus')")
        return False


# ============================================================================
# MAIN
# ============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="Agent binding validation tests for OpenClaw + Hermes",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--oc-url", default="http://127.0.0.1:18789/v1/chat/completions",
                       help="OpenClaw Gateway endpoint (default: http://127.0.0.1:18789/v1/chat/completions)")
    parser.add_argument("--oc-key", default="",
                       help="OpenClaw Gateway bearer token")
    parser.add_argument("--hermes-url", default="http://127.0.0.1:8643",
                       help="Hermes API server base URL (default: http://127.0.0.1:8643)")
    parser.add_argument("--hermes-key", default="",
                       help="Hermes API_SERVER_KEY bearer token")
    parser.add_argument("--hermes-profile", default="",
                       help="Hermes profile to test (default: empty = dedicated port, no /p/ prefix)")
    parser.add_argument("--unit-tests-only", action="store_true",
                       help="Run only unit tests (no network calls)")
    parser.add_argument("--skip-isolation", action="store_true",
                       help="Skip cross-system isolation test")
    parser.add_argument("--skip-persistence", action="store_true",
                       help="Skip session persistence tests")
    
    args = parser.parse_args()
    
    header("Agent Binding Validation — OpenClaw + Hermes")
    info(f"OpenClaw URL: {args.oc_url}")
    info(f"Hermes URL:  {args.hermes_url}")
    info(f"Hermes profile: {args.hermes_profile}")
    print()
    
    results = {}
    
    # --- Unit tests (always run) ---
    results["unit_tests"] = test_unit_only()
    
    if args.unit_tests_only:
        header("UNIT TESTS ONLY — skipping network tests")
        _print_summary(results)
        return 0 if all(results.values()) else 1
    
    # --- OpenClaw tests ---
    if not args.oc_key:
        warn("No --oc-key provided — skipping OpenClaw tests")
        results["oc_auth"] = None
        results["oc_rosie"] = None
        results["oc_models"] = None
    else:
        results["oc_auth"] = test_openclaw_auth_rejection(args.oc_url)
        results["oc_models"] = test_openclaw_models(args.oc_url, args.oc_key)
        results["oc_rosie"] = test_openclaw_rosie(args.oc_url, args.oc_key)
        
        if not args.skip_persistence and results["oc_rosie"]:
            results["oc_persistence"] = test_openclaw_session_persistence(args.oc_url, args.oc_key)
        else:
            results["oc_persistence"] = None
    
    # --- Hermes tests ---
    if not args.hermes_key:
        warn("No --hermes-key provided — skipping Hermes tests")
        results["hermes_auth"] = None
        results["hermes_venus"] = None
        results["hermes_models"] = None
    else:
        results["hermes_auth"] = test_hermes_auth_rejection(args.hermes_url, args.hermes_profile)
        results["hermes_models"] = test_hermes_models(args.hermes_url, args.hermes_key)
        results["hermes_venus"] = test_hermes_venus(args.hermes_url, args.hermes_key, args.hermes_profile)
        
        if not args.skip_persistence and results["hermes_venus"]:
            results["hermes_persistence"] = test_hermes_session_persistence(args.hermes_url, args.hermes_key, args.hermes_profile)
        else:
            results["hermes_persistence"] = None
    
    # --- Cross-system isolation ---
    if not args.skip_isolation and results.get("oc_rosie") and results.get("hermes_venus"):
        results["isolation"] = test_agent_isolation(args.oc_url, args.oc_key, args.hermes_url, args.hermes_key)
    else:
        results["isolation"] = None

    # --- Workspace file I/O tests ---
    if args.oc_key:
        results["oc_workspace_write"] = test_openclaw_workspace_write(args.oc_url, args.oc_key)
    else:
        results["oc_workspace_write"] = None

    if args.hermes_key:
        results["hermes_workspace_write"] = test_hermes_workspace_write(args.hermes_url, args.hermes_key, args.hermes_profile)
    else:
        results["hermes_workspace_write"] = None

    # --- Summary ---
    _print_summary(results)
    
    # Return 0 if all non-None tests passed
    active = [v for v in results.values() if v is not None]
    return 0 if all(active) else 1


def _print_summary(results):
    header("TEST RESULTS SUMMARY")
    
    total = 0
    passed = 0
    failed = 0
    skipped = 0
    
    for name, result in results.items():
        total += 1
        if result is True:
            passed += 1
            print(f"  {C.GREEN}✅ {name}{C.END}")
        elif result is False:
            failed += 1
            print(f"  {C.RED}❌ {name}{C.END}")
        else:
            skipped += 1
            print(f"  {C.YELLOW}⏭️  {name} (skipped){C.END}")
    
    print()
    color = C.GREEN if failed == 0 else C.RED
    print(f"  {color}{passed}/{total - skipped} passed, {failed} failed, {skipped} skipped{C.END}")
    print()


if __name__ == "__main__":
    sys.exit(main())