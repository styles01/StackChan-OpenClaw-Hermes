# STEP 1 — StackChan Firmware: LLM Backend Code Path

**Date:** 2026-08-19
**Repo:** `<repo-root>/stackchan-node/repos/StackChan` (GitHub m5stack/StackChan)
**Goal:** Map exactly where the LLM backend connects so we can swap it for an OpenClaw/Hermes agent adapter with MINIMAL changes — keeping STT/TTS/avatar/UI intact.

---

## Executive Summary

The StackChan firmware runs **two separate network backends** that must NOT be confused:

1. **StackChan server backend** (Go server, `/stackChan/*` REST + `/stackChan/ws` WebSocket) — handles device registration, app store, account binding, and **avatar/camera/device control** (not LLM).
2. **Xiaozhi-esp32 agent backend** (the LLM voice assistant) — the device is a **thin audio client** over a **WebSocket agent protocol** to a xiaozhi-compatible agent server. **This is where the LLM lives and where our adapter must plug in.**

**Critical architecture fact:** The device does NOT run STT or LLM locally. It captures **OPUS-encoded microphone audio** and streams it up a WebSocket to the agent server. The **server performs STT, runs the LLM, synthesizes TTS, and streams OPUS audio + JSON control events back down**. STT and TTS are the server's responsibility in the default config. The firmware only: captures mic → encodes OPUS → sends; receives OPUS → decodes → plays, plus renders text/emotion events on the LCD.

> This means our adapter is a **server-side replacement** (implement the xiaozhi agent WebSocket protocol), not a firmware STT/LLM substitution. If we want local/OpenClaw STT, we must insert an STT stage on our adapter between the incoming OPUS and the LLM call.

---

## 1. Build System

- **Framework:** ESP-IDF 5.5.4 (`idf.py build`), target **ESP32-S3**.
- `firmware/main/CMakeLists.txt` builds a **single component** that mixes:
  - **Xiaozhi source** (`firmware/xiaozhi-esp32/main/...` — a submodule of `78/xiaozhi-esp32`, branch **v2.2.4**). This provides `application.cc`, `protocols/`, `audio/`, `boards/common/`, `settings.cc`, `ota.cc`, `mcp_server.cc`, etc.
  - **StackChan HAL + apps** (`firmware/main/...`): `main.cpp`, `hal/`, `apps/`, `stackchan/`, `assets/`.
- **Dependency fetch:** `firmware/fetch_repos.py` clones repos listed in `firmware/repos.json`:
  - `mooncake`, `mooncake_log`, `smooth_ui_toolkit` (UI toolkit)
  - **`78/xiaozhi-esp32` @ v2.2.4** (the voice/LLM stack — MOST IMPORTANT)
  - `ArduinoJson`, `esp-now`
- **Patches:** `firmware/patches/xiaozhi-esp32.patch` applies to xiaozhi-esp32. It only customizes **activation message UX** and an **i2c device** file. **It does NOT touch the LLM protocol.** The LLM backend code is stock xiaozhi v2.2.4.
- **Board files:** `BOARD_TYPE=m5stack-stack-chan` compiles xiaozhi board `m5stack-stack-chan` — but that directory does NOT exist in xiaozhi's `boards/`. The actual StackChan board (audio codec, display, power) is the StackChan repo's own `main/hal/board/stackchan.cc`, wired via `hal_bridge` to xiaozhi's `Board::GetInstance()`. This is peripheral to the LLM swap.

**Key build files:**
- `firmware/main/CMakeLists.txt` — compiles both source trees into one component.
- `firmware/main/main.cpp` — `app_main()`: HAL init → mooncake UI loop → `GetHAL().startXiaozhi()` (never returns).
- `firmware/main/Kconfig.projbuild` — defines `CONFIG_STACKCHAN_SERVER_URL`, `CONFIG_OTA_URL`, board choices.

---

## 2. Config System (How the device knows where to connect)

Two independent config paths:

### A. LLM backend URL (xiaozhi websocket) — NVS via OTA config
- The agent backend URL is stored in **NVS** under namespace **`websocket`**, key **`url`** (plus `token`, `version`).
- It is populated **at runtime** by the **OTA config fetch** (`firmware/xiaozhi-esp32/main/ota.cc`).
  - Device POSTs device info to `CONFIG_OTA_URL` (default `https://api.tenclass.net/xiaozhi/ota/`).
  - Server returns JSON; the `websocket` section is written verbatim into NVS `websocket` namespace:
    ```json
    { "websocket": { "url": "wss://...", "token": "...", "version": 1 } }
    ```
- `WebsocketProtocol::OpenAudioChannel()` (`protocols/websocket_protocol.cc`) reads it:
  ```cpp
  Settings settings("websocket", false);
  std::string url   = settings.GetString("url");
  std::string token = settings.GetString("token");
  int version       = settings.GetInt("version");
  ```
- **No hardcoded URL at compile time for the agent** — it's delivered by the OTA server. **To point at our own agent adapter, either (a) run a tiny OTA endpoint returning our websocket URL, or (b) patch `WebsocketProtocol` to use a fixed URL (minimal change).**

### B. StackChan server URL — compile-time Kconfig
- `CONFIG_STACKCHAN_SERVER_URL` (default `http://47.113.125.164:12800`) → `secret_logic::get_server_url()`.
- Used for avatar websocket (`/stackChan/ws`), app store, device registration. **Not the LLM.** Override via `sdkconfig.defaults.local`.

---

## 3. Board Selection

- `sdkconfig.defaults`: `CONFIG_IDF_TARGET="esp32s3"`, `CONFIG_BOARD_TYPE_M5STACK_STACK_CHAN=y`.
- CMake `if(CONFIG_BOARD_TYPE_M5STACK_STACK_CHAN)` sets `BOARD_TYPE="m5stack-stack-chan"`.
- The xiaozhi `boards/m5stack-stack-chan/` dir is absent → the real StackChan board is `main/hal/board/stackchan.cc` (glued into xiaozhi `Board` via `hal_bridge`). This board is already built and working; **no board changes needed for the LLM swap.**

---

## 4. LLM Protocol

Two `Protocol` subclasses in `firmware/xiaozhi-esp32/main/protocols/`:

| Protocol | Transport | When used |
|----------|-----------|-----------|
| **`WebsocketProtocol`** | WebSocket (text JSON + binary OPUS) | When OTA config has a `websocket` section |
| `MqttProtocol` | MQTT + UDP (with AES) | When OTA config has an `mqtt` section, or fallback |

Selection logic in `application.cc::InitializeProtocol()`:
```cpp
if (ota_->HasMqttConfig())         protocol_ = std::make_unique<MqttProtocol>();
else if (ota_->HasWebsocketConfig()) protocol_ = std::make_unique<WebsocketProtocol>();
else                               protocol_ = std::make_unique<MqttProtocol>();
```

**The agent protocol is a full-duplex, binary/JSON WebSocket:** (the xiaozhi open-agent spec, v1/v2/v3 binary framing).

### WebsocketProtocol handshake (`websocket_protocol.cc`)
1. Device connects to `url`, sets headers: `Authorization: Bearer <token>`, `Protocol-Version`, `Device-Id` (MAC), `Client-Id` (UUID).
2. Device sends JSON `hello`:
   ```json
   {
     "type": "hello",
     "version": 1,
     "features": {"aec": false, "mcp": true},
     "transport": "websocket",
     "audio_params": {"format": "opus", "sample_rate": 16000, "channels": 1, "frame_duration": 60}
   }
   ```
3. Server must reply with JSON `hello` containing `transport`, `session_id`, `audio_params` (sample_rate, frame_duration).
4. Audio flows **binary**: client→server = encoded mic OPUS; server→client = OPUS for TTS playback.

### JSON event types the device parses (in `OnIncomingJson`)
- **`tts`** — `state`: `start`/`stop`/`sentence_start`; drives device into Speaking state + displays assistant text.
- **`stt`** — `text`: displays user's recognized speech.
- **`llm`** — `emotion`: sets avatar emotion.
- **`mcp`** — `payload`: MCP tool invocation (device-side tools, optional).
- **`system`** — `command`: e.g. `reboot`.
- **`alert`** — `status`/`message`/`emotion`: shows alert.

Device→server control messages (on `Protocol` base): `SendStartListening`, `SendStopListening`, `SendWakeWordDetected`, `SendAbortSpeaking`, `SendMcpMessage`, plus binary OPUS audio.

---

## 5. Code Path (STT → LLM → TTS)

This is the **xiaozhi thin-client** flow, orchestrated by `firmware/xiaozhi-esp32/main/application.cc`.

### STT side (mic → server)
```
[Microphone] --PCM--> [AudioProcessor (AEC/wake word)] --> {Encode Queue}
   --> [Opus Encoder, 16kHz, 60ms frames] --> {Send Queue}
   --> Application::HandleStartListening/WakeWordInvoke --> protocol_->OpenAudioChannel()
   --> MAIN_EVENT_SEND_AUDIO --> protocol_->SendAudio(binary OPUS) --> WebSocket --> SERVER
```
- Wake word (`hi, stack chan`) detected locally (ESP-SR) → opens channel → streams mic OPUS.
- VAD determines start/stop of speech; the device streams continuously while listening.

### LLM (server side) — where our adapter plugs in
- **Server receives OPUS → runs STT (server-side) → runs LLM → runs TTS (server-side)**.
- Server streams back: binary OPUS audio (TTS) + JSON events (`stt`, `llm`, `tts`).

### TTS side (server → speaker)
```
Server --binary OPUS--> WebsocketProtocol::OnData (binary) --> on_incoming_audio_
   --> audio_service_.PushPacketToDecodeQueue --> Opus decoder --> Playback Queue --> Speaker
Server --JSON "tts"--> protocol_->OnIncomingJson --> state machine (Speaking/Idle/Listening) + LCD text
```

### Where the response reaches the device
- `protocol_->OnIncomingAudio` → decode queue → speaker.
- `protocol_->OnIncomingJson` → switch on `type` (`tts`/`stt`/`llm`/`mcp`/`system`/`alert`).

---

## 6. Integration Points (exact files to touch / replace)

The **only** place the LLM backend connects is through the `Protocol` interface in `application.cc`. To swap the LLM backend, you replace the server, not the firmware — but if you want the firmware to reach your adapter, these are the touch points:

1. **`firmware/xiaozhi-esp32/main/protocols/websocket_protocol.cc`** — `OpenAudioChannel()` reads `websocket.url` from NVS. **Minimal change:** override the URL here (or via OTA config) to point at your adapter. This is the single connection point.

2. **`firmware/xiaozhi-esp32/main/ota.cc`** — if you keep the OTA mechanism, make `CONFIG_OTA_URL` (Kconfig) or the served config return your `websocket.url`. No code change needed; just your server.

3. **`firmware/main/Kconfig.projbuild`** — `CONFIG_STACKCHAN_SERVER_URL` (not LLM) and `CONFIG_OTA_URL` (feeds LLM URL) defaults.

4. **`application.cc::InitializeProtocol`** — protocol selection; no change needed if using websocket.

**No changes required** to: STT capture, OPUS encoding/decoding, TTS playback, audio service, wake word, board/HAL, UI apps, avatar. All of that stays as-is and talks to the server protocol.

---

## 7. Minimal Changes Needed (recommended approach)

**Option A — Server-side adapter (recommended, ZERO firmware STT/LLM changes):**
Build a WebSocket server that speaks the xiaozhi agent protocol:
1. Accept device `hello`, respond with `hello` + `session_id` + `audio_params` (opus, 16kHz, 60ms).
2. Receive OPUS audio frames → **STT** (transcribe) → send to OpenClaw/Hermes agent → get reply text → **TTS** → send back OPUS audio + JSON `tts`/`stt`/`llm` events.
3. Point the device at it by returning `{"websocket":{"url":"wss://our-adapter/"}}` from the OTA URL, **OR** patch `websocket_protocol.cc` to use a fixed URL (1-line-ish change).

**Option B (if we want OpenClaw to own STT/TTS locally instead of server):**
Still keep the xiaozhi protocol on the wire; the adapter just implements STT→LLM→TTS itself. Same integration point — no firmware changes.

**If the firmware URL must be hardcoded (no OTA):**
Edit `firmware/xiaozhi-esp32/main/protocols/websocket_protocol.cc`:
```cpp
// Settings settings("websocket", false);
// std::string url = settings.GetString("url");
std::string url = "wss://your-agent-adapter.example/";
```
Keep `token`/`version` from NVS if needed. This is the single minimal firmware edit.

---

## Critical Facts to Remember
- **STT/TTS are server-side** in the default xiaozhi protocol — the device only OPUS-encodes mic and decodes TTS. Your adapter must do STT + TTS (or bridge to OpenClaw/Hermes services).
- Two websockets exist: `/stackChan/ws` (avatar/control, Go server) vs the **agent websocket** (LLM). Do not confuse them.
- LLM backend code is **stock xiaozhi-esp32 v2.2.4** (only UX patches applied) — clean upstream, well-documented protocol.
- Agent URL comes from **OTA config** (remote), so pointing to our adapter can be done via config without reflashing.
