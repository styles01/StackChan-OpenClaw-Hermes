# StackChan-OpenClaw-Hermes — Build Plan

## Goal
Build a **thin audio client pipeline for ESP32 robots** — piloted on Stack-chan, designed for reuse on Larry the Elephant. The ESP32 records audio, sends it to the mini, the mini does STT → LLM → TTS, and returns WAV audio. ESP32 plays it back. Larry V2 architecture, ported from Pi→Mac to ESP32→Mini.

## Architecture — "Larry V2 Thin Audio Client"

```
┌──────────────────────────────────────────────────┐
│  ESP32 (Stack-chan) — THIN AUDIO CLIENT          │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ Body (STAYS AS-IS — plaipin's code)        │  │
│  │  m5avatar face + expressions               │  │
│  │  SCSCL servos (yaw + pitch)                │  │
│  │  GC0308 camera                              │  │
│  │  WS2812 LED ×12                             │  │
│  │  FT6336 touch (head-pet)                    │  │
│  │  M5.Speaker / M5.Mic (half-duplex)          │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ Thin Audio Client (OUR NEW CODE ~300 LOC)  │  │
│  │  1. Trigger: button press or head-pet      │  │
│  │  2. Record: M5.Mic → 16kHz mono PCM        │  │
│  │  3. Wrap as WAV header                     │  │
│  │  4. HTTP POST WAV to mini:18790/audio      │  │
│  │  5. Receive: WAV + body commands JSON      │  │
│  │  6. Play WAV through M5.Speaker            │  │
│  │  7. Parse body commands → face/servo/LED   │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
          │ HTTP POST (WAV audio)
          ▼
┌──────────────────────────────────────────────────┐
│  Clawdio-Mini — AUDIO PIPELINE SERVER            │
│  (Larry V2 pattern, adapted for OpenClaw)        │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ /audio endpoint (Node.js or Python)        │  │
│  │  1. Receive WAV from ESP32                 │  │
│  │  2. STT: Parakeet or Whisper → text        │  │
│  │  3. Send text to OpenClaw Gateway (WS)     │  │
│  │  4. Get agent response (text + markers)    │  │
│  │  5. Parse body command markers from text   │  │
│  │  6. TTS: Kokoro → WAV (24kHz, Brit voice)  │  │
│  │  7. Return: WAV audio + body commands JSON │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ OpenClaw Gateway (port 18789)              │  │
│  │  Rosie agent (Stack-chan session)          │  │
│  │  Larry agent (future — separate session)   │  │
│  │  Tools, memory, personality, MCP           │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

**Key principle:** ESP32 is a thin audio client. It knows NOTHING about STT, LLM, TTS, API keys, WebSocket, or gateway internals. It records audio, sends it, plays back what comes back. The mini does ALL the heavy lifting — exactly like Larry's Mac server does for the Pi today.

## What We're Building (3 pieces)

### Piece 1: Thin Audio Client Firmware (ESP32, ~300-400 LOC)
- Fork plaipin's Stack-chan firmware (keeps body code: face, servo, camera, LED, touch, MainLoop)
- **DELETE** plaipin's STT classes (CloudSpeechClient, Whisper, ModuleLLMASR) — not needed
- **DELETE** plaipin's TTS classes (WebVoiceVox, ElevenLabs, OpenAITTS, AquesTalk) — not needed
- **DELETE** plaipin's LLM classes (ChatGPT, Gemini, OpenClawClient, ModuleLLM) — not needed
- **NEW:** `ThinAudioClient` class — replaces the entire STT/LLM/TTS pipeline:
  - Records audio via M5.Mic (16kHz mono, fixed duration or VAD-stopped)
  - Wraps PCM as WAV (simple header, no encoding)
  - HTTP POST to mini:18790/audio
  - Receives WAV + body commands JSON
  - Plays WAV via M5.Speaker
  - Parses body commands → drives face/servo/LED via existing API
- **Reuse from plaipin:** platformio.ini (modified), partition table, config structure, MainLoop, body code
- **Reuse from Larry V2:** VAD concept, noise calibration concept, local sample playback, effect marker parsing (evolved into body commands)

### Piece 2: Audio Pipeline Server (on mini, ~500-600 LOC)
- Larry V2-style server that receives WAV, does STT → LLM → TTS, returns WAV
- **Option A: Python (direct port of Larry's server)**
  - Reuse Larry's `lobster_audio_server.py` pattern directly
  - Flask server, Whisper worker subprocess, Kokoro TTS
  - Adapt: route to OpenClaw Gateway instead of LM Studio
  - Adapt: parse body command markers from agent response
  - Pro: Larry's code already works, minimal changes
  - Con: Python on the mini (vs Node.js for plaipin's proxy)
- **Option B: Node.js (clean implementation)**
  - New server based on Larry V2 architecture but in Node.js
  - Calls OpenClaw Gateway WebSocket (like plaipin's proxy did)
  - Calls Whisper/Parakeet for STT
  - Calls Kokoro for TTS (or shells out to Python Kokoro)
  - Pro: Single language ecosystem on mini (Node.js)
  - Con: More new code
- **My recommendation: Option A (Python) for v1** — Larry's server already works. Port to Node.js later if we want consolidation. Ship faster.
- Runs as systemd service on Clawdio-Mini

### Piece 3: Agent Configuration (on gateway)
- Configure a "rosie-robot" agent session on OpenClaw Gateway
- System prompt includes:
  - Rosie's personality (warm, funny, household ops director)
  - Body command format: `[expression:happy] [gesture:nod] [led:blue]`
  - Instruction to keep responses short (<200 chars, ~20 seconds of speech)
  - Instruction to use body commands naturally (express emotion, look around, etc.)
- Tools wired up (household, printer, fridge, memory, Telegram)
- Voice: Kokoro British voice (bm_george or bf_emma) for consistency with Larry

## What We're NOT Building (v1)

- ❌ ESP-IDF firmware from scratch (rosie-node is throwaway)
- ❌ Plaipin's STT/TTS/LLM classes (DELETED — replaced by thin audio client)
- ❌ WebRTC audio pipeline (half-duplex is fine)
- ❌ LVGL display (m5avatar face stays)
- ❌ AEC / full-duplex audio (not needed)
- ❌ WakeNet wake word (use Stack-chan's existing button/VAD trigger)
- ❌ Custom servo/camera/LED drivers (Stack-chan already has them)
- ❌ Streaming audio (defer to v1.1 — ship non-streaming first, like Larry V2 non-streaming endpoint)
- ❌ Hermes routing (defer to v2 — ship OpenClaw-only first)
- ❌ Cloud API keys on the ESP32 (zero credentials on device)

## Response Format (server → ESP32)

The server returns JSON with base64-encoded WAV + body commands:

```json
{
  "audio": "base64-encoded-WAV-data",
  "sample_rate": 24000,
  "transcript": "what the user said",
  "response_text": "what the agent said (markers stripped)",
  "body": {
    "expression": "happy",
    "servo": { "yaw": -30, "pitch": 45, "speed": 50 },
    "gesture": "nod",
    "led": "blue"
  },
  "timings": {
    "stt": 0.3,
    "llm": 1.2,
    "tts": 0.5,
    "total": 2.0
  }
}
```

- `audio` — base64 WAV for M5.Speaker playback
- `body` — optional body commands (parsed from agent's response markers)
- `timings` — latency breakdown (like Larry V2's latency logging)

Body command markers (parsed from agent text before TTS):
- `[expression:happy]` → m5avatar expression: neutral/happy/sad/angry/sleepy/doubt
- `[gesture:nod]` → gesture: nod/shake/look_around
- `[led:blue]` → LED: off/green/blue/rainbow
- `[servo:yaw:-30,pitch:45]` → direct servo command

## Build Phases

### Phase 1: Fork & Flash Stock (1 day)
- [ ] Full 16MB flash backup of stock Stack-chan firmware (HARD RULE)
- [ ] Fork plaipin repo as our base
- [ ] Flash plaipin firmware UNMODIFIED to Stack-chan — verify body works (face, servo, touch)
- [ ] **MILESTONE: Stack-chan boots with plaipin firmware, body works**

### Phase 2: Audio Pipeline Server on Mini (1-2 days)
- [ ] Port Larry V2's `lobster_audio_server.py` pattern to a new server
- [ ] Adapt: route to OpenClaw Gateway WebSocket instead of LM Studio
- [ ] Add body command marker parsing (regex, like Larry's effect markers)
- [ ] Add Kokoro TTS (already on mini, British voice)
- [ ] Test: POST a WAV file → get WAV + JSON back (curl test, no ESP32 needed)
- [ ] **MILESTONE: Server works end-to-end with curl — WAV in, WAV + commands out**

### Phase 3: Thin Audio Client Firmware (2-3 days)
- [ ] Write `ThinAudioClient` class (replaces STT/LLM/TTS pipeline)
  - M5.Mic recording (16kHz mono, button-triggered for v1)
  - WAV header construction
  - HTTP POST to mini:18790/audio
  - Parse JSON response (audio + body commands)
  - M5.Speaker WAV playback
  - Body command execution (face/servo/LED)
- [ ] Remove/disable plaipin's STT, TTS, LLM classes from the build
- [ ] Update platformio.ini (set our config, remove STT/TTS API key fields)
- [ ] Update config (point to mini's IP:18790, no API keys needed)
- [ ] Flash to Stack-chan
- [ ] **MILESTONE: Press button → speak → Rosie responds through robot speaker**

### Phase 4: Agent Configuration (1 day)
- [ ] Configure "rosie-robot" agent session on OpenClaw Gateway
- [ ] Write system prompt with body command format + Rosie personality
- [ ] Wire up household tools (printer status, fridge, memory, Telegram)
- [ ] Test: "Hey Rosie, what's the printer status?" → robot looks, thinks, speaks
- [ ] **MILESTONE: Robot does useful agentic work through the pipeline**

### Phase 5: Polish & Testing (1-2 days)
- [ ] End-to-end test: pet head → speak → Rosie responds through robot
- [ ] Calibrate audio levels (mic gain, speaker volume)
- [ ] Test body commands (expression changes, servo gestures, LED states)
- [ ] Add error handling (server down, timeout, gibberish detection like Larry)
- [ ] Add latency logging (reuse Larry V2's two-clock NTP-style reconciliation)
- [ ] Clean up code, write README, commit and push
- [ ] **MILESTONE: Polished, documented, open-source-ready**

### Phase 6 (FUTURE): Larry the Elephant on ESP32
- [ ] Port Larry's Pi Python client logic to ESP32 C++ (VAD, noise calibration, samples)
- [ ] Configure "larry" agent session on OpenClaw Gateway (Larry's HEART.md + MEMORY.md)
- [ ] Same audio pipeline server — just a different agent session
- [ ] Test with Larry's plush body (LED, speaker, mic — no screen/servos)
- [ ] **MILESTONE: Larry the Elephant runs on ESP32 instead of Pi**

## File Structure

```
/Volumes/1TBSSDClawd/stackchan-node/
├── analysis/                       # Research reports (done)
│   ├── swarm-*.md                  # 4 swarm research reports
│   ├── swarm2-*.md                 # 4 swarm-2 reports + synthesis
│   └── *-repo-analysis.md          # 6 reference repo analyses
├── repos/                          # Reference repos (not tracked)
│   ├── plaipin-openclaw-stackchan/ # FORK BASE — body code + MainLoop
│   └── ...
├── firmware/                       # Our fork (to create)
│   ├── platformio.ini             # Modified — no STT/TTS API keys
│   ├── src/
│   │   ├── ThinAudioClient.cpp     # NEW — replaces STT/LLM/TTS pipeline
│   │   ├── ThinAudioClient.h       # NEW
│   │   ├── BodyCommandParser.cpp   # NEW — parses [expression:happy] etc
│   │   ├── BodyCommandParser.h     # NEW
│   │   ├── MainLoop.cpp            # Modified — calls ThinAudioClient
│   │   ├── Robot.cpp               # Modified — uses ThinAudioClient
│   │   └── ...                     # Body code stays from plaipin
│   └── ...
├── server/                         # Audio pipeline server (on mini)
│   ├── audio_pipeline.py           # NEW — Larry V2-style server
│   ├── whisper_worker.py           # NEW — STT subprocess (from Larry)
│   ├── kokoro_tts.py               # NEW — TTS module
│   ├── gateway_client.js           # NEW — OpenClaw WebSocket client
│   └── requirements.txt            # Python deps
├── docs/
│   ├── BRIEF.md                    # Project brief (updated)
│   └── LARRY-V2-REFERENCE.md       # How Larry V2 maps to our architecture
├── BUILD_PLAN.md                   # This file
├── TODO.md                         # Task list
└── CHANGELOG.md                    # Change log
```

## Revised Effort Estimate

| Phase | Time | What |
|-------|------|------|
| 1. Fork & Flash Stock | 1 day | Backup, fork, flash unmodified, verify body |
| 2. Audio Pipeline Server | 1-2 days | Port Larry V2 server pattern, adapt for OpenClaw |
| 3. Thin Audio Client | 2-3 days | Write ThinAudioClient, remove plaipin STT/TTS/LLM, flash |
| 4. Agent Config | 1 day | Rosie on gateway, system prompt, tools |
| 5. Polish | 1-2 days | Testing, calibration, error handling, docs |
| **Total (Stack-chan)** | **~1-1.5 weeks** | Pilot proven on ESP32 |
| 6. Larry ESP32 (future) | **~1 week** | Port Pi client to ESP32, configure Larry agent |

## Key Decisions (Resolved)

1. ~~Architecture A vs B vs C~~ → **Adapter pattern** (plaipin fork, PlatformIO/Arduino)
2. ~~Full-duplex / AEC~~ → **Half-duplex** (fine for both Stack-chan and Larry)
3. ~~esp-openclaw-room-node SDK~~ → **Not using** (locks to OpenClaw, kills Hermes)
4. ~~rosie-node ESP-IDF code~~ → **Throwaway** (Architecture A artifact)
5. ~~LVGL vs M5GFX~~ → **M5GFX/m5avatar stays**
6. ~~Wake word~~ → **Stack-chan's existing trigger** (button/head-pet)
7. ~~Dual-gateway~~ → **Defer Hermes to v2** (ship OpenClaw-only first)
8. ~~Streaming~~ → **Defer to v1.1** (ship non-streaming first, like Larry V2)
9. ~~Fork base~~ → **Plaipin fork + add MIT license** (pragmatic, attribute original)
10. ~~Body commands~~ → **System prompt markers** `[expression:happy] [gesture:nod] [led:blue]`
11. ~~STT/TTS~~ → **Thin audio client (Larry V2 pattern)** — ESP32 sends WAV to mini, mini does STT/TTS, returns WAV. No API keys on device. Replaces plaipin's entire STT/TTS/LLM pipeline.
12. ~~Repo name~~ → **Keep "StackChan-OpenClaw-Hermes"** (Hermes support is deferred but architecture supports it)

## Status
- [x] Repo analysis (6 repos + 4 swarm reports + 4 swarm-2 reports + synthesis)
- [x] Architecture decision (thin audio client / Larry V2 pattern)
- [x] BRIEF updated to Larry V2 thin audio client architecture
- [x] BUILD_PLAN rewritten
- [ ] Phase 1: Fork & Flash Stock
- [ ] Phase 2: Audio Pipeline Server on Mini
- [ ] Phase 3: Thin Audio Client Firmware
- [ ] Phase 4: Agent Configuration
- [ ] Phase 5: Polish & Testing
- [ ] Phase 6: Larry the Elephant on ESP32 (future)

## Larry V2 Reference

**Source files:**
- `/Users/clawdio/Larry-android-port/lobster_audio.py` — Pi client (VAD, noise filtering, HTTP POST, WAV playback)
- `/Users/clawdio/Larry-android-port/lobster_audio_server.py` — Mac server (Whisper STT, LM Studio LLM, Kokoro TTS, session manager, latency logging)

**Key parameters from Larry V2:**
- Sample rate: 16kHz mono (Pi resamples from 44.1kHz; ESP32 M5.Mic outputs 16kHz natively)
- VAD: WebRTC VAD aggressiveness 3, 30ms chunks, 350ms pause duration
- Noise filtering: min energy 0.005, min voice ratio 0.3, max noise 3000ms
- Whisper model: "tiny" (fast on Mac; mini can run larger)
- LLM max tokens: 80 (short responses = faster TTS)
- TTS: Kokoro, British voice (bm_george), 24kHz output
- Session: 10 turns max, 5min timeout → memory file update
- Gibberish detection: confidence < -0.8 → play local sample (TME mode)

**What we adapt for Stack-chan:**
- VAD: Port concept to C++ (or use button trigger for v1 — simpler)
- STT: Whisper or Parakeet on mini (instead of LM Studio)
- LLM: OpenClaw Gateway (instead of LM Studio direct)
- TTS: Kokoro on mini (same as Larry)
- Session: OpenClaw handles sessions (instead of Python SessionManager)
- Memory: OpenClaw handles memory (instead of MEMORY.md file)
- Effects → Body commands: `[trumpet]` → `[expression:happy] [gesture:nod] [led:blue]`
- Latency logging: Reuse Larry's two-clock NTP-style reconciliation