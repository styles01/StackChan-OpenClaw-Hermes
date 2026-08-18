# Project Brief — Stack-chan Thin Audio Client

## Vision

**Give Stack-chan a smart brain with zero API keys on the device.**

The ESP32 records audio, sends it to the mini, the mini does STT → LLM → TTS, and returns audio. Stack-chan plays it back. The robot's body (face, servos, LED, touch) stays untouched. The ESP32 is a dumb audio terminal — your server does all the thinking.

**Two robots, one pipeline:**
- **Pilot:** Stack-chan on ESP32 → mini does STT/LLM/TTS → ESP32 plays audio back
- **Follow-on:** Larry the Elephant on ESP32 → same mini, same pipeline, different plush

## Architecture — v1 Swap-Backends, v1.1 Thin Audio Client

### v1: Swap Backends (keep plaipin's pipeline, change where it sends requests)

The simplest path to a working robot. We keep plaipin's existing `STTBase`/`LLMBase`/`TTSBase` interfaces and robot orchestration (`Robot.cpp`, `AiStackChanMod.cpp`, `main.cpp` lipSync) completely intact. We just change WHERE the backends send their requests — to the mini instead of cloud APIs.

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
          │ STT: HTTP POST WAV → mini
          │ LLM: already via OpenClawClient → proxy → gateway
          │ TTS: HTTP POST text → mini → WAV back
          ▼
┌──────────────────────────────────────────────────┐
│  Clawdio-Mini — AUDIO PIPELINE SERVER            │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ /stt endpoint                               │  │
│  │  Receives WAV → STT (Whisper/Parakeet)      │  │
│  │  Returns text + confidence                  │  │
│  ├────────────────────────────────────────────┤  │
│  │ /tts endpoint                               │  │
│  │  Receives text → TTS (Kokoro, 24kHz)        │  │
│  │  Returns WAV audio                          │  │
│  │  Strips body command markers before TTS     │  │
│  │  Returns body commands in JSON              │  │
│  ├────────────────────────────────────────────┤  │
│  │ Body command parser                         │  │
│  │  Regex-parses [expression:happy] etc.       │  │
│  │  from agent response text                   │  │
│  │  Returns clean text + body JSON             │  │
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

**Why swap-backends for v1:**
- **Smallest change:** ~100-200 LOC of new backend code vs ~500+ LOC for a full ThinAudioClient rewrite
- **Nothing breaks:** lipSync, conversation mod, trigger logic, async TTS task all stay intact
- **Faster to ship:** retarget existing classes instead of writing new ones
- **The server is identical:** the mini's audio pipeline server is the same regardless of client approach

### v1.1: Thin Audio Client (collapse 3 round-trips to 1)

Once swap-backends proves the server works, optimize the firmware:
- Replace the 3-step pipeline (STT → LLM → TTS separate calls) with a single `ThinAudioClient`
- One HTTP POST: WAV in → mini does STT → LLM → TTS → WAV out
- Delete plaipin's STT/TTS/LLM classes (now safe — we've validated the server)
- Add VAD, streaming, local error samples

### Shared Architecture Insight

This same pattern (audio in → STT → LLM → TTS → audio out) is what ChatGPT-live, OpenClaw, and Hermes all do with slight variations in transport, streaming, and interruption handling. Our server is a **generic audio agent gateway** — the same skeleton serves all of these harnesses.

## Why This Architecture

1. **Proven pattern.** Larry V2 runs this exact flow: Pi records audio → sends to Mac → STT → LLM → TTS → returns audio → Pi plays it. We're porting from Pi→Mac to ESP32→Mini.

2. **No API keys on the device.** ESP32 has zero cloud credentials. No Google STT key, no OpenAI key, no Groq key. Everything routes through the mini. The robot can't leak what it doesn't have.

3. **Minimal firmware changes (v1).** We keep plaipin's pipeline structure and just retarget the backends. The body code (face, servo, LED, touch, lip sync) stays 100% intact.

4. **Stack-chan body stays untouched.** Face, servo, LED, touch all stay as-is. Camera is NOT compiled in by default (ENABLE_CAMERA undefined) — enabling it is future work, not a preserved feature.

5. **Dual-robot reuse.** The mini's audio pipeline server handles both Stack-chan and Larry. Different agents, different system prompts, different voices — same STT/TTS infrastructure.

6. **Half-duplex is fine.** Larry V2, Stack-chan, and robot-bridge all ship half-duplex. No AEC needed.

## What We're Building (3 pieces)

### Piece 1: Retargeted Backends (ESP32, ~100-200 LOC)
- Keep plaipin's `STTBase`/`LLMBase`/`TTSBase` abstract interfaces
- Keep `Robot.cpp`, `AiStackChanMod.cpp`, `main.cpp` (lipSync, triggers, conversation flow) unchanged
- **New STT backend:** sends WAV to mini's `/stt` endpoint → gets text + confidence back
- **LLM backend:** already works (plaipin's `OpenClawClient` → proxy → gateway)
- **New TTS backend:** sends text to mini's `/tts` endpoint → gets WAV back → play through M5.Speaker
- **Body command parser:** new class that parses `[expression:happy]` markers from agent response → drives face/servo/LED

### Piece 2: Audio Pipeline Server (on mini, ~400-500 LOC)
- Larry V2-style server with two endpoints:
  - `/stt` — receives WAV, does Whisper/Parakeet STT, returns text + confidence
  - `/tts` — receives text, strips body command markers, does Kokoro TTS, returns WAV + body commands JSON
- Body command marker parsing (regex, like Larry's `parse_effects`)
- Runs as systemd service on Clawdio-Mini
- Python for v1 (reuse Larry's server patterns directly)

### Piece 3: Agent Configuration (on gateway)
- Configure a "rosie-robot" agent session on OpenClaw Gateway
- System prompt includes Rosie's personality + body command format
- Tools wired up (household, printer, fridge, memory, Telegram)
- Voice: Kokoro British voice for consistency

## What We're NOT Doing (v1)

- ❌ NOT deleting plaipin's STT/TTS/LLM classes (that's v1.1)
- ❌ NOT writing a ThinAudioClient (that's v1.1)
- ❌ NOT building ESP-IDF firmware from scratch
- ❌ NOT using WebRTC (half-duplex is fine)
- ❌ NOT enabling camera/vision (ENABLE_CAMERA undefined — future work)
- ❌ NOT streaming audio (defer to v1.1)
- ❌ NOT building Hermes routing (defer to v2)
- ❌ NOT adding VAD (button trigger is fine for v1)
- ❌ NOT creating local error audio samples (text-on-avatar is the v1 fallback)

## What We ARE Doing (v1)

1. **Retarget STT backend** → mini's `/stt` endpoint instead of Google/Groq
2. **Keep LLM backend** → plaipin's OpenClawClient already works
3. **Retarget TTS backend** → mini's `/tts` endpoint instead of ElevenLabs/OpenAI
4. **Build mini server** → two endpoints (STT, TTS) + body command parser
5. **Add body command parser** → parse `[expression:happy]` markers → drive face/servo/LED
6. **Configure agent** → Rosie's system prompt on gateway with body command format

## Response Format — Markers-in-Text (FINAL)

The agent appends body command markers to its text response. The mini server parses them out before TTS and returns them as JSON.

**Agent response (raw):**
```
The printer is 40% done with the benchy! [expression:happy] [gesture:nod] [led:blue]
```

**Server parses → strips markers → TTS clean text → returns:**
```json
{
  "audio": "<WAV bytes or multipart>",
  "transcript": "what the user said",
  "response_text": "The printer is 40% done with the benchy!",
  "body": {
    "expression": "happy",
    "gesture": "nod",
    "led": "blue"
  }
}
```

**Body command markers:**
- `[expression:happy]` → m5avatar expression: neutral/happy/sad/angry/sleepy/doubt
- `[gesture:nod]` → gesture: nod/shake/look_around
- `[led:blue]` → LED: off/green/blue/rainbow
- `[servo:yaw:-30,pitch:45]` → direct servo command (optional)

This matches Larry V2's `parse_effects` pattern and plaipin's existing emoji stripping. ONE format, not two.

## Triggers (what starts a conversation)

Plaipin's existing trigger logic stays UNCHANGED:
- **Button A press** → `STT_ChatGPT()` → `robot->listen()` → `robot->chat()` → `robot->speech()`
- **Screen touch** (top-right region) → same flow
- **Wake word** (cores3 build, `ENABLE_WAKEWORD`) → same flow
- ~~Head-pet~~ → **does not exist in plaipin's code** (screen touch is the actual trigger, not petting)

The trigger logic lives in `AiStackChanMod.cpp`, not in the STT/TTS/LLM classes. Retargeting backends doesn't touch triggers at all.

## Auth Model

- WiFi credentials: stored on device (unavoidable, not a security issue)
- `/stt` and `/tts` endpoints: no auth for v1 (LAN-only, bind to local network)
- OpenClaw bearer token: currently in plaipin's config — can be removed if the proxy doesn't require it, or kept if the gateway needs it
- "Zero API keys" means zero CLOUD API keys — WiFi + optional LAN token are fine

## Hardware Target

**M5Stack Stack-chan (CoreS3)** — unchanged from stock:

| Component | Chip | Status |
|-----------|------|--------|
| MCU | ESP32-S3 | 16MB flash, 8MB PSRAM |
| Speaker | AW88298 | M5.Speaker — plays audio from mini |
| Mic | ES7210 | M5.Mic — records audio for mini |
| Display | ILI9342 | m5avatar face — works as-is |
| Servos | SCSCL ×2 | M5StackChan.Motion — works as-is |
| Camera | GC0308 | NOT compiled in by default (future work) |
| Touch | FT6336/Si12T | Screen regions — works as-is |
| LED | WS2812C ×12 | Works as-is |

## License Strategy

**Fork from Stack-chan (MIT-licensed), not plaipin (no license).**

Plaipin's repo has NO license file — under copyright law, that's "all rights reserved." We cannot legally add MIT to a fork of unlicensed code. Instead:
- Fork from Stack-chan directly (MIT-licensed, clean)
- Port plaipin's *concepts* (REST proxy, OpenClaw integration) as reference — write our own code
- Credit plaipin in the README as inspiration
- Add MIT license to our new code
- Keep Larry's HEART.md/MEMORY.md and Rosie's actual system prompt PRIVATE (ship an `agent-template.md` instead)

## Open Source Framing

**Lead with the platform, not the personal project.**
- README headline: "The ESP32 is a dumb audio terminal. No API keys on the device."
- Stack-chan is the demonstration platform
- Larry the Elephant is a charming footnote, not the headline
- "No API keys on the ESP32" is our strongest differentiator — no other Stack-chan fork does this
- Ship `agent-template.md` (personality format), not actual personalities
- The thin audio client pattern IS the contribution — a new way to build a robot brain

## Reference Repos & Code

| Source | Role | What we take |
|------|------|-------------|
| [m5stack/AiStackChan](https://github.com/m5stack/AiStackChan) | **FORK BASE (MIT)** | Body code, MainLoop, config, platformio.ini |
| [PlaiPin/plaipin-openclaw-stackchan](https://github.com/PlaiPin/plaipin-openclaw-stackchan) | **CONCEPT REFERENCE** | OpenClawClient pattern, REST proxy, partition table concepts |
| **Larry V2** (`lobster_audio.py`, `lobster_audio_server.py`) | **ARCHITECTURE BLUEPRINT** | Server pattern — WAV in → STT → LLM → TTS → WAV out |
| [migratorywhale/stackchan-mcp](https://github.com/migratorywhale/stackchan-mcp) | Hardware reference | GC0308 pins, servo patterns, camera I2C release |
| [waynecc-at/robot-bridge](https://github.com/waynecc-at/robot-bridge) | Hermes reference | LED state machine, face tracking, Opus params (for v2) |

## Success Criteria

1. **Stack-chan talks to Rosie** — press button → speak → Rosie responds through the robot's speaker with her personality, tools, and memory
2. **No cloud API keys on the ESP32** — zero cloud credentials stored on the device (WiFi + optional LAN token are fine)
3. **Body commands work** — agent can say "look left", "act happy", "turn LED green" and the robot does it
4. **Pipeline proven on ESP32** — the swap-backends approach works, paving the way for v1.1 thin client and Larry's ESP32 port
5. **Community adoption** — people on r/StackChan link to our repo instead of asking "is there a GitHub link?"

## Future

### v1.1: Thin Audio Client
- Collapse 3 round-trips to 1 (ThinAudioClient replaces STT/TTS/LLM pipeline)
- Delete plaipin's STT/TTS/LLM classes (now safe — server validated)
- Add VAD (energy threshold or WebRTC-style in C++)
- Add streaming audio (SSE — like Larry V2's `transcribe_respond_and_speak_stream`)
- Add local error audio samples
- Add noise calibration

### v2: Hermes Routing
- Proxy routes to OpenClaw OR Hermes based on config
- Dual-gateway switching without firmware change

### v3: Real-time Streaming with Interruption
- Borrow patterns from ChatGPT-live and OpenClaw/Hermes live modes
- Streaming audio chunks with interruption handling
- Same architecture skeleton (audio in → STT → LLM → TTS → audio out), different transport

### Phase 6: Larry the Elephant on ESP32
- Same mini server — just a different agent session
- Larry's HEART.md + MEMORY.md → agent system prompt on gateway
- Larry ESP32 firmware uses the thin audio client pattern (v1.1), not swap-backends
- Replace Pi with ESP32 — cheaper, lower power, smaller form factor

## Hard Rules

1. **Backup stock firmware BEFORE flashing** — full 16MB dump via esptool first
2. **Stack-chan firmware stays PlatformIO/Arduino** — no ESP-IDF conversion
3. **Don't touch the body** — face, servo, LED, touch all stay as-is
4. **The mini is the middleman** — ESP32 never talks directly to cloud APIs
5. **No cloud API keys on the ESP32** — all cloud calls go through the mini
6. **Fork from Stack-chan (MIT), not plaipin (no license)** — credit plaipin as inspiration

## Team

- **James** — project lead, hardware owner, firmware testing, Larry the Elephant creator
- **Rosie** — adapter development, server, gateway config, documentation