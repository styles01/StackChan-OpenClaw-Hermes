# Deep Read: Hermes Channels, Integrations & API Access

**Date:** 2026-08-18
**Author:** Dex (subagent deep-read)
**Purpose:** Extract patterns from the Hermes agent codebase that OpenClaw's Stack-chan integration can learn from, especially around channels, session lifecycle, and channel persistence.

---

## 1. Executive Summary

Hermes and OpenClaw are architecturally near-twins in how they handle channel integrations — James's observation is accurate. Both use a **gateway** that multiplexes many messaging platforms through a single agent core, both key sessions on a **deterministic session_key derived from a SessionSource**, both persist sessions to a **SQLite database** so they survive restarts, and both have a **daily/idle reset policy** (Hermes defaults to 4am local, matching OpenClaw's 02:00 UTC dream/wipe). The single most important discovery: **OpenClaw connects to Hermes over ACP (Agent Client Protocol) with `backend: "acpx"` in persistent mode** — so Hermes is reachable as an OpenClaw agent, and its channel/session model is the reference implementation for how a device like Stack-chan should bind to an agent.

---

## 2. How Hermes Handles Channels

### 2.1 The Gateway + Platform Adapter Model

Hermes uses a **gateway** (`gateway/run.py`, ~1.4MB) that runs a set of **platform adapters** (`gateway/platforms/`). Each adapter is a subclass of `BasePlatformAdapter` (`gateway/platforms/base.py`, 325KB). The gateway multiplexes all platforms through a single agent core.

**Built-in platforms** (in `gateway/platforms/`):
- `telegram.py`, `discord.py`, `signal.py`, `whatsapp.py` + `whatsapp_cloud.py`, `weixin.py`, `yuanbao.py`, `qqbot/`, `bluebubbles.py`, `webhook.py`, `api_server.py`, `msgraph_webhook.py`

**Plugin platforms** (in `plugins/platforms/`): `irc`, `teams`, `google_chat`, `line`, and more.

### 2.2 The Adapter Contract (the key pattern)

`ADDING_A_PLATFORM.md` documents the exact contract. Every adapter must implement:

| Method | Purpose |
|--------|---------|
| `__init__(self, config)` | Parse config, call `super().__init__(config, Platform.X)` |
| `connect() -> bool` | Connect, start listeners |
| `disconnect()` | Stop listeners, cancel tasks |
| `send(chat_id, text, ...) -> SendResult` | Send text |
| `send_typing(chat_id)` | Typing indicator |
| `send_image(chat_id, image_url, caption)` | Send image |
| `get_chat_info(chat_id) -> dict` | Return `{name, type, chat_id}` |

**Optional interactive UX methods** (degrade gracefully to text):
- `send_clarify(...)` — multi-choice buttons
- `send_exec_approval(...)` — Approve/Deny buttons for dangerous commands
- `send_slash_confirm(...)` — Once/Always/Cancel buttons
- `send_model_picker(...)`, `send_choice_picker(...)`

**Key patterns every adapter follows:**
- `self.build_source(...)` → constructs a `SessionSource`
- `self.handle_message(event)` → dispatches inbound to the gateway
- Filter self-messages (prevent reply loops)
- Redact sensitive identifiers in logs
- Reconnection with exponential backoff + jitter
- `MAX_MESSAGE_LENGTH` for platform limits

**Button-callback ID convention** shared across adapters: `cl:<id>:<idx>`, `appr:<id>:<choice>`, `sc:<choice>:<id>` — so gateway-side resolvers work without modification.

### 2.3 The Relay Adapter (generic multi-platform front)

`gateway/relay/adapter.py` is a **single generic adapter** that fronts many platforms via a **connector** (Node/TypeScript, `NousResearch/gateway-gateway`). The gateway dials **out** to the connector over a WebSocket; the connector owns all platform-specific socket/identity logic. At handshake, the connector sends a `CapabilityDescriptor` telling the gateway which platform it fronts and which capabilities to advertise.

**This is the single most relevant pattern for Stack-chan.** A device like Stack-chan could be a "connector" that fronts a platform (or a custom channel) to the gateway, without the gateway needing any device-specific code. The gateway sees an ordinary `MessageEvent` in and calls `adapter.send` out.

**Relay ↔ Connector contract** (`docs/relay-connector-contract.md`):
- Gateway dials OUT to connector's `/relay` WebSocket
- Frames: `hello`, `descriptor`, `inbound`, `outbound`, `outbound_result`, `interrupt`, `interrupt_inbound`
- Inbound rides the same socket the gateway dialed (no gateway-side inbound HTTP port needed)
- Multi-instance routing via Redis pub/sub relay bus keyed by tenant
- `CapabilityDescriptor` fields: `contract_version`, `platform`, `label`, `max_message_length`, `supports_draft_streaming`, `supports_edit`, `supports_threads`, `markdown_dialect`, `len_unit`, `emoji`, `platform_hint`, `pii_safe`, `supports_context`, `supported_ops`

---

## 3. OpenAI-Compatible HTTP Endpoint

**Yes.** `gateway/platforms/api_server.py` (347KB) is a full OpenAI-compatible API server, exposed as a platform adapter. Default port **8642**.

### 3.1 Endpoints

- `POST /v1/chat/completions` — OpenAI Chat Completions format (stateless; opt-in session continuity via `X-Hermes-Session-Id` header; opt-in long-term memory scoping via `X-Hermes-Session-Key` header)
- `POST /v1/responses` — OpenAI Responses API format (stateful via `previous_response_id`; `X-Hermes-Session-Key` supported)
- `GET /v1/responses/{response_id}` / `DELETE` — retrieve/delete stored response
- `GET /v1/models` — lists `hermes-agent` and configured `model_routes` aliases
- `GET /v1/capabilities` — machine-readable API capabilities
- `GET/POST /api/sessions` — list/create sessions
- `GET/PATCH/DELETE /api/sessions/{session_id}` — read/update/delete
- `GET /api/sessions/{session_id}/messages` — read history
- `POST /api/sessions/{session_id}/fork` — branch via SessionDB lineage
- `POST /api/sessions/{session_id}/chat[/stream]` — chat with persisted session
- `POST /v1/runs` — start a run (202), `GET /v1/runs/{run_id}`, `/events` (SSE), `/approval`, `/steer`, `/stop`
- `GET /health`, `GET /health/detailed`

Any OpenAI-compatible frontend (Open WebUI, LobeChat, LibreChat, AnythingLLM, NextChat, ChatBox) can connect by pointing at `http://localhost:8642/v1` with `API_SERVER_KEY`.

### 3.2 Session Handling (the critical pattern)

**Two distinct session concepts:**

1. **`session_id`** — a fresh UUID per one-off request (ephemeral, rotates).
2. **`gateway_session_key`** — a **stable per-channel identifier** supplied by the client via `X-Hermes-Session-Key`. This is the "channel identity" — it scopes long-term memory and session continuity, matching the native gateway's `session_key` semantics.

**Session ID derivation for stateless chat completions** (`_derive_chat_session_id`):
```python
seed = f"{system_prompt or ''}\n{first_user_message}"
digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16]
return f"api-{digest}"
```
OpenAI-compatible frontends send full history every request; the system prompt + first user message are constant across turns, so hashing them produces a **deterministic session ID** that reuses the same Hermes session (and Docker sandbox) across turns.

**Key insight for Stack-chan:** A device can present as an OpenAI-compatible client with a **stable `X-Hermes-Session-Key`** (e.g. `stackchan:living-room`) to get persistent, channel-scoped memory — without implementing the full gateway adapter.

---

## 4. Session Lifecycle & Channel Persistence

### 4.1 `SessionSource` — the identity dataclass

`gateway/session.py` defines `SessionSource`, the canonical description of where a message came from:

```python
@dataclass
class SessionSource:
    platform: Platform
    chat_id: str
    chat_name: Optional[str] = None
    chat_type: str = "dm"  # "dm", "group", "channel", "thread"
    user_id: Optional[str] = None
    user_name: Optional[str] = None
    thread_id: Optional[str] = None
    chat_topic: Optional[str] = None
    user_id_alt: Optional[str] = None  # platform-specific stable alt ID
    chat_id_alt: Optional[str] = None
    is_bot: bool = False
    scope_id: Optional[str] = None  # Discord guild / Slack workspace / Matrix server
    parent_chat_id: Optional[str] = None
    message_id: Optional[str] = None
    role_authorized: bool = False
    profile: Optional[str] = None  # multiplexing profile
    prospective_thread_id: Optional[str] = None  # Discord auto-thread continuity
    delivered_via_upstream_relay: bool = False  # wire-invisible trust signal
```

### 4.2 `build_session_key()` — the single source of truth

`gateway/session.py:1090` — `build_session_key(source, group_sessions_per_user, thread_sessions_per_user, profile)` produces a **deterministic, colon-joined session key** from the source. This is the core of channel identity.

**DM rules:**
- `[ns]:[platform]:dm:[chat_id][:thread_id]`
- Without chat_id, falls back to `user_id_alt`/`user_id` (prevents cross-user history bleed)
- Without thread_id or chat_id, DMs share a single session

**Group/channel rules:**
- `[ns]:[platform]:[chat_type]:[scope_id?]:[chat_id][:thread_id][:user_id?]`
- Threads default to **shared** sessions (all participants see the same conversation) unless `thread_sessions_per_user` is enabled
- `scope_id` (Slack workspace / Discord guild) isolates servers/workspaces

**Discord auto-thread continuity:** a channel-initiating message carries `prospective_thread_id` (the message id, which becomes the thread id). The session is keyed on that so the initiating channel message and follow-ups in the thread share ONE session.

### 4.3 SQLite persistence (`~/.hermes/state.db`)

Sessions persist to a SQLite DB (WAL mode) with tables:
- `sessions` — metadata, token counts, billing, `session_key`, `chat_id`, `chat_type`, `thread_id`, `display_name`, `origin_json`, `expiry_finalized`, `cwd`, `git_branch`, `parent_session_id`, `profile_name`, `rewind_count`, `archived`, `pinned`
- `messages` — full history, `tool_calls` as JSON, `api_content` byte-fidelity sidecar
- `messages_fts` / `_trigram` / `_cjk` — FTS5 search
- `gateway_routing`, `compression_locks`, `async_delegations`, `state_meta`

**Session lineage** via `parent_session_id` chains (compression-triggered splits). **Source tagging** (`cli`, `telegram`, `discord`) for platform filtering.

### 4.4 The 4am daily reset (Hermes's "dream/wipe")

`gateway/config.py` — `SessionResetPolicy`:
```python
mode: str = "none"  # "daily", "idle", "both", or "none"
at_hour: int = 4  # Hour for daily reset (0-23, local time)
idle_minutes: int = 1440  # 24h inactivity
notify: bool = True
notify_exclude_platforms: tuple = ("api_server", "webhook")
bg_process_max_age_hours: int = 24
```

**This is the direct analog of OpenClaw's 02:00 UTC dream/wipe.** Hermes defaults `at_hour=4` (4am local). The reset logic in `session.py::_should_reset()`:
- Returns `"idle"` if `now > entry.updated_at + idle_minutes`
- Returns `"daily"` if `entry.updated_at < today_reset` (computed at `at_hour`)
- **Sessions with active background processes are never reset** (unless the process is >24h old — then it's ignored, not killed)
- On daily reset, the agent injects: `"[System note: The user's session was automatically reset by the daily schedule. This is a fresh conversation with no prior context.]"`

**How channels survive resets:** The reset only clears the *conversation context* for a given `session_key`. The **channel identity** (`SessionSource` → `session_key`) is deterministic and re-derived from every inbound message. So after a reset, the next message on the same channel re-creates the session with the same key — the channel binding is permanent, only the conversation memory is wiped. This is exactly how OpenClaw's channels survive the 02:00 dream.

### 4.5 Dreaming

Hermes has a `memory/dreaming/` directory with `deep/`, `light/`, `rem/` subdirectories (dated `.md` files), and a `DREAMS.md` diary. The dreaming trigger isn't in the Python gateway code — it's driven by the OpenClaw integration (`__openclaw_memory_core_short_term_promotion_dream__` cron). So Hermes's dreaming is **orchestrated by OpenClaw**, not self-contained.

---

## 5. Device / Hardware Integration Patterns

Hermes has **no native robot/IoT/hardware platform adapter**. The closest patterns:

1. **`webhook.py`** — generic webhook adapter that receives POSTs from external services (GitHub, GitLab, JIRA, Stripe), validates HMAC signatures, transforms payloads into agent prompts, and routes responses back. **This is the most device-friendly pattern** — a physical device can POST to a webhook route and get an agent response. Config: `platforms.webhook.extra.routes`, each with `events`, `secret` (HMAC), `prompt` (template), `skills`, `deliver`, `deliver_only`.

2. **`api_server.py`** — the OpenAI-compatible endpoint (section 3) is the natural HTTP surface for a device.

3. **`relay/`** — the generic connector pattern (section 2.3) lets a device act as a connector fronting a custom channel.

4. **`display_config.py`** — display-related config, but not a hardware driver.

**Conclusion:** For Stack-chan, the two viable integration paths are (a) the **OpenAI-compatible API server** with a stable `X-Hermes-Session-Key`, or (b) the **webhook adapter** with HMAC auth. Both require zero core Hermes changes.

---

## 6. The ACP Adapter — How Hermes Bridges to OpenClaw

`acp_adapter/` implements the **Agent Client Protocol (ACP)** — a JSON-RPC stdio server that wraps Hermes's synchronous `AIAgent`. This is how OpenClaw talks to Hermes.

### 6.1 OpenClaw ↔ Hermes connection

From `~/.openclaw/openclaw.json`:
```json
"runtime": {
  "type": "acp",
  "acp": {
    "agent": "hermes",
    "backend": "acpx",
    "mode": "persistent",
    "cwd": "/Users/clawdio"
  }
}
```
And globally: `"acp": { "backend": "acpx", "defaultAgent": "openclaw", "dispatch": { "enabled": true }, "maxConcurrentSessions": 8 }`.

So **OpenClaw treats Hermes as an ACP agent** (`acpx` backend, persistent mode). The ACP adapter is the bridge.

### 6.2 ACP components

- `entry.py` — CLI entry; loads `~/.hermes/.env`, configures stderr logging (stdout reserved for ACP JSON-RPC)
- `server.py` (106KB) — `HermesACPAgent` implementing the ACP agent protocol: initialize/authenticate, new/load/resume/fork/list/cancel session methods, prompt execution, session model switching, wiring sync AIAgent callbacks into ACP async notifications
- `session.py` (27KB) — `SessionManager` mapping ACP sessions to Hermes `AIAgent` instances; **persisted to the shared SessionDB (`~/.hermes/state.db`)** so they survive restarts and appear in `session_search`
- `events.py` — converts AIAgent callbacks into ACP `session_update` events
- `permissions.py` — `make_approval_callback` for approvals
- `tools.py` (56KB) — tool rendering
- `auth.py` — auth methods, provider detection
- `provenance.py` — session provenance metadata

### 6.3 ACP session lifecycle

`SessionManager` tracks live ACP sessions in-memory **and** persists them. Each session stores `session_id`, `agent`, `cwd`, `model`, `history`, `cancel_event`. Supports create/get/remove/fork/list/cleanup/cwd-updates. When the editor reconnects after idle/restart, `load_session`/`resume_session` find the persisted session in the DB and restore full history.

**Key pattern:** ACP sessions are keyed by `session_id` (UUID), but the underlying Hermes session is persisted by `session_key` in the SessionDB. The ACP layer is a thin transport; the channel identity lives in the gateway's `SessionSource`/`session_key` model.

---

## 7. Patterns Stack-chan Can Learn From

### 7.1 Channel identity = deterministic session_key from a SessionSource
The single most important pattern. A device should derive a **stable, deterministic session key** from its identity (e.g. `stackchan:living-room`), not from ephemeral request IDs. This gives:
- Persistent memory scoped to the device
- Channel binding that survives resets
- Isolation between multiple devices

### 7.2 Two-layer session model (ephemeral session_id vs stable session_key)
Hermes cleanly separates the **ephemeral request session** (`session_id`, UUID, rotates) from the **stable channel session** (`session_key`, deterministic, persistent). Stack-chan should adopt the same: a fresh request ID per interaction, but a stable device key for memory/continuity.

### 7.3 Persist to SQLite, not JSONL
Hermes moved from per-session JSONL to a **single SQLite DB (WAL mode)** with FTS5 search, session lineage (`parent_session_id`), and source tagging. This is the robust persistence model for a device that must survive reboots.

### 7.4 Daily reset wipes context, not channel binding
The 4am reset (Hermes) / 02:00 dream (OpenClaw) clears conversation context but **never** the channel identity. The device re-derives its session key from every inbound message, so it "wakes up" on the same channel after a reset. Stack-chan should treat its device identity as permanent and only let the conversation context be reset.

### 7.5 The relay/connector pattern for device integration
The generic `RelayAdapter` + `CapabilityDescriptor` pattern means a device can be a **connector** that fronts a custom channel to the gateway without gateway changes. The gateway dials out; the connector owns device-specific socket/identity logic. This is the cleanest long-term integration for a physical device.

### 7.6 OpenAI-compatible endpoint as the low-friction path
The `api_server.py` endpoint means a device can integrate as an OpenAI-compatible client with a stable `X-Hermes-Session-Key` header — no custom adapter needed. This is the fastest path to a working Stack-chan ↔ agent link.

### 7.7 Capability negotiation
The `CapabilityDescriptor` (max_message_length, supports_threads, markdown_dialect, len_unit, supported_ops) is a clean way for a device to advertise what it can do (e.g. "I can show text but not images", "I have a 20-char display"). Stack-chan should negotiate its display/audio capabilities rather than assume a full chat surface.

### 7.8 Interactive UX degrades gracefully
Hermes's `send_clarify`/`send_exec_approval`/`send_choice_picker` all degrade to plain text when a platform doesn't support buttons. A device with a small display should implement the text fallback and optionally the button surface.

### 7.9 Trust signals are wire-invisible
`delivered_via_upstream_relay` is deliberately excluded from `to_dict`/`from_dict` so a peer can never forge it. Device-originated messages should carry unforgeable trust markers.

### 7.10 Active-process reset guard
Sessions with active background processes are never reset. A device mid-task (e.g. Stack-chan playing audio) should pin its session open during the reset window.

---

## 8. File Map (for follow-up)

| Concern | File |
|---------|------|
| Channel identity | `gateway/session.py` (`SessionSource`, `build_session_key`) |
| Platform adapter contract | `gateway/platforms/ADDING_A_PLATFORM.md`, `gateway/platforms/base.py` |
| OpenAI-compatible API | `gateway/platforms/api_server.py` |
| Generic relay/connector | `gateway/relay/adapter.py`, `gateway/relay/ws_transport.py`, `docs/relay-connector-contract.md` |
| Webhook (device-friendly) | `gateway/platforms/webhook.py` |
| Daily reset policy | `gateway/config.py` (`SessionResetPolicy`), `gateway/session.py` (`_should_reset`) |
| SQLite persistence | `website/docs/developer-guide/session-storage.md`, `hermes_state.py` |
| ACP bridge to OpenClaw | `acp_adapter/` (`server.py`, `session.py`, `entry.py`), `website/docs/developer-guide/acp-internals.md` |
| Channel directory | `gateway/channel_directory.py`, `~/.hermes/channel_directory.json` |
| Dreaming | `memory/dreaming/{deep,light,rem}/`, `DREAMS.md` |
| OpenClaw config | `~/.openclaw/openclaw.json` (ACP `acpx` backend) |

---

## 9. Bottom Line

Hermes and OpenClaw share the same core architecture: **gateway multiplexes platforms → deterministic session_key from SessionSource → SQLite persistence → daily reset that wipes context but not channel binding**. For Stack-chan, the highest-leverage patterns are (1) a **stable device session key** for persistent, channel-scoped memory, (2) the **OpenAI-compatible API endpoint** as the low-friction integration path, and (3) the **relay/connector capability-negotiation model** for a proper long-term device integration. The ACP bridge (`acpx` backend) is the proof that OpenClaw already treats Hermes as a first-class agent — a device can ride the same pattern.
