# Swarm 3 — Larry V2 Pattern Fidelity & Porting Risks

**Reviewer:** Hailey (subagent)
**Date:** 2026-08-18
**Scope:** Compare the "swap backends" approach (keep plaipin's STTBase/LLMBase/TTSBase, change where they send requests) vs. Larry V2's thin-client approach, for Stack-chan v1.
**Context:** James clarified v1 should be SIMPLE — keep plaipin's existing STT/LLM/TTS pipeline structure intact, just swap WHERE the backends send requests (to the mini instead of cloud APIs). Not "delete everything and write a thin audio client."

---

## TL;DR

The **swap-backends approach is the right call for v1**, and it is *not* a betrayal of the Larry V2 pattern — it is a **staging step toward it**. Larry's Pi is a true thin client (one HTTP call, no STT/TTS classes). Plaipin's firmware is a *thick* client (full STT/TTS classes calling cloud APIs). The two are different shapes, but the **server side is identical** in both: WAV in → STT → LLM → TTS → WAV out. The swap-backends approach keeps the ESP32 firmware mostly intact and moves the *intelligence* to the mini, which is exactly Larry's server model. The thin-client rewrite is a **v1.1 / Phase-6 optimization**, not a v1 requirement.

**Key finding:** The swap-backends approach and the thin-client approach converge on the *same server*. The only real difference is how much firmware you delete. For v1, delete nothing — swap the three backends. This de-risks the port, keeps the body code working, and still proves the Larry server pattern on the mini.

---

## 1. Swap-Backends vs. Larry's Thin Client — Which Is Better for v1?

### Larry V2's shape (reference: `lobster_audio.py`)

Larry's Pi client is genuinely thin. It has **no STT, no TTS, no LLM classes**. It:
- Records audio with WebRTC VAD (`record_with_vad`, `webrtcvad.Vad(VAD_AGGRESSIVENESS)`)
- Wraps it as WAV (`save_audio_to_wav`)
- Does **one** HTTP POST to `/transcribe_respond_and_speak` (server does STT→LLM→TTS)
- Plays back the returned WAV

The Pi's only "intelligence" is **audio capture quality** (VAD, noise calibration, energy gating, voice ratio) and **local sample playback** (TME mode, greeting, trumpet). It never touches text semantics.

### Plaipin's shape (reference: `firmware/src/`)

Plaipin's firmware is a **thick client**. It has:
- `STTBase` with `virtual String speech_to_text() = 0` — implemented by `Whisper` (Groq), `CloudSpeechClient` (Google), `ModuleLLMASR`
- `LLMBase` with `virtual void chat(String text, ...) = 0` — implemented by `OpenClawClient`, `ChatGPT`, `GeminiLive`
- `TTSBase` with `virtual void stream(String text) = 0` — implemented by `WebVoiceVoxTTS`, `ElevenLabsTTS`, `OpenAITTS`, `UAquesTalkTTS`

The pipeline is wired in `AiStackChanMod.cpp`:
```cpp
String ret = robot->listen();      // STT: stt->speech_to_text()
robot->chat(ret, base64_buf);      // LLM: llm->chat() → internally calls robot->speech() → tts->stream()
```

### The honest comparison

| | Larry Pi (thin) | Plaipin (thick) | Swap-backends (proposed v1) |
|---|---|---|---|
| STT class on device | ❌ none | ✅ Whisper→Groq | ✅ keep, retarget to mini |
| LLM class on device | ❌ none | ✅ OpenClawClient→proxy | ✅ keep (already works) |
| TTS class on device | ❌ none | ✅ WebVoiceVox→cloud | ✅ keep, retarget to mini |
| HTTP round-trips | 1 | 3 (STT, LLM, TTS) | 3 (STT, LLM, TTS) |
| Firmware to write | ~300 LOC | 0 (existing) | ~100-200 LOC (3 backend swaps) |
| Firmware to delete | n/a | n/a | 0 |
| Risk to body code | n/a | n/a | **Low** (body untouched) |

**Verdict: swap-backends is better for v1.** Reasons:

1. **It's the smallest possible change.** James's direction is correct: don't rewrite the firmware. The three `*Base` interfaces are clean seams. Each backend is a self-contained class that already does "record → send → parse → return." Retargeting the *send* is a contained edit per class.

2. **The body code stays 100% intact.** The `Robot.cpp` main loop, `m5avatar` face, servo, LED, touch, camera — none of it cares *where* STT/LLM/TTS send requests. `Robot::listen()` calls `stt->speech_to_text()`; `Robot::chat()` calls `llm->chat()` which calls `tts->stream()`. Swap the implementations, the body never knows.

3. **It de-risks the port.** The thin-client rewrite deletes ~2000 lines of plaipin's pipeline and replaces it with a new `ThinAudioClient` + `BodyCommandParser`. That's a lot of new firmware to debug on hardware you can't easily iterate on. Swap-backends reuses battle-tested code paths (recording, WAV handling, playback) and only changes the network target.

4. **It still proves the Larry server pattern.** The whole point of the pilot is "mini does STT→LLM→TTS." Both approaches put that on the mini. The server is the same either way.

**The one thing swap-backends does NOT give you** is the "ESP32 knows nothing" purity. The ESP32 still has STT/TTS classes and still does three round-trips. But that's a *firmware architecture* concern, not a *server* concern — and it's exactly what Phase 6 (Larry port) can fix later.

---

## 2. Three Round-Trips vs. Larry's One — Latency Impact

### The mechanics

**Larry (1 round-trip):** Pi POSTs WAV once → server does STT→LLM→TTS → returns WAV. One network upload, one download.

**Swap-backends (3 round-trips):**
1. ESP32 records → POSTs WAV to mini → mini does Whisper/Parakeet STT → returns **text**
2. ESP32 sends text to OpenClaw (via plaipin's `OpenClawClient` → proxy → gateway) → returns **text**
3. ESP32 sends text to mini → mini does Kokoro TTS → returns **WAV** → ESP32 plays

### Latency math

Larry's server logs (`_log_latency` in `lobster_audio_server.py`) show the dominant cost is **server processing**, not network:

| Stage | Typical (Larry V2) |
|---|---|
| Whisper STT | ~0.3-0.5s (tiny model) |
| LLM | ~1.0-1.5s (80 max tokens) |
| Kokoro TTS | ~0.3-0.5s |
| **Server total** | **~1.6-2.5s** |
| Network (upload+download) | ~0.1-0.3s on LAN |

**The three round-trips add only the network hops** — roughly 2 extra LAN round-trips, ~0.1-0.3s total on a good WiFi link. The STT/LLM/TTS compute time is **identical** whether it happens in one server call or three. So the swap-backends approach adds **~0.1-0.3s** of latency vs. Larry's single round-trip — roughly **5-15%** on a ~2s response. That is acceptable for a kids' toy / desk robot.

### The real latency risk is NOT the round-trips — it's the LLM

The dominant cost is the LLM call (1-1.5s). In swap-backends, step 2 (ESP32 → OpenClaw) goes through plaipin's `OpenClawClient`, which POSTs to the proxy at `/v1/chat/completions` with `stream: false` (see `OpenClawClient.cpp`: `"stream": false`). **Non-streaming means the ESP32 waits for the full LLM response before it can even start TTS.** Larry has the same issue (non-streaming `transcribe_respond_and_speak`), and Larry's own code notes streaming is deferred. So this is a known, accepted tradeoff — not a regression.

### One genuine concern: the ESP32's HTTP stack

Plaipin's `OpenClawClient::http_post_json` uses `HTTPClient` with `http.setTimeout(65000)` (65s). The STT `Whisper` uses a raw `WiFiClient` with a 10s timeout. The TTS `WebVoiceVoxTTS` uses `AudioFileSourceHTTPSStream`. **All three already do HTTP on the ESP32** — so the swap-backends approach reuses proven HTTP code. A thin client would need *new* HTTP code for the WAV upload + WAV download (larger payloads than text). Swap-backends avoids that entirely.

**Verdict: acceptable.** Three round-trips add ~0.1-0.3s on LAN, which is noise next to the ~1.5s LLM cost. The bigger win of swap-backends is that it reuses the ESP32's existing HTTP/audio code rather than writing new WAV-upload/download code.

---

## 3. Where Do Larry's Server Features Live?

Larry's server (`lobster_audio_server.py`) has these features. In swap-backends, **all of them belong on the mini server**, not the ESP32 — because the ESP32's STT/TTS classes are thin network wrappers, and the mini is where the audio/text intelligence already lives.

| Larry feature | Where it lives in Larry | Where it should live in swap-backends | Notes |
|---|---|---|---|
| **Gibberish detection** (`confidence < GIBBERISH_CONFIDENCE` = -0.8 → TME) | Server (`transcribe_respond_and_speak`: `is_gibberish = len(transcript) < MIN_TRANSCRIPT_CHARS or confidence < GIBBERISH_CONFIDENCE`) | **Mini server** (in the STT step) | The mini runs Whisper/Parakeet and gets the confidence score. It decides "gibberish → return TME marker." The ESP32's `Whisper::speech_to_text()` currently returns only `doc["text"]` — it discards confidence. **The mini must return a confidence/flag to the ESP32** so the ESP32 can play a local sample. This is a small protocol addition. |
| **Noise calibration** (`calibrate_noise_floor`, `CALIBRATION_MULTIPLIER`, `.calibration_cache`) | Pi client (`lobster_audio.py`) | **ESP32** (in the STT backend wrapper) | This is *audio capture* logic, not server logic. It must live where the mic is. But plaipin's `Whisper::speech_to_text()` uses `AudioWhisper::Record()` with no calibration. **This is a gap** — swap-backends keeps plaipin's naive recording. For v1, a simple fixed energy threshold or button trigger is fine; full calibration is a Phase-6 port. |
| **VAD cooldown** (`_vad_cooldown_until`, `VAD_COOLDOWN_SECS`) | Pi client | **ESP32** (in the STT backend wrapper / main loop) | Prevents speaker echo re-triggering. Plaipin doesn't have this. For v1 with button/head-pet trigger, it's less critical, but if VAD is used it matters. |
| **Session memory rewriting** (`SessionManager`, `_update_memory`, `MEMORY_TIMEOUT_SECS`) | Server (`lobster_audio_server.py`) | **OpenClaw Gateway** (already handles memory) | Plaipin's `OpenClawClient` already does `enableMemory(false)` — "OpenClaw handles memory server-side." **This is already solved.** The gateway replaces Larry's Python `SessionManager` entirely. |
| **Effect markers** (`parse_effects`, `[trumpet]`) | Server (`parse_effects` regex) | **Mini server** (parse `[expression:happy]` etc. before TTS) | Same pattern, evolved. The server strips markers before TTS and returns them as body commands. This is a server-side regex, exactly like Larry's `parse_effects`. |

**Key principle:** In swap-backends, the ESP32's STT/TTS classes are *thin network wrappers* — they should NOT grow Larry's server logic. The mini server is where STT confidence, gibberish detection, effect parsing, and session memory live. The only ESP32-side additions are **audio capture quality** (calibration, VAD cooldown) and **local sample playback** (TME), which are inherently device-side.

**The one protocol change needed:** plaipin's `Whisper::speech_to_text()` returns only text. For gibberish/TME to work, the mini's STT response must include a confidence score or a `tme` flag. This is a small addition to the STT backend wrapper's return contract.

---

## 4. Larry Client Features — What Matters for Stack-chan v1

Larry's client (`lobster_audio.py`) has a lot of machinery. Most of it is **not** needed for Stack-chan v1.

| Larry client feature | Stack-chan v1? | Defer? | Notes |
|---|---|---|---|
| **mDNS discovery** (`discover_server_url`, `avahi-browse _larry._tcp`) | ❌ Defer | ✅ | Stack-chan is a desk robot on a known LAN. Hardcode the mini's IP in config (plaipin already has `openclaw_s` host/port config). mDNS is a nice-to-have for Larry's roaming toy, not for a fixed desk robot. |
| **Activity runtime** (`ActivityRuntime`, `activity_models`, `activity_store`) | ❌ Defer | ✅ | This is Larry's structured play-session engine (colour games, rounds, attempts). Completely out of scope for Stack-chan v1. |
| **Character packs** (`active_character`, `characters/<char>/`) | ❌ Defer | ✅ | Larry's voice/sample theming. Stack-chan has one character (Rosie). Defer. |
| **Sound machine** (`sound_machine_track`, pink_noise/lullaby) | ❌ Defer | ✅ | Larry's sleep/soothing feature. Not a Stack-chan v1 need. |
| **Nightlight** (`nightlight_enabled`, `nightlight_rgb`) | ❌ Defer | ✅ | Larry's LED nightlight. Stack-chan has a WS2812 LED but it's for expressions, not nightlight. Defer. |
| **Firmware OTA** (`sync_firmware_if_needed`, signed manifest) | ❌ Defer | ✅ | Larry's phone-pushed OTA. Stack-chan flashes via PlatformIO/esptool. Not needed. |
| **Sample sync** (`sync_samples_if_needed`, SHA-256 verified) | ❌ Defer | ✅ | Larry's phone-pushed sample packs. Stack-chan plays local samples from SPIFFS. Defer. |
| **VAD + noise calibration** | ⚠️ Partial | ✅ mostly | Stack-chan has button/head-pet trigger. VAD is a nice-to-have. A simple energy threshold suffices for v1. |
| **Local sample playback (TME, greeting)** | ⚠️ Partial | ✅ mostly | Stack-chan already has core sounds. TME (gibberish → local sample) is worth adding but can be v1.1. |
| **Latency logging** (`_log_latency`, NTP two-clock) | ⚠️ Nice-to-have | ✅ | Useful for tuning, but not a v1 blocker. |

**Verdict:** For Stack-chan v1, **none of Larry's client machinery is required.** The only things worth carrying over are (a) a simple energy threshold / button trigger for recording, and (b) optionally a TME local-sample fallback. Everything else (mDNS, activity, character packs, sound machine, nightlight, OTA, sample sync) is Larry-specific and belongs in Phase 6.

---

## 5. Does Swap-Backends Make the Larry ESP32 Port Easier or Harder?

**It makes it easier — and it's the correct staging path.**

### The key insight: Larry's ESP32 firmware should use the *thin* pattern, but the *server* is shared

Larry's Pi is a true thin client (one HTTP call). When Larry moves to ESP32 (Phase 6), its firmware **should** use the thin audio client pattern — because Larry has no screen, no servos, no body commands to parse. Larry just needs: record → POST WAV → play WAV. That's the thin client.

But here's the thing: **the swap-backends approach builds the exact server Larry needs.** The mini server (WAV in → STT → OpenClaw → TTS → WAV out) is identical whether the client is plaipin's thick firmware or Larry's thin firmware. So:

- **Phase 2 (server)** — built once, reused by both Stack-chan AND Larry. ✅
- **Phase 3 (Stack-chan firmware)** — swap-backends, keeps plaipin's body + pipeline. ✅
- **Phase 6 (Larry firmware)** — thin client, because Larry has no body to preserve. ✅

**The swap-backends approach does NOT make the Larry port harder.** It makes it *easier* because:
1. The server is proven on Stack-chan first (same server Larry will use).
2. The body-command parsing (Stack-chan) and effect-marker parsing (Larry) are both server-side regex — the same `parse_effects` pattern.
3. When Larry's ESP32 firmware is written as a thin client, it can **reuse the same `/audio` endpoint** the swap-backends server exposes.

### The honest caveat

The swap-backends approach means Stack-chan's firmware is *not* the thin client Larry will use. So the "Larry V2 pattern proven on ESP32" success criterion is only **partially** met by v1 — v1 proves the *server* pattern and the *audio-over-HTTP* concept, but not the *thin firmware* pattern. That's fine: the thin firmware is trivially simpler than what plaipin already has, and Phase 6 can write it fresh for Larry's minimal needs.

**Recommendation:** Keep swap-backends for Stack-chan v1. In Phase 6, write Larry's ESP32 firmware as a true thin client (record → POST → play), reusing the same mini server. Do NOT force Stack-chan onto the thin pattern just to match Larry — Stack-chan's body code is worth preserving.

---

## 6. OpenClaw Gateway vs. LM Studio — What It Adds, What It Complicates

### What the gateway adds (vs. Larry's LM Studio)

Larry's server calls LM Studio directly (`openai.OpenAI(base_url=LM_STUDIO_URL)`). The gateway (via plaipin's `OpenClawClient` → proxy → WebSocket) adds:

| Capability | LM Studio (Larry) | OpenClaw Gateway (proposed) |
|---|---|---|
| **Tools** | ❌ none | ✅ household, printer, fridge, memory, Telegram |
| **Memory** | ✅ file-based (`MEMORY.md` rewrite) | ✅ native, server-side (plaipin already does `enableMemory(false)`) |
| **Sessions** | ✅ Python `SessionManager` (MAX_TURNS) | ✅ native gateway sessions |
| **MCP** | ❌ | ✅ (deferred to v2 per BRIEF, but available) |
| **Personality** | ✅ HEART.md in system prompt | ✅ system prompt + agent config |
| **Multi-robot** | ❌ one hardcoded prompt | ✅ separate agent sessions (Rosie vs. Larry) |

**The gateway is a strict upgrade** for the "agentic" goals (tools, memory, sessions). It replaces Larry's hand-rolled `SessionManager` and `MEMORY.md` rewriting with native gateway features.

### What it complicates for swap-backends

1. **The proxy hop.** Plaipin's `OpenClawClient` POSTs to a Node.js proxy (`openclaw-rest-proxy.js`, port 18790) which translates to the gateway's WebSocket (port 18789). So the LLM path is: ESP32 → proxy → gateway → back. That's an extra hop vs. Larry's direct LM Studio call. But it's **already working** (plaipin ships it), so it's not new risk — just an extra ~10-20ms.

2. **`stream: false` is baked in.** `OpenClawClient.cpp` hardcodes `"stream": false`. This means no token streaming — the ESP32 waits for the full response. Larry's non-streaming endpoint has the same limitation, so it's not a regression, but it caps how fast the robot can start speaking. Streaming is a v1.1 item.

3. **Response length cap.** `OpenClawClient.cpp` caps responses at 200 chars (`if(response.length() > 200)`). This is *good* for latency (matches Larry's `LLM_MAX_TOKENS = 80`) but means the agent must be prompted to keep responses short. The system prompt must enforce this.

4. **Body commands must survive the gateway.** The agent appends `[expression:happy]` markers to its response. The gateway returns them as text; the mini server parses them before TTS (like Larry's `parse_effects`). **This works** but requires the agent's system prompt to reliably emit markers — a prompt-engineering dependency, not a code dependency. If the agent forgets markers, the robot just plays audio with neutral expression (graceful degradation, per BRIEF).

5. **Emoji stripping is already handled.** `OpenClawClient.cpp` has `stripEmoji()` — good, because Kokoro TTS (like plaipin's TTS engines) chokes on 4-byte emoji. This is already solved in the existing code.

6. **The gateway is a stateful dependency.** If the gateway is down, the whole pipeline fails. Larry's LM Studio was a simpler, more stateless dependency. For a desk robot this is acceptable (the mini is always on), but the server needs a health check + graceful error path (return a local sample / "connection error" like plaipin's `OpenClawClient` already does).

### The one real complication

The swap-backends approach keeps **three separate network paths** on the ESP32: STT→mini, LLM→proxy→gateway, TTS→mini. That's three places to configure host/port, three timeouts, three failure modes. A thin client would collapse this to one. But since plaipin's code already has all three wired and working, the *incremental* risk of swap-backends is low — you're just changing the STT and TTS targets, and the LLM path is untouched.

---

## Recommendations

1. **Adopt swap-backends for v1.** Keep plaipin's `STTBase`/`LLMBase`/`TTSBase`. Retarget the STT backend (Whisper) and TTS backend (WebVoiceVox or a new Kokoro client) to the mini. Leave `OpenClawClient` (LLM) as-is — it already works.

2. **Build the mini server exactly like Larry's** (`lobster_audio_server.py` pattern): WAV in → STT → OpenClaw → TTS → WAV out. Reuse Larry's `transcribe_respond_and_speak` concept, `parse_effects` regex (evolved to body commands), and `_log_latency` two-clock logging.

3. **Add a confidence/TME field to the STT response.** Plaipin's `Whisper::speech_to_text()` returns only text. The mini must return a confidence score or `tme` flag so the ESP32 can play a local sample on gibberish (Larry's `GIBBERISH_CONFIDENCE = -0.8`).

4. **Keep body-command parsing on the mini server**, not the ESP32. It's a server-side regex (like Larry's `parse_effects`), and the ESP32 just receives a `body` JSON field.

5. **Defer all Larry client machinery** (mDNS, activity runtime, character packs, sound machine, nightlight, OTA, sample sync) to Phase 6. None of it is needed for Stack-chan v1.

6. **For Phase 6 (Larry ESP32), write a true thin client** (record → POST → play), reusing the same mini server. Do NOT force Stack-chan onto the thin pattern — Stack-chan's body code is worth preserving, and the server is shared either way.

7. **Accept the ~0.1-0.3s extra latency** from three round-trips. It's noise next to the ~1.5s LLM cost, and it buys you zero new firmware to debug.

---

## Appendix: Key Code Citations

**Larry thin client (no STT/TTS classes):**
- `lobster_audio.py`: `record_with_vad()` (WebRTC VAD), `save_audio_to_wav()`, single POST to `/transcribe_respond_and_speak`
- `lobster_audio_server.py`: `transcribe_respond_and_speak()` — WAV in → `transcribe()` → `ask_larry()` → `generate_speech()` → WAV out

**Larry server features:**
- Gibberish: `is_gibberish = len(transcript) < MIN_TRANSCRIPT_CHARS or confidence < GIBBERISH_CONFIDENCE` (confidence -0.8)
- Effects: `parse_effects(text)` regex `\[(\w+)\]`
- Session: `SessionManager._update_memory()` rewrites `MEMORY.md` after `MEMORY_TIMEOUT_SECS`
- Latency: `_log_latency()` NTP two-clock reconciliation via `/ack`

**Plaipin thick client (STT/TTS/LLM classes):**
- `STTBase.h`: `virtual String speech_to_text() = 0`
- `TTSBase.h`: `virtual void stream(String text) = 0`
- `LLMBase.h`: `virtual void chat(String text, ...) = 0`
- `Whisper.cpp`: POSTs WAV to `api.groq.com/openai/v1/audio/transcriptions`, returns `doc["text"]` (no confidence)
- `OpenClawClient.cpp`: POSTs to proxy `/v1/chat/completions`, `"stream": false`, `enableMemory(false)`, `stripEmoji()`, 200-char cap
- `WebVoiceVoxTTS.cpp`: `stream()` → `getStreamUrl()` → `AudioFileSourceHTTPSStream` → `playMP3()`
- `AiStackChanMod.cpp`: `robot->listen()` → `robot->chat(ret)` (the 3-stage pipeline)
