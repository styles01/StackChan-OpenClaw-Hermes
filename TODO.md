# TODO

## Phase 1: Core Bring-Up
- [ ] Set up ESP-IDF v5.5.4+ build environment on Clawdio-Mini
- [ ] Copy Waveshare ESP32-S3 board port from esp-openclaw-node as template
- [ ] Adapt board port for M5Stack CoreS3:
  - [ ] AW88298 speaker codec config
  - [ ] ES7210 mic config
  - [ ] ILI9342 display init
  - [ ] AXP2101 PMIC config
  - [ ] FT6336 touch driver
- [ ] Create `rosie-node/` firmware project structure
- [ ] Configure WebSocket target to OpenClaw Gateway
- [ ] Verify WebSocket handshake + Ed25519 pairing
- [ ] First voice test: talk to Stack-chan → audio routes through Gateway → Rosie responds

## Phase 2: Robot Layer Integration
- [ ] Port StackChan servo driver (SCSCL UART1 @ 1Mbps)
  - [ ] Yaw + pitch control
  - [ ] lookAtNormalized / lookAtPoint 3D IK
  - [ ] Spring-damper motion model
  - [ ] NVS zero-calibration
- [ ] Port StackChan LVGL face/avatar
  - [ ] Eye/mouth/bubble widget tree
  - [ ] Emotion states (happy, thinking, listening, speaking)
  - [ ] Blink/breath/speaking modifiers
  - [ ] Map emotions to esp-openclaw-node talk states
- [ ] Port camera (GC0308)
  - [ ] Capture → JPEG → POST to OpenClaw endpoint
  - [ ] Wire as Gateway command handler
- [ ] Port sensors (optional, can defer)
  - [ ] BMI270 IMU → shake to interrupt / pickup detection
  - [ ] Si12T head touch → petting → happy face

## Phase 3: Wake Word
- [ ] Research ESP-SR/WakeNet custom model generation options
- [ ] Generate "Hey Rosie" wake word model
  - Option A: Espressif online generator
  - Option B: Train with ESP-SR toolkit
  - Option C: Multi-wake-word model with mappable slot
- [ ] Configure firmware to use custom model
- [ ] Compile, flash, test: "Hey Rosie" → device wakes

## Phase 4: Gateway-Side Rosie Config
- [ ] Configure Rosie as the agent for this node on OpenClaw Gateway
- [ ] Set Rosie's system prompt as node personality
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

## Phase 5: Polish & Testing
- [ ] End-to-end: "Hey Rosie, what's the printer status?" → face thinks → servo looks → speaks status
- [ ] Calibrate audio levels (mic gain, speaker volume)
- [ ] Tune wake word sensitivity (false triggers vs miss rate)
- [ ] Test servo motions during speech
- [ ] Test camera vision ("Hey Rosie, what do you see?")
- [ ] Flash final firmware

## Investigation
- [ ] Verify OpenClaw Gateway supports esp-openclaw-node protocol (ws://localhost:19001)
- [ ] Check ESP-IDF version compatibility (esp-openclaw-node v5.5.5 vs StackChan v5.5.4)
- [ ] Check UART1 conflict (StackChan servos vs esp-openclaw-node)
- [ ] Research Espressif wake word generator availability