<div align="center">

# Stack-chan × OpenClaw

**Give a little robot a real AI agent — with persistent identity, workspace access, and session control.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: ESP32](https://img.shields.io/badge/platform-ESP32-blue.svg)](https://www.espressif.com/en/products/socs/esp32)
[![Agent: OpenClaw](https://img.shields.io/badge/agent-OpenClaw-purple.svg)](https://docs.openclaw.ai)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-support-yellow?logo=buy-me-a-coffee&logoColor=white)](https://buymeacoffee.com/aitamedia)

[Project](#the-problem) · [Architecture](#architecture) · [Firmware](#firmware) · [Config Editor](#web-config-editor) · [Tests](#test-harness) · [Research](#research)

</div>

---

## The Problem

You have a [Stack-chan](https://github.com/meganetaaan/stack-chan) — a cute little ESP32 robot with a face, a speaker, and a microphone. Out of the box, it talks to cloud LLM APIs the same way every other IoT device does: stateless HTTP calls, no identity, no memory, no agent binding. Every request is a one-shot. The robot has no idea who it is, who it's talking to, or what was said 5 minutes ago.

That's not an AI companion. That's a smart speaker with a face.

## The Brief

**What if the robot was a first-class citizen in your AI agent ecosystem?**

[OpenClaw](https://docs.openclaw.ai) runs AI agents with workspace access, memory files, and tool use. Agents talk to humans via channels (Telegram, Discord, WhatsApp). Each channel has a **stable identity** that survives session resets, dreaming cycles, and context compaction. Sessions come and go — the channel persists.

**The goal:** Make Stack-chan a proper channel in OpenClaw. Not a stateless HTTP client. A channel with a stable identity, agent binding, persistent sessions, and full workspace access — so the robot can remember conversations, write files, use tools, and be a real member of the agent ecosystem.

## What We Built

### Firmware Extensions

Extended the Stack-chan ESP32 firmware to talk to the OpenClaw Gateway instead of a raw LLM API:

- **Agent binding** — config struct extended with `agent_id`, `bot_token`, `default_model` so the robot knows which agent it belongs to
- **Backend selector** — swappable between OpenClaw (`backend: 0`) and Hermes (`backend: 1`) with the same config shape
- **Config endpoint** — `GET /config` returns current config as JSON, `POST /config` writes config to SPIFFS. The robot can be reconfigured over the network without reflashing.
- **YAML buffer** — bumped to 4096 bytes to fit the extended config
- **Emoji stripping** — `stripEmoji()` removes 4-byte emoji and 3-byte symbols for TTS compatibility (robots can't say 🎉)

```cpp
// Firmware config struct (StackchanExConfig.h)
// Replace "rosie" with your agent's id
struct openclaw_s {
  String host;
  uint16_t port;
  String agent_id;      // e.g. "rosie"
  String bot_token;     // Gateway auth
  String default_model; // e.g. "openclaw/rosie"
};
```

### Web Config Editor

A browser-based config editor for Stack-chan — because flashing YAML files via SD card gets old:

- Node.js server on port 5570
- Edit robot config from any device on your network
- POSTs config directly to the robot's `/config` endpoint
- No reflashing, no SD card swapping

### Test Harness

**8/8 end-to-end tests passed. 5/5 workspace write tests passed.**

The test harness simulates the full firmware message pipeline — system prompts + user message array → Gateway → agent response → JSON parsing — and validates that Stack-chan can:

- ✅ Talk to the right agent (your agent, not the default)
- ✅ Read and write files in your agent's workspace
- ✅ Handle multi-turn conversations
- ✅ Process system prompts from SPIFFS
- ✅ Parse responses in firmware-compatible JSON
- ✅ Use tools (workspace file writes confirmed on disk)
- ✅ Maintain agent identity across requests

## Architecture

```
ESP32 Stack-chan                    OpenClaw Gateway                    Your Agent
┌─────────────┐    POST /v1/chat     ┌──────────────┐    agent run     ┌─────────────┐
│ OpenClaw    │ ──────────────────▶ │ Gateway      │ ──────────────▶ │ your-agent  │
│ Client      │  model:openclaw/    │ :18789       │                 │ (workspace) │
│             │  your-agent         │              │  ◀────────────── │             │
│ TTS + Avatar│ ◀───────────────── │              │   response      │             │
└─────────────┘    JSON response    └──────────────┘                 └─────────────┘
```

### The Channel Question

> **Why not just use a stateless HTTP client?** Because OpenClaw resets sessions at 4am — the conversation context gets wiped to prevent bloat and enable dreaming. But the **channel identity survives**. The next message after a reset creates a fresh session under the same channel. Stack-chan needs the same treatment.

OpenClaw channels (Telegram, Discord, WhatsApp) have **stable identities** that survive the 4am session reset / dreaming cycle. Sessions are ephemeral — they get wiped nightly to prevent context bloat. Channels are permanent — the next message after a reset creates a fresh session under the same channel.

**Stack-chan needs the same treatment.** Two approaches:

| | v1: HTTP + Headers | v2: Channel Plugin |
|---|---|---|
| **How** | Firmware sends `model: openclaw/<agent_id>` + `x-openclaw-message-channel: stackchan` + `x-openclaw-session-key: agent:<agent_id>:stackchan:<device>` | A minimal OpenClaw channel plugin that registers `stackchan` as a first-class channel |
| **Agent binding** | Via `model` field + explicit session key prefix | Via `bindings` config (like Telegram) |
| **Session persistence** | Session key survives 4am reset (only sessionId rotates, sessionKey persists) | Same — channel plugin constructs proper session keys |
| **Channel identity** | Synthetic (header label, not a real channel in the registry) | First-class (appears in `channels list`, has config, can have multiple accounts) |
| **Effort** | Low — works today, no Gateway changes | Medium — plugin code + manifest |
| **When** | Ship now, validate behavior | When Stack-chan needs multi-device, outbound push, or channel management |

### Key Findings

- **`model: openclaw/rosie`** routes to the target agent with full workspace access (read + write) ✅
- **`user: "stackchan:<device_id>"`** creates persistent agent-bound sessions ✅
- **Bare session keys route to the wrong agent** — `x-openclaw-session-key: stackchan:*` gets re-scoped to the default agent. Must use agent-prefixed key: `agent:<agent_id>:stackchan:*` ✅
- **4am reset rotates `sessionId`, not `sessionKey`** — the channel identity and session key survive, only the conversation context resets. This is by design (dreaming/compaction). ✅
- **`x-openclaw-message-channel: stackchan`** sets the delivery routing context (where replies go) but does NOT affect session identity

## Firmware

The firmware lives in a fork of [plaipin-openclaw-stackchan](https://github.com/PlaiPin/plaipin-openclaw-stackchan):

- **Fork:** https://github.com/styles01/plaipin-openclaw-stackchan

### Key files
- `firmware/src/llm/OpenClaw/OpenClawClient.cpp` — HTTP client, sends chat requests to Gateway
- `firmware/src/StackchanExConfig.h` — config structs with agent binding
- `firmware/src/llm/OpenClaw/OpenClawConfig.h` — config loading from SPIFFS YAML
- `Copy-to-SD/app/AiStackChanEx/SC_ExConfig.yaml.example` — example config

### Config YAML
```yaml
openclaw:
  host: "192.168.x.x"     # Gateway host (LAN or tailnet)
  port: 18789              # Gateway port
  agent_id: "rosie"        # Your agent's id
  bot_token: "..."         # Gateway auth token
  default_model: "openclaw/rosie"  # openclaw/<agent_id>
hermes:
  host: ""
  port: 0
  agent_id: ""
  bot_token: ""
  default_model: ""
backend: 0                 # 0 = OpenClaw, 1 = Hermes
```

## Web Config Editor

A standalone HTML page that talks directly to the Stack-chan's `/config` endpoint. No server needed — just open it in a browser.

```
test-harness/web-config.html    # Open this file in any browser
```

Features:
- Connect to any Stack-chan by IP address
- View and edit OpenClaw + Hermes backend settings
- Switch active backend (0=OpenClaw, 1=Hermes)
- Test chat endpoint inline
- View raw config JSON

The ESP32 firmware serves these endpoints on port 80:
- `GET /config` — returns current config as JSON
- `POST /config` — updates config and persists to SPIFFS
- `GET /role_get` — returns current role text
- `POST /role_set` — sets role text
- `GET /memory_get` — returns user info
- `POST /memory_clear` — clears user info
- `GET /chat?text=<msg>` — sends a chat message to the LLM
- `GET /speech?say=<text>` — speaks text via TTS

## Test Harness

```bash
# End-to-end test (simulates full firmware pipeline)
python3 test-harness/e2e_test_harness.py

# Workspace write validation (proves agent binding is real)
python3 test-harness/workspace_write_test.py
```

### Test results
| Suite | Tests | Passed | Time |
|---|---|---|---|
| Agent binding (strict) | 12 | 12 ✅ | ~2min |

All 12 tests use strict identity validation: Rosie must say "rosie", Venus must say "venus", session persistence must contain "testbot". No false positives.

```bash
# Run all tests (requires live OpenClaw + Hermes gateways)
python3 test-harness/test_agent_binding.py \
  --oc-key <gateway_password> \
  --hermes-key <venus_api_key> \
  --hermes-url http://127.0.0.1:8643

# Unit tests only (no network)
python3 test-harness/test_agent_binding.py --unit-tests-only
```

## Research

Deep research into OpenClaw's channel plugin architecture, session lifecycle, and agent binding — using subagents to read source code and docs without burning main context.

### Phase 1: Architecture survey
- `research/channel-plugin-architecture.md` — how channel plugins work
- `research/hermes-and-agent-binding.md` — how Hermes/agent binding works
- `research/http-endpoint-session-behavior.md` — HTTP endpoint session routing
- `research/gateway-protocol-ws.md` — WebSocket protocol analysis
- `research/multi-agent-session-routing.md` — multi-agent routing config

### Phase 2: Deep code reads
- `research/deep-read-channel-sdk.md` — channel plugin SDK internals
- `research/deep-read-http-internals.md` — HTTP endpoint code trace
- `research/deep-read-hermes-channels.md` — Hermes channel patterns
- `research/deep-read-session-reset.md` — 4am reset & channel persistence
- `research/deep-read-device-patterns.md` — existing robot/device patterns

### Current plan
- `research/CURRENT_PLAN.md` — living plan & findings document

## Status

### ✅ Done
- Firmware extensions (commit `ff2df3a`, pushed to fork)
- Web config page (`test-harness/web-config.html` — browser-based, talks to ESP32 `/config` endpoint)
- Agent binding test harness — 12/12 passed with strict identity validation
- Workspace file I/O tests — both agents can write/update/read files via HTTP API
- Research phase 1 — 5 research docs
- Research phase 2 — 5 deep code reads
- API reference — both Option A (multiplex) and Option B (dedicated port) documented
- Code review V2 — 4 critical, 8 recommended findings (see `CODE_REVIEW_V2.md`)
- Hermes Venus setup — dedicated port 8643 with own API key (Option B)

### 📋 TODO — Firmware (v1)
- **C1:** Add session/channel headers to `OpenClawClient::http_post_json()`
- **C2:** Fix config YAML round-trip (write full struct, not just backend/openclaw/hermes)
- **C3:** Add auth to web endpoints + mask bot_token in GET /config
- **C4:** Enlarge `DynamicJsonDocument` buffers to 4096
- **R1:** Cap `chatHistory` length (prevent unbounded growth)
- **R2:** Add mutex around chat/speech (thread safety)
- Test on hardware

## License

MIT — see [LICENSE](LICENSE)

---

<div align="center">

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-support-yellow?logo=buy-me-a-coffee&logoColor=white)](https://buymeacoffee.com/aitamedia)

If this project helped you build something cool with a little robot, consider supporting the work. 🤖☕

</div>