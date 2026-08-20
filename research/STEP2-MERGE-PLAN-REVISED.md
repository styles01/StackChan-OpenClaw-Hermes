# STEP 2 — Merge Plan (REVISED after adversarial review)

**Date:** 2026-08-19
**Revised:** 2026-08-19 (addresses all 3 blockers + 7 non-blocking issues from STEP3-ADVERSARIAL-REVIEW.md)
**Goal:** Merge official StackChan firmware + circlemouth/Hermes-StackChan + plaipin-openclaw-stackchan into OUR repo (`styles01/StackChan-OpenClaw-Hermes`)

## Architecture Decision (supersedes BUILD_PLAN.md v1)

**The old BUILD_PLAN.md v1 swap-backends architecture is DEAD.** The FastAPI mini server (ports 18791/18790/18789), `audio_pipeline.py`, MiniSTT/MiniTTS/BodyCommandParser — all abandoned. The device is a thin audio client (confirmed by STEP1-FIRMWARE-CODE-PATH): it streams OPUS over WebSocket to a server that does STT→LLM→TTS. We use circlemouth's ai-server (TypeScript, WS port 8765) as the server, not the old FastAPI design.

**Why:** The old plan assumed device-side STT/TTS seams (`STTBase`/`TTSBase`/`Whisper.cpp`) — those are plaipin Arduino constructs that don't exist in the ESP-IDF firmware. The official firmware has no such hooks. The correct architecture is: device streams audio → ai-server does STT/LLM/TTS → streams audio back. This is what circlemouth already built and tested (68/68 tests pass).

## Source Repos

| # | Repo | Path | What We Take |
|---|------|------|-------------|
| 1 | `m5stack/StackChan` (official) | `repos/StackChan/firmware/` | Clean tracked source only (no build/managed_components/xiaozhi-esp32). CMakeLists, main/, patches/, repos.json, sdkconfig.defaults, partitions.csv, tests/. |
| 2 | `circlemouth/Hermes-StackChan` | `repos/working-repos/Hermes-StackChan/` | `patches/xiaozhi-esp32.patch` (canonical, replaces official patch), `ai-server/` (full TypeScript bridge), `sdkconfig.defaults` (audio config flags) |
| 3 | `plaipin-openclaw-stackchan` | `repos/plaipin-openclaw-stackchan/` | Config struct shapes (`StackchanExConfig.h`), web config endpoint pattern, `stripEmoji()` utility. **NOT** OpenClawClient.cpp (dead code under thin-client arch). **NOT** the Arduino build system. |

## Blocker Fixes (from STEP3-ADVERSARIAL-REVIEW)

### Blocker 1: Patch Collision → Use circlemouth as canonical

**Problem:** Official firmware has a 273-line `xiaozhi-esp32.patch` applied by `fetch_repos.py`. Circlemouth has an 1188-line patch. Both target the same 5 files. Applying both = conflict.

**Fix:** circlemouth's patch is our SINGLE canonical patch. We do NOT use the official patch. Instead:
1. Copy official firmware clean source (excluding its `patches/xiaozhi-esp32.patch`)
2. Copy circlemouth's `patches/xiaozhi-esp32.patch` as our only patch
3. Update `repos.json` to apply circlemouth's patch (it already references the same v2.2.4)
4. Hand-port the 3 official-only changes that the working Aug-18 build needs:
   - Backlight config
   - i2c `TryReadRegs` fix
   - Assets/emote strategy changes
5. Verify these 3 changes are not already in circlemouth's patch (they may overlap — check each)
6. Build → verify binary boots on CoreS3

### Blocker 2: First-Boot OTA Hole → Unconditional skip

**Problem:** circlemouth's "skip OTA when local WS configured" guard is conditional on NVS config existing. First boot = no config = guard false = device phones home and auto-updates.

**Fix:** Make OTA skip **unconditional** in our fork:
1. In `application.cc` (via our patch), comment out or remove the `ota_->CheckVersion()` call entirely — not conditional on config
2. Set `CONFIG_OTA_URL=""` in `sdkconfig.defaults` (empty string, not the tenclass URL)
3. Verify: `grep -r "CheckVersion" firmware/` shows it's gone or commented

### Blocker 3: Backend Binding Off-Device → Per-device in ai-server

**Problem:** circlemouth's `STACKCHAN_BACKEND` is a global env var — one ai-server = one backend. Violates the brief's per-robot binding requirement.

**Fix:** ai-server does **per-device** binding:
1. ai-server reads `Device-Id` (MAC) from the WebSocket hello handshake
2. Looks up device → backend+agent mapping from a config file (`devices.json` or similar)
3. Routes to OpenClaw (`openclaw.ts`) or Hermes (`hermes.ts`) per-device
4. Device-side config (`StackchanExConfig.h` struct, ported to NVS) stores the backend selector + agent_id
5. ai-server can also read the binding from the device's hello message (device sends its configured backend+agent_id in the WS handshake)
6. Web config editor on the device edits the NVS config → device sends it in WS hello → ai-server routes accordingly
7. This satisfies: "configured via BLE provisioning or web config editor — no reflashing needed"

## Non-Blocking Fixes (all addressed)

| # | Issue | Fix |
|---|-------|-----|
| 4 | Clean source copy | Copy tracked source only; exclude build/, managed_components/, xiaozhi-esp32/, sdkconfig. Update .gitignore to track firmware/ source files. |
| 5 | Declare mini server dead | This plan explicitly supersedes BUILD_PLAN.md v1. Step 8 updates BUILD_PLAN.md with "SUPERSEDED" header. |
| 6 | Redundant OpenClaw client | Drop firmware-side `OpenClawClient.cpp`. Thin-client device only talks to ai-server over WS. ai-server's `openclaw.ts` is the single OpenClaw path. |
| 7 | STT/TTS for ai-server | ai-server uses its existing STT/TTS (circlemouth already has working Opus decode/encode + STT + TTS). We use what circlemouth built. If we need faster-whisper/Kokoro later, that's a v2 enhancement. |
| 8 | Device config provisioning | Device gets WS URL via: (a) BLE provisioning (already in official firmware via esp-wifi-connect), or (b) web config editor (plaipin pattern, ported to NVS). The WS URL points to `ws://<ai-server-host>:8765/ws`. |
| 9 | End-to-end test through WS path | Step 5 includes a test script that: starts ai-server → flashes device → verifies device connects to ai-server → sends audio → gets response. Re-run ai-server's 68 tests in our repo. |
| 10 | Body-command markers + MCP tools | ai-server's `device_control.ts` already has 13 MCP tools (camera, servos, LED). These get registered in the OpenClaw agent config so the agent can drive the robot. Body-command markers (`[expression:happy]`) carry through LLM output → ai-server parses → sends to device. |

## Execution Phases

### Phase 1: Establish Baseline (official firmware, clean, OTA dead)

1. Copy official firmware clean tracked source into our repo `firmware/`:
   - `CMakeLists.txt`, `main/`, `repos.json`, `fetch_repos.py`, `sdkconfig.defaults`, `partitions.csv`, `tests/`
   - Exclude: `build/`, `managed_components/`, `xiaozhi-esp32/`, `sdkconfig`, `dependencies.lock`
2. Remove official `patches/xiaozhi-esp32.patch` (we use circlemouth's)
3. Set `CONFIG_OTA_URL=""` in `sdkconfig.defaults`
4. Update `.gitignore` to track `firmware/` source files (currently ignores `firmware/`)
5. Verify `idf.py build` works with clean source + `fetch_repos.py`
6. Commit: "feat: establish v1.4.3 baseline firmware (clean source, OTA disabled)"

### Phase 2: Merge circlemouth (canonical patch + ai-server)

7. Copy circlemouth's `patches/xiaozhi-esp32.patch` into `firmware/patches/`
8. Copy circlemouth's `ai-server/` into our repo `ai-server/`
9. Copy circlemouth's `sdkconfig.defaults` audio config flags (CONFIG_USE_SERVER_AEC, CONFIG_USE_AFE_WAKE_WORD, CONFIG_USE_AUDIO_PROCESSOR) — merge into our sdkconfig.defaults
10. Patch `application.cc` in our patch to make OTA skip **unconditional** (remove `CheckVersion()` call, not conditional)
11. Hand-port the 3 official-only changes (backlight, i2c TryReadRegs, assets) — check if circlemouth's patch already includes them; if not, add to our patch
12. Run `idf.py build` — verify clean build with circlemouth's patch
13. Run ai-server tests: `cd ai-server && npm test` (expect 68/68)
14. Commit: "feat: merge circlemouth WS bridge + ai-server, OTA unconditionally disabled"

### Phase 3: Port plaipin config + web endpoints (to ESP-IDF/NVS)

15. Port `StackchanExConfig.h` config struct shape to ESP-IDF:
    - `openclaw_s {host, port, agent_id, bot_token, default_model}`
    - `backend` selector (0=OpenClaw, 1=Hermes)
    - Persist to **NVS** (not SPIFFS — official firmware uses NVS)
16. Port `/config` web endpoints (GET/POST config as JSON) to ESP-IDF `esp_http_server`
17. Port `stripEmoji()` utility (simple C++ function, no build system dependency)
18. Copy `test-harness/web-config.html` (already exists in our repo, verify it works with new endpoints)
19. Drop `OpenClawClient.cpp` — dead code under thin-client architecture
20. Build + verify config endpoints work
21. Commit: "feat: merge plaipin config structs + web config (NVS, ESP-IDF)"

### Phase 4: Per-device backend binding in ai-server

22. Add `devices.json` config to ai-server: `{ "device_id": { "backend": "openclaw|hermes", "agent_id": "agent-a" } }`
23. ai-server reads `Device-Id` from WebSocket hello handshake
24. ai-server looks up device → backend+agent, routes to `openclaw.ts` or `hermes.ts` per-device
25. Device sends configured `backend` + `agent_id` in WS hello (from NVS config set in Phase 3)
26. ai-server constructs session key: `agent:<agent_id>:stackchan:<device_id>`
27. Verify: two simulated devices with different backends route correctly
28. Commit: "feat: per-device backend binding in ai-server"

### Phase 5: Build + Flash + Test

29. Backup current device firmware (16MB dump) — MANDATORY
30. `idf.py build` — final firmware binary
31. `idf.py flash` — flash to device
32. Start ai-server: `cd ai-server && npm start`
33. Verify device boots, connects to ai-server over WS
34. Verify: device sends audio → ai-server does STT → LLM → TTS → device plays audio
35. Verify: auto-update does NOT fire (OTA unconditionally disabled)
36. Verify: config can be changed via web config editor (POST /config → NVS → reboot → new WS URL)
37. Verify: agent can drive robot (MCP tools: set expression, move head, LED)
38. Run ai-server 68 tests in our repo
39. Write end-to-end test script: `test-harness/test_ws_e2e.py`
40. Commit: "feat: working firmware on device, all tests pass"

## What We Need From James (Step 4 — Signoff)

- [ ] Confirm this revised plan addresses all concerns
- [ ] Go-ahead to start Phase 1

## File Layout (Our Repo After Merge)

```
<repo-root>/stackchan-node/
├── firmware/                        # Official StackChan firmware (clean source)
│   ├── main/                        # Stack-chan body code
│   ├── patches/
│   │   └── xiaozhi-esp32.patch      # circlemouth's patch (canonical) + our hand-ports
│   ├── sdkconfig.defaults           # OTA URL empty, audio config flags
│   ├── repos.json                   # Dependencies (v2.2.4 + patch)
│   ├── fetch_repos.py               # Dependency fetcher
│   ├── CMakeLists.txt               # Build system
│   ├── partitions.csv               # Flash layout
│   └── tests/                       # Host-side tests
├── ai-server/                       # circlemouth's TypeScript bridge
│   ├── src/
│   │   ├── openclaw.ts              # OpenClaw Gateway client
│   │   ├── hermes.ts                # HermesAgent client
│   │   ├── server.ts                # WebSocket server for firmware
│   │   └── device_control.ts        # MCP tools (13 robot control tools)
│   ├── devices.json                 # Per-device backend+agent binding
│   ├── package.json
│   └── tests/                       # 68 unit tests
├── firmware-extras/                 # Plaipin contributions (ported to ESP-IDF)
│   ├── stackchan_ex_config.h        # Config structs (openclaw_s, hermes_s, backend)
│   ├── web_config_endpoints.cpp     # GET/POST /config (NVS-based)
│   └── strip_emoji.cpp              # Emoji stripping for TTS
├── test-harness/                    # Test harnesses
│   ├── web-config.html              # Browser config editor
│   ├── test_agent_binding.py        # Agent binding tests (existing)
│   ├── e2e_test_harness.py           # End-to-end tests (existing)
│   └── test_ws_e2e.py               # NEW: WS path end-to-end test
├── research/                        # Analysis docs
├── README.md                        # Updated to ai-server WS architecture
├── BUILD_PLAN.md                    # Marked SUPERSEDED, points to this plan
├── TODO.md                          # Updated with phase status
├── CHANGELOG.md                     # New entry for this iteration
└── backups/                         # Firmware backups
```