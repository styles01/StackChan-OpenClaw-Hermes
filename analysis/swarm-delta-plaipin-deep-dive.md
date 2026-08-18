# SWARM DELTA — PlaiPin/plaipin-openclaw-stackchan Deep Dive

**Date:** 2026-08-17
**Repo:** https://github.com/PlaiPin/plaipin-openclaw-stackchan
**Local clone:** /Volumes/1TBSSDClawd/stackchan-node/repos/plaipin-openclaw-stackchan/
**Stars:** 2 | **Forks:** 0 | **Open issues:** 0 | **Created:** 2026-03-30
**Last commit:** d9132fb "Add telegram input reaction" (Nat, 2026-03-30)
**Languages:** C, C++, HTML, JavaScript, Makefile, Shell
**Org:** PlaiPin (US-based; also makes rosclaw = ROS2+OpenClaw, 547-678★, and solana-esp32-x402)

> **This is the single closest precedent to what we're building.** It is the only repo that connects Stack-chan to OpenClaw directly. It is a *working* proof-of-concept, but it takes a fundamentally different (simpler) architecture than ours. Every detail below matters for our architecture decision.

---

## 1. ARCHITECTURE — What plaipin actually is

**Verdict: It starts from the existing Stack-chan Arduino firmware and *adds* OpenClaw as one of several LLM backends.** It is NOT a native OpenClaw node, and it does NOT start from OpenClaw.

The repo is a **PlatformIO/Arduino** project (NOT ESP-IDF). It is a fork/extension of the **AiStackChanEx** community firmware (by ronron-gh), which itself is a fork of the official Stack-chan Arduino firmware. PlaiPin took that firmware and:

1. Added an `OpenClawClient` class implementing the existing `LLMBase` interface (one of 5 LLM backends: ChatGPT, ModuleLLM, ModuleLLM-FnCl, Gemini, OpenClaw).
2. Added a **Node.js REST-to-WebSocket proxy** (`openclaw-rest-proxy.js`) that runs on the host machine.
3. Added a **Telegram bridge** (both directions) through the same proxy.

### The data flow (the "clever shortcut")

```
Stack-chan ESP32 (Arduino firmware)
    │  HTTP POST /v1/chat/completions  (OpenAI-shaped JSON, port 18790)
    ▼
openclaw-rest-proxy.js  (Node.js on host, port 18790)
    │  WebSocket (protocol v3, port 18789)
    ▼
OpenClaw Gateway
```

The ESP32 **thinks it is talking to an OpenAI-compatible API.** The Node.js proxy translates OpenAI-shaped HTTP requests into OpenClaw WebSocket protocol messages. This is the key architectural insight: **no ESP-IDF, no WebRTC, no esp-openclaw-node components, no WebSocket on the device.** Just plain HTTP + JSON from the ESP32.

### Why this matters for us

- plaipin proves **Stack-chan → OpenClaw is viable and has been done.**
- But it took the **easy path** (HTTP proxy through a Node.js middleman). We are taking the **native path** (direct WebSocket + WebRTC via esp-openclaw-node).
- Our approach is harder to build but removes the proxy dependency, lowers latency, enables WebRTC audio, and gives native OpenClaw node features (face state, commands, provisioning).

---

## 2. DISPLAY — LVGL or M5GFX?

**Neither. plaipin uses the `m5stack-avatar` library (M5Unified's avatar system), NOT LVGL and NOT raw M5GFX.**

- The face is rendered by **`m5stack-avatar`** (vendored in `firmware/lib/m5stack-avatar/`), which is built on **M5Unified/M5GFX** under the hood.
- The avatar is a global `Avatar avatar;` object in `main.cpp`, initialized with `avatar.init(16)` (Core2/CoreS3) or `avatar.setScale(0.5); avatar.setPosition(-56,-96); avatar.init()` (AtomS3R).
- **Faces:** uses the default m5avatar face, plus optional `CatFace` (`faces/CatFace.h`) for AtomS3R via `-DCAT_FACE`.
- **Expressions:** `Expression::Neutral/Happy/Sleepy/Doubt/Sad/Angry` — set via `avatar.setExpression(...)`.
- **Speech text:** `avatar.setSpeechText("...")` with a Japanese font `efontJA_16` (`avatar.setSpeechFont(&fonts::efontJA_16)`).
- **Lip sync:** a dedicated `lipSync` task reads `robot->tts->getLevel()` and calls `avatar->setMouthOpenRatio(open)` — classic m5avatar lip-sync.
- **Servo sync:** a `servo` task reads avatar gaze and calls `robot->servo->moveToGaze(...)`.
- **Battery icon:** `avatar->setBatteryIcon(true)` + `setBatteryStatus(...)`.
- **Sub-window / QR:** `avatar.updateSubWindowQrcode(url)` for showing the device's web URL.

**Relevance to us:** This is a *different* face system from both xiaozhi's LvglDisplay and room-node's built-in face. If we want the classic Stack-chan look, m5avatar is the natural choice (it's what Stack-chan actually uses). But it's M5Unified-specific and not directly reusable in an ESP-IDF/esp-openclaw-node build.

---

## 3. AUDIO — esp_codec_dev or M5.Speaker/M5.Mic? AEC / full-duplex?

**plaipin uses M5Unified's `M5.Speaker` and `M5.Mic` — NOT esp_codec_dev. There is NO AEC and NO full-duplex.**

### Output (TTS)
- TTS is **cloud-based** (WebVoiceVox, ElevenLabs, OpenAI TTS, AquesTalk, or ModuleLLM). The ESP32 does NOT synthesize locally (except AquesTalk).
- Audio is played through **`AudioOutputM5Speaker`** (`driver/AudioOutputM5Speaker.h`), a custom `AudioOutput` subclass for the **ESP8266Audio** library that feeds `m5::Speaker_Class::playRaw()`.
- It uses a **triple-buffer** (3 × 640 int16 samples) to smooth playback and avoid underruns.
- Speaker config in `main.cpp`: `spk_cfg.sample_rate = 64000` (64kHz), `task_pinned_core = APP_CPU_NUM`.
- **No AEC.** The mic and speaker are explicitly toggled: `M5.Mic.end(); M5.Speaker.begin(); ... M5.Speaker.end(); M5.Mic.begin();` (see `sw_tone()`). This is **half-duplex** — they cannot record and play simultaneously.

### Input (STT)
- STT is **cloud-based** (Google STT, Groq Whisper, or ModuleLLM ASR/Whisper).
- `AudioWhisper` (`driver/AudioWhisper.cpp`) records ~1.9s of 16kHz mono PCM into a PSRAM buffer, builds a WAV header, and uploads it.
- `Whisper` (`stt/Whisper.cpp`) posts the WAV to **`api.groq.com/openai/v1/audio/transcriptions`** with model `whisper-large-v3-turbo` via a raw `WiFiClientSecure` multipart POST (TLS with root CA).
- Mic config: `micConfig.sample_rate = 16000`.

### Wake word
- **SimpleVox** (MechaUma) MFCC-based wake word — NOT Espressif ESP-SR/WakeNet.
- `WakeWord.cpp` uses `simplevox::VadEngine` + `simplevox::MfccEngine`, records 3s clips, computes MFCC features, and compares against registered templates stored in SPIFFS (`/wakewordN.bin`).
- Uses `esp_ns.h` (`ns_pro_create`) for noise suppression.
- Can **register custom wake words** by recording your voice (BtnB long-press).
- **AtomS3R has wake word disabled** (`;-DENABLE_WAKEWORD` commented out — "ウェイクワードは未対応").

**Relevance to us:** plaipin's audio is entirely cloud STT/TTS with half-duplex M5Unified audio. It has **no AEC, no full-duplex, no local audio pipeline.** This is the biggest architectural gap vs. our native approach (WebRTC audio, esp_codec_dev, AEC). We cannot reuse their audio stack, but their **triple-buffer speaker pattern** and **WAV-header-in-PSRAM recording pattern** are useful references.

---

## 4. CONNECTION TO OPENCLAW GATEWAY — WebSocket or REST?

**The proxy uses WebSocket to the Gateway; the ESP32 uses HTTP to the proxy.**

- **Proxy → Gateway:** WebSocket, **protocol v3** (`minProtocol: 3, maxProtocol: 3`), port 18789, with `auth: { token }` and `scopes: ["operator.write"]`. Client identity: `{ id: "webchat", displayName: "OpenClaw REST Proxy", platform: "web", mode: "webchat" }`.
- **ESP32 → Proxy:** plain HTTP `POST /v1/chat/completions` (OpenAI shape) with `Authorization: Bearer <api_key>`.
- **ESP32 → Proxy (Telegram):** `GET /v1/pending` polling every 3s.

### The WebSocket protocol messages the proxy sends
- `connect` request → gets `hello-ok` → extracts `sessionKey` from `snapshot.sessionDefaults.mainSessionKey`.
- `chat.send` request with `{ sessionKey, message, idempotencyKey }` (idempotencyKey = `crypto.randomUUID()`).
- Listens for `event` type `chat` events; resolves pending requests on `state === "final" | "error" | "aborted"`.
- **60s response timeout.**

### Notable protocol quirks the proxy had to handle
1. **OpenClaw does NOT echo back the idempotencyKey** in the chat event — so the proxy resolves the *oldest* pending request (a FIFO assumption).
2. **Doubled responses** — the gateway sometimes sends text twice; the proxy has a `deduplicate()` function that detects if the second half of a response repeats the first half and strips it.
3. **Text extraction** mirrors `openclaw.ts` logic: takes only the *last* text block from `message.content` array (gateway may include accumulated + final).

---

## 5. WHAT openclaw-rest-proxy.js DOES — bridge or native?

**It is a pure bridge/proxy — a REST-to-WebSocket translation layer. The firmware is NOT native OpenClaw.**

`openclaw-rest-proxy.js` (456 lines, single file, only dependency `ws@^8.18.0`):

1. **HTTP server** on port 18790 (`0.0.0.0`).
2. **`POST /v1/chat/completions`** — OpenAI-shaped. Extracts the last user message, forwards via `chat.send`, waits for final, returns an OpenAI-shaped `chat.completion` response.
3. **`GET /health`** — returns `{ status: "ok"|"disconnected", sessionKey }`.
4. **`GET /v1/pending`** — Telegram bridge: returns queued `{ pending, userText, aiResponse }` for the ESP32 to pick up (Bearer-token protected).
5. **Telegram polling** — `pollTelegram()` uses `getUpdates` long-polling (30s timeout). Messages typed in Telegram are sent to OpenClaw via `chat.send`, the AI response is posted back to Telegram, AND queued in `pendingForRobot` for the ESP32 to speak. When the ESP32 speaks, the proxy also posts "🎙️ *Stack-chan heard:*" to Telegram so both sides of the conversation are visible.
6. **WebSocket management** — connect handshake, sessionKey extraction, auto-reconnect every 3s, rejects all pending on disconnect.
7. **systemd service** (`openclaw-rest-proxy.service`) — `After=network.target openclaw-gateway.service`, `Restart=always`, env vars `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_WS_URL=ws://localhost:18789`, `PROXY_PORT=18790`.

**Env vars:** `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_WS_URL`, `PROXY_PORT`, `OPENCLAW_TG_BOT_TOKEN`, `OPENCLAW_TG_CHAT_ID`.

**This is a bridge architecture, not native firmware.** The ESP32 never speaks OpenClaw protocol; it speaks OpenAI HTTP.

---

## 6. WHAT WORKED / WHAT DIDN'T — issues, refactor plans

**There is NO REFACTOR-PLAN file and NO issues list** (0 open issues, single commit, no tags, no branches beyond `main`). The repo is a one-shot proof-of-concept by a single author (Nat). The git history is a single squashed commit.

### What clearly worked (from the code)
- **The REST-proxy concept is proven.** The OpenAI-shaped HTTP interface is a clean, low-friction way to bolt OpenClaw onto any existing LLM client. The ESP32 code is simple (just `HTTPClient` POST).
- **Telegram bidirectional bridge works** — both directions (Telegram→robot and robot→Telegram) are implemented and wired into the firmware's `idle()` loop.
- **Emoji stripping for TTS** — a robust UTF-8 filter that keeps ASCII/Latin/CJK and strips 4-byte emoji + 3-byte dingbats/symbols. This is a real, reusable win (ESP32 TTS engines choke on 4-byte emoji).
- **Response sanitization** — strips `**`/`__` markdown, replaces newlines with spaces, caps response at ~200 chars to prevent TTS overload/crashes.
- **Multi-target build** — Core2, CoreS3, AtomS3R all supported in one platformio.ini.

### What didn't work / is weak (inferred from code)
- **No AEC / full-duplex** — half-duplex mic/speaker toggling. Can't listen while speaking.
- **No streaming** — `"stream": false`; the ESP32 waits for the full final response (up to 60s timeout) before speaking. High perceived latency.
- **No TLS on the ESP32→proxy leg** — `http_post_json` uses plain `http://` with a `// TODO: Add TLS support for production use` comment. The proxy is unauthenticated on the LAN except a Bearer token.
- **Fragile response matching** — resolving the *oldest* pending request because OpenClaw doesn't echo idempotencyKey is a race-prone hack (fine for single-user, breaks under concurrency).
- **Dedup hack** — the doubled-response workaround indicates a gateway quirk that could change.
- **Wake word is custom MFCC (SimpleVox)** — works but is less robust than ESP-SR/WakeNet and requires recording your own samples.
- **AtomS3R is a second-class citizen** — no wake word, no servo (pins 0/0 = "非対応"/unsupported), uses SPIFFS instead of SD.
- **Single commit, no docs** — README is just the repo title. No architecture doc, no setup guide, no troubleshooting. Hard to reproduce.

### The "extra PlaiPin features" (from the repo description)
- Telegram input reaction (the last commit), QR code for web URL, camera/face-detect (optional), pomodoro/photo-frame/status-monitor/volume mods, SD-updater, FTP server, WebAPI personalize page (role/memory editing). Most are irrelevant to us.

---

## 7. WHAT WE CAN DIRECTLY REUSE

### Directly reusable (high value)
1. **Emoji/symbol stripping for TTS** (`stripEmoji` in `OpenClawClient.cpp`) — copy this approach. When Rosie sends text with emoji to the robot for TTS, strip 4-byte emoji and 3-byte dingbats/symbols. This is battle-tested UTF-8 handling.
2. **Response sanitization** — strip `**`/`__` markdown, newline→space, cap length (~200 chars) to protect TTS. Directly applicable.
3. **Partition table** (`my_cores3_16MB.csv`) — confirms 16MB flash with ~6.25MB OTA partitions + a dedicated coredump partition works on CoreS3. Good reference for our flash layout.
4. **Servo API pattern** — `moveToGaze(gazeX, gazeY)` / `moveToOrigin()` is the right abstraction. Our servo port should match this.
5. **Telegram bridge pattern** — the proxy's `GET /v1/pending` queue + bidirectional Telegram relay is a clean pattern for async messages going TO the robot. Worth borrowing conceptually.
6. **Triple-buffer speaker output** — the 3×640-sample `playRaw` buffering is a solid pattern for glitch-free audio on M5Unified.
7. **WAV-header-in-PSRAM recording** — `AudioWhisper` builds a WAV header in PSRAM and records 16kHz mono; a clean reference for mic capture.

### Architecturally different (can't directly reuse)
1. **REST proxy vs native node** — they use HTTP+JSON through a Node.js middleman; we use WebSocket+WebRTC via esp-openclaw-node. Different build systems (Arduino/PlatformIO vs ESP-IDF).
2. **M5Unified/M5GFX/m5avatar** — their whole display/audio stack is M5Unified-specific. Not reusable in an ESP-IDF build.
3. **SimpleVox wake word** — custom MFCC; we're using Espressif's WakeNet (more robust, no sample recording).
4. **Cloud STT/TTS** — they offload all STT/TTS to the cloud; we want WebRTC audio through OpenClaw.

### Not useful
- The LLM/TTS/STT abstraction layers (ChatGPT, Gemini, WebVoiceVox, ElevenLabs, ModuleLLM) — OpenClaw handles all of that for us.
- WebAPI, FTP server, SD updater, photo frame, pomodoro, status monitor, volume mods.
- The `m5avatar` face system itself (different from both xiaozhi's LvglDisplay and room-node's built-in face).

---

## KEY INSIGHT FOR OUR ARCHITECTURE DECISION

plaipin proves the concept but took the **easy path**. Their architecture has three layers (ESP32 → Node proxy → Gateway) and is half-duplex, non-streaming, and non-TLS on the device leg. 

**Our native path (direct WebSocket + WebRTC via esp-openclaw-node) is strictly better on:**
- No proxy server to maintain (fewer moving parts, no Node dependency on host)
- Lower latency (direct WebSocket, no HTTP round-trip, streaming instead of wait-for-final)
- WebRTC audio (full-duplex, better quality than their HTTP-delivered TTS)
- Native OpenClaw node features (face state, commands, provisioning)
- TLS/security (native node handles auth properly)

**What we should borrow from plaipin regardless of architecture:**
- The emoji-stripping + response-sanitization logic (protects TTS)
- The partition table layout (with coredump partition)
- The `moveToGaze`/`moveToOrigin` servo abstraction
- The Telegram-bridge queue pattern for async messages to the robot
- The triple-buffer speaker pattern (if we end up on M5Unified)

**Bottom line:** plaipin is a working validation that Stack-chan + OpenClaw is real, but it is a bridge/POC, not a native implementation. We are building the harder, better version. Reuse its text-sanitization and servo/partition patterns; ignore its proxy architecture.
