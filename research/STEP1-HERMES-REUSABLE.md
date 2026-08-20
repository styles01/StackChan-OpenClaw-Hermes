# STEP 1 — Hermes-StackChan: What's Reusable for OpenClaw

**Review date:** 2026-08-19
**Reference repo:** `<repo-root>/stackchan-node/repos/working-repos/Hermes-StackChan` (GitHub: `circlemouth/Hermes-StackChan`)
**Our repo:** `<repo-root>/stackchan-node` (GitHub: `styles01/StackChan-OpenClaw-Hermes`)

**Bottom line up front:** The reference repo is *exactly* the architecture we want to build. It already solved the hard problem — replacing the xiaozhi cloud backend with a local bridge. The single most valuable reusable piece is **`ai-server/src/openclaw.ts`**, a ready-made OpenClaw Gateway HTTP client that routes LLM turns to `openclaw/agent-a` via `/v1/chat/completions` with per-device session-key routing. The firmware-side work (WebSocket protocol + Opus audio bridge + reconnect logic) is a thin adaptation of xiaozhi-esp32's existing WebSocket protocol, which we should learn from rather than copy wholesale.

---

## 1. Build System

**Files:** `firmware/CMakeLists.txt`, `firmware/fetch_repos.py`, `firmware/repos.json`, `firmware/.gitmodules`

### How it works

The firmware is **not** a fork of xiaozhi-esp32. It is a **Stack-chan / Mooncake-based top-level project** that **pulls xiaozhi-esp32 v2.2.4 as a git dependency** and **patches it in-place**.

- `firmware/repos.json` lists 6 git dependencies, each cloned into `firmware/` at a pinned branch/tag:
  - `mooncake` v2.3.3, `mooncake_log` v1.5.0, `smooth_ui_toolkit` v2.12.0 → `components/`
  - **`xiaozhi-esp32` v2.2.4 + `patch: patches/xiaozhi-esp32.patch`** → the cloud backend
  - `ArduinoJson` v7.4.2, `esp-now` → `components/`
- `firmware/fetch_repos.py` does: clone-or-fetch → checkout ref → optionally apply patch. The patch application logic uses `git apply --check` first, then `--reverse --check` to detect "already applied", exactly like the CMake patch mechanism (idempotent).
- `.gitmodules` at repo root adds `hermes-agent` → `https://github.com/NousResearch/hermes-agent.git` (the STT/TTS/LLM sidecar, pulled separately, empty in the working copy).
- **CMakeLists.txt** is mostly boilerplate plus **an idempotent patch-application block** that runs at configure time for 3 managed components (`esp-ml307`, `esp_lvgl_port`, `esp-wifi-connect`). Each block: check if patch applies → apply it; if already applied → no-op; else `FATAL_ERROR`. This is a clean pattern to reuse.
- **SDKCONFIG_DEFAULTS overlay:** CMakeLists auto-detects a git-ignored `sdkconfig.defaults.local` and appends it, so self-hosters can pin `CONFIG_STACKCHAN_SERVER_URL`/OTA URL without touching committed defaults.

### What to learn
- The **patch-in-place over a pinned upstream** model (repos.json + fetch_repos.py) is a clean way to adapt xiaozhi code without forking it. We can replicate this for OUR repo.
- The **idempotent `git apply --check` / reverse-check** pattern for build-time patches is exactly what we need to keep.
- The local sdkconfig overlay is a nice touch for pointing firmware at a custom OpenClaw bridge URL.

---

## 2. Patch Analysis — `firmware/patches/xiaozhi-esp32.patch`

**Applies to:** xiaozhi-esp32 v2.2.4. **1188 lines, 11 files.** All changes fall into three buckets: (A) point the WebSocket protocol at a local bridge, (B) make the audio channel self-healing / robust, (C) cosmetic + board fixes. File-by-file:

### `main/application.cc` + `main/application.h` — the core behavioral change (B, A)
- **Local WebSocket override:** `InitializeProtocol()` now reads NVS `"websocket"` namespace → `url` (fallback `url_override`). If set, it forces `std::make_unique<WebsocketProtocol>()` instead of MQTT/cloud. Sets `startup_connection_probe_pending_ = true`.
- **Startup connection probe:** new `ProbeStartupConnection()` — after activation, if a local websocket is configured and the audio channel isn't open and device is idle, it opens the channel automatically (persistent session).
- **Auto-reconnect with exponential backoff:** new `ScheduleAudioChannelReconnect()` / `CancelAudioChannelReconnect()` using an esp_timer. On disconnect → retry at 1s, 2s, 4s… capped 30s. Canceled on intentional close/launcher-return/protocol reset. This is how StackChan survives an `ai-server` restart.
- **Skips cloud OTA/version check** when a local websocket is configured (avoids phone-home).
- **`ShowActivationCode()` gutted** — no more binding-code voice. Just shows a "bind in the mobile app" message.
- **Wi-Fi disconnect handling** now shows a "HERMES Wi-Fi error" sad-face bubble and stops the audio channel.

### `main/assets.cc` + `main/assets.h`
- Comments out the entire `EmoteStrategy` (partition-mapped emote assets) — because StackChan's LCD shares SPI/GPIO with SD and the Hermes display strategy replaces it. Cosmetic/board-specific.

### `main/boards/common/backlight.cc`
- `RestoreBrightness()` short-circuits if brightness unchanged (avoids a pointless re-init that could glitch the display on handoff).

### `main/boards/common/i2c_device.cc/.h`
- Adds `TryReadRegs(reg, buf, len, timeout)` — a non-fatal I2C read used by the firmware for graceful sensor handling.

### `main/boards/common/wifi_board.cc`
- Adds `BuildHermesWifiErrorMessage()` and a `show_hermes_wifi_failure` bubble when WiFi config mode starts during boot (friendly "check SD /config.json" guidance instead of silent failure).

### `main/ota.cc`
- Reads the real firmware version from `esp_app_get_description()` instead of a hardcoded string; skip version check path is handled in application.cc.

### `main/protocols/websocket_protocol.cc/.h` — the protocol glue (high value)
- **`OpenAudioChannel()`** reads `websocket:url` (or `url_override`), token, and **version** from NVS. Errors now emit explicit "HERMES endpoint error / timeout" strings with the sanitized endpoint (credentials stripped).
- **Disconnect suppression flag:** new `suppress_next_disconnect_notification_` distinguishes an *intentional* close (launcher return, stop) from an *unexpected* disconnect. Only unexpected disconnects trigger the auto-reconnect (`on_disconnected_`).
- Logs the endpoint without leaking credentials.

**Verdict:** The `application.cc/.h` reconnect + local-websocket-forcing logic and the `websocket_protocol.cc` disconnect-suppression are the reusable firmware-side pieces. They are generic — they'd work identically pointing at OUR OpenClaw bridge.

---

## 3. Patch Analysis — the other three patches (`firmware/patches/`)

These are **component-level robustness patches** (not Hermes-specific, but they make the bridge reliable). All applied via the CMake idempotent mechanism:

- **`esp-ml307-tcp-shutdown.patch`** (`managed_components/78__esp-ml307`): Fixes a race in TCP/TLS teardown — adds `WaitForReceiveTaskExit()` to the ESP-AT ML307 TCP/SSL driver, guards event-group writes, and only fires the disconnect callback when actually connected. Prevents hangs/crashes on repeated connect/disconnect (important for the reconnect loop).
- **`esp-lvgl-port-rgb565-swap-buffer.patch`** (`managed_components/espressif__esp_lvgl_port`): Allocates a dedicated byte-swap buffer for RGB565 LVGL displays, avoiding in-place swap corruption of the draw buffer. Display-stability fix for the avatar face.
- **`esp-wifi-connect-station-stability.patch`** (`managed_components/78__esp-wifi-connect`): Adds human-readable disconnect reason names, disables WiFi power-save (`WIFI_PS_NONE`) for a stable connection, sets `listen_interval=0`, authmode/pma config, and logs the saved profile. **Keep — stable WiFi is prerequisite for a reliable voice bridge.**

**Verdict:** The ml307 and wifi-connect patches are valuable but general ESP hardening. The wifi-connect one (power-save off) is directly relevant to reliable OpenClaw bridging. The lvgl-port one only matters if we keep the LCD face.

---

## 4. ai-server — The Bridge (THE reusable core)

**Directory:** `ai-server/` — a TypeScript Node service. It is the translation layer between the **StackChan firmware's WebSocket/Opus protocol** and the **LLM backend**. This is where the "replace xiaozhi cloud with our backend" happens.

### Top-level flow (`src/index.ts` → `src/server.ts` → `src/session.ts`)
1. `startDeviceControlServer(8766, 127.0.0.1)` — local HTTP control (robot tools / status / followup).
2. `startServer(8765)` — WebSocket server on `/ws`, binds `0.0.0.0` so the ESP32 on WiFi can reach it.
3. Each device connection → one `Session` (WebSocket) which runs the full voice loop.

### `src/session.ts` — the heart (voice loop)
On each device WebSocket:
- **hello handshake** (protocol v3, `transport: websocket`, audio params `24000 Hz / 60 ms` output, `16000 Hz / 60 ms` input).
- **Opus in**: `extractOpusPayload()` (xiaozhi v2/v3 binary framing) → decode to PCM (opusscript).
- **Local RMS VAD** (`src/local_vad.ts`) detects utterance end from audio content (configurable thresholds), with barge-in VAD during TTS.
- **STT**: `src/hermes_audio.ts` → either OpenAI-compatible HTTP endpoint (`HERMES_STT_URL`) or Hermes Python `transcription_tools`.
- **LLM turn**: `Session` chooses backend at construction from `STACKCHAN_BACKEND` env:
  - `hermes` → `HermesClient` (`src/hermes.ts`)
  - **`openclaw` → `OpenClawClient` (`src/openclaw.ts`)** ← the prize
- **LLM → TTS**: text split into sentence segments → `synthesizeWithHermes` → encode Opus (`src/audio.ts`) → stream frames back to device with timing.
- **Robot tools**: `handleJson` `mcp` messages → `callRobotTool` → device control.

### `src/openclaw.ts` — THE REUSABLE OPENCLAW CLIENT (copy this)
A complete `HermesSessionClient` implementation (compatible with `session.ts` interface) that calls the **OpenClaw Gateway**:

- Endpoint: `http://${OPENCLAW_HOST}:${OPENCLAW_PORT}/v1/chat/completions` (default `127.0.0.1:18789`).
- Headers: `Authorization: Bearer <OPENCLAW_API_KEY>` + **`x-openclaw-session-key: agent:<agent_id>:stackchan:<device_id>`** (per-device session isolation — exactly the multi-agent routing we want).
- `submitPrompt(prompt)`: non-streamed POST, parses `choices[0].message.content`.
- `streamPrompt(prompt)`: **SSE streaming** (handles both `data:` and `data:` prefixes, `[DONE]`), yields `{type:'delta'|'complete'}` events — feeds the streaming LLM→TTS pipeline.
- `interrupt()` / `dispose()`: AbortController-based cancellation (supports barge-in).
- **Session key format matches our design:** `agent:agent-a:stackchan:default`.

### `src/hermes.ts`
The Hermes backend client (JSON-RPC over stdio `tui_gateway.entry` or WebSocket to Dashboard `/api/ws`). **Not needed for OpenClaw** except that STT/TTS may still use Hermes Python tools.

### `src/device_control.ts` + `src/stackchan_mcp_server.ts`
- Expose the robot as **MCP tools** (get_status, set_volume, head angles, LED, power_off, take_photo, display_image, capture_screen, reminders). Maps to firmware JSON-RPC `self.robot.*` / `self.camera.*` / `self.screen.*` tools.
- This gives our OpenClaw agent **tool-callable control** of the physical robot — valuable to carry over.

### Env config (`.env.example`) — the important ones for us
```
PORT=8765
STACKCHAN_CONTROL_PORT=8766
STACKCHAN_WS_HOST=0.0.0.0
STACKCHAN_BACKEND=openclaw
OPENCLAW_HOST=127.0.0.1
OPENCLAW_PORT=18789
OPENCLAW_AGENT_ID=agent-a
OPENCLAW_MODEL=openclaw/agent-a
OPENCLAW_API_KEY=<gateway-password>
STACKCHAN_DEVICE_ID=default
HERMES_ROOT=../hermes-agent   # STT/TTS Python helpers (can be replaced)
HERMES_STT_URL=...            # optional local STT
STACKCHAN_LOCAL_TTS_URL=...   # optional local TTS
```
Note: `STACKCHAN_BACKEND` is **global** (one ai-server = one backend) — v1 limitation noted in README.

**Verdict:** `ai-server/` (esp. `openclaw.ts`, `session.ts`, `audio.ts`, `local_vad.ts`, `device_control.ts`) is **the single most reusable artifact** in the whole repo. We can lift `openclaw.ts` nearly verbatim. `session.ts`'s STT/TTS/VAD/streaming pipeline is the proven glue.

---

## 5. Firmware Custom Code (vs. inherited xiaozhi)

`firmware/main/` is the **Stack-chan app layer** (mooncake), separate from the patched xiaozhi submodule. Custom pieces:

- **`main/main.cpp`** — bootstraps Mooncake apps (Launcher, AI Agent, Avatar, ESPNow, Dance, Setup), then on Hermes start request tears down Mooncake and calls `GetHAL().startHermes()` (never returns).
- **`main/hal/hal.h` + `hal.cpp`** — the `Hal` abstraction with a **"Hermes Bridge"** section: `requestHermesStart()`, `isHermesStartRequested()`, `prepareHermesDisplay()`, `startHermes()`, `getHermesBridgeConfig()`. `startHermes()` → `hal_bridge::start_hermes_app()` → `Application::GetInstance().Initialize(); Run();` (the **xiaozhi application runtime** from the patched submodule).
- **`main/hal/board/`** — board drivers:
  - `hal_bridge.cc/.h` — the seam between the Mooncake HAL and the xiaozhi `Application`/`Board`. Exposes touch point, Hermes-mode flag, LVGL display lock, `start_hermes_app()`, config (idle shutdown, charging, idle motion) persisted in NVS `"hermes"` ns.
  - `stackchan.cc` — the StackChan board (`M5Stack`), power save / idle shutdown integration, `hal_bridge::toggle_hermes_chat_state()`.
  - `stackchan_display.cc/.h` — `StackChanAvatarDisplay` with a dedicated **Hermes avatar LVGL screen** created at handoff (`create_hermes_avatar_screen`), plus `ResetForHermesHandoffLocked()`.
  - `stackchan_camera.cc` — camera driver.
- **`main/apps/app_ai_agent/`** — the **HERMES app** in Mooncake. On open, it checks SD config / websocket URL / WiFi readiness and either starts the Hermes bridge (`requestHermesStart()`) or shows a connectivity-error bubble.
- **`main/apps/app_launcher/`** — has `try_auto_open_hermes()` (opens Hermes automatically when config is present, gated by `CONFIG_HERMES_AUTOSTART`).
- **`main/apps/app_setup/workers/`** — Hermes power-saving + general config workers.
- **`main/Kconfig.projbuild`** — defines `CONFIG_HERMES_AUTOSTART` and the full `BOARD_TYPE` menu (StackChan / CoreS3 / etc.).

### What's custom vs. upstream
- **Custom:** the entire Mooncake HAL, board drivers, Hermes app/launcher/setup, the `hal_bridge` seam, and the handoff logic.
- **From xiaozhi (patched submodule):** the audio codec, AEC/wake-word (AFE), the WebSocket protocol, the `Application` state machine, STT/TTS hooks. The firmware talks to our bridge through the patched `WebsocketProtocol`.

---

## 6. Config Options — `firmware/sdkconfig.defaults`

Key settings (ESP32-S3 target, 16MB flash, QIO):
- `CONFIG_BOARD_TYPE_M5STACK_STACK_CHAN=y` — board.
- `CONFIG_HERMES_AUTOSTART=n` — the Hermes app doesn't auto-open by default (user opens it).
- `CONFIG_USE_SERVER_AEC=y`, `CONFIG_USE_AFE_WAKE_WORD=y`, `CONFIG_USE_AUDIO_PROCESSOR=y` — xiaozhi audio processing (AEC, wake word on-device).
- `CONFIG_SEND_WAKE_WORD_DATA=n` — don't send wake word to server.
- `CONFIG_SR_WN_WN9_HISTACKCHAN_TTS3=y` — the **WakeNet9 "Hi, StackChan"** model (custom wake phrase).
- `CONFIG_PARTITION_TABLE_CUSTOM=y` — custom `partitions.csv`.
- Memory/RTOS tuning (SPIRAM 80M, CPU 240, cache, task stacks, WDT 10s, BLE NimBLE for provisioning).
- Camera `GC0308` (DVP 320x240), LVGL fonts + QRCode/PNG/IMG tooling for the face UI.
- LVGL layout flags disable unneeded widgets (keyboard, list, menu, msgbox, win…) to save flash.

**Relevant to us:** the `HERMES_AUTOSTART`, wake-word model, audio processing (AFE/AEC), and partition table are all directly reusable for OpenClaw. The OpenClaw-specific config is **not** in sdkconfig — it lives in SD `/config.json` (`websocket_url: ws://<host>:8765/ws`) + NVS, plus ai-server `.env`.

---

## 7. What's Reusable For OpenClaw (our repo)

Ranked by value / effort:

### Tier 1 — Copy/adapt nearly verbatim (highest value)
1. **`ai-server/src/openclaw.ts`** — the OpenClaw Gateway client. **Directly reusable** — it already routes to `openclaw/agent-a` via `/v1/chat/completions` with per-device session key. Just confirm the Gateway's real HTTP port/auth and that SSE streaming matches.
2. **`ai-server/` whole session pipeline** (`session.ts`, `audio.ts`, `local_vad.ts`, `hermes_audio.ts`, `device_control.ts`, `stackchan_mcp_server.ts`) — this is the working firmware⇄LLM bridge. Port the OpenClaw + VAD + Opus + tool-control architecture.
3. **The `openclaw` backend selection mechanism** (`STACKCHAN_BACKEND=openclaw` in `Session` constructor + `.env.example`) — clean, env-driven.

**Tier 2 — Firmware logic to replicate (adapt, don't copy wholesale)**
4. **Patched `WebsocketProtocol`** (from the xiaozhi patch): local websocket override + `suppress_next_disconnect_notification_` + auto-reconnect with capped backoff. This is what lets a robot talk to *our* bridge and survive restarts.
5. **`application.cc` reconnect + local-websocket + skip-cloud-check** logic.
6. **The `hermes-agent`/`ai-server` split:** robot does only hardware (mic/speaker/face/servos); STT/LLM/TTS/MCP run on a host that talks to OpenClaw.
7. **`esp-wifi-connect-station-stability.patch`** (disable WiFi PS) — precondition for a reliable voice bridge.

**Tier 3 — Carry-over conveniences**
8. **Idempotent CMake patch-application** pattern + `sdkconfig.defaults.local` overlay.
9. **`device_control.ts` MCP tool surface** — gives OpenClaw tools to drive the robot (head, LED, camera, volume, reminders).
10. The Mooncake HAL + `hal_bridge.cc` seam, `StackChanAvatarDisplay` Hermes handoff, `AppAiAgent` launch readiness checks.

---

## 8. What Needs To Change (for OpenClaw instead of Hermes)

| Area | Reference (Hermes) | For OpenClaw |
|------|--------------------|--------------|
| **LLM backend** | `HermesClient` (JSON-RPC to HermesDashboard) | **`OpenClawClient` (already in repo)** — make it the default/primary backend. |
| **STT** | Hermes Python `transcription_tools` or `HERMES_STT_URL` | Keep OpenAI-compatible HTTP STT; add OpenClaw STT (whisper) if available; else a local Whisper endpoint. |
| **TTS** | Hermes `tts_tool` or `STACKCHAN_LOCAL_TTS_URL` | Keep HTTP local TTS (Piper etc.) — Hermes-specific only if we keep hermes-agent. |
| **Session key** | `agent:agent-a:stackchan:<device_id>` | Same key format works for OpenClaw — verify against gateway routing rules. |
| **Env** | `STACKCHAN_BACKEND=hermes`, `OPENCLAW_*` | Flip default to `openclaw`; point `OPENCLAW_HOST/PORT/AGENT_ID/MODEL/API_KEY` at our gateway. |
| **hermes-agent submodule** | Required for STT/TTS helpers + fallback LLM | **Drop it** if we use only OpenClaw + local STT/TTS. (README says Hermes still used for STT/TTS fallback; if we replace those too, it's fully optional.) |
| **Firmware config** | `websocket_url: ws://<ai-server>:8765/ws` | Same — the firmware doesn't care which LLM is behind the bridge. Point it at OUR ai-server. |
| **Control plane** | Hermes Dashboard /api/ws JSON-RPC | Replace with OpenClaw Gateway (no Hermes session mgmt needed). |
| **Multi-backend** | v1 is single backend per ai-server | For "dual backend" goal, we may keep the same env switch OR implement per-device binding (v2 feature). |

**Firmware changes that carry over unchanged:** the patched `WebsocketProtocol` + `application.cc` reconnect + `sdkconfig.defaults` + the board/HAL/app code — none of it references Hermes the LLM, only a generic websocket bridge. The word "Hermes" appears mostly in UI strings/identifiers and NVS namespace names (`"websocket"`, `"hermes"` config ns), which we can rename.

---

## 9. Actionable takeaways for `stackchan-node`

1. **The ai-server bridge is our centerpiece.** Port `ai-server/` (esp. `openclaw.ts` + `session.ts`) into our repo as the firmware⇄OpenClaw translation layer. This is the smallest, highest-leverage copy.
2. **Adopt the patched-WebsocketProtocol + reconnect model** in our firmware so the robot reliably maintains a persistent session to our bridge.
3. **Keep the OTS firmware board/HAL/app layer** (it's board-specific and already works); replace only the LLM-facing backend (Hermes → OpenClaw).
4. **Replicate the idempotent CMake patch + repos.json dependency mechanism** for pulling/adapting xiaozhi-esp32.
5. **Verify the OpenClaw Gateway HTTP endpoint** (`/v1/chat/completions` + `x-openclaw-session-key` header + SSE streaming) matches our gateway's real interface before porting `openclaw.ts` as-is.

**Recommended next research step (STEP 2):** inspect OUR `stackchan-node` firmware to map exactly which files we already have vs. which Hermes-StackChan files we adopt; and confirm the OpenClaw Gateway's HTTP chat-completions contract (port 18789, auth header, SSE streaming, session-key routing).
