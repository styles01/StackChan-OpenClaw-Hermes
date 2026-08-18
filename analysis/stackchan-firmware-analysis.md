# StackChan Firmware — Technical Analysis for a Custom OpenClaw/Rosie Node

**Repo analyzed:** `github.com/m5stack/StackChan` (local clone at `/Volumes/1TBSSDClawd/stackchan-node/firmware/StackChan`)
**Firmware version:** 1.4.3 (`PROJECT_VER` in `firmware/CMakeLists.txt`)
**Analysis date:** 2026-08-17
**Purpose:** Understand Stack-chan's hardware + firmware so we can build a custom OpenClaw/Rosie node on this platform.

---

## 1. What is this project?

StackChan is **both** the robot body firmware **and** a companion server + mobile app. The repo contains four top-level pieces:

| Directory | What it is |
|-----------|-----------|
| `firmware/` | The **robot firmware** (ESP-IDF app for the M5Stack CoreS3 + robot body). This is the main thing we care about. |
| `server/` | A **Go (GoFrame) backend** — the companion cloud server that the robot talks to over WebSocket. |
| `app/` | The **mobile app** (iOS/Android) — remote control, video viewing, avatar control. |
| `remote/` | A **remote controller** firmware (ESP-NOW based). |

**Key architectural insight:** The firmware is **not** a from-scratch M5Stack project. It is a **fork/wrapper around the open-source `xiaozhi-esp32` project** (v2.2.4, from `github.com/78/xiaozhi-esp32`), which is the popular open-source "XiaoZhi" AI voice-assistant firmware. StackChan layers its own robot-specific code (servos, avatar face, motion, RGB, head-touch, IMU) **on top of** the xiaozhi-esp32 AI agent core.

The boot flow in `main.cpp`:
1. Init HAL (board, servos, display, IMU, RTC, head-touch, IO expander).
2. Run the **Mooncake app framework** (a UI/app framework by Forairaaaaa) with 8 apps (launcher, AI agent, avatar, ESP-NOW control, app center, EZData, dance, setup).
3. When the user launches the AI Agent app (or `startAiAgentOnBoot` is set), it tears down Mooncake and calls `GetHAL().startXiaozhi()` — which **never returns** and runs the full xiaozhi-esp32 AI agent (wake word, streaming TTS/STT, WebSocket to a XiaoZhi-compatible server).

So: **the robot body firmware and the AI agent are two layers in one binary.** The robot HAL (servos/face) is exposed to the xiaozhi layer through a `hal_bridge` so the AI agent can drive the face and motion.

---

## 2. Firmware structure

```
firmware/
├── CMakeLists.txt          # Top-level, project "stack-chan", version 1.4.3
├── sdkconfig.defaults      # ESP-IDF 5.5.4 config (ESP32-S3, 16MB flash, PSRAM, BLE/NimBLE)
├── partitions.csv          # OTA dual-slot + 4MB assets (SPIFFS) partition
├── repos.json              # Git sub-repos fetched by fetch_repos.py
├── fetch_repos.py          # Clones mooncake, xiaozhi-esp32, ArduinoJson, esp-now
├── patches/xiaozhi-esp32.patch  # Patch applied to xiaozhi-esp32
├── main/
│   ├── main.cpp            # Entry point (Mooncake apps → xiaozhi)
│   ├── CMakeLists.txt      # Globs stackchan sources + pulls in xiaozhi-esp32 sources
│   ├── Kconfig.projbuild   # Board type, server URL, language, wake word, camera config
│   ├── idf_component.yml   # ESP-IDF component manager deps (LVGL 9.4, esp-sr, esp_video, etc.)
│   ├── hal/                # Hardware abstraction layer (the robot HAL)
│   │   ├── hal.h / hal.cpp # Hal singleton: init, display, BLE, RGB, IMU, RTC, network, OTA
│   │   ├── board/          # Board-specific: stackchan.cc (CoreS3 board), display, camera, audio codec, hal_bridge
│   │   ├── drivers/        # FTServo (SCSCL), BMI270 IMU, PCF8563 RTC, PY32 IO expander, Si12T touch
│   │   ├── utils/          # BLE peripheral, WiFi connect, JPEG decode, motion detector, OTA, secret_logic
│   │   └── hal_*.cpp       # hal_servo, hal_ble, hal_ws_avatar, hal_network, hal_espnow, hal_imu, hal_rtc, hal_io_expander, hal_head_touch, hal_ota, hal_mcp, hal_app_center, hal_ezdata, hal_account
│   ├── stackchan/          # The robot "brain" — motion, avatar, modifiers, animation, JSON
│   │   ├── stackchan.h/.cpp # StackChan class: owns Motion + Avatar + NeonLights + Modifier pool
│   │   ├── motion/          # servo.h/.cpp, motion.h/.cpp, motion_math (IK + normalized look)
│   │   ├── avatar/          # Avatar base + DefaultAvatar skin (eyes/mouth/speech bubble) + decorators
│   │   ├── modifiers/       # breath, blink, speaking, idle_motion, idle_expression, dance, head_pet, imu, timed
│   │   ├── animation/       # Keyframe sequence / timeline (dance playback)
│   │   ├── json/            # JSON → avatar/motion/neon-light/dance updates
│   │   └── addons/neon_light/
│   ├── apps/               # Mooncake apps (launcher, ai_agent, avatar, espnow_ctrl, app_center, ezdata, dance, setup)
│   └── assets/             # Icons, fonts, SFX (ogg), setup images
├── xiaozhi-esp32/          # (fetched) the AI agent core
└── components/             # (fetched) mooncake, mooncake_log, smooth_ui_toolkit, ArduinoJson, esp-now
```

**The two-layer split is the single most important thing to understand:** the `stackchan/` + `hal/` code is the robot; the `xiaozhi-esp32/` code is the AI agent. For a custom Rosie node we can **keep the robot layer and replace/repurpose the AI agent layer** (or drive the robot layer directly from our own control plane).

---

## 3. Hardware

From the README + `board/stackchan.cc` + `board/config.h`:

**Main controller: M5Stack CoreS3** — ESP32-S3 SoC:
- 240 MHz dual-core, 16 MB Flash, 8 MB PSRAM
- Wi-Fi + BLE (NimBLE)
- 2.0" capacitive touch display (320×240, ILI9342 controller over SPI)
- 0.3 MP camera (GC0308, DVP interface)
- Proximity & ambient light sensor
- 9-axis IMU (BMI270)
- microSD slot
- 1W speaker + dual microphones
- Power/reset buttons

**Robot body** (connected to CoreS3):
- USB-C for power/data
- 550 mAh battery
- **Two feedback servos** (SCSCL serial bus servos): 360° continuous rotation (yaw/horizontal) + 90° (pitch/vertical)
- **Two rows of 12 RGB LEDs** (neon lights)
- IR transmitter + receiver
- **Three-zone touch panel** (head petting — Si12T capacitive touch)
- Full NFC module

**I2C bus** (port 1, SDA=GPIO12, SCL=GPIO11) hosts:
- AXP2101 PMIC (0x34) — power, battery, backlight (DLDO1)
- AW9523 IO expander (0x58) — resets for audio amp + display, RGB LED control
- FT6336 touch controller (0x38)
- BMI270 IMU (0x69)
- PCF8563 RTC
- PY32 IO expander (robot body — servo power, RGB)
- Si12T head-touch sensor
- AW88298 audio amp + ES7210 ADC (audio codec I2C)

**SPI** (SPI3_HOST): MOSI=37, SCLK=36, CS=3, DC=35 → ILI9342 display.

**Camera DVP pins:** D0-D7 = 39,40,41,42,15,16,48,47; VSYNC=46, HREF=38, PCLK=45; XCLK from external 20 MHz crystal.

---

## 4. Servo control (head/arm)

**This is the most reusable piece for a Rosie node.**

- **Servo type:** Feetech **SCSCL** serial-bus servos (the `FTServo_Arduino` driver in `hal/drivers/FTServo_Arduino/`). These are half-duplex UART servos with position feedback, current/load sensing, and torque control.
- **Bus:** UART1 at **1,000,000 baud**, TX=GPIO6, RX=GPIO7 (`_scs_bus.begin(UART_NUM_1, 1000000, 6, 7)` in `hal_servo.cpp`).
- **Two servos:**
  - **Yaw (ID=1):** 360° continuous rotation, default zero pos 460, angle limit ±1280, raw pos 0–1000, PWM mode enabled (can rotate continuously).
  - **Pitch (ID=2):** 90° range, default zero pos 620, angle limit 30–870, raw pos 0–1000, stall protection enabled.
- **Zero calibration** stored in NVS (`servo` namespace, keys `zero_pos_1`/`zero_pos_2`), settable via the Setup app.
- **Angle mapping:** raw = zero + angle × 16/5/10 (0.3125° per raw step). `raw_pos_to_angle` = (raw − zero) × 5 × 10 / 16.
- **Motion model:** The `Servo` class uses a **spring-damper animation** (`uitk::AnimateValue` with stiffness/damping/mass) rather than raw position jumps. `moveWithSpeed(angle, speed)` maps speed (0–1000) to spring stiffness via a quadratic curve (k = 10 + (speed/1000)² × 640, critical damping d = 2√(m·k)). This gives smooth, natural head motion.
- **Auto torque release:** When the servo is at rest, torque is released automatically (saves power, allows manual posing).
- **Auto angle sync:** Optionally re-syncs animation start to the physical angle so external forces don't cause "snap" jumps.
- **Stall protection (pitch):** Monitors position delta + current + load; if stuck with current/load spike, it clamps the runtime limit and stops motion — protects the mechanism.
- **Servo power:** Controlled via the PY32 IO expander pin 0 (`setServoPowerEnabled`), pulled up at init.

**Motion API (`Motion` class):**
- `moveYaw/movePitch/move(angle)` — spring motion
- `moveWithSpeed(angle, speed)` — speed-mapped spring
- `goHome(speed)` — return to (0,0)
- `lookAtNormalized(x, y, speed)` — map normalized −1..1 to full range (great for camera tracking / joystick)
- `lookAtPoint(x, y, z, speed)` — **inverse kinematics** from 3D point to yaw/pitch (`motion_math.cpp`)
- `setTorqueEnabled`, `setAutoTorqueReleaseEnabled`, `setAutoAngleSyncEnabled`

**JSON control format** (from `json_helper.cpp`) — this is the wire protocol for motion:
```json
{ "yawServo":   { "angle": 0, "speed": 500 },
  "pitchServo": { "angle": 450, "speed": 900 } }
```
Also supports `rotate` (velocity), and `spring: {stiffness, damping}`.

---

## 5. Display / face

- **Panel:** ILI9342 (ILI9341 driver) 320×240 RGB565 over SPI at 40 MHz, driven through **LVGL 9.4** via `esp_lvgl_port`.
- **Backlight:** AXP2101 DLDO1, brightness mapped to register 20–28 (via `Pmic::SetBrightness`).
- **Touch:** FT6336 capacitive touch, polled on a 20 ms timer, fed to LVGL as a pointer input device.
- **The face** is a **custom LVGL widget tree** (`stackchan/avatar/`), not a bitmap:
  - `DefaultAvatar` = a 320×240 container with **left eye, right eye, mouth, and speech bubble** as LVGL objects.
  - **Eyes** (`DefaultEyes`): containers with an eye + eyelid; support `setPosition`, `setWeight` (eyelid openness), `setRotation`, `setEmotion`, `setSize`.
  - **Mouth** (`DefaultMouth`): a container whose `weight` controls openness (used by the SpeakingModifier to animate talking).
  - **Speech bubble** (`DefaultSpeechBubble`): container + arrow image + text label.
  - **Decorators** (angry, heart, shy, dizzy, sweat): overlay images for emotional states.
- **Emotions:** `Neutral, Happy, Angry, Sad, Sleepy, Doubt` — mapped from xiaozhi status strings (`neutral/happy/laughing/angry/sad/crying/sleepy/doubtful`).
- **Modifiers** drive the face + motion together:
  - `BreathModifier` — sinusoidal vertical bob of eyes+mouth (breathing).
  - `BlinkModifier` — periodic eyelid blink.
  - `SpeakingModifier` — random mouth open/close + subtle head nods.
  - `IdleMotionModifier` — random head glances (4 action types).
  - `IdleExpressionModifier` — random expressions.
  - `DanceModifier` — plays a keyframe sequence (face + servos + RGB).
  - `HeadPetModifier` / `ImuEventModifier` — react to touch / shake.
- **Avatar JSON control** (wire format):
```json
{ "leftEye":  { "x":0, "y":0, "rotation":0, "weight":100, "size":0 },
  "rightEye": { ... },
  "mouth":    { ... } }
```

**This whole avatar system is directly reusable** — it's a clean, self-contained LVGL face renderer with a JSON API.

---

## 6. Audio

- **Codec chips:** **AW88298** (Class-D speaker amp, output) + **ES7210** (4-channel ADC, input) — see `cores3_audio_codec.cc`.
- **I2S:** I2S_NUM_0, duplex. Output = I2S standard mode (16-bit stereo); input = I2S **TDM mode** (4 slots) to support the reference channel for echo cancellation.
- **Pins:** MCLK=0, WS=33, BCLK=34, DIN=14 (mic), DOUT=13 (speaker). Sample rate 24 kHz in/out.
- **Echo cancellation:** `AUDIO_INPUT_REFERENCE=true` → 2 input channels (mic + reference) for AEC. Uses `esp_codec_dev` + `esp_audio_codec` component.
- **Wake word / ASR / TTS:** handled by the xiaozhi-esp32 layer using **ESP-SR** (`esp-sr ~2.3.0`) with the `HISTACKCHAN_TTS3` wake-word model. Audio processing (noise reduction) via `afe_audio_processor`.
- **Audio streaming:** Opus audio frames are sent over the WebSocket to the server (type `0x01`).

---

## 7. Camera

- **Sensor:** GC0308 (0.3 MP), DVP interface, 20 MHz XCLK, configured via `esp_video` (V4L2-style API) — `stackchan_camera.cc`.
- **Resolution:** 320×240 (YUV422/RGB565), ~20 FPS.
- **Uses:** 
  - **Photo capture** (`Capture()`) — grabs a frame, plays a shutter SFX, shows a preview on the display.
  - **Video streaming** to the mobile app over WebSocket (JPEG frames, type `0x02`).
  - **AI "Explain"** (`Explain(question)`) — captures a frame, JPEG-encodes it in a background thread, and POSTs it as multipart/form-data to a configured server URL with the question, returning an AI analysis. This is a **ready-made vision hook** we could point at our own vision endpoint.
- **Mirror/flip** controls via V4L2 HFLIP/VFLIP.

---

## 8. Communication

The firmware has **multiple communication channels**:

1. **Wi-Fi** (`hal_network.cpp`): STA mode, provisioned via hotspot (default) / acoustic / Blufi. SNTP time sync. RSSI-based signal strength indicator.
2. **WebSocket to the StackChan server** (`hal_ws_avatar.cpp`): connects to `{server}/stackChan/ws?deviceType=StackChan` with an auth token. This is the **primary robot↔cloud channel** for the Avatar app (remote control, video, calls, dance, text messages). Binary frame protocol: `1 byte msgType + 4 bytes big-endian length + payload`.
3. **BLE** (`hal_ble.cpp`): NimBLE peripheral with a custom GATT service. Sends/receives **fragmented JSON** (motion, avatar, config, RGB) for direct phone control without the server. Supports large MTU (512) and a custom fragmentation protocol (magic `AA 55 C3` header).
4. **ESP-NOW** (`hal_espnow.cpp`): peer-to-peer wireless control (used by the `remote/` controller and `AppEspnowControl`). Also controls a laser.
5. **XiaoZhi AI agent** (`xiaozhi-esp32` layer): WebSocket/MQTT to a **XiaoZhi-compatible server** for the voice AI (STT/TTS/LLM). The default OTA URL is `https://api.tenclass.net/xiaozhi/ota/`.

**Server URL config:** `CONFIG_STACKCHAN_SERVER_URL` (Kconfig, default `http://47.113.125.164:12800`), overridable via `sdkconfig.defaults.local`. The `secret_logic` module generates the auth token (currently a weak placeholder `"hi-stack-chan"` unless overridden).

**For a custom Rosie node:** the cleanest path is to **replace the StackChan server URL with our own** and speak the documented WebSocket protocol (or drive the robot layer directly over BLE/ESP-NOW). The xiaozhi AI agent can be pointed at any XiaoZhi-compatible backend or bypassed entirely.

---

## 9. Build system

- **Framework:** **ESP-IDF v5.5.4** (not PlatformIO/Arduino for the main firmware). Target: **ESP32-S3**.
- **Component manager:** `idf_component.yml` pulls LVGL 9.4, esp-sr, esp_video, esp_codec_dev, esp_lcd drivers, esp-now, etc.
- **Sub-repos:** `fetch_repos.py` clones mooncake, xiaozhi-esp32 (v2.2.4 + patch), ArduinoJson, esp-now into `components/` and `xiaozhi-esp32/`.
- **Build:**
  ```bash
  python3 ./fetch_repos.py        # fetch sub-repos
  idf.py build                    # build
  idf.py flash                    # flash
  ```
- **Host-side tests** for motion math (no hardware):
  ```bash
  cmake -S tests -B build-host-tests && cmake --build build-host-tests && ctest --test-dir build-host-tests
  ```
- **Partition table:** dual OTA (ota_0/ota_1, ~5 MB each) + 4 MB SPIFFS `assets` partition + coredump.
- **Custom config:** `sdkconfig.defaults.local` (git-ignored) lets you pin `CONFIG_STACKCHAN_SERVER_URL`, `CONFIG_OTA_URL`, etc. without touching committed defaults.
- **Board type:** `CONFIG_BOARD_TYPE_M5STACK_STACK_CHAN=y` selects the StackChan board files.

---

## 10. App layer (Mooncake apps)

The firmware boots into a **Mooncake** app framework with 8 apps (`main/apps/`):

| App | Purpose |
|-----|---------|
| `AppLauncher` | Home screen with app grid + screensaver + startup setup wizard |
| `AppAiAgent` | Launches the xiaozhi AI agent (tears down Mooncake, runs `startXiaozhi()`) |
| `AppAvatar` | The "Sentinel" remote-avatar app — WebSocket + BLE control of face/motion, video window, phone calls, text messages, dances |
| `AppEspnowControl` | ESP-NOW remote control (startup + advanced pages) |
| `AppAppCenter` | Online app store (download/install apps from the server) |
| `AppEzdata` | EZData service (pairing/data service) |
| `AppDance` | Dance playback (BLE-driven keyframe sequences) |
| `AppSetup` | First-run setup wizard: WiFi, account, servo zero-calibration, servo test, RGB test, audio test, display test, about |

The `app_setup/workers/` folder has the calibration/test workers (servo, audio, display, connectivity, account, system, ai_agent, startup) — useful reference for a self-test/calibration flow.

---

## 11. Server (`server/`)

A **Go (GoFrame v2.10) backend** — the companion cloud service. Not a simple relay; it's a full platform:

- **Auth:** JWT for users/admins; **RSA-OAEP-encrypted MAC token** for devices (`<mac>|<nonce>|<timestamp>` encrypted with server public key, base64 in `Authorization` header).
- **WebSocket hub** (`internal/web_socket/`): pools for StackChan devices + app clients, forwards audio (Opus), JPEG frames, motion/avatar control, call state, dance, text messages. Heartbeat every 5 s, stale cleanup every 15 s.
- **Modules:** user, device (bind/unbind/rename), dance (motion JSON + music), community (posts/comments), pano (panoramic images), app store (admin CRUD), file upload, friend relationships, and **XiaoZhi integration** (token retrieval/refresh, agent reset).
- **Stack:** Go 1.26.3, GoFrame, gorilla/websocket, MySQL 8.0, Docker + Kustomize deploy templates, Flutter Web admin console (prebuilt).
- **Port:** `:12800`.

**For a custom Rosie node:** we almost certainly **don't need this full server**. The WebSocket protocol it implements is the useful spec (see §8). We can either (a) run a minimal WebSocket relay ourselves, or (b) drive the robot directly over BLE/ESP-NOW and skip the cloud entirely.

---

## 12. What we can steal for a custom Rosie node

**Highest-value reusable components (all MIT-licensed, self-contained, JSON-driven):**

1. **Servo driver + motion system** (`hal_servo.cpp`, `stackchan/motion/servo.cpp`, `motion.cpp`, `motion_math.cpp`, `drivers/FTServo_Arduino/`)
   - SCSCL serial-bus servo driver (position feedback, torque, current/load, stall protection)
   - Spring-damper motion model with speed mapping — gives natural head motion
   - `lookAtNormalized` (joystick/camera tracking) + `lookAtPoint` (3D IK)
   - Zero-calibration persisted in NVS
   - **This is the core "head" control we want for Rosie.**

2. **Avatar face renderer** (`stackchan/avatar/`)
   - LVGL-based eyes/mouth/speech-bubble with emotions, blink, breath, speaking animation
   - JSON API (`updateAvatarFromJson`) — drive the face from any control plane
   - Decorators (angry/heart/shy/dizzy/sweat)

3. **Modifier system** (`stackchan/modifiers/`)
   - Reusable behavior blocks: breath, blink, speaking, idle motion, idle expression, dance, head-pet, IMU-event
   - Clean `Modifier` interface — easy to add new behaviors (e.g., "listening", "thinking", "happy-to-see-you")

4. **Animation/timeline system** (`stackchan/animation/`)
   - Keyframe sequences (face + servos + RGB) with timing — perfect for scripted Rosie gestures/dances

5. **JSON wire protocol** (`stackchan/json/json_helper.cpp`)
   - The exact JSON schemas for motion, avatar, neon-light, and dance — a ready-made control API

6. **Board HAL** (`hal/board/stackchan.cc`, `cores3_audio_codec.cc`, `stackchan_camera.cc`)
   - Complete CoreS3 board bring-up: AXP2101 PMIC, AW9523, FT6336 touch, ILI9342 display, AW88298+ES7210 audio, GC0308 camera
   - Camera `Explain()` = ready-made vision hook (capture → JPEG → POST to AI endpoint)

7. **Sensors:** BMI270 IMU (shake/pickup detection), Si12T head-touch (petting gestures), PCF8563 RTC — all with working drivers and gesture recognizers.

8. **Communication patterns:** BLE fragmented-JSON GATT service, WebSocket binary protocol, ESP-NOW — reference implementations for how to control the robot.

**What we'd likely NOT reuse:**
- The full `xiaozhi-esp32` AI agent layer (unless we want XiaoZhi voice AI) — for OpenClaw/Rosie we'd drive the robot layer directly from our own control plane.
- The Go server (too heavy) — unless we want the full app ecosystem.
- The Mooncake app framework (nice but optional; we could boot straight into a custom control loop).

**Recommended integration strategy for Rosie:**
- Keep the `stackchan/` + `hal/` robot layer and the board files.
- Replace `main.cpp`'s Mooncake/xiaozhi boot with a **custom control loop** that:
  - Initializes the HAL (servos, face, audio, camera, sensors).
  - Exposes a control interface (BLE GATT + WebSocket to our own server, or a local serial/ESP-NOW command channel).
  - Accepts the documented JSON motion/avatar/dance commands.
- Reuse the `Servo`/`Motion`/`Avatar`/`Modifier`/`Animation` classes unchanged.
- Point the camera `Explain()` at our own vision endpoint for OpenClaw vision.

---

## Key file reference

| File | What it shows |
|------|---------------|
| `firmware/main/main.cpp` | Boot flow: Mooncake apps → xiaozhi |
| `firmware/main/hal/hal.cpp` | HAL init order + xiaozhi bridge |
| `firmware/main/hal/hal_servo.cpp` | SCSCL servo config + ScsServo class |
| `firmware/main/stackchan/motion/servo.cpp` | Spring-damper motion model |
| `firmware/main/stackchan/motion/motion_math.cpp` | IK + normalized look |
| `firmware/main/stackchan/avatar/skins/default/default.cpp` | Face widget construction |
| `firmware/main/stackchan/json/json_helper.cpp` | Wire JSON schemas |
| `firmware/main/hal/board/stackchan.cc` | CoreS3 board bring-up (PMIC, display, camera, touch) |
| `firmware/main/hal/board/cores3_audio_codec.cc` | AW88298 + ES7210 audio |
| `firmware/main/hal/board/stackchan_camera.cc` | Camera capture + Explain() vision hook |
| `firmware/main/hal/hal_ws_avatar.cpp` | WebSocket protocol to server |
| `firmware/main/hal/hal_ble.cpp` | BLE fragmented-JSON GATT |
| `firmware/main/Kconfig.projbuild` | Server URL + board config |
| `server/README.MD` | Full server + WebSocket protocol spec |
