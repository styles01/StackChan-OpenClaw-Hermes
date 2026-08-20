# Hermes-StackChan Deep Analysis

**Primary reference for porting OpenClaw into Hermes-StackChan as a second backend.**

- Repo: `<repo-root>/stackchan-node/repos/working-repos/Hermes-StackChan/`
- Upstream: `https://github.com/circlemouth/Hermes-StackChan.git` (fork of M5Stack's StackChan + xiaozhi-esp32)
- Official StackChan reference: `<repo-root>/stackchan-node/repos/StackChan/`
- Date: 2026-08-18

---

## 0. Executive Summary / Architecture at a Glance

**Hermes-StackChan is a three-layer system:**

```
┌─────────────────────────────────────────────────────────────────────┐
│ M5Stack StackChan (ESP32-S3) — FIRMWARE                            │
│ • Mooncake app framework (Launcher, Hermes/AI-Agent, Avatar, etc.) │
│ • HAL bridge (hal_bridge) that hands off to Xiaozhi-esp32 runtime  │
│ • Robot MCP tools (self.robot.*, self.camera.*, self.screen.*)    │
└─────────────────────────────────────────────────────────────────────┘
                    │  WebSocket / Opus audio  (ws://<host>:8765/ws)
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ ai-server (TypeScript bridge)                                      │
│ • WebSocket server (port 8765) ↔ device                            │
│ • Device control HTTP server (port 8766) for MCP tools             │
│ • HermesClient: connects to Hermes Dashboard/TUI /api/ws (9119)     │
│   OR spawns HermesAgent stdio gateway                              │
│ • STT/TTS helpers (Hermes Python tools, or local HTTP endpoints)   │
└─────────────────────────────────────────────────────────────────────┘
                    │  JSON-RPC over WebSocket (dashboard_ws) OR stdio
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ HermesAgent (Hermes Dashboard/TUI, /api/ws on 9119)                │
│ • Owns STT, LLM, TTS, memory, skills, provider config              │
│ • MCP client that calls stackchan_* tools                          │
└─────────────────────────────────────────────────────────────────────┘
```

**Key architectural insight for the OpenClaw port:** The firmware only talks to **one** WebSocket endpoint (`websocket_url` → `ai-server`). `ai-server` is the *only* place that talks to the backend (HermesAgent). To add **OpenClaw as a second backend**, the cleanest integration point is **inside ai-server** — replace/augment `HermesClient` with an `OpenClawClient` implementing the same interface (`submitPrompt`, `streamPrompt`, `interrupt`, `dispose`), driven by a config env var like `OPENCLAW_CONNECT_MODE`. The firmware itself needs **no changes** for a backend swap.

---

## 1. Firmware Changes vs Official m5stack/StackChan

### 1.1 Critical Correction: The firmware is NOT a fork of m5stack/StackChan directly

It is a fork of **StackChan (M5Stack's Mooncake-based firmware)** that **vendors the xiaozhi-esp32 runtime as a submodule** and runs it as the "Hermes bridge" audio/chat runtime. The build pulls in:

- `xiaozhi-esp32` v2.2.4 (submodule, patched via `firmware/patches/xiaozhi-esp32.patch`)
- `mooncake` v2.3.3, `mooncake_log`, `smooth_ui_toolkit` (StackChan's UI framework)
- `hermes-agent` (submodule, currently empty/not checked out in this working copy)
- ArduinoJson, esp-now

`firmware/repos.json` defines these dependencies and the patch to apply.

### 1.2 Directory diff: Hermes firmware vs official StackChan

```
FIRMWARE/MAIN/HAL — Hermes-only files:
  + hal_sdcard.cpp            (new — SD config autoload + parse)
  + hal/board/hal_bridge.cc   (new — the core Hermes↔Xiaozhi bridge)
  + hal/board/hal_bridge.h    (new — bridge declarations + config structs)
  + hal/board/config.h        (new — M5Stack StackChan board pin config)
  + hal/board/stackchan.cc    (heavily modified — Hermes board adapter)
  + hal/board/stackchan_camera.* (new — camera adapter)
  + hal/board/stackchan_display.* (new — display adapter with is_hermes_ready/idle)
  + hal/board/cores3_audio_codec.* (new — audio codec adapter)

FIRMWARE/MAIN/HAL — Removed (present in official, absent in Hermes):
  - hal_account.cpp, hal_app_center.cpp, hal_ezdata.cpp, hal_ota.cpp,
    hal_ws_avatar.cpp

FIRMWARE/MAIN/APPS — Removed:
  - app_app_center, app_ezdata
  (Hermes apps: app_ai_agent, app_avatar, app_dance, app_espnow_ctrl,
   app_launcher, app_setup, app_template)

OTHER:
  firmware/main/main.cpp   — completely rewritten for Hermes handoff
  firmware/main/CMakeLists.txt — pulls in xiaozhi-esp32 sources
  firmware/main/Kconfig.projbuild — adds Hermes Runtime menu + HERMES_AUTOSTART
  firmware/sdkconfig.defaults — targets esp32s3, BOARD_TYPE_M5STACK_STACK_CHAN
  firmware/sdcard/config.sample.json — SD config schema
  firmware/patches/xiaozhi-esp32.patch — Hermes changes to xiaozhi runtime
```

### 1.3 Key config: `firmware/sdkconfig.defaults`

The important lines:

```ini
CONFIG_IDF_TARGET="esp32s3"
CONFIG_BOARD_TYPE_M5STACK_STACK_CHAN=y
CONFIG_HERMES_AUTOSTART=n          # Launcher auto-opens Hermes app
CONFIG_USE_SERVER_AEC=y            # server-side AEC
CONFIG_USE_AFE_WAKE_WORD=y
CONFIG_USE_AUDIO_PROCESSOR=y
CONFIG_SEND_WAKE_WORD_DATA=n
CONFIG_SR_WN_WN9_HISTACKCHAN_TTS3=y  # wake word model
CONFIG_BT_ENABLED=y                 # BLE provisioning
CONFIG_BT_NIMBLE_ENABLED=y
CONFIG_SPIRAM=y
```

### 1.4 Hermes build options in `Kconfig.projbuild`

Three Hermes-specific options:

```c
config STACKCHAN_SERVER_URL
    string "StackChan server base URL"
    default "http://localhost:3000"
    help Base URL (scheme + host + port) of the StackChan backend.

config OTA_URL
    string "Default OTA URL"
    default ""          # Hermes leaves empty to avoid cloud OTA

config HERMES_AUTOSTART
    bool "Automatically open HERMES app from Launcher"
    default n
```

(`STACKCHAN_SERVER_URL` is largely vestigial for the current local setup; the real endpoint comes from the SD card / NVS `websocket` settings.)

---

## 2. Firmware HAL Code (Hermes-Specific)

### 2.1 `hal.cpp` — the Hermes bridge entry points

`Hal::init()` (boot-time) now calls these in order:

```cpp
void Hal::init() {
    prepareSharedSpiPinsBeforeBoardInit();  // CoreS3/StackChan: LCD+SD share SPI/GPIO35
    nvs_flash_init();
    consumeLauncherReturnRebootMarker();
    handleBootSdConfigAutoload();   // loads SD /config.json into NVS
    hermes_board_init();            // <-- HERMES: initializes Xiaozhi Board singleton
    robot_mcp_init();               // <-- HERMES: registers self.robot.* MCP tools
    head_touch_init();
    io_expander_init();
    rtc_init();
    imu_init();
    servo_init();
    lvgl_init();
}
```

**`hermes_board_init()`** just instantiates the Xiaozhi board singleton:

```cpp
void Hal::hermes_board_init() {
    mclog::tagInfo(_tag, "hermes bridge board init");
    hal_bridge::hermes_board_init();   // calls (void)Board::GetInstance();
}
```

**`Hal::startHermes()`** — called from `main.cpp` after Mooncake teardown. **Never returns**:

```cpp
void Hal::startHermes() {
    // PERFORMANCE power save, restore backlight
    board.SetPowerSaveLevel(PowerSaveLevel::PERFORMANCE);
    backlight->RestoreBrightness();
    // enable auto head-angle sync + torque release
    motion.setAutoAngleSyncEnabled(true);
    motion.setAutoTorqueReleaseEnabled(true);
    // reminder handler (local reminders)
    tools::on_reminder_triggered().connect(...);  // shows ReminderView + sound
    // spawn StackChan update task (20ms loop, LVGL avatar updates)
    xTaskCreatePinnedToCore(_stackchan_update_task, "stackchan", 4096, NULL, 3, NULL, 1);
    // <-- hands off to Xiaozhi runtime
    hal_bridge::start_hermes_app();   // app.Initialize(); app.Run(); (never returns)
}
```

`_stackchan_update_task` drives the LVGL avatar, home indicator, and status bar. It checks `hal_bridge::is_hermes_idle()` and `hal_bridge::is_hermes_ready()` before drawing — this ties the avatar to the Xiaozhi audio state.

**Launcher return / warm reboot markers** (NVS):
- `consumeLauncherReturnRebootMarker()` / `requestLauncherReturnReboot()` — used by the Hermes home-indicator "return to launcher" flow.
- `requestWarmReboot(int appIndex)` — reboots into a specific Mooncake app via NVS `warm_boot/app_index`.

### 2.2 `hal_ble.cpp` — BLE provisioning flow

`Hal::ble_init(bool useAltUuid)` registers StackChan BLE callbacks and starts the NimBLE peripheral:

```cpp
static stackchan_ble_callbacks_t ble_callbacks = {
    .motion_cb       = _handle_ble_motion_write,
    .avatar_cb       = _handle_ble_avatar_write,
    .config_cb       = _handle_ble_config_write,
    .rgb_cb          = _handle_ble_rgb_write,
    .battery_read_cb = _handle_ble_battery_read,
};
stackchan_ble_register_callbacks(&ble_callbacks);
ble_prph_init(useAltUuid);
```

**`startAppConfigServer()`** enables the BLE **Wi-Fi provisioning** channel. It runs a `WifiConfigServer` that handles JSON commands over BLE:

```
cmd = "setWifi"          { data: { ssid, password } }  → AddAuth + connect
cmd = "getWifiStatus"    → notifyState(0/1/2/3, ...)
cmd = "handshake"        { data } → secret_logic::generate_handshake_token()
```

Responses go back over BLE as `notifyState` JSON (`cmd:"notifyState", data:{type, state}`). On successful Wi-Fi connect it sets NVS `app_config/is_configed=true`.

**Important — `websocket_url` is NOT set over BLE.** BLE only provisions Wi-Fi credentials. The `websocket_url` comes exclusively from **SD card config** (see §5).

### 2.3 `hal_mcp.cpp` — firmware-side robot MCP tools (13 tools)

These are the firmware-side implementations exposed to `ai-server` via the WebSocket `mcp` message. Names are `self.<domain>.<name>`:

| Tool | Signature (properties) | Purpose |
|------|------------------------|---------|
| `self.robot.get_status` | `()` | Safe device status (device_id, firmware, battery, charging, wifi_status, wifi_configured, sd_config_error, speaker_volume, backlight_brightness, hermes_autostart, websocket_configured/scheme/host) |
| `self.robot.set_speaker_volume` | `volume:int(0-100)=40, permanent:bool=false` | Set M5 speaker volume |
| `self.audio.play_test_tone` | `frequency_hz:int(100-2000)=440, duration_ms:int(100-3000)=800, amplitude:int(500-16000)=6000` | Diagnostic sine tone, bypasses Hermes/TTS/Opus |
| `self.robot.get_head_angles` | `()` | Returns `{yaw, pitch}` in degrees |
| `self.robot.set_head_angles` | `yaw:int(-9999..128), pitch:int(-9999..90), speed:int(100-1000)=150` | Move head (yaw/pitch * 10 to servo units), locks motion for 1s |
| `self.robot.set_led_color` | `red:int(0-168), green:int(0-168), blue:int(0-168)` | Set onboard RGB LEDs |
| `self.robot.power_off` | `()` | Power off device (explicit request only) |
| `self.camera.capture_photo` | `quality:int(1-100)=80` | Capture camera still → returns image/jpeg MCP block (not on ESP32) |
| `self.screen.preview_image_url` | `url:string, duration_seconds:int(1-30)=6` | Download + show image full-screen preview |
| `self.screen.capture_screenshot` | `quality:int(1-100)=80` | Snapshot display → image/jpeg MCP block |
| `self.robot.create_reminder` | `duration_seconds:int(1-86400)=60, message:string, repeat:bool=false` | Create local reminder → returns id |
| `self.robot.get_reminders` | `()` | List active reminders (JSON array) |
| `self.robot.stop_reminder` | `id:int` | Stop a reminder by id |

These are registered in `Hal::robot_mcp_init()` via `McpServer::GetInstance().AddTool(...)`. The `McpServer` class comes from the vendored xiaozhi-esp32 (`mcp_server.cc`, not present in this working copy since submodules aren't checked out).

### 2.4 `hal_bridge.cc` / `hal_bridge.h` — the core bridge

**This is the single most important file for understanding the handoff.** It defines:

```cpp
struct TouchPoint_t { int num=0; int x=-1; int y=-1; };
struct Data_t {
    TouchPoint_t touchPoint;
    bool isHermesMode = false;
    bool isHermesModeToggleEnabled = false;
};
struct HermesRuntimeConfig_t {
    uint32_t idleShutdownTimeSeconds = 600;
    bool allowShutdownWhenCharging   = false;
    uint8_t idleRandomMovementLevel  = 2;
};

void hermes_board_init();      // init Xiaozhi Board
void start_hermes_app();       // app.Initialize(); app.Run() — never returns
bool is_hermes_ready();        // Xiaozhi SetStatus(STANDBY) seen
bool is_hermes_idle();         // Xiaozhi in idle state
HermesRuntimeConfig_t get_hermes_config();
void set_hermes_config(...);
// display / LVGL helpers, I2C, camera, battery, backlight, volume, power_off
```

`start_hermes_app()`:

```cpp
void start_hermes_app() {
    set_hermes_mode(true);
    auto& app = Application::GetInstance();
    app.Initialize();
    app.Run();  // main event loop — never returns
}
```

`is_hermes_ready` / `is_hermes_idle` are defined in `stackchan_display.cc`:

```cpp
static bool _is_hermes_ready = false;
static bool _is_hermes_idle  = false;
bool hal_bridge::is_hermes_ready() { return _is_hermes_ready; }
bool hal_bridge::is_hermes_idle()  { return _is_hermes_idle; }
// In StackChanAvatarDisplay::SetStatus():
//   status == LISTENING → _is_hermes_idle = false, pose=Listening
//   status == STANDBY   → _is_hermes_ready = true, _is_hermes_idle = true
//   status == SPEAKING  → _is_hermes_idle = false
```

### 2.5 Boot sequence (power-on → Hermes app)

```
1. app_main()
2. GetHAL().init()
     → prepareSharedSpiPinsBeforeBoardInit()
     → nvs_flash_init()
     → consumeLauncherReturnRebootMarker()
     → handleBootSdConfigAutoload()      // SD /config.json → NVS (websocket/wifi)
     → hermes_board_init()               // Xiaozhi Board singleton
     → robot_mcp_init()                  // self.robot.* MCP tools
     → head_touch / io_expander / rtc / imu / servo / lvgl init
3. Install Mooncake apps: Launcher, AiAgent(HERMES), Avatar,
   EspnowControl, Dance, Setup
4. Mooncake main loop:
     GetMooncake().update();
     if (GetHAL().isHermesStartRequested()) break;
5. Hermes start requested (explicit app open OR CONFIG_HERMES_AUTOSTART):
     → teardown Mooncake under LVGL lock
     → clean_lvgl_for_hermes_handoff_locked()
     → GetHAL().prepareHermesDisplay()   // SetupUI on the Xiaozhi display
     → GetHAL().startHermes()            // → hal_bridge::start_hermes_app() → app.Run()
```

**How Hermes start is triggered:**
- `AppAiAgent::onOpen()` (the "HERMES" app) checks: no SD config error AND valid `ws://`/`wss://` URL AND (Wi-Fi connected OR saved credentials). If ready → `GetHAL().requestHermesStart()`. If not ready → shows a connectivity error bubble on the avatar.
- `AppLauncher::try_auto_open_hermes()` (only if `CONFIG_HERMES_AUTOSTART=y`): auto-opens the HERMES app if `isAppConfiged()`, no SD error, and `hasHermesBridgeUrl()`.

---

## 3. The xiaozhi-esp32 Patch (Hermes changes to the runtime)

`firmware/patches/xiaozhi-esp32.patch` (44KB) is the Hermes-specific layer on top of xiaozhi v2.2.4. Files touched:

- **`application.cc` / `application.h`** — THE core changes:
  - **Local websocket protocol selection**: `InitializeProtocol()` reads NVS `websocket/url` (fallback `url_override`) and if present uses `WebsocketProtocol` + sets `startup_connection_probe_pending_ = true`. Otherwise falls back to MQTT/OTA config.
  - **`ProbeStartupConnection()`**: opens a *persistent* local websocket session on startup (auto-listens) instead of requiring a wake word/button.
  - **Auto-reconnect**: `ScheduleAudioChannelReconnect()` / `CancelAudioChannelReconnect()` with exponential backoff (1s → 30s cap). Triggered on network disconnect, protocol disconnect, or connect failure. A dedicated `esp_timer` (`hermes_reconnect`).
  - **Cloud OTA skip**: `CheckNewVersion()` returns early if a local websocket URL is configured (skips cloud version check).
  - **Error bubbles**: `HandleNetworkDisconnectedEvent` sets "HERMES Wi-Fi error..." message; `HandleStateChangedEvent` keeps protocol error bubbles visible for one idle transition.
  - **`ShowActivationCode`** disabled (binding code flow removed for local mode).
- **`websocket_protocol.cc` / `.h`** — `OpenAudioChannel()` now:
  - Reads `url` then falls back to `url_override`.
  - `suppress_next_disconnect_notification_` flag so intentional closes don't trigger reconnect.
  - On connect failure: `SetError("HERMES endpoint error: cannot connect to <host>. Start ai-server and check Wi-Fi.")`.
  - `DescribeWebsocketEndpoint()` strips credentials from logged URL (no secret leak).
- **`wifi_board.cc`** — `StartWifiConfigMode()` shows "HERMES Wi-Fi error..." bubble with AP ssid/url when startup Wi-Fi fails.
- **`ota.cc`** — reads `current_version_` from app descriptor.
- **`backlight.cc`** — `RestoreBrightness()` avoids redundant PWM writes.
- **`i2c_device.cc/.h`** — adds `TryReadRegs()` non-asserting read.
- **`assets.cc/.h`** — `EmoteStrategy` commented out (emote display not used by Hermes StackChan).

---

## 4. ai-server Bridge (TypeScript)

### 4.1 Architecture / file map

| File | Role |
|------|------|
| `index.ts` | Entry point: starts device-control server (8766), optional Hermes warmup, starts WS server (8765) |
| `server.ts` | HTTP + WebSocket server on port 8765, path `/ws`, also serves `/media/*` |
| `session.ts` | **The heart.** One `Session` per connected device: handles Opus audio, VAD, STT→LLM→TTS→Opus loop, MCP tool forwarding, barge-in, reminders |
| `hermes.ts` | `HermesClient` — transport abstraction to HermesAgent (dashboard_ws OR stdio) over JSON-RPC |
| `hermes_audio.ts` | STT + TTS helpers (Hermes Python tools or local OpenAI-compatible HTTP endpoints) |
| `audio.ts` | Opus decode/encode, WAV/PCM conversion, Xiaozhi binary protocol (v1/v2/v3) framing |
| `device_control.ts` | HTTP control server (8766): `/tools/call`, `/internal/followup`, `/internal/status` |
| `stackchan_mcp_server.ts` | MCP stdio server exposing the 14 `stackchan_*` tools to Hermes |
| `local_vad.ts` | Local RMS VAD for low-latency voice activity detection |
| `local_audio_output.ts` | Optional host-side (PipeWire) speaker output |
| `media.ts` | Media file registration + HTTP serving for image preview (MEDIA:/markdown) |
| `timing.ts` | Timing/elapsed helpers |

### 4.2 The WebSocket/Opus ↔ HermesAgent translation loop

**Inbound (device → ai-server):**
1. Device connects to `ws://<host>:8765/ws`.
2. Device sends `hello` JSON (`{type:'hello', version:3}`) → ai-server replies `hello` with `audio_params` (`sample_rate:24000, frame_duration:60`).
3. Device sends `listen` `{state:'start'|'detect'|'stop'}` messages and binary Opus frames.
4. `Session.handleBinary()` extracts Opus payload (per protocol version), decodes to 16kHz PCM, runs through `LocalRmsVad`.
5. On speech end → `triggerProcess()` → concatenate PCM → WAV → **STT** (`transcribeWithHermes`).
6. Text → **LLM** (`hermes.submitPrompt` / `streamPrompt`).
7. LLM reply → split into sentence segments → **TTS** (`synthesizeWithHermes`) → Opus frames (24kHz) → stream back to device.

**Outbound (ai-server → device):**
- `sendJson({type:'llm', emotion})` while thinking.
- `sendJson({type:'tts', state:'start'|'sentence_start'|'sentence_end'|'stop'})`.
- `sendBinary(wrapOpusPayload(frame, version))` — timed Opus frames for lip-sync.
- `sendJson({type:'alert', status, message, emotion})` for errors.
- `sendJson({type:'mcp', session_id, payload})` for MCP tool calls to the device.

### 4.3 Xiaozhi binary protocol (audio.ts)

```
BinaryProtocol3: [type:1][reserved:1][payload_size:2 BE][payload...]  // type 0=Opus
BinaryProtocol2: [version:2][type:2][reserved:4][timestamp:4][payload_size:4 BE][payload...]
version 1: raw Opus bytes
```
- Input: 16kHz mono, 60ms frames (960 samples/frame).
- Output: 24kHz mono, 60ms frames (1440 samples/frame).
- `extractOpusPayload(data, version)` parses inbound; `wrapOpusPayload(opus, version)` frames outbound.

### 4.4 Endpoints exposed by ai-server

| Endpoint | Port | Method | Purpose |
|----------|------|--------|---------|
| `ws://<host>:8765/ws` | 8765 | WebSocket | Device voice/control channel |
| `http://<host>:8765/media/<id>` | 8765 | GET | Serve registered media files (image preview) |
| `http://127.0.0.1:8766/tools/call` | 8766 | POST | MCP robot tool → device (JSON `{name, args}`) |
| `http://127.0.0.1:8766/internal/followup` | 8766 | POST | Queue a follow-up prompt to the device session |
| `http://127.0.0.1:8766/internal/status` | 8766 | GET | Bridge status (connected, readyForPrompt, reason) |

### 4.5 How the Hermes backend is selected (`hermes.ts`)

```ts
export class HermesClient {
    constructor() {
        this.client = process.env.HERMES_CONNECT_MODE === 'dashboard_ws'
            ? new DashboardWsHermesClient()      // connect to Hermes Dashboard /api/ws
            : new StdioHermesClient()             // spawn `python -m tui_gateway.entry`
    }
    submitPrompt(prompt)   // JSON-RPC 'prompt.submit'
    *streamPrompt(prompt)  // streaming 'prompt.submit' with message.delta / message.complete
    interrupt()            // JSON-RPC 'session.interrupt'
    dispose()
}
```

Two transports:
- **`DashboardWsTransport`**: connects to `HERMES_DASHBOARD_URL` (default `http://127.0.0.1:9119`), fetches `window.__HERMES_SESSION_TOKEN__` from the HTML (or uses `HERMES_DASHBOARD_TOKEN`), then opens `ws://.../api/ws?token=...`. Creates its **own** StackChan session (doesn't reuse the dashboard chat).
- **`StdioHermesTransport`**: spawns `python3 -m tui_gateway.entry` with `PYTHONPATH=hermes-agent`.

JSON-RPC methods: `session.create`, `prompt.submit`, `session.interrupt`.

### 4.6 How to add OpenClaw as a second backend

The cleanest approach — **zero firmware changes required**:

**Option A (recommended): Add `OpenClawClient` to `ai-server`.**

1. Create `ai-server/src/openclaw.ts` implementing the same interface as `HermesClient`:
   ```ts
   export type OpenClawSessionClient = {
       submitPrompt(prompt: string): Promise<string>
       streamPrompt?(prompt: string): AsyncIterable<{type:'delta';text:string}|{type:'complete';text?:string}>
       interrupt(): Promise<void>
       dispose(): Promise<void>
   }
   ```
2. In `session.ts`, the `HermesSessionClient` type already abstracts this interface. The `Session` constructor takes a `deps.hermes`. Wire `index.ts` to build an `OpenClawClient` when `OPENCLAW_CONNECT_MODE` (new env) is set, else `HermesClient`.
3. OpenClaw needs a JSON-RPC-over-stdio or JSON-RPC-over-WebSocket bridge. Options:
   - Spawn an OpenClaw CLI agent in a persistent JSON-RPC stdio mode (like `StdioHermesTransport`).
   - Connect to OpenClaw's gateway via WebSocket exposing the same `session.create` / `prompt.submit` / `session.interrupt` RPC surface.
   - Simplest MVP: implement `submitPrompt` via the OpenClaw CLI one-shot (`openclaw run "<prompt>"`), and `interrupt`/`streamPrompt` as best-effort.

**Option B: Replace the HermesAgent backend entirely.** If OpenClaw should own STT/TTS too, keep `hermes_audio.ts` (it uses Hermes Python STT/TTS helpers) but swap only the LLM transport. The `Session` already separates LLM (`hermes.submitPrompt`) from STT/TTS (`transcribeWithHermes` / `synthesizeWithHermes`), so you can keep Hermes STT/TTS and use OpenClaw for the LLM — **the minimal change is just swapping `HermesClient`**.

**Config additions needed (`.env`):**
```env
OPENCLAW_CONNECT_MODE=cli            # cli | gateway_ws | disabled
OPENCLAW_COMMAND=openclaw            # or full path
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789  # gateway port if used
OPENCLAW_WORKSPACE=/Users/<your-host>/openclaw-workspaces/dex
OPENCLAW_SUBAGENT_ID=dex             # or agent-a/dex as needed
```

### 4.7 `package.json` / `.env.example` highlights

- Deps: `dotenv`, `opusscript`, `ws`. Dev: tsx, typescript, @types.
- Key scripts: `start` (node dist), `mcp:stackchan` (node dist/stackchan_mcp_server.js), `probe:voice`.
- `.env.example` full of `STACKCHAN_*` tuning knobs. The **most relevant to a second backend**:
  - `HERMES_CONNECT_MODE=dashboard_ws` (or unset → stdio)
  - `HERMES_DASHBOARD_URL=http://127.0.0.1:9119`
  - `HERMES_ROOT=../hermes-agent`, `HERMES_PYTHON=python3`
  - `STACKCHAN_STREAM_LLM_TTS=true` (streaming TTS)
  - `STACKCHAN_CONTROL_PORT=8766`, `STACKCHAN_CONTROL_HOST=127.0.0.1`

---

## 5. Config Structure (firmware)

### 5.1 Three config sources (in priority order)

1. **SD card `/sdcard/config.json`** — the authoritative source (loaded at boot into NVS). Schema (`firmware/sdcard/config.sample.json`):
   ```json
   {
     "wifi_networks": [ { "name": "Home", "ssid": "...", "pass": "..." } ],
     "websocket_url": "ws://192.168.1.100:8765/ws",
     "websocket_version": 3,
     "timezone": "JST-9",
     "speaker_volume": 80,
     "display_brightness": 64
   }
   ```
   The SD parser (`hal/utils/sd_config/sd_config.cpp`) looks for `/sdcard/config.json`, `/sdcard/hermes-config.json`, `/sdcard/hermes/config.json`, `/sdcard/stackchan/config.json`. It accepts `websocket_url`, `bridge_url`, or `ws_url` (top-level or under a `websocket` object), plus legacy `ws_host`/`ws_port` (via `build_websocket_url_from_aiavatar_keys`). Validates `ws://` or `wss://`.

2. **NVS** — `websocket` namespace:
   - `url` (string) — the websocket endpoint
   - `url_override` (string) — fallback; SD write sets BOTH `url` and `url_override`
   - `version` (int) — protocol version (3)
   - Other NVS namespaces: `app_config` (`is_configed` bool), `wifi`, `display`, `audio`, `system`, `hermes` (idle config), `launcher_ret`, `warm_boot`.

3. **BLE provisioning** — only Wi-Fi credentials (ssid/password), NOT websocket_url.

### 5.2 How `websocket_url` is stored & retrieved

- **Write**: `apply_websocket_to_nvs()` in `sd_config.cpp` sets `url`, `url_override`, `version` under the `websocket` namespace. If config has no websocket, it erases those keys (SD is source of truth).
- **Read**: everywhere uses the same helper (duplicated in `hal_mcp.cpp`, `app_ai_agent.cpp`, `connectivity.cpp`, `websocket_protocol.cc`):
  ```cpp
  Settings ws_settings("websocket", false);
  std::string url = ws_settings.GetString("url_override", "");
  if (url.empty()) url = ws_settings.GetString("url", "");
  ```

### 5.3 What to add for an OpenClaw backend config section

Since OpenClaw lives server-side, you likely want the **device to select backend via SD config** (so a user can point the same firmware at either backend):

Add to `config.sample.json` / SD parser (`sd_config.cpp`):
```json
{ "backend": "openclaw", "openclaw_url": "ws://192.168.1.100:8765/ws" }
```
Then:
- Extend `parse_websocket_config()` (or add `parse_backend_config()`) to read a `backend` field (values: `hermes` | `openclaw`).
- Store it in NVS under a `backend` namespace or as `websocket/backend`.
- But note: **the firmware does not need to know the backend** — the firmware just talks to ai-server. The backend choice can be 100% server-side (ai-server picks `HermesClient` vs `OpenClawClient`). If you want per-device backend selection, the simplest is to have ai-server read `backend` from the device's `hello`/config message or use a per-`websocket_url` routing rule. **For an MVP, keep backend selection in ai-server's `.env` — no firmware change needed.**

---

## 6. MCP Tools (all 14)

### 6.1 The 13 robot `stackchan_*` tools + 1 subagent tool

These are the **server-side** MCP tools (exposed by `stackchan_mcp_server.ts` to Hermes as an MCP server). The firmware-side implementations use `self.robot.*` names.

| MCP tool (server-side, Hermes-facing) | Maps to firmware tool | Implementation |
|----------------------------------------|----------------------|----------------|
| `stackchan_get_status` | `self.robot.get_status` | ai-server → HTTP /tools/call → Session.callRobotTool → WS mcp → firmware |
| `stackchan_set_speaker_volume` | `self.robot.set_speaker_volume` | same chain |
| `stackchan_play_test_tone` | `self.audio.play_test_tone` | same chain |
| `stackchan_get_head_angles` | `self.robot.get_head_angles` | same chain |
| `stackchan_set_head_angles` | `self.robot.set_head_angles` | same chain |
| `stackchan_set_led_color` | `self.robot.set_led_color` | same chain |
| `stackchan_power_off` | `self.robot.power_off` | same chain |
| `stackchan_take_photo` | `self.camera.capture_photo` | same chain (returns MCP image block) |
| `stackchan_display_image` | `self.screen.preview_image_url` | ai-server resolves source (HTTP/file/MEDIA:) → serves via /media → passes URL |
| `stackchan_capture_screen` | `self.screen.capture_screenshot` | same chain (returns MCP image block) |
| `stackchan_create_reminder` | `self.robot.create_reminder` | same chain |
| `stackchan_get_reminders` | `self.robot.get_reminders` | same chain |
| `stackchan_stop_reminder` | `self.robot.stop_reminder` | same chain |
| `stackchan_ask_hermes_subagent` | *(no firmware counterpart)* | Hermes-only: returns immediately, spawns a background Hermes sub-agent, posts result via `/internal/followup` |

### 6.2 Implementation: firmware side vs server side

**Full call chain for a robot tool:**
```
Hermes (LLM) decides to call stackchan_set_led_color
  → Hermes MCP client invokes stackchan_mcp_server.js (stdio)
  → stackchan_mcp_server.ts: handleRequest('tools/call')
  → callBridge('stackchan_set_led_color', args)
  → POST http://127.0.0.1:8766/tools/call  { name, args }
  → device_control.ts: callStackChanTool() → activeSession.callRobotTool('self.robot.set_led_color', args)
  → Session.callRobotToolInternal(): assigns MCP id, sends WS {type:'mcp', session_id, payload:{jsonrpc:'2.0', id, method:'tools/call', params:{name, arguments}}}
  → Firmware McpServer invokes the registered tool (hal_mcp.cpp)
  → Firmware sends WS {type:'mcp', session_id, payload:{id, result}}
  → Session.handleMcpPayload() resolves the pending promise
  → result returned up the chain to Hermes
```

**Key point for OpenClaw:** OpenClaw can use the **exact same** `stackchan_mcp_server.ts` as an MCP server (register it in OpenClaw's MCP config, like Hermes does in `~/.hermes/config.yaml`). The `TOOL_MAP` in `device_control.ts` and the `tools[]` array in `stackchan_mcp_server.ts` are backend-agnostic — they just talk to the ai-server control HTTP endpoint.

### 6.3 The `stackchan_ask_hermes_subagent` tool (fast-response pattern worth copying for OpenClaw)

This is a notable pattern: for slow multi-step work, Hermes calls this tool, it returns immediately (acknowledgement), spawns a background sub-agent, and the result is delivered later via `/internal/followup`. **This is directly analogous to OpenClaw's subagent pattern and would map cleanly to an `openclaw_ask_subagent` tool** that spawns a `sessions_spawn` sub-agent and delivers the result via followup.

---

## 7. Key Integration Points for the OpenClaw Port

### 7.1 Firmware — NO changes required for a backend swap

The firmware talks only to `ws://<ai-server>:8765/ws`. Backend choice is entirely server-side.

### 7.2 ai-server — the single integration point

1. **Add `OpenClawClient`** implementing `HermesSessionClient` (`submitPrompt`, `streamPrompt`, `interrupt`, `dispose`).
2. **Select backend in `index.ts`** or `session.ts` via env (`OPENCLAW_CONNECT_MODE`).
3. **Reuse `stackchan_mcp_server.ts`** for OpenClaw MCP tool access (register as OpenClaw MCP server).
4. **STT/TTS**: keep `hermes_audio.ts` (Hermes Python helpers) for the MVP, OR add OpenClaw STT/TTS later. The `Session` decouples LLM from STT/TTS, so swapping only the LLM transport is trivial.

### 7.3 Recommended `.env` additions

```env
# Backend selection
OPENCLAW_CONNECT_MODE=cli            # disabled | cli | gateway_ws
OPENCLAW_COMMAND=openclaw
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_WORKSPACE=/Users/<your-host>/openclaw-workspaces/dex
OPENCLAW_AGENT=dex

# Optional subagent tool (mirror of stackchan_ask_hermes_subagent)
OPENCLAW_SUBAGENT_PROMPT_PREFIX=You are a background OpenClaw sub-agent for StackChan...
```

### 7.4 The OpenClaw transport options

- **CLI one-shot (simplest MVP)**: `openclaw run --agent dex "<prompt>"` → returns final text. `interrupt` = no-op or kill process. No streaming (or shell-stream).
- **Persistent stdio JSON-RPC (best)**: mirror `StdioHermesTransport` — spawn `openclaw` in a JSON-RPC-over-stdio gateway mode implementing `session.create` / `prompt.submit` / `session.interrupt`. This gives clean streaming + interrupt.
- **Gateway WebSocket**: connect to OpenClaw Gateway (`18789`) if it exposes a compatible JSON-RPC surface.

### 7.5 What OpenClaw gains from this bridge

- Full access to physical StackChan: audio voice loop, head servos, LEDs, speaker, camera, screen preview/capture, local reminders.
- The `stackchan_*` MCP tools are ready to register in OpenClaw with zero firmware changes.
- The `stackchan_ask_hermes_subagent` pattern maps to OpenClaw's subagent model for fast-ack + background work.

---

## 8. Files-to-touch Checklist for the Port

**Create:**
- `ai-server/src/openclaw.ts` — `OpenClawClient` + transports (cli / stdio / gateway_ws)
- `ai-server/src/openclaw_mcp.ts` (optional) — `openclaw_ask_subagent` tool or reuse `stackchan_mcp_server.ts`

**Modify:**
- `ai-server/src/index.ts` — wire `OpenClawClient` selection + optional warmup
- `ai-server/src/session.ts` — accept an `OpenClawSessionClient` (already generic via `SessionDeps.hermes`)
- `ai-server/.env.example` — add `OPENCLAW_*` vars + docs

**No changes to firmware**, unless you want SD-card backend selection (then touch `firmware/sdcard/config.sample.json`, `hal/utils/sd_config/sd_config.cpp`, and the NVS read helpers).

---

*Document generated 2026-08-18 by Dex subagent. Primary source code references: `firmware/main/hal/*.cpp/.cc`, `firmware/patches/xiaozhi-esp32.patch`, `ai-server/src/*.ts`, `firmware/sdkconfig.defaults`, `firmware/main/Kconfig.projbuild`.*
