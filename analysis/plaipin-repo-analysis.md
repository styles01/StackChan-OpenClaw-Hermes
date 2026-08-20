# PlaiPin/plaipin-openclaw-stackchan — Repo Analysis

**Date:** 2026-08-17
**Repo:** https://github.com/PlaiPin/plaipin-openclaw-stackchan
**Stars:** 2 | **Forks:** 0 | **Created:** 2026-03-30
**Languages:** C, C++, HTML, JavaScript, Makefile, Shell
**Org:** PlaiPin (US-based, also makes rosclaw = ROS2+OpenClaw, solana-esp32-x402)

## Verdict: HELPFUL — different architecture, but real working OpenClaw+Stack-chan code

## What They Built

This is a **PlatformIO/Arduino** project (NOT ESP-IDF). It takes the existing Stack-chan Arduino firmware (the "AiStackChanEx" community fork by ronron-gh) and adds OpenClaw as one of several LLM backend options.

### Architecture: REST Proxy (NOT native OpenClaw node)

Their approach is fundamentally different from ours:

```
Stack-chan (Arduino firmware)
    ↓ HTTP POST /v1/chat/completions (OpenAI-shaped)
openclaw-rest-proxy.js (Node.js, port 18790)
    ↓ WebSocket
OpenClaw Gateway (port 18789)
```

The ESP32 thinks it's talking to an OpenAI-compatible API. A Node.js proxy translates that into OpenClaw WebSocket protocol messages. This is a **clever shortcut** — no ESP-IDF, no WebRTC, no esp-openclaw-node components. Just HTTP + JSON.

### Key Files

1. **`openclaw-rest-proxy.js`** (456 lines) — The star of the show
   - HTTP server on port 18790
   - Accepts `POST /v1/chat/completions` (OpenAI format)
   - Translates to OpenClaw WebSocket protocol
   - Handles session management, reconnection
   - **Telegram polling**: Also polls Telegram messages and queues them for the robot to pick up via `GET /v1/pending`
   - Sends what the robot heard to Telegram so both sides of the conversation are visible
   - systemd service file included

2. **`firmware/src/llm/OpenClaw/OpenClawClient.cpp`** (283 lines)
   - Implements `LLMBase` interface for OpenClaw
   - Makes HTTP POST to the proxy (not WebSocket directly)
   - Model field: `"openclaw:main"`
   - Strips emoji from responses for TTS compatibility (clever — ESP32 TTS engines choke on 4-byte emoji)
   - Loads system prompt from SPIFFS
   - Disables local memory (`enableMemory(false)`) — OpenClaw handles memory server-side

3. **`firmware/src/StackchanExConfig.h`** — Config struct with `openclaw_s` type:
   ```c
   typedef struct OpenClawConf {
       // host, port, model
   } openclaw_s;
   ```

4. **`firmware/src/ServoCustom.cpp`** — Simple servo wrapper:
   - `moveToOrigin()` — return to center
   - `moveToGaze(int gazeX, int gazeY)` — look at a direction
   - Extends `StackchanSERVO` from stackchan-arduino library

5. **`firmware/src/driver/WakeWord.cpp`** — Custom MFCC-based wake word using SimpleVox
   - NOT ESP-SR/WakeNet — uses `simplevox::VadEngine` + `simplevox::MfccEngine`
   - Records 3-second audio clips, computes MFCC features, compares against registered templates
   - Stores templates in SPIFFS
   - Can register custom wake words by recording your voice
   - This is a completely different approach from Espressif's WakeNet

6. **`firmware/src/driver/AudioOutputM5Speaker.h`** — M5Unified speaker driver
   - Tri-buffer audio output for M5Stack speakers
   - Uses `m5::Speaker_Class::playRaw()`

7. **`firmware/platformio.ini`** — Multi-target build config
   - Supports: m5stack-core2, m5stack-cores3, m5stack-atoms3r
   - Multiple LLM backends: ChatGPT, Gemini, ModuleLLM, OpenClaw
   - Multiple TTS: WebVoiceVox, ElevenLabs, OpenAI, AquesTalk, ModuleLLM
   - Uses `stackchan-arduino` library from GitHub

8. **`firmware/my_cores3_16MB.csv`** — Partition table for CoreS3:
   ```
   nvs:       0x9000,  0x5000
   otadata:   0xe000,  0x2000
   app0:      0x10000, 0x640000 (6.25MB)
   app1:      0x650000,0x640000 (6.25MB)
   spiffs:    0xc90000,0x340000 (3.25MB)
   fr:        0xfd0000,0x20000  (128KB)
   coredump:  0xFF0000,0x10000  (64KB)
   ```
   Note: Their OTA partitions are 6.25MB each vs our 6MB. They also have a dedicated coredump partition.

## What We Can Learn From This

### Directly Useful
1. **Emoji stripping for TTS** — Their UTF-8 emoji filter is a good idea. When Agent A sends text with emoji to the robot for TTS, we should strip 4-byte emoji and decorative symbols. Copy their approach.
2. **Partition table reference** — Their CoreS3 partition layout confirms 16MB flash with ~6MB OTA partitions works. They also include a coredump partition (good idea for debugging).
3. **Servo API pattern** — `moveToGaze(gazeX, gazeY)` is the right abstraction for servo control. Our servo port should match this pattern.
4. **Telegram proxy pattern** — Their idea of polling Telegram and queuing messages for the robot is interesting. The proxy acts as a bridge for async messages going TO the robot.

### Architecturally Different (can't directly reuse)
1. **REST proxy vs native node** — They use HTTP+JSON through a Node.js proxy. We use WebSocket+WebRTC via esp-openclaw-node. Our approach is more integrated but harder to build.
2. **Arduino/PlatformIO vs ESP-IDF** — Different build systems entirely. Their code uses M5Unified, ArduinoJson, ESP8266Audio — none of which we use.
3. **SimpleVox wake word vs ESP-SR** — Custom MFCC-based wake word registration. Interesting but we're using Espressif's WakeNet which is more robust and doesn't require recording samples.

### Not Useful
- The LLM/TTS/STT abstraction layers (ChatGPT, Gemini, WebVoiceVox, etc.) — we don't need these, OpenClaw handles all of that
- The WebAPI, FTP server, SD updater, photo frame, pomodoro modules — not relevant to our use case
- The `m5avatar` face system — uses M5Unified's avatar which is different from both xiaozhi's LvglDisplay and room-node's built-in face

## Key Insight

Their approach proves that connecting Stack-chan to OpenClaw is viable and has been done. But they took the **easy path** — HTTP proxy through a Node.js middleman. We're taking the **native path** — direct WebSocket + WebRTC via esp-openclaw-node. 

Our approach is harder to build but:
- No proxy server to maintain
- Lower latency (direct WebSocket, no HTTP round-trip)
- WebRTC audio (better quality than their HTTP-based TTS delivery)
- Native OpenClaw node features (face state, commands, provisioning)
- No Node.js dependency on the host machine

Their emoji-stripping code and partition table layout are worth borrowing. The rest is a different architecture that validates the concept but isn't directly reusable.