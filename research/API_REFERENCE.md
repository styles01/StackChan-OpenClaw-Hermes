# OpenClaw + Hermes HTTP API Reference for Stack-chan
**Updated: 2026-08-18 13:48 MDT**
**Purpose: Concrete HTTP call patterns for firmware + subagents. No secrets here.**

---

## OpenClaw Gateway

### Endpoint
```
POST http://127.0.0.1:18789/v1/chat/completions
```

### Auth
```
Authorization: Bearer <GATEWAY_PASSWORD>
```
- Gateway auth mode: `password` (configured in `openclaw.json` → `gateway.auth.password`)
- This is FULL OPERATOR ACCESS — file reads/writes, exec, tools, everything
- MUST stay on loopback/tailnet/private ingress only

### Agent Binding
```
"model": "openclaw/<agent_id>"
```
- This is the **only** agent selector for the HTTP endpoint
- Bindings config is NOT consulted for HTTP requests (only channel plugins)
- Example: `"model": "openclaw/rosie"` → routes to Rosie agent

### Session Control (2 headers)
```
x-openclaw-session-key: agent:<agent_id>:stackchan:<device_id>
x-openclaw-message-channel: stackchan
```
- `x-openclaw-session-key` — persistent channel identity, survives 4am reset
  - MUST be agent-prefixed: `agent:rosie:stackchan:device-001`
  - Bare keys (like `stackchan:device-001`) silently route to default agent
- `x-openclaw-message-channel` — delivery routing label
  - Does NOT affect agent selection or session key construction
  - Normalized to literal string `"stackchan"` (not a built-in channel)

### Full Example (cURL)
```bash
curl -X POST http://127.0.0.1:18789/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <GATEWAY_PASSWORD>" \
  -H "x-openclaw-session-key: agent:rosie:stackchan:device-001" \
  -H "x-openclaw-message-channel: stackchan" \
  -d '{
    "model": "openclaw/rosie",
    "messages": [
      {"role": "user", "content": "Tell me your name and role."}
    ]
  }'
```

### Response
Standard OpenAI Chat Completions JSON:
```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "I'm Rosie, your household operations director..."
      }
    }
  ]
}
```

### Session Behavior
- `deliver: false` on HTTP endpoint — no outbound push, request/response only
- Session key persists across 4am reset (only sessionId rotates)
- Full workspace access (read + write) confirmed
- Multi-turn: reuse same `x-openclaw-session-key` across requests

### Verified Test (2026-08-18)
- Sent: `model: openclaw/rosie` + session key + channel header
- Response: "I'm Rosie, your household operations director..."
- ✅ Agent binding works, session key works, auth works
- ✅ Auth rejection: 401 on missing/invalid bearer token

---

## Hermes Gateway

Hermes offers **two options** for reaching a specific named profile (like Venus) via HTTP. Both require a Bearer token (`API_SERVER_KEY`).

### Option A — Multiplex Mode (shared port)

All profiles share the default gateway's API server on port 8642. Each profile gets its own URL prefix.

**Config required in `~/.hermes/config.yaml`:**
```yaml
gateway:
  multiplex_profiles: true
  multiplex_profile_allowlist:
    - venus
    - default
```
Requires restarting the default Hermes gateway.

**Endpoint:**
```
POST http://<host>:8642/p/<profile>/v1/chat/completions
```

**Auth:**
```
Authorization: Bearer <DEFAULT_API_SERVER_KEY>
```
- Uses the default gateway's `API_SERVER_KEY` — no per-profile key needed
- All profiles in the allowlist share this one key

**Tradeoffs:**
- ✅ One config change, one key, one port for all profiles
- ✅ Less infrastructure churn
- ⚠️ All profiles share the same auth token
- ⚠️ Requires default gateway restart to enable

### Option B — Dedicated Port (RECOMMENDED)

Each profile runs its own API server on a separate port with its own key. Better sandboxing — profiles are fully isolated.

**Config required in profile's launchd plist:**
```xml
<key>API_SERVER_ENABLED</key><string>true</string>
<key>API_SERVER_KEY</key><string><your-per-profile-secret></string>
<key>API_SERVER_HOST</key><string>0.0.0.0</string>
<key>API_SERVER_PORT</key><string>8643</string>
<key>API_SERVER_CORS_ORIGINS</key><string>*</string>
```
Also add `API_SERVER_KEY=<your-per-profile-secret>` to the profile's `.env` file. Requires unloading and reloading the profile's launchd plist.

**Endpoint:**
```
POST http://<host>:8643/v1/chat/completions
```
No `/p/<profile>/` prefix — the port IS the profile.

**Auth:**
```
Authorization: Bearer <PROFILE_API_SERVER_KEY>
```
- Per-profile secret, stored in profile `.env` + launchd plist
- Key must be ≥16 characters
- Named profiles fail closed (401) without their own key — they do NOT inherit the default profile's key

**Tradeoffs:**
- ✅ Better sandboxing — each profile has its own key and port
- ✅ No shared auth token between profiles
- ✅ Profile can be restarted independently
- ⚠️ One port per profile (8643, 8644, etc.)
- ⚠️ Requires plist edit + reload per profile

### Session Control (2 headers, both options)
```
X-Hermes-Session-Id: <ephemeral-uuid>     # per-request, rotates
X-Hermes-Session-Key: <stable-channel-id>  # persists, scopes long-term memory
```
- `X-Hermes-Session-Id` — ephemeral, one-off request session
- `X-Hermes-Session-Key` — stable per-channel identity
  - Requires `API_SERVER_KEY` auth — rejected if no key configured
  - Scopes long-term memory and session continuity

### Full Example — Option A (Multiplex)
```bash
curl -X POST http://127.0.0.1:8642/p/venus/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <DEFAULT_API_SERVER_KEY>" \
  -H "X-Hermes-Session-Key: venus-stackchan-device-001" \
  -d '{
    "model": "hermes-agent",
    "messages": [
      {"role": "user", "content": "Tell me your name and role."}
    ]
  }'
```

### Full Example — Option B (Dedicated Port)
```bash
curl -X POST http://127.0.0.1:8643/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <VENUS_API_SERVER_KEY>" \
  -H "X-Hermes-Session-Key: venus-stackchan-device-001" \
  -d '{
    "model": "hermes-agent",
    "messages": [
      {"role": "user", "content": "Tell me your name and role."}
    ]
  }'
```

### Other Endpoints
```
GET  /v1/models                         # List available models
GET  /v1/capabilities                   # Machine-readable API capabilities
POST /v1/responses                      # OpenAI Responses API (stateful)
GET  /api/sessions                       # List sessions
POST /api/sessions                       # Create session
GET  /api/sessions/{id}                  # Read session
GET  /api/sessions/{id}/messages         # Read session history
POST /api/sessions/{id}/fork             # Fork a session
POST /api/sessions/{id}/chat[/stream]    # Chat with persisted session
POST /v1/runs                            # Start async run (202)
GET  /v1/runs/{id}/events                # SSE event stream
```

### Verified Test (2026-08-18)
- Venus running on dedicated port 8643 (Option B)
- Sent: `model: hermes-agent` + `Authorization: Bearer <venus_key>` + `X-Hermes-Session-Key`
- Response: "Venus" (correct profile identity)
- ✅ Agent binding works, session key works, auth works
- ✅ Auth rejection: 401 on missing/invalid bearer token
- ❌ Multiplex (Option A) NOT enabled — when tested with `/p/venus/` prefix, silently fell through to default profile (Maïs). This is expected behavior when `multiplex_profiles: false`.

---

## Side-by-Side Comparison

| Feature | OpenClaw | Hermes (Option A) | Hermes (Option B) |
|---------|----------|-------------------|-------------------|
| **Endpoint** | `/v1/chat/completions` | `/p/<profile>/v1/chat/completions` | `/v1/chat/completions` |
| **Default port** | 18789 | 8642 | 8643+ (per profile) |
| **Auth header** | `Authorization: Bearer <password>` | `Authorization: Bearer <default_key>` | `Authorization: Bearer <profile_key>` |
| **Auth config** | `gateway.auth.password` in openclaw.json | `API_SERVER_KEY` in default gateway | `API_SERVER_KEY` in profile .env + plist |
| **Agent selector** | `model: openclaw/<agent_id>` | URL prefix `/p/<profile>/` | Port number (each port = one profile) |
| **Session key header** | `x-openclaw-session-key` | `X-Hermes-Session-Key` | `X-Hermes-Session-Key` |
| **Session ID header** | (internal) | `X-Hermes-Session-Id` | `X-Hermes-Session-Id` |
| **Channel header** | `x-openclaw-message-channel` | (N/A — platform adapter) | (N/A — platform adapter) |
| **Session survives reset** | ✅ Yes | ✅ Yes | ✅ Yes |
| **Outbound push** | ❌ No (`deliver: false`) | ❌ No (request/response) | ❌ No (request/response) |
| **Workspace access** | ✅ Full (read + write) | ✅ Full (agent workspace) | ✅ Full (agent workspace) |
| **Sandboxing** | Single password | Shared key (all profiles) | Per-profile key (isolated) |

---

## For Stack-chan Firmware

### v1: OpenClaw (Rosie)
```
POST http://<mini_ip>:18789/v1/chat/completions
Authorization: Bearer <GATEWAY_PASSWORD>
x-openclaw-session-key: agent:rosie:stackchan:<device_id>
x-openclaw-message-channel: stackchan
Content-Type: application/json

{"model": "openclaw/rosie", "messages": [...]}
```

### v2: Hermes (Venus, Option B — dedicated port)
```
POST http://<mini_ip>:8643/v1/chat/completions
Authorization: Bearer <VENUS_API_SERVER_KEY>
X-Hermes-Session-Key: venus-stackchan-<device_id>
Content-Type: application/json

{"model": "hermes-agent", "messages": [...]}
```

### Auth Token Storage on ESP32
- Store bearer token in firmware config (hardcoded or NVS)
- ESP32 has no secure enclave — the token is in flash
- Mitigation: ESP32 only talks to the mini over LAN, mini is the trust boundary
- If ESP32 is stolen, flash read reveals the token — but it only works on your LAN
- For v2: consider per-device tokens or challenge-response

### Streaming (SSE)
Both OpenClaw and Hermes support `"stream": true` in the request body for Server-Sent Events. Each `data: <json>` chunk contains a `delta.content` field with text fragments. The ESP32 can feed these to TTS as they arrive for lower-latency voice output. Stream terminates with `data: [DONE]`.

### Reference Document
- Hermes handoff doc: `~/.hermes/workspace/esp32-venus-api-handoff/HANDOFF.md`
- Contains full ESP32 Arduino pseudo-code for both non-streaming and streaming modes