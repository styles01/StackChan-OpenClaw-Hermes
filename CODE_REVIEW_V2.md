# Code Review — Stack-chan × OpenClaw Integration (V2)

**Date:** 2026-08-18
**Reviewer:** Dex (subagent)
**Scope:** OpenClaw client firmware + test harness

Files reviewed:
- `firmware/src/llm/OpenClaw/OpenClawClient.cpp` / `.h`
- `firmware/src/StackchanExConfig.h` / `.cpp`
- `firmware/src/WebAPI.cpp`
- `firmware/src/Robot.cpp`
- `test-harness/test_agent_binding.py`

---

## Summary

The integration is structurally sound: the backend selector (`backend` 0=OpenClaw, 1=Hermes) is cleanly plumbed through config → Robot → OpenClawClient, the response parsing is defensive (handles empty / error / missing-content / null cases), and the test harness covers identity, auth rejection, session persistence, agent isolation, and workspace file I/O.

However, there is **one show-stopping correctness bug** (config YAML write drops all non-OpenClaw config, which would reboot the device into the wrong LLM type) and **one security-critical gap** (the v1 session/channel headers are not sent, plus all config endpoints are unauthenticated and expose the Telegram bot token in plaintext). Several buffer-size and thread-safety concerns are also worth fixing before flashing.

---

## Critical Issues (must fix before firmware flash)

### C1. http_post_json() does not send any OpenClaw/Hermes session or channel headers — the main v1 gap
`firmware/src/llm/OpenClaw/OpenClawClient.cpp` — `http_post_json()` (~line 305)

```cpp
String OpenClawClient::http_post_json(const char* url, const char* json_string) {
  String payload = "";
  HTTPClient http;
  http.setTimeout(65000);
  if (http.begin(url)) {
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", String("Bearer ") + param.api_key);
    int httpCode = http.POST((uint8_t *)json_string, strlen(json_string));
```

Only `Authorization` is sent. The v1 binding requires at minimum:
- `x-openclaw-session-key: agent:<agent_id>:<channel>:<device_id>`
- `x-openclaw-message-channel: <channel>`

And for the Hermes backend, `X-Hermes-Session-Key` plus the Hermes `bot_token` (currently **no header is sent for Hermes auth at all** — the `hermesConfig` `bot_token`/`api key` is never used in the request). As written, every request from the device:
- routes to whatever agent the gateway defaults to (no agent binding),
- starts a **new session every message** (no conversation continuity),
- and the Hermes path sends only the OpenClaw `param.api_key` as Bearer, which the Hermes `API_SERVER_KEY` will reject (→ 401, the "Connection error"/API error path).

**Fix (v1):** branch on `backend` and inject the proper headers before `http.POST`:
```cpp
if (backend == 1) {
  http.addHeader("X-Hermes-Session-Key", String("stackchan-") + ...);
  http.addHeader("Authorization", String("Bearer ") + hermesConfig.bot_token);
} else {
  http.addHeader("x-openclaw-session-key",
                 String("agent:") + openclawConfig.agent_id + ":stackchan:" + sessionId);
  http.addHeader("x-openclaw-message-channel", "stackchan");
}
```
Note: a per-device `sessionId` needs to be generated once and stored (NVS/SPIFFS) so the session persists across reboots.

### C2. Config YAML write does NOT round-trip — data loss on every POST /config
`firmware/src/WebAPI.cpp` — `handle_config_set()` (~line 340) vs `firmware/src/StackchanExConfig.cpp` — `setExtendSettings()`.

The writer emits **only** `backend`, `openclaw`, `hermes`:
```cpp
f.print("backend: "); f.println(cfg.backend);
f.println("openclaw:");
f.print("  host: "); ...
```

But the loader (`setExtendSettings`) reads the full structure including `llm`, `tts`, `stt`, `wakeword`, `moduleLLM`:
```cpp
_ex_parameters.llm.type = doc["llm"]["type"].as<int>();
...
_ex_parameters.tts.type = doc["tts"]["type"].as<int>();
...
```
After a `/config` POST + reboot, the `llm.type` etc. default to **0** (ChatGPT) instead of the OPENCLAW type (4), the STT/TTS types go to 0 (Google STT, VoiceVox), `moduleLLM.rxPin/txPin` go to 0. The device will come up configured for a **different hardware/AI setup** than intended — effectively bricking the OpenClaw integration until a full config file is restored.

**Fix:** serialize the **entire** `ex_config_s` (including llm/tts/stt/wakeword/moduleLLM) to YAML, or better, generate the YAML from a single `serializeYml`/ArduinoJson round-trip rather than hand-formatting, and have the writer read+merge the existing config file before overwriting. Also quote/escape string values in YAML.

### C3. All config/chat/role endpoints are unauthenticated, and GET /api/config exposes secrets
`firmware/src/WebAPI.cpp` — `handle_config_get()` (~line 290).

```cpp
void handle_config_get() {
  DynamicJsonDocument doc(1024);
  JsonObject root = doc.to<JsonObject>();
  serializeExConfig(root, robot->m_config.getExConfig());
  String response;
  serializeJson(doc, response);
  server.send(200, "application/json", response);
}
```
`serializeExConfig` includes `bot_token` for both agents. The ESP32 listens on port 80 on the LAN with **no authentication** on `/config`, `/role_get`, `/memory_get`, `/chat`, `/speech`, etc. Any device on the network can:
- read the Telegram bot token + agent credentials (`GET /config`),
- overwrite the config (`POST /config`),
- drive speech (`/speech`, `/chat`).

**Fix:** at minimum require a shared admin token header on mutating endpoints, and **do not return `bot_token`/api keys** from `/config` (return them masked, e.g. `"bot_token": "sk-***abc"`).

### C4. DynamicJsonDocument(1024) buffers are too small for the config
`firmware/src/WebAPI.cpp` — `handle_config_get()` and `handle_config_set()` both use `DynamicJsonDocument doc(1024)`.

The full serialized config includes two `bot_token` fields (Telegram bot tokens are ~46 chars each) plus host/port/model/agent_id for both backends. Serializing the get path and deserializing the POST body can exceed 1024 bytes → the JSON is truncated (`get`) or rejected with "Invalid JSON" / `JsonDocument capacity` (`set`). Because `deserializeJson` into an oversized doc returns a capacity error, a legitimately large config POST can be rejected with 400.

**Fix:** size both to at least 2048 (ideally 4096) and check `doc.capacity() == 0` / `overFlowed()` on deserialize.

---

## Recommended improvements (should fix soon)

### R1. chatHistory grows unbounded — long-run memory/request bloat
`firmware/src/llm/OpenClaw/OpenClawClient.cpp` — `chat()` (~line 218)

```cpp
chatHistory.push_back(String("user"), String(""), text);
// ...rebuild messages from full history ...
for (int i = 0; i < chatHistory.get_size(); i++) { ... }
```
Every turn appends 2 entries and the whole history is re-serialized and re-sent. Over a long session this grows without bound — each request gets bigger, and ESP32 RAM/heap is exhausted. This is a slow-burn memory leak. **Fix:** cap the number of retained turns (e.g. keep last N=20 user/assistant pairs) and drop the oldest.

### R2. Thread-safety on the avatar / LLM state
`firmware/src/Robot.cpp` `chat()` (`robot->chat(text)` called from `handle_chat` in the HTTP server thread) and the main loop both touch `llm`, `avatar`, `chatHistory`, and `robot->speech()` (TTS stream). There is **no mutex** around `LLMBase.chat`/`speech`, so a LAN HTTP request concurrent with a wake-word-triggered loop can:
- interleave `chatHistory` writes (corruption),
- double-drive the TTS/Avatar concurrently.

**Fix:** guard `Robot::chat()` and `Robot::speech()` with a FreeRTOS mutex (the codebase already uses FreeRTOS tasks).

### R3. `http.begin` with no TLS — bearer token in cleartext
`firmware/src/llm/OpenClaw/OpenClawClient.cpp` ~line 305 has a `// TODO: Add TLS support for production use`. The token (and the whole conversation) travel over plaintext HTTP. Acceptable for a LAN/gateway, but flagging — if the gateway is ever exposed beyond the local network this must be HTTPS.

### R4. stripEmoji reads p[1],p[2] without a length bound
`firmware/src/llm/OpenClaw/OpenClawClient.cpp` — `stripEmoji()`.

The loop advances `p` by 1,2,3,4 depending on the leading byte, but the 2-byte/3-byte branches read `p[1]`/`p[2]` unconditionally. Arduino `String` is NUL-terminated, so a truncated multibyte sequence reads at most NULs (safe in practice), but a non-NUL-terminated `const char*` input or corrupted response could read past the buffer. Defensive fix: check `p[1] != '\0'` / `p[2] != '\0'` before consuming, and verify continuation bytes are `0b10xxxxxx`.

### R5. Response parse buffer 8192 may be too small
`firmware/src/llm/OpenClaw/OpenClawClient.cpp` ~line 250 — `SpiRamJsonDocument doc(8192)`. If the model returns a long reply, the full JSON must fit in 8 KB or it parses as "Parse error". Since the device caps speech to 200 chars, consider streaming or raising the buffer / trimming the raw payload before parse.

### R6. SpiRamJsonDocument(8192) is stack/PSRAM — verify no hard-fault path
Confirm the error paths (`"Connection error"`, `"Parse error"`, `"API error"`, `"Response error"`) never leave the avatar in a stuck "Thinking..." state (they do reset to Neutral/Sad correctly). Good — but note `robot->speech(response)` is still called on error strings, so the robot **speaks** the error text (e.g. "Parse error"). That's acceptable, but confirm it's intended.

### R7. `handle_chat` returns an empty body
`firmware/src/WebAPI.cpp` — `handle_chat()`:
```cpp
static String response = "";
...
robot->chat(text);
server.send(200, "text/html", String(HEAD)+String("<body>")+response+String("</body>"));
```
`response` is `static` and never assigned, so the browser gets an empty page. The TTS still runs, but the HTTP reply is meaningless. Either populate it with the LLM reply or return 202/204.

### R8. `backend` value is not range-checked
`firmware/src/WebAPI.cpp` `handle_config_set()`: `cfg.backend = doc["backend"].as<int>()` with no validation. Any non-1 value silently falls to the OpenClaw path. Accept 0/1 explicitly and 400 otherwise. Same for ports (must be 1–65535).

---

## Minor notes (nice to have)

- **OpenClawClient.h** — `openclaw_s`/`hermes_s` duplicate identical structs; consider a single shared struct. `default_model` is stored but **never used** in `OpenClawClient` (only `model` is used at chat-time). Dead field or unimplemented.
- **`load_role()`** hardcodes the model template `json_OpenClawChatString` with three `system` messages (empty role, empty system role, "User Info:"). The `systemRole_noMemory` / `defaultRole` values are the only real role content; the role/userInfo fill works, but the template is brittle if the number of system slots changes. Add a comment that index constants (`SYSTEM_PROMPT_INDEX_*`) must match the template.
- **`handle_speech`/`handle_face`/`handle_chat`** do not check `server.method()` (they run for GET+POST). Prefer explicit method binding or a 405.
- **`handleNotFound`** echoes request arguments (including possibly sensitive query strings) back to the client; on a LAN this is minor, but consider trimming.
- **`handle_speech`** — `speaker`/`voice` args are parsed but unused (commented-out TTS logic). Dead code.
- **`handle_apikey`** legacy page / the `#if 0` blocks (`handle_apikey_set`, `handle_setting`, `ROLE_HTML`, `handle_role_set` HTML) remain dead; consider removing to reduce flash usage and review surface.

### Test harness (test_agent_binding.py)

- **12 tests** actually = the `--unit-tests-only` set (4 unit test steps) + network tests; the count includes OpenClaw auth, models, agent-a, persistence; Hermes auth, models, agent-b, persistence; isolation; and two workspace-write tests. The workspace tests are **NOT** part of the unit-only run — a `--unit-tests-only` invocation still passes even though the integration isn't exercised. Make that explicit in the summary output.
- **False-positive risk in identity checks** (e.g. `test_openclaw_agent-a`, `test_hermes_agent-b`, `test_agent_isolation`): the check is a bare substring `"agent-a" in content.lower()`. An LLM responding "I am **not** Agent A" or a wrong-but-named agent would still pass. Consider requiring the substring to appear in a self-referential clause (e.g. `/i am |my name is |i'm /` + target), or do a secondary negation check.
- **Workspace tests couple to the local filesystem** (`AGENT_A_WORKSPACE_DIR` = `/Users/<your-host>/openclaw-workspaces/agent-a`, `AGENT_B_WORKSPACE_DIR = "/Users/<your-host>/.hermes/...`). These are hardcoded host paths — the tests fail/hang on any other machine or user, and the `120s` timeouts make them slow. Pass them as args, and make the verify step the primary assertion (the HTTP "200" check is almost a given).
- **Workspace write relies on the LLM actually writing the file** — non-deterministic. A model could say "sure" and never call the write tool; the test would only catch it if the disk file check happens and the file is missing. Good: the disk check is the real assertion. But cleanup is best-effort — if the test fails partway, the test file is left in the agent workspace.
- **`http_post_json`/`http_get_json`:** `json.loads(raw)` on an empty 200 body throws → caught by generic `except` → returned as a string error "Failed: ...", which several tests treat as a hard failure. Consider a body that isn't JSON (e.g. an HTML error page) → same. Either validate `Content-Type` or handle empty bodies gracefully.
- **`test_openclaw_models` and `test_hermes_models` return True even when the target agent is absent** (they `warn` and `return True`). They therefore do not enforce agent binding. If a strict model-list check is wanted, make Agent A/Agent B presence a hard requirement for the corresponding OpenClaw/Hermes test.
- **Session persistence tests** don't clear the session afterward, and rely on the model to repeat "testbot" — a model could echo "testbot" from the instruction rather than true memory. Consider verifying the second answer independently (e.g. ask a different question) and cleaning up the session key.
- **`validate_openclaw_session_key`** accepts any 4-part `agent:*:*:*` string without confirming the agent id is a known one. Fine for a unit test, but it will accept e.g. `agent:evil:chan:x`.
- No secrets in test files; keys are passed via CLI args. Good — but note the CLI args are visible in `ps` output. Accepting keys via env vars would be slightly safer.

---

## Suggested fix order
1. **C1** — add session/channel/auth headers (v1 blocker; the task's stated main fix).
2. **C2** — fix the config YAML round-trip (full-struct serialize / merge before write).
3. **C3** — auth on endpoints + never return bot_token from `/config`.
4. **C4** — enlarge the two `DynamicJsonDocument(1024)` buffers.
5. **R1** — cap `chatHistory` length.
6. **R2** — mutex around chat/speech.
7. Remaining R items and test-harness tightening as bandwidth allows.

---

*Review complete. The firmware is near-flashable once C1–C4 are addressed; the config round-trip (C2) is the one that would otherwise silently break the device on the first config change.*
