# StackChan-OpenClaw-Hermes

## Overview
Custom ESP-IDF firmware that turns the M5Stack Stack-chan robot (ESP32-S3, CoreS3) into a native node for OpenClaw and/or Hermes agent — no proxies, no middlemen, no cloud brokers.

## Vision
Stack-chan becomes a first-class AI agent node:
- **Wake word:** ESP-SR WakeNet 9 ("Hi ESP", custom "Hey Rosie" as parallel track)
- **Brain:** OpenClaw Gateway OR Hermes Agent (dual-target, config-time switch)
- **Voice:** WebRTC audio pipeline (Opus 16kHz) through the Gateway
- **Face:** LVGL avatar with emotions mapped to conversation state
- **Body:** Servo head tracking, camera vision, touch sensors
- **Tools:** Full agent ecosystem — household ops, memory, Telegram, Notion, MCP tools

## Architecture

```
┌──────────────────────────────────────────┐
│  Stack-chan Hardware (M5Stack CoreS3)     │
│  ESP32-S3 + 8MB PSRAM                    │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │ Core Firmware (backend-agnostic)   │  │
│  │  WakeNet 9 wake word               │  │
│  │  AW88298 speaker / ES7210 mic      │  │
│  │  ILI9342 320×240 display           │  │
│  │  SCSCL servos (yaw + pitch)        │  │
│  │  GC0308 camera                     │  │
│  └────────────────────────────────────┘  │
│  ┌────────────────────────────────────┐  │
│  │ Connection Layer (swappable)       │  │
│  │  Option A: OpenClaw Gateway :18789 │  │
│  │  Option B: Hermes Agent :PORT      │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
          │
          ▼
┌──────────────────────────────────────────┐
│  Your Agent (choose one)                  │
│  OpenClaw Gateway       Hermes Agent      │
│  - Rosie, Claude, etc.  - Local agent     │
│  - Tools, memory, TTS    - MCP tools      │
│  - Telegram, Notion     - Custom logic    │
└──────────────────────────────────────────┘
```

## Source Repos
| Repo | Path | Role |
|------|------|------|
| `openclaw/esp-openclaw-node` | `repos/esp-openclaw-node/` | Core firmware — steal verbatim |
| `m5stack/StackChan` | `firmware/StackChan/` | Robot layer — servo/face/camera/sensor drivers |
| `78/xiaozhi-esp32` | `firmware/xiaozhi-esp32/` | Reference — what we're replacing |

## Analysis Reports (6 reference repos + 1 community thread)
- `analysis/zclaw-analysis.md` — zclaw technical analysis
- `analysis/esp-openclaw-node-analysis.md` — esp-openclaw-node technical analysis
- `analysis/xiaozhi-firmware-analysis.md` — xiaozhi-esp32 firmware analysis
- `analysis/stackchan-firmware-analysis.md` — StackChan firmware analysis
- `analysis/plaipin-repo-analysis.md` — PlaiPin REST proxy analysis
- `analysis/stackchan-mcp-repo-analysis.md` — Best hardware reference (CoreS3)
- `analysis/stackchan-atoms3r-repo-analysis.md` — Best architecture reference (core/platform separation)
- `analysis/robot-bridge-repo-analysis.md` — Best Hermes integration reference (production-deployed)
- `analysis/stackchan-gemini-firmware-repo-analysis.md` — CoreS3 hardware patterns + GC0308 pin confirmation
- `analysis/reddit-openclaw-stackchan-thread.md` — Real-world community findings
- `analysis/adversarial-review.md` — Adversarial review of all claims

## Build Phases
See [BUILD_PLAN.md](./BUILD_PLAN.md) for detailed build plan.

1. **Core bring-up** — esp-openclaw-node on CoreS3, Gateway connection, first voice test
2. **Robot layer** — servos, LVGL face, camera, sensors
3. **Wake word** — stock WakeNet model now, "Hey Rosie" as parallel track
4. **Gateway config** — agent personality + household tools
5. **Polish** — end-to-end testing and calibration

## Hardware
- **Device:** M5Stack Stack-chan (CoreS3 version)
- **MCU:** ESP32-S3 with 16MB flash, 8MB PSRAM
- **Display:** ILI9342 320×240 LCD
- **Audio:** AW88298 speaker codec, ES7210 mic (TDM I2S, AEC)
- **Servos:** 2× SCSCL serial-bus servos (head yaw + pitch)
- **Camera:** GC0308 (optional vision)
- **Sensors:** BMI270 IMU, Si12T head touch, FT6336 capacitive touch
- **Power:** AXP2101 PMIC + battery

## Build Environment
- **ESP-IDF:** v5.5.4
- **Host:** Clawdio-Mini (macOS arm64)
- **Storage:** 1TB SSD (`/Volumes/1TBSSDClawd/stackchan-node/`)
- **Symlink:** `~/openclaw-workspaces/rosie/stackchan-node/` → SSD