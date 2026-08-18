# Swarm 3 Synthesis — All Four Reviews Combined

**Date:** 2026-08-18
**Reviewers:** dex (alpha/technical), hailey (beta/larry-fidelity), ernest (delta/gaps), gordon (gamma/opensource)
**Subject:** Larry V2 Thin Audio Client architecture for Stack-chan

---

## 🚨 TOP 5 FINDINGS (ranked by impact)

### 1. 🏗️ SWAP BACKENDS, DON'T DELETE — v1 strategy shift (beta + delta)

**The current BRIEF says "DELETE plaipin's STT/TTS/LLM classes and write a ThinAudioClient." The swarm says DON'T.**

Hailey's finding: plaipin's `STTBase`/`LLMBase`/`TTSBase` are clean seams. Swapping the backends (STT→mini, LLM→already works via OpenClawClient, TTS→mini) is ~100-200 LOC of changes vs ~500+ LOC of new ThinAudioClient code. The server is identical either way.

Ernest's finding: deleting the classes breaks **6 things** — Robot.cpp's facade, main.cpp's lipSync (`robot->tts->getLevel()` drives mouth animation), AiStackChanMod's conversation flow, the async TTS task, and the REALTIME_API build path. You'd have to rewrite the entire AI orchestration layer.

**Recommendation:** Keep the three `*Base` interfaces. Implement new backends that send to the mini instead of cloud APIs. This is the smallest change that achieves the goal, and it preserves lip sync, triggers, and the conversation mod with zero changes.

**This means the BRIEF and BUILD_PLAN need a significant rewrite.** The "thin audio client" becomes a v1.1/Phase-6 optimization, not the v1 approach.

### 2. 🧠 ESP32 MEMORY TRAP — `getString()` will OOM on real responses (alpha)

The ESP32-S3 has ~320KB usable internal SRAM. A 20-second Kokoro response at 24kHz = ~960KB WAV, ~1.28MB base64. `HTTPClient.getString()` buffers in internal RAM. **The first real response will crash the device.**

Three fixes needed:
1. **Never use `getString()` for audio responses** — use `http.getStream()` and read into PSRAM
2. **Drop base64-in-JSON** — use raw WAV body + metadata in HTTP headers (halves peak memory, eliminates base64 decode)
3. **All large buffers must use `heap_caps_malloc(..., MALLOC_CAP_SPIRAM)`** — the 8MB PSRAM is more than enough, but only if you explicitly allocate from it

**Note:** If we go with swap-backends (finding #1), the TTS backend already streams MP3 through a 30KB buffer — this problem is *smaller* than with the thin client. The thin client's "receive one big WAV" is harder than plaipin's existing "stream MP3."

### 3. 📜 LICENSE BLOCKER — cannot legally add MIT to plaipin's unlicensed code (gamma + delta)

Plaipin's repo has NO license file. Under copyright law, that's "all rights reserved." Adding an MIT LICENSE to a fork of unlicensed code is legally dubious — you can't grant rights to code you don't own.

**Gordon's recommendation:** Fork from **Stack-chan directly** (MIT-licensed), port plaipin's *concepts* (REST proxy, OpenClaw integration) as reference, write your own code, credit plaipin in the README. This is both legally cleaner AND more honest — we're deleting most of plaipin's code anyway.

**This is a blocker for the open-source goal.** Resolve before publishing anything public.

### 4. 📛 REPO NAMING + FRAMING — "StackChan-OpenClaw-Hermes" oversells what ships (gamma)

Hermes is deferred to v2. A stranger seeing the name asks "do I need all three?" The current "pilot for Larry" framing makes it look like a personal hack, not a platform.

**Gordon's reframe:**
- Rename to `stackchan-thin-audio-client` or `stackchan-openclaw` NOW (0 stars = free rename)
- README headline: "The ESP32 is a dumb audio terminal. No API keys on the device."
- Larry becomes a charming footnote, not the headline
- Ship `agent-template.md` (personality format), keep Larry's HEART.md/MEMORY.md private
- The thin audio client pattern IS the contribution — no other Stack-chan fork does this

### 5. 🔌 RESPONSE FORMAT CONTRADICTION — markers-in-text vs structured JSON (delta)

The BRIEF describes TWO contradictory response formats:
- Server returns structured JSON with `body` field
- Agent appends `[expression:happy]` markers and server parses them out

**Pick ONE:** markers-in-text, parsed server-side (Larry V2's `parse_effects` pattern). The server strips markers before TTS, puts parsed commands in the response. This matches Larry's proven pattern and plaipin's existing emoji stripping.

---

## 📊 ALL FINDINGS BY CATEGORY

### Architecture & Approach
| # | Finding | Source | Severity |
|---|---------|--------|----------|
| 1 | Swap backends, don't delete — stub the interfaces | beta + delta | CRITICAL |
| 2 | Thin client is v1.1, not v1 — swap-backends is the staging step | beta | HIGH |
| 3 | ~300-400 LOC estimate is optimistic — swap-backends is ~100-200 LOC, thin client is ~500+ LOC | alpha + beta | MEDIUM |
| 4 | Three round-trips (STT→LLM→TTS) add only ~0.1-0.3s vs one — acceptable | beta | LOW |
| 5 | OpenClaw Gateway is a strict upgrade over LM Studio (tools, memory, sessions) | beta | INFO |

### ESP32 Hardware
| # | Finding | Source | Severity |
|---|---------|--------|----------|
| 6 | `getString()` will OOM on audio responses — use `getStream()` + PSRAM | alpha | CRITICAL |
| 7 | Base64-in-JSON is wrong for ESP32 — use raw WAV + headers | alpha | HIGH |
| 8 | M5.Speaker can't stream WAV — needs full PCM in memory (unlike MP3 streaming) | alpha | HIGH |
| 9 | Recording + WAV header already exist in `AudioWhisper.cpp` — reuse, don't rewrite | alpha | GOOD |
| 10 | PSRAM (8MB) is sufficient IF you allocate correctly | alpha | INFO |

### Firmware Coupling
| # | Finding | Source | Severity |
|---|---------|--------|----------|
| 11 | Deleting STT/TTS/LLM breaks lipSync, conversation mod, async TTS, REALTIME build | delta | CRITICAL |
| 12 | "Head-pet" trigger doesn't exist in plaipin — triggers are Button A + screen touch + wake word | delta | HIGH |
| 13 | Camera/vision NOT compiled in by default — `ENABLE_CAMERA` undefined | delta | HIGH |
| 14 | No bundled sound samples — "I can't connect" sound must be created | delta | MEDIUM |
| 15 | WiFi creds + possibly OpenClaw bearer token live on device — "zero credentials" is misleading | delta | MEDIUM |

### Larry V2 Fidelity
| # | Finding | Source | Severity |
|---|---------|--------|----------|
| 16 | VAD cooldown (1.8s after playback) is dropped silently — will cause echo-loop | beta | HIGH |
| 17 | Gibberish detection needs confidence score — plaipin's Whisper returns only text | beta | MEDIUM |
| 18 | Larry's activity runtime, character packs, sound machine, nightlight — all defer to Phase 6 | beta | INFO |
| 19 | Phase 6 (Larry ESP32) should use thin client, not swap-backends — different firmware pattern | beta | INFO |
| 20 | Effect markers → body commands is the cleanest fidelity match | beta | GOOD |

### Open Source & Strategy
| # | Finding | Source | Severity |
|---|---------|--------|----------|
| 21 | Cannot add MIT to unlicensed fork — fork from Stack-chan (MIT) instead | gamma + delta | BLOCKER |
| 22 | Repo name oversells Hermes — rename now | gamma | HIGH |
| 23 | "No API keys on device" is the strongest selling point — lead with it | gamma | HIGH |
| 24 | "Pilot for Larry" framing is a liability for community adoption | gamma | HIGH |
| 25 | Ship agent template, keep Larry/Rosie personalities private | gamma | MEDIUM |
| 26 | Gateway tools → robot actions is the best demo — spell it out in README | gamma | MEDIUM |

### Future: Streaming (James's v3 vision)
| # | Finding | Source | Notes |
|---|---------|--------|-------|
| 27 | ChatGPT-live / Hermes live mode patterns apply to v3 streaming with interruption | James | Deferred to v3 — firmware changes on top of the foundation |

---

## 🎯 RECOMMENDED v1 SCOPE (revised)

Based on all four reviews:

**v1 = Swap-Backends (not thin audio client)**
- Keep plaipin's `STTBase`/`LLMBase`/`TTSBase` interfaces
- Retarget STT backend → mini server (Whisper/Parakeet)
- Leave `OpenClawClient` (LLM) as-is — already works
- Retarget TTS backend → mini server (Kokoro)
- Build mini server (Larry V2 pattern: WAV in → STT → OpenClaw → TTS → WAV out)
- Button trigger only (existing plaipin trigger logic, unchanged)
- No camera, no VAD, no head-pet
- Text-only error handling (reuse plaipin's avatar text)
- Response format: markers-in-text, parsed server-side

**v1.1 = Thin Audio Client optimization**
- Collapse 3 round-trips to 1 (ThinAudioClient)
- Delete plaipin's STT/TTS/LLM classes
- Add VAD cooldown
- Add local error samples
- Add streaming (ChatGPT-live pattern)

**v2 = Hermes + MCP**
**v3 = Real-time streaming with interruption**
**Phase 6 = Larry ESP32 (true thin client, same server)**

---

## 📝 DOCS THAT NEED UPDATING

1. **BRIEF.md** — rewrite from "thin audio client" to "swap-backends for v1, thin client for v1.1"
2. **BUILD_PLAN.md** — Phase 3 changes from "write ThinAudioClient" to "retarget STT and TTS backends"
3. **TODO.md** — update task list to reflect swap-backends approach
4. **README.md** — needs to be written from scratch with gamma's framing recommendations
5. **Response format** — pick markers-in-text, document it clearly
6. **License** — resolve before publishing (fork from Stack-chan, not plaipin)
7. **Repo name** — rename before any public push

---

## 🐝 SWARM STATS

| Agent | Angle | Report | Lines |
|-------|-------|--------|-------|
| dex | Technical feasibility | swarm3-alpha-technical-feasibility.md | 219 |
| hailey | Larry V2 fidelity | swarm3-beta-larry-fidelity.md | 246 |
| ernest | Gaps & risks | swarm3-delta-gaps-risks.md | 249 |
| gordon | Open source strategy | swarm3-gamma-opensource-strategy.md | 343 |
| **Total** | | | **1057** |