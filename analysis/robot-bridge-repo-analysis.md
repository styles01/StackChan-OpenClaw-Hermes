# waynecc-at/robot-bridge — Repo Analysis

**Date:** 2026-08-17
**Repo:** https://github.com/waynecc-at/robot-bridge
**License:** MIT
**Version:** 0.2.0
**Language:** Python (bridge) + C++ (firmware snippets)

## Verdict: THE MOST DIRECTLY RELEVANT REPO — WORKING Stack-chan → Hermes Agent BRIDGE

This is someone who **already built and shipped** what we're building. Stack-chan connected to Hermes Agent via a Python bridge service. It's production-quality, deployed, and has 21 completed features including multi-user face recognition, voice conversation, servo tracking, and LED state indicators.

## What They Built

A Python bridge service that connects an M5Stack Stack-chan (ESP32-S3) to a [Hermes Agent](https://github.com/nicoborghi/hermes) via the XiaoZhi WebSocket protocol. The bridge is a "thin layer" — it handles audio (ASR/TTS/Opus), the XiaoZhi protocol, and local vision (OpenCV face detection). All intelligence (conversation, decisions, memory, personality) lives in the Hermes Agent.

```
ESP32 StackChan (XiaoZhi WebSocket protocol, Opus audio)
    │
    ▼
Bridge :8081 (Python FastAPI — thin execution layer)
    │ ASR (SenseVoiceSmall) → POST :8644/webhooks/stackchan
    ▼
Hermes Agent (SOUL.md + Skills + Memory + MCP tools)
    │ stackchan_speak/emote/look/led tools
    ▼
MCP Server → HTTP :8081/internal/* → Bridge → ESP32
```

### Key Architecture Principle
> "Bridge only does what needs low latency (audio, protocol, servos, face detection, LED). All 'understanding' and 'decisions' (who is it, how to respond, extract info, when to turn head) are in Hermes."

This is **exactly** the core/platform separation pattern from stackchan-atoms3r, but implemented as a service architecture instead of a firmware architecture. Same principle, different layer.

## 11 MCP Tools (Proven Working)

| Tool | Purpose | Notes |
|------|---------|-------|
| `stackchan_listen` | ASR — transcribe user speech | SenseVoiceSmall, local |
| `stackchan_speak` | TTS — speak text through robot | Sherpa-ONNX Matcha → Opus, streaming |
| `stackchan_see` | Camera snapshot → vision analysis | OpenCV face detection + Hermes Vision |
| `stackchan_face` | Face recognition result | LBPH local + Hermes Vision fallback |
| `stackchan_face_register` | Register new person | LLM-driven natural conversation registration |
| `stackchan_look` | Servo control (yaw/pitch/speed) | yaw -90 to 90, pitch 10 to 70 |
| `stackchan_track_target` | Face tracking for N seconds | Smooth tracking with dead zone |
| `stackchan_led` | RGB LED control (R/G/B/rainbow) | NeoPixel ×2 |
| `stackchan_emote` | Facial expression | neutral/happy/sad/angry/sleepy/doubtful |
| `stackchan_status` | Device diagnostics | |
| `stackchan_idle` | Set idle mode | Suppresses auto-listen |

## Key Technical Details

### 1. XiaoZhi WebSocket Protocol (REUSABLE PATTERN)
They implement the XiaoZhi protocol server-side:
- Client hello: `{"type":"hello","version":1,"transport":"websocket","audio_params":{...}}`
- Server hello: `{"type":"hello","session_id":"...","audio_params":{...}}`
- Listen start: `{"type":"listen","state":"start","mode":"auto"}`
- Listen stop: `{"type":"listen","state":"stop"}` (VAD silence trigger)
- Raw Opus audio in binary WS frames while listening (60ms frames, 960 samples/frame)
- Server → Device: `{"type":"stt","text":"..."}`, `{"type":"llm","emotion":"neutral"}`, `{"type":"tts","state":"start"}`, binary Opus, `{"type":"tts","state":"stop"}`

**Why this matters:** This is the exact protocol our esp-openclaw-node WebSocket uses. Seeing it implemented server-side in Python confirms the message flow.

### 2. Opus Audio Streaming (BORROWABLE)
- 16kHz mono Opus, 60ms frames (960 samples per frame)
- `opuslib` for encode/decode
- ffmpeg soxr anti-aliasing resampling for TTS quality
- Opus complexity=10 for best quality
- DTX silence detection (RMS energy threshold)
- TTS streaming: sentence-level pipeline, first chunk at 50ms for instant playback

### 3. Face Tracking → Servo (REUSABLE ALGORITHM)
`FaceTracker` class with:
- Smooth exponential moving average (smoothing=0.25)
- Dead zone (6% of frame — ignore tiny offsets)
- Rate limiting (max 12° per update, 0.5s interval)
- Multi-person priority (tracks current speaker only)
- LLM override (pauses tracking for 4s when LLM sends explicit head command)
- Safe servo ranges: yaw ±90° (HW max ±128°), pitch 10-70° (HW max 0-90°)

### 4. Multi-User Face Recognition (IMPRESSIVE)
Full pipeline:
- OpenCV local face detection (~5ms)
- LBPH local recognition cache (fast, offline)
- Hermes Vision API fallback (accurate, when LBPH uncertain)
- **Natural stranger registration**: LLM-driven conversation (no regex, no state machine)
  - Bridge detects unknown face 3× → sets flag
  - LLM naturally asks "好像没见过你呀，怎么称呼？"
  - User says "我是小明，爸爸" → LLM understands
  - Background `extract_person_info` → LBPH retrain → next time auto-recognized
- **Per-person memory isolation**: `stackchan-{name}` Hermes sessions

### 5. LED State Machine (BORROWABLE)
- Idle: LED off
- Wake word detected: Green (1.8s)
- Listening: Green → fade
- Thinking (LLM call): Rainbow chase (0.25s/frame, 7-color cycle)
- Replying (TTS): Blue (0,0,168)
- Idle: LED off

### 6. LLM → TTS Streaming Pipeline (ADVANCED)
- `chat_with_tools` with `on_text` callback
- `_tts_worker`: sentence-level pipeline — LLM generates text, TTS starts speaking first sentence while LLM is still generating
- Emotion sent BEFORE LLM response (face updates immediately)
- `extract_person_info` runs as background asyncio task (doesn't block TTS)
- Barge-in: `_tts_stop` Event cancels in-progress TTS stream
- 4 seconds faster than non-streaming approach

### 7. Firmware Side — Camera + Face Detection (C++ SNIPPETS)
`firmware/` contains Arduino headers for:
- `CameraDriver.h` — GC0308 init with **different pin mapping** than stackchan-mcp:
  - XCLK=15, SIOD=4, SIOC=5, Y2-Y9=20,7,8,9,10,11,16,3
  - VSYNC=6, HREF=18, PCLK=17
  - **NOTE: These pins are DIFFERENT from stackchan-mcp's mapping!** Need to verify which is correct for CoreS3.
- `FaceDetector.h` — ESP-DL face detection (MTMN model, ~3-5 FPS)
- `FaceTracker.h` — servo following
- `WebSocketSender.h` — base64 JPEG → WebSocket vision_frame messages

### 8. OTA Endpoint
- `/ota` provides ESP32 initial configuration
- Separate OTA HTTP server on port 8884
- MQTT broker on port 8883
- Flash command documented in ARCHITECTURE.md

### 9. Hermes Integration Details
- Hermes Gateway on port 8642 (API), 8644 (webhook)
- MCP stdio server spawned by Hermes as subprocess
- Webhook-driven: ASR result → POST to Hermes → Hermes processes → responds via MCP tools
- `hermes webhook subscribe stackchan --prompt "..." --deliver log`
- Per-person session: `X-Hermes-Session-Id: stackchan-{name}`

### 10. REFACTOR-PLAN.md — Self-Critique (VALUABLE)
They identified that their bridge was "too thick" — it was making decisions that should belong to Hermes:
- Bridge was building system prompts → should be Hermes
- Bridge was orchestrating conversation flow → should be Hermes
- Bridge was controlling LED state → should be Hermes (but they kept it for latency)
- Bridge was the active caller, Hermes was passive API → should be reversed

**Target architecture:** Hermes owns StackChan. Bridge is just MCP server + audio/protocol/vision execution layer. This validates our dual-target design — the "thin bridge" pattern works for Hermes, and our "native node" pattern works for OpenClaw. Same robot, different backend, same principles.

## What's Directly Useful For Our Project

### 1. Hermes Integration Blueprint
This repo IS the Hermes integration. We can study exactly how:
- MCP tools are defined and called
- Webhook-driven conversation flow works
- Per-person memory sessions work
- The bridge-to-Hermes API contract works

### 2. XiaoZhi Protocol Reference
The full server-side XiaoZhi protocol implementation confirms our WebSocket message flow.

### 3. Opus Audio Parameters
16kHz mono, 60ms frames, complexity=10, soxr resampling — all proven working parameters.

### 4. Face Tracking Algorithm
The smoothing/dead-zone/rate-limit/multi-person algorithm is directly reusable for our Phase 2 servo work.

### 5. LED State Machine
Clean state→color mapping for conversation phases. Directly borrowable.

### 6. GC0308 Pin Mapping (ALTERNATIVE)
Their pin mapping differs from stackchan-mcp's. We need to verify which is correct for our CoreS3 board revision. **This is important** — two repos with different pin configs means at least one is wrong or they target different board revisions.

### 7. Natural Stranger Registration
The LLM-driven registration flow (no regex, no state machine) is a better UX than any explicit registration UI. Worth considering for our Phase 3.

### 8. Streaming TTS Pipeline
Sentence-level LLM→TTS pipeline with barge-in support. Our WebRTC Talk path handles this differently (gateway-side), but the pattern is worth studying.

## What's NOT Useful / Different

1. **Python bridge architecture** — we want native ESP-IDF firmware, not a Python middleman
2. **SenseVoiceSmall ASR** — Chinese-specific, we use Whisper/OpenClaw STT
3. **Sherpa-ONNX TTS** — Chinese-specific, we use OpenClaw TTS
4. **XiaoZhi firmware** — they run stock XiaoZhi firmware, we run custom ESP-IDF
5. **Chinese-only** — system prompts, TTS, ASR all Chinese. We need English/multilingual
6. **No wake word on-device** — they use "hai san san" via XiaoZhi's MultiNet, we use ESP-SR WakeNet

## GC0308 Camera Pin Controversy

**Two different pin mappings for the same camera on the same board:**

| Pin | stackchan-mcp | robot-bridge |
|-----|---------------|--------------|
| XCLK | GPIO 2 | GPIO 15 |
| SIOD (SDA) | GPIO 12 | GPIO 4 |
| SIOC (SCL) | GPIO 11 | GPIO 5 |
| D0 (Y2) | GPIO 39 | GPIO 20 |
| D1 (Y3) | GPIO 40 | GPIO 7 |
| D2 (Y4) | GPIO 41 | GPIO 8 |
| D3 (Y5) | GPIO 42 | GPIO 9 |
| D4 (Y6) | GPIO 15 | GPIO 10 |
| D5 (Y7) | GPIO 16 | GPIO 11 |
| D6 (Y8) | GPIO 47 | GPIO 16 |
| D7 (Y9) | GPIO 48 | GPIO 3 |
| VSYNC | GPIO 46 | GPIO 6 |
| HREF | GPIO 38 | GPIO 18 |
| PCLK | GPIO 45 | GPIO 17 |

**This is a RED FLAG.** We MUST verify the correct pin mapping for our specific CoreS3 board revision before camera init. Getting this wrong could damage the camera or cause I2C bus conflicts. Plan: test both configs during Phase 2 camera bring-up and document which works.

## Comparison: All 5 Repos Analyzed

| Aspect | PlaiPin | stackchan-mcp | stackchan-atoms3r | robot-bridge | Our Approach |
|--------|---------|---------------|-------------------|--------------|-------------|
| Architecture | REST proxy | MCP→HTTP REST | HTTP+SSE | XiaoZhi WS→Hermes | Native WS+WebRTC |
| Build | Arduino/PlatformIO | Arduino/PlatformIO | ESP-IDF/PlatformIO | Arduino (firmware) | ESP-IDF |
| Hardware | CoreS3 | CoreS3 | AtomS3R | CoreS3 | CoreS3 |
| Backend | OpenClaw | AI Agent (MCP) | Custom | **Hermes** | **OpenClaw + Hermes** |
| Audio | HTTP TTS | PCM TCP/UDP | 16kHz WAV+SSE | **Opus 16kHz WS** | WebRTC Opus |
| Wake word | SimpleVox | RMS VAD | Button | XiaoZhi MultiNet | WakeNet 9 |
| Face reg | None | None | None | **OpenCV+LBPH+LLM** | Phase 2 |
| Servo tracking | None | Manual | None | **Auto face track** | Phase 2 |
| LED states | None | None | None | **Full state machine** | Phase 2 |
| Tests | None | None | Host+QEMU | **11 E2E tests** | TBD |
| Production | No | No | No | **YES — deployed** | No (yet) |

## Key Insight

robot-bridge is the **most production-mature** Stack-chan agent integration in existence. It's been deployed, tested, and iterated through 21 features and 15 bug fixes. The architecture decisions, gotchas, and refactor plan are invaluable.

**For our OpenClaw + Hermes dual-target design:** robot-bridge gives us the complete Hermes-side blueprint. We can see exactly what MCP tools the Hermes agent needs, how the webhook-driven conversation flow works, and how to structure the bridge. Our native firmware approach eliminates the Python bridge entirely — the ESP32 talks directly to the gateway — but the tool definitions, conversation flow, and feature set are directly informed by what robot-bridge already proved works.