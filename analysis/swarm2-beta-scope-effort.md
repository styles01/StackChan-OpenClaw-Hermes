# SWARM 2 — BETA: Scope & Effort Critique

**Reviewer:** Research Agent BETA (scope & effort)
**Date:** 2026-08-17 23:55 MDT
**Mandate:** Argue that the effort estimate is WRONG. Break down each phase honestly.

---

## EXECUTIVE VERDICT

**The 1-1.5 week estimate is OPTIMISTIC by 2x. Realistic estimate: 2-3 weeks.** The docs undercount Phase 1 ( Plaipin may not compile today) and Phase 2 (streaming is a proxy rewrite, not a flag flip). Phase 3 (Hermes) is honestly the riskiest because we don't actually know the Hermes gateway protocol.

---

## Phase 1: Fork & Flash — claimed 1-2 days → REALISTIC 2-4 days

### What the docs say:
> Fork plaipin, configure proxy, flash, first voice test

### What's actually involved:

1. **Does plaipin's firmware compile today?** UNKNOWN. The repo has 1 commit from March 2026 (5 months ago). PlatformIO libraries drift fast. `M5Unified`, `m5stack-avatar`, `StackChan-BSP` may have pushed breaking changes since then. The `platformio.ini` pins `espressif32@6.3.2` (PlatformIO platform) but library deps are git URLs with no version pins:
   ```
   lib_deps = 
     https://github.com/m5stack/M5Unified.git
     https://github.com/m5stack/StackChan-BSP.git
   ```
   These resolve to HEAD. If any of these repos pushed breaking changes in the last 5 months, the build breaks. **Estimate to fix build issues: 2-8 hours.**

2. **PlatformIO environment setup.** Does James have PlatformIO installed? Python + pip + platformio CLI + ESP32 toolchain. If starting from scratch: 1-2 hours. If already set up: 15 minutes.

3. **Stock firmware backup.** 16MB dump via esptool. Need to detect the right serial port, install USB drivers (CP210x or CH340 depending on cable). 30 minutes if drivers are already installed, 2 hours if not.

4. **Proxy setup on mini.** Copy `openclaw-rest-proxy.js`, `npm install ws`, configure env vars (`OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_WS_URL`), set up systemd service. 1-2 hours.

5. **Gateway configuration.** Need to know the actual gateway token, confirm port 18789 is correct, verify the gateway accepts WebSocket connections from the proxy. 30 minutes if docs are right, 2+ hours if there's auth friction.

6. **First voice test.** Flash firmware, connect to WiFi, pet head, speak, verify audio round-trip. 1-2 hours IF everything works first try. But:
   - WiFi credentials need to be configured in firmware (how? SPIFFS? SD card? hardcoded?)
   - The proxy URL (mini's IP:18790) needs to be configured in firmware
   - The API key needs to match between firmware and proxy
   - The gateway needs to accept the proxy's connection

**Realistic Phase 1: 2-4 days.** The docs' "1-2 days" assumes zero build issues, zero config issues, zero driver issues. That's optimistic for embedded work.

---

## Phase 2: Improve Adapter — claimed 2-3 days → REALISTIC 3-5 days

### Streaming (claimed as part of Phase 2):
As Agent ALPHA identified, streaming requires:
- Proxy: rewrite HTTP response from buffered to SSE/chunked (~150 lines)
- Proxy: accumulate `delta` events and forward incrementally (~50 lines)
- Firmware: rewrite `http_post_json()` to stream-parse response (~80 lines)
- Firmware: feed text to TTS sentence-by-sentence instead of full response (~60 lines)
- Testing: verify streaming actually reduces perceived latency (~2 hours)

**Streaming alone: 2-3 days.** The docs lump it in with body commands as "2-3 days total" which is wrong.

### Body commands (claimed as part of Phase 2):
- ESP32 parsing: ~50 lines (realistic, as ALPHA confirmed)
- But the hard question: how does the agent PRODUCE body commands? Options:
  - (a) System prompt instructs agent to append JSON markers like `[expression:happy]` to its text response → proxy parses them out → 1-2 days to design + test
  - (b) Gateway supports structured JSON output → proxy passes through → 0.5 day IF the gateway supports it
  - (c) Proxy parses natural language for emotional cues (like robot-bridge does) → 2-3 days to implement NLP parsing

**Body commands: 1-3 days depending on approach.**

### Error handling + polish:
- Retry logic, backoff, timeout handling, edge cases: 1 day
- Response sanitization improvements: 0.5 day

**Realistic Phase 2: 3-5 days.** Not 2-3.

---

## Phase 3: Hermes Path — claimed 1-2 days → REALISTIC 2-4 days (HIGH RISK)

### The critical unknown:

**Do we actually know the Hermes gateway protocol?** The docs say "add Hermes routing to the proxy" as if it's a known quantity. But:

- We have NOT cloned the Hermes repo
- We have NOT read Hermes's API documentation (if it exists)
- We have NOT verified Hermes has an HTTP or WebSocket API that accepts text input and returns text output
- The robot-bridge analysis shows Hermes uses a **webhook-driven flow** (POST to `:8644/webhooks/stackchan`), not a simple request-response like OpenClaw's `chat.send`

**Hermes integration is NOT "swap the endpoint URL."** It's a fundamentally different protocol:
- OpenClaw: WebSocket `chat.send` → wait for `chat` event with `state: final`
- Hermes: HTTP POST to webhook → Hermes processes → Hermes calls MCP tools back to the proxy → response flows back through webhook

**This means the proxy needs TWO completely different code paths**, not a config switch. The Hermes path likely needs:
- HTTP POST to Hermes webhook (not WebSocket)
- A callback server to receive MCP tool calls from Hermes (the proxy becomes a server, not just a client)
- Translation between Hermes MCP tool responses and OpenAI-shaped JSON for the ESP32

**Realistic Phase 3: 2-4 days IF Hermes has good documentation.** If not, add 1-2 days for protocol discovery.

**This is the phase most likely to slip.** The docs should flag it as high-risk.

---

## Phase 4: Agent Configuration — claimed 1 day → REALISTIC 1-2 days

### What's involved:
- Configure Rosie as the node agent on OpenClaw Gateway: 1-2 hours
- System prompt for robot interaction (include body command format, personality, tool list): 2-3 hours
- Wire up 6+ tools (printer, fridge, memory, Telegram, time, household status): 2-3 hours (IF tools already exist — they do for Rosie)
- Map body commands (emotion → expression, servo commands, LED states, gestures): 2-3 hours
- Test end-to-end: 1-2 hours

**Realistic Phase 4: 1-2 days.** The docs' "1 day" is about right if tools already exist.

---

## Phase 5: Polish & Testing — claimed 1-2 days → REALISTIC 2-3 days

### What's involved:
- End-to-end testing across all interaction modes: 0.5 day
- Audio calibration (mic gain, speaker volume, TTS quality): 0.5 day
- Camera vision test: 0.5 day
- Servo/LED/emotion test: 0.5 day
- Error state testing (gateway down, network loss, timeout): 0.5 day
- Dual-gateway switch test: 0.5 day
- README + documentation: 0.5-1 day
- Code cleanup + commit: 0.5 day

**Realistic Phase 5: 2-3 days.** Slightly more than docs say.

---

## What's MISSING from the plan

1. **WiFi provisioning.** How does the Stack-chan get WiFi credentials? Plaipin's firmware — does it have a config UI? AP mode? SD card config? The TODO doesn't mention this AT ALL. If we need to add WiFi provisioning, that's 0.5-1 day.

2. **STT/TTS path.** As Agent DELTA will likely flag: where does speech-to-text happen? Plaipin's firmware sends TEXT to the proxy, not audio. So the firmware must do STT locally (using what? Google STT? OpenAI Whisper API? Module LLM?) or send audio to the proxy. The docs say "gateway handles STT/TTS" but the firmware sends text, not audio. This is a GAPING HOLE.

3. **Recording trigger.** How does the robot know when to start/stop recording? Button? Head pet? VAD? Fixed duration? The docs mention "pet head → record → send" but don't specify the mechanism.

4. **Proxy deployment hardening.** Systemd service, log rotation, crash recovery, monitoring. 0.5 day.

5. **Fork setup.** GitHub repo for the fork, branch strategy, upstream remote tracking. 2-4 hours.

6. **LICENSE decision.** The docs don't mention licensing at all. If we want upstream PRs, we need to match Stack-chan's license (MIT). 30 minutes to decide, but it should be in the plan.

---

## Is rosie-node worth salvaging?

**No.** The rosie-node ESP-IDF code was built for a completely different architecture (room-node SDK, WebRTC, LVGL). None of it transfers to the plaipin fork approach. The only potentially useful artifact is the partition table (`my_cores3_16MB.csv` equivalent) — but plaipin already has one (`my_cores3_16MB.csv`). 

**Throwaway confirmed.**

---

## REVISED EFFORT ESTIMATE

| Phase | Docs say | Realistic | Notes |
|-------|----------|-----------|-------|
| 1. Fork & Flash | 1-2 days | 2-4 days | Build issues, WiFi config, driver setup |
| 2. Improve Adapter | 2-3 days | 3-5 days | Streaming is a rewrite, not a flag |
| 3. Hermes Path | 1-2 days | 2-4 days | HIGH RISK — unknown protocol |
| 4. Agent Config | 1 day | 1-2 days | About right |
| 5. Polish | 1-2 days | 2-3 days | More testing than expected |
| **Missing items** | — | 1-2 days | WiFi provisioning, STT/TTS, deployment |
| **TOTAL** | **1-1.5 weeks** | **2-3 weeks** | **2x the docs' estimate** |

---

## Recommendation

1. **Split streaming into a stretch goal.** Ship v1 with `stream: false` (works today). Add streaming in v1.1 once the basic pipeline is proven.
2. **De-scope Hermes to v2.** Ship OpenClaw-only first. Add Hermes once we've actually studied the Hermes API. The dual-gateway claim is a selling point but shouldn't block v1.
3. **Add WiFi provisioning + STT/TTS to the plan.** These are missing and could be 1-2 days of work.
4. **Be honest about effort.** 2-3 weeks is still fast for what we're building. Don't set James's expectations at 1 week.