# migratorywhale/stackchan-mcp — Repo Analysis

**Date:** 2026-08-17
**Repo:** https://github.com/migratorywhale/stackchan-mcp
**Stars:** 55 | **Forks:** 17 | **Created:** 2026-05-18
**Languages:** C, C++, Python, Makefile, Shell
**License:** (check repo)

## Verdict: VERY HELPFUL — best Stack-chan reference repo we've found

## What They Built

A complete MCP (Model Context Protocol) bridge for Stack-chan on M5Stack CoreS3. Two-part architecture:

```
AI Agent (Claude/GPT/etc)
    ↓ MCP Protocol
stackchan-mcp Python server (FastMCP)
    ↓ HTTP REST
Stack-chan CoreS3 firmware (Arduino/PlatformIO)
```

The firmware exposes an HTTP API on the ESP32 itself. The Python MCP server translates MCP tool calls into HTTP requests to the robot. This is a clean separation — the AI agent talks MCP, the robot talks HTTP, the server bridges them.

### Why This Is More Relevant Than PlaiPin

- **Same hardware** (M5Stack CoreS3, Stack-chan with servos)
- **Same camera** (GC0308) with working pin config and RGB565→JPEG conversion
- **Same servo system** (SCSCL bus servos via UART1 GPIO6/7)
- **Production quality** — 55 stars, 17 forks, proper tests, docs, troubleshooting guides
- **Working face system** — AnimatedGIF-based expressions with BGR color correction for ILI9342
- **Working audio** — PCM streaming (TCP + UDP), WAV playback, mic recording with VAD
- **MCP server** — proper FastMCP implementation with auth, telemetry, voice bridge scripts

## Key Files Worth Studying

### 1. `firmware/src/servo_service.cpp` — BEST SERVO REFERENCE
- Uses `M5StackChan.Motion` API from StackChan-BSP library
- `servoMove(float yawDeg, float pitchDeg, int speedPct)` — clean API
- Yaw: -128° to +128°, Pitch: 5° to 85°
- BSP uses 0.1° units (`degToBspAngle = deg * 10`)
- Speed: 0-100% → BSP speed 0-1000
- **Gestures**: nod (4-step Y axis), shake (4-step X axis) — non-blocking, state machine in `updateServoGesture()`
- `M5StackChan.Motion.goHome(500)` for centering
- `M5StackChan.Motion.setAutoTorqueReleaseEnabled(true)` — releases torque when idle
- Diagnostic feedback: position, speed, moving state, voltage, temperature

### 2. `firmware/src/camera_service.cpp` — WORKING GC0308 PIN CONFIG
```
CAM_PIN_XCLK    = GPIO 2
CAM_PIN_SIOD     = GPIO 12  (I2C SDA, shared)
CAM_PIN_SIOC     = GPIO 11  (I2C SCL, shared)
CAM_PIN_D0-D7    = GPIO 39,40,41,42,15,16,48,47
CAM_PIN_VSYNC    = GPIO 46
CAM_PIN_HREF     = GPIO 38
CAM_PIN_PCLK     = GPIO 45
```
- **Critical**: GC0308 does NOT support hardware JPEG — must capture RGB565 and convert with `frame2jpg()`
- **Critical**: Camera shares I2C with system — must call `M5.In_I2C.release()` before camera init
- 20MHz XCLK, QVGA 320x240, quality 80

### 3. `firmware/src/face_service.cpp` — GIF-BASED FACE SYSTEM
- Uses AnimatedGIF library with 7 expressions: calm, thinking, happy, sleepy, shy, smug, pouty
- GIFs stored as C arrays (compiled into `gif_assets.h`)
- 192x192 source GIFs scaled 1.25x to fill 240px height
- **BGR color correction for ILI9342**: swaps R and B fields in RGB565 palette
  - Formula: `color = ((c & 0x1F) << 11) | (c & 0x07E0) | (c >> 11)`
- Lip sync support: `setMouthOpen(float ratio)` — 0.0 to 1.0
- Face state machine: IDLE, LISTENING, PLAYING, THINKING, HAPPY

### 4. `firmware/src/playback_service.h` — AUDIO PIPELINE
- WAV URL playback (downloads then plays)
- PCM streaming via TCP port 9090 (default) and UDP port 9091
- 24kHz mono s16le PCM format
- Staged playback: buffer all segments in PSRAM, play after final segment
- Mic resume after playback (avoids audio loop feedback)
- 120ms prebuffer for TCP stream

### 5. `firmware/src/mic_service.cpp` — MIC WITH VAD
- RMS-based voice activity detection
- Pre-trigger buffer (4800 samples = 300ms at 16kHz)
- Trigger/silence thresholds configurable
- Records up to 8 seconds
- WAV output with proper header

### 6. `mcp_server/mcp_tools.py` — MCP TOOL DEFINITIONS
10 MCP tools:
- `stackchan_say(text, lang)` — TTS + playback
- `stackchan_listen(lang)` — capture recording
- `stackchan_move(x, y, speed)` — servo control
- `stackchan_nod()` / `stackchan_shake()` — gestures
- `stackchan_face(expression)` — face change
- `stackchan_see()` — camera snapshot
- `stackchan_home()` — servo center
- `stackchan_status()` — diagnostics
- `stackchan_health()` — health check

### 7. `firmware/platformio.ini` — BUILD CONFIG
- Platform: espressif32@7.0.0
- Board: m5stack-cores3
- Framework: arduino
- Key libs: M5Unified@0.2.15, StackChan-BSP@1.1.0, ArduinoJson@7.4.3, AnimatedGIF@2.2.3
- 80MHz flash, PSRAM enabled, `-mfix-esp32-psram-cache-issue`

### 8. `docs/http-api.md` — COMPLETE HTTP API CONTRACT
Full REST API spec for the firmware. Could serve as reference for our command interface.

## What We Can Learn From This

### Directly Useful (can adapt to ESP-IDF)
1. **GC0308 camera pin config** — exact GPIO mapping for CoreS3. We need this for Phase 2 camera work.
2. **Camera I2C bus sharing** — must release M5Unified's I2C before camera init. Critical gotcha.
3. **GC0308 RGB565→JPEG** — no hardware JPEG, must use `frame2jpg()` software conversion
4. **BGR color correction formula** — ILI9342 on CoreS3 needs R/B swap in RGB565. We already have BGR flag in our display config but this confirms it.
5. **Servo gesture patterns** — nod and shake as 4-step state machines. Clean, non-blocking design.
6. **Servo angle ranges** — yaw ±128°, pitch 5-85°. Confirms our ranges.
7. **BSP 0.1° units** — servo angles are ×10 in the BSP. Important for our servo port.
8. **Mic VAD approach** — RMS-based trigger with pre-trigger buffer. Could complement WakeNet.
9. **Audio gate pattern** — mic resume after playback to prevent feedback. Important for our Talk path.
10. **Face state machine** — IDLE/LISTENING/PLAYING/THINKING/HAPPY matches our room-node face states.

### Architecturally Different (can't directly reuse)
1. **Arduino/PlatformIO** — we're on ESP-IDF. Can't use M5Unified or StackChan-BSP directly.
2. **HTTP REST API** — they expose HTTP endpoints. We use WebSocket commands via esp-openclaw-node.
3. **MCP server in Python** — we don't need this, OpenClaw Gateway is our intelligence layer.
4. **GIF face system** — we're using room-node's built-in procedural LVGL face for v1.

### Not Useful
- The Python MCP server (we have OpenClaw)
- The voice bridge scripts (we have WebRTC Talk)
- The config loader (we have provisioning)

## Comparison: PlaiPin vs stackchan-mcp vs Our Approach

| Aspect | PlaiPin | stackchan-mcp | Our Approach |
|--------|---------|---------------|-------------|
| Architecture | HTTP→Node.js proxy→WS→Gateway | MCP→Python server→HTTP→ESP32 | WS+WebRTC direct to Gateway |
| Build system | Arduino/PlatformIO | Arduino/PlatformIO | ESP-IDF |
| Intelligence | OpenClaw Gateway | AI Agent via MCP | OpenClaw Gateway |
| Audio | TTS via HTTP | PCM streaming (TCP/UDP) | WebRTC Opus |
| Wake word | SimpleVox MFCC | RMS VAD | ESP-SR WakeNet |
| Face | m5avatar | AnimatedGIF | Room-node built-in |
| Camera | esp32-camera | esp_camera (RGB565) | esp_video (Phase 2) |
| Servo | StackchanSERVO | M5StackChan.Motion (BSP) | SCSCL direct (Phase 2) |
| Host dependency | Node.js proxy | Python MCP server | None (direct) |

## Key Insight

stackchan-mcp is the best hardware reference we've found. Their firmware code confirms:
- CoreS3 camera pin layout (critical for Phase 2)
- Servo angle ranges and BSP API patterns
- ILI9342 BGR color handling
- Audio gate / mic resume pattern for feedback prevention
- Face state machine that matches our room-node states

The MCP server architecture is irrelevant to us, but the FIRMWARE is a goldmine for Phase 2 robot layer work.