# Analysis: M5Stack StackChan `app/` Directory

**Date:** 2026-08-18
**Repo:** `https://github.com/m5stack/StackChan` (local clone at `<repo-root>/stackchan-node/repos/StackChan/`)
**Question answered:** "Is THIS how we're supposed to tweak the main firmware?" — **No.**

---

## TL;DR — The Direct Answer

**`app/` is NOT the firmware, and it is NOT where you tweak the robot's on-device behavior.**

`app/` is a **Flutter mobile companion app** (iOS + Android) that runs on a **phone/tablet**, not on the robot. It is one of **four** independent codebases in the repo:

| Directory | What it is | Runs on |
|-----------|-----------|---------|
| `firmware/` | The actual robot firmware (ESP32-S3 / CoreS3) | **The robot** |
| `app/` | Flutter mobile app (iOS/Android) | **Your phone** |
| `remote/` | ESP-NOW remote controller firmware | A separate remote |
| `server/` | Backend server (Go) | A cloud/server |

The main repo README confirms this explicitly: *"Here are StackChan related open-source resources, including source code of the StackChan **firmware**, **remote controller firmware**, **mobile app** (iOS and Android), and **server**."*

**To tweak the robot's AI/personality, you do NOT rebuild the firmware.** The AI behavior is configured through the **XiaoZhi cloud** (xiaozhi.me), which the app and the firmware both talk to. The app is a *configuration/control surface* for that cloud service — not the behavior engine itself.

---

## 1. What is in `app/`? (Structure)

```
app/
├── README.md              # Flutter app README (features, build, config)
├── pubspec.yaml           # Flutter/Dart project manifest (v1.1.0+6)
├── analysis_options.yaml  # Dart linter config
├── devtools_options.yaml  # Flutter devtools config
├── android/               # Android native wrapper (Gradle/Kotlin)
├── ios/                   # iOS native wrapper (Xcode/Swift, Podfile)
├── assets/                # ~50 assets: SVG icons, PNGs, 3D model (.glb), setup videos
├── lib/                   # ← All Dart source code
│   ├── main.dart          # App entry point
│   ├── app_state.dart     # Global state (device MAC, auth, WebSocket)
│   ├── model/             # Data models
│   │   ├── XiaoZhi/       # ← XiaoZhi AI service models (agent, device, license, MCP, TTS, conversation)
│   │   ├── blue_device_info.dart, blue_model.dart  # BLE models
│   │   ├── dance_list.dart, expression_data.dart, msg_type.dart, etc.
│   ├── network/           # Network layer
│   │   ├── urls.dart      # ← Backend API endpoint config (KEY FILE)
│   │   ├── http.dart      # HTTP client
│   │   └── web_socket_util.dart  # WebSocket (RSA-encrypted) to backend
│   ├── util/              # Utilities
│   │   ├── XiaoZhi_util.dart    # ← XiaoZhi AI service client (KEY FILE)
│   │   ├── blue_util.dart       # ← BLE control of the robot (KEY FILE)
│   │   ├── value_constant.dart  # Constants, RSA keys, BLE keys
│   │   ├── rsa_util.dart, music_util.dart, audio_engine_manager.dart, etc.
│   └── view/              # UI screens
│       ├── home/          # home, settings, conversation, dance, mcp_page, avatar, camera...
│       └── popup/         # agent_configuration, edit_agent, device_wifi_config, login, motion...
└── test/                  # widget_test.dart
```

**Language/framework:** **Flutter (Dart 3.0+)**. Native wrappers are Kotlin (Android) and Swift/Objective-C (iOS). It uses `flutter_blue_plus` for BLE, `three_js` for 3D rendering, `dio` for HTTP, `get` for state management.

---

## 2. How does `app/` relate to `firmware/`?

They are **two separate, independent codebases** that communicate over **Bluetooth Low Energy (BLE)** and through a **shared cloud backend**.

- **`firmware/`** = the robot's brain. It's an ESP-IDF project (ESP32-S3) built on **xiaozhi-esp32** (the XiaoZhi ESP32 firmware framework). The `app_ai_agent` app on the device calls `GetHAL().requestXiaozhiStart()` to launch the XiaoZhi voice-AI service **on the device itself**.
- **`app/`** = the phone app. It does NOT run the AI. It:
  1. **Discovers & pairs** the robot over BLE (writes WiFi credentials, motion, expressions, RGB, avatar data to BLE characteristics).
  2. **Configures the AI Agent** on the XiaoZhi cloud (which LLM model, TTS voice, personality/character, memory, MCP tools).
  3. **Views conversations** (fetches chat history from XiaoZhi cloud).
  4. **Controls** the robot remotely (motion, dance, avatar, camera view).

**The AI conversation itself happens on the ROBOT** (via xiaozhi-esp32 firmware → XiaoZhi cloud → LLM), not in the app. The app is a remote control + configuration tool.

---

## 3. Can you customize Stack-chan's behavior through `app/` without modifying firmware?

**Partially — but only the *cloud-side* AI personality, not the on-device firmware behavior.**

Through the app's **"AI Agent Config"** screen (`lib/view/popup/agent_configuration.dart` + `edit_agent.dart`), you can create/edit an **AI Agent** that is bound to your device. The agent has these configurable fields (from `lib/model/XiaoZhi/agent.dart`):

- `agent_name` — name of the agent
- `llm_model` — **the LLM model** (selected from a list served by XiaoZhi cloud)
- `tts_voice` — voice tone (from XiaoZhi TTS list)
- `tts_speech_speed`, `tts_pitch`, `asr_speed` — speech parameters
- `character` — **personality profile** (free-text, with `{{assistant_name}}` / `{{user_name}}` placeholders)
- `memory` / `memory_type` (OFF / SHORT_TERM) / `long_memory_switch`
- `language` / `lang_code`
- `mcp_endpoints` — MCP tools the agent can use
- `knowledge_base_ids` — RAG knowledge bases

**This is the "personality/behavior" layer — and it lives in the XiaoZhi cloud, not in the firmware.** So yes, you can change the robot's *personality, voice, and LLM model* through the app (or directly via the XiaoZhi API) **without rebuilding the firmware**.

**BUT** — the on-device behavior (animations, motion, avatar rendering, dance, the app launcher, hardware control) is in `firmware/` and requires a firmware rebuild. The app cannot change that.

---

## 4. Language/Framework

**Flutter (Dart 3.0+)** — confirmed by `pubspec.yaml` (`sdk: ^3.11.5`), `lib/`, `android/`, `ios/`, `test/`. Native: Kotlin (Android), Swift/ObjC (iOS). Version `1.1.0+6`.

---

## 5. LLM/AI Integration — How does it talk to the robot?

**Two separate communication paths:**

### A. App ↔ Robot: **Bluetooth Low Energy (BLE)**
`lib/util/blue_util.dart` uses `flutter_blue_plus`. It writes to BLE characteristics on the robot:
- `targetServiceUUID` = `e2e5e5ff-1234-5678-1234-56789abcdef0`
- `headCharacteristicUUID` = `0000ffe1-...` (head/motion)
- `expressionCharacteristicUUID` = `0000ffe3-...` (facial expressions)
- `writeCharacteristicUUID` = `0000ffe4-...`
- `motionCharacteristicUUID` = `e2e5e5e1-...`
- `avatarCharacteristicUUID` = `e2e5e5e2-...`
- `configCharacteristicUUID` = `e2e5e5e3-...`
- `rgbCharacteristicUUID` = `e2e5e5e4-...`
- `wifiSetCharacteristicUUID` = `e2e5e5e3-...` (used to push WiFi credentials to the robot)

The app also connects to the backend over **WebSocket** (`web_socket_util.dart`) with **RSA-encrypted** auth headers.

### B. App ↔ XiaoZhi AI Cloud: **HTTPS REST + WebSocket**
`lib/util/XiaoZhi_util.dart` talks to **`https://XiaoZhi.me/`** (hardcoded base URL). Endpoints include:
- `api/developers/agent-templates/list` — agent templates
- `api/developers/devices` — device lookup by MAC
- `api/roles/model-list` — **the list of available LLM models**
- `api/user/tts-list` — TTS voices
- `api/agents` — create/edit agents
- `api/developers/mcp-endpoints` — MCP tool management
- `api/developers/generate-license` — device licensing
- `https://api.XiaoZhi.me/mcp/endpoints/list` — MCP endpoints

### C. Robot ↔ XiaoZhi Cloud (the actual AI)
The **firmware** (via xiaozhi-esp32) connects to the XiaoZhi cloud over **WebSocket/MQTT** and does streaming **ASR → LLM → TTS** on-device. The app is not in this loop for the core conversation.

---

## 6. Can it configure the robot's LLM backend / point it at a custom endpoint (like OpenClaw)?

**Not directly, and not to an arbitrary endpoint.** Here's the critical limitation:

- The app lets you **select an `llm_model`** for the agent, but the model list comes from **XiaoZhi's cloud** (`api/roles/model-list` → `https://XiaoZhi.me/`). It's a **curated dropdown**, not a free-form "enter your own endpoint URL" field.
- The **backend server URL** (`lib/network/urls.dart`) is a single hardcoded constant (`url = "00.000.000.000:0000/"` — a placeholder). This points at the **StackChan backend server** (device registration, dance storage, auth), NOT at an LLM.
- The **XiaoZhi base URL** (`https://XiaoZhi.me/`) is hardcoded in `XiaoZhi_util.dart`.

**So the app cannot point Stack-chan at a custom LLM endpoint like OpenClaw.** The LLM routing is controlled by the **XiaoZhi cloud service**, which the firmware connects to. To use a custom backend (e.g., OpenClaw), you would need to either:
1. **Modify the firmware** (xiaozhi-esp32) to point at your own WebSocket/MQTT server, OR
2. **Run your own XiaoZhi-compatible server** and point both the firmware and app at it (the `server/` directory in this repo is the StackChan backend, but the AI routing is XiaoZhi's).

**The `app/` directory is NOT the place to wire in OpenClaw.** The AI integration point is the firmware's xiaozhi-esp32 layer.

---

## 7. Key Files Read (Contents Summary)

| File | What it revealed |
|------|------------------|
| `README.md` | Flutter app, BLE control, XiaoZhi AI, Three.js 3D face, dance, RSA encryption. Backend config via `urls.dart` / `value_constant.dart`. |
| `pubspec.yaml` | Flutter/Dart 3.11.5, deps: flutter_blue_plus, three_js, dio, get, camera, opencv, ffmpeg, opus_codec, etc. |
| `lib/network/urls.dart` | Backend URL placeholder `00.000.000.000:0000/`; endpoints for device mgmt, dance, social, auth, XiaoZhi token. |
| `lib/util/value_constant.dart` | RSA keys (empty placeholders), BLE advertisement keys, language map, BLE private key (empty). |
| `lib/util/XiaoZhi_util.dart` | Full XiaoZhi cloud client: agents, devices, models, TTS, MCP, licenses, conversations. Base URL `https://XiaoZhi.me/`. |
| `lib/util/blue_util.dart` | BLE control: scan, pair, write motion/expression/avatar/RGB/WiFi characteristics. |
| `lib/view/popup/agent_configuration.dart` | "AI Agent Config" UI: bind device to an agent, show LLM model, TTS voice, character profile. |
| `lib/view/popup/edit_agent.dart` | Create/edit agent: pick LLM model (from XiaoZhi list), TTS voice, character, memory, MCP tools. |
| `lib/view/home/mcp_page.dart` | MCP endpoint management (name/description/enabled) + endpoint tokens. |
| `lib/view/popup/device_wifi_config.dart` | Pushes WiFi credentials to the robot over BLE. |
| `lib/view/home/conversation_page.dart` | Fetches conversation history from XiaoZhi cloud. |
| `lib/network/web_socket_util.dart` | RSA-encrypted WebSocket to backend. |
| `firmware/main/apps/app_ai_agent/app_ai_agent.cpp` | On-device AI.AGENT app calls `requestXiaozhiStart()` — AI runs on the robot via xiaozhi-esp32. |
| `firmware/xiaozhi-esp32/README.md` | XiaoZhi = MCP-based chatbot, streaming ASR+LLM+TTS, WebSocket/MQTT, device-side + cloud-side MCP. |

---

## Conclusion / Recommendation for James

- **`app/` is a phone companion app, not the firmware.** It is NOT the place to "tweak the main firmware."
- **The robot's AI personality (LLM model, voice, character, memory, MCP tools) is configured in the XiaoZhi cloud**, and can be changed through the app's "AI Agent Config" — **without rebuilding firmware**.
- **To point Stack-chan at a custom LLM/AI backend (like OpenClaw), the integration point is the firmware's xiaozhi-esp32 layer** (WebSocket/MQTT to the AI server), not `app/`. The app's model list is a XiaoZhi-curated dropdown and cannot be pointed at an arbitrary endpoint.
- If the goal is to run OpenClaw as the robot's brain, the work belongs in **`firmware/`** (xiaozhi-esp32 config / custom server), or by running a **XiaoZhi-compatible server** and pointing the firmware at it.
