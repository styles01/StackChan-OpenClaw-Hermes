<div align="center">

# Stack-chan × OpenClaw × Hermes

**Give a little robot a real AI agent — with persistent identity, workspace access, session control, and profile binding across multiple backends.**

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

**What if the robot was a first-class citizen in your AI agent ecosystem — and could bind to different agents on different backends?**

We run two AI agent platforms:

- **[OpenClaw](https://docs.openclaw.ai)** — runs agents with workspace access, memory files, and tool use. Agents talk to humans via channels (Telegram, Discord, WhatsApp). Each channel has a **stable identity** that survives session resets, dreaming cycles, and context compaction.
- **[Hermes](https://github.com/NousResearch/hermes-agent)** — runs agents with STT, LLM, TTS, memory, skills, and MCP configuration.

**The goal:** Make Stack-chan a proper channel in **both** ecosystems — with profile binding so each physical robot knows which backend AND which agent it belongs to.

### Profile Binding

Each Stack-chan has a **profile** that binds it to a specific backend + agent:

| Robot | Backend | Agent | Port | Session Key |
|-------|---------|-------|------|------------|
| Robot A | OpenClaw | Rosie (household ops) | 18789 | `agent:rosie:stackchan:robot-a` |
| Robot B | Hermes | Venus (product strategy) | 8643 | `venus-stackchan:robot-b` |
| Robot C | OpenClaw | custom agent | 18789 | `agent:custom:stackchan:robot-c` |

Profiles are configured via BLE provisioning or the web config editor — no reflashing needed. The `backend` field in config selects OpenClaw (0) or Hermes (1), and the agent binding headers/routes follow accordingly.

### Why Both Backends?

OpenClaw and Hermes have different strengths. OpenClaw gives agents workspace file I/O, channel persistence, and tool use. Hermes gives agents voice-first interaction, MCP tools, and a TUI dashboard. Some robots serve as household assistants (OpenClaw/Rosie), others as research companions (Hermes/Venus). Profile binding lets one fleet of robots span both worlds.

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

Stack-chan supports **two backends** with profile binding. The firmware config struct has both OpenClaw and Hermes fields, with a `backend` selector (0=OpenClaw, 1=Hermes). The same robot can be reconfigured to talk to either backend via the web config editor or BLE provisioning — no reflashing needed.

### OpenClaw Path

```
ESP32 Stack-chan                    OpenClaw Gateway                    Your Agent
┌─────────────┐    POST /v1/chat    ┌──────────────┐    agent run     ┌─────────────┐
│ OpenClaw    │ ──────────────────▶ │ Gateway      │ ──────────────▶ │ your-agent  │
│ Client      │  model:openclaw/    │ :18789       │                 │ (workspace) │
│             │  your-agent         │              │  ◀────────────── │             │
│ TTS + Avatar│ ◀───────────────── │              │   response      │             │
└─────────────┘    JSON response    └──────────────┘                 └─────────────┘
```

- Headers: `model: openclaw/<agent_id>`, `x-openclaw-session-key: agent:<agent_id>:stackchan:<device>`, `x-openclaw-message-channel: stackchan`
- Agent binding via `model` field + agent-prefixed session key
- Full workspace file I/O (read + write)
- Session key survives 4am reset (only sessionId rotates)

### Hermes Path

```
ESP32 Stack-chan                    ai-server (bridge)                 HermesAgent
┌─────────────┐    WebSocket + Opus  ┌──────────────┐  session.create ┌─────────────┐
│ Hermes      │ ──────────────────▶ │ ai-server    │ ──────────────▶│ HermesAgent │
│ Client      │  ws://server:8765   │ (TypeScript) │  prompt.submit  │ (STT/LLM/   │
│             │                     │              │                 │  TTS/MCP)   │
│ TTS + Avatar│ ◀───────────────── │              │  ◀────────────── │             │
└─────────────┘  Opus audio stream  └──────────────┘  message.done   └─────────────┘
```

- Dedicated port per profile (Venus on 8643)
- Auth: `Authorization: Bearer <profile_api_key>`
- Session: `X-Hermes-Session-Key: <agent>-stackchan-<device>`
- MCP tools: `stackchan_take_photo`, `stackchan_set_head_angles`, `stackchan_set_led_color`, etc.
- Voice-first: streaming ASR + LLM + TTS architecture

### Reference Implementation: circlemouth/Hermes-StackChan

The [Hermes-StackChan](https://github.com/circlemouth/Hermes-StackChan) fork is our **primary reference** for the Hermes path. It already solved:
- Firmware → custom WebSocket server (instead of XiaoZhi cloud)
- ai-server TypeScript bridge (Opus audio ↔ HermesAgent protocol)
- Full MCP tool suite (13 robot control tools)
- BLE provisioning with `websocket_url` config
- Desktop UI simulator (test avatar without flashing)
- Hermes error display on avatar face

We extend this to add OpenClaw as a second backend option.

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

The firmware has **three development paths**. The official M5Stack firmware uses ESP-IDF (not PlatformIO), and a community UIFlow2 Python implementation also exists.

### Path 1: Official ESP-IDF Firmware (✅ CONFIRMED WORKING — built & flashed Aug 18, 2026)

The official [m5stack/StackChan](https://github.com/m5stack/StackChan) firmware is **native ESP-IDF (C++)**, NOT Arduino/PlatformIO. It's a fork of xiaozhi-esp32 v2.2.4. Firmware version: 1.4.3.

**Toolchain:** ESP-IDF v5.5.4 (installed at `/Volumes/1TBSSDClawd/esp-idf/`)

```bash
# Activate ESP-IDF (must be in same shell as build/flash)
export IDF_PATH=/Volumes/1TBSSDClawd/esp-idf
. "$IDF_PATH/export.sh"

cd /Volumes/1TBSSDClawd/stackchan-node/repos/StackChan/firmware
idf.py set-target esp32s3                     # first time only
python3 ./fetch_repos.py                      # fetch deps
idf.py build                                  # build (~2 min, 2493 steps)
idf.py -p /dev/cu.usbmodem211301 flash         # flash (~30 sec)

# Host-side tests (NO HARDWARE NEEDED — just CMake!)
cmake -S tests -B build-host-tests
cmake --build build-host-tests
ctest --test-dir build-host-tests --output-on-failure
```

**Flash partitions:** bootloader(0x0) + stack-chan.bin(0x20000, 3.7MB) + partition_table(0x8000) + ota_data(0xd000) + generated_assets(0xa00000, 2.3MB)
**Firmware config:** `CONFIG_BOARD_TYPE_M5STACK_STACK_CHAN=y`, SPIRAM 80MHz, BLE NimBLE, QIO flash 16MB
**Dependencies:** mooncake v2.3.3, xiaozhi-esp32 v2.2.4 (patched), ArduinoJson v7.4.2, esp-now, smooth_ui_toolkit v2.12.0
**AI layer:** xiaozhi-esp32 v2.2.4 — WebSocket/MQTT client to XiaoZhi cloud. This is the integration point for OpenClaw.

**Factory restore:** `/Volumes/1TBSSDClawd/stackchan-node/backups/cores3_factory_uiflow2_v2.5.1.bin`
```bash
esptool.py --chip esp32s3 -p /dev/cu.usbmodem211301 -b 460800 \
  --before=default_reset --after=hard_reset \
  write_flash --flash_mode dio --flash_size 16MB --flash_freq 80m \
  0x0 /Volumes/1TBSSDClawd/stackchan-node/backups/cores3_factory_uiflow2_v2.5.1.bin
```

### Path 2: UIFlow2 Python (Recommended for rapid development)

[haraisao/stackchan-uiflow2](https://github.com/haraisao/stackchan-uiflow2) — complete Stack-chan implementation in Python/MicroPython for UIFlow2. Runs on factory firmware, no build system needed.

- Face rendering (11 expressions, blinking, talk animation)
- TTS (Google, Voicevox) + STT (Google, Vosk)
- Dialog backends: Gemini, OpenAI, LM Studio, Dify (adding OpenClaw = 1 new file)
- Motor control (Dynamixel, SG90), camera with face tracking, web server with REST API
- Deploy via UIFlow2 web IDE (`https://uiflow2.m5stack.com/`) or USB-ampy

### Path 3: PlatformIO Arduino Fork (Legacy — requires fixes)

The [plaipin-openclaw-stackchan](https://github.com/PlaiPin/plaipin-openclaw-stackchan) fork uses PlatformIO Arduino. **All builds produced black screen / boot loop on CoreS3.**

**Root cause (confirmed Aug 18, 2026 via subagent analysis):**
1. Missing `-mfix-esp32-psram-cache-issue` — ESP32-S3 cache errata CACHE-126 causes random crashes under PSRAM load
2. Wrong board `esp32s3box` — I2C pins wrong (SDA=41/SCL=40 vs CoreS3's SDA=12/SCL=11)
3. M5Unified 0.1.17 mismatched with M5GFX 0.2.27 — incompatible version pairing

**To fix:** `board = esp32-s3-devkitc-1`, add `-mfix-esp32-psram-cache-issue -DESP32S3 -DBOARD_HAS_PSRAM` to build_flags, update M5Unified to `^0.2.20`.

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
- Official ESP-IDF firmware built + flashed (v1.4.3, working on CoreS3)
- Working reference repos collected (5 repos in `repos/working-repos/`)
- **Hermes-StackChan reference** — circlemouth fork analyzed as primary architecture reference
- **Profile binding validated** — Rosie on OpenClaw:18789, Venus on Hermes:8643, strict identity tests pass
- **Three-repo merge** — official v1.4.3 + circlemouth ai-server + plaipin config layer
- **Web config server** — GET/POST /config on device port 80, HTML editor, mDNS (`clawdio-mini.local`)
- **Device connected to ai-server** — full chain: device → mDNS → WS → ai-server → OpenClaw → Rosie
- **English voice** — TTS (`en-GB-LibbyNeural`), STT (faster-whisper, English), English fast-acks
- **OpenClaw auth** — Bearer token working, HTTP 200
- **Firmware crash fixed** — WiFi power save + TCP reconnect cleanup, 61KB free SRAM (up from 29KB)
- **Device talks and survives** — full conversation cycles: listening → speaking → listening (no crash!)

### 📋 TODO — Firmware (v1)
- **C1:** Add session/channel headers to `OpenClawClient::http_post_json()`
- **C2:** Fix config YAML round-trip (write full struct, not just backend/openclaw/hermes)
- **C3:** Add auth to web endpoints + mask bot_token in GET /config
- **C4:** Enlarge `DynamicJsonDocument` buffers to 4096
- **R1:** Cap `chatHistory` length (prevent unbounded growth)
- **R2:** Add mutex around chat/speech (thread safety)
- **STT/VAD tuning** — raise VAD threshold (0.025 too low), increase max duration, fix segment limit (1 sentence cut-off)
- **Wake word** — submit Espressif request for "Hey Rosie" custom WakeNet, or use "Hey, Ivy" temporarily
- **POST /config crash** — 16384 stack built but untested (device was disconnected)
- **P1:** Fix PlatformIO build: `board = esp32-s3-devkitc-1`, add `-mfix-esp32-psram-cache-issue -DESP32S3 -DBOARD_HAS_PSRAM`, update M5Unified to `^0.2.20`
- **P2:** Or migrate to official ESP-IDF build system (recommended)
- **P3:** Or use UIFlow2 Python path (easiest, no build system)

### 🔮 TODO — Future
- **M5Burner publishing** — publish working firmware via M5Burner for one-click install (no toolchain needed by users)
- **v2 channel plugin** — proper OpenClaw `stackchan` channel plugin for outbound push, multi-device, `channels list` visibility
- **ai-server OpenClaw adapter** — extend circlemouth's ai-server bridge to support OpenClaw Gateway as a backend option alongside HermesAgent
- **Fleet management** — multi-robot profile management UI

## repos/ Directory

### Working Repos (confirmed building/booting on CoreS3)

| Repo | Source | Path | CoreS3 | Purpose |
|------|--------|------|--------|---------|
| `Hermes-StackChan/` | circlemouth/Hermes-StackChan | `working-repos/` | ✅ | **PRIMARY REFERENCE** — fork with self-hosted HermesAgent backend, ai-server bridge, MCP tools, UI simulator |
| `xiaozhi-esp32/` | 78/xiaozhi-esp32 v2.2.6 | `working-repos/` | ✅ | AI/LLM layer (WebSocket/MQTT client), 70+ board support |
| `HeavenlyPointer/` | r3dfish/HeavenlyPointer | `working-repos/` | ✅ | Working PlatformIO firmware, satellite tracker, proper board config |
| `stackchan-mcp/` | kisaragi-mochi/stackchan-mcp | `working-repos/` | ✅ | MCP bridge for Claude + Stack-chan, firmware + Python MCP server |
| `stackchan-bluetooth-simple/` | mongonta0716 | `working-repos/` | ❌ | Core2 only, but servo/YAML config reference |

### Reference Repos (official + legacy)

| Repo | Source | Path | Purpose |
|------|--------|------|---------|
| `StackChan/` | m5stack/StackChan | top level | Official M5Stack firmware (ESP-IDF) — C++ firmware, app, server, remote |
| `stackchan-uiflow2/` | haraisao/stackchan-uiflow2 | top level | UIFlow2 Python implementation — face, voice, motors, dialog backends |
| `plaipin-openclaw-stackchan/` | PlaiPin/plaipin-openclaw-stackchan | top level | Arduino fork (broken on CoreS3) — OpenClaw client code lives here |
| `StackChan-BSP/` | m5stack/StackChan-BSP | top level | Arduino peripheral library — servos, touch, NFC, IR, RGB |
| `esp-openclaw-node/` | openclaw/esp-openclaw-node | top level | ESP node code |
| `zclaw/` | (existing) | top level | Additional tooling |

## Analysis Files (Aug 18, 2026)

- `analysis-official-stackchan.md` — Official repo deep dive (314 lines)
- `analysis-uiflow2-stackchan.md` — UIFlow2 implementation analysis
- `analysis-platformio-issues.md` — PlatformIO root cause analysis (333 lines)

Three subagents analyzed the official StackChan repo, the UIFlow2 implementation, and the PlatformIO build failures. Key findings:

- **Official firmware = ESP-IDF v5.5.4** (not Arduino). Build: `python3 fetch_repos.py && idf.py build && idf.py flash`
- **Host-side tests** run with CMake (no device needed): `cmake -S tests -B build-host-tests && cmake --build build-host-tests && ctest --test-dir build-host-tests --output-on-failure`
- **UIFlow2 Python** implementation is complete and adaptable — adding OpenClaw backend requires 1 new Python file + 1 config entry
- **PlatformIO root cause:** missing PSRAM cache fix + wrong board definition + M5Unified version mismatch

## License

MIT — see [LICENSE](LICENSE)

---

<div align="center">

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-support-yellow?logo=buy-me-a-coffee&logoColor=white)](https://buymeacoffee.com/aitamedia)

If this project helped you build something cool with a little robot, consider supporting the work. 🤖☕

</div>