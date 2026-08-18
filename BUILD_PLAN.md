# Build Plan — Stack-chan Thin Audio Client

## Goal
Give Stack-chan a smart brain with zero cloud API keys on the device. v1: swap plaipin's STT/TTS backends to point at the mini. v1.1: collapse to a thin audio client. The mini server is the same in both versions.

## Architecture — v1 Swap-Backends

```
┌──────────────────────────────────────────────────┐
│  ESP32 (Stack-chan) — SWAPPED BACKENDS           │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ Body (STAYS AS-IS — plaipin's code)        │  │
│  │  m5avatar face + expressions + lip sync    │  │
│  │  SCSCL servos (yaw + pitch)                │  │
│  │  WS2812 LED ×12                            │  │
│  │  FT6336 touch (screen regions)             │  │
│  │  M5.Speaker / M5.Mic (half-duplex)         │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ Existing pipeline (KEPT — just retargeted) │  │
│  │  STTBase → sends WAV to mini (not Google)  │  │
│  │  LLMBase → OpenClawClient (already works)  │  │
│  │  TTSBase → sends text to mini (not cloud)  │  │
│  │  Robot.cpp / AiStackChanMod → UNCHANGED    │  │
│  │  lipSync (tts->getLevel) → UNCHANGED       │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
          │ STT: HTTP POST WAV → mini:18790/stt
          │ LLM: already via OpenClawClient → proxy → gateway
          │ TTS: HTTP POST text → mini:18790/tts → WAV back
          ▼
┌──────────────────────────────────────────────────┐
│  Clawdio-Mini — AUDIO PIPELINE SERVER            │
│                                                  │
│  /stt   → WAV in → Whisper/Parakeet → text out   │
│  /tts   → text in → strip markers → Kokoro       │
│           → WAV out + body commands JSON         │
│  parser → regex [expression:happy] etc.          │
│                                                  │
│  OpenClaw Gateway (port 18789)                   │
│    Rosie agent · Tools · Memory · MCP            │
└──────────────────────────────────────────────────┘
```

**Key principle:** Keep plaipin's pipeline structure. Change WHERE backends send requests, not HOW the pipeline works. Lip sync, triggers, conversation flow, async TTS — all stay intact.

## What We're Building (3 pieces)

### Piece 1: Retargeted Backends (ESP32, ~100-200 LOC)

Keep plaipin's `STTBase`/`LLMBase`/`TTSBase` abstract interfaces. Implement new concrete backends:

- **New STT backend (`MiniSTT.cpp`):** Implements `STTBase::speech_to_text()`. Records audio via M5.Mic (existing `AudioWhisper.cpp` code), HTTP POSTs WAV to mini's `/stt` endpoint, receives text + confidence back. ~50-80 LOC.
- **LLM backend:** Already works. Plaipin's `OpenClawClient` → `openclaw-rest-proxy.js` → gateway WebSocket. No changes needed.
- **New TTS backend (`MiniTTS.cpp`):** Implements `TTSBase::stream()`. HTTP POSTs text to mini's `/tts` endpoint, receives WAV back, plays through M5.Speaker. Must provide `getLevel()` for lip sync (reuse plaipin's audio level tracking). ~50-80 LOC.
- **Body command parser (`BodyCommandParser.cpp`):** Parses `[expression:happy]` markers from agent response text. Called from the TTS backend or from `AiStackChanMod` after `robot->speech()`. ~40-60 LOC.

**What stays untouched:**
- `Robot.cpp` — factory + facade, no changes needed
- `AiStackChanMod.cpp` — trigger logic, conversation flow, no changes
- `main.cpp` — lipSync task, servo task, no changes
- `platformio.ini` — add build flags for new backends, remove old API key fields

### Piece 2: Audio Pipeline Server (on mini, ~400-500 LOC)

Python server (reuse Larry V2 patterns directly):

- **`/stt` endpoint:** Receives WAV → runs Whisper/Parakeet → returns JSON `{ text, confidence }`
- **`/tts` endpoint:** Receives text → strips body command markers → runs Kokoro TTS → returns WAV + JSON `{ body_commands }`
- **Body command parser:** Regex-parses `[expression:happy]`, `[gesture:nod]`, `[led:blue]`, `[servo:...]` from text, strips them, returns clean text + parsed commands
- **Confidence/gibberish detection:** Low confidence → flag for ESP32 to handle (TME mode in Larry V2)
- Runs as systemd service on Clawdio-Mini

### Piece 3: Agent Configuration (on gateway)
- Configure "rosie-robot" agent session on OpenClaw Gateway
- System prompt: Rosie's personality + body command format + short response instruction
- Tools: household, printer, fridge, memory, Telegram
- Voice: Kokoro British voice

## ESP32 Memory Considerations

- **ESP32-S3:** ~320KB internal SRAM, 8MB PSRAM
- **Audio buffers MUST use PSRAM:** `heap_caps_malloc(..., MALLOC_CAP_SPIRAM)` — never let large buffers land in internal RAM
- **TTS response:** plaipin already streams MP3 through a 30KB `AudioFileSourceBuffer` — this pattern works for our WAV responses too
- **`HTTPClient.getString()` is forbidden for audio:** Use `http.getStream()` and read into PSRAM-allocated buffer
- **No base64-in-JSON for audio:** Raw WAV body with metadata in HTTP headers or small JSON wrapper

## Response Format — Markers-in-Text (FINAL)

Agent appends markers to response text. Server strips them before TTS.

**Agent output:** `The printer is 40% done! [expression:happy] [gesture:nod] [led:blue]`
**Server returns:** clean WAV audio + `{ "body": { "expression": "happy", "gesture": "nod", "led": "blue" } }`

ONE format, not two. Matches Larry V2's `parse_effects` pattern.

## Build Phases

### Phase 1: Fork & Flash Stock (1 day)
- [ ] Full 16MB flash backup (HARD RULE — `esptool read_flash 0 0x1000000`)
- [ ] Fork from Stack-chan (MIT) — NOT plaipin (no license)
- [ ] Port plaipin's OpenClawClient + REST proxy concepts as reference
- [ ] Flash unmodified firmware to Stack-chan — verify body works (face, servo, touch)
- [ ] **MILESTONE: Stack-chan boots, body works**

### Phase 2: Audio Pipeline Server on Mini (1-2 days)
- [ ] Port Larry V2's `lobster_audio_server.py` pattern
- [ ] `/stt` endpoint: WAV in → Whisper/Parakeet → text + confidence out
- [ ] `/tts` endpoint: text in → strip markers → Kokoro TTS → WAV + body commands out
- [ ] Body command marker parser (regex)
- [ ] Test: `curl -F audio=test.wav http://mini:18790/stt` → text back
- [ ] Test: `curl -d "hello world [expression:happy]" http://mini:18790/tts` → WAV + JSON back
- [ ] systemd service on mini (auto-start, auto-restart)
- [ ] **MILESTONE: Server works with curl — no ESP32 needed**

### Phase 3: Retarget Backends (2-3 days)
- [ ] Write `MiniSTT` class (implements `STTBase`) — POST WAV to mini `/stt`, get text back
- [ ] Write `MiniTTS` class (implements `TTSBase`) — POST text to mini `/tts`, get WAV back, play through M5.Speaker, provide `getLevel()` for lip sync
- [ ] Write `BodyCommandParser` class — parse markers → drive face/servo/LED
- [ ] Update `platformio.ini` — select new backends, remove old API key fields
- [ ] Update config — point to mini's IP:18790, no cloud API keys
- [ ] Flash to Stack-chan
- [ ] **MILESTONE: Press button → speak → Rosie responds through robot speaker**

### Phase 4: Agent Configuration (1 day)
- [ ] Configure "rosie-robot" agent session on gateway
- [ ] System prompt: Rosie personality + body command format + short responses
- [ ] Wire up tools (printer, fridge, memory, Telegram, household)
- [ ] Test: "What's the printer status?" → robot responds + drives body
- [ ] **MILESTONE: Robot does useful agentic work**

### Phase 5: Polish & Testing (1-2 days)
- [ ] End-to-end testing (button → speak → respond → body commands)
- [ ] Calibrate audio levels (mic gain, speaker volume)
- [ ] Test body commands (expression changes, servo gestures, LED states)
- [ ] Error handling (server down → avatar text "Connection error" + sad face, like plaipin already does)
- [ ] Latency logging (reuse Larry V2's two-clock reconciliation)
- [ ] Write README (community-first framing per swarm3-gamma)
- [ ] Clean up, commit, push
- [ ] **MILESTONE: Polished, documented, open-source-ready**

### Phase 6 (FUTURE): Larry the Elephant on ESP32
- [ ] Larry ESP32 firmware uses thin audio client pattern (v1.1), not swap-backends
- [ ] Same mini server — just a different agent session (Larry's HEART.md)
- [ ] Port Larry's VAD, noise calibration, local samples to C++
- [ ] Test with Larry's plush body (LED, speaker, mic — no screen/servos)

## v1.1: Thin Audio Client (after v1 is working)
- [ ] Collapse 3 round-trips to 1 (`ThinAudioClient` class)
- [ ] Delete plaipin's STT/TTS/LLM classes (now safe — server validated)
- [ ] Add VAD (energy threshold or WebRTC-style in C++)
- [ ] Add streaming audio (SSE — like Larry V2's streaming endpoint)
- [ ] Add local error audio samples
- [ ] Add noise calibration (Larry's p95 × multiplier approach)
- [ ] Add gibberish detection (confidence threshold → TME mode)

## v2: Hermes Routing (deferred)
- [ ] Proxy routes to OpenClaw OR Hermes based on config
- [ ] Dual-gateway switching without firmware change

## v3: Real-time Streaming with Interruption (deferred)
- [ ] Borrow patterns from ChatGPT-live and OpenClaw/Hermes live modes
- [ ] Streaming audio chunks with interruption handling
- [ ] Same skeleton (audio in → STT → LLM → TTS → audio out), different transport

## File Structure

```
/Volumes/1TBSSDClawd/stackchan-node/
├── analysis/                       # Research reports
│   ├── swarm-*.md                  # Swarm 1 + 2 + 3 reports + synthesis
│   └── *-repo-analysis.md          # Reference repo analyses
├── repos/                          # Reference repos (not tracked)
│   ├── plaipin-openclaw-stackchan/ # Concept reference (NOT fork base)
│   └── ...
├── firmware/                       # Our fork (to create)
│   ├── platformio.ini             # Modified — new backends, no cloud API keys
│   ├── src/
│   │   ├── stt/
│   │   │   ├── MiniSTT.cpp         # NEW — sends WAV to mini /stt
│   │   │   └── MiniSTT.h
│   │   ├── tts/
│   │   │   ├── MiniTTS.cpp         # NEW — sends text to mini /tts, plays WAV
│   │   │   └── MiniTTS.h
│   │   ├── BodyCommandParser.cpp   # NEW — parses [expression:happy] etc.
│   │   ├── BodyCommandParser.h
│   │   ├── Robot.cpp               # UNCHANGED — factory + facade
│   │   ├── AiStackChanMod.cpp      # UNCHANGED — triggers + conversation flow
│   │   ├── main.cpp                # UNCHANGED — lipSync, servo task
│   │   └── ...                     # Body code stays from Stack-chan
│   └── ...
├── server/                         # Audio pipeline server (on mini)
│   ├── audio_pipeline.py           # NEW — /stt + /tts endpoints
│   ├── body_command_parser.py      # NEW — regex marker stripping
│   ├── whisper_worker.py           # NEW — STT subprocess (from Larry V2)
│   ├── kokoro_tts.py               # NEW — TTS module
│   └── requirements.txt
├── docs/
│   ├── BRIEF.md
│   └── LARRY-V2-REFERENCE.md
├── BUILD_PLAN.md
├── TODO.md
└── analysis/
    └── swarm3-synthesis.md         # Swarm 3 findings
```

## Revised Effort Estimate

| Phase | Time | What |
|-------|------|------|
| 1. Fork & Flash Stock | 1 day | Backup, fork from Stack-chan, flash, verify body |
| 2. Audio Pipeline Server | 1-2 days | /stt + /tts endpoints, body command parser, curl-testable |
| 3. Retarget Backends | 2-3 days | MiniSTT + MiniTTS + BodyCommandParser, flash |
| 4. Agent Config | 1 day | Rosie on gateway, system prompt, tools |
| 5. Polish | 1-2 days | Testing, calibration, README, commit |
| **Total (v1)** | **~1-1.5 weeks** | Swap-backends working end-to-end |
| v1.1 Thin Client | ~3-5 days | Collapse to single HTTP call, delete old classes |
| Phase 6 Larry ESP32 | ~1 week | Thin client on ESP32 for Larry's body |

## Key Decisions (Resolved)

1. ~~Thin audio client vs swap-backends~~ → **Swap-backends for v1** (smallest change, nothing breaks). Thin client is v1.1.
2. ~~Fork base~~ → **Fork from Stack-chan (MIT)**, not plaipin (no license). Credit plaipin as inspiration.
3. ~~Repo name~~ → **Rename to `stackchan-thin-audio-client`** or `stackchan-openclaw` (current name oversells Hermes)
4. ~~Response format~~ → **Markers-in-text, parsed server-side** (Larry V2 pattern, ONE format)
5. ~~Body commands~~ → `[expression:happy] [gesture:nod] [led:blue]` in agent text, server strips before TTS
6. ~~Streaming~~ → **Defer to v1.1** (ship non-streaming first)
7. ~~Hermes~~ → **Defer to v2**
8. ~~Camera/vision~~ → **Not in v1** (ENABLE_CAMERA undefined, future work)
9. ~~VAD~~ → **Button trigger for v1** (VAD is v1.1)
10. ~~Error handling~~ → **Text-on-avatar for v1** (reuse plaipin's existing pattern, audio samples are v1.1)
11. ~~Server language~~ → **Python for v1** (reuse Larry V2 directly)
12. ~~Open source framing~~ → **Platform-first** ("dumb audio terminal, no API keys"), Larry as footnote

## Status
- [x] Repo analysis (6 repos + 3 swarm rounds + syntheses)
- [x] Architecture decision (swap-backends for v1, thin client for v1.1)
- [x] BRIEF rewritten (swap-backends + swarm findings)
- [x] BUILD_PLAN rewritten
- [ ] TODO updated
- [ ] Phase 1: Fork & Flash Stock
- [ ] Phase 2: Audio Pipeline Server on Mini
- [ ] Phase 3: Retarget Backends
- [ ] Phase 4: Agent Configuration
- [ ] Phase 5: Polish & Testing
- [ ] Phase 6: Larry the Elephant on ESP32 (future)

## Larry V2 Reference

**Source files:**
- `/Users/clawdio/Larry-android-port/lobster_audio.py` — Pi client (VAD, noise filtering, HTTP POST, WAV playback)
- `/Users/clawdio/Larry-android-port/lobster_audio_server.py` — Mac server (Whisper STT, LM Studio LLM, Kokoro TTS, session manager, latency logging)

**Key parameters:**
- Sample rate: 16kHz mono (M5.Mic outputs 16kHz natively — no resampling)
- VAD: WebRTC aggressiveness 3, 30ms chunks, 350ms pause (v1.1 for ESP32)
- Whisper model: "tiny" (mini can run larger)
- LLM max tokens: 80 (short responses = faster TTS)
- TTS: Kokoro, British voice, 24kHz output
- Gibberish detection: confidence < -0.8 → play local sample (v1.1)
- Effect markers: `[trumpet]` → evolved to `[expression:happy] [gesture:nod] [led:blue]`