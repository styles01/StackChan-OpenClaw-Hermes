# StackChan-OpenClaw-Hermes — Build Plan

## Goal
Replace the Stack-chan's weak chatbot brain with a real agentic harness (OpenClaw or Hermes) while keeping the robot body untouched.

## Architecture

```
┌──────────────────────────────────────────┐
│  Stack-chan (Arduino/PlatformIO)         │
│  ESP32-S3 CoreS3 — FIRMWARE UNTOUCHED    │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │ Body (STAYS AS-IS)                 │  │
│  │  m5avatar face + expressions       │  │
│  │  SCSCL servos (yaw + pitch)        │  │
│  │  GC0308 camera                     │  │
│  │  WS2812 LED ×12                    │  │
│  │  FT6336 touch (head-pet)           │  │
│  │  M5.Speaker / M5.Mic (half-duplex) │  │
│  └────────────────────────────────────┘  │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │ LLMBase adapter (OUR CODE)         │  │
│  │  chat(text) → HTTP POST to mini    │  │
│  │  ← response: text + emotion + cmds │  │
│  │  → TTS speaks, face moves, servo   │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
          │ HTTP (OpenAI-shaped JSON)
          ▼
┌──────────────────────────────────────────┐
│  Clawdio-Mini (the middleman)            │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │ Proxy Service (Node.js, ~500 LOC)  │  │
│  │  Receives HTTP from ESP32          │  │
│  │  Routes to: OpenClaw OR Hermes     │  │
│  │  Formats response for Stack-chan   │  │
│  └────────────────────────────────────┘  │
│                                          │
│  ┌───────────────┐ ┌──────────────────┐  │
│  │ OpenClaw      │ │ Hermes Agent     │  │
│  │ Gateway       │ │ (optional)       │  │
│  │ port 18789    │ │                  │  │
│  │ WebSocket     │ │ WebSocket/HTTP   │  │
│  └───────────────┘ └──────────────────┘  │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │ Rosie Agent (on OpenClaw)          │  │
│  │  System prompt: Rosie persona      │  │
│  │  Tools: household, printer,        │  │
│  │  fridge, memory, Telegram          │  │
│  │  Voice: en-GB-LibbyNeural          │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

**Key principle:** ESP32 stays dumb. Mini does the heavy lifting. Stack-chan body stays untouched.

## What We're Building (3 pieces)

### Piece 1: LLMBase Adapter (ESP32, ~200 LOC)
- Fork plaipin's `OpenClawClient.cpp` (already implements `LLMBase`)
- Improve: streaming responses, body-command parsing, error handling
- Sends HTTP POST to the mini's proxy service
- Receives: text to speak + emotion + optional servo/gesture/LED commands
- Drives Stack-chan's body via existing API (`avatar.setExpression()`, `servo->moveToGaze()`, etc.)

### Piece 2: Proxy Service (on mini, ~500-600 LOC)
- Fork plaipin's `openclaw-rest-proxy.js` (456 lines, already works)
- Extends to:
  - Route to OpenClaw OR Hermes based on config
  - Parse agent responses for body commands
  - Stream responses back to ESP32 (plaipin used `stream: false`)
  - Handle dual-gateway switching without firmware changes
- Runs as systemd service on Clawdio-Mini
- Dependencies: just `ws@^8.18.0` (same as plaipin)

### Piece 3: Agent Configuration (on gateway)
- Rosie's system prompt configured for robot interaction
- Tools wired up (household, printer, fridge, memory, Telegram)
- Response format that includes body commands
- Voice configuration for TTS through the robot

## What We're NOT Building

- ❌ ESP-IDF firmware from scratch (rosie-node is throwaway)
- ❌ esp-openclaw-room-node integration (locks to OpenClaw, kills Hermes)
- ❌ WebRTC audio pipeline (half-duplex is fine)
- ❌ LVGL display (m5avatar face stays)
- ❌ AEC / full-duplex audio (not needed)
- ❌ WakeNet wake word (use Stack-chan's existing button/VAD trigger)
- ❌ Custom servo/camera/LED drivers (Stack-chan already has them)
- ❌ Python bridge (we use a thin Node.js proxy on the mini)

## Response Format (agent → robot)

The proxy formats the agent's response as OpenAI-shaped JSON that the ESP32 parses:

```json
{
  "choices": [{
    "message": {
      "content": "The text to speak through the robot speaker"
    }
  }],
  "body": {
    "expression": "happy",
    "servo": { "yaw": -30, "pitch": 45, "speed": 50 },
    "gesture": "nod",
    "led": "blue"
  }
}
```

- `content` — text for TTS (emoji-stripped, markdown-stripped, <200 chars)
- `body.expression` — m5avatar expression: neutral/happy/sad/angry/sleepy/doubt
- `body.servo` — optional servo command (yaw ±90°, pitch 10-70°, speed 0-100)
- `body.gesture` — optional gesture: nod/shake/look_around
- `body.led` — optional LED state: off/green/blue/rainbow

The `body` field is optional. If absent, robot just speaks the text with neutral expression.

## Build Phases

### Phase 1: Fork & Flash (1-2 days)
- [ ] Full 16MB flash backup of stock Stack-chan firmware (HARD RULE)
- [ ] Fork plaipin repo as our base
- [ ] Configure `OpenClawClient` to point to mini's IP:18790
- [ ] Copy plaipin's `openclaw-rest-proxy.js` to Clawdio-Mini
- [ ] Configure proxy: `OPENCLAW_WS_URL=ws://localhost:18789`, `OPENCLAW_GATEWAY_TOKEN=...`
- [ ] Set up systemd service for proxy on mini
- [ ] Flash plaipin firmware to Stack-chan
- [ ] **MILESTONE: Stack-chan talks to OpenClaw Gateway through the proxy**

### Phase 2: Improve Adapter (2-3 days)
- [ ] Add streaming support (`stream: true` — robot starts speaking first sentence while agent still generating)
- [ ] Add body-command parsing in `OpenClawClient::chat()` response handler
- [ ] Add emoji stripping (copy plaipin's `stripEmoji()`)
- [ ] Add response sanitization (strip markdown, cap at ~200 chars)
- [ ] Add error handling (connection errors, timeouts, parse errors)
- [ ] **MILESTONE: Streaming responses + body commands work**

### Phase 3: Hermes Path (1-2 days)
- [ ] Add Hermes routing to the proxy (same HTTP interface, different gateway)
- [ ] Add Hermes auth/webhook configuration
- [ ] Test: swap OpenClaw → Hermes by changing one config value on the mini
- [ ] **MILESTONE: Dual-gateway switching works without firmware change**

### Phase 4: Agent Configuration (1 day)
- [ ] Configure Rosie as the agent for this node on OpenClaw Gateway
- [ ] Set Rosie's system prompt for robot interaction (include body command format)
- [ ] Wire up household tools (printer status, fridge, memory, Telegram)
- [ ] Map robot commands (look, emote, gesture, LED)
- [ ] **MILESTONE: "Hey Rosie, what's the printer status?" → robot looks, thinks, speaks**

### Phase 5: Polish & Testing (1-2 days)
- [ ] End-to-end test: pet head → speak → Rosie responds through robot
- [ ] Calibrate audio levels (mic gain, speaker volume)
- [ ] Test camera vision ("what do you see?")
- [ ] Test servo gestures during speech
- [ ] Test LED emotion states
- [ ] Clean up code, write README, commit and push
- [ ] **MILESTONE: Polished, documented, open-source-ready**

## File Structure

```
/Volumes/1TBSSDClawd/stackchan-node/
├── analysis/                       # Research reports (done)
│   ├── swarm-*.md                  # 4 swarm research reports
│   ├── adversarial-*.md            # Code + doc critiques
│   └── *-repo-analysis.md          # 6 reference repo analyses
├── repos/                          # Reference repos (not tracked)
│   ├── plaipin-openclaw-stackchan/ # OUR BASE — fork this
│   ├── stackchan-mcp/              # Hardware reference
│   ├── esp-openclaw-node/          # (throwaway — was for Architecture A)
│   ├── robot-bridge/               # Hermes reference
│   └── ...
├── rosie-node/                     # ⚠️ THROWAWAY — Architecture A artifact
│                                   # Kept for reference, not used
├── firmware/                       # Our fork of plaipin (to create)
│   ├── platformio.ini
│   ├── src/
│   │   ├── llm/
│   │   │   └── OpenClaw/           # Our improved adapter
│   │   ├── ...
│   └── ...
├── proxy/                          # Our proxy service (on mini)
│   ├── openclaw-rest-proxy.js      # Forked from plaipin
│   ├── hermes-route.js             # Hermes routing (new)
│   └── package.json
├── docs/BRIEF.md                   # This project brief
├── BUILD_PLAN.md                   # This file
├── TODO.md                         # Task list
└── CHANGELOG.md                    # Change log
```

## Revised Effort Estimate

| Phase | Time | What |
|-------|------|------|
| 1. Fork & Flash | 1-2 days | Fork plaipin, configure proxy, first voice test |
| 2. Improve Adapter | 2-3 days | Streaming, body commands, error handling |
| 3. Hermes Path | 1-2 days | Dual-gateway routing in proxy |
| 4. Agent Config | 1 day | Rosie on gateway, tools, commands |
| 5. Polish | 1-2 days | Testing, calibration, docs |
| **Total** | **~1-1.5 weeks** | Down from 2.5-3 weeks for Architecture A |

## Status
- [x] Repo analysis (6 repos + 4 swarm reports)
- [x] Architecture decision (adapter pattern, plaipin base)
- [x] BRIEF updated to new architecture
- [x] BUILD_PLAN rewritten
- [ ] Phase 1: Fork & Flash
- [ ] Phase 2: Improve Adapter
- [ ] Phase 3: Hermes Path
- [ ] Phase 4: Agent Config
- [ ] Phase 5: Polish

## Resolved Decisions
1. ~~Architecture A vs B vs C~~ → RESOLVED: Adapter pattern (James's call). Stack-chan firmware stays Arduino/PlatformIO. We write an LLMBase adapter + proxy on the mini. No ESP-IDF, no room-node SDK, no WebRTC.
2. ~~Full-duplex / AEC~~ → RESOLVED: Not needed. Half-duplex is fine. Stack-chan, robot-bridge, and plaipin all ship half-duplex.
3. ~~esp-openclaw-room-node SDK~~ → RESOLVED: Not using it. Locks to OpenClaw, kills Hermes option, forces ESP-IDF conversion.
4. ~~rosie-node ESP-IDF code~~ → RESOLVED: Throwaway. Was Architecture A artifact.
5. ~~LVGL vs M5GFX~~ → RESOLVED: M5GFX/m5avatar stays. No LVGL.
6. ~~Wake word~~ → RESOLVED: Use Stack-chan's existing trigger (button/head-pet/VAD). No WakeNet needed.
7. ~~Dual-gateway~~ → RESOLVED: Proxy on mini routes to OpenClaw OR Hermes. ESP32 doesn't know which.
8. ~~Streaming~~ → TARGET: Add `stream: true` support (plaipin used `stream: false`). Robot speaks first sentence while agent still generating.