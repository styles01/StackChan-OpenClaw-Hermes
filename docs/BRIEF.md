# Project Brief — StackChan-OpenClaw-Hermes

## Vision

**Build a thin audio client pipeline for ESP32 robots — piloted on Stack-chan, designed for reuse on Larry the Elephant.**

Stack-chan has a polished body (cute face, servo gestures, camera, LED, touch). Larry the Elephant has a working V2 architecture (RPi thin client → Mac server → STT/LLM/TTS → WAV back). We're combining them: ESP32 becomes a thin audio client like Larry's Pi, but with a robot body attached.

**Two robots, one pipeline:**
- **Pilot:** Stack-chan on ESP32 → mini does STT/LLM/TTS → ESP32 plays WAV
- **Follow-on:** Larry the Elephant on ESP32 → same mini, same pipeline, different plush

This is a dry run. We prove the thin audio client on Stack-chan first because it has a screen, servos, and a mature firmware base (plaipin's PlatformIO fork). Then we port Larry's Pi Python code to the same ESP32 pattern.

## Architecture — "Larry V2 Thin Audio Client"

```
┌──────────────────────────────────────────────┐
│  ESP32 (Stack-chan OR Larry) — THIN CLIENT   │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ Body (STAYS AS-IS for Stack-chan)      │  │
│  │  m5avatar face + expressions           │  │
│  │  SCSCL servos (yaw + pitch)            │  │
│  │  GC0308 camera                         │  │
│  │  WS2812 LED ×12                        │  │
│  │  FT6336 touch (head-pet)               │  │
│  │  M5.Speaker / M5.Mic (half-duplex)     │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ Thin Audio Client (OUR FIRMWARE)       │  │
│  │  1. Record audio (M5.Mic, VAD/button)  │  │
│  │  2. HTTP POST WAV to mini              │  │
│  │  3. Receive WAV response               │  │
│  │  4. Play WAV (M5.Speaker)              │  │
│  │  5. Parse body commands from response  │  │
│  │  6. Drive face/servo/LED from commands │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
          │ HTTP POST (WAV audio + metadata)
          ▼
┌──────────────────────────────────────────────┐
│  Clawdio-Mini — THE SERVER (Larry V2 style)  │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ Audio Pipeline Server (Node.js/Python) │  │
│  │  Receives WAV from ESP32               │  │
│  │  ┌─ STT (Whisper/Parakeet) ─────────┐  │  │
│  │  ├─ Route text to OpenClaw Gateway ─┤  │  │
│  │  ├─ Get text response ──────────────┤  │  │
│  │  ├─ TTS (Kokoro, 24kHz) ────────────┤  │  │
│  │  └─ Return WAV + body commands ─────┘  │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ OpenClaw Gateway (port 18789)          │  │
│  │  Rosie agent (Stack-chan)              │  │
│  │  Larry agent (separate session)        │  │
│  │  Tools, memory, personality, MCP       │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

**Key principle:** The ESP32 knows NOTHING about STT, LLM, TTS, API keys, WebSocket protocols, or gateway internals. It records audio, sends it to the mini, and plays back what the mini sends. The mini does ALL the heavy lifting — exactly like Larry's Mac server does for the Pi today.

## Why This Architecture (Larry V2 Pattern)

1. **Proven on Larry the Elephant.** Larry V2 runs this exact pattern: Pi records audio → sends WAV to Mac → Mac does Whisper STT → LLM → Kokoro TTS → returns WAV → Pi plays it. We're porting this from Pi→Mac to ESP32→Mini. Same architecture, different hardware.

2. **No API keys on the device.** ESP32 has zero cloud credentials. No Google STT key, no OpenAI key, no Groq key. Everything routes through the mini. This is critical for Larry (kids' toy with no security) and clean for Stack-chan.

3. **Thin client = less firmware.** We DELETE plaipin's STT classes (CloudSpeechClient, Whisper, ModuleLLMASR), TTS classes (WebVoiceVox, ElevenLabs, OpenAITTS, AquesTalk), and LLM client — replacing ALL of them with a single HTTP POST that sends WAV and gets WAV back. ~300-400 lines of new firmware vs. maintaining ~2000 lines of plaipin's STT/TTS/LLM pipeline.

4. **Stack-chan body stays untouched.** Face, servo, camera, LED, petting, scanning — all stay as-is. We only replace the brain (STT/LLM/TTS pipeline) with the thin audio client.

5. **Dual-robot reuse.** The mini's audio pipeline server handles both Stack-chan and Larry. Different agents (Rosie vs. Larry), different system prompts, different voices — same STT/TTS infrastructure. Add a new robot = add a new agent session on the gateway.

6. **Half-duplex is fine.** Larry V2, Stack-chan, and robot-bridge all ship half-duplex. The ESP32 records OR plays, never both. No AEC needed.

## Larry V2 → Stack-chan Mapping

| Larry V2 (Pi → Mac) | Stack-chan (ESP32 → Mini) | Notes |
|---|---|---|
| Pi records audio (sounddevice, 44.1kHz) | ESP32 records (M5.Mic, 16kHz) | M5.Mic outputs 16kHz directly — no resampling needed |
| WebRTC VAD (Python, webrtcvad) | VAD in C++ or button trigger | Stack-chan already has button/head-pet triggers; VAD is a nice-to-have |
| Noise filtering (energy threshold, voice ratio) | Simple energy threshold in C++ | Pi's calibration logic can be simplified for ESP32 |
| HTTP POST WAV to Mac (requests library) | HTTP POST WAV to mini (HTTPClient) | Same pattern, different HTTP library |
| Mac does Whisper STT (faster-whisper subprocess) | Mini does STT (Whisper or Parakeet) | Mini is more powerful than Mac was for Larry |
| Mac calls LM Studio (OpenAI-compatible API) | Mini calls OpenClaw Gateway | Upgrade from LM Studio to real agentic gateway |
| Mac does Kokoro TTS → WAV | Mini does Kokoro TTS → WAV | Same Kokoro pipeline, already on mini |
| Mac returns WAV to Pi | Mini returns WAV to ESP32 | Same |
| Pi plays WAV (sounddevice, ALSA) | ESP32 plays WAV (M5.Speaker) | Different audio API but same concept |
| Pi plays local samples (greeting, trumpet) | ESP32 plays local samples | Stack-chan already has core sounds |
| Larry effect markers `[trumpet]` | Stack-chan body commands `[expression:happy]` | Same pattern — markers in LLM response, parsed client-side |
| Session manager (MAX_TURNS, memory file) | OpenClaw handles sessions + memory | Upgrade — gateway does what Larry's Python did |

## What We Reuse from Larry V2

| Larry component | Reuse? | How |
|---|---|---|
| Server architecture (WAV in → STT → LLM → TTS → WAV out) | **Reuse pattern directly** | Identical flow — port to Node.js or keep Python |
| `transcribe_respond_and_speak` endpoint | **Reuse concept** | Our `/audio` endpoint does the same thing |
| `transcribe_respond_and_speak_stream` (SSE streaming) | **Defer to v1.1** | Same as plaipin — ship non-streaming first |
| Whisper worker subprocess | **Reuse concept** | Parakeet or OpenClaw's built-in Whisper on mini |
| Kokoro TTS pipeline | **Reuse directly** | Already on mini, British voice for Rosie |
| Session manager (history + memory file) | **Adapt** | OpenClaw handles sessions, but session pattern is useful |
| Latency logging (NTP-style two-clock) | **Reuse** | Useful for tuning ESP32 ↔ mini round-trip |
| Gibberish detection (confidence threshold) | **Reuse** | Same — low confidence → play local sample instead |
| Effect markers `[trumpet]` | **Evolve into body commands** | `[expression:happy] [gesture:nod] [led:blue]` |
| VAD + noise filtering (Python) | **Port concept to C++** | Pi does this in Python; ESP32 needs C++ equivalent |

## What We're NOT Doing (v1)

- ❌ NOT building ESP-IDF firmware from scratch (rosie-node is throwaway)
- ❌ NOT using plaipin's STT/TTS classes (replaced by thin audio client)
- ❌ NOT using WebRTC (half-duplex is fine, no AEC needed)
- ❌ NOT using LVGL (Stack-chan's m5avatar face stays)
- ❌ NOT reinventing servo/camera/LED drivers (Stack-chan already has them)
- ❌ NOT streaming audio (defer to v1.1 — ship `stream: false` first)
- ❌ NOT building Hermes routing (defer to v2 — ship OpenClaw-only first)
- ❌ NOT a closed-source project — goes open source

## What We ARE Doing

1. **Fork plaipin's Stack-chan firmware** — for the body code (face, servo, camera, LED, touch, MainLoop)
2. **Replace the STT/LLM/TTS pipeline with a thin audio client** — one HTTP POST, WAV in, WAV out
3. **Run an audio pipeline server on the mini** — Larry V2 style: receive WAV → STT → OpenClaw → TTS → return WAV
4. **Add body command parsing** — agent appends `[expression:happy] [gesture:nod] [led:blue]`, ESP32 parses and drives the body
5. **Configure the agent** — Rosie's system prompt on the gateway, with body command format in the system prompt
6. **Design for Larry reuse** — the audio pipeline server and thin client pattern will be reused for Larry the Elephant on ESP32

## The Thin Audio Client (what the ESP32 does)

```
1. TRIGGER: Button press, head-pet, or VAD detects speech
2. RECORD: M5.Mic records 16kHz mono PCM (fixed duration or VAD-stopped)
3. ENCODE: Wrap PCM as WAV header (simple, no encoding needed)
4. SEND: HTTP POST WAV to mini:18790/audio
5. RECEIVE: WAV response (TTS audio) + JSON metadata (body commands)
6. PLAY: M5.Speaker plays the WAV
7. ACT: Parse body commands, drive face/servo/LED
```

That's it. No STT, no LLM, no TTS, no API keys on the ESP32. Seven steps, one HTTP call.

## The Audio Pipeline Server (what the mini does)

```
1. RECEIVE: HTTP POST with WAV audio from ESP32
2. STT: Transcribe WAV (Whisper, Parakeet, or OpenClaw's built-in STT)
3. LLM: Send transcribed text to OpenClaw Gateway (WebSocket)
4. RESPONSE: Get text response from agent (with body command markers)
5. TTS: Convert text to speech (Kokoro, 24kHz, British voice)
6. RETURN: WAV audio + body commands JSON to ESP32
```

This is Larry V2's `transcribe_respond_and_speak` endpoint, adapted for OpenClaw Gateway instead of LM Studio.

## Response Format (agent → robot)

The server returns multipart or JSON with WAV audio + body commands:

```json
{
  "audio": "<base64-encoded WAV or multipart attachment>",
  "transcript": "what the user said",
  "response_text": "what the agent said (with markers stripped)",
  "body": {
    "expression": "happy",
    "servo": { "yaw": -30, "pitch": 45, "speed": 50 },
    "gesture": "nod",
    "led": "blue"
  }
}
```

- `audio` — WAV audio for M5.Speaker playback
- `body.expression` — m5avatar expression: neutral/happy/sad/angry/sleepy/doubt
- `body.servo` — optional servo command (yaw ±90°, pitch 10-70°, speed 0-100)
- `body.gesture` — optional gesture: nod/shake/look_around
- `body.led` — optional LED state: off/green/blue/rainbow

The `body` field is optional. If absent, robot just plays the audio with neutral expression.

Body commands are generated by the agent via system prompt markers — agent appends `[expression:happy] [gesture:nod]` to its response, the server parses them out before TTS and includes them in the JSON.

## Hardware Target

**M5Stack Stack-chan (CoreS3)** — unchanged from stock:

| Component | Chip | Status |
|-----------|------|--------|
| MCU | ESP32-S3 | 16MB flash, 8MB PSRAM |
| Speaker | AW88298 | M5.Speaker — plays WAV from mini |
| Mic | ES7210 | M5.Mic — records audio for mini |
| Display | ILI9342 | m5avatar face — works as-is |
| Servos | SCSCL ×2 | M5StackChan.Motion — works as-is |
| Camera | GC0308 | esp_camera — works as-is |
| Touch | FT6336/Si12T | Head-pet — works as-is |
| LED | WS2812C ×12 | Works as-is |

**Nothing changes on the hardware side.** We're swapping the brain, not the body.

## Reference Repos & Code

| Source | Role | What we take |
|------|------|-------------|
| [PlaiPin/plaipin-openclaw-stackchan](https://github.com/PlaiPin/plaipin-openclaw-stackchan) | **FORK BASE** | Body code, MainLoop, config, platformio.ini, partition table. We DELETE their STT/TTS/LLM classes and replace with thin audio client. |
| **Larry V2** (`lobster_audio.py`, `lobster_audio_server.py`) | **ARCHITECTURE BLUEPRINT** | Thin audio client pattern — WAV in, WAV out. Server does STT → LLM → TTS. This is the reference for both Stack-chan AND future Larry ESP32 port. |
| [migratorywhale/stackchan-mcp](https://github.com/migratorywhale/stackchan-mcp) | Hardware reference | GC0308 pins, servo patterns, camera I2C release |
| [waynecc-at/robot-bridge](https://github.com/waynecc-at/robot-bridge) | Hermes reference | LED state machine, face tracking, Opus params (for v2) |
| [taranton/stackchan-gemini-firmware](https://github.com/taranton/stackchan-gemini-firmware) | Hardware patterns | Emotion states, servo gestures, XCLK gotcha |

## Success Criteria

1. **Stack-chan talks to Rosie** — press button / pet head → speak → Rosie responds through the robot's speaker with her personality, tools, and memory
2. **No API keys on the ESP32** — zero cloud credentials stored on the device
3. **Body commands work** — agent can say "look left", "act happy", "turn LED green" and the robot does it
4. **Larry V2 pattern proven on ESP32** — the thin audio client works on ESP32, paving the way for Larry's Pi → ESP32 port
5. **Community adoption** — people on r/StackChan link to our repo instead of asking "is there a GitHub link?"

## Future: Larry the Elephant on ESP32

This project is the dry run. Once the thin audio client pipeline works on Stack-chan:

1. **Same firmware pattern, different body** — Larry doesn't have a screen or servos, but has LED, speaker, mic, and plush body
2. **Same mini server** — audio pipeline server already handles STT/TTS, just needs a Larry agent session on the gateway
3. **Port Larry's Python client logic to C++** — VAD, noise calibration, local sample playback, effect markers
4. **Larry's HEART.md + MEMORY.md** → agent system prompt on gateway (same as Larry V2 does today)
5. **Replace Pi with ESP32** — cheaper, lower power, smaller form factor for a kids' toy

The win: we build the pipeline once, use it for two robots. Stack-chan gets a smart brain, Larry gets off the Pi.

## Hard Rules

1. **Backup stock firmware BEFORE flashing** — full 16MB dump via esptool first
2. **Stack-chan firmware stays PlatformIO/Arduino** — no ESP-IDF conversion
3. **Don't touch the body** — face, servo, camera, LED, petting, scanning all stay as-is
4. **The mini is the middleman** — ESP32 never talks directly to the gateway, never has API keys
5. **No API keys on the ESP32** — all cloud calls go through the mini

## Team

- **James** — project lead, hardware owner, firmware testing, Larry the Elephant creator
- **Rosie** — adapter development, server, gateway config, documentation