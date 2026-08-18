# Swarm 3 (Alpha) — Technical Feasibility Review

**Reviewer angle:** Technical feasibility of the ESP32-S3 thin audio client
**Date:** 2026-08-18
**Scope:** Can the Stack-chan (CoreS3) actually do the thin audio client? Where does it break?

---

## Executive Summary

**The thin audio client is feasible — but the plan as written has three real blockers that will bite in Phase 3, and one architectural decision (base64-in-JSON) that is the wrong choice for this hardware.** None of these are fatal; all are fixable with concrete changes. The good news: plaipin's firmware already contains ~80% of the recording-side code (`AudioWhisper.cpp`), and the ESP32-S3's 8MB PSRAM is more than enough for the audio buffers *if* you allocate from PSRAM explicitly.

The three blockers, in order of severity:

1. **`HTTPClient.getString()` buffers the entire response in internal RAM, not PSRAM.** The existing plaipin code (`OpenClawClient.cpp:http_post_json`, `WebVoiceVoxTTS.cpp:https_get`) does exactly this. A 20-second Kokoro response at 24kHz is ~960KB of WAV, ~1.28MB base64. The ESP32-S3 has only ~320KB of usable internal SRAM. `String`/`getString()` will OOM or fragment to death. **This is the #1 thing that will crash the device.**

2. **M5.Speaker cannot stream a WAV from a source — it needs the full PCM in memory.** The existing pipeline plays MP3 via `AudioGeneratorMP3` + `AudioFileSourceBuffer` (streaming, 30KB buffer). But the plan says "play WAV via M5.Speaker." `M5.Speaker.playWav()` requires the complete WAV in a contiguous buffer. You cannot stream a 960KB WAV through the 30KB `preallocateBuffer` the way MP3 is streamed today. You'd need the whole thing in PSRAM, plus a base64 decode buffer.

3. **Base64-in-JSON is the wrong transport for this hardware.** It inflates payloads 33%, forces a full in-memory decode, and requires a JSON parser (ArduinoJson) to hold a multi-megabyte string. Multipart HTTP (or raw WAV body with JSON in headers) is strictly better on ESP32.

---

## 1. Can the ESP32-S3 actually do the thin audio client?

**Yes — recording and HTTP POST are proven, already in plaipin's codebase.** Playback of a large response WAV is the unproven, risky part.

### Recording (M5.Mic) — PROVEN, reuse it

plaipin's `AudioWhisper.cpp` already does exactly what the plan describes:

```cpp
// AudioWhisper.cpp
constexpr size_t record_number = 400;
constexpr size_t record_length = 150;
constexpr size_t record_size = record_number * record_length;   // 60,000 samples
constexpr size_t record_samplerate = 16000;

AudioWhisper::AudioWhisper() {
  const auto size = record_size * sizeof(int16_t) + headerSize;
  record_buffer = static_cast<byte*>(::heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  ...
}
```

Key facts this proves:
- **M5.Mic records 16kHz mono natively** — no resampling needed (the BRIEF's claim is correct). `main.cpp:322` sets `micConfig.sample_rate = 16000`.
- **The WAV header construction is already written** — `MakeHeader()` in `AudioWhisper.cpp` builds the exact 44-byte RIFF header the plan wants. Don't rewrite it; copy it.
- **Recording buffers go in PSRAM** (`MALLOC_CAP_SPIRAM`), which is the correct pattern. `record_size * 2 + 44` = 120,044 bytes for ~3.75s. The plan's 6s/192KB is a modest bump and still trivially fits in 8MB PSRAM.

**The one recording caveat:** `M5.Mic.record()` is called in a loop of fixed-size chunks (`record_length=150` samples each). This is a **fixed-duration** recording, not VAD-stopped. The plan correctly defers VAD to v1.1 and uses button trigger for v1 — good. But note the existing `Audio` class (the older one) records only ~1.9 seconds (`wavDataSize = record_number * record_length * 2` with `record_number=400, record_length=150` → 120KB → 3.75s at 16kHz). If you want 6 seconds you must bump `record_number` to ~640. That's a one-line change, but it's a change the plan doesn't call out.

### HTTP POST of WAV — PROVEN, reuse the pattern

`OpenClawClient.cpp:http_post_json` already does an HTTP POST with a body and reads the response:

```cpp
String OpenClawClient::http_post_json(const char* url, const char* json_string) {
  HTTPClient http;
  http.setTimeout(65000);
  if (http.begin(url)) {
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", String("Bearer ") + param.api_key);
    int httpCode = http.POST((uint8_t *)json_string, strlen(json_string));
    ...
    payload = http.getString();   // ← THE PROBLEM
```

`HTTPClient.POST(uint8_t*, size_t)` accepts a raw byte buffer, so posting a WAV body is straightforward. **But** the response handling (`getString()`) is the fatal flaw (see Section 3).

### Playback (M5.Speaker) — UNPROVEN, this is the risk

The existing pipeline plays **MP3** through a streaming decoder:

```cpp
// PlayMP3.cpp
int preallocateBufferSize = 30*1024;
AudioGeneratorMP3 *mp3;
AudioFileSourceBuffer *buff = new AudioFileSourceBuffer(stream, preallocateBuffer, preallocateBufferSize);
playMP3(buff);
```

This streams MP3 through a 30KB buffer — it never holds the whole file in memory. **The plan's "play WAV via M5.Speaker" is a different animal.** `M5.Speaker.playWav()` (and `playRaw()`) require the complete PCM/WAV in a single contiguous buffer. There is no `AudioGeneratorWAV` streaming path in this codebase. So for a 960KB response WAV you need:
- ~1.28MB base64 string (in PSRAM, if you're careful)
- ~960KB decoded WAV (in PSRAM)
- Both alive simultaneously during decode

That's ~2.2MB of PSRAM. The CoreS3 has 8MB, so it *fits*, but only if you explicitly allocate from PSRAM and never let `String`/`getString()` touch internal RAM. This is the crux of the whole feasibility question.

---

## 2. Specific C++ challenges for each step

| Step | Pi (Python) | ESP32 (C++) | C++ challenge |
|------|-------------|-------------|---------------|
| Record | `sounddevice` callback → numpy | `M5.Mic.record()` loop | **None** — proven in `AudioWhisper.cpp`. Fixed-duration only; no VAD. |
| WAV header | `soundfile.write()` | Manual 44-byte RIFF | **None** — `MakeHeader()` already exists. |
| HTTP POST | `requests.post(files=...)` | `HTTPClient.POST(uint8_t*, len)` | **Minor** — must set `Content-Type: audio/wav` and send raw bytes, not JSON. `HTTPClient` handles this fine. |
| Receive response | `requests` → `resp.json()["audio"]` | `http.getString()` → ArduinoJson | **MAJOR** — `getString()` buffers in internal RAM. See Section 3. |
| Base64 decode | `base64.b64decode()` | Manual or `mbedtls` base64 | **Moderate** — no stdlib. Need a PSRAM-backed decode loop. |
| Play WAV | `sounddevice` / ALSA | `M5.Speaker.playWav()` | **MAJOR** — needs full WAV in contiguous PSRAM; no streaming path. |
| Parse body commands | `re.findall(r'\[(\w+)\]')` | ArduinoJson or manual string scan | **Minor** — ArduinoJson is already a dependency. |

**The two C++ challenges that don't exist in Python:**
1. **Memory management.** Python's `requests` + numpy handle big buffers transparently on a Pi with 1GB+ RAM. On ESP32 you must manually route every large allocation to PSRAM (`heap_caps_malloc(..., MALLOC_CAP_SPIRAM)`), and you must avoid `String` for anything large. The plaipin codebase already has the `SpiRamJsonDocument` allocator (`SpiRamJsonDocument.h`) for exactly this — use it.
2. **No streaming WAV decoder.** Python plays WAV via ALSA/sounddevice which streams from disk/memory. ESP32's M5.Speaker doesn't. This forces the "whole WAV in memory" approach.

---

## 3. WAV file size and RAM — the numbers

### Request side (16kHz mono 16-bit)

- 6 seconds = 16,000 × 2 bytes × 6 = **192,000 bytes** PCM + 44 header.
- In PSRAM: trivial. The existing `AudioWhisper` already holds 120KB in PSRAM. Bumping to 192KB is fine.
- **No streaming needed for the request.** Record into a PSRAM buffer, prepend header, POST the whole thing. `HTTPClient.POST(uint8_t*, 192044)` handles it.

### Response side (24kHz Kokoro output) — THIS is where it gets tight

Kokoro outputs at 24kHz (`lobster_audio_server.py: KOKORO_SAMPLE_RATE = 24000`). The plan's system prompt caps responses at ~200 chars / ~20 seconds of speech.

- 20 seconds at 24kHz 16-bit mono = 24,000 × 2 × 20 = **960,000 bytes** PCM.
- Base64-encoded = 960,000 × 4/3 = **1,280,000 bytes** of text.
- JSON overhead (keys, transcript, body, timings) adds maybe 1-2KB — negligible.

**Memory budget for the response path (worst case, 20s):**
- Base64 string in PSRAM: ~1.28MB
- Decoded WAV in PSRAM: ~0.96MB
- **Peak simultaneous: ~2.24MB PSRAM** (during decode, both exist)

The CoreS3 has 8MB PSRAM. The rest of the firmware (avatar, camera, WiFi, ArduinoJson docs) uses maybe 1-2MB. So **2.24MB fits comfortably — IF you allocate from PSRAM.** The danger is not total capacity; it's that `http.getString()` and `String` default to **internal SRAM** (~320KB usable), which will OOM instantly on a 1.28MB base64 string.

**Verdict:** PSRAM is required, and the plan already targets the CoreS3 which has it. But the plan must be explicit: **every large buffer must be `heap_caps_malloc(..., MALLOC_CAP_SPIRAM)`, and you must NOT use `http.getString()`.** This is the single most important implementation detail.

---

## 4. Base64-in-JSON vs multipart — base64 is the wrong choice

**Recommendation: use multipart/form-data or raw WAV body, not base64-in-JSON.**

Why base64-in-JSON is bad on ESP32:
1. **33% size inflation.** 1.28MB base64 vs 960KB raw. On a WiFi link that's ~0.3s extra transfer — not huge, but pointless.
2. **Forces a full in-memory decode.** You must hold the base64 string AND the decoded WAV simultaneously (~2.24MB peak). With raw WAV you hold only the WAV (~960KB).
3. **ArduinoJson must parse a multi-megabyte string.** ArduinoJson's `deserializeJson` on a 1.28MB string is slow and memory-hungry, even with the PSRAM allocator. You'd be better off parsing the small JSON metadata separately from the audio.
4. **`getString()` is the trap.** The existing code reads the whole response into a `String` — which is internal RAM. This is a guaranteed crash for a 1.28MB payload.

What the ESP32 HTTPClient is actually capable of:
- **`http.POST(uint8_t*, size_t)`** — sends a raw body. Works for WAV.
- **`http.addHeader()`** — you can set `Content-Type: audio/wav` and put metadata in custom headers (e.g. `X-Transcript`, `X-Expression`).
- **`http.getStream()`** — returns a `Stream` you can read incrementally. **This is the key API.** Instead of `getString()`, read the response body in chunks into a PSRAM buffer. This avoids the internal-RAM trap entirely.

**Recommended response format (v1):**
- Server returns **raw WAV bytes** as the HTTP body (`Content-Type: audio/wav`).
- Body commands / transcript / timings go in **HTTP response headers** (small, parseable with a tiny header read) OR a small JSON in a header.
- ESP32 reads the body via `http.getStream()` into a PSRAM buffer, then plays it.

This eliminates base64 decode entirely, halves the peak memory, and avoids ArduinoJson on the big payload. The JSON-with-base64 format in the BRIEF/BUILD_PLAN should be changed.

---

## 5. Bridging HTTP (ESP32) → WebSocket (gateway) → HTTP (back)

The plan's server (Option A: Python port of `lobster_audio_server.py`) is the right call. The bridge challenge is real but manageable:

**The flow:** ESP32 → HTTP POST `/audio` → Python server → STT → WebSocket to OpenClaw Gateway (port 18789) → text response → Kokoro TTS → WAV → HTTP response to ESP32.

Challenges:
1. **WebSocket client in Python.** `lobster_audio_server.py` currently calls LM Studio over plain HTTP (`openai.OpenAI(base_url=LM_STUDIO_URL)`). Switching to OpenClaw Gateway means a WebSocket client. The plaipin firmware's `OpenClawClient.cpp` already talks to the gateway over HTTP (`/v1/chat/completions`), so the gateway exposes an OpenAI-compatible HTTP endpoint — **you may not need WebSocket at all.** Check whether the gateway's `/v1/chat/completions` (which `OpenClawClient.cpp` uses) is sufficient. If so, the Python server can keep using the `openai` library pointed at the gateway's HTTP URL, exactly like it points at LM Studio today. This is a much smaller change than the plan implies.

2. **Synchronous vs async.** The gateway call is blocking (STT → LLM → TTS). Flask's default threaded mode handles one request per thread, so a blocking gateway call is fine for a single robot. For two robots (Stack-chan + Larry) you need `threaded=True` (already set in `lobster_audio_server.py`) and a per-request agent session ID. The plan's "different agent session" requirement means the server must pass a session/agent identifier through to the gateway — a small addition.

3. **Latency.** The gateway adds LLM latency on top of STT+TTS. Larry's server already logs this (`_log_latency`). The plan reuses it — good. Expect total round-trip of 2-4s for a short response, which is acceptable for a robot.

4. **The real risk is not the bridge — it's the ESP32 response handling.** The HTTP→WS→HTTP bridge is server-side and well-understood (Python has mature WS + HTTP libs). The hard part remains getting the 960KB WAV back to the ESP32 without OOM (Section 3/4).

---

## 6. Is ~300-400 LOC for ThinAudioClient realistic?

**No — it's optimistic by roughly 2x.** Here's what the plan's estimate misses:

**What's actually in scope (from TODO Phase 3):**
- M5.Mic recording (button-triggered) — ~40 LOC (mostly copy from `AudioWhisper.cpp`)
- WAV header construction — ~50 LOC (copy `MakeHeader`)
- HTTP POST of WAV — ~40 LOC
- **Receive + parse response** — this is the big one. Reading via `getStream()` into PSRAM, handling headers, parsing body commands. ~80-120 LOC.
- **Base64 decode** (if you keep base64) — ~40 LOC, plus the PSRAM juggling.
- **M5.Speaker WAV playback** — ~30 LOC, but you must write a PSRAM-backed WAV loader (no existing helper).
- Body command parser (`BodyCommandParser`) — ~60-80 LOC (regex-free manual scan of `[expression:happy]` etc.)
- Error handling (server down, timeout, retry) — ~50 LOC
- Wiring into MainLoop/Robot.cpp — ~30 LOC

**Realistic total: ~400-550 LOC** for ThinAudioClient + BodyCommandParser, **before** the PSRAM memory-management plumbing that the plan doesn't mention at all. The plan also omits:
- **A PSRAM allocator / buffer manager** for the response path (not in plaipin's code — `SpiRamJsonDocument` is JSON-only).
- **A WAV playback helper** that loads from PSRAM (plaipin only has MP3 streaming).
- **The `getString()` → `getStream()` rewrite** of the HTTP response handling.

**What the plan over-counts:** it says "DELETE ~2000 lines of plaipin STT/TTS/LLM." That's true and is the real win — but deletion is not the same as the new code being small. The new code is smaller than what it replaces, but 300-400 LOC is a floor, not a realistic estimate.

---

## Concrete recommendations (in priority order)

1. **Change the response transport from base64-in-JSON to raw WAV body + JSON/headers.** This is the single highest-impact change. It halves peak memory, removes the base64 decode, and avoids ArduinoJson on a multi-MB string. (Sections 3, 4)

2. **Never use `http.getString()` for the response.** Use `http.getStream()` and read into a PSRAM buffer. This is the difference between a working device and a crash-on-first-response. (Section 3)

3. **Reuse `AudioWhisper.cpp`'s recording + `MakeHeader()`** rather than writing new. Bump `record_number` to ~640 for 6s. (Section 1)

4. **Verify whether the gateway's `/v1/chat/completions` HTTP endpoint suffices** before building a WebSocket client. `OpenClawClient.cpp` already uses it, so the Python server may not need WS at all. (Section 5)

5. **Budget ~500 LOC, not 300-400**, and add a PSRAM buffer manager + WAV playback helper to the plan. (Section 6)

6. **Test the response path with curl first** (the plan already does this in Phase 2) — but add a specific test: POST a request, get a 20-second response, and verify the ESP32 can receive + play it without OOM. This is the make-or-break milestone.

---

## Bottom line

The architecture is sound and the recording side is proven. The thin audio client **will work** on the CoreS3 — but only if the team fixes the response-handling path (PSRAM allocation, no `getString()`, and ideally raw-WAV-over-multipart instead of base64-in-JSON). As written, the plan's Phase 3 will hit an OOM crash on the first real response. Fix the transport and the memory management, and this is a ~1.5-week project as estimated.
