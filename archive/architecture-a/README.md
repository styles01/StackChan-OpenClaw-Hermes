# StackChan-OpenClaw-Hermes

> **The open-source reference firmware for making M5Stack Stack-chan a first-class node of your AI agent — OpenClaw or Hermes.**

[![ESP-IDF](https://img.shields.io/badge/ESP--IDF-5.5.4-red)](https://docs.espressif.com/projects/esp-idf/)
[![Board](https://img.shields.io/badge/board-M5Stack%20CoreS3-blue)](https://shop.m5stack.com/products/stack-chan)
[![License](https://img.shields.io/badge/license-TBD-lightgrey)](LICENSE)
[![Status](https://img.shields.io/badge/status-Phase%201%20builds-yellow)](#status)

---

## What This Is

Custom ESP-IDF firmware that turns the M5Stack Stack-chan robot into a **native node** of [OpenClaw](https://github.com/openclaw/openclaw) and/or [Hermes agent](https://github.com/nicoborghi/hermes). No proxies, no middlemen, no cloud brokers — the robot connects directly to your agent over WebSocket + WebRTC.

**This is the firmware people on Reddit keep asking for.** Every Stack-chan owner who wants to hook it up to their AI agent has the same problem: the existing solutions all require a middleman server (Node.js proxy, Python MCP server, Python bridge, cloud broker). We're building the thing that just works — natively.

## Why This Exists

The Stack-chan community wants AI agent integration. We analyzed every existing approach:

| Solution | Problem |
|----------|---------|
| [PlaiPin/plaipin-openclaw-stackchan](https://github.com/PlaiPin/plaipin-openclaw-stackchan) | Needs a Node.js proxy server running 24/7 |
| [migratorywhale/stackchan-mcp](https://github.com/migratorywhale/stackchan-mcp) | Needs a Python MCP server + HTTP REST |
| [waynecc-at/robot-bridge](https://github.com/waynecc-at/robot-bridge) | Needs a Python FastAPI bridge — closest to production, but still a middleman |
| [taranton/stackchan-gemini-firmware](https://github.com/taranton/stackchan-gemini-firmware) | Arduino/PlatformIO + Google Gemini Live — useful hardware patterns, wrong AI backend |
| [Reddit community efforts](https://www.reddit.com/r/StackChan/comments/1tey028/) | Modifying stock XiaoZhi firmware, hitting codec bugs |
| **StackChan-OpenClaw-Hermes (this project)** | **Native ESP-IDF, direct WebSocket+WebRTC, no proxy, dual-target** |

Full analyses in [`analysis/`](analysis/) — 6 reference repos + 1 community thread.

## Architecture

### Dual-Target Design

The firmware is architected to work with **either** OpenClaw **or** Hermes as the backend agent. The core firmware (audio capture/playback, wake word, face, servos) is backend-agnostic. Only the connection layer changes:

```
┌──────────────────────────────────────────┐
│  Stack-chan Hardware (M5Stack CoreS3)     │
│  ESP32-S3 + 8MB PSRAM                    │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │ Core Firmware (backend-agnostic)   │  │
│  │  WakeNet 9 wake word ("Hi ESP")    │  │
│  │  AW88298 speaker / ES7210 mic      │  │
│  │  ILI9342 320×240 display           │  │
│  │  SCSCL servos (yaw + pitch)        │  │
│  │  GC0308 camera                     │  │
│  │  Face state machine                │  │
│  └────────────────────────────────────┘  │
│  ┌────────────────────────────────────┐  │
│  │ Connection Layer (swappable)       │  │
│  │                                    │  │
│  │  Option A: OpenClaw Gateway        │  │
│  │    WebSocket → ws://gateway:18789  │  │
│  │    WebRTC audio (Opus 16kHz)       │  │
│  │    esp-openclaw-node core          │  │
│  │                                    │  │
│  │  Option B: Hermes Agent            │  │
│  │    WebSocket → ws://hermes:PORT    │  │
│  │    Audio bridge (16kHz PCM)        │  │
│  │    Hermes protocol adapter         │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
          │
          ▼
┌──────────────────────────────────────────┐
│  Your Agent (choose one)                  │
│                                          │
│  OpenClaw Gateway          Hermes Agent   │
│  - Rosie, Claude, etc.    - Local agent   │
│  - Tools, memory, TTS     - Custom logic  │
│  - Telegram, Notion, etc. - MCP tools      │
└──────────────────────────────────────────┘
```

### Why Dual-Target?

- **OpenClaw** gives you a full agent ecosystem: tools, memory, TTS, Telegram, Notion, household ops — everything. The robot becomes an extension of your existing agent.
- **Hermes** gives you a lightweight local agent with its own tool ecosystem. Some users prefer self-hosted simplicity.
- **Same firmware, different config.** The connection target is a build-time or runtime config option, not a fork.

### Architecture Inspiration

This dual-target design is directly inspired by two reference repos:

- [kkdev92/stackchan-atoms3r](https://github.com/kkdev92/stackchan-atoms3r) — **Best architecture reference.** Their core/platform separation pattern (`src/core` has zero ESP-IDF deps, `src/platform` implements hardware + connection) proves you can swap the backend without touching core firmware.
- [waynecc-at/robot-bridge](https://github.com/waynecc-at/robot-bridge) — **Best Hermes integration reference.** Production-deployed Stack-chan → Hermes bridge with 21 features, 11 MCP tools, multi-user face recognition, and a self-critique (REFACTOR-PLAN.md) that validates going native instead of using a bridge.

## Hardware

| Component | Chip | Notes |
|-----------|------|-------|
| MCU | ESP32-S3 | 16MB flash, 8MB PSRAM |
| Speaker Codec | AW88298 | I2S STD, 16kHz mono |
| Mic Codec | ES7210 | STD I2S stereo, MIC1+MIC3 (AEC) |
| Display | ILI9342 | 320×240 SPI, BGR color |
| Touch | FT6336 / Si12T | Capacitive (Phase 2) |
| Servos | SCSCL ×2 | UART1 GPIO6/7, yaw ±128° / pitch 5-85° |
| Camera | GC0308 | 320×240, RGB565→JPEG (Phase 2) |
| LEDs | WS2812C ×12 | Via PY32 IO expander (Phase 2) |
| Wake Word | ESP-SR WakeNet 9 | "Hi ESP" (wn9_hiesp) |

## Features

### Phase 1 — Core Bring-Up + Voice (current)
- [x] ESP-IDF v5.5.4 build environment
- [x] CoreS3 board port (audio, display, touch button)
- [x] Dual-OTA partitions (6MB each)
- [x] WakeNet 9 wake word support
- [x] Firmware builds successfully (`stackchan_node.bin`, 3.4MB)
- [ ] Flash to hardware (backup stock firmware first!)
- [ ] WebSocket connection to OpenClaw Gateway
- [ ] WebRTC Talk voice path (make-or-break test)
- [ ] Face + expression rendering

### Phase 2 — Robot Layer
- [ ] Servo control (SCSCL, gestures: nod/shake/look)
- [ ] Camera capture (GC0308, snapshot + vision)
- [ ] Touch sensor (head-pet as push-to-talk)
- [ ] LED control (status indicators, expressions)
- [ ] Full face animation system

### Phase 3 — Dual-Target + Release
- [ ] Hermes agent connection layer
- [ ] BLE/AP provisioning
- [ ] Configuration UI
- [ ] Documentation + release
- [ ] Open source publication

## Getting Started

### Prerequisites

- ESP-IDF v5.5.4
- M5Stack Stack-chan (CoreS3 version)
- USB-C data cable

### Build

```bash
# Set up ESP-IDF
export IDF_PATH=/path/to/esp-idf
export IDF_TOOLS_PATH=~/.espressif
. $IDF_PATH/export.sh

# Build
cd StackChan-OpenClaw-Hermes
idf.py set-target esp32s3
idf.py build
```

### Flash

**⚠️ CRITICAL: Back up stock firmware BEFORE flashing!**

```bash
# 1. Plug in Stack-chan via USB
# 2. Detect serial port (usually /dev/cu.usbmodem*)
# 3. Full 16MB backup (SAVE THIS FILE)
esptool.py --port /dev/cu.usbmodemXXXX read_flash 0 0x1000000 backup_stackchan_stock.bin

# 4. Save partition table
esptool.py --port /dev/cu.usbmodemXXXX read_flash 0x8000 0x1000 backup_partition_table.bin

# 5. ONLY NOW flash our firmware
idf.py -p /dev/cu.usbmodemXXXX flash
```

We have bricked devices before. **Always back up first.**

### Configure

The firmware needs to know where your agent is:

```bash
# OpenClaw Gateway (default)
idf.py menuconfig
# → StackChan Node → Connection Target → OpenClaw
# → StackChan Node → Gateway URL → ws://your-gateway:18789
# → StackChan Node → Gateway Token → your-token

# Hermes Agent
idf.py menuconfig
# → StackChan Node → Connection Target → Hermes
# → StackChan Node → Hermes URL → ws://your-hermes:PORT
```

## Project Structure

```
StackChan-OpenClaw-Hermes/
├── rosie-node/               # ESP-IDF firmware project
│   ├── CMakeLists.txt
│   ├── partitions.csv         # Dual-OTA + SPIFFS model partition
│   └── main/
│       ├── main.c            # Entry point
│       ├── idf_component.yml  # Dependencies
│       └── board_cores3/      # CoreS3 board port
│           ├── cores3_audio.c  # AW88298 + ES7210 STD I2S
│           ├── cores3_display.c # ILI9342 320×240
│           └── cores3_touch.c  # BOOT button (Phase 1)
├── analysis/                  # Reference repo analyses (6 repos + 1 community thread)
│   ├── plaipin-repo-analysis.md
│   ├── stackchan-mcp-repo-analysis.md
│   ├── stackchan-atoms3r-repo-analysis.md
│   ├── robot-bridge-repo-analysis.md
│   ├── stackchan-gemini-firmware-repo-analysis.md
│   └── reddit-openclaw-stackchan-thread.md
├── docs/
│   ├── BRIEF.md              # Project brief
│   ├── BUILD_PLAN.md         # Detailed build plan
│   ├── TODO.md               # Task checklist
│   └── CHANGELOG.md          # What's done
├── backups/                   # Stock firmware backups (gitignored)
└── README.md                  # This file
```

## Known Gotchas

1. **`esp_codec_dev_write()` may silently fail** — I2S format conflicts with duplex config on XiaoZhi-based firmware. If audio output is silent, bypass the codec and write PCM directly to `i2s_channel_write()`. Keep codec only for amp/volume. ([Source: Reddit community finding](analysis/reddit-openclaw-stackchan-thread.md))

2. **GC0308 camera shares I2C with system** — must release M5Unified's I2C before camera init. ([Source: stackchan-mcp repo](analysis/stackchan-mcp-repo-analysis.md))

3. **GC0308 pin mapping controversy** — stackchan-mcp and robot-bridge have **completely different** GPIO pin configs for the same camera on the same board. Two repos (stackchan-mcp + stackchan-gemini-firmware) agree on SDA=GPIO12/SCL=GPIO11; robot-bridge is the outlier. **Use GPIO12/GPIO11.** ([Source: robot-bridge analysis](analysis/robot-bridge-repo-analysis.md), [gemini-firmware analysis](analysis/stackchan-gemini-firmware-repo-analysis.md))

4. **ILI9342 needs BGR color correction** — RGB565 R/B channels are swapped. Formula: `color = ((c & 0x1F) << 11) | (c & 0x07E0) | (c >> 11)`.

5. **Mic quality is a known challenge** — ES7210 may need gain tuning. Plan for AGC early.

6. **Camera XCLK via LEDC causes audio choppy** — must use external 20MHz clock (XCLK=-1), not LEDC-generated. Third repo to confirm this. ([Source: gemini-firmware analysis](analysis/stackchan-gemini-firmware-repo-analysis.md))

7. **Servo angles use 0.1° units** — StackChan-BSP uses `deg * 10` for servo positioning.

8. **Reuse-first principle** — wrap proven Stack-chan libraries via Arduino-ESP32 component. Don't reinvent servo/camera/LED drivers that already work. Adversarial review should catch "should this code exist?" not just "are there bugs?"

## References

- [esp-openclaw-node](https://github.com/openclaw/esp-openclaw-node) — OpenClaw ESP32 node core
- [OpenClaw](https://github.com/openclaw/openclaw) — AI agent gateway
- [Hermes Agent](https://github.com/nicoborghi/hermes) — Local AI agent
- [M5Stack Stack-chan](https://shop.m5stack.com/products/stack-chan) — Hardware
- [StackChan-BSP](https://github.com/meganetaaan/stack-chan) — Board support package
- [migratorywhale/stackchan-mcp](https://github.com/migratorywhale/stackchan-mcp) — Best hardware reference
- [kkdev92/stackchan-atoms3r](https://github.com/kkdev92/stackchan-atoms3r) — Best architecture reference
- [waynecc-at/robot-bridge](https://github.com/waynecc-at/robot-bridge) — Best Hermes integration reference (production-deployed)

## Status

**Phase 1 — Core Bring-Up:** Firmware builds, not yet flashed to hardware. The next milestone is the Talk voice path test — connect to the OpenClaw Gateway, speak through the robot, hear the response. That's the make-or-break moment.

## License

TBD — will be open source on release.

## Acknowledgments

- [meganetaaan](https://github.com/meganetaaan) — Stack-chan creator
- [migratorywhale](https://github.com/migratorywhale) — stackchan-mcp hardware reference
- [kkdev92](https://github.com/kkdev92) — stackchan-atoms3r architecture reference
- [waynecc-at](https://github.com/waynecc-at) — robot-bridge Hermes integration reference (production-deployed)
- [taranton](https://github.com/taranton) — stackchan-gemini-firmware CoreS3 hardware patterns
- [PlaiPin](https://github.com/PlaiPin) — plaipin-openclaw-stackchan concept validation
- The r/StackChan community — for proving people want this