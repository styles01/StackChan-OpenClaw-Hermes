# kkdev92/stackchan-atoms3r — Repo Analysis

**Date:** 2026-08-17
**Repo:** https://github.com/kkdev92/stackchan-atoms3r
**License:** MIT
**Status:** 0.1.0 (best-effort maintenance)

## Verdict: DIFFERENT HARDWARE, EXCELLENT ARCHITECTURE PATTERNS

## What They Built

A clean, well-architected Stack-chan firmware for **M5Stack AtomS3R** (not CoreS3) with the **Atomic Voice Base** accessory. The codebase is notably well-structured with strict layering, host-testable core logic, and excellent documentation.

### Hardware (DIFFERENT from ours)
- **Board:** M5Stack AtomS3R (not CoreS3)
  - 8MB flash, 8MB octal PSRAM
  - 128×128 integrated display (vs our 320×240 ILI9342)
- **Audio:** M5Stack Atomic Voice Base
  - ES8311 codec (vs our AW88298)
  - I2C at GPIO 39/38, I2S at GPIO 5/6/7/8
  - No MCLK line (uses BCLK as clock source)
  - PI4IOE I/O expander at 0x43 for speaker amp switching
- **No servos, no camera, no touch** — minimal desktop robot

### Build System (SAME as ours)
- **ESP-IDF 6.0.1** via PlatformIO
- C++17
- CMake-based with EXTRA_COMPONENT_DIRS
- This is the closest build system to our project of all repos analyzed

## Key Architectural Patterns Worth Studying

### 1. Core/Platform Separation (EXCELLENT)
```
src/core/stackchan_domain/    — decisions, protocol, parsing (NO ESP-IDF deps)
src/core/stackchan_board/      — board profile, pin claims
src/core/stackchan_app/        — conversation, request routing, commands
src/core/stackchan_ports/      — abstract interfaces (AudioSource, AudioSink, Face)
src/platform/stackchan_audio/  — ES8311 implementation
src/platform/stackchan_display/ — M5GFX face implementation
src/platform/stackchan_conversation/ — gateway client, conversation task
src/platform/stackchan_deviceapi/ — HTTP server
src/main/                      — composition root (wiring only)
```

**Why this matters:** `src/core` builds on the HOST (no ESP-IDF) so all protocol/parsing/state logic is unit-testable without hardware. Platform code is isolated. This is the cleanest layering I've seen in any Stack-chan firmware repo.

### 2. Port Abstractions (REUSABLE PATTERN)
```cpp
// AudioSource — mic capture abstraction
class AudioSource {
  bool start_capture(uint32_t sample_rate);
  void stop_capture();
  size_t read(Sample* out, size_t count, Deadline deadline, uint32_t now_ms);
};

// AudioSink — speaker playback abstraction
class AudioSink {
  bool start_playback(uint32_t sample_rate);
  void stop_playback();
  size_t write(const Sample* samples, size_t count, Deadline deadline, uint32_t now_ms);
  void set_volume(uint8_t percent);
};

// Face — display abstraction
class Face {
  void show(Expression expression);
  void set_talking(bool talking);
  void show_message(string_view text);
  void show_pairing(string_view ssid, string_view password, string_view url);
};
```

**Why this matters:** These abstractions are exactly what we need for the OpenClaw + Hermes dual-target architecture. The firmware doesn't know WHAT it's talking to — it just knows how to capture audio, play audio, and show a face. The connection layer (WebSocket to OpenClaw or HTTP to Hermes) is a platform implementation detail.

### 3. Deadline-Based Audio I/O (SMART)
Every audio read/write operation takes a `Deadline` parameter. No unbounded waits. Cancellation is checked between bounded operations via an atomic `CancellationSource`. This prevents hangs when the gateway is slow or unresponsive.

**Why this matters for us:** WebRTC audio and WebSocket commands both have latency variability. Having deadline-based I/O built into the audio abstraction prevents the firmware from hanging if the gateway stops responding.

### 4. Half-Duplex Direction Lock (RELEVANT)
The Voice Base is half-duplex (can't record and play simultaneously). They use a recursive mutex (`DirectionLock`) to serialize direction changes. Recording and playback can't overlap.

**Why this matters:** Our CoreS3 with TDM I2S + AEC is designed for full-duplex, but the direction lock pattern is still useful for managing the Talk state machine transitions (listening → thinking → speaking).

### 5. Speech Segmenter (BORROWABLE)
A `SpeechSegmenter` class that:
- Splits streaming text into sentences at `.`, `!`, `?`, and CJK terminators
- Handles UTF-8 multi-byte characters correctly (won't split mid-character)
- Supports expression markers `[happy]text[/happy]` to change face during speech
- Has a fixed-size FIFO buffer (PSRAM-backed in implementation)
- Properly handles the `3.14` vs sentence-end `.` ambiguity

**Why this matters:** If we stream TTS text from the gateway, we need the same sentence segmentation to drive face expressions during speech. This is a well-tested implementation we can adapt.

### 6. Protocol Envelope (REUSABLE)
JSON envelope for device commands:
```json
{"v":1,"kind":"command","id":"req-1","name":"device.describe","payload":{}}
```
Response:
```json
{"v":1,"kind":"result","id":"req-1","ok":true,"result":{...}}
```
Events:
```json
{"v":1,"kind":"event","name":"reply.audio","payload":{"pcm":"...","last":true}}
```

Error codes: none, bad_request, unknown_command, invalid_argument, not_found, unsupported, estop_engaged, busy, unavailable, timeout, cancelled, internal. Each marked retryable or not.

**Why this matters:** This is a clean, versioned protocol envelope. Our OpenClaw WebSocket protocol is different (uses the OpenClaw gateway protocol), but the pattern of versioned envelopes with explicit error codes and retry semantics is worth studying.

### 7. Gateway Client (HTTP, not WebSocket)
Their gateway connection is HTTP POST with SSE (Server-Sent Events) response streaming:
- POST recorded audio (base64-encoded WAV)
- Receive SSE stream of `reply.audio` events (base64 PCM) + `conversation.text` + `conversation.finished`
- 10s first-event deadline, 30s idle deadline
- Gateway URL stored in NVS (persistent config)

**Why this differs from us:** We use WebSocket + WebRTC via esp-openclaw-node. They use HTTP + SSE. But the conversation lifecycle (start → record → send → stream response → play → finish) is the same pattern.

### 8. Partition Table (BORROWABLE)
```
nvs,        data, nvs,     0x9000,   0x6000,
phy_init,   data, phy,     0xF000,   0x1000,
factory,    app,  factory, 0x10000,  0x600000,
storage,    data, littlefs,0x610000, 0x1B0000,
coredump,   data, coredump,0x7C0000, 0x40000,
```

They have a **coredump partition** (256KB at 0x7C0000) — same pattern as PlaiPin. We already have this in our TODO.

### 9. Command Registry (GOOD PATTERN)
Commands registered once with name, parameters, availability, and handler. `device.describe` generates its capability list from the same registry. Hardware-dependent commands are discoverable even when unavailable (marked `available: false` with a reason).

### 10. Face System (M5GFX-based, not GIF)
Procedural face drawn with M5GFX canvas primitives — circles, triangles, rectangles. Six expressions: neutral, happy, sad, doubt, sleepy, angry. Lip sync via `set_talking(bool)` that animates mouth height/width. Breath animation (sine wave, 3.3s cycle). Eye blink (random interval).

**Why this matters:** This is a procedural face that doesn't need GIF assets — lighter footprint than stackchan-mcp's AnimatedGIF approach. Our room-node built-in face is similar (procedural LVGL), so the pattern matches.

## What's NOT Useful

1. **ES8311 codec registers** — different chip (we have AW88298)
2. **AtomS3R pin assignments** — different board
3. **128×128 display geometry** — our ILI9342 is 320×240
4. **HTTP API + SSE** — we use WebSocket + WebRTC
5. **No servos, no camera, no touch** — doesn't help with Phase 2 robot layer

## Comparison: All Repos Analyzed

| Aspect | PlaiPin | stackchan-mcp | stackchan-atoms3r | Our Approach |
|--------|---------|---------------|-------------------|-------------|
| Build | Arduino/PlatformIO | Arduino/PlatformIO | ESP-IDF/PlatformIO | ESP-IDF |
| Hardware | CoreS3 | CoreS3 | AtomS3R | CoreS3 |
| Architecture | REST proxy → WS | MCP → HTTP REST | HTTP + SSE | WebSocket + WebRTC |
| Intelligence | OpenClaw | AI Agent (MCP) | Custom gateway | OpenClaw + Hermes |
| Audio | TTS via HTTP | PCM TCP/UDP | 16kHz WAV + SSE | WebRTC Opus |
| Wake word | SimpleVox | RMS VAD | Button-only | WakeNet |
| Face | m5avatar | AnimatedGIF | M5GFX procedural | Room-node LVGL |
| Servo | StackchanSERVO | M5StackChan.Motion | None | SCSCL (Phase 2) |
| Camera | esp32-camera | esp_camera | None | esp_video (Phase 2) |
| Code quality | Prototype | Good | Excellent | TBD |
| Tests | None | None | Host tests + QEMU | None yet |
| Coredump partition | ✅ | ❌ | ✅ | ✅ (planned) |
| Dual-OTA | ❌ | ❌ | ❌ | ✅ |

## Key Takeaway

stackchan-atoms3r is the **best software architecture reference** we've found, even though the hardware is different. The core/platform separation, port abstractions, deadline-based I/O, and host-testable design principles are directly applicable to our project. If we adopt their layering pattern, our firmware will be:

1. **Testable** — core logic runs on the host without ESP-IDF
2. **Portable** — swapping OpenClaw for Hermes is a platform-layer change, not a core change
3. **Maintainable** — clear boundaries, no hidden dependencies
4. **Robust** — deadline-based I/O prevents hangs, cancellation is atomic

This validates our OpenClaw + Hermes dual-target idea: if we define clean port interfaces for the connection layer (like they do for audio/face), the same core firmware can talk to either backend by swapping the platform implementation.