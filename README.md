# Stack-chan OpenClaw

### The ESP32 is a dumb audio terminal. No API keys on the device.

Turn a Stack-chan robot into a voice-controlled agent powered by [OpenClaw](https://github.com/openclaw/openclaw) — with zero cloud API keys on the robot itself. All intelligence runs on your local machine; the ESP32 just records, sends, receives, and plays.

---

## What can it do?

- 🎙️ **Voice conversation** — press the button, speak, get a spoken response
- 🤖 **Any OpenClaw agent personality** — bring your own agent, give it a voice
- 🎭 **Body commands** — the agent controls the robot's face, servos, and LED via text markers in its response
- 🔒 **Fully local** — STT (faster-whisper), LLM (your model), TTS (Kokoro) all run on your machine
- 🧩 **Minimal firmware changes** — keeps 95% of Stack-chan's original code intact

## Architecture

```
┌──────────────────┐         ┌─────────────────────────────────────────┐
│                  │  WAV    │                                         │
│   ESP32 (robot)  │────────▶│  Mini / Local Machine                   │
│                  │  POST   │                                         │
│  ┌────────────┐  │         │  ┌──────────┐  ┌──────┐  ┌──────────┐  │
│  │ M5.Mic     │  │         │  │  /stt    │  │      │  │  /tts    │  │
│  │ (16kHz)    │  │────────▶│  │ faster-  │  │ Open │  │ Kokoro   │  │
│  │            │  │  text   │  │ whisper  │  │ Claw │  │ TTS      │  │
│  └────────────┘  │  back   │  └──────────┘  └──────┘  └──────────┘  │
│                  │         │                    │                     │
│  ┌────────────┐  │  text   │              ┌─────┴─────┐               │
│  │ Speaker    │◀│─────────│              │  Gateway   │               │
│  │ + Avatar   │  │  WAV   │              │  (agent +  │               │
│  │ + Servos   │  │  back  │              │   tools)   │               │
│  └────────────┘  │         │              └───────────┘               │
│                  │         │                                         │
│  ┌────────────┐  │  JSON   │  ┌──────────────────┐                     │
│  │ OpenClaw   │─────────▶│  │  REST Proxy       │                     │
│  │ Client     │  │  resp  │  │  (HTTP → WS)      │                     │
│  └────────────┘  │         │  └──────────────────┘                     │
└──────────────────┘         └─────────────────────────────────────────┘
```

### The Three Hops

1. **STT** — ESP32 records audio, POSTs WAV to `mini:18791/stt`, gets text back
2. **LLM** — ESP32 sends text to OpenClaw via REST proxy → Gateway WebSocket → agent responds
3. **TTS** — ESP32 POSTs response text to `mini:18791/tts`, gets WAV back, plays it

The LLM hop already works via plaipin's `OpenClawClient`. Only STT and TTS need new backends.

## Bring Your Own Personality

The robot doesn't care what agent it talks to — any OpenClaw agent works. You define the personality with a system prompt that:

- Keeps responses short (~80 tokens, ~20 seconds of speech)
- Uses body command markers to control the robot: `[expression:happy] [gesture:nod] [led:blue]`
- Knows it's speaking aloud, not writing text

See [`docs/agent-template.md`](docs/agent-template.md) for a starter template.

## Quick Start

### Prerequisites

- An ESP32-S3 dev board with M5Stack firmware (Stack-chan or compatible)
- A local machine with:
  - Python 3.9+
  - [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
  - [Kokoro TTS](https://github.com/kokoro-xtts/kokoro)
  - [OpenClaw](https://github.com/openclaw/openclaw) Gateway running
  - Node.js (for the REST proxy)

### Build Phases

| Phase | What | Status |
|-------|------|--------|
| 1 | Backup flash, flash firmware, verify body works | 🔄 In Progress |
| 2 | Audio server (STT + TTS endpoints on mini) | 📋 Planned |
| 3 | Firmware swap — new STT/TTS backends in Robot.cpp | 📋 Planned |
| 4 | OpenClaw agent session + wake word | 📋 Planned |
| 5 | Body commands + polish | 📋 Planned |

See [`BUILD_PLAN.md`](BUILD_PLAN.md) for the full technical plan and [`TODO.md`](TODO.md) for the task breakdown.

## Credits

- **[Stack-chan](https://github.com/meganetaaan/stack-chan)** — the adorable robot body (MIT License)
- **[plaipin](https://github.com/plaipin/stack-chan)** — OpenClaw client integration inspiration
- **[OpenClaw](https://github.com/openclaw/openclaw)** — agent runtime and Gateway

## License

MIT — same as Stack-chan. Fork it, build it, make it yours.