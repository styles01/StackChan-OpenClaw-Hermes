# Stack-chan → Rosie Node Build Plan

## Goal
Replace the default Stack-chan chatbot (xiaozhi cloud brain) with a real OpenClaw node that makes the robot a physical extension of Rosie.

## Architecture

```
Stack-chan Hardware (M5Stack CoreS3, ESP32-S3)
├── esp-openclaw-node core (steal verbatim)
│   ├── WebSocket → OpenClaw Gateway (ws://host:19001)
│   ├── JSON-RPC protocol, Ed25519 pairing
│   ├── WebRTC audio (Opus 16kHz) → provider STT/TTS
│   ├── WakeNet 9 wake word detection
│   └── Provisioning (BLE/AP)
├── CoreS3 Board Port (new, based on Waveshare S3 template)
│   ├── AW88298 speaker codec config
│   ├── ES7210 mic config
│   ├── ILI9342 display init
│   ├── AXP2101 PMIC
│   └── FT6336 touch
├── StackChan Robot Layer (borrow from StackChan firmware)
│   ├── SCSCL serial servo control (yaw + pitch)
│   ├── LVGL face/avatar with emotions
│   ├── GC0308 camera (vision hook → OpenClaw endpoint)
│   ├── BMI270 IMU (shake/pickup detection)
│   └── Si12T head touch (petting gestures)
└── Custom: "Hey Rosie" wake word model
    └── ESP-SR/WakeNet custom model
```

## What We're Taking From Each Repo

### 1. esp-openclaw-node (the core)
- **Take verbatim:** esp_openclaw_node core, esp_openclaw_talk, provisioning, room-node product
- **Board port template:** Waveshare ESP32-S3 example (same chip, PSRAM, I2S codecs, LVGL)
- **Protocol:** WebSocket JSON-RPC to Gateway, WebRTC audio to provider
- **Key files:** `esp_openclaw_node.h`, `esp_openclaw_node_protocol.c`, `esp_openclaw_room_node.c`, `room_media.c`, `esp_openclaw_talk.c`

### 2. StackChan firmware (the robot body)
- **Servo system:** SCSCL serial-bus servos (UART1 @ 1Mbps, GPIO6/7), yaw + pitch, spring-damper motion, lookAtNormalized, lookAtPoint 3D IK
- **Avatar face:** LVGL widget tree (eyes/mouth/bubble), emotions, blink/breath/speaking modifiers, JSON API
- **Camera:** GC0308 with Explain() vision hook (capture → JPEG → POST to AI endpoint)
- **Sensors:** BMI270 IMU (shake/pickup), Si12T head touch, PCF8563 RTC
- **Build:** ESP-IDF v5.5.4, same as esp-openclaw-node

### 3. xiaozhi-esp32 firmware (reference for what we're replacing)
- **Wake word approach:** ESP-SR/WakeNet — same system, we just swap the model
- **Audio pipeline reference:** Opus encoding/decoding patterns
- **Board profile reference:** m5stack/core-s3 config (audio codec pins, display config, etc.)

### 4. zclaw (smallest contributor)
- **Agent loop pattern:** tool-calling decision engine
- **NVS provisioning pattern:** custom endpoint override
- **Not much else** — no audio, no hardware relevance

## Build Phases

### Phase 1: Core Bring-Up (1-2 days)
- [ ] Set up ESP-IDF v5.5.4 build environment on Clawdio-Mini
- [ ] Copy Waveshare ESP32-S3 board port as starting template
- [ ] Adapt board port for CoreS3:
  - [ ] AW88298 speaker codec (same as StackChan)
  - [ ] ES7210 mic (same as StackChan)
  - [ ] ILI9342 display (StackChan uses this)
  - [ ] AXP2101 PMIC config
  - [ ] FT6336 touch
- [ ] Get esp-openclaw-node connecting to OpenClaw Gateway
- [ ] Verify WebSocket handshake + pairing
- [ ] First voice test: talk to Stack-chan, audio routes through Gateway

### Phase 2: Robot Layer Integration (2-3 days)
- [ ] Port StackChan servo driver (SCSCL UART1 @ 1Mbps)
  - [ ] Yaw + pitch control
  - [ ] lookAtNormalized / lookAtPoint
  - [ ] Spring-damper motion model
  - [ ] NVS zero-calibration
- [ ] Port StackChan LVGL face/avatar
  - [ ] Eye/mouth/bubble widget tree
  - [ ] Emotion states (happy, thinking, listening, speaking)
  - [ ] Blink/breath/speaking modifiers
  - [ ] Map to esp-openclaw-node talk states
- [ ] Port camera (GC0308)
  - [ ] Capture → JPEG → POST to OpenClaw endpoint
  - [ ] Wire up as a Gateway command handler
- [ ] Port sensors (optional, can defer)
  - [ ] BMI270 IMU → shake to interrupt / pickup detection
  - [ ] Si12T head touch → petting → happy face

### Phase 3: Wake Word (2-5 hours)
- [ ] Research ESP-SR/WakeNet custom model generation
- [ ] Generate "Hey Rosie" wake word model
  - Option A: Espressif online generator (if available)
  - Option B: Train custom model with ESP-SR toolkit
  - Option C: Multi-wake-word model with a slot we can map
- [ ] Configure firmware to use custom model
- [ ] Compile, flash, test: say "Hey Rosie" → device wakes

### Phase 4: Gateway-Side Rosie Config (1 hour)
- [ ] Configure Rosie as the agent for this node on the OpenClaw Gateway
- [ ] Set Rosie's system prompt as the node personality
- [ ] Wire up household tools:
  - [ ] rosie_status (household summary)
  - [ ] rosie_printer_status (3D printer)
  - [ ] rosie_fridge_update (fridge dashboard)
  - [ ] rosie_memory (memory search)
  - [ ] rosie_say (Telegram voice notes)
  - [ ] rosie_time
- [ ] Map robot commands:
  - [ ] "Look at me" → servo lookAtNormalized
  - [ ] "Show me [image]" → camera capture + display
  - [ ] Emotion mapping → face states

### Phase 5: Polish & Testing (1-2 days)
- [ ] End-to-end test: "Hey Rosie, what's the printer status?" → face shows thinking → servo looks at you → speaks status
- [ ] Calibrate audio levels (mic gain, speaker volume)
- [ ] Tune wake word sensitivity (false triggers vs miss rate)
- [ ] Test servo motions during speech
- [ ] Test camera vision ("Hey Rosie, what do you see?")
- [ ] Flash final firmware

## File Structure

```
/Volumes/1TBSSDClawd/stackchan-node/
├── analysis/                    # 4 subagent reports (done)
│   ├── zclaw-analysis.md
│   ├── esp-openclaw-node-analysis.md
│   ├── xiaozhi-firmware-analysis.md
│   └── stackchan-firmware-analysis.md
├── firmware/                    # reference repos (cloned)
│   ├── xiaozhi-esp32/           # what we're replacing
│   ├── StackChan/               # robot layer source
├── repos/                       # reference repos (cloned)
│   ├── zclaw/
│   ├── esp-openclaw-node/       # core to steal
├── rosie-node/                  # OUR FIRMWARE (to create)
│   ├── CMakeLists.txt
│   ├── main/
│   │   ├── main.c
│   │   ├── board_cores3/        # CoreS3 board port
│   │   ├── robot/               # servo + face + camera + sensors
│   │   └── wake_word/           # "Hey Rosie" model
│   ├── sdkconfig.defaults
│   └── partitions.csv
├── server.py                    # MCP server (current, may deprecate)
├── BUILD_PLAN.md                # this file
├── PLAN.md                      # original plan
└── README.md
```

## Key Decisions Needed
1. **Wake word model generation** — need to research if Espressif has an online generator or if we need the ESP-SR training toolkit
2. **Gateway connection** — does the OpenClaw Gateway on this machine support the esp-openclaw-node protocol? Need to verify ws://localhost:19001
3. **ESP-IDF version** — esp-openclaw-node examples pin v5.5.5, StackChan uses v5.5.4 — need to pick one (probably 5.5.5)
4. **Servo UART conflict** — StackChan uses UART1 for servos, esp-openclaw-node may need UART1 for something else. Need to check.

## Status
- [x] Repo analysis (4 subagent reports complete)
- [x] Build plan written
- [ ] Phase 1: Core bring-up
- [ ] Phase 2: Robot layer
- [ ] Phase 3: Wake word
- [ ] Phase 4: Gateway config
- [ ] Phase 5: Polish