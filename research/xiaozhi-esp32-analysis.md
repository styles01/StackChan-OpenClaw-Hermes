# xiaozhi-esp32 v2.2.6 Deep-Dive Analysis — for OpenClaw Integration into Hermes-StackChan

**Prepared by:** ernest (subagent)
**Date:** 2026-08-18
**Scope:** Deep technical analysis of the `xiaozhi-esp32` v2.2.6 firmware (the AI-assistant integration layer used by the official StackChan firmware) to plan porting an OpenClaw backend into the **Hermes-StackChan** fork.

---

## 0. TL;DR — Integration Summary

- **xiaozhi-esp32** is a full ESP-IDF "AI assistant" firmware. Its core is an event-loop `Application` that connects to a cloud server via **WebSocket** (or MQTT+UDP), streams **Opus-encoded** microphone audio up, receives Opus TTS audio down, and dispatches **JSON messages** by `type` (TTS/STT/LLM/MCP/system/alert).
- **The `Protocol` interface is the clean seam for a backend.** `WebsocketProtocol` and `MqttProtocol` are two implementations. Adding an **`OpenClawProtocol`** (HTTP/SSE streaming backend) is the natural integration point.
- **The StackChan fork does NOT rewrite xiaozhi.** It vendors the xiaozhi repo at `v2.2.4` (patched), defines its own board (`m5stack-stack-chan`) that overrides the display with `StackChanAvatarDisplay`, and calls `Application::Initialize()` + `Application::Run()` inside its Mooncake app shell. The protocol layer is untouched.
- **Hermes-StackChan already has a self-hosted HTTP backend** (`CONFIG_STACKCHAN_SERVER_URL` → `http://<host>:12800` with `/stackChan/*` REST endpoints and a `/stackChan/ws` WebSocket). **OpenClaw plugs in best at the protocol layer** (a new `Protocol` impl) or as an HTTP endpoint in the StackChan HAL.
- **Key compatibility fact:** The device's own mic audio is **Opus 16 kHz mono**, and it *requires* downlink audio to be **Opus** as well (the `OpusCodecTask` decodes all inbound binary frames as Opus). An OpenClaw backend must return Opus-encoded TTS audio (or be wrapped in a proxy that transcodes).

---

## 1. Architecture Overview

### 1.1 Boot / Entry (`main/main.cc`)

`app_main()` is trivial:
1. Init NVS flash.
2. `Application::GetInstance().Initialize()` — set up display, audio codec, audio service, state machine, network callbacks.
3. `Application::GetInstance().Run()` — **the main event loop, never returns**.

> In the StackChan fork, `main.cpp` does NOT call `app_main()` directly. Instead, the fork's `hal_bridge::start_xiaozhi_app()` calls `Application::Initialize()` + `Application::Run()` after the Mooncake app shell finishes (see §8). `Application::Run()` blocks forever on the xiaozhi event loop.

### 1.2 Application lifecycle (`main/application.cc`)

`Application` is a singleton built around an **event group** (`xEventGroupCreate()`) and a **state machine**. It:

- **Initializes**: display UI, audio codec + `AudioService`, MCP server common tools, network event callback, then `board.StartNetwork()` (async).
- **Runs** an event loop that waits on a bitmask of events and dispatches handlers:
  - `MAIN_EVENT_NETWORK_CONNECTED` → activation flow (version check, OTA check, then `InitializeProtocol()`).
  - `MAIN_EVENT_SEND_AUDIO` → pops encoded Opus packets from `AudioService` send queue and calls `protocol_->SendAudio(...)`.
  - `MAIN_EVENT_WAKE_WORD_DETECTED` / `MAIN_EVENT_VAD_CHANGE` → listening/speaking transitions.
  - `MAIN_EVENT_STATE_CHANGED` → updates display/LED per state.
  - `MAIN_EVENT_SCHEDULE` → runs queued `std::function`s (main-thread marshaling).
  - `MAIN_EVENT_CLOCK_TICK` → status bar updates + heap stats.

### 1.3 Activation flow (key: where the backend URL is chosen)

After network connects, `ActivationTask()` runs:
1. `CheckAssetsVersion()` — downloads assets to a dedicated partition if a URL is pending.
2. `CheckNewVersion()` — HTTP POST to `CONFIG_OTA_URL` (or `wifi`/`ota_url` NVS). The response JSON may contain:
   - `firmware` (version/url/force) → OTA upgrade.
   - `activation` (code/challenge) → activation sequence (HMAC-SHA256 with efuse serial).
   - `mqtt` object → written to NVS namespace **`mqtt`**.
   - `websocket` object → written to NVS namespace **`websocket`** (`url`, `token`, `version`).
   - `server_time` → sets system clock.
3. `InitializeProtocol()`:
   ```cpp
   if (ota_->HasMqttConfig())      protocol_ = make_unique<MqttProtocol>();
   else if (ota_->HasWebsocketConfig()) protocol_ = make_unique<WebsocketProtocol>();
   else                           protocol_ = make_unique<MqttProtocol>(); // default
   ```

### 1.4 State machine (`main/device_state.h`, `device_state_machine.cc`)

States: `Unknown, Starting, WifiConfiguring, Idle, Connecting, Listening, Speaking, Upgrading, Activating, AudioTesting, FatalError`.

- `DeviceStateMachine` enforces **valid transitions** (e.g. cannot go Idle→Speaking directly), notifies listeners.
- **Audio channel lifecycle** (the protocol's core contract):
  - `Idle → Connecting` (wake word / button) → `OpenAudioChannel()` → server hello → `Listening`.
  - `Listening → Speaking` on server `tts/state=start`; `Speaking → Listening/Idle` on `tts/state=stop`.
  - `AbortSpeaking()` sends `type:abort`; `CloseAudioChannel()` tears down.
- `listening_mode_`: `AutoStop`, `ManualStop`, `Realtime` (requires AEC).

### 1.5 Full audio + network data flow

```
MIC --I2S--> AudioCodec --PCM--> [AudioInputTask] --16k PCM--> AudioProcessor(AEC/VAD/NR)
                                                                    |
                                                                    v  (clean PCM)
                                                             audio_encode_queue_
                                                                    |
                                              [OpusCodecTask] OpusEncoder (16k mono, 60ms)
                                                                    |
                                                             audio_send_queue_ (Opus packets)
                                                                    |
                                        Application::Run --MAIN_EVENT_SEND_AUDIO--> Protocol::SendAudio()
                                                                    |
                                                              (WebSocket binary frame OR MQTT+UDP)
                                                                    |
                                                                   Server
                                                                    |
                                                              (WebSocket binary OR UDP encrypted)
                                                                    |
                                                             on_incoming_audio_ --> audio_decode_queue_
                                                                    |
                                              [OpusCodecTask] OpusDecoder --> (resample) --> audio_playback_queue_
                                                                    |
                                              [AudioOutputTask] --> AudioCodec --I2S--> SPEAKER

  JSON control: Protocol::SendText(...) <--> on_incoming_json_ --> Application::HandleJson (tts/stt/llm/mcp/system/alert)
```

---

## 2. WebSocket Protocol (`main/protocols/`)

### 2.1 The `Protocol` interface (`protocol.h`)

`Protocol` is a pure-virtual base with:
- **Audio**: `OpenAudioChannel()`, `CloseAudioChannel()`, `IsAudioChannelOpened()`, `SendAudio(unique_ptr<AudioStreamPacket>)`.
- **JSON control**: `SendWakeWordDetected()`, `SendStartListening(mode)`, `SendStopListening()`, `SendAbortSpeaking(reason)`, `SendMcpMessage(json)`.
- **Callbacks**: `OnIncomingAudio`, `OnIncomingJson`, `OnAudioChannelOpened/Closed`, `OnNetworkError`, `OnConnected/Disconnected`.
- State: `server_sample_rate_` (default 24000), `server_frame_duration_` (default 60), `session_id_`, timeout (120s inactivity).

**`AudioStreamPacket`**: `{ sample_rate, frame_duration, timestamp, payload (vector<uint8_t>) }`.

### 2.2 `WebsocketProtocol` (`websocket_protocol.cc`)

- **Lazy connect**: `Start()` returns true without connecting; connection happens in `OpenAudioChannel()`.
- **Settings** read from NVS namespace `websocket`: `url`, `token`, `version`.
- **Headers** set on the socket:
  - `Authorization: Bearer <token>` (prefix added if missing a space)
  - `Protocol-Version: <version>`
  - `Device-Id: <MAC address>`
  - `Client-Id: <software UUID>`
- **Handshake**: `Connect(url)` → send `hello` JSON → wait for server `hello` (10s timeout).
- **Hello (device→server)**:
  ```json
  {
    "type": "hello",
    "version": 1,
    "features": { "mcp": true, "aec": true },
    "transport": "websocket",
    "audio_params": { "format": "opus", "sample_rate": 16000, "channels": 1, "frame_duration": 60 }
  }
  ```
- **Server hello** parsed: `transport` must be `"websocket"`; captures `session_id`, `audio_params.sample_rate`, `audio_params.frame_duration` → sets `on_audio_channel_opened_`.
- **Binary receive**: decoded as Opus → `on_incoming_audio_` (only pushed to decode queue when state == Speaking).
- **Text receive**: parsed with `cJSON_ParseWithLength`; if `type == "hello"` handled internally, else forwarded to `on_incoming_json_`.

### 2.3 Binary framing versions (per `version` NVS setting)

- **v1 (default)**: raw Opus frames. WebSocket binary opcode distinguishes from text.
- **v2**: `BinaryProtocol2 { uint16 version; uint16 type; uint32 reserved; uint32 timestamp; uint32 payload_size; uint8 payload[]; }` — timestamp useful for server-side AEC.
- **v3**: `BinaryProtocol3 { uint8 type; uint8 reserved; uint16 payload_size; uint8 payload[]; }` — lightweight header.
- Network byte order applied via `htons/htonl`.

> **Note:** the current official xiaozhi server mostly uses **v3** (and MQTT uses v3-style framing over UDP). The WebSocket `version` is negotiated via the `version` NVS setting and echoed in the `Protocol-Version` header.

### 2.4 `MqttProtocol` (`mqtt_protocol.cc`) — the other backend

For completeness: MQTT for JSON control (namespace `mqtt`: `endpoint`, `client_id`, `username`, `password`, `publish_topic`, `keepalive`), and a **UDP channel for audio** negotiated via the server hello (`udp: {server, port, key, nonce}`). Audio over UDP is **AES-128-CTR encrypted** Opus frames. This shows the pattern: **control plane (JSON) and audio plane can be separate transports.**

---

## 3. JSON Message Protocol (device ↔ server)

Documented fully in `docs/websocket.md`. Summary:

### 3.1 Device → Server (text)
| Message | Example |
|---|---|
| hello | `{"type":"hello","version":1,"features":{"mcp":true},"transport":"websocket","audio_params":{...}}` |
| listen start | `{"session_id":"x","type":"listen","state":"start","mode":"auto"\|"manual"\|"realtime"}` |
| listen stop | `{"session_id":"x","type":"listen","state":"stop"}` |
| wake word detect | `{"session_id":"x","type":"listen","state":"detect","text":"Hi XiaoZhi"}` |
| abort | `{"session_id":"x","type":"abort","reason":"wake_word_detected"}` |
| mcp | `{"session_id":"x","type":"mcp","payload":<JSON-RPC 2.0>}` |

### 3.2 Server → Device (text, dispatched in `Application::OnIncomingJson`)
| `type` | Purpose | Fields |
|---|---|---|
| hello | handshake ack | `transport`, `session_id`, `audio_params` |
| stt | ASR result shown on screen | `text` |
| llm | set avatar emotion | `emotion`, `text` |
| tts | TTS playback control | `state`: `start`/`stop`/`sentence_start`, `text` |
| mcp | IoT control / tool results | `payload` (JSON-RPC 2.0) |
| system | reboot etc. | `command` |
| alert | show alert + vibration | `status`, `message`, `emotion` |
| custom | (if `CONFIG_RECEIVE_CUSTOM_MESSAGE`) arbitrary | `payload` |

---

## 4. MCP Server (`main/mcp_server.cc`, `mcp_server.h`)

**This is the IoT control plane and the most OpenClaw-relevant existing surface.**

- Implements a **JSON-RPC 2.0 server** embedded in the firmware. Spec: `2024-11-05`.
- Inbound MCP messages arrive as `{"type":"mcp","payload":{...}}` via `on_incoming_json_` → `McpServer::ParseMessage(payload)`.
- Responses are sent back as `{"session_id":"x","type":"mcp","payload":<jsonrpc result>}` via `Application::SendMcpMessage()` → `protocol_->SendMcpMessage()`.
- **Methods handled:**
  - `initialize` → returns `{protocolVersion, capabilities:{tools:{}}, serverInfo:{name, version}}`.
  - `tools/list` → paginated tool list (max 8 KB payload, uses `cursor`/`nextCursor`).
  - `tools/call` → executes a registered tool.
  - `notifications/*` → ignored.
- **Tool model:** `McpTool { name, description, PropertyList(inputSchema), callback }`, `user_only` flag (annotated with `audience:["user"]` so AI can't see user-only tools).
- **Built-in tools** (`AddCommonTools`): `self.get_device_status`, `self.audio_speaker.set_volume`, `self.screen.set_brightness`, `self.screen.set_theme`, `self.camera.take_photo`.
- **User-only tools** (`AddUserOnlyTools`): `self.get_system_info`, `self.reboot`, `self.upgrade_firmware`, `self.screen.get_info`, `self.screen.snapshot`, `self.screen.preview_image`, `self.assets.set_download_url`.
- **Vision capability** (`ParseCapabilities`): server can push a vision URL/token to enable camera explain (`camera->SetExplainUrl`).

> **OpenClaw implication:** The device is an *MCP server* that exposes device capabilities. When OpenClaw becomes the backend, OpenClaw (the LLM agent) becomes the *MCP client* that calls these `self.*` tools. This is exactly the `MCP` transport that OpenClaw already supports. The device-side MCP server is **transport-agnostic** — it only depends on JSON-RPC messages arriving via the protocol. It will work over an OpenClaw HTTP/SSE channel unchanged.

---

## 5. Board Support (`main/boards/`)

### 5.1 Board architecture

- ~98 boards under `main/boards/`, each a directory with `config.h`, `config.json`, a `*_audio_codec.cc`, and a board class file.
- **`Board`** abstract interface (`boards/common/board.h`): `GetBoardType()`, `GetUuid()`, `GetBacklight()`, `GetLed()`, `GetAudioCodec()`, `GetDisplay()`, `GetCamera()`, `GetNetwork()`, `StartNetwork()`, `SetPowerSaveLevel()`, etc.
- **`WifiBoard`** (common base) adds WiFi manager integration, provisioning, power save.
- **Board instantiation** uses `DECLARE_BOARD(ClassName)` → generates `create_board()` returning a new board → `Board::GetInstance()` static singleton calls it.

### 5.2 Build-time selection

- `main/Kconfig.projbuild` defines `BOARD_TYPE_*` choices (e.g. `CONFIG_BOARD_TYPE_M5STACK_CORE_S3`).
- `main/CMakeLists.txt` maps Kconfig → `BOARD_TYPE` string and compiles `boards/<manufacturer>/<board>/` sources.
- `config.json` sets the IDF target (`esp32s3`) and `sdkconfig_append`.

### 5.3 M5Stack CoreS3 (`boards/m5stack-core-s3/`)

- **config.h**: I2S audio pins (MCLK 0, WS 33, BCLK 34, DIN 14, DOUT 13), audio codecs **AW88298** (amp) + **ES7210** (ADC) at 24 kHz in/out, ILI9342 SPI display 320×240, GC0308 camera.
- **m5stack_core_s3.cc**: initializes AXP2101 PMIC, AW9523 IO expander, FT6336 touch, SPI display, DVP camera; a 20 ms touchpad poller; power-save timer (60 s sleep / 300 s shutdown).
- **Display**: `SpiLcdDisplay` (LVGL). The **StackChan fork replaces this** with `StackChanAvatarDisplay` (see §8).

---

## 6. Audio Pipeline (`main/audio/`)

### 6.1 `AudioService` threading (3 tasks)

1. **`AudioInputTask`** (core 0, pri 8): reads raw PCM from codec at 16 kHz/10 ms, feeds `WakeWord` and/or `AudioProcessor` (AEC/VAD/NR) based on event flags.
2. **`OpusCodecTask`** (pri 2): encode PCM→Opus (16 kHz mono, 60 ms frames) into `audio_send_queue_`; decode Opus→PCM into `audio_playback_queue_` (with resampling).
3. **`AudioOutputTask`** (pri 4): takes decoded PCM → `codec->OutputData()` → speaker.

### 6.2 Codec details

- **Encoder**: `esp_opus_enc`, **16 kHz mono, 60 ms frames** (`OPUS_FRAME_DURATION_MS`), `ESP_OPUS_BITRATE_AUTO`, VBR on, DTX on, complexity 0.
- **Decoder**: `esp_opus_dec`, configurable sample rate (defaults to codec output, typically 24 kHz for CoreS3), re-created dynamically when server sample rate changes.
- **Resampling**: input resampler (codec rate → 16 kHz) and output resampler (decoder rate → codec rate) via `esp_ae_rate_cvt`.
- **Codecs supported** (HAL layer): `es8311`, `es8374`, `es8388`, `es8389`, `box`, `dummy`, `no`. (CoreS3 uses a custom `cores3_audio_codec`.) All produce **16-bit PCM over I2S**.
- **Wake words**: AFE-based (`esp-sr` WN9 etc.) on S3/P4; `esp_wake_word` on others.
- **Local sounds**: OGG assets demuxed (`OggDemuxer`) and pushed through the same decode/playback path (so the device can play UI sounds without a server).
- **Power**: input/output channels auto-disabled after 15 s inactivity.

> **OpenClaw implication:** Upstream mic audio = Opus 16 kHz mono. Downlink must be Opus (the decoder rejects non-Opus binary). If OpenClaw's HTTP API returns PCM/WAV/MP3, **a transcoding proxy is required** unless the OpenClaw channel delivers Opus.

---

## 7. Display System (`main/display/`)

- **`Display`** abstract base: `SetStatus`, `ShowNotification`, `SetEmotion`, `SetChatMessage(role, content)`, `ClearChatMessages`, `SetTheme`, `UpdateStatusBar`, `SetPowerSaveMode`, `SetupUI`, plus lock/unlock.
- **LVGL implementations**: `LvglDisplay` (base), `LcdDisplay` (SPI/RGB/MIPI LCD with chat bubbles + emoji + GIF), `OledDisplay` (128×64-ish), `EmoteDisplay` (the `esp_emote_expression` animatable emoji engine used on smaller/cheaper boards).
- **Avatar/expression**: `SetEmotion(name)` loads an emoji/GIF by name from a theme collection, falls back to FontAwesome glyph. `SetChatMessage` renders user/assistant/status text as subtitle bubbles.
- **Status bar**: network icon (from `WifiBoard::GetNetworkStateIcon()`), battery, clock.
- **The StackChan fork** replaces the whole display with `StackChanAvatarDisplay` (a custom `LvglDisplay` subclass) that renders the robot avatar + modifiers (`blink`, `idle_motion`, `speaking`, `idle_expression`) instead of a flat face. `SetEmotion`/`SetChatMessage` are overridden to drive the robot.

---

## 8. Network Config & Provisioning

### 8.1 WiFi provisioning (`boards/common/wifi_board.cc`)

- Uses the `78/esp-wifi-connect` component (`WifiManager`, `SsidManager`, `wifi_station`).
- `StartNetwork()` → if SSIDs stored, `StartStation()` (60 s timeout → config mode); else config mode.
- **Provisioning modes** (Kconfig-selectable):
  - `CONFIG_USE_HOTSPOT_WIFI_PROVISIONING` — soft-AP `Xiaozhi*` + captive web portal.
  - `CONFIG_USE_ESP_BLUFI_WIFI_PROVISIONING` — BLE `esp-blufi` provisioning (`Blufi::GetInstance()`).
  - `CONFIG_USE_ACOUSTIC_WIFI_PROVISIONING` — audio (AFSK) provisioning via the mic/speaker.
- AP SSID prefix defaults to `"Xiaozhi"`.

### 8.2 Server URL configuration

- **Via OTA/activation:** the OTA server's JSON response pushes the `websocket`/`mqtt` NVS namespaces (URL, token, version). This is the *official* way the device learns its backend.
- **Via NVS directly:** `Settings("websocket")` → `url`, `token`, `version`. A tool or provisioning step could write these directly.
- **StackChan fork:** `CONFIG_STACKCHAN_SERVER_URL` (default `http://47.113.125.164:12800`) — the HAL composes REST + WS endpoints from this base. Overridable via `sdkconfig.defaults.local`.

---

## 9. OpenClaw Integration Points (the core deliverable)

### 9.1 Where to add OpenClaw as a backend option

**Primary seam: the `Protocol` interface.** Add a third implementation, `OpenClawProtocol : public Protocol`, that:
- Implements the same virtuals (`Start`, `OpenAudioChannel`, `CloseAudioChannel`, `IsAudioChannelOpened`, `SendAudio`, `SendText`, plus inherited `SendStartListening/Stop/Abort/McpMessage`).
- Translates the xiaozhi JSON message vocabulary (§3) to/from OpenClaw's HTTP streaming API.
- Emits inbound Opus frames → `on_incoming_audio_`, and JSON → `on_incoming_json_`.

Then extend `Application::InitializeProtocol()` to pick `OpenClawProtocol` when a new NVS namespace (e.g. `openclaw`) or OTA config section is present:
```cpp
else if (ota_->HasOpenClawConfig())  protocol_ = make_unique<OpenClawProtocol>();
```

### 9.2 How WebSocket (Hermes) differs from OpenClaw HTTP API

| Aspect | xiaozhi WebSocket (Hermes) | OpenClaw HTTP |
|---|---|---|
| Transport | Persistent bidirectional WS | Request/response HTTP (POST), often SSE for streaming |
| Audio up | Binary Opus frames over WS | Requires HTTP multipart/chunked upload of Opus (or PCM + transcode) |
| Audio down | Binary Opus frames pushed over WS | HTTP/SSE response body (format TBD — likely needs Opus or proxy transcode) |
| Control | JSON `type:*` messages, both directions | OpenClaw API endpoints (sessions, messages, tools) |
| Session | `session_id` in hello | OpenClaw session ids |
| MCP | `type:"mcp"` JSON-RPC in-band | OpenClaw exposes MCP to LLM; device is MCP *server* (client role swaps) |

**Core mismatch:** xiaozhi is a **push/bidirectional streaming** model; OpenClaw is a **pull/request-response** model. Bridging requires a small **adapter layer** that:
1. Accumulates mic Opus frames into an utterance buffer (VAD-end triggers upload).
2. POSTs the utterance (and optionally wake-word context) to OpenClaw.
3. Reads OpenClaw's streaming response (SSE), demultiplexes **control JSON** (→ `on_incoming_json_`/display) from **TTS audio** (→ `on_incoming_audio_`), transcoding to Opus if needed.

### 9.3 Supporting BOTH backends (Hermes WS + OpenClaw HTTP)

Because both implement the same `Protocol` interface, the cleanest design is:
1. **Keep both protocols.** Select at build time (Kconfig) or runtime (NVS/OTA config).
2. **Factor shared logic** into `Protocol` base helpers (JSON builders already live there).
3. **The MCP server is already transport-agnostic** — it works over any protocol; no changes needed for MCP.
4. **Audio path is already transport-agnostic** — `AudioService` doesn't care how packets move; the protocol is the only audio I/O boundary.
5. **Recommendation:** implement `OpenClawProtocol` as a sibling; add a `CONFIG_BACKEND_*` Kconfig choice; keep Hermes WS as the default (works out-of-box with the existing xiaozhi server). For a first port, **a lightweight proxy** (`OpenClaw ↔ Hermes-WebSocket`) is far lower-risk than rewriting the transport, because it lets the firmware stay 100% unchanged (it thinks it's talking to a WS server) while OpenClaw is the real brain. The proxy handles: WS handshake/hello, Opus upload→OpenClaw, OpenClaw streaming→Opus+JSON→WS.

### 9.4 Specific code touch-points (if implementing a native protocol)

- **New files:** `main/protocols/openclaw_protocol.{h,cc}`, wired into `main/CMakeLists.txt`.
- **`application.cc` `InitializeProtocol()`:** add the branch.
- **`ota.cc` `CheckVersion()`:** add parsing for an `openclaw` JSON section (mirror `websocket`).
- **`settings`:** new NVS namespace `openclaw` (`url`, `token`, `api_key`).
- **`SystemInfo`:** reuse `GetMacAddress()`/`GetUuid()` for device identity headers.
- **HTTP client:** reuse `network->CreateHttp(...)` (already available on `NetworkInterface`), which supports POST/headers/read. For SSE streaming, use `CreateHttp` + incremental `Read()` (blocking) — acceptable given the existing event-loop threading model, but be aware of the 120 s `Protocol::IsTimeout()`.
- **`CONFIG_RECEIVE_CUSTOM_MESSAGE`:** enable to allow OpenClaw to push arbitrary display payloads.

### 9.5 Important constraints for any backend

1. **Downlink audio MUST be Opus** (or be transcoded). The decoder is Opus-only.
2. **Mic audio is 16 kHz mono Opus, 60 ms frames.**
3. **`session_id`** is expected by `SendStartListening/Abort/McpMessage`; if OpenClaw doesn't provide one, generate/omit consistently (JSON builder tolerates empty).
4. **120 s inactivity timeout** (`Protocol::IsTimeout()`) — an OpenClaw channel that goes silent >120 s will be treated as dead unless it pings.
5. **`on_audio_channel_closed_`** must fire on disconnect so the state machine returns to Idle.
6. **Power-save** (`OnAudioChannelOpened` → `PERFORMANCE`, closed → `LOW_POWER`) ties to the audio channel lifecycle.

---

## 10. Differences: v2.2.4 (StackChan) vs v2.2.6

### 10.1 Upstream functional changes (v2.2.4 → v2.2.6)

The core protocol/application layer changed **very little**. `git log v2.2.4..v2.2.6` = **51 commits**, dominated by board additions + bug fixes:

- **`application.cc`**: removed a redundant `play_popup_on_listening_ = true` in `ContinueWakeWordInvoke()` (CONFIG_SEND_WAKE_WORD_DATA path).
- **`websocket_protocol.cc`**: switched `cJSON_Parse(data)` → `cJSON_ParseWithLength(data, len)` (memory safety with fragmented/partial frames).
- **`es8311_audio_codec.cc`**: added mutex + null-check in `SetOutputVolume()` (crash fix).
- **`cJSON_ParseWithLength`** was the only protocol-affecting change.
- Everything else: new boards (NULLLAB-AI-VOX3, Waveshare AMOLED/C6/ePaper, ESP32-P4-WIFI6-Touch-LCD, freenove, etc.), dependency bumps (`esp_codec_dev>=1.5.5`, `esp-ml307`), GIF flicker race fixes, doc updates.

**No breaking changes to the WebSocket/JSON/MCP protocol between 2.2.4 and 2.2.6.**

### 10.2 The StackChan fork's own patches (on top of v2.2.4)

The `patches/xiaozhi-esp32.patch` in the StackChan firmware makes **minimal** changes:
1. **`application.cc` `ShowActivationCode()`**: commented out the digit-sound playback; replaced with a display message "Please bind and set up in the mobile app." (avoids the 9 KB SRAM sound-buffer bloat).
2. **`assets.cc`/`assets.h`**: commented out `EmoteStrategy` (the animatable-emote asset engine) since StackChan uses LVGL + its own avatar.
3. **`i2c_device.{cc,h}`**: added `TryReadRegs()` (non-fatal I2C read for the StackChan board's touch/power polling).

The **protocol, audio, MCP, and network layers are untouched** in the fork. So an OpenClaw protocol added against v2.2.6 will apply cleanly to the fork's v2.2.4 base (only the `cJSON_ParseWithLength` websocket change would be absent).

### 10.3 Recommendation on version

Since the functional delta is tiny and non-breaking, **porting to the fork's v2.2.4 base is safe**. If desired, bump the fork's submodule to v2.2.6 and re-apply the 4-file patch — low risk. The v2.2.6 `cJSON_ParseWithLength` fix is worth taking.

---

## 11. Appendix: Key Files & Symbols

| Concern | File |
|---|---|
| Main loop / app lifecycle | `main/application.cc`, `main/application.h` |
| Device state machine | `main/device_state.{h}`, `device_state_machine.{h,cc}` |
| Protocol interface | `main/protocols/protocol.{h,cc}` |
| WS backend | `main/protocols/websocket_protocol.{h,cc}` |
| MQTT+UDP backend | `main/protocols/mqtt_protocol.{h,cc}` |
| MCP (IoT) server | `main/mcp_server.{h,cc}` |
| OTA/activation/config push | `main/ota.{h,cc}` |
| NVS settings | `main/settings.{h,cc}` |
| Audio pipeline | `main/audio/audio_service.{h,cc}`, `main/audio/README.md` |
| Audio codec HAL | `main/audio/audio_codec.{h,cc}`, `main/audio/codecs/` |
| Display (LVGL) | `main/display/lvgl_display/`, `lcd_display.{h,cc}` |
| Board base | `main/boards/common/board.h`, `wifi_board.{h,cc}` |
| CoreS3 board | `main/boards/m5stack-core-s3/` |
| WebSocket client (78 component) | `managed_components/78__esp-ml307/{include,src}/web_socket.*` |
| Protocol docs | `docs/websocket.md`, `docs/mcp-protocol.md` |

**StackChan fork (Hermes) integration files:**
- `firmware/main.cpp` — Mooncake shell → `startXiaozhi()`.
- `firmware/main/hal/board/hal_bridge.{h,cc}` — bridges xiaozhi `Application` ↔ StackChan shell.
- `firmware/main/hal/board/stackchan.cc` — the `m5stack-stack-chan` board (overrides display).
- `firmware/main/hal/board/stackchan_display.{h,cc}` — `StackChanAvatarDisplay` (LVGL + robot avatar).
- `firmware/main/Kconfig.projbuild` — `STACKCHAN_SERVER_URL` (default `http://47.113.125.164:12800`).
- `firmware/patches/xiaozhi-esp32.patch` — the fork's 4-file patch set.
