# Swarm BETA — Minimal Client Analysis: Direct WebSocket in Stack-chan Firmware

**Date:** 2026-08-17
**Author:** Research Agent BETA
**Question:** Do we need the full `esp-openclaw-room-node` SDK, or can we write a lighter integration — a direct WebSocket client inside the Stack-chan firmware?

**Verdict (short):** The full room-node contract is **NOT required** for a working voice conversation. The OpenClaw Gateway WebSocket protocol is a small, well-documented JSON-RPC surface. The heavy parts (WebRTC, esp_webrtc, esp-openclaw-talk) are **optional** and can be bypassed with a proven raw-WebSocket + Opus path. There are **three viable architectures**, each with different tradeoffs. Details below.

---

## 1. What the OpenClaw Gateway WebSocket protocol actually requires

Source: `esp-openclaw-node/components/esp-openclaw-node/README.md` and `include/esp_openclaw_node.h`.

### 1.1 The wire protocol is small and self-contained

The component's README documents the **exact** wire messages (README.md, "Example Wire Messages" section). The full handshake is:

1. **Open WebSocket** to `ws://<gateway>:<port>` (or `wss://`).
2. **Gateway sends** `connect.challenge`:
   ```json
   {"type":"event","event":"connect.challenge","payload":{"nonce":"...","ts":1774830385123}}
   ```
3. **Node replies** with a `connect` request:
   ```json
   {"type":"req","id":"connect-...","method":"connect","params":{
     "minProtocol":3,"maxProtocol":4,
     "client":{"id":"node-host","displayName":"...","version":"1.0.0","platform":"esp32","deviceFamily":"ESP32","modelIdentifier":"esp32s3","mode":"node"},
     "role":"node","scopes":[],"caps":["device","wifi","gpio"],"commands":["device.info",...],
     "auth":{"deviceToken":"<saved-device-token>"},
     "userAgent":"esp-openclaw-node/1.0.0","locale":"en-US",
     "device":{"id":"<device-id>","publicKey":"<base64url-pubkey>","signature":"<base64url-sig>","signedAt":...,"nonce":"<from-challenge>"}
   }}
   ```
4. **Gateway replies** `hello-ok` (a `res` with `ok:true`), which may include `payload.auth.deviceToken` (the reconnect token) and `payload.pluginSurfaceUrls`.

**Key finding:** The protocol is a **plain JSON-RPC over WebSocket** (`type: req/res/event`, `method`, `params`, `id`). There is nothing exotic. Any WebSocket client that can send/receive JSON text frames can speak it.

### 1.2 connect.challenge signing — the one non-trivial piece

From `esp_openclaw_node.h` and README "Stored State":

- The node generates a **32-byte Ed25519 seed** (`device_seed`), stored in NVS namespace `openclaw`.
- From the seed it derives the **Ed25519 keypair** and a stable `device_id = hex(sha256(public_key))`.
- On connect, it **signs** the challenge payload (nonce + signedAt) with the Ed25519 private key, producing `device.signature` (base64url).

**This is the ONLY crypto the protocol requires.** It is:
- **Ed25519 signing** (well-supported on ESP32 — `mbedtls` has Ed25519, and there are Arduino/ESP-IDF libs).
- **SHA-256** for the device_id (trivial).
- **base64url** encoding (trivial).

**Proven in reference repo:** The `esp-openclaw-node` component does exactly this (README "Stored State", `esp_openclaw_node_get_device_id()` in the header). It is not theoretical — it's the shipped implementation.

**Theoretically possible but untested in Arduino:** Reimplementing Ed25519 signing + the connect handshake in Arduino/C++ is straightforward (mbedtls is bundled with ESP-IDF), but **nobody in our repos has done it in Arduino yet**. It's a small, well-bounded task.

### 1.3 Auth modes — you don't need setup codes

The component supports 5 connect sources (`esp_openclaw_node.h`, `esp_openclaw_node_connect_source_t`):
- `SAVED_SESSION` (reconnect with persisted `{gateway_uri, device_token}`)
- `SETUP_CODE` (base64url JSON with `url` + one of `bootstrapToken`/`token`/`password`)
- `GATEWAY_TOKEN` (`auth.token`)
- `GATEWAY_PASSWORD` (`auth.password`)
- `NO_AUTH` (omit `auth` entirely)

**For a minimal client, the simplest path is `GATEWAY_TOKEN` or `NO_AUTH`** — no setup-code decoding, no saved-session persistence. Just send `auth: {token: "<shared-token>"}` (or omit auth) and you're in. This dramatically simplifies the firmware.

### 1.4 Talk voice pipeline — WebRTC is the heavy part, and it's OPTIONAL

`esp-openclaw-talk` (README.md + `src/esp_openclaw_talk.c`) adapts OpenClaw's Talk API to `esp_webrtc` signaling. The flow:

1. Node sends `talk.client.create` RPC with `{mode:"realtime", transport:"webrtc", brain:"agent-consult", sessionKey:"main", capabilities:["gateway-control-v1"]}`.
2. Gateway returns `{transport:"webrtc", offerUrl:"/...", clientSecret:"...", voiceSessionId:"...", clientControl:{owner:"gateway"}}`.
3. Node POSTs its SDP to `offerUrl` with `Authorization: Bearer <clientSecret>`.
4. Gateway returns the answer SDP; `esp_webrtc` establishes the WebRTC peer connection and streams Opus audio.

**Critical finding:** This is **entirely a WebRTC path**. It requires:
- `esp_webrtc` (the full libpeer-derived stack, ~large)
- `esp_peer` (ICE/DTLS/SRTP)
- `esp_audio_codec` (Opus)
- AEC (acoustic echo cancellation)

**This is the ONLY part that needs the room-node/WebRTC contract.** And it is **not required** for a working voice conversation — see Architecture C below.

---

## 2. Can we implement a MINIMAL client (WebSocket + audio, no room-node)?

**YES.** The protocol surface is small:

| Piece | Needed? | Complexity |
|-------|---------|-----------|
| WebSocket client (ws://) | Yes | Trivial — Arduino `WebSocketsClient` or ESP-IDF `esp_websocket_client` |
| JSON encode/decode | Yes | Trivial — ArduinoJson / cJSON |
| Ed25519 signing | Yes (for device auth) | Small — mbedtls bundled with ESP-IDF |
| SHA-256 + base64url | Yes | Trivial |
| connect.challenge handshake | Yes | Small — ~50 lines of JSON |
| node.invoke.request/result | Optional | Only if you want gateway→device commands |
| WebRTC / esp_webrtc / esp-openclaw-talk | **NO** | Skip entirely for Architecture C |
| Opus encode/decode | Yes (for audio) | Small — `libopus` is available for ESP32 |

**The minimal client is: WebSocket + JSON + Ed25519 + Opus.** All four are well-supported on ESP32-S3. None require the room-node SDK.

---

## 3. esp-openclaw-talk — what it needs from the board

From `esp_openclaw_talk.h` and `src/esp_openclaw_talk.c`:

- It is a **signaling implementation** (`esp_peer_signaling_impl_t`) — a drop-in for `esp_webrtc_cfg_t.signaling_cfg.extra_cfg`.
- It requires an **already-connected operator-role node** with `operator.talk` scope (`esp_openclaw_node_handle_t operator_node`).
- It requires `gateway_http_base_url` for relative offer URLs.
- It does **NOT** touch audio directly — it only exchanges SDP. The actual audio capture/render is done by `esp_webrtc`'s media system.

**Answer to Q3:** `esp-openclaw-talk` **cannot** be used standalone with just audio handles. It is tightly coupled to:
1. A connected `esp_openclaw_node` (the full room-node contract), AND
2. The `esp_webrtc` media system (it's a signaling impl, not an audio pipeline).

So if you want to use `esp-openclaw-talk`, you **must** have the full room-node + esp_webrtc stack. There is no "talk standalone" mode.

**However** — the `esp_webrtc` solution itself **can** be used standalone without room-node. The `openai_demo` (README) shows a custom signaling impl (`esp_signaling_get_openai_signaling`) that talks directly to OpenAI's `/v1/realtime/calls` — no room-node, no OpenClaw. This proves `esp_webrtc` is a general WebRTC engine that can be pointed at any signaling endpoint. But that still means implementing WebRTC, which is the heavy path.

---

## 4. The XiaoZhi protocol option (proven working)

Source: `analysis/robot-bridge-repo-analysis.md` + web (xiaozhi.dev, xiaozhi-esp32).

The XiaoZhi WebSocket protocol is **simpler than the OpenClaw node protocol** and is **already supported by Stack-chan's stock firmware**:

- Client hello: `{"type":"hello","version":1,"transport":"websocket","audio_params":{...}}`
- Server hello: `{"type":"hello","session_id":"...","audio_params":{...}}`
- Listen start: `{"type":"listen","state":"start","mode":"auto"}`
- Listen stop: `{"type":"listen","state":"stop"}` (VAD silence)
- **Raw Opus audio in binary WS frames** while listening (60ms frames, 960 samples/frame)
- Server → Device: `{"type":"stt","text":"..."}`, `{"type":"llm","emotion":"neutral"}`, `{"type":"tts","state":"start"}`, binary Opus, `{"type":"tts","state":"stop"}`

**Proven in reference repo:** robot-bridge implements this **server-side in Python** and it works end-to-end (Stack-chan → Hermes agent, 21 features, deployed). The Opus parameters (16kHz mono, 60ms frames, complexity=10) are proven.

**Key insight:** XiaoZhi is a **device↔server** protocol. It does NOT speak OpenClaw's protocol. To use it with OpenClaw, you'd need a **bridge/proxy** that translates XiaoZhi ↔ OpenClaw. That's exactly what robot-bridge does for Hermes.

**Two sub-options:**
- **(a) XiaoZhi → bridge → OpenClaw:** Use Stack-chan's stock XiaoZhi firmware (zero firmware work) + a Python bridge that translates to OpenClaw. This is the **fastest to working** but keeps a Python middleman (which James wants to avoid).
- **(b) XiaoZhi protocol natively in Arduino:** Implement the XiaoZhi client in our custom firmware. This is simpler than the OpenClaw protocol (no Ed25519, no challenge) but still needs a bridge to OpenClaw.

---

## 5. Architecture C — native WebSocket + Opus in Arduino (RECOMMENDED for minimal)

This is the "Architecture C" the task describes: **Stack-chan firmware with a native WebSocket + Opus client, no WebRTC, no room-node SDK.**

### 5.1 What it looks like

```
ESP32 Stack-chan (Arduino/ESP-IDF)
  ├── WebSocketsClient (ws://gateway:port)
  ├── ArduinoJson (JSON-RPC)
  ├── mbedtls Ed25519 (device auth)
  ├── libopus (encode/decode)
  ├── I2S mic → Opus encode → WS binary frames
  └── WS binary frames → Opus decode → I2S speaker
```

### 5.2 How audio flows (the proven robot-bridge pattern, natively)

robot-bridge proved the **raw Opus over WebSocket** pattern works (robot-bridge-repo-analysis.md, "Opus Audio Streaming"). The same pattern can be implemented natively:

- **Mic → Opus:** Capture 16kHz mono from I2S, encode to Opus (60ms frames, 960 samples), send as binary WS frames.
- **Speaker ← Opus:** Receive binary WS frames, decode Opus, write to I2S.

**Proven in reference repo:** The Opus-over-WS framing is proven by robot-bridge (server side) and by XiaoZhi firmware (device side). The I2S speaker path is proven by `stackchan-mcp/firmware/src/pcm_stream_service.cpp` — it already does 24kHz mono s16le → I2S with click-free concealment, fade-in/out, and jitter buffering (lines ~40-60, `writeUdpI2sFrame`, `fillConcealmentRamp`, `applyFadeIn`). That code is directly reusable for the Opus-decode → I2S path.

**Theoretically possible but untested:** Doing the **full OpenClaw protocol + Opus natively in Arduino** (Ed25519 + challenge + binary audio) is theoretically possible but **nobody has shipped it**. It's a build task, not a research risk.

### 5.3 The one open question: how does the agent's audio get to us?

This is the **critical architectural decision** that determines whether Architecture C works:

- **OpenClaw's Talk API is WebRTC-only** (`transport:"webrtc"` in `talk.client.create`). There is **no documented raw-WebSocket audio mode** in the OpenClaw Talk API as documented in `esp_openclaw_talk.c`.
- **robot-bridge's audio path is NOT OpenClaw's** — it uses Hermes' own TTS/ASR (Sherpa-ONNX, SenseVoiceSmall) and streams Opus over its own WebSocket. It does **not** use OpenClaw's Talk API.

**So Architecture C has two sub-paths:**

- **(C1) Native OpenClaw protocol + OpenClaw's own audio:** Requires OpenClaw to support a non-WebRTC audio transport. **Not proven** — the reference `esp-openclaw-talk` only does WebRTC. This would need either (a) OpenClaw adding a raw-WS audio mode, or (b) a bridge that converts OpenClaw's WebRTC audio to raw Opus.
- **(C2) Native OpenClaw protocol for control + a separate audio path:** Use the OpenClaw WS for commands/control, and a separate mechanism (e.g., a bridge doing TTS/ASR like robot-bridge) for audio. This is proven (robot-bridge) but keeps a bridge for audio.

**Honest assessment:** A **fully-native, no-bridge, no-WebRTC** Architecture C that uses OpenClaw's own Talk audio is **NOT currently possible** with the documented protocol, because OpenClaw's Talk is WebRTC-only. To get there you'd need OpenClaw to expose a raw-WebSocket/Opus audio transport, or you accept a bridge for the audio leg.

---

## 6. Architecture comparison

| Aspect | A: Full room-node + WebRTC | B: XiaoZhi + bridge | C: Native WS + Opus |
|--------|---------------------------|---------------------|---------------------|
| Firmware work | High (esp_webrtc, room-node) | **Zero** (stock XiaoZhi) | Medium (WS+Opus+Ed25519) |
| Bridge needed | No | **Yes** (Python) | Maybe (audio leg) |
| OpenClaw native | **Yes** | No (translated) | **Yes** (control) |
| Audio transport | WebRTC (heavy) | Raw Opus WS (proven) | Raw Opus WS (proven) |
| Proven end-to-end | Reference repo (esp-openclaw-node) | **robot-bridge (deployed)** | Partially (pieces proven) |
| Latency | Low (WebRTC) | Low (Opus WS) | Low (Opus WS) |
| RAM/Flash footprint | High (WebRTC stack) | Low | Low |
| Risk | Low (reference exists) | Low (deployed) | **Medium** (integration untested) |

---

## 7. Recommendations

1. **The full room-node contract is NOT required for voice.** The OpenClaw WS protocol is a small JSON-RPC surface. The only crypto is Ed25519 signing, which is trivial on ESP32.

2. **If you want OpenClaw-native with zero bridge and are willing to carry the WebRTC weight:** Use the full `esp-openclaw-node` + `esp-openclaw-talk` stack. It's the reference, proven path. This is Architecture A.

3. **If you want the fastest working demo with zero firmware work:** Use stock XiaoZhi firmware + a Python bridge (robot-bridge pattern) that translates to OpenClaw. This is Architecture B. It keeps a Python middleman.

4. **Architecture C (native WS + Opus, no WebRTC) is the most attractive but has ONE blocker:** OpenClaw's Talk audio is WebRTC-only. A fully-native C1 (OpenClaw audio over raw WS) is **not currently possible** without OpenClaw adding a raw-WS audio transport. A C2 (native OpenClaw control + separate audio bridge) is proven but keeps a bridge.

5. **The pragmatic middle path:** Implement the **native OpenClaw WS client in Arduino** (Ed25519 + connect handshake + node.invoke) for control/commands, and use **raw Opus over the same WS** for audio **if OpenClaw supports it** — otherwise pair it with a thin audio bridge. This gets us 90% native with minimal firmware, and the WebSocket+Opus audio path is the proven robot-bridge pattern.

---

## 8. Key file references

- `esp-openclaw-node/components/esp-openclaw-node/include/esp_openclaw_node.h` — full C API, connect sources, device_id, events.
- `esp-openclaw-node/components/esp-openclaw-node/README.md` — wire protocol, connect.challenge, hello-ok, node.invoke, stored state, Ed25519 identity.
- `esp-openclaw-node/components/esp-openclaw-talk/README.md` — Talk = WebRTC signaling impl, needs operator node + esp_webrtc.
- `esp-openclaw-node/components/esp-openclaw-talk/src/esp_openclaw_talk.c` — talk.client.create flow, SDP exchange, gateway_owned descriptor check.
- `esp-openclaw-node/third_party/esp-webrtc-solution/components/esp_webrtc/README.md` — esp_webrtc is a general WebRTC engine; signaling is swappable (openai_demo proves standalone use).
- `esp-openclaw-node/third_party/esp-webrtc-solution/solutions/openai_demo/README.md` — custom signaling impl, no room-node, proves esp_webrtc standalone.
- `analysis/robot-bridge-repo-analysis.md` — XiaoZhi protocol, Opus params, proven Hermes bridge.
- `stackchan-mcp/firmware/src/pcm_stream_service.cpp` — proven I2S speaker path (24kHz mono s16le, click-free, jitter buffer) reusable for Opus-decode→I2S.
- `stackchan-mcp/firmware/src/http_server.cpp` — `/audio/session` UDP PCM session (proven low-latency audio transport pattern).

---

## 9. Distinction: proven vs. theoretical

**Proven in reference repos:**
- OpenClaw WS protocol handshake (esp-openclaw-node README, shipped).
- Ed25519 device identity + connect.challenge signing (esp-openclaw-node, shipped).
- XiaoZhi WebSocket + Opus protocol end-to-end (robot-bridge, deployed).
- Opus params: 16kHz mono, 60ms frames, 960 samples/frame (robot-bridge).
- I2S speaker playback with click-free concealment (stackchan-mcp pcm_stream_service.cpp).
- esp_webrtc standalone with custom signaling, no room-node (openai_demo).

**Theoretically possible but untested:**
- Full OpenClaw protocol + Opus natively in Arduino (no one has shipped it).
- OpenClaw Talk audio over raw WebSocket (OpenClaw's Talk is WebRTC-only; no raw-WS audio mode documented).
- Native Arduino Ed25519 + connect handshake (mbedtls supports it, but not yet done in our repos).
