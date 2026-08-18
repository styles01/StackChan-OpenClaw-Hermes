# TODO — StackChan-OpenClaw-Hermes

## ⚠️ HARD RULE: Backup Stock Firmware Before Flashing
We have bricked multiple devices before. BEFORE flashing StackChan-OpenClaw-Hermes firmware to the Stack-chan:
1. Plug in via USB, detect serial port
2. `esptool read_flash 0 0x1000000 backup_stackchan_stock.bin` (full 16MB dump)
3. Save partition table: `esptool read_flash 0x8000 0x1000 backup_partition_table.bin`
4. Verify backup file is exactly 16MB
5. Store backups on 1TB SSD: `/Volumes/1TBSSDClawd/stackchan-node/backups/`
6. ONLY then flash our firmware

If anything goes wrong: `esptool write_flash 0x0 backup_stackchan_stock.bin` restores brick-for-brick.

## GitHub
- [x] Rename project to StackChan-OpenClaw-Hermes
- [x] Create GitHub repo and push

## Phase 0: Gateway Prep (0.5 day)
- [ ] Confirm Gateway port: 18789 (NOT 19001 — that's the `--dev` profile default)
- [ ] Set `gateway.nodes.commands.allow` to allow rosie_* commands (currently unset → node gets `commands: []`)
- [ ] Decide auth path: password (`clawdiomax`) vs setup code
- [ ] Run `openclaw qr --voice-node --setup-code-only` to generate provisioning code
- [ ] Restart gateway after config changes

## Phase 1: Core Bring-Up + Voice Verification (2-3 days)
- [x] Set up ESP-IDF v5.5.4 build environment on Clawdio-Mini
- [x] Study the Waveshare ESP32-S3 example in esp-openclaw-node (NOT our hardware — just a reference for how to structure a board port)
- [ ] Write CoreS3 board port from scratch (M5Stack Stack-chan hardware):
  - [x] AW88298 speaker codec (CoreS3 chip — Waveshare uses ES8311, different)
  - [x] ES7210 mic with TDM I2S (CoreS3 needs TDM for AEC reference — Waveshare uses STD)
  - [x] ILI9342 SPI display init (CoreS3 display — Waveshare uses SH8601 QSPI AMOLED, different)
  - [ ] AXP2101 PMIC config
  - [ ] FT6336 touch driver (deferred to Phase 2 — BOOT button for v1)
- [x] Create firmware project structure (`rosie-node/`)
- [x] Set up dual-OTA partition table + rollback from the start
- [ ] Configure WebSocket target to OpenClaw Gateway on port 18789
- [ ] Verify WebSocket handshake + Ed25519 pairing
- [ ] **CRITICAL: Verify Talk voice path** (`gateway-control-v1` capability) — run `wake` console command, confirm gateway returns offer URL + clientSecret. Make-or-break test.
- [ ] First voice test: talk to Stack-chan → audio routes through Gateway → Rosie responds
- [ ] Add coredump partition (64KB at end of flash) — pattern from PlaiPin repo
- [ ] Add emoji-stripping filter before TTS output — pattern from PlaiPin repo
- [ ] Borrow GC0308 camera pin config from stackchan-mcp (Phase 2 camera work)
- [ ] Borrow servo gesture patterns (nod/shake state machine) from stackchan-mcp (Phase 2 servo work)
- [ ] Add audio gate / mic resume pattern to prevent feedback during Talk — from stackchan-mcp
- [ ] ⚠️ KNOWN GOTCHA: If `esp_codec_dev_write()` silently fails, bypass it and write PCM directly to `i2s_channel_write()`. Keep codec only for amp/volume. (From Reddit community finding)
- [ ] Test mic quality early — Reddit users report Whisper returns empty transcriptions due to low mic gain on CoreS3
- [ ] Study stackchan-atoms3r core/platform separation pattern for our OpenClaw + Hermes dual-target architecture
- [ ] Adapt stackchan-atoms3r's port abstractions (AudioSource/AudioSink/Face) for backend-agnostic core firmware
- [ ] Borrow stackchan-atoms3r's SpeechSegmenter for streaming TTS text → sentence boundaries → face expressions
- [ ] Borrow stackchan-atoms3r's deadline-based audio I/O pattern to prevent hangs on slow gateway responses
- [ ] Study robot-bridge's 11 MCP tool definitions for our Hermes target tool list
- [ ] Borrow robot-bridge's LED state machine (idle=off, wake=green, think=rainbow, reply=blue) for Phase 2
- [ ] Borrow robot-bridge's face tracking algorithm (EMA 0.25, dead zone 6%, rate limit 12°/0.5s) for Phase 2 servos
- [ ] ⚠️ CRITICAL: Verify GC0308 camera pin mapping — stackchan-mcp and gemini-firmware agree on SDA=GPIO12/SCL=GPIO11, robot-bridge is the outlier (GPIO4/GPIO5). Use GPIO12/GPIO11 unless testing proves otherwise. Test all configs during Phase 2 camera bring-up.
- [ ] ⚠️ CRITICAL: Camera XCLK must use external 20MHz clock (XCLK=-1), NOT LEDC-generated — 3 repos warn this causes audio choppyness. (From gemini-firmware analysis)
- [ ] Camera init pattern: `M5.In_I2C.release()` before `esp_camera_init()`, deinit after capture — don't leave camera always-on (confirmed by stackchan-mcp + gemini-firmware)
- [ ] Borrow gemini-firmware's non-blocking servo gesture queue pattern (max 16 steps, anchor tracking, BSP 0.1° units) for Phase 2 servos
- [ ] Borrow gemini-firmware's 10-mode emotion state machine (neutral/listening/speaking/thinking/looking/happy/angry/found/error/sleep) — more granular than robot-bridge's 4-state LED
- [ ] Borrow gemini-firmware's SD-backed config + setup AP fallback pattern for Phase 3 provisioning
- [ ] Consider gemini-firmware's boot/wake procedural sound effects (R2-D2 whistle on separate audio channel) for UX polish
- [ ] Study gemini-firmware's Gemini Live WebSocket protocol (setup → bidirectional audio → tool calls) — architecturally similar to our OpenClaw WS flow
- [ ] Study robot-bridge's LLM→TTS streaming pipeline (sentence-level, barge-in, emotion before LLM) for Talk voice path optimization
- [ ] Consider robot-bridge's natural stranger registration pattern (LLM-driven, no regex) for Phase 3

## Phase 2: Robot Layer Integration (3-5 days)
**REUSE-FIRST PRINCIPLE: Wrap proven Stack-chan libraries, don't reinvent them.**
Add `espressif/arduino-esp32` (v3.3.6) as a managed component for direct access to `M5StackChan.Motion`, `M5Unified`, `StackChan-BSP`, `esp_camera`.

- [ ] **Add Arduino-ESP32 as managed component:**
  - [ ] Add `espressif/arduino-esp32` to `idf_component.yml`
  - [ ] Add `m5stack/M5Unified`, `m5stack/StackChan-BSP` as Arduino library deps
  - [ ] Verify build still compiles with Arduino component added

- [ ] **Servo + motion (WRAP M5StackChan.Motion — proven by stackchan-mcp):**
  - [ ] Thin wrapper around `M5StackChan.Motion.move()`, `.goHome()`, `.moveX()`, `.moveY()`
  - [ ] Adapt stackchan-mcp's `servo_service.cpp` gesture patterns (nod, shake, look_around)
  - [ ] BSP handles torque enable, VM_EN power, safe ranges — don't reimplement
  - [ ] UART1 @ 1Mbps GPIO6/7 (NO CONFLICT — console on USB Serial/JTAG)
  - [ ] Wire as board `services.register_commands` hook

- [ ] **Camera (ADAPT stackchan-mcp's camera_service.cpp — proven GC0308 driver):**
  - [ ] Use stackchan-mcp's init/capture/deinit pattern directly
  - [ ] `M5.In_I2C.release()` before `esp_camera_init()`, deinit after capture
  - [ ] GC0308 pins: SDA=GPIO12, SCL=GPIO11 (2-repo consensus), XCLK=external 20MHz (NOT LEDC)
  - [ ] Wire through room-node's `try_acquire_camera()` / `release_camera()`
  - [ ] Use custom command name `rosie.vision` (gateway blocks `camera.snap`/`camera.clip`)

- [ ] **LED + Emotion (ADAPT gemini-firmware's 10-mode state machine):**
  - [ ] Port emotion states: neutral/listening/speaking/thinking/looking/happy/angry/found/error/sleep
  - [ ] LED state machine: idle=off, wake=green, think=rainbow chase, reply=blue (from robot-bridge)
  - [ ] WS2812C ×12 LEDs via AW9523 IO expander

- [ ] **Face (USE ROOM-NODE BUILT-IN for v1):**
  - [ ] v1: Use esp-openclaw-node's built-in procedural LVGL face (`room_face.c`)
  - [ ] v2 (later): Re-parent StackChan avatar widget tree onto room-node display

- [ ] **Sensors (OPTIONAL, DEFER):**
  - [ ] BMI270 IMU, Si12T touch

## Phase 3: Wake Word (1-2 days + parallel research track)
NOTE: There is NO self-service online wake word generator. It's a submission to Espressif (GitHub issue #88).

- [ ] **Immediate (works today):** Ship with stock WakeNet model
  - Option A: `wn9_hiesp` ("Hi ESP") — esp-openclaw-node default
  - Option B: `wn9_histackchan_tts3` ("Hi StackChan") — already exists for this hardware
  - Update wake callback string in `room_media.c:61` to match
- [ ] **Parallel research track (days-weeks, external dependency):**
  - Submit "Hey Rosie" to Espressif via GitHub issue #88 / application form
  - Evaluate `xiaozhi-assets-generator` MultiNet flow
  - No guarantee Espressif accepts — fallback is stock model permanently
- [ ] Configure firmware to use chosen stock model
- [ ] Compile, flash, test: device wakes on stock word

## Phase 4: Gateway-Side Rosie Config (1 hour)
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

## Phase 5: Polish & Testing (2-3 days)
- [ ] End-to-end: wake word → face thinks → servo looks → speaks status
- [ ] Calibrate audio levels (mic gain, speaker volume)
- [ ] Tune wake word sensitivity (false triggers vs miss rate)
- [ ] Test servo motions during speech
- [ ] Test camera vision ("what do you see?")
- [ ] Flash final firmware