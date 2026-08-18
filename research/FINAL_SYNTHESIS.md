# Stack-chan Channel Integration — Final Synthesis
**Saved: 2026-08-18 12:28 MDT**

## Executive Summary

Stack-chan should use the OpenAI HTTP endpoint with proper headers for v1. A channel plugin is deferred to v2. **Session control is safe** — the session key survives the 4am reset. Only the conversation context (sessionId) rotates.

All 5 deep-read subagents complete. 10 research docs on disk. Full findings below.

---

## The v1/v2 Architecture

### v1: HTTP + Headers (SHIP NOW)

**Firmware sends:**
```
POST /v1/chat/completions
Authorization: Bearer <gateway_token>
Content-Type: application/json
x-openclaw-message-channel: stackchan
x-openclaw-session-key: agent:<agent_id>:stackchan:<device_id>

{
  "model": "openclaw/<agent_id>",
  "messages": [...]
}
```

**Why this works:**
- `model: openclaw/<agent_id>` → agent selection (your agent, not the default)
- `x-openclaw-session-key: agent:<agent_id>:stackchan:<device_id>` → persistent session, agent-bound, channel-scoped
- `x-openclaw-message-channel: stackchan` → delivery routing context (where replies go)
- Session key survives 4am reset (only sessionId rotates, sessionKey persists)
- Full workspace access confirmed (read + write)

**What survives 4am reset:**
- ✅ Session key (`agent:<agent_id>:stackchan:<device_id>`) — persists
- ✅ Channel identity (`stackchan`) — persists (in the session key)
- ✅ Agent binding (encoded in session key) — persists
- ❌ Conversation context (sessionId rotates — this is the POINT of the reset)

**What we get:**
- Persistent channel identity across session resets
- Agent binding (not default agent)
- Full tool access (workspace reads/writes)
- Multi-turn conversation within a session
- Clean session reset at 4am (dreaming/compaction)

**What we DON'T get (v2 provides):**
- Outbound push (Gateway can't send to robot without a request — `deliver: false` on HTTP endpoint)
- Appearance in `channels list` / status dashboard
- Binding via Gateway config (`bindings` array only works for real channel plugins)
- Multi-device account management
- First-class channel registry entry

### v2: Channel Plugin (WHEN NEEDED)

Build a minimal `stackchan` channel plugin when:
- Multiple devices need their own accounts/configs
- Outbound push needed (Gateway sends to robot without a request)
- Stack-chan should appear in `channels list` / status
- Its own webhook/inbound route is needed
- Multi-user identity (different people talking to the same robot)

**Plugin requirements:**
- `createChatChannelPlugin({ base: createChannelPluginBase({ id: "stackchan", config, setup }) })`
- `defineChannelChannelPluginEntry` in entry point
- Manifest with `channels: ["stackchan"]`
- `messaging.resolveSessionConversation` for conversation grammar
- Binding: `{ "agentId": "<agent_id>", "match": { "channel": "stackchan", "accountId": "stackchan-001" } }`

**Key code insight from deep-read-channel-sdk.md:**
- The plugin does NOT build session keys — core does
- Plugin only provides conversation grammar via `messaging.resolveSessionConversation`
- Core's `resolveSessionKey` produces `agent:<agentId>:<channel>:<conversation>`
- Bindings are consulted ONLY in channel plugin route resolvers, NOT in the HTTP endpoint path

---

## Top 10 Findings (ranked by importance)

### 1. 4am reset preserves sessionKey, rotates sessionId
**Source:** `deep-read-session-reset.md`

The "4am reset" is NOT a cron job. It's a **lazy freshness check** evaluated on the next inbound message. On each inbound message, `evaluateSessionFreshness()` checks if `sessionStartedAt` is before today's 4am boundary. If stale, the session rotates.

**What rotates:** sessionId (new UUID), transcript (archived), token counters (reset to 0), compaction count (reset).
**What survives:** sessionKey, channel binding (route, deliveryContext, lastChannel, lastTo, lastAccountId, origin), label, displayName, model override, thinking/verbose levels, exec settings.

**Live proof:** Rosie's Telegram session key has survived **21 sessionId rotations** with the Telegram binding fully intact.

**HTTP sessions are treated identically.** A `user`-derived key or explicit `x-openclaw-session-key` persists across the daily reset the same way.

### 2. Bare session keys route to default agent
**Source:** `deep-read-http-internals.md`

`buildAgentCommandInput` passes `sessionKey` into the run but **omits `agentId`**. The agent is derived from the session key at run time. Bare keys (like `stackchan:device-002`) are classified as `legacy_or_alias` shape and get re-scoped to the default agent via `scopeLegacySessionKeyToAgent`.

**Fix:** Use agent-prefixed keys: `agent:<agent_id>:stackchan:<device_id>`. Or use the `user` field which auto-scopes to `agent:<agent_id>:openai-user:<user>`.

### 3. `user` field auto-scopes to `agent:<agent_id>:openai-user:<user>`
**Source:** `deep-read-http-internals.md`

The `user` field in the request body derives a stable main session key via `buildAgentMainSessionKey`. It's persisted in the session store and survives 4am resets (it's a main key, not a peer key). Reusing the same `user` resumes the same session.

**Caveat:** The channel segment is `openai-user`, not `stackchan`. To get `stackchan` in the session key, use explicit `x-openclaw-session-key: agent:<agent_id>:stackchan:<device_id>`.

### 4. `x-openclaw-message-channel` is delivery routing, not session identity
**Source:** `deep-read-http-internals.md`

The header is read by `resolveGatewayRequestContext`, normalized via `normalizeMessageChannel`, and flows into `runContext.messageChannel` → `turnSourceChannel`. It affects:
- Delivery routing (where replies go)
- `modelByChannel` resolution (only if channel is "deliverable" — `stackchan` is NOT, so this is skipped)
- Channel-aware prompts/policies
- Diagnostics

It does NOT affect:
- Session key construction
- Agent binding/routing
- Session identity

### 5. Bindings route by channel+accountId, never by session-key prefix
**Source:** `deep-read-http-internals.md`, `deep-read-channel-sdk.md`

**Critical finding:** The HTTP endpoint **never consults bindings**. `resolveConfiguredBindingRoute` is only called from channel-plugin route resolvers (e.g. `resolveTelegramConversationRoute`). Zero binding references in the HTTP files.

This means: Adding `{ "agentId": "rosie", "match": { "channel": "stackchan" } }` to the Gateway config will NOT route HTTP endpoint requests to Rosie. The `model` field is the ONLY agent selector for the HTTP endpoint.

**For v1:** Agent selection is via `model: openclaw/<agent_id>` only. The binding config is irrelevant for HTTP endpoint requests.

**For v2:** A channel plugin's route resolver WOULD consult bindings, making the binding config work.

### 6. `nodes.allowCommands` already has robot commands
**Source:** `deep-read-device-patterns.md`

The Gateway config already includes robot commands in `nodes.allowCommands`:
- `rosie.status`, `rosie.servo.look`, `rosie.servo.home`, `rosie.vision.capture`
- `face.set`, `face.gesture`, `talk.start`, `talk.stop`
- `canvas.*`, `device.info`, `device.status`, `wifi.status`

These are for the Node pattern (Clawdio-Mini, iPhone) — physical devices that bind via WebSocket with device pairing. Too heavy for ESP32 but shows the command surface is already anticipated.

### 7. robot-bridge is the most mature reference
**Source:** `deep-read-device-patterns.md`

A Python FastAPI bridge speaking XiaoZhi/WebSocket protocol to an ESP32, backed by Hermes. 21 features, 15 bug fixes, 11 E2E tests. Handles sessions via per-person `stackchan-{name}` session keys. This is the most production-mature Stack-chan integration in existence.

**Relevant patterns:** Opus audio params, face-tracking, LED state machine, per-person session management.

### 8. WS protocol too heavy for ESP32
**Source:** `deep-read-device-patterns.md`, `deep-read-channel-sdk.md`

The Gateway WebSocket protocol requires:
- Signed device handshake (Ed25519)
- Nonce challenge
- Scopes/caps model
- Device-token pairing flow
- Reconnect with backoff
- Tick keepalives
- Large JSON-RPC surface

This is a full operator/node control-plane protocol designed for native apps (iOS/Android), not constrained microcontrollers. Use HTTP instead.

### 9. Channel plugin SDK is well-documented
**Source:** `deep-read-channel-sdk.md`

Minimum viable channel plugin:
- `createChatChannelPlugin({ base: createChannelPluginBase({ id, config, setup }) })`
- `defineChannelChannelPluginEntry` in entry point
- Manifest with `channels: ["stackchan"]`
- Optional: security, pairing, threading, outbound/message adapters

The plugin does NOT build session keys — core does. Plugin only provides `messaging.resolveSessionConversation` grammar. Core's `resolveSessionKey` produces `agent:<agentId>:<channel>:<conversation>`.

### 10. Hermes relay adapter is the closest pattern for Stack-chan
**Source:** `deep-read-hermes-channels.md`

Hermes has a **RelayAdapter** — a single generic adapter that fronts many platforms via a connector over WebSocket. The gateway dials OUT to the connector. The connector owns all platform-specific logic.

**This is the pattern for v2:** Stack-chan could be a "connector" that fronts a custom channel to the gateway, without the gateway needing device-specific code.

**Hermes also has a full OpenAI-compatible API server** (`api_server.py`, port 8642) with:
- `/v1/chat/completions` (stateless; session continuity via `X-Hermes-Session-Id` header)
- `X-Hermes-Session-Key` for stable channel identity
- `/api/sessions` CRUD
- Session fork via SessionDB lineage

The two-layer session model (ephemeral session_id + stable gateway_session_key) is exactly what OpenClaw's HTTP endpoint does with sessionId + sessionKey.

---

## Research Files Index

### Phase 1: Architecture survey
- `research/channel-plugin-architecture.md` — how channel plugins work
- `research/hermes-and-agent-binding.md` — how Hermes/agent binding works
- `research/http-endpoint-session-behavior.md` — HTTP endpoint session routing
- `research/gateway-protocol-ws.md` — WebSocket protocol analysis
- `research/multi-agent-session-routing.md` — multi-agent routing config

### Phase 2: Deep code reads
- `research/deep-read-channel-sdk.md` — channel plugin SDK internals (20KB)
- `research/deep-read-http-internals.md` — HTTP endpoint code trace (19KB)
- `research/deep-read-hermes-channels.md` — Hermes channel patterns (20KB)
- `research/deep-read-session-reset.md` — 4am reset & channel persistence (18KB)
- `research/deep-read-device-patterns.md` — existing robot/device patterns (21KB)

### Planning
- `research/CURRENT_PLAN.md` — living plan & findings document
- `research/FINAL_SYNTHESIS.md` — this document

---

## Implementation Checklist for v1

- [ ] Update firmware `OpenClawClient.cpp` to send headers:
  - `x-openclaw-session-key: agent:<agent_id>:stackchan:<device_id>`
  - `x-openclaw-message-channel: stackchan`
- [ ] Test on hardware with real Gateway
- [ ] Verify session persists across requests
- [ ] Verify workspace access (read + write)
- [ ] (Optional) Add binding config for v2 preparation
- [ ] Document the header convention in firmware config YAML

## Implementation Checklist for v2 (future)

- [ ] Build minimal `stackchan` channel plugin
- [ ] Register `channels: ["stackchan"]` in plugin manifest
- [ ] Implement `messaging.resolveSessionConversation` for device-scoped sessions
- [ ] Add binding: `{ "agentId": "<agent_id>", "match": { "channel": "stackchan" } }`
- [ ] Implement inbound webhook (if needed)
- [ ] Implement outbound transport (for push messages)
- [ ] Test multi-device support
