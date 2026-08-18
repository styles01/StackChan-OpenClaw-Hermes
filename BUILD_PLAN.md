# Build Plan — Stack-chan OpenClaw Audio Client

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
│  │  WakeWord (SimpleVox MFCC+DTW) — cores3    │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ Existing pipeline (KEPT — just retargeted) │  │
│  │  STTBase → MiniSTT: POST WAV to mini /stt  │  │
│  │  LLMBase → OpenClawClient (already works)  │  │
│  │  TTSBase → MiniTTS: POST text to mini /tts │  │
│  │  Robot.cpp / AiStackChanMod → UNCHANGED    │  │
│  │  lipSync (tts->getLevel) → UNCHANGED       │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
          │ STT: HTTP POST WAV → mini:18791/stt
          │ LLM: already via OpenClawClient → proxy:18790 → gateway:18789
          │ TTS: HTTP POST text → mini:18791/tts → WAV back
          ▼
┌──────────────────────────────────────────────────┐
│  Clawdio-Mini — AUDIO PIPELINE SERVER            │
│                                                  │
│  :18791  audio_pipeline.py (FastAPI)             │
│    /stt   → WAV in → faster-whisper → text+conf  │
│    /tts   → text in → strip markers → Kokoro     │
│             → WAV out + body_commands JSON       │
│    parser → regex [expression:happy] etc.        │
│                                                  │
│  :18790  openclaw-rest-proxy.js (Node)            │
│    ESP32 OpenClawClient → OpenAI-shaped POST     │
│    → WebSocket → Gateway                         │
│                                                  │
│  :18789  OpenClaw Gateway                         │
│    Rosie agent · Tools · Memory · MCP            │
└──────────────────────────────────────────────────┘
```

**Key principle:** Keep plaipin's pipeline structure. Change WHERE backends send requests, not HOW the pipeline works. Lip sync, triggers, conversation flow, async TTS, wake word — all stay intact.

## What We're Building (3 pieces)

### Piece 1: Retargeted Backends (ESP32, ~150-200 LOC)

Keep plaipin's `STTBase`/`LLMBase`/`TTSBase` abstract interfaces. Add new `#define` constants and implement new concrete backends.

**Config changes (StackchanExConfig.h):**
```cpp
// Add to existing defines
#define STT_TYPE_MINI_WHISPER   4   // NEW — sends WAV to mini server
#define TTS_TYPE_MINI_KOKORO    5   // NEW — sends text to mini server

// Add to ExConfig struct (already has openclaw_s openclaw)
// Reuse openclaw_s for mini audio server host/port, OR add:
typedef struct MiniAudioConf {
    String host;
    int port;       // 18791
} mini_audio_s;
```

**New STT backend (`stt/MiniSTT.cpp` + `.h`):**
- Implements `STTBase::speech_to_text()` → returns `String`
- Records audio via M5.Mic (reuse plaipin's `AudioWhisper.cpp` — it already captures 16kHz mono WAV into a PSRAM buffer with `audio->GetBuffer()` and `audio->GetSize()`)
- HTTP POST multipart WAV to `http://<mini_host>:<mini_port>/stt`
- Parse JSON response `{ "text": "...", "confidence": 0.85 }`
- Return text string to `Robot::listen()` → `Robot::chat()`
- Pattern reference: plaipin's `Whisper.cpp` does exactly this but sends to Groq API — same multipart structure, just different host and no TLS
- ~60-80 LOC

**LLM backend — NO CHANGES NEEDED:**
- Plaipin's `OpenClawClient` already works via `openclaw-rest-proxy.js`
- ESP32 sends OpenAI-shaped HTTP POST → Node proxy → WebSocket → Gateway
- Robot.cpp `initLLM()` already has `case LLM_TYPE_OPENCLAW: llm = new OpenClawClient(...)` (line 155)

**New TTS backend (`tts/MiniTTS.cpp` + `.h`):**
- Implements `TTSBase::stream(String text)` and `int getLevel()`
- HTTP POST text to `http://<mini_host>:<mini_port>/tts`
- Receive WAV response via `http.getStream()` into PSRAM buffer
- Play WAV through M5.Speaker (use `AudioFileSourcePROGMEM` + `AudioGeneratorWAV` from ESP8266Audio, OR convert WAV to raw PCM and use `M5.Speaker.playRaw()`)
- `getLevel()` returns current audio amplitude for lip sync — reuse plaipin's pattern from `PlayMP3.cpp` where `*out.getBuffer()` gives the current sample
- **CRITICAL:** Use `http.getStream()`, NEVER `http.getString()` for audio data
- **CRITICAL:** Allocate WAV buffer from PSRAM: `heap_caps_malloc(size, MALLOC_CAP_SPIRAM)`
- Pattern reference: plaipin's `OpenAITTS.cpp` streams MP3 via `AudioFileSourceHttpsPostStream` + `AudioFileSourceBuffer` + `playMP3()` — we do similar but HTTP (not HTTPS) and WAV (not MP3)
- ~80-100 LOC

**Body command parser (`BodyCommandParser.cpp` + `.h`):**
- Parses `[expression:happy]` markers from LLM response text
- Called from `AiStackChanMod` after `robot->llm->chat()` returns, before `robot->tts->stream(text)`
- Strips markers from text, drives avatar/servo/LED
- `[expression:happy]` → `avatar.setExpression(happy)`
- `[gesture:nod]` → `servo->moveToGaze()` sequence
- `[led:blue]` → `M5.Power.setLed(0x0000ff)`
- `[servo:yaw:-30,pitch:45]` → `servo->moveToGaze(-30, 45)`
- Actually: server strips markers before TTS, sends clean text + body commands JSON. ESP32 receives both via TTS response headers or small JSON preamble.
- ~40-60 LOC

**What stays untouched:**
- `Robot.cpp` — factory + facade. Add 2 cases to initSTT/initTTS switch statements. ~4 LOC each.
- `AiStackChanMod.cpp` — trigger logic (Button A, screen touch, wake word), conversation flow
- `main.cpp` — lipSync task, servo task
- `driver/WakeWord.cpp` — SimpleVox MFCC+DTW wake word (already works, independent of STT/TTS/LLM)
- `platformio.ini` — add build flags for new backends, remove cloud API key fields

### Piece 2: Audio Pipeline Server (on mini, ~400-500 LOC)

Python FastAPI server (reuse Larry V2 patterns directly). Larry's server is Flask on port 5000; ours is FastAPI on port 18791.

**Existing mini environment (verified):**
- `faster-whisper` 1.2.1 ✓
- `kokoro-onnx` 0.4.7 ✓ (also `kokoro` KPipeline available)
- `fastapi` 0.128.8 ✓
- `uvicorn` 0.39.0 ✓
- `openai-whisper` 20250625 ✓
- Larry's `lobster_audio_server.py` at `<your-home>/Larry-android-port/` ✓

**Endpoints:**

**`POST /stt` — Speech to Text**
- Receives: multipart WAV file (16kHz mono, same as M5.Mic output)
- Process: save to temp file → `faster-whisper` transcribe → extract text + avg_logprob confidence
- Returns: `{"text": "...", "confidence": -0.45}` (Larry V2's confidence scale: > -0.6 clear, < -0.8 gibberish)
- Reuse: Larry's `transcribe()` function (line 103 of lobster_audio_server.py) — already runs faster-whisper, returns (text, confidence)

**`POST /tts` — Text to Speech + Body Commands**
- Receives: text body (raw or JSON `{"text": "..."}`)
- Process: parse `[expression:happy]` markers → strip from text → Kokoro TTS → WAV
- Returns: WAV audio body + `X-Body-Commands` header (JSON) or JSON preamble
- Reuse: Larry's `parse_effects()` (line 165) — regex `\[(\w+)\]` pattern, adapted for `[key:value]` format
- Reuse: Larry's `generate_speech()` (line 123) — Kokoro KPipeline, `bm_george` voice, 24kHz output

**Body command parser (server-side, Python):**
```python
# Extended from Larry's parse_effects()
# Larry: [trumpet] → ("I love elephants!", ["trumpet"])
# Ours:  [expression:happy] [gesture:nod] → ("Hello!", [{"type":"expression","value":"happy"},...])
BODY_CMD_RE = r'\[(\w+):(\w+(?:,\w+:\w+)*)\]'
def parse_body_commands(text):
    commands = []
    for m in re.finditer(BODY_CMD_RE, text):
        cmd_type = m.group(1)
        params = dict(p.split(':') for p in m.group(2).split(','))
        commands.append({"type": cmd_type, **params})
    clean = re.sub(r'\s*\[\w+:.*?\]\s*', '', text).strip()
    return clean, commands
```

**`POST /chat` — Full Round Trip (v1.1, optional for v1)**
- Single endpoint: WAV in → STT → OpenClaw Gateway → TTS → WAV out
- Collapses 3 HTTP calls to 1 from ESP32's perspective
- This is the "thin audio client" server endpoint — exists in v1 but ESP32 doesn't use it until v1.1

**Server startup:**
- systemd service: `audio-pipeline.service` on mini
- Port 18791 (18789=gateway, 18790=rest proxy, 18791=audio)
- Auto-start, auto-restart

### Piece 3: Agent Configuration (on gateway)
- Configure "rosie-robot" agent session on OpenClaw Gateway
- System prompt: Rosie's personality + body command format + short response instruction
- Tools: household, printer, fridge, memory, Telegram
- Voice: Kokoro British voice (server-side, not gateway's TTS)
- LLM max tokens: 80 (Larry V2's setting — short responses = faster TTS)

## ESP32 Memory Rules (CRITICAL — from swarm3)

1. **`HTTPClient.getString()` is FORBIDDEN for audio responses** — buffers in internal SRAM (~320KB), will OOM on any real audio. Use `http.getStream()`.
2. **All audio buffers MUST use PSRAM** — `heap_caps_malloc(size, MALLOC_CAP_SPIRAM)`. 8MB PSRAM is sufficient IF allocated correctly.
3. **No base64-in-JSON for audio** — inflates payload 33%, forces full in-memory decode. Use raw WAV body + metadata in HTTP headers or small JSON wrapper.
4. **M5.Speaker needs full PCM in contiguous memory** — allocate from PSRAM, not fragmented heap.
5. **Plaipin's TTS already streams MP3 through a 30KB buffer** — `AudioFileSourceBuffer` + `playMP3()`. Our WAV approach needs similar streaming or full PSRAM allocation.

## Response Format — Markers-in-Text (FINAL)

Agent appends markers to response text. Server strips them before TTS.

**Agent output:** `The printer is 40% done! [expression:happy] [gesture:nod] [led:blue]`
**Server returns:** clean WAV audio + `X-Body-Commands: [{"type":"expression","value":"happy"},{"type":"gesture","value":"nod"},{"type":"led","value":"blue"}]`

ONE format, not two. Matches Larry V2's `parse_effects` pattern, evolved from `[trumpet]` to `[key:value]`.

## Wake Word System (BONUS — already built in plaipin)

Plaipin has a **custom wake word system** using MFCC + DTW via the `simplevox` library:
- `driver/WakeWord.cpp` — records 3s audio, extracts MFCC features, compares via DTW
- Threshold < 250 = match. Up to 10 wake words stored in SPIFFS (`/wakeword0.bin`)
- Called from `AiStackChanMod.cpp` idle loop → triggers `STT_ChatGPT()` (same as Button A)
- LLM can register/delete wake words via function calling (`register_wakeword`, `delete_wakeword`)
- Enabled via `-DENABLE_WAKEWORD` in platformio.ini (already set for cores3 builds)
- **Speaker-dependent** (matches YOUR voice saying the word, not a general keyword) — fine for household robot
- **Independent of STT/TTS/LLM pipeline** — swap-backends doesn't touch it

**Plan:** Enable wake word in Phase 4 or 5. James records "Rosie" as the wake word. No code needed — just the registration flow via LLM function calling or a simple config UI.

## Build Phases

### Phase 1: Fork & Flash Stock (1 day)
- [ ] Plug in Stack-chan via USB, detect serial port
- [ ] Full 16MB flash backup (HARD RULE — `esptool read_flash 0 0x1000000 backup_stackchan_stock.bin`)
- [ ] Save partition table: `esptool read_flash 0x8000 0x1000 backup_partition_table.bin`
- [ ] Verify backup is exactly 16MB
- [ ] Store backups on SSD: `/Volumes/1TBSSDClawd/stackchan-node/backups/`
- [ ] Fork from Stack-chan upstream (MIT) — NOT plaipin (no license)
- [ ] Clone plaipin as reference (concepts only, not code)
- [ ] Flash unmodified plaipin firmware to Stack-chan — verify body works
  - [ ] Face/avatar displays and animates
  - [ ] Servos move (yaw + pitch)
  - [ ] Touch screen responds
  - [ ] Button A triggers conversation
  - [ ] Speaker plays audio
  - [ ] Mic records audio
  - [ ] Wake word works (if cores3 build)
- [ ] **MILESTONE: Stack-chan boots, body works, plaipin firmware verified**

### Phase 2: Audio Pipeline Server on Mini (1-2 days)
- [ ] Create `server/audio_pipeline.py` based on Larry V2's `lobster_audio_server.py`
- [ ] Port Larry's `transcribe()` function (faster-whisper, returns text + confidence)
- [ ] Port Larry's `generate_speech()` function (Kokoro KPipeline, bm_george voice)
- [ ] Port Larry's `parse_effects()` → extend to `parse_body_commands()` for `[key:value]` format
- [ ] `POST /stt` endpoint: multipart WAV in → JSON `{text, confidence}` out
- [ ] `POST /tts` endpoint: text in → strip markers → Kokoro WAV out + body commands in `X-Body-Commands` header
- [ ] `GET /health` endpoint (for systemd watchdog)
- [ ] Use FastAPI + uvicorn (not Flask — already installed, async-friendly)
- [ ] Port 18791 (gateway=18789, proxy=18790, audio=18791)
- [ ] Test: `curl -F audio=test.wav http://localhost:18791/stt` → JSON text back
- [ ] Test: `curl -d "hello world [expression:happy]" http://localhost:18791/tts` → WAV + header back
- [ ] Test: `curl http://localhost:18791/health` → 200 OK
- [ ] systemd service: `audio-pipeline.service` (auto-start, auto-restart, watchdog)
- [ ] **MILESTONE: Server works with curl — no ESP32 needed**

### Phase 3: Retarget Backends (2-3 days)
- [ ] Add `STT_TYPE_MINI_WHISPER` and `TTS_TYPE_MINI_KOKORO` to `StackchanExConfig.h`
- [ ] Add `mini_audio_s` struct to ExConfig (host + port for mini server)
- [ ] Write `stt/MiniSTT.h` + `stt/MiniSTT.cpp`
  - [ ] `speech_to_text()`: record via M5.Mic (reuse AudioWhisper.cpp) → POST multipart WAV to `http://<host>:18791/stt` → parse JSON → return text
  - [ ] Use `WiFiClient` (HTTP, not HTTPS — mini is LAN)
  - [ ] No `getString()` for response — response is small JSON, OK to use `getString()` here (it's text, not audio)
  - [ ] Timeout: 10s (same as plaipin's Whisper STT)
- [ ] Write `tts/MiniTTS.h` + `tts/MiniTTS.cpp`
  - [ ] `stream(String text)`: POST text to `http://<host>:18791/tts` → receive WAV via `http.getStream()` → play through M5.Speaker
  - [ ] `getLevel()`: return current audio sample amplitude for lip sync
  - [ ] Allocate WAV receive buffer from PSRAM
  - [ ] Use HTTP (not HTTPS) — LAN only, no cert needed
  - [ ] Parse `X-Body-Commands` header → execute body commands via callbacks
- [ ] Write `BodyCommandParser.h` + `BodyCommandParser.cpp`
  - [ ] Parse JSON body commands from TTS response header
  - [ ] `expression` → `avatar.setExpression()`
  - [ ] `gesture` → servo gesture sequence (nod/shake/look_around)
  - [ ] `led` → LED state (off/green/blue/rainbow)
  - [ ] `servo` → `servo->moveToGaze(yaw, pitch)`
- [ ] Update `Robot.cpp` `initSTT()`: add `case STT_TYPE_MINI_WHISPER: stt = new MiniSTT(stt_param, mini_audio);`
- [ ] Update `Robot.cpp` `initTTS()`: add `case TTS_TYPE_MINI_KOKORO: tts = new MiniTTS(tts_param, mini_audio);`
- [ ] Update `platformio.ini`:
  - [ ] Set `STT_TYPE` to `4` (MINI_WHISPER)
  - [ ] Set `TTS_TYPE` to `5` (MINI_KOKORO)
  - [ ] Set `LLM_TYPE` to `4` (OPENCLAW — already works)
  - [ ] Remove cloud API key fields from config
  - [ ] Add mini audio server host/port to config
  - [ ] Keep `-DENABLE_WAKEWORD` (cores3)
- [ ] Update config file on device: mini host IP, port 18791, no API keys
- [ ] Flash to Stack-chan
- [ ] **MILESTONE: Press button → speak → Rosie responds through robot speaker + body moves**

### Phase 4: Agent Configuration (1 day)
- [ ] Configure "rosie-robot" agent session on OpenClaw Gateway
- [ ] Write system prompt with:
  - [ ] Rosie's personality (warm, funny, household ops director)
  - [ ] Body command format: `[expression:happy] [gesture:nod] [led:blue]`
  - [ ] Instruction to keep responses short (<200 chars, ~20 seconds of speech)
  - [ ] Instruction to use body commands naturally (express emotion, look around)
  - [ ] Tool availability (household, printer, fridge, memory, Telegram)
- [ ] Wire up tools:
  - [ ] rosie_status (household summary)
  - [ ] rosie_printer_status (3D printer)
  - [ ] rosie_fridge_update (fridge dashboard)
  - [ ] rosie_memory (memory search)
  - [ ] rosie_say (Telegram voice notes)
  - [ ] rosie_time
- [ ] Test: "What's the printer status?" → robot looks, thinks, speaks + body commands
- [ ] Optional: record "Rosie" as custom wake word via plaipin's registration flow
- [ ] **MILESTONE: Robot does useful agentic work through the pipeline**

### Phase 5: Polish & Testing (1-2 days)
- [ ] End-to-end test: button → speak → Rosie responds + body commands execute
- [ ] End-to-end test: wake word → speak → Rosie responds
- [ ] Calibrate audio levels (mic gain, speaker volume)
- [ ] Test all body commands (expression changes, servo gestures, LED states)
- [ ] Error handling:
  - [ ] Server down → avatar text "Connection error" + sad face (reuse plaipin's existing pattern)
  - [ ] WiFi not connected → avatar text "No WiFi" + sad face
  - [ ] STT returned empty → avatar text "Didn't catch that" + confused face
  - [ ] LLM timeout → avatar text "Thinking..." → "Sorry, took too long"
- [ ] Latency logging (reuse Larry V2's two-clock NTP-style reconciliation)
- [ ] Write README (community-first framing):
  - [ ] Headline: "The ESP32 is a dumb audio terminal. No API keys on the device."
  - [ ] Architecture diagram
  - [ ] "What can it do?" section (printer status, fridge, camera vision examples)
  - [ ] "Bring your own personality" — agent template, not actual prompts
  - [ ] "Also powers Larry" — one paragraph footnote
  - [ ] License: MIT, credit Stack-chan + plaipin inspiration
- [ ] Clean up code, commit, push
- [ ] **MILESTONE: Polished, documented, open-source-ready**

### Phase 6 (FUTURE): Larry the Elephant on ESP32
- [ ] Larry ESP32 firmware uses thin audio client pattern (v1.1), not swap-backends
- [ ] Port Larry's Pi Python client logic to ESP32 C++:
  - [ ] VAD (WebRTC-style in C++, or simpler energy threshold)
  - [ ] Noise calibration (reuse Larry's p95 × multiplier approach)
  - [ ] Local sample playback (greeting, trumpet — Larry's core sounds)
  - [ ] Effect markers (reuse Larry's `[trumpet]` pattern)
- [ ] Configure "larry" agent session on OpenClaw Gateway
  - [ ] Larry's HEART.md → system prompt (PRIVATE — not in repo)
  - [ ] Larry's MEMORY.md → agent memory (PRIVATE — not in repo)
- [ ] Same mini server — just a different agent session
- [ ] Test with Larry's plush body (LED, speaker, mic — no screen/servos)
- [ ] **MILESTONE: Larry the Elephant runs on ESP32 instead of Pi**

## v1.1: Thin Audio Client (after v1 is working)
- [ ] Add `POST /chat` endpoint to mini server (WAV in → STT → LLM → TTS → WAV out, one call)
- [ ] Write `ThinAudioClient` class — single HTTP POST, single WAV response
- [ ] Delete plaipin's STT/TTS/LLM classes (now safe — server validated)
- [ ] Add VAD on ESP32 (energy threshold or WebRTC-style in C++)
- [ ] Add VAD cooldown (1.8s after playback — prevents echo-loop, Larry V2 pattern)
- [ ] Add streaming audio (SSE — like Larry V2's `transcribe_respond_and_speak_stream`)
- [ ] Add local error audio samples ("I can't connect", "taking a while")
- [ ] Add noise calibration (Larry's p95 × 1.4 multiplier approach)
- [ ] Add gibberish detection (confidence < -0.8 → TME mode, play local sample)

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
├── firmware/                       # Our fork (to create from Stack-chan upstream)
│   ├── platformio.ini             # Modified — new backends, no cloud API keys
│   ├── src/
│   │   ├── stt/
│   │   │   ├── MiniSTT.cpp         # NEW — sends WAV to mini /stt
│   │   │   ├── MiniSTT.h
│   │   │   ├── STTBase.h           # KEPT from plaipin (clean interface)
│   │   │   └── AudioWhisper.cpp    # KEPT (mic recording code)
│   │   ├── tts/
│   │   │   ├── MiniTTS.cpp         # NEW — sends text to mini /tts, plays WAV
│   │   │   ├── MiniTTS.h
│   │   │   ├── TTSBase.h           # KEPT from plaipin (clean interface)
│   │   │   └── PlayMP3.cpp         # KEPT (audio playback utilities)
│   │   ├── llm/
│   │   │   ├── OpenClawClient.cpp  # KEPT (already works!)
│   │   │   ├── OpenClawClient.h
│   │   │   └── LLMBase.h           # KEPT
│   │   ├── BodyCommandParser.cpp   # NEW — parses body commands from TTS response
│   │   ├── BodyCommandParser.h
│   │   ├── Robot.cpp               # ~8 LOC changed (2 switch cases)
│   │   ├── AiStackChanMod.cpp      # UNCHANGED — triggers + conversation flow
│   │   ├── main.cpp                # UNCHANGED — lipSync, servo task
│   │   ├── driver/WakeWord.cpp     # KEPT — SimpleVox MFCC+DTW wake word
│   │   └── ...                     # Body code stays from Stack-chan
│   └── ...
├── server/                         # Audio pipeline server (on mini)
│   ├── audio_pipeline.py           # NEW — FastAPI /stt + /tts endpoints
│   ├── body_command_parser.py      # NEW — regex marker stripping
│   ├── whisper_worker.py           # NEW — STT subprocess (from Larry V2 pattern)
│   ├── kokoro_tts.py               # NEW — TTS module (from Larry V2 pattern)
│   ├── audio-pipeline.service      # NEW — systemd unit
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
| 4. Agent Config | 1 day | Rosie on gateway, system prompt, tools, wake word |
| 5. Polish | 1-2 days | Testing, calibration, README, commit |
| **Total (v1)** | **~1-1.5 weeks** | Swap-backends working end-to-end |
| v1.1 Thin Client | ~3-5 days | Collapse to single HTTP call, delete old classes |
| Phase 6 Larry ESP32 | ~1 week | Thin client on ESP32 for Larry's body |

## Key Decisions (Resolved)

1. ~~Thin audio client vs swap-backends~~ → **Swap-backends for v1** (smallest change, nothing breaks). Thin client is v1.1.
2. ~~Fork base~~ → **Fork from Stack-chan (MIT)**, not plaipin (no license). Credit plaipin as inspiration.
3. ~~Repo name~~ → **Rename to `stackchan-openclaw`** (current name oversells Hermes)
4. ~~Response format~~ → **Markers-in-text, parsed server-side** (Larry V2 pattern, ONE format)
5. ~~Body commands~~ → `[expression:happy] [gesture:nod] [led:blue]` in agent text, server strips before TTS, returns in HTTP header
6. ~~Streaming~~ → **Defer to v1.1** (ship non-streaming first)
7. ~~Hermes~~ → **Defer to v2**
8. ~~Camera/vision~~ → **Not in v1** (ENABLE_CAMERA undefined, future work)
9. ~~VAD~~ → **Button trigger + wake word for v1** (VAD cooldown is v1.1)
10. ~~Error handling~~ → **Text-on-avatar for v1** (reuse plaipin's existing pattern, audio samples are v1.1)
11. ~~Server language~~ → **Python/FastAPI for v1** (reuse Larry V2 directly, all deps installed)
12. ~~Open source framing~~ → **Platform-first** ("dumb audio terminal, no API keys"), Larry as footnote
13. ~~Wake word~~ → **Enable in Phase 4/5** (already built, just needs registration flow)
14. ~~LLM path~~ → **OpenClawClient already works** (no changes needed — REST proxy → gateway WebSocket)
15. ~~Server port~~ → **18791** (18789=gateway, 18790=REST proxy, 18791=audio pipeline)

## Codebase Reference (verified from plaipin source)

**Interface classes (the seams we swap at):**
- `STTBase` (`stt/STTBase.h`): `virtual String speech_to_text() = 0` — one method to implement
- `TTSBase` (`tts/TTSBase.h`): `virtual void stream(String text) = 0` + `virtual int getLevel()` — two methods
- `LLMBase` (`llm/LLMBase.h`): `virtual void chat(String text, const char *base64_buf = NULL) = 0` — already implemented by OpenClawClient

**Existing backends (for pattern reference):**
- `stt/Whisper.cpp` — multipart WAV POST to Groq API (our MiniSTT follows this pattern, HTTP not HTTPS)
- `tts/OpenAITTS.cpp` — HTTP POST text, stream MP3 back via `AudioFileSourceBuffer` + `playMP3()` (our MiniTTS follows this, WAV not MP3)
- `llm/OpenClawClient.cpp` — OpenAI-shaped POST to REST proxy → gateway WebSocket (ALREADY WORKS)

**Robot.cpp switch statements (where we add our backends):**
- `initLLM()` line 155: `case LLM_TYPE_OPENCLAW: llm = new OpenClawClient(llm_param, config.getExConfig().openclaw);`
- `initSTT()` line 197: `case STT_TYPE_GOOGLE: stt = new CloudSpeechClient(stt_param);` → add `case 4: stt = new MiniSTT(...)`
- `initTTS()` line 243: `case TTS_TYPE_WEB_VOICEVOX: tts = new WebVoiceVoxTTS(tts_param);` → add `case 5: tts = new MiniTTS(...)`

**Config constants (StackchanExConfig.h):**
- `LLM_TYPE_OPENCLAW = 4` (already exists)
- `STT_TYPE_MINI_WHISPER = 4` (NEW — we add)
- `TTS_TYPE_MINI_KOKORO = 5` (NEW — we add)

**Larry V2 reusable functions (from lobster_audio_server.py):**
- `transcribe(wav_path)` line 103 → faster-whisper, returns (text, confidence)
- `generate_speech(text)` line 123 → Kokoro KPipeline, bm_george, 24kHz
- `parse_effects(text)` line 165 → regex `[tag]` stripping → adapt to `[key:value]`
- `_log_latency(record)` line 180 → latency logging pattern

## Status
- [x] Repo analysis (6 repos + 3 swarm rounds + syntheses)
- [x] Architecture decision (swap-backends for v1, thin client for v1.1)
- [x] BRIEF rewritten (swap-backends + swarm findings)
- [x] BUILD_PLAN rewritten with codebase specifics
- [x] TODO updated
- [ ] Phase 1: Fork & Flash Stock
- [ ] Phase 2: Audio Pipeline Server on Mini
- [ ] Phase 3: Retarget Backends
- [ ] Phase 4: Agent Configuration
- [ ] Phase 5: Polish & Testing
- [ ] Phase 6: Larry the Elephant on ESP32 (future)

## Larry V2 Reference

**Source files:**
- `<your-home>/Larry-android-port/lobster_audio.py` — Pi client (VAD, noise filtering, HTTP POST, WAV playback)
- `<your-home>/Larry-android-port/lobster_audio_server.py` — Mac server (Whisper STT, LM Studio LLM, Kokoro TTS, session manager, latency logging)

**Key parameters:**
- Sample rate: 16kHz mono (M5.Mic outputs 16kHz natively — no resampling)
- VAD: WebRTC aggressiveness 3, 30ms chunks, 350ms pause (v1.1 for ESP32)
- Whisper model: "tiny" (mini can run larger — try "base" or "small")
- LLM max tokens: 80 (short responses = faster TTS)
- TTS: Kokoro, British voice (bm_george), 24kHz output
- Gibberish detection: confidence < -0.8 → play local sample (v1.1)
- Effect markers: `[trumpet]` → evolved to `[expression:happy] [gesture:nod] [led:blue]`