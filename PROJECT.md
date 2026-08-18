# Stack-chan → Rosie Node

## Overview
Convert the M5Stack Stack-chan robot (ESP32-S3, CoreS3) from its default xiaozhi cloud chatbot into a real OpenClaw node — a physical extension of Rosie, the Aita household operations director.

## Vision
Stack-chan becomes Rosie's body in the physical world:
- **Wake word:** "Hey Rosie" (custom ESP-SR/WakeNet model)
- **Brain:** OpenClaw Gateway (Rosie's personality, tools, household context)
- **Voice:** WebRTC audio pipeline through the Gateway (STT → Rosie LLM → TTS)
- **Face:** LVGL avatar with emotions mapped to Rosie's state
- **Body:** Servo head tracking, camera vision, touch sensors
- **Tools:** Household status, 3D printer, fridge dashboard, memory, Telegram

## Architecture

```
┌─────────────────────────────────────┐
│  Stack-chan Hardware (CoreS3)       │
│  ESP32-S3 + PSRAM                   │
│  ┌───────────────────────────────┐  │
│  │ esp-openclaw-node core        │  │
│  │  WebSocket → OpenClaw Gateway │  │
│  │  WebRTC audio (Opus 16kHz)    │  │
│  │  WakeNet 9 wake word          │  │
│  │  BLE/AP provisioning          │  │
│  └───────────────────────────────┘  │
│  ┌───────────────────────────────┐  │
│  │ CoreS3 Board Port             │  │
│  │  AW88298 speaker / ES7210 mic │  │
│  │  ILI9342 display / AXP2101    │  │
│  │  FT6336 touch                 │  │
│  └───────────────────────────────┘  │
│  ┌───────────────────────────────┐  │
│  │ Robot Layer (from StackChan)  │  │
│  │  SCSCL servos (yaw + pitch)   │  │
│  │  LVGL face/avatar + emotions  │  │
│  │  GC0308 camera                │  │
│  │  BMI270 IMU / Si12T touch     │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
          │ WebSocket (ws://gateway:19001)
          ▼
┌─────────────────────────────────────┐
│  OpenClaw Gateway (Clawdio-Mini)    │
│  ┌───────────────────────────────┐  │
│  │ Rosie Agent                   │  │
│  │  System prompt: Rosie persona │  │
│  │  Tools: household, printer,   │  │
│  │  fridge, memory, Telegram     │  │
│  │  Voice: en-GB-LibbyNeural     │  │
│  └───────────────────────────────┘  │
│  ┌───────────────────────────────┐  │
│  │ Audio Pipeline                │  │
│  │  STT (Whisper) → LLM → TTS   │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

## Source Repos
| Repo | Path | Role |
|------|------|------|
| `openclaw/esp-openclaw-node` | `repos/esp-openclaw-node/` | Core firmware — steal verbatim |
| `m5stack/StackChan` | `firmware/StackChan/` | Robot layer — servo/face/camera/sensor drivers |
| `78/xiaozhi-esp32` | `firmware/xiaozhi-esp32/` | Reference — what we're replacing |
| `tnm/zclaw` | `repos/zclaw/` | Pattern reference — agent loop, provisioning |

## Analysis Reports
- `analysis/zclaw-analysis.md` — zclaw technical analysis
- `analysis/esp-openclaw-node-analysis.md` — esp-openclaw-node technical analysis
- `analysis/xiaozhi-firmware-analysis.md` — xiaozhi-esp32 firmware analysis
- `analysis/stackchan-firmware-analysis.md` — StackChan firmware analysis

## Build Phases
See [BUILD_PLAN.md](./BUILD_PLAN.md) for detailed build plan.

1. **Core bring-up** — esp-openclaw-node on CoreS3, Gateway connection, first voice test
2. **Robot layer** — servos, LVGL face, camera, sensors
3. **Wake word** — "Hey Rosie" ESP-SR model
4. **Gateway config** — Rosie personality + household tools
5. **Polish** — end-to-end testing and calibration

## Hardware
- **Device:** M5Stack Stack-chan (2025 Kickstarter edition)
- **MCU:** ESP32-S3 with PSRAM
- **Display:** ILI9342 320x240 LCD
- **Audio:** AW88298 speaker codec, ES7210 mic
- **Servos:** 2× SCSCL serial-bus servos (head yaw + pitch)
- **Camera:** GC0308 (optional vision)
- **Sensors:** BMI270 IMU, Si12T head touch, PCF8563 RTC
- **Power:** AXP2101 PMIC + battery

## Build Environment
- **ESP-IDF:** v5.5.4+ (v5.5.5 preferred)
- **Host:** Clawdio-Mini (macOS arm64) or James's laptop
- **Storage:** 1TB SSD (`/Volumes/1TBSSDClawd/stackchan-node/`)
- **Symlink:** `~/openclaw-workspaces/rosie/stackchan-node/` → SSD