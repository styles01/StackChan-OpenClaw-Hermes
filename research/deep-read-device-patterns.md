# Deep Read: Existing Robot / Device / Hardware Integration Patterns

**Date:** 2026-08-18 | **Researcher:** Dex (subagent) | **Task:** Find the "reference projects" James mentioned that "already worked through the profile/channel side" of device/hardware integration with OpenClaw.

---

## Executive Summary

There is **no existing "robot channel"** in OpenClaw — no `stackchan`, `device`, or `robot` channel plugin exists on this machine. But there are **three mature, working patterns** that already solve the exact problems Stack-chan needs:

1. **The Node pattern** (Clawdio-Mini, iPhone) — a physical device binds to the Gateway as a `role: node` over WebSocket, with device pairing, capability/command allowlists, and per-device tokens. This is the **canonical device-to-agent pattern** and the closest thing to what Stack-chan should be.
2. **The OpenAI HTTP endpoint pattern** — the Gateway serves `/v1/chat/completions` where the `model` field selects the agent and a stable `user`/`x-openclaw-session-key` gives session continuity. This is the **pragmatic fit for an ESP32** (no WS handshake, no pairing, no crypto).
3. **The channel-plugin pattern** (Telegram/Discord/WhatsApp) — a first-class messaging channel with `bindings` routing to agents. This is what James means by "channel key, not session key" — the **channel is the stable identity** that survives 4am session resets.

The **robot-bridge** project (a separate-machine Python FastAPI bridge speaking XiaoZhi/WebSocket to an ESP32, backed by Hermes) is the **most production-mature Stack-chan agent integration in existence** — a goldmine of protocol patterns (Opus params, face-tracking, LED state machine, natural stranger registration) to reuse, not copy.

---

## 1. What reference projects exist for device/hardware integration?

### 1a. The Node pattern — Clawdio-Mini & iPhone (WORKING, ON THIS MACHINE)

The **most important reference project** is the node infrastructure already running here. From `~/.openclaw/nodes/paired.json` and `~/.openclaw/devices/paired.json`:

**Clawdio-Mini** (the macOS node, `nodeId 9c730436...`):
- `clientId: "openclaw-macos"`, `clientMode: "ui"`, `role: node` (also `operator`)
- `deviceFamily: "Mac"`, `modelIdentifier: "Mac16,10"`
- **caps**: `["canvas", "screen", "browser"]`
- **commands**: `canvas.present/hide/navigate/eval/snapshot/a2ui.*`, `screen.snapshot`, `system.notify/which/run/execApprovals.*`, `browser.proxy`
- **permissions**: `appleScript: true`, `notifications: true`, others false
- **bins**: `osascript, shortcuts, sqlite3, python3, git, node, nano-pdf, curl, oracle, jq`
- Has both an `operator` token and a `node` token (separate scopes)

**iPhone** (`nodeId 2f63bdd2...`):
- `clientId: "openclaw-ios"`, `clientMode: "ui"` (and a second entry `clientMode: "node"`)
- **caps**: `["canvas", "screen", "camera", "voiceWake", "device", "talk", "watch", "photos", "contacts", "calendar", "reminders", "motion"]`
- **commands**: `system.notify`, `talk.ptt.start/stop/cancel/once`, `camera.list`, `device.status/info`, `photos.latest`, `contacts.search`, `calendar.events`, `reminders.list`, `motion.activity/pedometer`
- **permissions**: `camera: true`, `microphone: true`, `screenRecording: true`, `speechRecognition: true`
- `remoteIp: "192.168.2.155"` (LAN)

**Key takeaway:** A node is a **peripheral**, not a gateway. It connects to the Gateway WebSocket with `role: "node"`, presents a device identity, gets paired (device pairing), and exposes a **command surface** (`canvas.*`, `camera.*`, `device.*`, `system.*`) via `node.invoke`. Nodes do **not** run the gateway service, and channel messages (Telegram etc.) land on the gateway, not on nodes.

**This is the pattern Stack-chan should follow for its *device* identity** — but with a critical caveat: the full WS node protocol is **too heavy for an ESP32** (signed Ed25519 handshake, nonce challenge, scopes/caps model, device-token pairing, reconnect/backoff, tick keepalives). See §6.

### 1b. The robot-bridge project (MOST PRODUCTION-MATURE STACK-CHAN INTEGRATION)

From Rosie's earlier research (in `analysis/` and the `robot-bridge` repo), this is a **separate-machine Python FastAPI bridge** that:
- Speaks the **XiaoZhi WebSocket protocol** to the ESP32 (stock firmware)
- Runs ASR (SenseVoiceSmall), TTS (Sherpa-ONNX Matcha → Opus), face tracking, LED state machine, multi-user face recognition
- Backed by **Hermes** (Nous Research agent) via MCP tools + webhook-driven conversation
- **21 features, 15 bug fixes, 11 E2E tests, deployed in production**

**Reusable patterns (not to copy, to learn from):**
- **XiaoZhi WS protocol** — `hello`/`listen`/`stt`/`llm`/`tts` message flow, raw Opus binary frames (16kHz mono, 60ms frames, 960 samples/frame, complexity=10)
- **Opus audio streaming** — 16kHz mono, soxr resampling, DTX silence detection, sentence-level TTS streaming (first chunk at 50ms)
- **Face tracking → servo** — exponential moving average (smoothing=0.25), dead zone (6%), rate limiting (max 12°/update, 0.5s), multi-person priority, LLM override
- **LED state machine** — idle/wake/listening/thinking/reply color mapping
- **Natural stranger registration** — LLM-driven conversation (no regex/state machine), per-person memory isolation via `stackchan-{name}` sessions
- **Self-critique (REFACTOR-PLAN.md)** — they found their bridge was "too thick" (making decisions that belonged to Hermes). Target: **Hermes owns StackChan; bridge is just MCP server + audio/protocol/vision execution layer.** This validates the "thin bridge" pattern.

**Why it matters for us:** This is the complete **Hermes-side blueprint** for a Stack-chan agent integration. Our native firmware approach eliminates the Python bridge (ESP32 talks directly to the gateway), but the tool definitions, conversation flow, and feature set are directly informed by what robot-bridge already proved works.

### 1c. The channel-plugin pattern (Telegram/Discord/WhatsApp)

The **reference projects for the "profile/channel side"** James mentioned. From `docs/channels/` and the bundled plugins:
- A channel plugin is a package with `openclaw.channel` metadata + `openclaw.plugin.json` declaring `channels: ["<id>"]`
- Entry point uses `defineChannelPluginEntry(...)`, built via `createChatChannelPlugin`/`createChannelPluginBase`
- Exposes `id`, `config`, `setup`, `security.dm`, `pairing`, `threading`, `outbound`/`message` adapters
- Registers an inbound webhook via `api.registerHttpRoute`, verifies platform signature, dispatches through the shared inbound pipeline

**This is what James means by "channel key, not session key."** A channel is a **stable identity** that sessions hang off of. When sessions reset at 4am (dreaming/compaction), the channel survives and a new session is created under it.

---

## 2. Is there a robot-bridge or similar pattern? What does it do?

**Yes — two distinct things called "bridge":**

### 2a. The legacy TCP Bridge protocol (REMOVED — historical only)
`docs/gateway/bridge-protocol.md` documents a **legacy TCP JSONL bridge** (port 18790) that was the old node transport. It has been **removed** from current builds. It used:
- TCP, one JSON object per line (JSONL), optional TLS
- `hello` → `pair-request` → `pair-ok` → `hello-ok` handshake
- `req`/`res` scoped RPC, `invoke`/`invoke-res` node commands, `event` signals, `ping`/`pong` keepalive
- Allowlist enforcement in `src/gateway/server-bridge.ts` (removed)

**The docs explicitly say:** "The TCP bridge has been removed. Current OpenClaw builds do not ship the bridge listener... Use the Gateway protocol for all node/operator clients." So the modern equivalent is the **WebSocket Gateway protocol** (see §6).

### 2b. The robot-bridge project (ACTIVE, separate machine)
The Python FastAPI bridge described in §1b. It's a **middleman** between the ESP32 (stock XiaoZhi firmware) and Hermes. It handles the XiaoZhi WS protocol, audio, vision, and MCP tool execution. **This is the "robot-bridge" James referenced in earlier research.**

**How it handles the channel/session question:** It uses **Hermes webhooks** (`hermes webhook subscribe stackchan --prompt "..." --deliver log`) and **per-person Hermes sessions** (`X-Hermes-Session-Id: stackchan-{name}`). Each person gets their own session namespace. This is the Hermes analog of OpenClaw's `agent:rosie:stackchan:<name>` session keys.

---

## 3. What does the `nodes` config do? Is it for physical devices?

**Yes — `nodes` is exactly the physical-device config.** From the actual `openclaw.json`:

```json5
"nodes": {
  "denyCommands": [
    "camera.snap", "camera.clip", "screen.record",
    "contacts.add", "calendar.add", "reminders.add", "sms.send"
  ],
  "allowCommands": [
    "device.info", "device.status", "wifi.status",
    "talk.start", "talk.stop", "face.set", "face.gesture",
    "canvas.present", "canvas.navigate", "canvas.hide", "canvas.snapshot",
    "canvas.a2ui.pushJSONL", "canvas.a2ui.push", "canvas.a2ui.reset",
    "rosie.status", "rosie.servo.look", "rosie.servo.home", "rosie.vision.capture"
  ]
}
```

**Critical finding:** The `allowCommands` list **already contains robot commands** — `rosie.status`, `rosie.servo.look`, `rosie.servo.home`, `rosie.vision.capture`, plus `face.set`, `face.gesture`, `talk.start`, `talk.stop`. This is the **closest thing to a device binding for Stack-chan that already exists.** Someone (Rosie's team) already anticipated the robot command surface.

**How nodes authenticate and connect:**
1. Node connects to Gateway WebSocket (same port 18789) with `role: "node"` and a device identity
2. Gateway creates a **device pairing request** (`role: node`)
3. Operator approves via `openclaw devices approve <requestId>` (or UI)
4. Gateway issues a **per-device token** (persisted for reconnect)
5. Node reconnects using the token, now paired
6. Live node commands come from what the node **declares on connect**, filtered by the gateway's global `gateway.nodes.allowCommands`/`denyCommands`

**Pairing lifecycle** (`docs/gateway/pairing.md`):
- Pending requests expire 5 min after last retry
- Approval **always** generates a fresh token (tokens rotate on re-pair)
- Approval scope follows declared commands: commandless = `operator.pairing`; non-exec = `operator.pairing` + `operator.write`; `system.run` = `operator.pairing` + `operator.admin`
- `node.pair.*` is a **separate, legacy** pairing store that does NOT gate the WS handshake — **device pairing** does

**The `nodes` config in `openclaw.json` is currently `{}`** (empty) — the actual node registry lives in `~/.openclaw/nodes/paired.json` and `~/.openclaw/devices/paired.json`, not in the config file. The config only holds the command allow/deny lists.

---

## 4. What does the `talk` config do? Is it relevant to Stack-chan?

**Yes — `talk` is directly relevant to Stack-chan (voice/realtime).** From the actual config:

```json5
"talk": {
  "interruptOnSpeech": true,
  "consultThinkingLevel": "adaptive",
  "realtime": {
    "mode": "realtime",
    "brain": "direct-tools"
  }
}
```

From `docs/nodes/talk.md`, Talk mode covers five runtime shapes:
- **Native macOS/iOS/Android Talk** — local STT, Gateway chat, `talk.speak` TTS. Nodes advertise the `talk` capability and declare `talk.*` commands.
- **iOS Talk (realtime)** — client-owned WebRTC for OpenAI realtime
- **Browser Talk** — `talk.client.create` / `talk.session.create`
- **Android Talk (realtime)** — `talk.realtime.mode: "realtime"` + `talk.realtime.transport: "gateway-relay"`
- **Transcription-only clients** — `talk.session.create({ mode: "transcription", transport: "gateway-relay", brain: "none" })`

**Key config keys relevant to Stack-chan:**
- `talk.realtime.mode: "realtime"` — continuous speech
- `talk.realtime.brain: "direct-tools"` — legacy direct-tool compatibility (vs `agent-consult` which routes through Gateway policy)
- `talk.realtime.transport` — `webrtc` (client-owned), `provider-websocket`, or `gateway-relay` (keeps provider audio on the Gateway)
- `interruptOnSpeech: true` — barge-in (user talks while assistant speaks → playback stops)
- `silenceTimeoutMs` — pause window before sending transcript (700ms macOS/Android, 900ms iOS)
- `consultThinkingLevel: "adaptive"` — thinking level override for realtime agent consult

**Relevance to Stack-chan:** The `esp-openclaw-talk` component (from the esp-openclaw-node repo) adapts OpenClaw's Talk API to `esp_webrtc` signaling. The voice pipeline is **esp_webrtc + esp_capture + esp-sr (WakeNet) + AEC + Opus**. This is the **native ESP-IDF path** for Stack-chan voice — the room-node owns the AFE (WakeNet/AEC/VAD) exclusively (esp-sr is single-instance). The `talk` config on the gateway side is what the ESP32's WebRTC Talk path connects to.

---

## 5. Are there any existing device-to-agent patterns that already solve the channel binding question?

**Yes — three, at different levels of abstraction:**

### 5a. The `bindings` array (channel → agent routing) — THE ANSWER TO JAMES'S QUESTION

From the actual config, `bindings` maps channel accounts to agents:

```json5
bindings: [
  { agentId: "main",   match: { accountId: "default", channel: "telegram" } },
  { agentId: "rosie",  match: { accountId: "rosie",   channel: "telegram" } },
  ...
]
```

**This is the "channel key" mechanism James is pointing at.** The routing is deterministic and controlled by host config — the model does not choose a channel. Routing picks one agent per inbound message by match order:
1. exact `peer` → 2. parent peer → 3. peer wildcard → 4. guild+roles → 5. guild → 6. team → 7. `accountId` → 8. channel (`accountId: "*"`) → 9. default agent

**Session key construction** (`buildAgentPeerSessionKey`): with `dmScope = per-channel-peer` (this machine's setting), a DM becomes:
```
agent:<agentId>:<channel>:direct:<peerId>
```
e.g. `agent:rosie:telegram:direct:<chatId>`. Groups: `...:group:<peerId>`, threads append `:thread:<id>`.

**The channel is the stable identity.** Sessions hang off channels. When sessions reset at 4am, the channel survives and a new session is created under it. This is exactly what James described.

### 5b. The OpenAI HTTP endpoint (device → agent, no channel plugin needed)

From `docs/gateway/openai-http-api.md` — the Gateway serves `/v1/chat/completions` (enabled on this machine: `gateway.http.endpoints.chatCompletions.enabled: true`). This is the **pragmatic fit for an ESP32**:

- **Agent selection** = `model` field: `openclaw/rosie` → Rosie agent (or `x-openclaw-agent-id: rosie` header)
- **Session continuity** = stable OpenAI `user` string (auto-scoped to `agent:rosie:user:<value>`) OR `x-openclaw-session-key: agent:rosie:stackchan:<id>` (fully qualified)
- **Channel identity** = `x-openclaw-message-channel: <channel>` header (sets synthetic ingress channel context)
- **Auth** = `Authorization: Bearer <gateway-token/password>` (full operator-equivalent — keep on loopback/tailnet/private ingress)

**Critical caveat from the research:** The session key is an **opaque bucket identifier scoped inside the selected agent** — it does NOT select the agent. Agent selection is `x-openclaw-agent-id` header → `model` field → default agent. A bare `stackchan:*` session key gets re-scoped to the default agent (Clawdio), which is why the earlier test routed to the wrong agent. **Fix:** always send `model: openclaw/rosie` + a fully-qualified `agent:rosie:stackchan:<id>` session key, or a stable `user` string.

### 5c. Channel docking (`session.identityLinks`)

`docs/concepts/channel-docking.md` — a session's reply route can move between linked channels via `/dock-<channel>` commands. Requires `session.identityLinks` mapping a canonical identity to channel-prefixed peer ids. This is a **cross-channel identity** mechanism — relevant if Stack-chan should share identity with James's Telegram identity.

---

## 6. What about the Clawdio-Mini node? How does it bind to the Gateway?

**Clawdio-Mini is the reference for how a physical device binds to the Gateway.** From `~/.openclaw/nodes/paired.json`:

- `clientId: "openclaw-macos"`, `clientMode: "ui"`, `role: node` (also `operator`)
- Connects to the Gateway WebSocket on port 18789
- Has **two tokens**: an `operator` token (scopes: `operator.admin/read/write/approvals/pairing`) and a `node` token (scopes: `[]` — the node role carries no operator scopes)
- Declares `caps`, `commands`, `permissions`, `bins` on connect
- `lastConnectedAtMs` / `lastSeenAtMs` / `lastSeenReason: "connect"` tracked by the gateway

**How it binds (from `docs/nodes/index.md`):**
- macOS runs in **node mode**: the menubar app connects to the Gateway's WS server and exposes its local canvas/camera commands as a node
- `openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"` (foreground) or `openclaw node install` + `openclaw node start` (service)
- Node host auth: `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD` env vars, or `gateway.auth.token` / `gateway.auth.password` config
- Pairing: `openclaw devices list` → `openclaw devices approve <requestId>` → `openclaw nodes status`
- Exec approvals are **per node host** at `~/.openclaw/exec-approvals.json`

**The pattern for Stack-chan:** Clawdio-Mini is a **full WS node** — too heavy for an ESP32. But the **conceptual model transfers**: Stack-chan should be a node with a declared command surface (`rosie.servo.look`, `rosie.vision.capture`, `talk.start`, etc.), filtered by `gateway.nodes.allowCommands`. The difference is the **transport** — ESP32 uses HTTP `/v1/chat/completions` (or a thin WebRTC Talk path) instead of the full WS control plane.

---

## 7. Recommendations for Stack-chan (synthesis)

Based on all the reference patterns, the **channel binding question** resolves to:

### The channel key (James's direction)
Stack-chan should be treated as a **first-class channel identity**, not just a session. The stable identity is the **channel**, and sessions hang off it. Concretely:

1. **Use the OpenAI HTTP endpoint** (`/v1/chat/completions`) as the transport — it's the pragmatic fit for an ESP32 (no WS handshake, no pairing, no crypto).
2. **Select the agent via `model: openclaw/rosie`** (or `x-openclaw-agent-id: rosie`) — never rely on the session key for agent selection.
3. **Give it a channel identity** via `x-openclaw-message-channel: stackchan` header — this is the "channel key" that survives session resets.
4. **Use a stable, fully-qualified session key** `agent:rosie:stackchan:<device>` (or a stable `user` string) for conversation continuity within the channel.
5. **Register the robot command surface** in `gateway.nodes.allowCommands` (already partially done: `rosie.status`, `rosie.servo.look`, `rosie.servo.home`, `rosie.vision.capture`).

### When a full channel plugin is warranted
Only if Stack-chan must behave as a **native messaging network** (its own users/rooms/webhooks/outbound transport) or appear in `channels list`/status. For a single physical device talking to one agent (Rosie), the HTTP endpoint + headers is sufficient — **no channel plugin required**.

### The voice path
For realtime voice, the `esp-openclaw-talk` component (esp_webrtc + esp_capture + esp-sr WakeNet + AEC + Opus) is the native ESP-IDF path. The gateway-side `talk` config (`realtime.mode: "realtime"`, `brain: "direct-tools"`, `interruptOnSpeech: true`) is what it connects to.

### The robot-bridge lesson
The most production-mature Stack-chan integration (robot-bridge) proved the **"thin bridge" pattern**: the agent owns the conversation; the bridge/device is just the audio/protocol/vision execution layer. Our native firmware approach eliminates the Python bridge entirely — the ESP32 talks directly to the gateway — but the tool definitions, conversation flow, and feature set are directly informed by what robot-bridge already proved works.

---

## Appendix: Key file references

- `~/.openclaw/openclaw.json` — gateway config (auth password `clawdiomax`, port 18789, `nodes.allowCommands` with robot commands, `bindings`, `talk`, `session.dmScope: per-channel-peer`)
- `~/.openclaw/nodes/paired.json` — Clawdio-Mini + iPhone node records (caps, commands, permissions, tokens)
- `~/.openclaw/devices/paired.json` — device pairing records (roles, scopes, tokens, public keys)
- `~/.openclaw/identity/device.json` + `device-auth.json` — the CLI/operator device identity (Ed25519 keypair + operator token)
- `docs/nodes/index.md` — node pairing, capabilities, permissions, node host
- `docs/gateway/pairing.md` — gateway-owned node pairing lifecycle
- `docs/gateway/bridge-protocol.md` — legacy TCP bridge (removed, historical)
- `docs/gateway/openai-http-api.md` — the HTTP endpoint + headers
- `docs/gateway/config-channels.md` — channel config (DM/group policies)
- `docs/channels/channel-routing.md` — routing rules + session key shapes
- `docs/channels/index.md` — supported channels list
- `docs/concepts/channel-docking.md` — cross-channel identity (`session.identityLinks`)
- `docs/nodes/talk.md` — Talk mode config
- `docs/plugins/sdk-channel-plugins.md` — channel plugin SDK
- `robot-bridge` repo (in `analysis/`) — the production Stack-chan/Hermes integration
- `esp-openclaw-node` repo (in `repos/`) — the native ESP-IDF OpenClaw components (esp-openclaw-node, esp-openclaw-room-node, esp-openclaw-talk)
