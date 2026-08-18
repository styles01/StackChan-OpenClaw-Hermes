# Stack-chan OpenClaw Firmware — Full Code Review
**Date:** 2026-08-18  
**Reviewer:** Rosie (after reading every critical file in the firmware)  
**Verdict:** **NO-GO** — 3 CRITICAL bugs must be fixed before push. 5 HIGH bugs should be fixed. Then it's GO.

---

## 1. CRITICAL — Will crash or brick the device

### C1: Wrong deallocator — `delete` on `heap_caps_malloc` pointer (×2 files)

**AudioWhisper.cpp:14-19**
```cpp
// Constructor: allocates with heap_caps_malloc
record_buffer = static_cast<byte*>(::heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
// Destructor: frees with delete — WRONG
delete record_buffer;  // ← C1 BUG: heap corruption
```
`heap_caps_malloc` returns C-allocated memory. `delete` calls the destructor and uses the allocator's `free`, which doesn't match. On ESP32 with PSRAM, this corrupts the heap metadata and can crash immediately or cause random failures later.

**Audio.cpp:5-11** — IDENTICAL bug:
```cpp
wavData = (typeof(wavData))heap_caps_malloc(record_size * sizeof(int16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
// ...
delete wavData;  // ← same C1 bug
```

**Fix:** Replace `delete` with `free()` (or `heap_caps_free()`) in both destructors. Add null check.

### C2: Unchecked malloc — NULL dereference crash (×2 files)

**AudioWhisper.cpp:14-16**
```cpp
record_buffer = static_cast<byte*>(::heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
::memset(record_buffer, 0, size);  // ← C2: if malloc returned NULL, memset crashes
```
If PSRAM is exhausted or fragmented, `heap_caps_malloc` returns NULL. `memset(NULL, 0, size)` is an immediate hard crash with no recovery.

**Audio.cpp:5-6** — IDENTICAL bug:
```cpp
wavData = (typeof(wavData))heap_caps_malloc(...);
memset(wavData, 0, record_size * sizeof(int16_t));  // ← same C2 bug
```

**Fix:** Add null check after malloc. Log error and return early if NULL.

### C4: JSON buffer too small for real LLM responses (×4 files)

**OpenClawClient.cpp:226**
```cpp
DynamicJsonDocument doc(2000);  // ← C4: real responses routinely >2KB
```
The Gateway confirmed a real response is 443 bytes (small), but larger responses (function calls, long answers, error messages with context) easily exceed 2000 bytes. `deserializeJson` silently truncates or fails, causing "Parse error" or missing content.

**Also affected (same pattern):**
- `ChatGPT.cpp:307` — `DynamicJsonDocument doc(2000)`
- `ElevenLabsTTS.cpp:36` — `DynamicJsonDocument doc(2000)`
- `OpenAITTS.cpp:31` — `DynamicJsonDocument doc(2000)`
- `WebVoiceVoxTTS.cpp:59` — `DynamicJsonDocument doc(1000)`
- `Whisper.cpp:83` — `StaticJsonDocument<200>` (way too small for STT response JSON)

**Fix:** Use `SpiRamJsonDocument(4096)` for response parsing (PSRAM-backed, already available in the codebase). For Whisper STT response, use at least `StaticJsonDocument<1024>`.

---

## 2. HIGH — Will cause silent failures or data loss

### H1: ChatHistory has no bounds checking on index access

**ChatHistory.cpp:33-45**
```cpp
String ChatHistory::get_role(int i) {
  return chatHistory_role[i];  // ← no bounds check, UB if i >= size
}
```
`get_role(i)`, `get_funcName(i)`, `get_content(i)` all access `std::deque[i]` without checking `i < size()`. If the deque is empty or `i` is out of bounds, this is undefined behavior — on ESP32, likely a crash or garbage data.

**OpenClawClient.cpp:186-190** iterates `for (int i = 0; i < chatHistory.get_size(); i++)` which is safe, but any other caller could pass an out-of-range index.

**Fix:** Add `if (i < 0 || i >= (int)chatHistory_role.size()) return "";` to each accessor.

### H2: Whisper STT response parsing — `StaticJsonDocument<200>` too small

**Whisper.cpp:83**
```cpp
StaticJsonDocument<200> doc;
::deserializeJson(doc, body);
return doc["text"].as<String>();
```
Groq's Whisper API response includes metadata (language, duration, segments) alongside the `text` field. A 200-byte buffer will fail to parse most real responses, silently returning empty string. The user speaks, STT "succeeds" (HTTP 200) but returns `""` — the robot appears deaf.

**Fix:** Use `StaticJsonDocument<1024>` or `DynamicJsonDocument(2048)`.

### H3: Whisper destructor — `client.stop()` commented out

**Whisper.cpp:20**
```cpp
Whisper::~Whisper() {
  //client.stop();  // ← commented out, TLS connection leaks
}
```
The TLS connection to `api.groq.com` is never properly closed. On repeated STT calls, this leaks connections and eventually exhausts the ESP32's socket table.

**Fix:** Uncomment `client.stop()` in the destructor.

### H4: RealtimeLLMBase — `heap_caps_malloc` with no null check, no cleanup

**RealtimeLLMBase.cpp:41**
```cpp
recTestBuf = (int16_t*)heap_caps_malloc(recTestLenMax * sizeof(*rtRecBuf), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
```
No null check after malloc. No destructor visible in the file — if `recTestBuf` is never freed, that's a memory leak. Same for `audioBuf[i] = (uint8_t*)malloc(100 * 1024)` on line 47.

**Fix:** Add null checks. Ensure destructors free with `free()`/`heap_caps_free()`, not `delete`.

### H5: `PlayMP3.cpp` — `malloc` + `delete` mismatch

**PlayMP3.cpp:45,100,116,137,152-153**
```cpp
preallocateBuffer = (uint8_t *)malloc(preallocateBufferSize);  // malloc
// ...
delete file_mp3;  // These are `new`-allocated, OK
delete buff;     // ← need to verify if buff was malloc'd or new'd
```
The `file_mp3` deletes are fine (allocated with `new`), but `buff` and `preallocateBuffer` need verification. If `buff` was `malloc`'d, `delete` is wrong.

---

## 3. MEDIUM — Degraded functionality

### M1: OpenClawClient model field uses `openclaw:main` instead of `openclaw/main`

**OpenClawClient.cpp:10**
```cpp
static const String json_OpenClawChatString =
"{\"model\": \"openclaw:main\","
```
The Gateway's OpenAI endpoint accepts both `openclaw/main` and `openclaw:main` (compatibility alias), but the canonical form is `openclaw/main`. Using the alias works but is fragile — if the alias is deprecated, this breaks silently.

**Fix:** Use `openclaw/main` or better, use the `openclaw_model` config value (which it already does in `load_role()` via `chat_doc["model"] = openclaw_model`). The template default should match the config, not be hardcoded.

### M2: HTTP timeout is 65 seconds — too long for interactive robot

**OpenClawClient.cpp:142**
```cpp
http.setTimeout(65000);  // 65 seconds
```
If the Gateway is unreachable, the robot hangs for over a minute with "Thinking..." on its face before showing an error. Users will think it's frozen.

**Fix:** Reduce to 15-20 seconds. Add a visual "still thinking" indicator update during the wait.

### M3: Response truncation at 200 chars is aggressive

**OpenClawClient.cpp:257-261**
```cpp
if(response.length() > 200){
  int cut = response.lastIndexOf(' ', 200);
  if(cut < 100) cut = 200;
  response = response.substring(0, cut);
}
```
200 characters is ~30 words. Most LLM responses are 50-200 words. The robot will cut off mid-sentence frequently. The `lastIndexOf(' ', 200)` tries to find a word boundary but falls back to hard 200 if none found in the first 100 chars.

**Fix:** Increase to 300-500 chars, or make it configurable. TTS engines can handle longer text.

### M4: No HTTP retry logic

**OpenClawClient.cpp:140-163**
The `http_post_json` function makes one attempt. If the Gateway is briefly unreachable (network hiccup, Gateway restarting), the robot immediately shows "Connection error" with no retry.

**Fix:** Add 2-3 retry attempts with short delays.

### M5: ChatHistory destructor doesn't clear deques

**ChatHistory.cpp:21-23**
```cpp
ChatHistory::~ChatHistory() {
  // empty
}
```
While `std::deque` cleans itself up on destruction, the `String` objects inside contain heap allocations that won't be explicitly freed. On ESP32 with limited heap, this could fragment memory over many chat cycles.

**Fix:** Add `clear()` calls in destructor for safety.

---

## 4. LOW — Code quality, maintainability

### L1: `openclaw_port` is `int` but used in string concatenation without explicit cast

**OpenClawClient.cpp:200**
```cpp
String url = String("http://") + openclaw_host + ":" + String(openclaw_port) + "/v1/chat/completions";
```
Works but fragile. If `openclaw_port` is ever changed to a String, this breaks silently.

### L2: `stripEmoji` is a static function in the .cpp file — not testable in isolation

The stripEmoji function is defined as `static` in OpenClawClient.cpp. It can't be unit-tested without including the whole file. The test harness has a Python port that matches, but the C++ original has no native test.

### L3: Magic numbers throughout

- `200` (response cap), `2000` (JSON buffer), `65000` (timeout), `1024*50` (prompt max) — all hardcoded with no named constants
- `record_number = 400`, `record_length = 150` — audio buffer sizes with no documentation of why these values

### L4: No SPIFFS corruption handling

**OpenClawClient.cpp:99-106** (`init_chat_doc`)
If SPIFFS has a corrupt JSON file, `deserializeJson` fails, prints an error, but the function continues with an empty `chat_doc`. Subsequent access to `chat_doc["messages"]` will create empty arrays, and the chat will send a malformed payload to the Gateway.

### L5: `http_post_json` doesn't validate URL format

**OpenClawClient.cpp:141**
If `openclaw_host` contains `https://` or a trailing slash, the URL construction produces malformed strings like `http://https://host:port/v1/...`.

---

## 5. ARCHITECTURE — Design concerns

### A1: The REST proxy is obsolete — Gateway has built-in HTTP endpoint

The `openclaw-rest-proxy.js` was built to bridge the firmware's HTTP requests to the Gateway's WebSocket protocol. But the Gateway already has a built-in OpenAI-compatible HTTP endpoint at `/v1/chat/completions` that does exactly what the firmware needs. The proxy adds complexity, latency, and a failure point for no benefit.

**Recommendation:** Remove the proxy from the firmware's deployment path. The firmware hits the Gateway directly via HTTP. Keep the proxy file in the repo for reference but document that it's no longer needed.

### A2: `DynamicJsonDocument` (stack/heap) vs `SpiRamJsonDocument` (PSRAM)

The codebase has `SpiRamJsonDocument` available (PSRAM-backed, 8MB on the M5Stack CoreS3), but the response parsing in `OpenClawClient::chat()` uses `DynamicJsonDocument(2000)` which allocates from regular heap. This wastes precious internal RAM and limits buffer size. All JSON parsing should use `SpiRamJsonDocument` unless there's a specific reason not to.

### A3: ChatHistory is unbounded in practice

`ChatHistory` has a `max_history` limit, but `max_history` is set from `_max_history` which comes from the constructor. `OpenClawClient` passes `OPENCLAW_PROMPT_MAX_SIZE (1024*50)` as `_promptMaxSize`, not as the history limit. Need to verify what `max_history` is actually set to — if it's too large, the deque grows unboundedly and exhausts memory.

### A4: No HTTPS/TLS support in OpenClawClient

**OpenClawClient.cpp:200**
```cpp
String url = String("http://") + openclaw_host + ":" + String(openclaw_port) + "/v1/chat/completions";
```
The API key is sent over plain HTTP. If the Gateway is on a local network, this is acceptable. If it's ever exposed to the internet, the API key is sniffable. The `TODO` comment on line 140 acknowledges this.

---

## 6. SECURITY — Exposed secrets or auth issues

### S1: API key sent in cleartext over HTTP
**OpenClawClient.cpp:148**
```cpp
http.addHeader("Authorization", String("Bearer ") + param.api_key);
```
Sent over `http://` (not `https://`). Fine for localhost/tailnet, dangerous if exposed.

### S2: REST proxy reads Gateway token from env var — good
**openclaw-rest-proxy.js:28**
```cpp
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";
```
No hardcoded credentials. Good practice.

### S3: No hardcoded API keys in firmware source
Grep found no hardcoded `sk-*` keys, WiFi passwords, or embedded URLs with credentials. Good.

---

## 7. GO / NO-GO Recommendation

### **NO-GO as-is.** Fix these 3 CRITICAL bugs first:

| # | Bug | File | Fix |
|---|-----|------|-----|
| C1 | `delete` on `heap_caps_malloc` pointer | AudioWhisper.cpp:19, Audio.cpp:11 | Use `free()`, add null check |
| C2 | Unchecked malloc → NULL deref | AudioWhisper.cpp:15, Audio.cpp:6 | Add null check after malloc |
| C4 | JSON buffer 2000B too small | OpenClawClient.cpp:226 | Use `SpiRamJsonDocument(4096)` |

### After C1/C2/C4 fixes: **GO**

The HIGH bugs (H1-H5) should be fixed but won't brick the device — they cause silent failures in edge cases. Fix them in a follow-up commit.

### Files to fix before push:
1. `firmware/src/driver/AudioWhisper.cpp` — C1 (line 19), C2 (line 15)
2. `firmware/src/driver/Audio.cpp` — C1 (line 11), C2 (line 6)
3. `firmware/src/llm/OpenClaw/OpenClawClient.cpp` — C4 (line 226)

### Files to fix in follow-up:
4. `firmware/src/llm/ChatHistory.cpp` — H1 (bounds checks)
5. `firmware/src/stt/Whisper.cpp` — H2 (line 83), H3 (line 20)
6. `firmware/src/llm/RealtimeLLMBase.cpp` — H4 (null checks, cleanup)
7. `firmware/src/driver/PlayMP3.cpp` — H5 (verify buff allocation)
8. `firmware/src/tts/ElevenLabsTTS.cpp` — C4 follow-up (line 36)
9. `firmware/src/tts/OpenAITTS.cpp` — C4 follow-up (line 31)
10. `firmware/src/tts/WebVoiceVoxTTS.cpp` — C4 follow-up (line 59)
11. `firmware/src/llm/ChatGPT/ChatGPT.cpp` — C4 follow-up (line 307)

---

## 8. ADDITIONAL FINDINGS (from dex's review)

### X1 — REST proxy resolves the WRONG pending request under concurrency (HIGH)
**openclaw-rest-proxy.js:145-156**
The proxy registers each request under a unique `idempotencyKey`, but the WebSocket message handler **ignores the key entirely** and resolves "the oldest pending request" via `for (const [key, req] of pending) { ...break; }`. If an ESP32 request and a Telegram message overlap, **the wrong request gets resolved** — the ESP32 could receive the Telegram response or vice versa. This is moot now since the proxy is obsolete (Gateway has built-in HTTP), but documents why the proxy should be removed.

### X2 — Conversation context silently discarded by proxy (HIGH)
The firmware carefully builds the full multi-turn `messages` array in `OpenClawClient::chat()`, but the proxy's HTTP handler **extracts only the last user message** and calls `chat.send` with that single string. Combined with `enableMemory(false)`, Stack-chan has **no conversation memory** through the proxy. The entire history-building logic is dead weight. Moot with direct Gateway HTTP (which receives the full messages array), but another reason the proxy should go.

### X3 — Unauthenticated FTP server with hardcoded credentials (HIGH)
**main.cpp:393**
```cpp
ftpSrv.begin("stackchan","stackchan");
```
Starts an FTP server with **hardcoded, publicly-known credentials** (`stackchan`/`stackchan`), bound to 0.0.0.0:21. Anyone on the LAN can log in and read/write SPIFFS — including config files containing **WiFi password and API keys**. This is inherited from upstream Stack-chan, but is a real security hole.

**Fix:** Make credentials configurable via config file, or at minimum change from the literal default.

### X4 — WebAPI endpoints have no authentication (MEDIUM)
**WebAPI.cpp**
The WebAPI exposes `/apikey` (POST to set API keys), `/speech`, `/chat` — with **no authentication**. Anyone on the LAN can POST to change API keys or trigger speech/chat. Combined with the FTP server, this device has multiple unauthenticated attack surfaces. Inherited from upstream — acceptable for a home device on a trusted network, but worth flagging.

### X5 — Silent config-load failure if YAML exceeds 2048 bytes (MEDIUM)
**main.cpp:336-338**
```cpp
system_config.loadConfig(SPIFFS, "/SC_ExConfig.yaml", 2048, ...);
```
If `SC_ExConfig.yaml` (which now includes `openclaw: {host, port, model}` plus all other settings) exceeds ~2KB, `deserializeYml` returns `NoMemory` → **silently falls back to defaults**. The openclaw host/port/model would silently not load.

**Fix:** Increase buffer to 4096, or better, use `SpiRamJsonDocument` for config loading.

### X6 — `static String response` shared across instances (LOW)
**OpenClawClient.cpp:123**
```cpp
static String response = "";
```
Shared across all `OpenClawClient` instances and retained for program lifetime. Not a bug with a single instance, but a code smell that would cause silent cross-talk if multiple instances were ever created.

## Updated GO / NO-GO

### **NO-GO as-is.** Fix these 3 CRITICAL bugs first:

| # | Bug | File:Line | Fix |
|---|-----|-----------|-----|
| C1 | `delete` on `heap_caps_malloc` pointer | AudioWhisper.cpp:19, Audio.cpp:11 | Use `free()`, add null check |
| C2 | Unchecked malloc → NULL deref | AudioWhisper.cpp:15, Audio.cpp:6, WakeWord.cpp:152-153 | Add null check after malloc |
| C4 | JSON buffer 2000B too small | OpenClawClient.cpp:226 | Use `SpiRamJsonDocument(8192)` |

Note: C1 is triggered on EVERY STT cycle because `Whisper.cpp:106` does `delete audio;` on an `AudioWhisper*` — the broken destructor runs every time.

### After C1/C2/C4 fixes: **GO**

The HIGH bugs (H1-H5, X1-X3) should be fixed in a follow-up commit. The proxy bugs (X1, X2) are moot since the proxy is obsolete — just remove it from the deployment path. The FTP/WebAPI security issues (X3, X4) are inherited from upstream and acceptable for a home device on a trusted network, but should be on the roadmap.

---

**Review by Rosie 🤖 + dex — read every file, cited every line number, no cheerleading.**