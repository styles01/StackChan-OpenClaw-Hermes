# Xiaozhi-ESP32 Firmware — Technical Analysis for Building a Custom "Rosie" Node

**Repo:** github.com/78/xiaozhi-esp32 (local: `/Volumes/1TBSSDClawd/stackchan-node/firmware/xiaozhi-esp32`)
**Project version:** 2.4.2 (from root `CMakeLists.txt`)
**Target hardware:** M5Stack CoreS3 (`main/boards/m5stack/core-s3/`) — the Stack-chan body
**Analysis date:** 2026-08-17

---

## 1. What Is This Project?

**Xiaozhi (小智) is an open-source, MCP-based voice chatbot firmware for ESP32-family boards.** It turns an ESP32 (with mic, speaker, display, and optional camera) into a hands-free voice assistant that connects to a cloud backend for speech-to-text (STT), large-language-model (LLM) inference, and text-to-speech (TTS).

### Architecture Overview

```
┌────────────────────────────── ESP32 Device ──────────────────────────────┐
│                                                                          │
│  Board layer (main/boards/)  ── pins, codec, display, camera, network    │
│        │                                                                │
│  Application (main/application.cc)  ── state machine, orchestration     │
│        │                                                                │
│  AudioService (main/audio/)  ── capture → AFE → Opus encode → send      │
│        │                          receive → Opus decode → play          │
│        │                                                                │
│  Protocol (main/protocols/)  ── WebSocket OR MQTT+UDP transport        │
│        │                                                                │
│  McpServer (main/mcp_server.cc)  ── exposes device tools to the cloud   │
│        │                                                                │
│  Ota (main/ota.cc)  ── version check, firmware download, activation      │
└──────────────────────────────────────────────────────────────────────────┘
        │  (WebSocket or MQTT+UDP, JSON control + Opus audio)
        ▼
┌────────────────────────────── Cloud Backend ─────────────────────────────┐
│  xiaozhi.me (official) OR self-hosted server (e.g. xinnan-tech/          │
│  xiaozhi-esp32-server)                                                   │
│  STT (ASR) → LLM (Qwen/DeepSeek) → TTS, plus MCP client that calls      │
│  device tools                                                            │
└──────────────────────────────────────────────────────────────────────────┘
```

**Key architectural insight for Rosie:** The device is essentially a **thin audio + display + MCP-tool client**. All intelligence (STT, LLM, TTS, system prompt, personality) lives **on the cloud server**, not on the device. The device's "personality" is therefore defined by:
1. The **wake word** (on-device, ESP-SR).
2. The **system prompt / LLM config** (cloud-side, configured on the server).
3. The **display expressions** (on-device, emoji/emote assets).
4. The **MCP tools** it exposes (on-device, `mcp_server.cc`).

To make a "Rosie" node, the cleanest path is to **replace the cloud backend** (point the device at your own server that speaks the same protocol) and **customize the on-device wake word + display + MCP tools**. The firmware itself does not need deep modification for personality — the server does that.

---

## 2. Board Profiles

### How board profiles work

Each board lives in its own directory under `main/boards/` (grouped by manufacturer). A board directory contains:

- **`config.h`** — C preprocessor macros for pins, sample rates, display geometry, camera pins, codec I2C addresses.
- **`config.json`** — machine-readable board metadata: `manufacturer`, `type`, `target` (chip), and a `builds[]` array. Each build has a `name` (the OTA-reported board identity), `build_options` (semantic options like camera mirroring), and `sdkconfig_append` (extra `CONFIG_*` lines).
- **`<board>_board.cc`** — a C++ class (e.g. `M5StackCoreS3Board`) that subclasses `WifiBoard` (or `Board`), registers via `DECLARE_BOARD(...)`, and wires up the codec, display, camera, backlight, PMIC, touch, etc.
- **`README.md`** — build/flash notes.

The board class is selected at compile time via the `BOARD_TYPE_*` Kconfig choice (`main/Kconfig.projbuild` line ~122). `scripts/build.py` reads `config.json`, resolves the canonical `CONFIG_BOARD_TYPE_*` symbol, and injects it plus `sdkconfig_append` into the build.

### M5Stack CoreS3 (`main/boards/m5stack/core-s3/`)

- **`config.h`**: 24 kHz audio in/out, I2S pins (MCLK=0, WS=33, BCLK=34, DIN=14, DOUT=13), codec I2C (SDA=12, SCL=11), AW88298 amp + ES7210 ADC, 320×240 display, GC0308 camera (DVP, 8-bit), BOOT button on GPIO 0.
- **`m5stack_core_s3.cc`**: `M5StackCoreS3Board : WifiBoard`. Initializes AXP2101 PMIC (battery + backlight), AW9523 IO expander (resets AW88298 amp + ILI9342 LCD), FT6336 capacitive touch (short-tap toggles chat, long-press ignored), SPI ILI9342 LCD via `SpiLcdDisplay`, GC0308 camera via `EspVideo`, and a power-save timer (60s dim, 300s shutdown on battery).
- **`cores3_audio_codec.cc`**: `CoreS3AudioCodec` — dual codec (ES7210 mic ADC + AW88298 speaker amp) over I2S.
- **`config.json`**: target `esp32s3`, build name `m5stack-core-s3`, appends `CONFIG_SPIRAM_MODE_QUAD`, `CONFIG_CAMERA_GC0308`, etc.

**Build command:** `python ./scripts/build.py m5stack-core-s3` (or `idf.py` with the right `BOARD_NAME`).

---

## 3. Wake Word System (ESP-SR)

### How it works

The firmware uses **Espressif ESP-SR** for offline wake-word detection. There are three implementations, selected by the `WAKE_WORD_TYPE` Kconfig choice (`main/Kconfig.projbuild` ~line 867):

| Config | Meaning | Targets |
|--------|---------|---------|
| `WAKE_WORD_DISABLED` | No wake word | any |
| `USE_ESP_WAKE_WORD` | WakeNet model, no AFE | ESP32-C3/C5/C6, ESP32+PSRAM |
| `USE_AFE_WAKE_WORD` | WakeNet model **with AFE** (AEC/VAD) | **ESP32-S3**, P4, S31 + PSRAM |
| `USE_CUSTOM_WAKE_WORD` | **MultiNet** model (custom wake word) | ESP32-S3, P4, S31 + PSRAM |

**The CoreS3 (ESP32-S3) defaults to `USE_AFE_WAKE_WORD`** (the `default USE_AFE_WAKE_WORD if (IDF_TARGET_ESP32S3 ...) && SPIRAM` line).

### Where the wake word model is configured

1. **`sdkconfig.defaults.esp32s3`** sets the default model:
   ```
   CONFIG_SR_WN_WN9_NIHAOXIAOZHI_TTS=y
   ```
   This is the **"Ni Hao XiaoZhi" (你好小智)** WakeNet9 model — the stock wake word.

2. **`main/audio/engines/afe_audio_engine.cc`** — the AFE engine:
   - Loads models via `esp_srmodel_init("model")` (from the assets partition) or a passed-in `srmodel_list_t`.
   - Filters for a WakeNet model (`esp_srmodel_filter(models_, ESP_WN_PREFIX, ...)`) and/or a MultiNet model (`ESP_MN_PREFIX`).
   - If a **MultiNet** model is present → uses `CustomWakeWord` (custom wake word path).
   - Else if a **WakeNet** model is present → uses the stock WakeNet path.
   - Configures the AFE (`esp_afe_sr_iface_t`) with the chosen model.

3. **`main/audio/wake_words/custom_wake_word.cc`** — the custom wake word path:
   - Reads `CONFIG_CUSTOM_WAKE_WORD` (pinyin, space-separated), `CONFIG_CUSTOM_WAKE_WORD_DISPLAY` (the greeting text sent to server), and `CONFIG_CUSTOM_WAKE_WORD_THRESHOLD` (sensitivity %, default 20).
   - OR reads a `multinet_model` config from the assets `index.json` (for the online assets-generator flow).
   - Uses `esp_mn_handle_from_name()` + `esp_mn_iface_t` (MultiNet command-word recognition).

### How to change it to "Hey Rosie"

**Option A — Use the built-in custom wake word (MultiNet):** Set these in the build (via `sdkconfig_append` or `menuconfig`):
```
CONFIG_USE_AFE_WAKE_WORD=n
CONFIG_USE_CUSTOM_WAKE_WORD=y
CONFIG_CUSTOM_WAKE_WORD="hey luo xi"      # pinyin, space-separated
CONFIG_CUSTOM_WAKE_WORD_DISPLAY="Hey Rosie"
CONFIG_CUSTOM_WAKE_WORD_THRESHOLD=20
```
This requires a **MultiNet model** in the assets partition (the `esp_mn_*` model). The stock assets ship with WakeNet only, so you'd need to add a MultiNet model via the [xiaozhi-assets-generator](https://github.com/78/xiaozhi-assets-generator) tool or the online custom-assets flow.

**Option B — Use a pre-trained WakeNet model:** ESP-SR ships several WakeNet9 models (e.g. `wn9_jarvis_tts`, `wn9_hi_xiaozhi_tts`, etc.). `scripts/build.py` supports `--wake-word <model>`:
```
python ./scripts/build.py m5stack-core-s3 --wake-word wn9_jarvis_tts
```
List available models with `python ./scripts/build.py --list-wake-words`. **Note:** "Hey Rosie" is not a stock WakeNet phrase — you'd need a custom-trained model or use MultiNet.

**Option C — Train a custom WakeNet model** via Espressif's ESP-SR wake-word training service, then bundle it in the assets partition.

**Important:** The wake word is **not** a simple string the firmware recognizes — it's a **neural network model** (WakeNet/MultiNet) that must be trained on the phrase. You cannot just type "Hey Rosie" into a config and have it work; you need a model that recognizes that phrase. The `CONFIG_CUSTOM_WAKE_WORD` pinyin string only works with a **MultiNet** model that has been trained on those command words.

---

## 4. Communication Protocol

The device supports **two transports**, selected at runtime by the OTA config:

### 4.1 WebSocket (`main/protocols/websocket_protocol.cc`)

- **Control + audio both over one WebSocket.**
- Headers on connect: `Authorization` (Bearer token), `Protocol-Version`, `Device-Id` (MAC), `Client-Id` (UUID).
- **Hello handshake:** device sends `{"type":"hello","version":N,"features":{"mcp":true,...},"transport":"websocket","audio_params":{"format":"opus","sample_rate":16000,"channels":1,"frame_duration":60}}`. Server replies with its own `hello` (may include `session_id` and negotiated `audio_params`).
- **Binary frames** = Opus audio. **Text frames** = JSON control messages.
- Binary protocol versions: v1 (raw Opus), v2 (`BinaryProtocol2` with timestamp for server AEC), v3 (`BinaryProtocol3`).

### 4.2 MQTT + UDP (`main/protocols/mqtt_protocol.cc`)

- **MQTT** carries control/JSON messages; **UDP** carries real-time audio (encrypted with **AES-CTR**, key/nonce delivered in the MQTT hello response).
- Hello: `{"type":"hello","version":3,"transport":"udp","features":{"mcp":true,...},"audio_params":{...}}`. Server responds with UDP endpoint + AES key/nonce.
- Audio packets: 16-byte header (nonce + payload_len + timestamp + sequence) + AES-CTR-encrypted Opus payload.

### 4.3 JSON message types (both transports)

From `application.cc` `OnIncomingJson`:
- **`tts`** — `state: start|stop|sentence_start`, with `text` (and optional glyph data) for display.
- **`stt`** — user speech text for display.
- **`llm`** — `emotion` field → drives display expression.
- **`mcp`** — MCP JSON-RPC payload → `McpServer::ParseMessage()`.
- **`system`** — `command: reboot` (used after OTA).
- **`alert`** — status/message/emotion → on-screen alert + sound.
- **`custom`** — arbitrary custom payload (if `CONFIG_RECEIVE_CUSTOM_MESSAGE`).

Outgoing control: `SendWakeWordDetected`, `SendStartListening`, `SendStopListening`, `SendAbortSpeaking`, `SendMcpMessage`.

### 4.4 Server URL / OTA endpoint

- `CONFIG_OTA_URL` (default `https://api.tenclass.net/xiaozhi/ota/`) is the **version-check + config endpoint**. The device POSTs its identity and the server returns `{firmware:{version,url}, mqtt:{...}, websocket:{...}, activation:{...}}`.
- The `mqtt`/`websocket` sections in that response configure the actual chat server connection (stored in NVS via `Settings`).

**For Rosie:** To connect to OpenClaw instead of xiaozhi cloud, you either (a) run a self-hosted xiaozhi-compatible server and point `CONFIG_OTA_URL` at it, or (b) write a small server that implements the WebSocket hello + JSON + Opus protocol and serves the OTA config. The protocol is well-documented in `docs/websocket.md` and `docs/mqtt-udp.md`.

---

## 5. Audio Pipeline

### Capture → Encode → Send

1. **`AudioService`** (`main/audio/audio_service.cc`) owns the pipeline.
2. **Codec** (`AudioCodec`, e.g. `CoreS3AudioCodec`) captures 24 kHz PCM from the ES7210 mic via I2S.
3. **AFE engine** (`AfeAudioEngine`) processes the PCM: AEC (if enabled), VAD, and wake-word detection. Output is 16 kHz PCM frames.
4. **Opus encoding:** `esp_opus_enc_open()` encodes 16 kHz PCM into Opus frames (`OPUS_FRAME_DURATION_MS` = 60 ms default). The `OpusCodecTask` runs the encode/decode loop.
5. **Send:** encoded Opus frames are wrapped in `AudioStreamPacket` and sent via the protocol (`SendAudio`).

### Receive → Decode → Play

1. Incoming Opus frames → `PushPacketToDecodeQueue`.
2. `esp_opus_dec_open()` decodes to the codec's output sample rate (24 kHz).
3. PCM → codec → AW88298 amp → speaker.

### Key constants
- `OPUS_FRAME_DURATION_MS` = 60 ms (advertised in hello).
- Encoder sample rate = 16000 Hz; decoder = codec output rate (24000 Hz).
- `AUDIO_INPUT_REFERENCE` (CoreS3 = false) — whether the codec provides a reference signal for device-side AEC.

### Realtime / full-duplex
- `kListeningModeRealtime` requires AEC. The CoreS3 does **not** enable device-side AEC by default (`CONFIG_USE_DEVICE_AEC` is off for CoreS3 — it's only on for specific boards like ESP32-S3-BOX). Server-side AEC (`CONFIG_USE_SERVER_AEC`) is an option.

---

## 6. MCP Integration

### Client or server?

**The device is an MCP *server*.** The cloud backend is the MCP *client* that discovers and invokes device tools. This is the reverse of the typical "LLM is the MCP server" setup — here the LLM (on the cloud) uses MCP to control the ESP32.

### How it works (`main/mcp_server.cc` / `mcp_server.h`)

- `McpServer` is a **singleton** (`McpServer::GetInstance()`).
- MCP messages are wrapped in the transport's JSON: `{"type":"mcp","payload":{JSON-RPC 2.0}}`.
- Methods handled: `initialize`, `tools/list`, `tools/call` (JSON-RPC 2.0).
- Tools are registered with `AddTool()` (visible to AI) or `AddUserOnlyTool()` (hidden, only with `withUserTools=true` — for privileged/user-initiated actions).

### Tools exposed (`AddCommonTools` + `AddUserOnlyTools`)

**Common (AI-callable):**
- `self.get_device_status` — real-time device state (volume, screen, battery, network).
- `self.audio_speaker.set_volume` — set speaker volume (0–100).
- `self.screen.set_brightness` — set backlight (0–100).
- `self.screen.set_theme` — light/dark theme (LVGL only).
- `self.camera.take_photo` — capture + explain a photo (if camera present).

**User-only (privileged):**
- `self.get_system_info`
- `self.reboot`
- `self.upgrade_firmware` — OTA from a URL.
- `self.screen.get_info`, `self.screen.snapshot`, `self.screen.preview_image`
- `self.assets.set_download_url`

**Custom tools:** The comment in `AddCommonTools` says *"Custom tools must be added in the board's `InitializeTools` function."* Boards can register their own tools (e.g. the ESP-Hi robot dog adds `self.dog.forward`). **This is the primary extension point for Rosie-specific device control** (servos, Stack-chan head/eye movement, etc.).

### MCP flow
1. Device connects, advertises `"mcp": true` in hello `features`.
2. Backend sends `initialize` → device replies with protocol version + `serverInfo` (name = `BOARD_NAME`, version = firmware version).
3. Backend sends `tools/list` → device returns tool schemas.
4. Backend sends `tools/call` → device executes and returns result.

---

## 7. LLM / STT / TTS

### Where does inference happen?

**All on the cloud server.** The ESP32 does **no** LLM, STT, or TTS inference. It only:
- Captures audio → Opus → sends to server.
- Receives Opus TTS audio → decodes → plays.
- Receives STT text and LLM emotion → displays.
- Exposes MCP tools for the server to call.

The device's `hello` advertises `"format":"opus"` and the server negotiates sample rate/frame duration. The server runs the ASR → LLM → TTS chain and streams results back.

### System prompt / personality

**There is no system prompt on the device.** The system prompt, LLM model (Qwen/DeepSeek), voice, and personality are all configured **on the server** (xiaozhi.me console, or your self-hosted server's config). The device is agnostic to which LLM is used.

**For Rosie:** The personality is defined entirely server-side. To make Rosie, you configure the server's system prompt (e.g. "You are Rosie, a friendly robot assistant...") and voice. The device just renders whatever the server sends.

### What the device CAN override
- **Display emotion** — the server sends `{"type":"llm","emotion":"happy"}` and the device maps it to an emoji/expression. You can add custom emotions on-device.
- **Wake word** — on-device (see §3).
- **MCP tools** — on-device (see §6).
- **Custom messages** — `CONFIG_RECEIVE_CUSTOM_MESSAGE` lets the server push arbitrary JSON to the device for display.

---

## 8. Display

### Two display styles

1. **LVGL style** (`main/display/lvgl_display/` + `lcd_display.cc`) — used by the CoreS3 (`SpiLcdDisplay`). Full LVGL UI: status bar (network/battery/clock), chat message area, and an **emoji expression** area.
2. **Emote style** (`main/display/emote_display.cc`, `CONFIG_USE_EMOTE_MESSAGE_STYLE`) — used by ESP32-S3-BOX boards. Uses the `esp_emote_expression` component for animated faces. **Not used by CoreS3.**

### How facial expressions work (CoreS3 / LVGL)

`LcdDisplay::SetEmotion(const char* emotion)`:
1. Looks up the emotion name in the theme's **emoji collection** (`EmojiCollection::GetEmojiImage(emotion)`).
2. If found → displays the emoji image (static or **GIF animation** via `LvglGif`).
3. If not found → falls back to a Unicode emoji from `noto_emoji` or `material_symbols` fonts.

Emotion names are strings like `"neutral"`, `"happy"`, `"sleepy"`, `"warning"`, etc. The server sends these via the `llm` message. The emoji assets (images/GIFs) come from the **assets partition** (see §Assets below).

### Customizing Stack-chan's facial expressions

- **Add custom emoji/GIFs** to the assets partition (via `xiaozhi-assets-generator` or by building a custom assets.bin). Each emotion name maps to an image/GIF.
- **Add new emotion names** by adding entries to the emoji collection and having the server send them.
- **The `EmoteDisplay` path** (animated face) is the richer option but requires the emote message style + `esp_emote_expression` component, which the CoreS3 board doesn't currently use. You could port it, but the LVGL emoji/GIF path is simpler and already works on CoreS3.

### Assets system (`main/assets.cc` / `assets.h`)

- Assets (fonts, emoji, wake-word models, language strings) live in a **dedicated SPIFFS partition** (`assets`, 8 MB in the 16 MB partition table).
- `Assets::Download()` fetches an assets bundle from a URL; `Assets::Apply()` mounts it.
- `LoadSrmodelsFromIndex()` loads ESP-SR models (wake word) from the assets `index.json`.
- `CONFIG_OTA_URL` / `CONFIG_CUSTOM_ASSETS_FILE` control where assets come from.

---

## 9. OTA Updates

### How it works (`main/ota.cc`)

1. **Version check:** On boot, `Ota::CheckVersion()` POSTs device identity (MAC, UUID, current version, serial number) to `CONFIG_OTA_URL` (`GetCheckVersionUrl()`).
2. **Response** contains:
   - `firmware: {version, url}` — new firmware if available.
   - `mqtt: {...}` / `websocket: {...}` — chat server connection config (stored in NVS).
   - `activation: {message, code, challenge, timeout_ms}` — device activation flow.
3. **Upgrade:** `Ota::Upgrade(url, callback)` downloads the firmware binary and writes it to the OTA partition (`ota_1`), then reboots. Uses dual-OTA partitions (`ota_0`/`ota_1` in `partitions/v2/16m.csv`).
4. **Rollback:** `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` + `MarkCurrentVersionValid()` — if the new firmware fails to boot, it rolls back.

### Partition table (`partitions/v2/16m.csv`)
```
nvs,      data, nvs,     0x9000,  0x4000
otadata,  data, ota,     0xd000,  0x2000
phy_init, data, phy,     0xf000,  0x1000
ota_0,    app,  ota_0,   0x20000, 0x3f0000
ota_1,    app,  ota_1,   ,        0x3f0000
assets,   data, spiffs,  0x800000, 8M
```

**For Rosie:** You can host your own OTA server that serves firmware + the chat-server config. The `self.upgrade_firmware` MCP tool also allows remote OTA from an arbitrary URL.

---

## 10. Build System

### ESP-IDF version
- **Preferred: ESP-IDF v6.0.2** (stable v6.0+). `idf_component.yml` requires `idf: version: '>=5.5.2'`. ESP-IDF v5.5.2 retained only for legacy boards.
- ESP-SR component: `espressif/esp-sr: ~2.4.7`.
- LVGL: `lvgl/lvgl: ~9.5.0`.

### Build steps

**Recommended (via build script):**
```bash
# From the firmware root
python ./scripts/build.py m5stack-core-s3
# With custom wake word:
python ./scripts/build.py m5stack-core-s3 --wake-word wn9_jarvis_tts
# List available wake words:
python ./scripts/build.py --list-wake-words
# List boards:
python ./scripts/build.py --list-boards
```

`build.py`:
1. Reads `main/boards/m5stack/core-s3/config.json`.
2. Resolves the canonical `CONFIG_BOARD_TYPE_M5STACK_CORE_S3` symbol.
3. Merges `sdkconfig.defaults` + `sdkconfig.defaults.esp32s3` + board `sdkconfig_append` + CLI options into a generated sdkconfig fragment.
4. Runs `idf.py -DIDF_TARGET=esp32s3 -DSDKCONFIG_DEFAULTS=... -DBOARD_NAME=m5stack-core-s3 reconfigure`.
5. Runs `idf.py build`, then `idf.py merge-bin` (and optionally zips to `releases/`).

**Manual (idf.py):**
```bash
idf.py set-target esp32s3
idf.py menuconfig   # select board, wake word, etc.
idf.py build
idf.py -p /dev/tty.usbmodem* flash
```

### Flash
- `idf.py flash` (or `idf.py -p PORT flash`).
- CoreS3 download mode: **long-press the reset button (~3 s) until the internal LED turns green, then release.**
- The CoreS3 uses a USB-to-UART bridge; the port is typically `/dev/tty.usbmodem*` on macOS.

---

## 11. Customization Points for a "Rosie" Node

Here's exactly where to inject Rosie-specific behavior. **The cleanest architecture: keep the firmware mostly stock, replace the cloud backend, and customize the on-device wake word + display + MCP tools.**

### A. Personality / LLM (server-side — primary)
- **Do NOT modify firmware for personality.** Run a self-hosted xiaozhi-compatible server (e.g. `xinnan-tech/xiaozhi-esp32-server`) and set the system prompt to define Rosie's personality, voice, and behavior.
- Point the device at your server by setting `CONFIG_OTA_URL` to your server's OTA endpoint (which returns the `websocket`/`mqtt` config pointing at your chat server).

### B. Wake word → "Hey Rosie"
- **MultiNet custom wake word** (recommended): set `CONFIG_USE_CUSTOM_WAKE_WORD=y`, `CONFIG_CUSTOM_WAKE_WORD="hey luo xi"`, `CONFIG_CUSTOM_WAKE_WORD_DISPLAY="Hey Rosie"`. Requires a MultiNet model in assets.
- **Pre-trained WakeNet:** `--wake-word wn9_jarvis_tts` etc. (no "Hey Rosie" stock model).
- **Custom-trained model:** train via ESP-SR service, bundle in assets.
- Files: `main/audio/engines/afe_audio_engine.cc`, `main/audio/wake_words/custom_wake_word.cc`, `sdkconfig.defaults.esp32s3`, `main/Kconfig.projbuild`.

### C. Display expressions (on-device)
- Add custom emoji/GIFs to the assets partition for Rosie's face.
- Map emotion names (sent by server) to Rosie expressions in `LcdDisplay::SetEmotion` / the emoji collection.
- Optionally port the `EmoteDisplay` animated-face style for richer expressions.

### D. MCP tools (on-device — Rosie device control)
- **Add Rosie-specific tools** in the board's `InitializeTools()` (e.g. `self.rosie.move_head`, `self.rosie.set_eye`, `self.rosie.servo`). This is the documented extension point for device control.
- The cloud LLM can then control Stack-chan's servos/eyes via MCP.

### E. OpenClaw connection (instead of xiaozhi cloud)
Two approaches:
1. **Bridge server:** Run a small server that implements the xiaozhi WebSocket protocol (hello + JSON + Opus) and forwards to OpenClaw. The device connects to it unchanged. This is the least invasive.
2. **Firmware protocol swap:** Replace `WebsocketProtocol`/`MqttProtocol` with a custom protocol that talks directly to OpenClaw. More work, but removes the xiaozhi protocol dependency. The `Protocol` interface (`main/protocols/protocol.h`) is cleanly abstracted — you can add a new `Protocol` subclass.

### F. Custom messages
- Enable `CONFIG_RECEIVE_CUSTOM_MESSAGE` to let the server push arbitrary JSON to the device (e.g. Rosie status updates, custom display content).

### G. Board identity
- If you ship a distinct "Rosie" firmware, **create a new board variant** (per `docs/custom-board.md`) rather than overwriting `m5stack-core-s3`, so OTA updates don't clobber your custom firmware with stock.

---

## Key Files Reference

| Area | Files |
|------|-------|
| Board (CoreS3) | `main/boards/m5stack/core-s3/{config.h, config.json, m5stack_core_s3.cc, cores3_audio_codec.cc}` |
| Board base | `main/boards/common/{board.h, board.cc, wifi_board.h}` |
| Application | `main/application.cc`, `main/application.h` |
| Audio | `main/audio/{audio_service.cc, audio_engine.h, wake_word.h}` |
| AFE/wake word | `main/audio/engines/afe_audio_engine.cc`, `main/audio/wake_words/custom_wake_word.cc` |
| Protocols | `main/protocols/{protocol.h, websocket_protocol.cc, mqtt_protocol.cc}` |
| MCP | `main/mcp_server.cc`, `main/mcp_server.h` |
| Display | `main/display/{display.h, lcd_display.cc, lvgl_display/, emote_display.cc}` |
| OTA | `main/ota.cc`, `main/ota.h` |
| Assets | `main/assets.cc`, `main/assets.h` |
| Config | `main/Kconfig.projbuild`, `sdkconfig.defaults`, `sdkconfig.defaults.esp32s3` |
| Build | `scripts/build.py`, `CMakeLists.txt`, `main/idf_component.yml` |
| Partitions | `partitions/v2/16m.csv` |
| Docs | `docs/websocket.md`, `docs/mqtt-udp.md`, `docs/mcp-protocol.md`, `docs/mcp-usage.md`, `docs/custom-board.md` |

---

## Summary

The xiaozhi-esp32 firmware is a **thin, well-abstracted voice-client** for ESP32 boards. The CoreS3 (Stack-chan) board is fully supported. To build a custom "Rosie" node:

1. **Personality lives on the server** — run a self-hosted xiaozhi-compatible server (or a custom OpenClaw bridge) and define Rosie there. No firmware change needed for the LLM/system prompt.
2. **Wake word** — switch to a custom MultiNet model or a pre-trained WakeNet model via `--wake-word` / Kconfig.
3. **Display** — customize emoji/GIF expressions in the assets partition.
4. **Device control** — add Rosie MCP tools in the board's `InitializeTools()`.
5. **Connectivity** — point `CONFIG_OTA_URL` at your server, or add a custom `Protocol` subclass to talk to OpenClaw directly.

The firmware's clean `Protocol` interface, `McpServer` tool registry, and board abstraction make it highly customizable without deep surgery.
