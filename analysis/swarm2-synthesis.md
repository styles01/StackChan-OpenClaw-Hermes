# SWARM 2 SYNTHESIS — Final Review Before Buildout

**Date:** 2026-08-17 23:58 MDT
**Input:** 4 critique reports (alpha-technical, beta-scope, gamma-opensource, delta-gaps)
**Purpose:** Finalize the plan. Fix what's wrong. Propose the buildout.

---

## 🔴 CRITICAL FINDINGS (must fix before building)

### 1. STT/TTS PATH IS MISUNDERSTOOD IN THE DOCS
**Delta found it.** The docs say "gateway handles STT/TTS." That's WRONG.

**What actually happens (from reading plaipin's source):**
- ESP32 records audio with M5.Mic
- ESP32 does STT **locally** using Google STT or OpenAI Whisper API (cloud, requires API key ON THE ESP32)
- ESP32 sends **text** to proxy → gateway → agent → text back
- ESP32 does TTS **locally** using its built-in TTS engine
- Gateway only sees text in, text out. It never touches audio.

**What this means for the plan:**
- We need an STT API key (Google or OpenAI) configured on the ESP32
- This is SEPARATE from the OpenClaw gateway token
- The architecture diagram is wrong — STT/TTS happens on the ESP32, not the gateway
- For v1: use plaipin's existing STT/TTS as-is. No extra architecture work, but API key config is a setup step.

**Fix:** Correct the BRIEF architecture diagram and add STT/TTS API key requirement to TODO.

### 2. STREAMING IS NOT A FLAG FLIP — IT'S A PROXY REWRITE
**Alpha found it.** The docs say "add streaming support (stream: true)" as if it's trivial.

**The reality:**
- The proxy collects the FULL response, then sends it in one shot (`res.end(JSON.stringify(response))`)
- Delta events from the gateway are explicitly IGNORED: `// We could accumulate deltas, but we wait for final`
- Adding streaming requires rewriting BOTH:
  - Proxy: HTTP response path → SSE/chunked, accumulate deltas, forward incrementally (~150 lines)
  - Firmware: HTTP parsing → stream-parse SSE chunks, feed to TTS sentence-by-sentence (~80-100 lines)

**Fix:** Move streaming to a v1.1 stretch goal. Ship v1 with `stream: false` (works today, 3-8s round-trip). This removes the biggest scope risk from v1.

### 3. BODY COMMAND PIPELINE IS UNDER-SPECIFIED
**Alpha found it.** ESP32 parsing is easy (~50 lines). But how does the AGENT produce body commands?

**Options:**
- (a) System prompt tells agent to append markers like `[expression:happy]` → proxy parses them out. Fragile but simple. ~1 day.
- (b) Gateway supports structured JSON output → proxy passes through. Clean but depends on gateway support. ~0.5 day.
- (c) Proxy parses natural language for emotional cues (like robot-bridge does). More work but most natural. ~2-3 days.

**Fix:** Pick option (a) for v1 — system prompt markers. Simple, works, doesn't depend on gateway features. Document the marker format in the system prompt.

### 4. NO SECURITY ON THE PROXY
**Delta found it.** HTTP (not HTTPS), Bearer token in cleartext, `0.0.0.0` binding.

**Fix:** Acceptable for v1 on a trusted home network. Document as a known limitation. TLS hardening in v2. Add to the docs explicitly.

---

## 🟡 IMPORTANT FINDINGS (should fix, not blocking)

### 5. EFFORT ESTIMATE IS 2X OPTIMISTIC
**Beta's breakdown:**
| Phase | Docs say | Realistic |
|-------|----------|-----------|
| 1. Fork & Flash | 1-2 days | 2-4 days (build issues, API keys, WiFi config) |
| 2. Improve Adapter | 2-3 days | 2-3 days (WITHOUT streaming — see finding #2) |
| 3. Hermes Path | 1-2 days | 2-4 days (HIGH RISK — unknown protocol) |
| 4. Agent Config | 1 day | 1-2 days |
| 5. Polish | 1-2 days | 2-3 days |
| **TOTAL** | **1-1.5 weeks** | **2-3 weeks** |

### 6. HERMES IS HIGHER RISK THAN DOCS SUGGEST
**Beta found it.** We haven't cloned the Hermes repo. We don't know its API. Robot-bridge shows Hermes uses webhook-driven flow (not simple request-response like OpenClaw). The proxy would need TWO completely different code paths.

**Fix:** De-scope Hermes to v2. Ship OpenClaw-only v1. The "gateway-agnostic architecture" is still true — we just don't ship the second gateway in v1.

### 7. PLAIPIN IS A DEAD REPO
**Gamma found it.** 2 stars, 1 commit, 5 months old, no README, no license file. PRing to plaipin is shouting into the void.

**Fix:** Fork from Stack-chan directly, port plaipin's OpenClaw adapter as reference (not as base). OR fork plaipin and accept it's our repo now. Either way, resolve the license ambiguity — plaipin has NO license file, which is technically "all rights reserved."

### 8. RECORDING TRIGGER IS UNDOCUMENTED
**Delta found it.** Plaipin uses button press / touch screen / optional wake word. The docs say "pet head → record" without specifying the mechanism.

**Fix:** Document plaipin's existing trigger mechanism. No extra work for v1, just accuracy in the docs.

---

## 🟢 WHAT THE DOCS GOT RIGHT

- **Adapter pattern is correct** — `LLMBase::chat()` is the right swap point
- **Forking plaipin is correct** — it's the only repo with a working OpenClaw backend
- **Half-duplex is fine** — plaipin, robot-bridge, and Stack-chan all ship half-duplex
- **Keeping the body untouched** — m5avatar, servo, camera, LED all stay
- **The mini as middleman** — ESP32 stays simple, mini handles gateway complexity
- **Upstream advantage** — pulling Stack-chan updates is realistic (additive fork, not deep modification)
- **Open source flywheel** — we scratch our itch, community benefits, PRs flow both ways

---

## 📋 PROPOSED V1 BUILDOUT (revised based on swarm findings)

### What ships in v1 (2-2.5 weeks):
1. **Fork plaipin, flash, first voice test** (2-4 days)
   - Backup stock firmware
   - Fork plaipin, fix any build issues
   - Configure STT API key (OpenAI Whisper) on ESP32
   - Configure proxy on mini, systemd service
   - Configure WiFi (plaipin's existing SD/SmartConfig)
   - Flash, first voice test through gateway
   - **MILESTONE: Stack-chan talks to Rosie through OpenClaw**

2. **Body commands via system prompt markers** (2-3 days)
   - System prompt instructs agent to append `[expression:happy] [gesture:nod] [led:blue]` markers
   - Proxy parses markers out of text, adds to `body` field in response JSON
   - ESP32 parses `body` field, drives avatar/servo/LED
   - Error handling, retry logic, response sanitization
   - **MILESTONE: Agent drives robot body via text markers**

3. **Agent configuration** (1-2 days)
   - Rosie system prompt for robot interaction (includes marker format)
   - Wire up tools (printer, fridge, memory, Telegram, household status)
   - Map body commands to natural language triggers
   - **MILESTONE: "What's the printer status?" → robot looks, thinks, speaks with Rosie personality**

4. **Polish & testing** (2-3 days)
   - End-to-end testing across interaction modes
   - Audio calibration
   - Camera vision test
   - Error state testing
   - README, code cleanup, commit, push
   - **MILESTONE: Polished, documented, open-source-ready**

### What's deferred to v1.1 / v2:
- **Streaming** (v1.1) — requires proxy rewrite, saves perceived latency
- **Hermes support** (v2) — unknown protocol, high risk, ship OpenClaw-only first
- **TLS security** (v2) — acceptable on trusted home network for v1
- **Wake word** (v2) — use button/touch trigger for v1
- **Multi-user sessions** (v2) — v1 is single shared session
- **Upstream PR to Stack-chan** (post-v1) — ship first, PR after validation

### What's throwaway:
- `rosie-node/` ESP-IDF project — confirmed throwaway, Architecture A artifact

---

## KEY DECISIONS FOR JAMES

1. **Streaming: defer to v1.1?** Ship v1 with `stream: false` (3-8s round-trip, works today). Streaming requires proxy rewrite — not worth the risk for v1.

2. **Hermes: defer to v2?** Ship OpenClaw-only v1. We don't know the Hermes protocol well enough to estimate confidently. The architecture still supports it — we just don't ship it yet.

3. **Fork from plaipin or from Stack-chan directly?** Plaipin has no license (legal ambiguity) but has the working adapter. Forking Stack-chan and porting the adapter is cleaner legally but more work. OR fork plaipin and add MIT license (pragmatic but technically sketchy).

4. **Body commands: system prompt markers?** Agent appends `[expression:happy]` markers to its text response. Proxy parses them out. Simple, works, doesn't depend on gateway features. Good enough for v1?

5. **STT: use plaipin's existing OpenAI Whisper STT?** Requires an OpenAI API key on the ESP32. Or use Google STT (also requires key). No free option in plaipin's firmware. Acceptable for v1?

6. **Repo name: keep "StackChan-OpenClaw-Hermes" or rename to "stackchan-openclaw"?** Gamma argues the current name is confusing. If we defer Hermes to v2, the name oversells what we ship.