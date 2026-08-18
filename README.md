# Stack-chan OpenClaw Integration

Connecting a Stack-chan robot (ESP32) to an OpenClaw agent (Rosie) via the Gateway's HTTP API — with proper agent binding, workspace access, and session control.

## Status

### ✅ Done
- **Firmware extensions** (commit `ff2df3a` on fork)
  - `openclaw_s` config struct extended with `agent_id`, `bot_token`, `default_model`
  - `hermes_s` backend struct (same shape, swappable)
  - `backend` selector in `ex_config_s` (0=openclaw, 1=hermes)
  - `OpenClawClient::chat()` routes host/port/model based on backend
  - `/config` GET endpoint returns current config as JSON
  - `/config` POST endpoint writes config to SPIFFS
  - YAML buffer bumped to min 4096 bytes
- **Web config editor** (`config-editor/`)
  - Node.js server on port 5570
  - Edit Stack-chan config from a browser
  - POSTs config to the robot's `/config` endpoint
- **End-to-end test harness** (`test-harness/e2e_test_harness.py`)
  - 8/8 tests passed — full pipeline simulation
  - Proves: agent identity (Rosie), workspace access (read + write), multi-turn conversation, system prompt handling, streaming-capable, tool-use support, response parsing (firmware-compatible), workspace file write as rosie agent
- **Workspace write test** (`test-harness/workspace_write_test.py`)
  - 5/5 tests passed — Stack-chan writes to Rosie's workspace AS rosie
  - Proves: agent binding is real, file written to disk, content verified
- **Research phase 1** (`research/`)
  - 5 research docs covering: channel plugin architecture, Hermes/agent binding, HTTP endpoint session behavior, Gateway WebSocket protocol, multi-agent session routing
  - Root cause found: bare session keys get re-scoped to default agent (Clawdio); fix is `user` field or agent-prefixed session key

### 🔄 In Progress
- **Research phase 2** — 5 deep-read subagents investigating:
  - Channel plugin SDK (minimum viable plugin, session key construction, binding logic)
  - HTTP endpoint internals (code-level trace of `x-openclaw-message-channel` behavior)
  - Hermes channel/integration patterns (how Hermes handles channels, ACP adapter)
  - Session reset & channel persistence (what survives 4am dreaming, how channels recreate sessions)
  - Existing device/robot patterns (robot-bridge, nodes config, talk config)
- **Channel surface validation** — James raised the critical question: sessions reset at 4am, channels survive. Stack-chan needs to be a proper channel, not just a session key. Deep-read research will determine v1 vs v2 approach.

### 📋 TODO
- Determine v1 (HTTP + headers + binding config) vs v2 (full channel plugin)
- Validate channel surface survives 4am session reset
- Update firmware `OpenClawClient::chat()` with correct headers
- Test on hardware

## Architecture

```
ESP32 Stack-chan                    OpenClaw Gateway                    Rosie Agent
┌─────────────┐    POST /v1/chat     ┌──────────────┐    agent run     ┌─────────────┐
│ OpenClaw    │ ──────────────────▶ │ Gateway      │ ──────────────▶ │ rosie       │
│ Client      │  model:openclaw/    │ :18789       │                 │ (workspace) │
│             │  rosie              │              │  ◀────────────── │             │
│ TTS + Avatar│ ◀───────────────── │              │   response      │             │
└─────────────┘    JSON response    └──────────────┘                 └─────────────┘
```

## Key Files

### Firmware (in fork repo)
- `firmware/src/llm/OpenClaw/OpenClawClient.cpp` — HTTP client, sends chat requests
- `firmware/src/StackchanExConfig.h` — config structs with agent binding
- `firmware/src/llm/OpenClaw/OpenClawConfig.h` — config loading from SPIFFS YAML
- `Copy-to-SD/app/AiStackChanEx/SC_ExConfig.yaml.example` — example config

### Config Editor
- `config-editor/server.js` — Node.js web server (port 5570)
- `config-editor/public/` — web UI for editing robot config

### Test Harness
- `test-harness/e2e_test_harness.py` — 8-test end-to-end simulation
- `test-harness/workspace_write_test.py` — workspace write validation

### Research
- `research/CURRENT_PLAN.md` — current plan & findings (saved Aug 18 12:00 MDT)
- `research/channel-plugin-architecture.md` — how channel plugins work
- `research/hermes-and-agent-binding.md` — how Hermes/agent binding works
- `research/http-endpoint-session-behavior.md` — HTTP endpoint session routing
- `research/gateway-protocol-ws.md` — WebSocket protocol analysis
- `research/multi-agent-session-routing.md` — multi-agent routing config
- `research/deep-read-*.md` — phase 2 deep-read reports (in progress)

### Analysis
- `analysis/` — repo analyses, adversarial reviews, architecture feasibility studies

## Key Findings

### Agent Binding
- `model: openclaw/rosie` routes to Rosie with full workspace access (read + write) ✅
- `user: "stackchan:<device_id>"` creates persistent Rosie-bound sessions ✅
- Bare `x-openclaw-session-key: stackchan:*` routes to default agent (Clawdio) ❌ — must use agent-prefixed key `agent:rosie:stackchan:*`

### Channel vs Session
- **Session** = ephemeral conversation context. Reset at 4am for dreaming/compaction.
- **Channel** = stable identity (like `telegram`, `discord`). Survives session resets.
- Stack-chan needs to be a **channel**, not just a session — this is the current open question.

### Bindings (from Gateway config)
```json
[
  { "agentId": "rosie", "match": { "channel": "telegram", "accountId": "rosie" } }
]
```
Stack-chan would need a similar binding to route to the right agent.

## Firmware Repo

The firmware lives in a fork of plaipin-openclaw-stackchan:
- **Fork:** https://github.com/styles01/plaipin-openclaw-stackchan
- **Upstream:** https://github.com/PlaiPin/plaipin-openclaw-stackchan

## Team
- **Rosie** (household ops director) — project lead, agent binding, test harness
- **Dex** (subagent) — firmware extensions, research
- **James** — product direction, architecture decisions