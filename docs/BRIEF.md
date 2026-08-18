# Project Brief — StackChan-OpenClaw-Hermes

## Vision

**The open-source reference firmware for making M5Stack Stack-chan a first-class node of your AI agent.**

No proxies. No middlemen. No cloud brokers. The robot connects directly to your agent — OpenClaw or Hermes — over WebSocket + WebRTC. This is the firmware the Stack-chan community keeps asking for.

## Problem

Every existing Stack-chan + AI agent solution has a fatal flaw:

1. **PlaiPin/plaipin-openclaw-stackchan** (2 stars) — requires a Node.js proxy server running 24/7 as a middleman between the robot and the OpenClaw Gateway. Adds latency, adds a failure point, adds a dependency.

2. **migratorywhale/stackchan-mcp** (55 stars) — requires a Python MCP server translating tool calls into HTTP REST requests to the robot. Clean code, but the architecture adds a whole server layer that shouldn't need to exist.

3. **waynecc-at/robot-bridge** — the closest to production (21 features, 11 E2E tests, actually deployed), but still uses a Python FastAPI bridge as a middleman. Their own REFACTOR-PLAN.md admits the bridge is "too thick" and should be thinner. We eliminate the bridge entirely.

4. **taranton/stackchan-gemini-firmware** — solid CoreS3 hardware work (GC0308 pin config, servo gestures, emotion states, SD-backed provisioning) but locked to Google Gemini Live API. Useful hardware patterns, not reusable AI backend.

5. **Reddit community efforts** — people modifying the stock XiaoZhi firmware, hitting `esp_codec_dev_write()` silent failures, fighting mic quality issues, and posting "is there a GitHub link?" when they get stuck.

**Nobody has shipped a clean, native, no-proxy solution.** That's the gap we fill.

## Solution

**StackChan-OpenClaw-Hermes** — native ESP-IDF firmware that connects directly to your agent:

- **Direct WebSocket** to the OpenClaw Gateway (or Hermes agent) — no proxy server
- **WebRTC audio** for the Talk voice path — Opus 16kHz, sub-100ms latency
- **ESP-SR WakeNet 9** wake word — hands-free, on-device, no cloud
- **Dual-OTA partitions** — firmware updates without bricking risk
- **Proper CoreS3 board support** — AW88298 speaker, ES7210 mic with AEC, ILI9342 display, SCSCL servos, GC0308 camera
- **Dual-target architecture** — same firmware works with OpenClaw OR Hermes by swapping the connection layer

## Dual-Target Architecture

The core firmware (audio, wake word, face, servos, camera) is **backend-agnostic**. Only the connection layer changes:

### Option A: OpenClaw Gateway
- WebSocket → `ws://gateway:18789`
- WebRTC audio (Opus 16kHz)
- Uses `esp-openclaw-node` core components
- Agent has tools, memory, TTS, Telegram, Notion — full ecosystem
- Robot becomes a physical extension of your existing agent

### Option B: Hermes Agent
- WebSocket → `ws://hermes:PORT`
- Audio bridge (16kHz PCM)
- Uses Hermes protocol adapter
- Lightweight local agent with MCP tools
- Robot is a standalone node

**Same firmware. Different config. Not a fork.**

This is inspired by two reference repos:
- [kkdev92/stackchan-atoms3r](https://github.com/kkdev92/stackchan-atoms3r) — core/platform separation pattern that enables swapping the backend without touching core firmware
- [waynecc-at/robot-bridge](https://github.com/waynecc-at/robot-bridge) — production-deployed Hermes integration that proves the tool set and conversation flow work in practice

## Hardware Target

**M5Stack Stack-chan (CoreS3)** — the most popular Stack-chan variant:

| Component | Chip | Why It Matters |
|-----------|------|----------------|
| MCU | ESP32-S3 | 16MB flash, 8MB PSRAM — enough for dual-OTA + wake word models |
| Speaker | AW88298 | I2S STD — ⚠️ `esp_codec_dev_write()` may silently fail, bypass to `i2s_channel_write()` |
| Mic | ES7210 | STD I2S stereo, MIC1+MIC3 for AEC — enables full-duplex (others are half-duplex) |
| Display | ILI9342 | 320×240 SPI, needs BGR color correction |
| Servos | SCSCL ×2 | UART1, yaw ±128° / pitch 5-85°, BSP uses 0.1° units |
| Camera | GC0308 | 320×240, RGB565→JPEG (no hardware JPEG), shares I2C with system — ⚠️ pin mapping controversy between reference repos |
| Touch | FT6336/Si12T | Head-pet as push-to-talk fallback |
| Wake Word | ESP-SR WakeNet 9 | "Hi ESP" (wn9_hiesp), 284KB, on-device |

## Reference Repos Analyzed

| Repo | Stars | Usefulness | Key Takeaway |
|------|-------|-----------|--------------|
| [migratorywhale/stackchan-mcp](https://github.com/migratorywhale/stackchan-mcp) | 55 | ⭐⭐⭐⭐ | Best hardware reference — GC0308 pins, servo patterns, BGR correction, audio gate |
| [kkdev92/stackchan-atoms3r](https://github.com/kkdev92/stackchan-atoms3r) | — | ⭐⭐⭐⭐ | Best architecture reference — core/platform separation, port abstractions, host tests |
| [waynecc-at/robot-bridge](https://github.com/waynecc-at/robot-bridge) | — | ⭐⭐⭐⭐⭐ | Best Hermes integration reference — production-deployed, 11 MCP tools, 21 features, validates our native approach |
| [PlaiPin/plaipin-openclaw-stackchan](https://github.com/PlaiPin/plaipin-openclaw-stackchan) | 2 | ⭐⭐ | Concept validation — coredump partition, emoji stripping |
| [taranton/stackchan-gemini-firmware](https://github.com/taranton/stackchan-gemini-firmware) | — | ⭐⭐⭐ | CoreS3 hardware patterns — GC0308 pin confirmation, XCLK/LEDC audio gotcha, servo gestures, emotion states, SD provisioning |
| [Reddit r/StackChan](https://www.reddit.com/r/StackChan/comments/1tey028/) | — | ⭐⭐⭐ | Real-world findings — codec write bug, mic quality issues, community demand |

Full analyses in [`analysis/`](analysis/) — 6 reference repos + 1 community thread.

## Build Phases

### Phase 1 — Core Bring-Up + Voice Verification (current)
- ESP-IDF v5.5.4 build environment ✅
- CoreS3 board port (audio, display, touch) ✅
- Dual-OTA partitions ✅
- WakeNet 9 wake word ✅
- Firmware builds (3.4MB, 46% free) ✅
- **Flash to hardware + Talk voice test** ← WE ARE HERE
- Face + expression rendering

### Phase 2 — Robot Layer (reuse-first: wrap proven Stack-chan libraries via Arduino-ESP32 component)
- Servo control + gestures → wrap `M5StackChan.Motion` BSP (from stackchan-mcp)
- Camera capture → adapt `esp_camera` init + I2C release pattern (from stackchan-mcp)
- Touch sensor (head-pet push-to-talk)
- LED control + emotion states → adapt gemini-firmware's 10-mode state machine
- Full face animation system (v2 — port StackChan avatar)

### Phase 3 — Dual-Target + Release
- Hermes agent connection layer
- BLE/AP provisioning
- Configuration UI
- Documentation
- Open source publication

## Design Principle: Reuse First

**Reuse proven code from reference repos unless we have a specific architectural reason to rewrite.** The Stack-chan community has already solved servo control, camera init, LED emotion states, and face rendering on CoreS3. We wrap their proven implementations, not reinvent them.

**Architecture decision: Add Arduino-ESP32 as an ESP-IDF managed component.**

- stackchan-mcp and plaipin are Arduino/PlatformIO projects using `M5StackChan.Motion`, `M5Unified`, `StackChan-BSP`, `esp_camera`
- Arduino-ESP32 v3.3.6 is built on ESP-IDF v5.5.2 (matches our v5.5.4) and is officially supported as an ESP-IDF component
- Adding it gives us direct access to all proven Stack-chan libraries without porting
- This is the fastest path to working hardware with minimum reinvention
- We can always strip the Arduino dependency later if binary size becomes an issue

**What we reuse directly (thin wrappers, not rewrites):**
- Servo control → `M5StackChan.Motion` BSP (proven on CoreS3 by stackchan-mcp)
- Camera → `esp_camera` + stackchan-mcp's init/I2C-release pattern
- LED/Emotion → stackchan-gemini-firmware's 10-mode emotion state machine pattern
- Face → room-node built-in procedural face for v1 (already wired to Talk state)

**What we legitimately write ourselves:**
- Audio board port → room-node contract is ESP-IDF, AW88298/ES7210 codecs are CoreS3-specific (Waveshare reference uses different chips)
- Display board port → room-node contract is ESP-IDF, ILI9342 SPI is CoreS3-specific
- Connection layer → our dual-target OpenClaw/Hermes architecture is novel
- Services hooks → `prepare_runtime`, `register_commands` are our custom robot commands

## Non-Goals

- NOT building a cloud broker
- NOT building a proxy server
- NOT building a Python bridge (robot-bridge already did that — we're going native)
- NOT modifying stock XiaoZhi firmware
- NOT reinventing servo/camera/LED drivers that already work (reuse them)
- NOT a closed-source project — this goes open source

## Success Criteria

1. **Talk voice path works** — say "Hi ESP", speak to the robot, hear the agent's voice response through the speaker. Sub-500ms latency. This is the make-or-break test.

2. **Dual-target works** — same firmware binary connects to OpenClaw Gateway or Hermes agent with only a config change. No recompilation.

3. **Community adoption** — people on r/StackChan link to our repo instead of asking "is there a GitHub link?"

4. **No bricking** — dual-OTA means failed updates are recoverable. Stock firmware is backed up before first flash.

## Hard Rules

1. **NO GATEWAY RESTARTS WITHOUT ASKING** — James's explicit rule. Gateway restarts disrupt running sessions.
2. **Backup stock firmware BEFORE flashing** — we have bricked devices before. Full 16MB dump via esptool first.
3. **No LAN Only Mode for any printer solution** — separate rule, not relevant here, but don't forget it.

## Team

- **James** — project lead, hardware owner, firmware testing
- **Rosie** — firmware development, research, documentation, git wrangling