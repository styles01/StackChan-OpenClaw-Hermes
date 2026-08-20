# Existing OpenClaw Stack-chan Work — Analysis for Porting into Hermes-StackChan

**Author:** Gordon (subagent review)
**Date:** 2026-08-18
**Purpose:** Document everything we already built in the OpenClaw Stack-chan project so it can be ported into the `Hermes-StackChan` fork (`repos/working-repos/Hermes-StackChan/`) as a **dual-backend firmware** (OpenClaw + Hermes).

---

## 0. Executive Summary

We already built and validated the **entire OpenClaw side** of a Stack-chan × AI-agent integration, plus the Hermes binding logic and a profile-binding concept. The firmware that implements it lives in `repos/plaipin-openclaw-stackchan/` (PlatformIO Arduino — **confirmed broken on CoreS3**). The Hermes side of the integration is already solved in the `Hermes-StackChan` fork (ESP-IDF, WebSocket + Opus audio bridge, MCP robot tools).

**The port work is NOT "port OpenClaw code into Hermes-StackChan" line-by-line.** The two firmware codebases are architecturally incompatible:
- plaipin = Arduino/PlatformIO, synchronous HTTP POST `/v1/chat/completions`, text-only
- Hermes-StackChan = ESP-IDF, WebSocket streaming with Opus audio, voice-first STT→LLM→TTS

The real work is: **(1)** add an **OpenClaw HTTP backend** to Hermes-StackChan's ai-server bridge (the natural seam — the ai-server already mediates between firmware and the AI backend), and **(2)** add a `backend` selector + profile binding to the config surface so each robot picks OpenClaw or Hermes. The reusable assets from our plaipin work are the **header conventions, config schema, profile-binding concept, and the validated API reference + test harness logic** — not the C++ itself.

---

## 1. Existing Firmware Work (plaipin-openclaw-stackchan)

Source root: `<repo-root>/stackchan-node/repos/plaipin-openclaw-stackchan/firmware/src/`

### 1.1 File inventory (OpenClaw-related)

| File | Role |
|---|---|
| `llm/OpenClaw/OpenClawClient.cpp` | HTTP client; sends chat requests to OpenClaw Gateway OR Hermes backend (dual-backend) |
| `llm/OpenClaw/OpenClawClient.h` | Class declaration; holds `openclaw_host/port/model/agent_id`, `backend`, `hermesConfig`, `deviceId` |
| `StackchanExConfig.h` | Config structs: `openclaw_s`, `hermes_s`, `ex_config_s` with `backend` selector |
| `StackchanExConfig.cpp` | YAML config loading from SPIFFS (`loadExtendConfig` / `setExtendSettings`) |
| `WebAPI.cpp` | HTTP config endpoints: `GET/POST /config`, `POST /apikey`, serialization to/from YAML |
| `main.cpp` | Robot bootstrap; wires `backend` into `OpenClawClient` |

> **Note:** The task brief referenced `OpenClawConfig.h` — **that file does not exist.** Config loading is done inline in `StackchanExConfig.cpp` (`loadExtendConfig`) and serialization in `WebAPI.cpp`. There is no separate `OpenClawConfig.h`/`.cpp`.

### 1.2 `OpenClawClient::http_post_json()` — how it works

Defined in `OpenClawClient.cpp`. Signature: `String OpenClawClient::http_post_json(const char* url, const char* json_string)`.

Behavior:
- Creates an `HTTPClient`, `http.setTimeout(65000)` (65s — matches our E2E harness constant).
- `http.begin(url)` — **plain HTTP, no TLS** (`// TODO: Add TLS support for production use`).
- Adds `Content-Type: application/json`.
- **Branches on `backend` for auth + session headers** (this is the C1 fix from CODE_REVIEW_V2 — now implemented):
  - `backend == 1` (Hermes):
    - `Authorization: Bearer <hermesConfig.bot_token>`
    - `X-Hermes-Session-Key: stackchan-<deviceId>`
  - `backend == 0` (OpenClaw, default):
    - `Authorization: Bearer <param.api_key>`
    - `x-openclaw-session-key: agent:<openclaw_agent_id>:stackchan:<deviceId>`
    - `x-openclaw-message-channel: stackchan`
- `http.POST((uint8_t*)json_string, strlen(json_string))`.
- On `HTTP_CODE_OK || HTTP_CODE_MOVED_PERMANENTLY`, returns `http.getString()` (full body). Otherwise returns `""` (empty → "Connection error" path).

### 1.3 Backend selection & routing (in `chat()`)

```cpp
String host  = (backend == 1) ? hermesConfig.host  : openclaw_host;
int    port  = (backend == 1) ? hermesConfig.port  : openclaw_port;
String model = (backend == 1) ? hermesConfig.model : openclaw_model;
String url = String("http://") + host + ":" + String(port) + "/v1/chat/completions";
```
- Single URL shape: `http://<host>:<port>/v1/chat/completions` for **both** backends.
- `backend` is selected once at config-load, stored on the client, and branched in `http_post_json` (headers) and `chat` (host/port/model).

### 1.4 Chat template & request body

`json_OpenClawChatString` template:
```cpp
{"model": "openclaw/agent-a", "stream": false,
 "messages": [
   {"role":"system","content":""},   // user-role slot
   {"role":"system","content":""},   // system-role slot
   {"role":"system","content":"User Info: "}  // user-info slot
 ]}
```
- `stream: false` (non-streaming; SSE streaming is documented in API_REFERENCE as a future option).
- `load_role()` overrides `model` from config (`openclaw_model`), fills the 3 system slots, then `chat()` appends the chat-history user/assistant turns from `ChatHistory` (capped at `CHAT_HISTORY_MAX_ENTRIES = 40` = 20 turns — R1 fix).
- `enableMemory(false)` — OpenClaw handles memory server-side.

### 1.5 Response parsing (in `chat()`)

Defensive, in order:
1. `ret == ""` → avatar Sad + speak **"Connection error"**.
2. `deserializeJson` into `SpiRamJsonDocument(8192)` fails → **"Parse error"**.
3. `doc.containsKey("error")` → read `doc["error"]["message"]` → **"API error"**.
4. `!doc["choices"][0]["message"].containsKey("content")` → **"Response error"**.
5. `content == nullptr` → **"Empty response"**.
6. Otherwise → `stripEmoji(content)` + `\n`→space + strip `**`/`__` + cap at 200 chars (word-boundary) → `robot->speech(response)`.

`stripEmoji()` (top of cpp): keeps ASCII + Latin-extended + CJK + JP punctuation; strips 4-byte emoji (U+F0000+), and 3-byte symbol ranges: U+2700–27BF (dingbats), U+2600–26FF, U+2300–23FF, U+2460–24FF, U+25A0–25FF, U+FE00–FE0F.

### 1.6 Device ID (`loadOrGenerateDeviceId`)

- Persists a `device_id` in NVS namespace `"stackchan"`.
- If absent, generates `sc-<6-hex-mac-bytes>` from the WiFi MAC and commits to NVS.
- Used to build stable session keys: `agent:<agent_id>:stackchan:<deviceId>`.

### 1.7 Config structs (`StackchanExConfig.h`)

```cpp
#define LLM_TYPE_OPENCLAW 4   // new LLM type enum value

typedef struct OpenClawConf {
    String host;
    int port;
    String model;
    String agent_id;         // NEW: agent binding (e.g. "agent-a")
    String bot_token;        // NEW: Telegram bot token / gateway auth
    String default_model;    // NEW: default model string
} openclaw_s;

typedef struct HermesConf {   // same shape, swappable
    String host; int port; String model;
    String agent_id; String bot_token; String default_model;
} hermes_s;

typedef struct ExConfig {
    llm_s llm; tts_s tts; stt_s stt; wakeword_s wakeword;
    moduleLLM_s moduleLLM;
    openclaw_s openclaw;
    hermes_s hermes;
    int backend;   // NEW: 0=openclaw, 1=hermes
} ex_config_s;
```
- `llm.type == LLM_TYPE_OPENCLAW (4)` selects `OpenClawClient`.
- `default_model` is stored but **never used at chat-time** (only `model` is used) — flagged in CODE_REVIEW_V2 as a dead/duplicate field.

### 1.8 Config loading (`StackchanExConfig.cpp`)

`loadExtendConfig(fs, yaml_filename, yaml_size)`:
- Uses `DynamicJsonDocument doc(yaml_size < 4096 ? 4096 : yaml_size)` (YAML parsed via ArduinoJson — 4096 buffer, C4 fix).
- Reads `openclaw.host/port/model/agent_id/bot_token/default_model`, `hermes.*`, and `backend`.
- Falls back to legacy TXT if YAML missing.

### 1.9 Web config endpoints (`WebAPI.cpp`)

- **`GET /config`** → `handle_config_get()`: serializes full `ex_config_s` via `serializeExConfig()` into `DynamicJsonDocument(4096)`. **bot_tokens masked** via `maskToken()` → `***<last4>` (C3 fix).
- **`POST /config`** → `handle_config_set()`: parses JSON, range-checks `backend` (0/1 else 400 — R8 fix), applies openclaw/hermes/backend fields, then **writes the FULL config to YAML** on SPIFFS `/SC_ExConfig.yaml` (llm/tts/stt/wakeword/moduleLLM + backend + openclaw/hermes — the C2 round-trip fix).
- **`POST /apikey`** → `handle_apikey`-style (C3): sets `openclaw.bot_token` / `hermes.bot_token` via JSON `{openclaw:{key}}` / `{hermes:{key}}`; Hermes token also persisted to NVS `"hermes_bot_token"`.

---

## 2. Test Harness

Root: `<repo-root>/stackchan-node/test-harness/`

### 2.1 `test_agent_binding.py` — 12 test suites (the primary suite)

Runs live OpenClaw (Agent A) + Hermes (Agent B) agent-binding validation. Requires live gateways OR `--unit-tests-only`.

**Header builders (the exact conventions to port):**
```python
def build_openclaw_headers(api_key, agent_id, channel, device_id):
    return {
        "Authorization": f"Bearer {api_key}",
        "x-openclaw-session-key": f"agent:{agent_id}:{channel}:{device_id}",
        "x-openclaw-message-channel": channel,      # = "stackchan"
    }

def build_hermes_headers(api_key, session_key):
    return {
        "Authorization": f"Bearer {api_key}",
        "X-Hermes-Session-Key": session_key,        # e.g. "stackchan-<device>"
    }

def build_hermes_url(base_url, profile):
    if profile: return f"{base_url}/p/{profile}/v1/chat/completions"  # Option A multiplex
    return f"{base_url}/v1/chat/completions"                          # Option B dedicated port
```

**The 12 suites:**
1. **Unit tests** (no network): OpenClaw header construction, Hermes header construction, `validate_openclaw_session_key` (must be agent-prefixed, ≥4 parts), Hermes URL construction (`/p/<profile>/` vs bare).
2. **OpenClaw auth rejection** — missing/invalid Bearer → expect 401.
3. **OpenClaw models** — `GET /v1/models` lists agents (warns, not fails, if agent-a absent).
4. **OpenClaw Agent A identity** — POST `openclaw/agent-a`, strict check: response must contain `"agent-a"`.
5. **OpenClaw session persistence** — same session key, message 2 "What is my name?" must contain `"testbot"`.
6. **Hermes auth rejection** — 401 on missing/invalid token (skips on connection-refused).
7. **Hermes models** — `GET /v1/models`.
8. **Hermes Agent B identity** — `model: hermes-agent`, strict check: response contains `"agent-b"`; also detects WRONG profile (Maïs/mermaid → fail).
9. **Hermes session persistence** — same `X-Hermes-Session-Key`, must contain `"testbot"`.
10. **Agent isolation** — Agent A says "agent-a", Agent B says "agent-b" (cross-system).
11. **OpenClaw workspace write** — ask Agent A to create/update a file in `AGENT_A_WORKSPACE_DIR`, verify exact content on disk.
12. **Hermes workspace write** — same for Agent B in `AGENT_B_WORKSPACE_DIR`.

**Result (from README):** 12/12 passed with strict identity validation. Workspace writes confirmed on disk.

### 2.2 `e2e_test_harness.py` — firmware pipeline simulation

Simulates the full firmware chat path against the real Gateway:
- `parse_response_firmware_style()` — replicates `OpenClawClient::chat` parsing: deserialize, check `error`, extract `choices[0].message.content`, stripEmoji, `\n`→space, strip `**`/`__`, 200-char cap.
- 8 tests: agent identity, workspace access, multi-turn conversation, response parsing (emoji/markdown/cap), error handling (bad model), latency (< 65s), full pipeline (system prompts → Gateway → TTS-ready), model routing (`openclaw/agent-a` vs `openclaw/main`).
- Hardcodes `GATEWAY_AUTH = "Bearer <your-gateway-password>"` and `GATEWAY_URL` to `127.0.0.1:18789`.

### 2.3 `workspace_write_test.py` — the "real bar"

Proves the full binding `Stack-chan firmware → Gateway (openclaw/agent-a) → Agent A agent → workspace write`:
1. Verify Agent A workspace exists.
2. Clean slate (remove old handshake file).
3. Send firmware-style write request through Gateway → `STACKCHAN_HANDSHAKE.txt` in Agent A's workspace.
4. Verify file exists + content markers (handshake text, "agent-a", "openclaw/agent-a", timestamp).
5. Read back through Gateway (proves read+write).

**5/5 checks passed** per README.

### 2.4 `web-config.html` — browser config editor

- Standalone single-file HTML (no server). Talks directly to ESP32 `/config` on port 80.
- **Find Stack-chan**: auto-scans `/24` subnet by GET `/config`, lists devices by `backend` + `agent_id`.
- **Backend selector**: dropdown (OpenClaw=0 / Hermes=1), toggles which section shows.
- **OpenClaw section**: host, port (default 18789), model (default `openclaw/agent-a`), agent_id.
- **Hermes section**: host, port (default 8643), model (default `hermes-agent`), agent_id.
- **Actions**: Save Config (POST /config), Reload, Test Chat (GET /chat?text=), Show Raw JSON.
- **API Keys section**: `saveApiKey('openclaw'|'hermes')` → `POST /apikey_set` with `{openclaw:{key}}` / `{hermes:{key}}`. Tokens NOT sent in the config POST body (per C3) — stored separately, shown masked.
- Validation: host required, port 1–65535, agent_id required for active backend.

---

## 3. Research Files

### 3.1 `research/FINAL_SYNTHESIS.md`

The authoritative architecture decision:
- **v1 = HTTP + Headers** (SHIP NOW). Firmware sends `POST /v1/chat/completions` with `model: openclaw/<agent_id>`, `x-openclaw-session-key: agent:<agent_id>:stackchan:<device_id>`, `x-openclaw-message-channel: stackchan`.
- **v2 = channel plugin** (when needed): minimal `stackchan` channel plugin for outbound push, `channels list` visibility, bindings. **Deferred.**
- Key: session key survives 4am reset (only sessionId rotates). Channel identity persists.
- **10 ranked findings**, most important:
  1. 4am reset preserves `sessionKey`, rotates `sessionId`.
  2. Bare session keys route to **default agent** — must use `agent:`-prefixed keys.
  3. `user` field auto-scopes to `agent:<agent_id>:openai-user:<user>`.
  4. `x-openclaw-message-channel` = delivery routing, NOT session identity.
  5. **Bindings route by channel+accountId, never by session-key prefix** — and the HTTP endpoint NEVER consults bindings. `model` field is the ONLY agent selector for HTTP.
  6–10: robot commands exist in config; robot-bridge is most mature reference; WS protocol too heavy for ESP32; channel plugin SDK well-documented; Hermes RelayAdapter is the v2 pattern.

### 3.2 `research/API_REFERENCE.md`

Concrete HTTP call patterns (no secrets). The **authoritative reference for the port**:
- **OpenClaw:** `POST http://<host>:18789/v1/chat/completions`, `Authorization: Bearer <gateway_password>`, `model: openclaw/<agent_id>`, headers `x-openclaw-session-key` + `x-openclaw-message-channel`. `deliver: false` (no outbound push). Full workspace access.
- **Hermes Option A (multiplex):** `http://<host>:8642/p/<profile>/v1/chat/completions`, shared `API_SERVER_KEY`.
- **Hermes Option B (dedicated port, RECOMMENDED):** `http://<host>:8643/v1/chat/completions` (port = profile), per-profile `API_SERVER_KEY`. Named profiles fail closed (401) without own key.
- **Hermes session headers:** `X-Hermes-Session-Id` (ephemeral) + `X-Hermes-Session-Key` (stable).
- Side-by-side comparison table (endpoint/auth/agent-selector/session headers/outbound/workspace/sandboxing).
- **Streaming (SSE):** both support `"stream": true`, each `data:` chunk has `delta.content`, terminates with `data: [DONE]`.
- **Auth storage on ESP32:** token in flash; mitigation = LAN-only trust boundary.

### 3.3 `research/CURRENT_PLAN.md`

James's direction: **"channel key not session key."** Sessions reset at 4am; the **channel** is the stable identity. Proved: `model: openclaw/agent-a` works, `user:` auto-scopes, bare session keys route to wrong agent, agent-prefixed keys work. Not yet validated: channel surface recognition, session survival across 4am (it does survive, per FINAL_SYNTHESIS), channel key stability.

### 3.4 `CODE_REVIEW_V2.md`

Dex's review of the plaipin firmware + harness. **Critical (C1–C4)** and **Recommended (R1–R8)** — most are now fixed in the current code:
- C1 (headers) — **FIXED** (http_post_json now branches on backend).
- C2 (config YAML round-trip data loss) — **FIXED** (full-struct serialize).
- C3 (unauthenticated endpoints + bot_token exposure) — **FIXED** (maskToken + /apikey endpoint).
- C4 (1024 buffers too small) — **FIXED** (4096).
- R1 (chatHistory unbounded) — **FIXED** (cap 40 entries).
- R2 (thread safety) — NOT fixed (no mutex).
- R3 (no TLS) — open TODO.
- R4 (stripEmoji bounds) — open.
- R5 (8192 parse buffer) — open.
- R7 (`handle_chat` empty body) — open.
- Test-harness tightening notes (false-positive substring checks, hardcoded workspace paths, non-deterministic writes).

---

## 4. The Hermes-StackChan Fork (port target)

Root: `<repo-root>/stackchan-node/repos/working-repos/Hermes-StackChan/`

### 4.1 Architecture (from code review)

**Firmware (ESP-IDF)** — `firmware/main/`:
- Native ESP-IDF (mooncake + xiaozhi-esp32 v2.2.4 base). NOT Arduino.
- `apps/app_ai_agent/app_ai_agent.cpp` — the "HERMES" app. On open, reads `websocket_url` from Settings, checks Wi-Fi + SD config, then `GetHAL().requestHermesStart()` → `hal_bridge::start_hermes_app()`.
- SD config: `firmware/sdcard/config.sample.json`:
  ```json
  { "wifi_networks": [...], "websocket_url": "ws://192.168.1.100:8765/ws",
    "websocket_version": 3, "timezone": "JST-9", ... }
  ```
- `hal/hal_mcp.cpp` — MCP server on firmware exposing robot tools (camera, screen, reminders, head angles, LED, speaker, power off, test tone) to the ai-server via the control port.
- Connection: WebSocket to `ws://<server>:8765/ws`, protocol version 3, Opus audio streaming.

**ai-server (TypeScript bridge)** — `ai-server/src/`:
- `index.ts` — starts control server (8766) + WebSocket server (8765), optional Hermes warmup.
- `server.ts` — `WebSocketServer` on `/ws`, per-connection `Session`.
- `session.ts` — the core: Opus in → VAD → STT → LLM turn → TTS → Opus out. Sends JSON control (`hello`, `listen`, `tts` states, `stt`, `llm`, `mcp`, `alert`).
- `hermes.ts` — `HermesClient` (RPC over Hermes stdio gateway OR Dashboard `/api/ws`). Methods: `submitPrompt`, `streamPrompt`, `interrupt`. JSON-RPC: `session.create`, `prompt.submit`, `message.delta`, `message.complete`.
- `hermes_audio.ts` — `transcribeWithHermes` (STT), `synthesizeWithHermes` (TTS); local OpenAI-compatible STT/TTS endpoints supported via env.
- `stackchan_mcp_server.ts` — MCP server exposing **13 tools** to Hermes: `stackchan_capture_screen`, `stackchan_create_reminder`, `stackchan_display_image`, `stackchan_get_head_angles`, `stackchan_get_reminders`, `stackchan_get_status`, `stackchan_play_test_tone`, `stackchan_power_off`, `stackchan_set_head_angles`, `stackchan_set_led_color`, `stackchan_set_speaker_volume`, `stackchan_stop_reminder`, `stackchan_take_photo`. Plus `stackchan_ask_hermes_subagent`.
- `device_control.ts` — control HTTP server (127.0.0.1:8766) for MCP.
- Config via `ai-server/.env` (PORT=8765, STACKCHAN_* knobs, HERMES_* connection, local TTS/VAD).

### 4.2 Key seam for the port

The **ai-server `Session` class is the natural integration point.** Currently it does:
```
Opus in → decode → transcribeWithHermes() [STT] → HermesClient.submitPrompt/streamPrompt [LLM] → synthesizeWithHermes() [TTS] → Opus out
```
To add OpenClaw as a backend, we add an **`OpenClawClient` (HTTP)** alongside `HermesClient`, and branch on a `backend` setting (0=OpenClaw, 1=Hermes) at the LLM-turn step. The STT/TTS pipeline (voice loop) stays the same — OpenClaw replaces **only the LLM turn** (and optionally becomes a text-only path).

---

## 5. Port Work — Detailed Plan

### 5.1 What actually needs to be ported (vs. what's already there)

**Reusable as-is (concepts/logic, not code):**
- OpenClaw HTTP header convention: `Authorization: Bearer`, `x-openclaw-session-key: agent:<agent_id>:stackchan:<device_id>`, `x-openclaw-message-channel: stackchan`, `model: openclaw/<agent_id>`.
- Hermes HTTP header convention: `Authorization: Bearer`, `X-Hermes-Session-Key`.
- Config schema (host/port/model/agent_id/bot_token/default_model + backend selector).
- Profile-binding concept (robot ↔ backend + agent).
- API_REFERENCE (authoritative endpoints).
- Test-harness header builders + strict identity validation logic (rewrite in TS or keep as Python against the new ai-server).

**Must be written fresh in Hermes-StackChan (can't copy C++):**
- `OpenClawClient` (TypeScript) for ai-server — HTTP POST `/v1/chat/completions`.
- Backend selector plumbing through firmware config + ai-server env.
- WebSocket protocol extension if the firmware needs to tell ai-server which backend.

### 5.2 Mapping: plaipin config struct → Hermes-StackChan config

| plaipin `ex_config_s` field | Hermes-StackChan target |
|---|---|
| `openclaw.host` | `OPENCLAW_HOST` env in `ai-server/.env` |
| `openclaw.port` | `OPENCLAW_PORT` env (default 18789) |
| `openclaw.model` | `OPENCLAW_MODEL` env (default `openclaw/agent-a`) |
| `openclaw.agent_id` | `OPENCLAW_AGENT_ID` env (e.g. `agent-a`) |
| `openclaw.bot_token` | `OPENCLAW_API_KEY` env (gateway password) |
| `openclaw.default_model` | (unused in plaipin; drop or alias to model) |
| `hermes.*` | Already handled by existing `HERMES_*` env + `HermesClient` |
| `backend` (0/1) | `STACKCHAN_BACKEND` env (default `openclaw` or `hermes`) |

The firmware SD `config.json` gains an optional `"backend": "openclaw"|"hermes"` field (and optionally an `openclaw_*` block), which `app_ai_agent.cpp` passes through to the ai-server on connect (via the `hello` message or a new JSON field), so backend selection is per-robot and reconfigurable without reflashing.

### 5.3 Changes needed in Hermes-StackChan **firmware**

1. **`firmware/sdcard/config.sample.json`** — add:
   ```json
   "backend": "openclaw",
   "openclaw": { "host": "192.168.1.100", "port": 18789,
                 "model": "openclaw/agent-a", "agent_id": "agent-a" }
   ```
   (token stays server-side in ai-server `.env`, not on the SD card — better security than plaipin's flash-stored token).
2. **`hal/hal_mcp.cpp` / `get_websocket_url()`** — read optional `backend` + `openclaw.*` from Settings alongside `websocket_url`; expose via the bridge config.
3. **`hal_bridge` handshake** — when sending `hello` (protocol v3) to the ai-server, include the selected `backend` so the server routes the LLM turn correctly.
4. **`apps/app_ai_agent/app_ai_agent.cpp`** — surface `backend` in connectivity error messages (e.g. "OPENCLAW endpoint error" vs "HERMES endpoint error") so a misconfigured OpenClaw backend gives a clear bubble.

### 5.4 Changes needed in Hermes-StackChan **ai-server**

1. **New file `ai-server/src/openclaw.ts`** — `OpenClawClient` (mirror of the firmware's `http_post_json` + `chat` logic, in TypeScript):
   - `chat(messages, sessionKey)` → `POST http://<host>:<port>/v1/chat/completions`.
   - Headers: `Authorization: Bearer <OPENCLAW_API_KEY>`, `x-openclaw-session-key: agent:<agent_id>:stackchan:<device_id>`, `x-openclaw-message-channel: stackchan`, `Content-Type: application/json`.
   - Body: `{ model: "openclaw/<agent_id>", stream: false, messages }`.
   - Parse: check `error`, extract `choices[0].message.content`; strip emoji/markdown/newlines; cap length (reuse `limitStackChanSpeechText` / `stripMediaForSpeech`).
   - Stable device id: derive from a per-device key passed in `hello`, or a stable `X-Hermes-Session-Key`-style value, so session persists across turns.
2. **`ai-server/src/session.ts`** — make the LLM-turn step backend-aware:
   - In the constructor / `hello` handler, read the device's `backend` (from the WebSocket hello message OR `STACKCHAN_BACKEND` env).
   - Add a `HermesSessionClient`-shaped **`OpenClawClient` adapter** that implements `submitPrompt` (and optionally `streamPrompt` for SSE) so the existing `speakHermesReplyBuffered`/`speakHermesReplyStreaming` call sites need minimal change.
   - `process()` and `processFollowup()` route to the OpenClaw client when backend=OpenClaw; STT/TTS stay on Hermes/local providers.
   - `getBridgeStatus()` can report which backend is active.
3. **`ai-server/.env`** — add `STACKCHAN_BACKEND`, `OPENCLAW_HOST/PORT/MODEL/AGENT_ID/API_KEY`.
4. **(Optional) SSE streaming** — implement `streamPrompt` on the OpenClaw client using `"stream": true` + SSE parsing (`delta.content`, `data: [DONE]`) to feed the low-latency streaming path that Hermes already uses.
5. **(Optional) robot MCP tools via OpenClaw** — OpenClaw agents get workspace file I/O natively via the Gateway; no MCP needed for files, but the 13 `stackchan_*` tools would need an OpenClaw-side equivalent if OpenClaw should control robot hardware. Defer (documented as v2).

### 5.5 Profile binding implementation plan

**Concept (from README):** each physical robot has a profile that binds it to a backend + agent. Example fleet:
| Robot | Backend | Agent | Port | Session Key |
|---|---|---|---|---|
| A | OpenClaw | Agent A | 18789 | `agent:agent-a:stackchan:robot-a` |
| B | Hermes | Agent B | 8643 | `agent-b-stackchan:robot-b` |
| C | OpenClaw | custom | 18789 | `agent:custom:stackchan:robot-c` |

**Implementation in Hermes-StackChan:**
1. **Per-robot identity** — the firmware already has a stable device id (or we add one). The device id becomes the `${device_id}` in the session key: `agent:<agent_id>:stackchan:<device_id>` (OpenClaw) or `<agent>-stackchan-<device_id>` (Hermes).
2. **Per-robot backend + agent config** — stored in the SD `config.json` (`backend`, `openclaw.agent_id`, `hermes.agent_id`), sent to ai-server on the `hello` handshake. No reflash needed to rebind a robot — just edit SD config (or add the web-config editor later).
3. **ai-server maps robot → backend** — a small lookup keyed by device id (or read from the hello payload). The `Session` constructs the right client + session key for that robot.
4. **Web config editor** — port `web-config.html` to also set `backend` + `openclaw.agent_id`/`hermes.agent_id`, writing the SD `config.json` via an endpoint (the Hermes-StackChan firmware has no `/config` HTTP endpoint yet — this is new work; alternatively use BLE provisioning which the fork already supports for `websocket_url`).

---

## 6. Port Checklist

### Firmware (Hermes-StackChan ESP-IDF)
- [ ] `firmware/sdcard/config.sample.json`: add `backend` + `openclaw.*` block (and `hermes.agent_id`).
- [ ] `hal/hal_mcp.cpp` (`get_websocket_url` + config read): parse `backend` + `openclaw.*`/`hermes.*` from Settings.
- [ ] `hal_bridge`: include `backend` in the `hello`/bridge config sent to ai-server.
- [ ] `apps/app_ai_agent/app_ai_agent.cpp`: backend-aware connectivity error bubbles.
- [ ] (optional) BLE provisioning: add `backend` + `agent_id` fields alongside `websocket_url`.

### ai-server (TypeScript bridge)
- [ ] New `ai-server/src/openclaw.ts` — `OpenClawClient` (HTTP `/v1/chat/completions`, correct headers, response parse, emoji/markdown strip, length cap).
- [ ] New `ai-server/src/openclaw_client.ts` adapter — implement `HermesSessionClient` interface (`submitPrompt`, `streamPrompt?`, `interrupt`, `dispose`).
- [ ] `ai-server/src/session.ts` — backend selection in constructor + `process()`/`processFollowup()`; `getBridgeStatus()` backend reporting.
- [ ] `ai-server/.env` — `STACKCHAN_BACKEND`, `OPENCLAW_HOST/PORT/MODEL/AGENT_ID/API_KEY`.
- [ ] (optional) SSE streaming on OpenClaw client for low-latency path.
- [ ] (optional) OpenClaw-side equivalent of the 13 `stackchan_*` MCP tools (defer).

### Config / editor
- [ ] Port `web-config.html` → add `backend` selector + `openclaw.agent_id`/`hermes.agent_id`; target Hermes-StackChan SD config (via new endpoint or BLE).
- [ ] Keep bot_tokens out of the config POST (server-side `.env` or NVS), masked in any GET.

### Testing
- [ ] Port `test_agent_binding.py` header builders + strict identity/session-persistence/isolation logic as a TS test against the new ai-server (or keep Python, pointed at the ai-server's OpenClaw path).
- [ ] Verify: OpenClaw backend routes to correct agent, session persists across turns, auth rejection (401), workspace I/O.
- [ ] Verify: Hermes backend still works (regression).
- [ ] Verify: profile binding (robot A → Agent A/OpenClaw, robot B → Agent B/Hermes) on the same ai-server.

---

## 7. Key Gotchas & Decisions

1. **The HTTP endpoint never consults Gateway `bindings`** — agent selection is **only** via `model: openclaw/<agent_id>`. Don't rely on bindings config.
2. **Bare session keys silently route to the default agent** — ALWAYS use `agent:<agent_id>:stackchan:<device_id>`.
3. **`x-openclaw-message-channel: stackchan` is delivery routing, NOT session identity** — include it (it's harmless/needed for routing) but don't expect it to bind the agent.
4. **Session key survives 4am reset** (only sessionId rotates) — so `agent:<agent_id>:stackchan:<device_id>` gives stable channel identity + conversation continuity.
5. **plaipin firmware is Arduino/PlatformIO and broken on CoreS3** (PSRAM cache fix + wrong board + M5Unified mismatch). Do NOT port its C++ directly. The ai-server seam is the right port location.
6. **Security:** Hermes-StackChan's SD config is a better place for `backend`/`agent_id` than plaipin's flash-stored bot_tokens. Keep API keys in ai-server `.env` (or NVS), not the SD card.
7. **`default_model` in plaipin is dead** — don't carry it forward.

---

## 8. Appendix — Exact header/body conventions to reproduce

**OpenClaw (from API_REFERENCE + firmware + tests):**
```http
POST http://<host>:18789/v1/chat/completions
Authorization: Bearer <GATEWAY_PASSWORD>
Content-Type: application/json
x-openclaw-session-key: agent:<agent_id>:stackchan:<device_id>
x-openclaw-message-channel: stackchan

{ "model": "openclaw/<agent_id>", "stream": false,
  "messages": [ { "role": "user", "content": "..." } ] }
```

**Hermes (dedicated port, Option B — used by Agent B):**
```http
POST http://<host>:8643/v1/chat/completions
Authorization: Bearer <PROFILE_API_SERVER_KEY>
Content-Type: application/json
X-Hermes-Session-Key: <agent>-stackchan-<device_id>

{ "model": "hermes-agent", "messages": [...] }
```

**Hermes (multiplex, Option A — not enabled for Agent B):**
```http
POST http://<host>:8642/p/<profile>/v1/chat/completions
```

---

*End of analysis. Source of truth files: plaipin firmware under `repos/plaipin-openclaw-stackchan/firmware/src/`, tests under `test-harness/`, research under `research/`, and the port target under `repos/working-repos/Hermes-StackChan/`.*
