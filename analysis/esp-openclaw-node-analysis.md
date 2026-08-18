# Technical Analysis: `esp-openclaw-node`

**Repo:** github.com/openclaw/esp-openclaw-node (local: `/Volumes/1TBSSDClawd/stackchan-node/repos/esp-openclaw-node`)
**Analyzed:** 2026-08-17
**Purpose:** Build a custom ESP32 OpenClaw node to replace the default Stack-chan chatbot firmware (target: M5Stack CoreS3 → "Rosie" node).

---

## 1. What Is This Project?

`esp-openclaw-node` is the **official ESP-IDF component + example suite** for running ESP32 boards as **OpenClaw Nodes** — i.e., physical devices that pair to an OpenClaw Gateway over the LAN and become controllable, voice-capable endpoints in an OpenClaw agent network.

- **Language:** C (ESP-IDF / FreeRTOS). No C++, no Arduino.
- **Framework:** ESP-IDF **5.x** (examples pin `==5.5.5`; component requires `>=5.0`).
- **Target hardware:** ESP32 family — ESP32-S3 (Waveshare AMOLED room node), ESP32-P4 (M5Stack Tab5), generic ESP32/ESP32-C6 (esp32-node example), ESP-BOX-3.
- **License:** Apache-2.0 (room-node has one Espressif-modified-MIT file for a pinned AEC closure).

**Key architectural fact:** This is *not* a chatbot firmware. It is a **thin, gateway-owned device**. The device does **no LLM inference, no STT, no TTS locally**. It is a **WebRTC audio endpoint + command executor** that the OpenClaw Gateway (running on a PC/server) drives. The "brain" (LLM, STT, TTS, wake routing) lives on the Gateway and its providers. This is the opposite of Stack-chan's self-contained chatbot model — and it's exactly the model we want for a Rosie node.

### Repository layout
- `components/esp-openclaw-node/` — core transport/pairing/command component (the reusable library).
- `components/esp-openclaw-talk/` — OpenClaw Talk (WebRTC voice) signaling adapter.
- `components/esp-openclaw-node-provisioning/` — Wi-Fi, saved-session, USB REPL provisioning helpers.
- `components/esp-openclaw-room-node/` — the **canonical full product** (dual sessions, wake word, Talk, Canvas UI, face, diagnostics). This is the crown jewel.
- `examples/` — thin board ports: `esp32-node`, `esp-box-3-display`, `waveshare-esp32-s3-touch-amoled-2.06-room-node`, `m5stack-tab5-room-node`.
- `third_party/` — submodules: `esp-webrtc-solution` (Espressif WebRTC stack) and `esp-protocols` (websocket client).

---

## 2. Architecture

Three layers, cleanly separated:

```
┌─────────────────────────────────────────────────────────────┐
│  Board port (examples/*) — thin, board-owned only          │
│  display.start/lock/unlock, audio.open (codec handles),    │
│  services.prepare_runtime/network, storage, board commands │
├─────────────────────────────────────────────────────────────┤
│  esp-openclaw-room-node (canonical product component)       │
│  dual node+operator sessions, Talk lifecycle, wake word,    │
│  Canvas/A2UI, procedural face, diagnostics, reconnect       │
├─────────────────────────────────────────────────────────────┤
│  esp-openclaw-node (core) + esp-openclaw-talk + provisioning│
│  WebSocket transport, Ed25519 identity, pairing, commands,  │
│  WebRTC signaling                                            │
├─────────────────────────────────────────────────────────────┤
│  third_party: esp-webrtc-solution (esp_webrtc, esp_peer,    │
│  av_render, media_lib_utils), esp-protocols (websocket)      │
└─────────────────────────────────────────────────────────────┘
```

### The room-node product (the model to copy)
The room-node owns:
1. **Two simultaneous OpenClaw sessions** on one device:
   - **node client** (`role="node"`) — advertises capabilities/commands (`talk`, `voiceWake`, `canvas`, `face`, `device`, board commands). Receives `node.invoke.request` from the Gateway.
   - **operator client** (`role="operator"`, scopes `operator.read` + `operator.talk`) — used to create Talk voice sessions and receive gateway events (`voicewake.changed`).
2. **Talk lifecycle** — a state machine (idle → dialing → active → closing) with a teardown queue, a call-timeout timer, and careful race handling between wake-initiated and agent-initiated calls.
3. **Wake word** — ambient WakeNet detection that starts a Talk session.
4. **Canvas/A2UI** — the Gateway can push UI (A2UI components or images) to the display via `canvas.*` commands.
5. **Procedural face** — LVGL-drawn animated face driven by Talk state and speech level.
6. **Diagnostics overlay** — live audio/Wi-Fi/heap meters, speaker test tone.

### Board port contract (how portable it is)
The room-node is **board-agnostic** via a narrow C struct (`esp_openclaw_room_node_config_t` in `include/esp_openclaw_room_node.h`). A board port must supply:
- **display**: `start`, `lock`, `unlock`, `set_brightness`, native w/h, safe_inset, `animated_face` flag, `animation_frame_ms`.
- **audio**: `open(ctx, handles)` returning `esp_codec_dev_handle_t record` + `playback`; plus `afe_layout` (e.g. `"MR"` = mic+reference), `record_channels`, `channel_mask`, `playback_volume`, optional `input_gain_db`.
- **services**: `prepare_runtime`, `prepare_network`, `register_commands` (board-specific node commands).
- **storage** (optional): file root + metrics.

**This is the single most important takeaway for porting to CoreS3:** the entire product logic is shared; a CoreS3 port is just a new `examples/m5stack-cores3-room-node/` that fills in the display/audio/services structs. The Waveshare S3 example is the closest template (same ESP32-S3, PSRAM, I2S codecs, LVGL).

---

## 3. Communication Protocol

**Primary transport: WebSocket to the OpenClaw Gateway.** No MQTT, no direct HTTP polling for control.

- **URLs:** `ws://<gateway-host>:<port>` or `wss://...` (TLS via mbedTLS cert bundle). Default gateway port in examples is `19001` (ws) / `19100` (http origin for Canvas/Talk).
- **Protocol:** a JSON-RPC-style message protocol over WebSocket with `type: "req" | "event" | "res"`, `method`, `id`, `params`. Protocol version 3–4.
- **Pairing flow:**
  1. Device generates/loads a 32-byte Ed25519 seed from NVS → derives keypair + stable `device_id = hex(sha256(public_key))`.
  2. Device opens WS, receives `connect.challenge` (nonce + ts).
  3. Device signs the challenge and sends `connect` with client metadata, capabilities, commands, and auth.
  4. Gateway replies `hello-ok` with `auth.deviceToken` (persisted as the reconnect session) and optionally `pluginSurfaceUrls.canvas`.
- **Auth modes:** setup-code (base64url JSON with `url` + `bootstrapToken`/`token`/`password`), gateway token, gateway password, no-auth, and saved-session reconnect.
- **Command dispatch:** Gateway sends `node.invoke.request` → device runs registered handler → replies `node.invoke.result` (ok + `payloadJSON`, or error code/message).
- **Async RPCs:** device can call gateway methods via `esp_openclaw_node_gateway_request()` (used for `talk.client.create` / `talk.client.close`).
- **Reconnect:** component does one attempt at a time; the app layer (provisioning helper / room-node) implements saved-session auto-reconnect.

**Talk (voice) transport:** WebRTC (audio-only, Opus 16 kHz mono) — see §4/§6.

---

## 4. Audio Pipeline

**No local STT/TTS.** All speech recognition and synthesis happen on the Gateway/provider. The device only does:
- **Capture:** mic → codec (ES7210/ES8311 etc.) → I2S → **Espressif AFE (AEC)** → two sinks.
- **Playback:** Opus → decode → `av_render` player → render tap → I2S renderer → codec → speaker.

**Key components (all Espressif, from `esp-webrtc-solution` + `esp-sr`):**
- `esp_capture` — capture pipeline with an **AEC source** (`room_capture_new_audio_aec_src`). The AFE does acoustic echo cancellation + noise suppression + VAD + WakeNet.
- **WakeNet 9 (`wn9_hiesp`)** — the wake-word model, compiled in (`CONFIG_SR_WN_WN9_HIESP=y`). Wake word is **"Hi ESP"** (hardcoded in `room_media.c`: `wake_callback("hiesp", ...)`).
- **Opus codec** — `ESP_CAPTURE_FMT_ID_OPUS`, 16 kHz, mono, 16-bit. WebRTC peer configured with `ESP_PEER_AUDIO_CODEC_OPUS`, `sample_rate=16000`, `channel=1`.
- **Two capture sinks:** sink 0 = Talk (Opus, consumed by esp_webrtc), sink 1 = ambient wake (PCM, drained by a `wake_drain_task` to keep the AFE fetching so WakeNet keeps firing).
- **Render tap** — wraps the I2S renderer to feed mean amplitude to the face (mouth follows speech) and to diagnostics.

**Ambient vs Talk capture ownership:** When idle, the AFE runs with WakeNet enabled (ambient). On wake, Talk reopens the AFE with AEC+VAD but **WakeNet disabled**; after the call, ambient reopens with WakeNet restored. This is handled by `room_media_set_ambient_wake(bool)`.

---

## 5. LLM Integration

**The device does NOT call an LLM directly.** There is no API key, no HTTP call to an LLM provider, no MCP client on the device.

The LLM lives on the **OpenClaw Gateway** (or its configured provider). The device's role is:
1. Capture audio → send over WebRTC to the provider (via the Gateway's Talk API).
2. Receive synthesized speech back over WebRTC → play it.
3. Execute `node.invoke` commands the agent decides to run (e.g. `face.set`, `talk.stop`, `display.show`, GPIO).

The only "brain" configuration the device exposes is optional `provider` / `model` / `voice` overrides passed through to the Gateway's `talk.client.create` (e.g. `gpt-live-1-codex`). By default these are empty and the Gateway's Talk config is used.

---

## 6. OpenClaw Integration (the core question)

**Yes — this connects to OpenClaw specifically, via the OpenClaw Node WebSocket protocol + the OpenClaw Talk API.** It is not MCP, not a generic HTTP API.

### Node connection (control plane)
- WebSocket to the Gateway (`ws://host:19001`), JSON-RPC protocol, Ed25519-signed pairing, capability/command advertisement, `node.invoke` dispatch. Fully implemented in `components/esp-openclaw-node/`.

### Talk (voice plane) — `components/esp-openclaw-talk/`
This is the clever part. The device does **not** do WebRTC signaling itself. Instead:
1. The **operator** session calls the Gateway RPC **`talk.client.create`** with `{mode:"realtime", transport:"webrtc", brain:"agent-consult", sessionKey:"main", capabilities:["gateway-control-v1"]}`.
2. The Gateway (which owns provider credentials and the agent-consult sideband) returns an **offer URL** + single-use **clientSecret** + `voiceSessionId`, and requires the descriptor `clientControl: {owner:"gateway"}` (gateway-owned control — no client-side tool handling).
3. The device POSTs its local SDP to the offer URL (HTTP, `Authorization: Bearer <clientSecret>`, `Content-Type: application/sdp`), gets the answer SDP, and feeds it to `esp_webrtc`.
4. WebRTC media flows **directly between the device and the provider** (client-owned WebRTC), while OpenClaw owns credentials and agent delegation.
5. On close, device calls `talk.client.close` with `sessionKey` + `voiceSessionId`.

**Gateway events observed:** `voicewake.changed`, `voicewake.routing.changed` (wake routing updates from the Gateway).

**Gateway-side setup required:** `gateway.bind lan`, a command allowlist (`gateway.nodes.commands.allow`), and a Gateway that supports `gateway-control-v1` Talk (older Gateways fail with "Gateway upgrade required").

---

## 7. Wake Word Handling

- **Detection:** Espressif **WakeNet 9** (`wn9_hiesp`), compiled into the firmware, running inside the AFE capture pipeline. Wake word is **"Hi ESP"**.
- **Customization:** The model is **compiled in** (`CONFIG_SR_WN_WN9_HIESP=y`). The README explicitly notes: *"an arbitrary text trigger cannot replace a compiled local WakeNet model."* To change the wake word you must build with a different WakeNet model (esp-sr ships several: `wn9_hiesp`, `wn9_nihaoxiaoan`, `wn9_nihaotiancai`, etc.) or train a custom one. The wake callback is `room_afe_wake()` → `wake_callback("hiesp", ...)`.
- **Behavior:** On wake, the room-node checks state (operator ready, no active call/camera), sets UI to CONNECTING, plays a "surprise" face gesture, and notifies the talk-start worker to open a Talk session.
- **Gateway routing:** The Gateway can push `voicewake.changed` events, but the *local* trigger is always the compiled WakeNet model. (A console `wake` command simulates the wake word for testing.)
- **For Rosie:** If we want a custom wake word (e.g. "Rosie"), we'd need to either (a) use a different prebuilt WakeNet model, (b) train/customize a WakeNet model via Espressif's tooling, or (c) keep "Hi ESP" and rely on the Gateway for routing. This is the main customization constraint.

---

## 8. Hardware Abstraction & Portability to M5Stack CoreS3

**Supported boards (from examples):**
- ESP32 (generic, esp32-node) — device/wifi/gpio/adc commands only.
- ESP-BOX-3 — + display.
- **Waveshare ESP32-S3 Touch AMOLED 2.06** — full room node (WakeNet, AEC, WebRTC Talk, Canvas, face). **Closest analog to CoreS3.**
- **M5Stack Tab5** (ESP32-P4 + C6 remote Wi-Fi) — full room node + camera, sensors, SD, RS-485.

**Portability to M5Stack CoreS3 (ESP32-S3):**
- **Very high.** The room-node is board-agnostic behind the `esp_openclaw_room_node_config_t` port struct. A CoreS3 port = a new example that fills in:
  - **display**: CoreS3 uses an ST7789 320×240 LCD via SPI + LVGL (M5Stack BSP / `m5stack-esp32-coreS3` component). `animated_face = true` is feasible (S3 has the CPU for it; the Waveshare S3 runs it at 60 Hz).
  - **audio**: CoreS3 uses an **AW88298** speaker amp + **ES7210** (or ES8311) mic via I2S. The Waveshare `audio_open` (ES7210 mic + ES8311 speaker) is a near-direct template; swap the speaker codec to AW88298 and set the right I2S pins/`afe_layout`.
  - **services**: `prepare_network` (CoreS3 has native Wi-Fi, unlike Tab5's hosted C6), `prepare_runtime`, `register_commands` (CoreS3 has a button, IMU, maybe battery).
  - **storage** (optional): SD card.
- **Memory profile:** The Waveshare S3 sdkconfig is the reference — PSRAM-first (`CONFIG_SPIRAM_TRY_ALLOCATE_WIFI_LWIP`, `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=256`, `CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC`), task priorities raised to 11 for node/websocket, internal DMA draw buffers for the panel. CoreS3 has 8MB PSRAM + 16MB flash, plenty.
- **Caveats:** CoreS3's display is small (320×240) vs the room-node's assumed larger canvases — the Canvas/A2UI layout and face geometry may need tuning, but the code is resolution-parameterized via `native_width/height` and `safe_inset`.

---

## 9. Build System

- **ESP-IDF** (not PlatformIO, not Arduino). Component-based (`idf_component_register`), managed dependencies via `idf_component.yml`.
- **IDF version:** `>=5.0` for the core component; examples pin **`==5.5.5`** (Tab5) and use IDF 5.5 (Waveshare). `esp-openclaw-talk` requires `>=5.3`.
- **Build:** `idf.py set-target <target> && idf.py build flash monitor`.
- **Key deps:** `espressif/cjson`, `espressif/esp_websocket_client`, `espressif/libsodium` (Ed25519), `mbedtls`, `nvs_flash`, `espressif/esp-sr` (WakeNet/AFE), `espressif/esp_audio_codec`, `espressif/esp_capture`, `espressif/esp_codec_dev`, `espressif/esp_new_jpeg`, `lvgl__lvgl`, plus the submodule `esp-webrtc-solution` (esp_webrtc, esp_peer, av_render, media_lib_utils) and `esp-protocols`.
- **Config:** Kconfig (`menuconfig`) under "ESP OpenClaw Node" (capabilities/commands/stack sizes/priorities) and "OpenClaw room node" (Wi-Fi SSID/password, setup code, Talk provider/model/voice, call idle seconds).
- **Partition table:** custom `partitions.csv` (large app + NVS).

---

## 10. Five Most Important Files

1. **`components/esp-openclaw-node/include/esp_openclaw_node.h`** — The public C API of the core component: lifecycle (`create/destroy`), registration (capabilities/scopes/commands), async control (`request_connect/disconnect`, `gateway_request`), inspection. This is the contract every node app builds against.

2. **`components/esp-openclaw-node/src/esp_openclaw_node_protocol.c`** (34 KB) — The OpenClaw wire protocol: `connect.challenge` signing, `connect` request construction, `hello-ok` handling, `node.invoke.request` dispatch, `node.invoke.result` replies, gateway RPCs. The heart of OpenClaw integration.

3. **`components/esp-openclaw-room-node/esp_openclaw_room_node.c`** (50 KB) — The canonical product: dual node/operator sessions, Talk lifecycle state machine, wake-word → Talk flow, reconnect policy, command registration, camera serialization, diagnostics. The blueprint for a Rosie room node.

4. **`components/esp-openclaw-room-node/room_media.c`** — The audio pipeline: AFE/AEC capture source, WakeNet ambient wake, Opus Talk sink, av_render player with render tap (face mouth), ambient↔Talk capture ownership switching. Everything about audio/wake.

5. **`components/esp-openclaw-talk/src/esp_openclaw_talk.c`** — The Talk signaling adapter: `talk.client.create` RPC, offer-URL SDP exchange over HTTP with Bearer token, gateway-owned control descriptor check, `talk.client.close`. How voice actually connects.

*(Honorable mentions: `examples/waveshare-.../main/main.c` — the closest S3 board port template; `components/esp-openclaw-room-node/include/esp_openclaw_room_node.h` — the board port contract.)*

---

## 11. What We Can Steal for the Stack-chan → Rosie Node

This repo is essentially a **turnkey OpenClaw voice-node reference design**. For a CoreS3-based Rosie node, the highest-value reuse:

1. **The entire `esp-openclaw-node` core component** — WebSocket transport, Ed25519 identity, pairing, saved-session reconnect, command dispatch. Use it verbatim (it's a published ESP-IDF component, `espressif`-managed deps). Zero reason to reimplement.

2. **The `esp-openclaw-room-node` product component** — dual node/operator sessions, Talk lifecycle, wake word, Canvas, face, diagnostics. Use it verbatim; it's board-agnostic.

3. **The Waveshare S3 board port as the CoreS3 template** — copy `examples/waveshare-esp32-s3-touch-amoled-2.06-room-node/main/main.c` and its sdkconfig, then swap:
   - display → CoreS3 ST7789 320×240 (M5Stack BSP / esp_lcd + LVGL),
   - audio → CoreS3 AW88298 speaker + ES7210/ES8311 mic (I2S),
   - `afe_layout`/`record_channels`/`channel_mask` to match CoreS3 mic topology,
   - services → native Wi-Fi (CoreS3 has it built-in), button/IMU/battery commands.

4. **The `esp-openclaw-talk` component + `esp-webrtc-solution` submodule** — the entire WebRTC voice path (Opus, AEC, provider-direct media). Use verbatim.

5. **The provisioning component** — Wi-Fi + USB REPL + saved-session reconnect. Use verbatim.

6. **The sdkconfig memory/priority profile** — the Waveshare S3 config (PSRAM-first, task priorities 11, internal DMA draw buffers) is battle-tested for exactly our hardware class.

### What we must build / customize ourselves
- **A new board port** (`examples/m5stack-cores3-room-node/`) filling the port struct — this is the main engineering work, but it's *thin* (the Waveshare port is ~300 lines of board code).
- **Wake word:** decide on "Hi ESP" (free, works) vs. a custom "Rosie" WakeNet model (needs Espressif model tooling / training). This is the one hard customization constraint.
- **Face/UI tuning** for the small 320×240 CoreS3 screen (safe_inset, Canvas layout, face geometry).
- **Stack-chan-specific hardware** (servo/neck, if we keep it) — the room-node has no servo support; we'd add a `servo.*` command via the board's `register_commands` hook.
- **Gateway-side config:** `gateway.bind lan`, command allowlist, and a Gateway that supports `gateway-control-v1` Talk.

### Key architectural decision to carry forward
**The device is a gateway-owned thin client, not a self-contained chatbot.** All intelligence (LLM, STT, TTS, wake routing) lives on the OpenClaw Gateway. This is a fundamentally different (and more powerful) model than Stack-chan's on-device chatbot — Rosie becomes a voice/display/actuator endpoint in the OpenClaw network, with the full agent toolchain available. We should embrace this rather than try to replicate Stack-chan's local-chatbot behavior.

---

## Appendix: Wire Protocol Quick Reference

**connect.challenge (gateway→node):**
```json
{"type":"event","event":"connect.challenge","payload":{"nonce":"...","ts":1774830385123}}
```

**connect (node→gateway):** `type:"req"`, `method:"connect"`, `params` with `minProtocol:3, maxProtocol:4`, `client{id,displayName,version,platform,deviceFamily,modelIdentifier,mode:"node"}`, `role:"node"`, `caps[]`, `commands[]`, `auth{deviceToken|bootstrapToken|token|password}`, `device{id,publicKey,signature,signedAt,nonce}`.

**hello-ok (gateway→node):** `type:"res"`, `ok:true`, `payload{type:"hello-ok", protocol, server{version,connId}, pluginSurfaceUrls{canvas}, auth{deviceToken, role, scopes, deviceTokens[]}}`.

**node.invoke.request (gateway→node):** `type:"event"`, `event:"node.invoke.request"`, `payload{id, nodeId, command, paramsJSON}`.

**node.invoke.result (node→gateway):** `type:"req"`, `method:"node.invoke.result"`, `params{id, nodeId, ok, payloadJSON | error{code,message}}`.

**Talk:** `talk.client.create` (operator session) → offer URL + clientSecret + voiceSessionId; SDP POST to offer URL; `talk.client.close` on teardown.
