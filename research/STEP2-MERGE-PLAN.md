# STEP 2 — Merge Plan: 3 Repos → 1

**Date:** 2026-08-19
**Goal:** Merge official StackChan firmware + circlemouth Hermes-StackChan + plaipin-openclaw-stackchan into OUR repo (`styles01/StackChan-OpenClaw-Hermes`)

## The Problem

We have 3 source repos that each solve part of the puzzle, but they're all based on different (stale) versions of the official firmware. We need to:

1. Start from the latest official firmware as our baseline
2. Kill auto-update so our firmware sticks
3. Merge in the reusable parts from all 3 repos
4. Build from OUR repo only

## Source Repos

| # | Repo | Path | What It Provides |
|---|------|------|-----------------|
| 1 | `m5stack/StackChan` | `repos/StackChan/` | Official v1.4.3 ESP-IDF firmware — the baseline. Device is a thin audio client (WebSocket → server does STT/LLM/TTS). Auto-updates via `CONFIG_OTA_URL` to M5Stack's cloud. |
| 2 | `circlemouth/Hermes-StackChan` | `repos/working-repos/Hermes-StackChan/` | Patch to redirect xiaozhi WebSocket to local ai-server bridge. ai-server (TypeScript) with `openclaw.ts` (OpenClaw Gateway HTTP client). Auto-reconnect logic. Skips OTA when local WS configured. 68/68 tests pass. |
| 3 | `plaipin-openclaw-stackchan` | `repos/plaipin-openclaw-stackchan/` | `OpenClawClient.cpp` (HTTP client → Gateway), `StackchanExConfig.h` (config structs with agent binding), `/config` web endpoints (GET/POST config via browser), emoji stripping for TTS. Arduino/PlatformIO (broken on CoreS3). |

## What Each Repo Gives Us

### Repo 1: Official StackChan (Baseline)
- ESP-IDF v5.5.4 build system (`idf.py build`)
- `fetch_repos.py` + `repos.json` — pulls xiaozhi-esp32 v2.2.4 as a dependency
- `application.cc` — main app, calls `ota_->CheckVersion()` on boot (auto-update)
- `websocket_protocol.cc` — the single integration point (WebSocket URL stored in NVS)
- Board config for M5STACK_STACK_CHAN
- All the body code: face/avatar, servos, LED, touch, speaker, mic, BLE provisioning
- **This is our starting point. We clone this into our repo as `firmware/`.**

### Repo 2: circlemouth/Hermes-StackChan (Backend Bridge)
- **`patches/xiaozhi-esp32.patch`** (1188 lines, 11 files) — the key changes:
  - `application.cc` — reads NVS `"websocket"` namespace for local WS URL, skips OTA check when configured
  - Auto-reconnect with exponential backoff (1s→2s→4s→...→30s)
  - `ShowActivationCode()` gutted (no cloud binding)
  - Wi-Fi disconnect shows Hermes error face
- **`ai-server/`** — TypeScript bridge:
  - `src/openclaw.ts` — OpenClaw Gateway HTTP client (routes LLM to `openclaw/agent-a` via `/v1/chat/completions`, per-device session keys)
  - WebSocket server on port 8765 (firmware connects here)
  - Opus audio decode/encode, STT, TTS
  - MCP tools (13 robot control tools: camera, servos, LED, etc.)
  - 68/68 tests passing
- **`sdkconfig.defaults`** — CONFIG_OTA_URL pointed at local server
- **`repos.json`** — same dependency model as official, plus `patch: patches/xiaozhi-esp32.patch`

### Repo 3: plaipin-openclaw-stackchan (Config + HTTP Client)
- **`OpenClawClient.cpp`** — HTTP POST to Gateway `/v1/chat/completions` with `model: openclaw/<agent_id>` + session key headers
- **`StackchanExConfig.h`** — config struct: `openclaw_s {host, port, agent_id, bot_token, default_model}` + `hermes_s` + `backend` selector (0=OpenClaw, 1=Hermes)
- **`/config` web endpoints** — GET/POST config as JSON, persists to SPIFFS
- **`stripEmoji()`** — removes 4-byte emoji for TTS compatibility
- **Web config editor** — `test-harness/web-config.html` (browser-based, talks to ESP32 port 80)
- **NOTE:** This is Arduino/PlatformIO (broken on CoreS3). We take the CODE, not the build system.

## Merge Strategy

### Phase 1: Establish Baseline (Official Firmware in Our Repo)

**Goal:** Our repo builds the official v1.4.3 firmware with zero changes.

1. Copy `repos/StackChan/firmware/` into our repo root as `firmware/`
2. Verify `idf.py build` works (it already did on Aug 18)
3. Kill auto-update:
   - Option A: Set `CONFIG_OTA_URL` to empty/localhost in `sdkconfig.defaults`
   - Option B: Patch `application.cc` to skip OTA check entirely (circlemouth's approach)
   - **Recommended: Option B** — patch application.cc to skip OTA when a local WebSocket URL is configured (same as circlemouth)
4. Commit: "feat: establish v1.4.3 baseline firmware, disable auto-update"

### Phase 2: Merge circlemouth (WebSocket Bridge + ai-server)

**Goal:** Firmware connects to local ai-server instead of xiaozhi cloud.

5. Copy circlemouth's `patches/xiaozhi-esp32.patch` into our `firmware/patches/`
6. Update `firmware/repos.json` to apply the patch (circlemouth's pattern)
7. Copy circlemouth's `ai-server/` into our repo as `ai-server/`
8. Verify the patch applies cleanly against xiaozhi-esp32 v2.2.4
9. Build: `idf.py build` — should produce firmware that connects to local WS
10. Commit: "feat: merge circlemouth WebSocket bridge + ai-server"

### Phase 3: Merge plaipin (Config + HTTP Client + Web Config)

**Goal:** Profile binding, web config, OpenClaw HTTP client.

11. Port `StackchanExConfig.h` concepts into our firmware config (the struct shape: openclaw_s, hermes_s, backend selector)
12. Port `/config` web endpoints (GET/POST config as JSON, persist to SPIFFS)
13. Port `stripEmoji()` utility
14. Port `OpenClawClient.cpp` — adapt from Arduino HTTP to ESP-IDF HTTP client (different API)
15. Copy `test-harness/web-config.html` into our repo (already exists, verify)
16. Commit: "feat: merge plaipin config structs, web endpoints, OpenClaw client"

### Phase 4: Integrate OpenClaw into ai-server

**Goal:** ai-server can route to either OpenClaw Gateway or HermesAgent.

17. Verify `ai-server/src/openclaw.ts` works (circlemouth already wrote it, 68/68 tests pass)
18. Add config to ai-server: `backend: "openclaw" | "hermes"` selector
19. Add OpenClaw session key routing: `agent:<agent_id>:stackchan:<device_id>`
20. Add Hermes session key routing (already exists in circlemouth)
21. Commit: "feat: dual backend selector in ai-server (OpenClaw + Hermes)"

### Phase 5: Build + Flash + Test

22. Backup current device firmware (16MB dump) — MANDATORY before flashing
23. `idf.py build` — produce final firmware binary
24. `idf.py flash` — flash to device
25. Verify: device boots, connects to local ai-server, can talk to OpenClaw agent
26. Verify: auto-update does NOT fire (OTA is disabled)
27. Verify: config can be changed via web config editor (POST /config)
28. Commit: "feat: working firmware on device, all tests pass"

## What We Need From James

- [ ] Confirm this 3-repo merge approach is correct
- [ ] Confirm we should start from v1.4.3 source (v1.4.4 .bin-only, no source available)
- [ ] Should we try to find v1.4.4 source, or is v1.4.3 close enough?
- [ ] Go-ahead to start Phase 1 (copy official firmware into our repo)

## Key Files (Where Things Will Live in Our Repo)

```
<repo-root>/stackchan-node/
├── firmware/                    # Official StackChan firmware (from Repo 1)
│   ├── main/                    # Stack-chan body code
│   ├── xiaozhi-esp32/            # Pulled by fetch_repos.py (v2.2.4)
│   ├── patches/
│   │   └── xiaozhi-esp32.patch   # circlemouth's patch (from Repo 2)
│   ├── sdkconfig.defaults        # Our config (OTA disabled)
│   ├── repos.json                # Dependencies + patch config
│   └── CMakeLists.txt            # Build system
├── ai-server/                    # TypeScript bridge (from Repo 2)
│   ├── src/
│   │   ├── openclaw.ts           # OpenClaw Gateway client (from Repo 2)
│   │   ├── hermes.ts             # HermesAgent client (from Repo 2)
│   │   └── server.ts             # WebSocket server for firmware
│   └── package.json
├── firmware-extras/              # Plaipin's contributions (from Repo 3, ported to ESP-IDF)
│   ├── OpenClawClient.cpp        # HTTP client → Gateway
│   ├── StackchanExConfig.h        # Config structs (agent binding, backend selector)
│   └── web_config_endpoints.cpp   # GET/POST /config
├── test-harness/                  # Existing test harness (already in our repo)
│   ├── web-config.html            # Browser config editor
│   ├── e2e_test_harness.py        # End-to-end tests
│   └── test_agent_binding.py      # Agent binding tests
├── research/                      # Analysis docs (already in our repo)
├── README.md                      # Our brief
├── BUILD_PLAN.md                  # Architecture doc
├── TODO.md                        # Task tracking
└── backups/                       # Firmware backups
```