# Project Brief — StackChan-OpenClaw-Hermes

## Vision

**Replace the Stack-chan's weak chatbot brain with a real agentic harness.**

The Stack-chan robot already has a polished body — cute face, servo gestures, camera, LED emotions, petting/scanning interactions. But its AI is a dumb ChatGPT call with no tools, no memory, no personality, no agency.

We're replacing that brain with OpenClaw or Hermes — real agent harnesses with tools, memory, MCP, and personality. The body stays untouched. We're just hijacking the LLM call.

## Architecture

```
Stack-chan (Arduino/PlatformIO firmware — UNTOUCHED)
  ├── mic → records audio → STT → text
  ├── text → LLMBase.chat() → OUR ADAPTER
  │
  ├── OUR ADAPTER (implements LLMBase)
  │   ├── sends text + context to mini (Clawdio-Mini)
  │   └── receives response: text + emotion + body commands
  │
  ├── Mini (Clawdio-Mini) — the middleman
  │   ├── receives query from Stack-chan
  │   ├── routes to: OpenClaw Gateway OR Hermes Gateway
  │   ├── gateway does agentic work (tools, memory, personality, MCP)
  │   └── formats response back for Stack-chan's body
  │
  └── Stack-chan body responds:
      ├── TTS speaks the text
      ├── avatar.setExpression() drives the face
      ├── servo moves (look, nod, shake)
      └── LED shows emotion state
```

**Key principle:** The ESP32 doesn't know about WebSocket protocols, Ed25519, WebRTC, or gateway internals. It just calls `LLMBase::chat(text)` and gets back text + body commands. The mini handles all the gateway complexity.

## Why This Architecture

1. **Stack-chan's body is already polished.** Face, servo, camera, LED, petting, scanning — all working, all proven. We don't reinvent any of it.

2. **Half-duplex is fine.** Stack-chan is already half-duplex (mic OR speaker). Robot-bridge shipped half-duplex. Plaipin shipped half-duplex. Nobody complained. Full-duplex/AEC is a nice-to-have for interruption, not a requirement.

3. **Dual-gateway support is free.** The adapter just hits an endpoint on the mini. The mini decides: OpenClaw or Hermes? Same response format either way. Swap gateways without touching firmware.

4. **Minimal new code.** Plaipin already wrote `OpenClawClient.cpp` implementing `LLMBase` → it works. We polish it, add body commands, add the Hermes path, and run the proxy on the mini.

5. **No build system drama.** Stays PlatformIO/Arduino. No ESP-IDF conversion, no Arduino-as-component hacks, no LVGL vs M5GFX debates.

6. **The mini does the heavy lifting.** Gateway protocol, auth, tools, memory, TTS/STT — all on Clawdio-Mini. The ESP32 stays dumb and fast.

## What We're NOT Doing

- ❌ NOT building ESP-IDF firmware from scratch (rosie-node is throwaway)
- ❌ NOT using esp-openclaw-room-node SDK (locks us to OpenClaw, kills Hermes option)
- ❌ NOT using WebRTC (half-duplex is fine, no AEC needed)
- ❌ NOT using LVGL (Stack-chan's m5avatar face stays)
- ❌ NOT reinventing servo/camera/LED drivers (Stack-chan already has them)
- ❌ NOT building a Python bridge (robot-bridge already did that — we use a thin Node.js proxy on the mini instead)
- ❌ NOT a closed-source project — goes open source

## What We ARE Doing

1. **Fork plaipin's Stack-chan firmware** — it already has the `OpenClawClient` LLMBase backend
2. **Improve the adapter** — streaming, body commands, better error handling
3. **Run the proxy on the mini** — plaipin's `openclaw-rest-proxy.js` (456 lines) already translates HTTP → OpenClaw WebSocket
4. **Add Hermes routing** — same proxy, different gateway endpoint
5. **Define a response format** — text + emotion + optional servo/gesture/LED commands so the agent can drive the body
6. **Configure the agent** — Rosie's system prompt, tools, and personality on the gateway side

## The LLMBase Interface (what the adapter implements)

Stack-chan already has this abstraction:

```cpp
class LLMBase {
    virtual void chat(String text, const char *base64_buf = NULL) = 0;
    // ... plus chat history, system prompts, memory management
};
```

Existing backends:
- `ChatGPT` — basic OpenAI chat (the weak one)
- `Gemini` — Google Gemini (also has RealtimeLLM for live audio)
- `ModuleLLM` — M5Stack ModuleLLM hardware
- `ModuleLLMFncl` — ModuleLLM with function calling
- `OpenClaw` — plaipin's adapter (already works, our starting point)

We're improving the `OpenClaw` backend and making it the primary one.

## The Proxy (runs on Clawdio-Mini)

Plaipin already wrote `openclaw-rest-proxy.js` (456 lines, only dependency `ws@^8.18.0`):
- HTTP server on port 18790
- Receives OpenAI-shaped POST from ESP32
- Translates to OpenClaw WebSocket protocol (port 18789)
- Returns OpenAI-shaped response to ESP32
- Auto-reconnect, session management, response deduplication

We extend it to:
- Route to OpenClaw OR Hermes based on config
- Parse agent responses for body commands (emotion, servo, LED)
- Stream responses back to ESP32 (plaipin used `stream: false`)

## Hardware Target

**M5Stack Stack-chan (CoreS3)** — unchanged from stock:

| Component | Chip | Status |
|-----------|------|--------|
| MCU | ESP32-S3 | 16MB flash, 8MB PSRAM |
| Speaker | AW88298 | M5.Speaker — works as-is |
| Mic | ES7210 | M5.Mic — works as-is (half-duplex) |
| Display | ILI9342 | m5avatar face — works as-is |
| Servos | SCSCL ×2 | M5StackChan.Motion — works as-is |
| Camera | GC0308 | esp_camera — works as-is |
| Touch | FT6336/Si12T | Head-pet — works as-is |
| LED | WS2812C ×12 | Works as-is |

**Nothing changes on the hardware side.** We're swapping software brains, not rebuilding the body.

## Reference Repos

| Repo | Role | What we take |
|------|------|-------------|
| [PlaiPin/plaipin-openclaw-stackchan](https://github.com/PlaiPin/plaipin-openclaw-stackchan) | **OUR BASE** | Fork this. OpenClawClient adapter, rest-proxy, emoji stripping, partition table |
| [migratorywhale/stackchan-mcp](https://github.com/migratorywhale/stackchan-mcp) | Hardware reference | GC0308 pins, servo patterns, camera I2C release (if we need hardware fixes) |
| [waynecc-at/robot-bridge](https://github.com/waynecc-at/robot-bridge) | Hermes reference | 11 MCP tool definitions, LED state machine, face tracking algorithm, Opus params |
| [taranton/stackchan-gemini-firmware](https://github.com/taranton/stackchan-gemini-firmware) | Hardware patterns | Emotion states, servo gestures, XCLK gotcha (if needed) |
| [kkdev92/stackchan-atoms3r](https://github.com/kkdev92/stackchan-atoms3r) | Architecture reference | Core/platform separation pattern (informs our adapter design) |

Full analyses in [`analysis/`](analysis/) + swarm reports.

## Success Criteria

1. **Stack-chan talks to Rosie** — press button / pet head → speak → Rosie responds through the robot's speaker with her personality, tools, and memory
2. **Dual-gateway works** — swap OpenClaw → Hermes by changing one config value on the mini, no firmware change
3. **Body commands work** — agent can say "look left", "act happy", "turn LED green" and the robot does it
4. **Streaming responses** — robot starts speaking first sentence while agent is still generating (not wait-for-full-response like plaipin)
5. **Community adoption** — people on r/StackChan link to our repo instead of asking "is there a GitHub link?"

## Upstream Advantage

Because this is a **fork of plaipin** (which itself forks Stack-chan), we get:

1. **Pull upstream Stack-chan updates** — bug fixes, face improvements, servo tuning, M5Unified compatibility, new gestures/skins. Merge from upstream, not reinvent.
2. **Stay compatible with the Stack-chan ecosystem** — M5StackChan BSP, M5Unified, community mods all drop in because we didn't change the firmware architecture.
3. **Community contributions flow both ways** — our improved OpenClawClient adapter can PR back to plaipin/Stack-chan. Their improvements flow down to us.
4. **No maintenance isolation** — rosie-node (Architecture A) would have been permanently cut off from the Stack-chan community. A fork stays connected.

This is the open-source flywheel: we build the OpenClaw/Hermes adapter, the community builds everything else, and we all benefit from each other's work.

## Hard Rules

1. **Backup stock firmware BEFORE flashing** — full 16MB dump via esptool first
2. **Stack-chan firmware stays PlatformIO/Arduino** — no ESP-IDF conversion
3. **Don't touch the body** — face, servo, camera, LED, petting, scanning all stay as-is
4. **The mini is the middleman** — ESP32 never talks directly to the gateway

## Team

- **James** — project lead, hardware owner, firmware testing
- **Rosie** — adapter development, proxy, gateway config, documentation