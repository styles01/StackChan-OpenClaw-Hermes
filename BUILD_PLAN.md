# StackChan-OpenClaw-Hermes — Build Plan

## Goal
Replace the default Stack-chan chatbot (xiaozhi cloud brain) with a native AI agent node — OpenClaw or Hermes — that makes the robot a first-class extension of your agent.

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
          │ WebSocket (ws://gateway:18789)
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

## What We're Taking From Each Repo

### 1. esp-openclaw-node (the core)
- **Take verbatim:** esp_openclaw_node core, esp_openclaw_talk, provisioning, room-node product
- **Board port reference:** esp-openclaw-node ships with an example board port for a Waveshare ESP32-S3 dev board. This is NOT our hardware — our hardware is M5Stack CoreS3. The Waveshare example is only useful as a structural reference (how to fill in the board port contract struct). The actual CoreS3 hardware is completely different (AW88298 vs ES8311 codec, ILI9342 vs SH8601 display, TDM vs STD I2S). ~40-50% code reuse, 100% port contract reuse.
- **Protocol:** WebSocket JSON-RPC v3-4 to Gateway on port **18789** (NOT 19001), Ed25519 pairing
- **Key files:** `esp_openclaw_node.h`, `esp_openclaw_node_protocol.c`, `esp_openclaw_room_node.h`, `room_media.c`, `esp_openclaw_talk.c`

### 2. StackChan firmware (the robot body)
- **Servo + motion (PORTABLE — high value, low risk):** `stackchan/motion/`, `hal/hal_servo.cpp`, `drivers/FTServo_Arduino/` — no xiaozhi deps, only LVGL + smooth_ui_toolkit + ArduinoJson
- **Avatar face (COUPLED — defer to v2):** `StackChanAvatarDisplay` inherits from xiaozhi's `LvglDisplay` — not portable as-is. Use room-node's built-in procedural face for v1.
- **Camera (COUPLED — rewrite, don't port):** depends on xiaozhi's mcp_server/board/display. Rewrite as standalone esp_video capture.
- **Sensors (DEFER):** BMI270, Si12T drivers are portable. Later.
- **Build:** ESP-IDF v5.5.4

### 3. xiaozhi-esp32 firmware (reference for what we're replacing)
- **Wake word approach:** ESP-SR/WakeNet — same system, stock model for now
- **Board profile reference:** m5stack/core-s3 config (audio codec pins, display config)

### 4. zclaw (smallest contributor)
- Agent loop pattern — marginal, since the agent loop lives on the Gateway in this architecture

### 5. PlaiPin/plaipin-openclaw-stackchan (reference — different architecture)
- **NOT our architecture** — they use HTTP REST proxy (Node.js middleman) instead of native WebSocket+WebRTC
- **Worth borrowing:**
  - Emoji-stripping code for TTS (ESP32 TTS engines choke on 4-byte emoji — strip before sending)
  - Coredump partition in partition table (64KB at end of flash — good for crash debugging)
  - Servo API pattern: `moveToGaze(gazeX, gazeY)` confirms our servo abstraction shape
- **NOT useful:** REST proxy architecture, SimpleVox wake word, LLM/TTS/STT abstraction layers
- Full analysis: `analysis/plaipin-repo-analysis.md`
- Repo cloned to `repos/plaipin-openclaw-stackchan/` (excluded from git tracking)

### 6. migratorywhale/stackchan-mcp (BEST hardware reference — different architecture)
- **NOT our architecture** — they use MCP Python server → HTTP REST → ESP32 firmware. We use WebSocket+WebRTC via esp-openclaw-node.
- **VERY useful firmware reference** — same hardware (CoreS3, GC0308 camera, SCSCL servos, ILI9342 display):
  - GC0308 camera pin config (exact GPIO mapping for CoreS3) — critical for Phase 2
  - Camera I2C bus sharing gotcha: must `M5.In_I2C.release()` before camera init
  - GC0308 does NOT support hardware JPEG — must capture RGB565 and software convert
  - Servo API: `servoMove(yawDeg, pitchDeg, speedPct)` with yaw ±128°, pitch 5-85°
  - BSP uses 0.1° units (`deg * 10`) — important for our servo port
  - Servo gestures: nod/shake as 4-step non-blocking state machines
  - ILI9342 BGR color correction: `color = ((c & 0x1F) << 11) | (c & 0x07E0) | (c >> 11)`
  - Audio gate / mic resume pattern to prevent feedback during Talk
  - Face state machine: IDLE/LISTENING/PLAYING/THINKING/HAPPY — matches room-node states
- Full analysis: `analysis/stackchan-mcp-repo-analysis.md`
- Repo cloned to `repos/stackchan-mcp/` (excluded from git tracking)

### 7. Reddit r/StackChan community findings (real-world integration experience)
- Thread: "Openclaw + StackChan 🦞🦞" (June 2026) — `analysis/reddit-openclaw-stackchan-thread.md`
- **CRITICAL FINDING:** `esp_codec_dev_write()` silently fails in XiaoZhi firmware due to I2S format conflict with duplex config. Fix: bypass codec write, use `i2s_channel_write()` directly. Keep codec only for amp/volume management.
- 16kHz WAV is the proven working sample rate for TTS pipeline — confirms our choice
- Mic quality is a known problem — even with higher gain, Whisper returns empty transcriptions. Plan for gain/AGC tuning early.
- Head-pet (touch sensor) as push-to-talk alternative to wake word
- Real demand for Stack-chan + OpenClaw integration — people buying hardware for this use case
- No clean reference implementation exists yet — our project could fill this gap

### 8. kkdev92/stackchan-atoms3r (BEST architecture reference — different hardware)
- **DIFFERENT HARDWARE** — M5Stack AtomS3R + Atomic Voice Base (not CoreS3)
- **SAME BUILD SYSTEM** — ESP-IDF 6.0.1 via PlatformIO (closest to our ESP-IDF approach)
- **EXCELLENT architecture** — best software design of all repos analyzed:
  - Core/platform separation: `src/core` has zero ESP-IDF deps, host-testable
  - Port abstractions: `AudioSource`, `AudioSink`, `Face` interfaces in core, implementations in platform
  - Deadline-based audio I/O — no unbounded waits, prevents hangs
  - Half-duplex direction lock pattern (recursive mutex for capture/playback transitions)
  - Speech segmenter: splits streaming text at sentence boundaries, handles UTF-8, supports `[expression]text[/expression]` markers
  - Versioned protocol envelope with explicit error codes + retry semantics
  - Command registry with auto-generated capability list
  - Coredump partition (confirms pattern from PlaiPin)
  - Host tests + QEMU verification
- Full analysis: `analysis/stackchan-atoms3r-repo-analysis.md`
- Key insight: their core/platform separation pattern directly enables our OpenClaw + Hermes dual-target architecture — swap the connection layer without touching core firmware

### 10. taranton/stackchan-gemini-firmware (CoreS3 hardware patterns — Gemini Live backend)
- **PlatformIO/Arduino** firmware for CoreS3 with Google Gemini Live API via WebSocket
- **NOT our architecture** — Gemini Live is a cloud AI backend, not OpenClaw/Hermes
- **VERY useful hardware patterns** — same CoreS3 hardware:
  - GC0308 pin config CONFIRMS stackchan-mcp mapping (SDA=GPIO12, SCL=GPIO11) — second repo to agree, robot-bridge is the outlier
  - ⚠️ CRITICAL: XCLK via LEDC causes audio choppy — must use external 20MHz clock (XCLK=-1, GPIO_NUM_NC)
  - Camera I2C release pattern confirmed again: `M5.In_I2C.release()` before init, deinit after capture
  - Non-blocking servo gesture queue (max 16 steps, BSP angle units 10=1°, anchor tracking)
  - 10-mode emotion state machine (neutral/listening/speaking/thinking/looking/happy/angry/found/error/sleep) — more granular than robot-bridge's 4-state LED
  - SD-backed config + setup AP fallback (`192.168.4.1`) — borrowable for Phase 3 provisioning
  - Boot/wake procedural sound effects (R2-D2 whistle, separate audio channel from voice)
  - VAD defaults: prefix padding 800ms, silence duration 900ms — useful for WebRTC audio path
  - HTTP API surface reference (status/config/voice/camera/servo/emotion/memory/gateway/sensors)
  - Gemini Live WebSocket protocol architecturally similar to OpenClaw WS flow (setup → bidirectional audio → tool calls)
- Full analysis: `analysis/stackchan-gemini-firmware-repo-analysis.md`
- Key insight: GC0308 pin mapping consensus is now 2-to-1 in favor of stackchan-mcp (GPIO12/GPIO11). XCLK must be external, NOT LEDC-generated.

### 9. waynecc-at/robot-bridge (MOST DIRECTLY RELEVANT — working Hermes + Stack-chan bridge)
- **PRODUCTION-DEPLOYED** Stack-chan → Hermes Agent bridge — 21 features, 15 bug fixes, 11 E2E tests
- Python FastAPI bridge on :8081 — XiaoZhi WebSocket protocol + Opus audio + ASR/TTS + vision
- Hermes Agent on :8642/:8644 — webhook-driven conversation, MCP tools, per-person memory sessions
- **11 MCP tools**: listen, speak, see, face, face_register, look, track_target, led, emote, status, idle
- **Multi-user face recognition**: OpenCV local detection + LBPH cache + Hermes Vision fallback + LLM-driven natural stranger registration
- **Face tracking → servo**: smooth EMA (0.25), dead zone (6%), rate limit (12°/0.5s), multi-person priority, LLM override
- **LED state machine**: idle=off, wake=green(1.8s), think=rainbow chase, reply=blue
- **LLM→TTS streaming pipeline**: sentence-level, on_text callback, barge-in, emotion before LLM response
- **XiaoZhi protocol server-side**: full hello/listen/stt/llm/tts/abort message flow confirmed
- **Opus params**: 16kHz mono, 60ms frames, complexity=10, soxr resampling, DTX silence detection
- **GC0308 pin mapping DIFFERENT from stackchan-mcp** — ⚠️ must verify which is correct for our CoreS3 board rev
- **REFACTOR-PLAN.md**: self-critique — bridge was too thick, should be thinner. Validates our native approach (no bridge at all).
- Full analysis: `analysis/robot-bridge-repo-analysis.md`
- Key insight: this IS the Hermes integration blueprint. Our firmware eliminates the Python bridge — ESP32 talks directly to gateway — but tool definitions, conversation flow, and feature set are directly informed by what robot-bridge proved works.

## Build Phases

### Phase 0: Gateway Prep (0.5 day)
- [ ] Confirm Gateway port: **18789** (NOT 19001 — that's the `--dev` profile default)
- [ ] Set `gateway.nodes.commands.allow` to allow rosie_* commands (currently unset → node gets `commands: []`)
- [ ] Decide auth path: password (`clawdiomax`) vs setup code
- [ ] Run `openclaw qr --voice-node --setup-code-only` to generate provisioning code
- [ ] Restart gateway after config changes

### Phase 1: Core Bring-Up + Voice Verification (2-3 days)
- [ ] Set up ESP-IDF v5.5.4 build environment on Clawdio-Mini
- [ ] Study the Waveshare ESP32-S3 example in esp-openclaw-node (NOT our hardware — just a reference for how to structure a board port)
- [ ] Write CoreS3 board port from scratch (M5Stack Stack-chan hardware):
  - [ ] AW88298 speaker codec (CoreS3 chip — Waveshare uses ES8311, different)
  - [ ] ES7210 mic with TDM I2S (CoreS3 needs TDM for AEC reference — Waveshare uses STD)
  - [ ] ILI9342 SPI display init (CoreS3 display — Waveshare uses SH8601 QSPI AMOLED, different)
  - [ ] AXP2101 PMIC config
  - [ ] FT6336 touch
- [ ] Get esp-openclaw-node connecting to Gateway on port 18789
- [ ] Verify WebSocket handshake + Ed25519 pairing
- [ ] **CRITICAL: Verify Talk voice path** (`gateway-control-v1` capability) — run `wake` console command, confirm gateway returns offer URL + clientSecret (not "Gateway upgrade required"). This is the make-or-break test.
- [ ] First voice test: talk to Stack-chan, audio routes through Gateway
- [ ] Set up dual-OTA partition table + rollback from the start

### Phase 2: Robot Layer Integration (3-5 days)
**REUSE-FIRST PRINCIPLE: Wrap proven Stack-chan libraries, don't reinvent them.**
Add `espressif/arduino-esp32` (v3.3.6, built on ESP-IDF v5.5.2) as a managed component to get direct access to `M5StackChan.Motion`, `M5Unified`, `StackChan-BSP`, `esp_camera`. These are already proven on CoreS3 by stackchan-mcp and plaipin.

- [ ] **Add Arduino-ESP32 as managed component:**
  - [ ] Add `espressif/arduino-esp32` to `idf_component.yml`
  - [ ] Add `m5stack/M5Unified`, `m5stack/StackChan-BSP` as Arduino library deps
  - [ ] Verify build still compiles with Arduino component added
  - [ ] If binary size becomes an issue later, strip Arduino and port to pure ESP-IDF

- [ ] **Servo + motion (WRAP M5StackChan.Motion — proven by stackchan-mcp):**
  - [ ] Thin wrapper around `M5StackChan.Motion.move()`, `.goHome()`, `.moveX()`, `.moveY()`
  - [ ] Adapt stackchan-mcp's `servo_service.cpp` gesture patterns (nod, shake, look_around)
  - [ ] BSP handles torque enable, VM_EN power, safe ranges, acceleration curves — don't reimplement
  - [ ] UART1 @ 1Mbps GPIO6/7 (NO CONFLICT — console on USB Serial/JTAG)
  - [ ] Wire as board `services.register_commands` hook

- [ ] **Camera (ADAPT stackchan-mcp's camera_service.cpp — proven GC0308 driver):**
  - [ ] Use stackchan-mcp's `camera_service.cpp` init/capture/deinit pattern directly
  - [ ] `M5.In_I2C.release()` before `esp_camera_init()`, `esp_camera_deinit()` after capture
  - [ ] GC0308 pins: SDA=GPIO12, SCL=GPIO11 (2-repo consensus), XCLK=external 20MHz (NOT LEDC)
  - [ ] Wire through room-node's `try_acquire_camera()` / `release_camera()` to avoid media contention with Talk
  - [ ] Use custom command name `rosie.vision` (gateway blocks `camera.snap`/`camera.clip`)

- [ ] **LED + Emotion (ADAPT gemini-firmware's 10-mode state machine):**
  - [ ] Port emotion states: neutral/listening/speaking/thinking/looking/happy/angry/found/error/sleep
  - [ ] LED state machine: idle=off, wake=green, think=rainbow chase, reply=blue (from robot-bridge)
  - [ ] WS2812C ×12 LEDs via AW9523 IO expander

- [ ] **Face (USE ROOM-NODE BUILT-IN for v1):**
  - [ ] v1: Use esp-openclaw-node's built-in procedural LVGL face (`room_face.c`) — zero work, already wired to Talk state
  - [ ] v2 (later): Re-parent StackChan avatar widget tree onto room-node display

- [ ] **Sensors (OPTIONAL, DEFER):**
  - [ ] BMI270 IMU, Si12T touch — drivers are portable, gesture recognizers in `stackchan/modifiers/` are self-contained

### Phase 3: Wake Word (1-2 days + parallel research track)
NOTE: There is NO self-service online wake word generator. It's a submission to Espressif (GitHub issue #88). Ship a stock model now.

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

### Phase 4: Gateway-Side Rosie Config (1 hour)
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

### Phase 5: Polish & Testing (2-3 days)
- [ ] End-to-end test: "Hey Rosie, what's the printer status?" → face thinks → servo looks → speaks status
- [ ] Calibrate audio levels (mic gain, speaker volume)
- [ ] Tune wake word sensitivity (false triggers vs miss rate)
- [ ] Test servo motions during speech
- [ ] Test camera vision ("Hey Rosie, what do you see?")
- [ ] Flash final firmware

## File Structure

```
/Volumes/1TBSSDClawd/stackchan-node/
├── analysis/                    # 5 reports (done)
│   ├── zclaw-analysis.md
│   ├── esp-openclaw-node-analysis.md
│   ├── xiaozhi-firmware-analysis.md
│   ├── stackchan-firmware-analysis.md
│   └── adversarial-review.md
├── firmware/                    # reference repos (not tracked in git)
│   ├── xiaozhi-esp32/           # what we're replacing
│   ├── StackChan/               # robot layer source
├── repos/                       # reference repos (not tracked in git)
│   ├── zclaw/
│   ├── esp-openclaw-node/       # core to steal
├── rosie-node/                  # OUR FIRMWARE (to create)
│   ├── CMakeLists.txt
│   ├── main/
│   │   ├── main.c
│   │   ├── board_cores3/        # CoreS3 board port
│   │   ├── robot/               # servo + motion (from StackChan)
│   │   └── wake_word/           # stock model config
│   ├── sdkconfig.defaults
│   └── partitions.csv          # dual-OTA + rollback
├── server.py                    # MCP server (interim, separate system)
├── BUILD_PLAN.md                # this file
├── PROJECT.md
├── TODO.md
└── CHANGELOG.md
```

## Resolved Decisions (from adversarial review + James's reuse-first callout)
1. ~~Wake word model generation~~ → RESOLVED: No self-service generator exists. Ship stock model, submit "Hey Rosie" to Espressif as parallel track.
2. ~~Gateway connection~~ → RESOLVED: Port is 18789 (not 19001). Protocol supported. Must set `gateway.nodes.commands.allow`.
3. ~~ESP-IDF version~~ → RESOLVED: Pick 5.5.4 (matches StackChan's tested env, satisfies `>=5.3`).
4. ~~Servo UART conflict~~ → RESOLVED: No conflict. Servos on UART1, console on USB Serial/JTAG.
5. ~~Arduino vs ESP-IDF for robot layer~~ → RESOLVED: Add Arduino-ESP32 as managed component (Path A). Reuse `M5StackChan.Motion`, `esp_camera`, `M5Unified` directly. Don't reinvent servo/camera/LED drivers that already work.
6. ~~Audio I2S mode~~ → RESOLVED: STD I2S for both TX and RX (not TDM). Waveshare reference proves STD works with ES7210 for 2-channel AEC. Mixed STD+TDM on same port doesn't work.
7. ~~Reinventing the wheel~~ → RESOLVED: James called this out. Adversarial review should have caught "should this code exist?" not just "are there bugs?" Reuse-first principle now enforced.

## Open Risks (from adversarial review)
1. **`gateway-control-v1` Talk capability** — NOT found in gateway dist. Must verify with real device in Phase 1. If it fails, fall back to interim MCP server (separate system, not a drop-in).
2. **esp-sr/esp_video version skew** — StackChan pins esp-sr ~2.3.0, esp-openclaw-node needs ^2.4.7. Only matters if reusing StackChan audio/wake code (which we're NOT). Camera pins esp_video ==1.3.1 — keep camera on separate track.
3. **`smooth_ui_toolkit` + `ArduinoJson` + `mooncake` deps** — StackChan robot brain needs these external repos. Add as managed components.
4. **Room-node face vs StackChan avatar collision** — two competing face systems. Use room-node built-in for v1.
5. **Camera + Talk media contention** — wire through room-node's acquire/release API.
6. **`denyCommands` blocks `camera.snap`/`camera.clip`** — use custom command name (`rosie.vision`).
7. **No OTA/rollback plan** — keep dual-OTA partition table + rollback from the start.
8. **`server.py` MCP fallback is a trap** — it's a different protocol, not a drop-in fallback. Treat as separate interim system.

## Revised Effort Estimate

| Phase | Original | Revised | Why |
|-------|----------|---------|-----|
| 0. Gateway prep | (missing) | 0.5 day | Port, auth, commands.allow |
| 1. Core bring-up | 1-2 days | 2-3 days | CoreS3 board port is real engineering |
| 2. Robot layer | 2-3 days | 3-5 days | Display/camera coupled, only servo is portable |
| 3. Wake word | 2-5 hours | 1-2 days + parallel | No self-service generator, external dependency |
| 4. Gateway config | 1 hour | 1 hour | Unchanged |
| 5. Polish | 1-2 days | 2-3 days | More to calibrate |
| **Total** | **~1 week** | **~2.5-3 weeks** | |

## Status
- [x] Repo analysis (4 subagent reports complete)
- [x] Adversarial review (thomas, verified against source)
- [x] Build plan revised per review
- [ ] Phase 0: Gateway prep
- [ ] Phase 1: Core bring-up + voice verification
- [ ] Phase 2: Robot layer (servo first, face later, camera last)
- [ ] Phase 3: Wake word (stock model now, "Hey Rosie" parallel track)
- [ ] Phase 4: Gateway config
- [ ] Phase 5: Polish