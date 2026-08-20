# SWARM 2 — DELTA: Gaps & Risks Critique

**Reviewer:** Research Agent DELTA (gaps & risks)
**Date:** 2026-08-17 23:55 MDT
**Mandate:** Find the BLIND SPOTS. What are we NOT thinking about?

---

## EXECUTIVE VERDICT

**The docs have 3 critical gaps and 2 moderate gaps.** The critical gaps are: (1) the STT/TTS path is fundamentally misunderstood, (2) there's no security on the proxy, (3) the recording trigger mechanism is unspecified. The moderate gaps are WiFi provisioning and multi-user session handling. None of these are dealbreakers, but ALL of them need to be in the plan before building starts.

---

## CRITICAL GAP 1: STT/TTS — Where does speech become text? Where does text become speech?

**The docs say:** "Gateway handles STT/TTS" in the architecture diagram.

**The reality:** I read the plaipin source code. Here's what actually happens:

1. **User speaks to robot** → M5.Mic records audio
2. **Firmware does STT LOCALLY** — `Robot.cpp` has `stt->speech_to_text()` which calls one of:
   - `CloudSpeechClient` (Google STT — requires Google API key)
   - `Whisper` (OpenAI Whisper API — requires OpenAI API key)
   - `ModuleLLMASR` (M5Stack Module LLM hardware)
   - `ModuleLLMWhisper` (M5Stack Module LLM with Whisper model)
3. **Firmware sends TEXT to proxy** → proxy sends to gateway → gateway runs the agent → returns text
4. **Firmware does TTS LOCALLY** — `robot->speech(response)` calls the TTS engine which is ALSO in the firmware (not the gateway)

**This means:**
- **STT happens on the ESP32**, not the gateway. The ESP32 sends TEXT to the proxy, not audio.
- **TTS happens on the ESP32**, not the gateway. The ESP32 receives TEXT back and speaks it locally.
- **The gateway only sees text in, text out.** It never touches audio.

**Why this matters:**
1. We need an STT API key configured on the ESP32 (Google or OpenAI). This is SEPARATE from the OpenClaw gateway token.
2. The STT quality depends on which engine plaipin uses. Google STT and OpenAI Whisper are both cloud-based — they require internet access and API keys.
3. If we want to use OpenClaw's STT (Whisper on the mini), we'd need to change the firmware to send AUDIO to the proxy instead of text. That's a MUCH bigger change than the docs suggest.
4. TTS is also on the ESP32 — plaipin uses what TTS engine? Need to check. If it's a cloud TTS, that's another API key. If it's local TTS (AquesTalk or similar), quality may be limited.

**The docs are WRONG when they say "gateway handles STT/TTS."** The firmware handles both. The gateway only does LLM text-in/text-out. This needs to be corrected.

**Impact on plan:** If we accept plaipin's STT/TTS as-is, no extra work. But we need to document which STT/TTS engine we're using and configure the API keys. If we want to move STT/TTS to the gateway (better quality, centralized config), that's a significant firmware change.

**Recommendation for v1:** Use plaipin's existing STT (OpenAI Whisper API) and TTS as-is. Document the API key requirement. Don't try to move STT/TTS to the gateway in v1.

---

## CRITICAL GAP 2: Security — Anyone on the network can impersonate the robot

**The proxy listens on `0.0.0.0:18790`** — all network interfaces. It accepts POST requests with a Bearer token check:

```javascript
const token = authHeader.replace(/^Bearer\s+/i, "");
if (GATEWAY_TOKEN && token !== GATEWAY_TOKEN) {
    res.writeHead(401, ...);
}
```

**Problems:**
1. **HTTP, not HTTPS.** The Bearer token is sent in cleartext. Anyone on the same WiFi can sniff it.
2. **The ESP32 sends HTTP, not HTTPS.** `OpenClawClient.cpp` uses `http.begin(url)` — no TLS. The `// TODO: Add TLS support for production use` comment confirms this is known.
3. **If `GATEWAY_TOKEN` is empty, there's NO auth at all.** The proxy silently accepts everything.
4. **The ESP32's API key (`param.api_key`) is the same as the proxy's `GATEWAY_TOKEN`.** They must match. If someone learns the token, they can send arbitrary queries to the gateway through the proxy.

**On a home network, this is probably fine.** But if the Stack-chan is on a shared WiFi (office, makerspace), it's a real vulnerability.

**What the docs should say:** "v1 uses HTTP with Bearer token on a trusted home network. For production/shared networks, add TLS support (ESP32 supports HTTPS, proxy can use Let's Encrypt or self-signed cert). This is a v2 hardening item."

---

## CRITICAL GAP 3: Recording trigger — How does the robot know when to listen?

**The docs say:** "pet head → record → send to gateway"

**The reality:** I read `main.cpp`. Plaipin uses:
- **Physical buttons** (BtnA, BtnB, BtnC on CoreS3) — `mod->btnA_pressed()`, `mod->btnB_pressed()`, etc.
- **Touch screen** — `M5.Touch.getCount()`, `mod->display_touched(t.x, t.y)`
- **Wake word** (optional, via Module LLM KWS) — `WAKEWORD_TYPE_MODULE_LLM_KWS`

The recording flow is:
1. User presses a button OR touches the screen OR says wake word
2. Firmware starts recording with `M5.Mic.record()`
3. After fixed duration (or VAD silence?), recording stops
4. STT converts audio to text
5. Text goes to `llm->chat(text)`

**What we need to understand:**
- How long does it record? Fixed duration? VAD-based? Button-hold?
- Is there visual feedback during recording? (avatar expression change?)
- What if the user speaks too long? Too short?

**This is actually FINE for v1** — plaipin's existing trigger mechanism works. But the docs should document what it is, not gloss over it with "pet head → record."

**Recommendation:** Document the existing trigger mechanism in the BRIEF. Note that v1 uses plaipin's existing button/touch trigger. Wake word is a v2 stretch goal.

---

## MODERATE GAP 4: WiFi provisioning

**Plaipin's firmware has THREE WiFi config methods:**
1. **SD card config** — reads SSID/password from SD card
2. **SmartConfig** — ESP8266/ESP32 SmartConfig (phone app sends WiFi credentials)
3. **Previous connection** — ESP32 remembers last WiFi

**The docs don't mention WiFi at all.** This works out of the box with plaipin's existing methods, but:
- SmartConfig requires a phone app (ESP-Touch or similar)
- SD card config requires an SD card with a config file
- We should document which method to use for initial setup

**Recommendation:** Add "WiFi provisioning: uses plaipin's existing SD card / SmartConfig. No additional work needed for v1." to the docs.

---

## MODERATE GAP 5: Multi-user session handling

**What if two people talk to the robot?**

Current architecture: ESP32 → proxy → gateway → agent. The proxy maintains a single WebSocket connection with a single `sessionKey`. All queries go to the same agent session.

This means:
- If James talks to the robot, then Gabby talks 10 seconds later, the agent remembers James's conversation (same session)
- There's no per-user session management
- The agent doesn't know WHO is talking (no speaker identification)

**Is this a problem?** For v1, no. The robot is a household device, not a personal assistant. Agent A knows she's talking to the household. If we want per-user personalization later, that's a v2 feature (would require voice biometrics or face recognition).

**But the docs should mention it.** "v1: single session, all users share one agent conversation. v2: per-user sessions (requires speaker ID or face recognition)."

---

## OTHER GAPS (minor)

### Latency
- ESP32 → HTTP → mini → WebSocket → gateway → LLM → response back
- Estimated round-trip: 3-8 seconds (STT: 1-2s, HTTP: 0.1s, gateway LLM: 2-5s, TTS: 0.5-1s)
- This is SLOWER than a smart speaker (1-2s) but comparable to plaipin's current performance
- The docs should set expectations: "3-8 seconds total round-trip. Streaming (v1.1) reduces perceived latency."

### Proxy reliability
- The proxy has auto-reconnect (3s delay) — good
- No watchdog — if the proxy process dies, the ESP32 can't reach the gateway
- Systemd service with `Restart=always` handles this — docs mention it, good
- But no health alerting — if the proxy is down, nobody knows until the robot stops responding

### Power
- The ESP32 power consumption is unchanged (firmware is the same)
- The mini runs a Node.js process — negligible additional power (mini is always on anyway)
- Not a real concern

### What if the mini is down?
- ESP32 sends HTTP → connection refused → `http_post_json()` returns "" → `avatar.setExpression(Sad)` + "Connection error" speech
- This is handled in plaipin's existing error handling. Good.
- But no retry — the user has to try again. Fine for v1.

---

## SUMMARY: Gaps ranked by severity

| Gap | Severity | Impact | Fix |
|-----|----------|--------|-----|
| STT/TTS path misunderstood in docs | CRITICAL | Docs are misleading, plan may miss API key config step | Correct docs: "STT/TTS on ESP32, gateway does text-in/text-out only" |
| No proxy security (HTTP, no TLS) | CRITICAL | Vulnerable on shared networks | Document as v1 limitation, TLS in v2 |
| Recording trigger unspecified | CRITICAL | Plan doesn't document how user interacts | Document plaipin's existing button/touch trigger |
| WiFi provisioning not mentioned | MODERATE | User confusion during setup | Add note: "uses plaipin's SD/SmartConfig" |
| Multi-user sessions not addressed | MODERATE | All users share one session | Note as v1 limitation, v2 feature |
| Latency not documented | MINOR | Wrong expectations | Add "3-8s round-trip" to docs |
| No health monitoring | MINOR | Silent failures | Systemd watchdog, future alerting |

## The biggest insight

**The STT/TTS gap is the most important finding.** The docs say "gateway handles STT/TTS" but plaipin's firmware does STT/TTS locally on the ESP32 using cloud APIs (Google/OpenAI). The gateway only sees text. This means:

1. We need an STT API key (Google or OpenAI) on the ESP32, separate from the gateway token
2. Moving STT/TTS to the gateway would be a major firmware change (send audio instead of text)
3. For v1, we use plaipin's existing STT/TTS — no extra work, but we need to configure API keys
4. The "gateway handles STT/TTS" claim in the architecture diagram is WRONG and must be corrected

This doesn't change the architecture — the adapter pattern is still right. But it changes the CONFIGURATION requirements and the docs should be honest about what happens where.