# Repo Analysis: taranton/stackchan-gemini-firmware

## Overview

**Repo:** https://github.com/taranton/stackchan-gemini-firmware
**Author:** taranton (StackChan Gemini Firmware contributors)
**License:** MIT
**Last commit:** `6c00ab8` — "ci: add PlatformIO firmware build" (single commit, CI-only)
**Activity:** Early-stage experimental firmware, single commit with substantial codebase

Experimental firmware for M5Stack CoreS3 Stack-chan that uses **Google Gemini Live API** as the voice/AI backend via WebSocket. Includes SD-backed runtime configuration, local memory store, Web UI/API for on-device provisioning, camera smoke tests, servo gestures, and an optional LAN tool gateway for Hermes/Home Assistant integrations. Targets developers/hobbyists comfortable with PlatformIO and ESP32-S3 flashing.

## Architecture

- **Build system:** PlatformIO (Arduino framework, `espressif32@6.3.2` platform)
- **Board:** `esp32s3box` with `m5stack-cores3` env, 16MB flash, QIO_QSPI memory
- **Framework:** Arduino + M5Unified + custom StackChan-BSP library (bundled in `lib/`)
- **AI backend:** Google Gemini Live API via WebSocket Secure (`generativelanguage.googleapis.com:443`)
- **Audio path:** 16kHz PCM, 0.125s chunks (2000 samples), M5.Speaker for output, configurable VAD
- **Config:** SD card based (`/app/StackChan/config/runtime.json`) — no hard-coded secrets
- **Web UI:** Built-in HTTP server with Basic Auth, setup AP fallback (`192.168.4.1`)
- **Tool gateway:** Optional HTTP client to LAN gateway for Hermes/MCP tool routing

### Module breakdown
| Module | File | Purpose |
|--------|------|---------|
| GeminiLiveProbe | `.h/.cpp` | WebSocket client for Gemini Live bidi API, audio streaming, VAD config |
| GeminiToolBridge | `.h/.cpp` | Maps Gemini function calls to local handlers or LAN gateway |
| ToolGatewayClient | `.h/.cpp` | HTTP client for external MCP/Hermes gateway (`/tools`, `/call`) |
| CameraCapture | `.h/.cpp` | esp_camera init/capture/deinit smoke test (RGB565→JPEG) |
| ServoGestureController | `.h/.cpp` | Non-blocking servo gesture queue, BSP angle units (10=1°) |
| EmotionController | `.h/.cpp` | LED + face emotion state machine (10 modes) |
| MemoryStore | `.h/.cpp` | SD-backed append-only event/dialogue/fact/summary store |
| ConfigManager | `.h/.cpp` | SD config loader with secret redaction |
| WebConfigServer | `.h/.cpp` | HTTP Web UI/API with Basic Auth, setup AP, all endpoints |

## Hardware Target

- **M5Stack CoreS3** (ESP32-S3 + PSRAM) — same as our target
- GC0308 camera (enabled via `-DENABLE_CAMERA` build flag)
- SCSCL servos (via bundled StackChan-BSP, SCServo library)
- Si12T touch sensor (in BSP examples)
- SD card required for config/secrets/memory
- AW98298 speaker + ES7210 mic (via M5Unified)

## LLM/Voice Backend

**Google Gemini Live API** (not OpenClaw, not Hermes):
- WebSocket Secure to `generativelanguage.googleapis.com:443/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`
- API key passed as URL query parameter
- Model: `models/gemini-3.1-flash-live-preview` (configurable)
- Voice: `Puck` (configurable)
- Bidirectional audio: 16kHz PCM, 0.125s chunks (2000 samples)
- Server-side VAD with configurable sensitivity, prefix padding, silence duration
- Input/output audio transcription enabled (for memory logging)
- Function calling: Gemini function declarations → GeminiToolBridge → local or gateway

**Optional LAN gateway** (Hermes-compatible):
- HTTP client (not WebSocket) to configurable base URL
- `GET /tools` — fetch tool declarations
- `POST /call` — invoke tool with `{robot_id, session_id, tool, arguments}`
- Default tools: `search_memory`, `ask_hermes`, `get_robot_status`, `set_emotion`
- Disabled by default, must be explicitly configured

## Reusable Findings

### ✅ SD-backed configuration pattern
- Runtime config in `/app/StackChan/config/runtime.json`
- Secrets in separate files (`gemini_api_key.txt`, `wifi_password.txt`, `gateway_token.txt`)
- Web UI redacts secrets as `set`/`missing` — never round-trips secret values
- **Useful for our provisioning phase** — SD-based config avoids hard-coding WiFi/API keys

### ✅ Setup access point fallback
- If WiFi not configured or fails → starts AP `<robot_id>-setup-XXXX` at `192.168.4.1`
- Web UI for first-time WiFi/Gemini/password setup
- **Borrowable for Phase 3** — provisioning without serial/USB

### ✅ GC0308 camera pin mapping (THIRD data point!)
```c
.pin_xclk = -1,           // External 20MHz clock, NOT LEDC-generated
.pin_sscb_sda = 12,       // GPIO12 (matches stackchan-mcp)
.pin_sscb_scl = 11,       // GPIO11 (matches stackchan-mcp)
.pin_d7 = 47, .pin_d6 = 48, .pin_d5 = 16, .pin_d4 = 15,
.pin_d3 = 42, .pin_d2 = 41, .pin_d1 = 40, .pin_d0 = 39,
.pin_vsync = 46, .pin_href = 38, .pin_pclk = 45,
.xclk_freq_hz = 20000000,
.pixel_format = PIXFORMAT_RGB565,
.frame_size = FRAMESIZE_QVGA,  // 320x240
```
- **XCLK = -1 (GPIO_NUM_NC)** — uses external 20MHz clock, does NOT generate via LEDC
- **Comment warns:** "Do not generate XCLK via LEDC here; the previous GPIO/LEDC XCLK smoke build made speech choppy"
- **SDA=GPIO12, SCL=GPIO11** — matches stackchan-mcp, NOT robot-bridge (GPIO4/GPIO5)
- **This is the SECOND repo confirming stackchan-mcp's pin mapping** — strong signal it's correct for CoreS3

### ✅ Camera I2C bus release pattern (confirmed)
```c
M5.In_I2C.release();       // Release M5Unified's I2C before camera init
esp_camera_init(&kCameraConfig);
// ... capture ...
esp_camera_deinit();
// Camera init temporarily releases internal I2C bus
```
- Same pattern as stackchan-mcp — must release M5Unified I2C before camera init
- **They go further:** init camera only for capture, then deinit — camera is NOT always-on
- Reason: voice/audio and camera driver conflict on shared I2C bus

### ✅ Camera → audio interference warning
- Explicit comment: generating XCLK via LEDC made speech choppy
- They use external 20MHz clock (XCLK=-1) to avoid this
- **Critical gotcha for our Phase 2** — if we generate XCLK via LEDC, audio may degrade

### ✅ Non-blocking servo gesture controller
- Step queue with max 16 steps, non-blocking `loop()` execution
- BSP angle units: 10 = 1 degree (yaw ±1280, pitch 0-900)
- Anchor position tracking, relative/absolute moves
- Gesture names: idle, nod, shake, look-around, etc.
- **Borrowable pattern for Phase 2 servo work**

### ✅ Emotion state machine (10 modes)
- Neutral, Listening, Speaking, Thinking, Looking, Happy, Angry, Found, Error, Sleep
- LED + display face rendering per mode
- Sleep mode with display off + power management
- **More granular than robot-bridge's 4-state LED machine** — could combine both

### ✅ SD-backed local memory store
- Append-only JSONL: events, dialogues, facts, summaries
- Session-based with date keys (`YYYY-MM-DD`)
- Policy-based retention (keep N sessions or N days raw, compact older)
- Context builder for LLM prompt injection (max chars cap)
- **Useful pattern for our Phase 3 memory** — but we'd use OpenClaw/Hermes memory, not SD-local

### ✅ VAD configuration surface
- Configurable: prefix padding (800ms default), silence duration (900ms default)
- Start/end sensitivity (high/low)
- Turn coverage (all input vs activity only)
- **Useful defaults to borrow** for our WebRTC audio path

### ✅ Boot/wake sound effects
- Procedural R2-D2-style whistle on boot (PCM generated in code, 24kHz)
- Short wake chirp on voice activation (debounced 1.5s)
- Separate audio channel (channel 0) from Gemini voice (channel 1)
- **Nice UX touch** — makes the robot feel alive without TTS

### ✅ HTTP Basic Auth for Web UI
- SHA256-hashed password stored on SD
- All API endpoints require auth once password is set
- Setup AP is open (no auth) by design
- **Borrowable for Phase 3 web provisioning security**

### ✅ Comprehensive HTTP API design
- `/api/status`, `/api/runtime`, `/api/config` — config management
- `/api/voice/toggle`, `/api/gemini/text` — voice control
- `/api/camera/*` — camera capture/JPEG
- `/api/servo/*` — servo move/gesture
- `/api/emotion` — emotion set
- `/api/memory/*` — memory search/summary
- `/api/gateway/tools` — gateway tool list
- `/api/sensors` — diagnostics
- **Good API surface reference** for our Phase 3 web interface

## Not Reusable

### ❌ PlatformIO/Arduino build system
- We use ESP-IDF 5.5.4, not PlatformIO/Arduino
- Their `platformio.ini` and Arduino framework are incompatible with our build
- The bundled StackChan-BSP is Arduino-specific

### ❌ Gemini Live API as primary backend
- We target OpenClaw Gateway and Hermes Agent, not Google Gemini
- Their WebSocket protocol is Gemini-specific (setup → audio streaming → function calls)
- However, the **pattern** (WebSocket → setup → bidirectional audio → tool calls) maps closely to our OpenClaw WebSocket flow

### ❌ HTTP-based tool gateway
- Their gateway is HTTP REST (`GET /tools`, `POST /call`)
- Our Hermes integration uses webhooks + MCP, not HTTP REST
- robot-bridge's webhook pattern is more relevant for Hermes

### ❌ SD card dependency
- They require SD for all config, secrets, memory
- We use NVS/flash for config and OpenClaw/Hermes for memory
- SD is optional in our design

### ❌ ArduinoJson
- We use ESP-IDF's native JSON or cJSON
- ArduinoJson is Arduino-framework-specific

## Gotchas & Lessons

### ⚠️ XCLK via LEDC causes audio choppy
- **CRITICAL:** Generating the camera XCLK signal via ESP32 LEDC peripheral interferes with audio
- Fix: Use external 20MHz clock (XCLK = GPIO_NUM_NC = -1)
- This is the **third repo** to warn about camera/audio interference on CoreS3
- **Must verify our camera init doesn't use LEDC XCLK**

### ⚠️ Camera must release I2C bus
- `M5.In_I2C.release()` required before `esp_camera_init()`
- Camera and M5Unified share I2C bus — concurrent access causes conflicts
- They deinit camera after capture to restore I2C for other peripherals

### ⚠️ Single-commit repo
- Only one commit (`6c00ab8`) — CI build only
- No release tags, no issue tracker activity visible
- Code is substantial (~20 source files) but maturity is "experimental developer firmware"

### ⚠️ Setup AP is open (no auth)
- First-boot AP has no password (`stackchanXXXX` is predictable)
- Web UI accessible to anyone on the AP
- They acknowledge this: "Setup access point is intentionally simple"

### ⚠️ Memory store is local-only
- No sync to external memory (OpenClaw/Hermes)
- Compaction is a "compile-stage placeholder" — not implemented
- Vectorization is queued but not executed
- **Not production-ready for memory management**

## Comparison to Our Approach

| Aspect | taranton/gemini-firmware | StackChan-OpenClaw-Hermes |
|--------|--------------------------|---------------------------|
| Build system | PlatformIO/Arduino | ESP-IDF 5.5.4 (native) |
| AI backend | Google Gemini Live (WebSocket) | OpenClaw Gateway + Hermes Agent |
| Audio codec | Raw PCM 16kHz | WebRTC Opus 16kHz |
| Wake word | Touch/screen (no wake word model) | WakeNet 9 ("Hi ESP") |
| Config | SD card only | NVS/flash + optional SD |
| Memory | SD-local JSONL | OpenClaw/Hermes cloud memory |
| Tool calling | Gemini functions → HTTP gateway | OpenClaw commands + Hermes MCP |
| Camera | RGB565→JPEG, init/deinit per capture | Same pattern planned (Phase 2) |
| Servos | Non-blocking gesture queue | SCSCL via UART1 (Phase 2) |
| OTA | None | Dual-OTA (6MB partitions) |
| Provisioning | Setup AP + Web UI | TBD (Phase 3) |
| Maturity | Experimental, single commit | In development, firmware builds |

## Verdict

**Moderately useful — 6/10.** This repo is a solid Arduino/PlatformIO reference for CoreS3 hardware patterns, but its Gemini-centric architecture means most of the AI/voice layer is not directly reusable. The key takeaways are:

1. **GC0308 pin mapping confirmed** — matches stackchan-mcp (SDA=12, SCL=11), NOT robot-bridge. Two repos now agree.
2. **XCLK via LEDC causes audio choppy** — critical gotcha, must use external clock
3. **Camera I2C release pattern** — `M5.In_I2C.release()` before camera init, deinit after
4. **SD-backed config + setup AP** — borrowable provisioning pattern for Phase 3
5. **Non-blocking servo gesture queue** — good pattern for Phase 2
6. **Emotion state machine** — 10 modes with LED+face, more granular than robot-bridge's 4

The Gemini Live WebSocket protocol is architecturally similar to our OpenClaw WebSocket flow (setup → bidirectional audio → tool calls), so their client implementation is worth studying for message sequencing and audio chunk handling patterns, even though the protocol itself differs.