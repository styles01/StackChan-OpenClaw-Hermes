# Swarm Alpha — Architecture B Feasibility Analysis

**Date:** 2026-08-17
**Author:** Research Agent ALPHA
**Question:** Can we start from the Stack-chan Arduino firmware and ADD the OpenClaw connection layer (esp-openclaw-node + room-node + talk + webrtc) on top?

---

## ⚡ EXECUTIVE VERDICT

**Architecture B is FEASIBLE — and it is ALREADY BEING BUILT in this workspace as the `agent-node` project.**

The premise "start from Stack-chan firmware and add OpenClaw" is being executed as a **native ESP-IDF project** (`<repo-root>/stackchan-node/agent-node/`), NOT as a PlatformIO/Arduino project. This is the correct and only realistic path, because the esp-openclaw-room-node contract is **hard-wired to the ESP-IDF native audio/display stack** (esp_capture + esp_codec_dev + esp-sr + LVGL) and cannot be satisfied by M5Unified/M5GFX without a full rewrite of the room-node's audio pipeline.

**The critical finding:** The room-node's audio port does NOT just need "any audio handles" — it feeds `esp_codec_dev_handle_t` handles into a pinned `esp_capture` AFE (Audio Front End) source (`room_aec_src.c`) that runs esp-sr WakeNet + AEC + VAD. This is a deep, non-negotiable dependency on the ESP-IDF native audio stack. M5Unified's `M5.Speaker`/`M5.Mic` cannot be wrapped as these handles without reimplementing the entire AFE pipeline.

**Bottom line:** Architecture B works, but "start from the Arduino firmware" must be reinterpreted as "**port the Stack-chan robot features (servo, camera, face, LED) into a native ESP-IDF project that already has the OpenClaw connection layer**" — which is exactly what `agent-node` is doing. The Arduino firmware is a **reference for the robot features**, not a buildable base.

---

## 1. Can esp-openclaw-node components be used in a PlatformIO/Arduino project?

### Short answer: Technically possible in theory, but NOT the right path.

**What the components actually are:**
- `esp-openclaw-node`, `esp-openclaw-room-node`, `esp-openclaw-talk` are **pure ESP-IDF components** (CMake `idf_component_register()`), not Arduino libraries.
  - `components/esp-openclaw-node/CMakeLists.txt` — REQUIRES `espressif__cjson`, `esp_websocket_client`, `libsodium`, `mbedtls`, `nvs_flash`
  - `components/esp-openclaw-room-node/CMakeLists.txt` — REQUIRES `esp_webrtc`, `esp_peer`, `espressif__esp-sr`, `espressif__esp_audio_codec`, `espressif__esp_capture`, `espressif__esp_codec_dev`, `lvgl__lvgl`, `av_render`, `media_lib_utils`, `esp_lcd`, `esp_capture`, etc.
  - `components/esp-openclaw-talk/CMakeLists.txt` — REQUIRES `esp_webrtc`, `esp_peer`, `json`
- These are **managed components** pulled from the ESP Component Registry (esp-sr, esp_capture, esp_codec_dev, lvgl, esp_websocket_client, libsodium, etc.), resolved via `idf_component.yml` + the IDF Component Manager.

**PlatformIO mixing reality:**
- PlatformIO's `framework = arduino` and `framework = espidf` are **mutually exclusive** per environment. You cannot set both on one env.
- PlatformIO does support "Arduino as an ESP-IDF component" (the reverse direction — Arduino inside an IDF project), documented at `docs.espressif.com/projects/arduino-esp32/.../esp-idf_component.html`. This is the **only** supported way to mix them, and it means the project is **ESP-IDF-first** with Arduino as a component — not Arduino-first.
- The esp-openclaw components are **not** published as Arduino libraries and have no Arduino wrapper. There is no `esp-openclaw-node` Arduino library on the Arduino registry or PlatformIO lib registry.
- esp-openclaw-node **is** published on the ESP Component Registry (`espressif/esp-openclaw-node` v1.0.0) — confirming it is an ESP-IDF-managed-component ecosystem, not Arduino.

**Conclusion for Q1:** You **cannot** cleanly add these components to the existing `stackchan-mcp` PlatformIO Arduino project (`firmware/platformio.ini`, `framework = arduino`). The realistic path is to **invert the project**: make it ESP-IDF-native and pull the Stack-chan robot features in as C/C++ sources. This is what `agent-node` does.

---

## 2. Can we bridge M5GFX → LVGL and M5.Speaker/M5.Mic → esp_codec_dev?

### Display (M5GFX → LVGL): YES, bridgeable — but the room-node doesn't need M5GFX.

- The room-node display port (`esp_openclaw_room_display_port_t` in `esp_openclaw_room_node.h`) requires an `lv_display_t *` from `start()`, plus `lock/unlock/set_brightness`. It is **LVGL-native**.
- M5GFX **does** have working LVGL flush adapters in the wild (e.g. `go-go-golems/esp32-s3-m5/0025-cardputer-lvgl-demo/main/lvgl_port_m5gfx.cpp` — a working M5GFX→LVGL flush bridge). So bridging M5GFX to LVGL is proven possible.
- **However:** the `agent-node` project already implements the CoreS3 display **directly** with `esp_lcd` + LVGL (`main/board_cores3/cores3_display.c` — SPI ILI9342 via `esp_lcd_panel_ili9341` + LVGL 9.4.0), **bypassing M5GFX entirely**. This is cleaner and avoids the M5GFX/LVGL double-buffer and DMA complications.
- **Recommendation:** Do NOT bridge M5GFX. Use the native `esp_lcd` + LVGL path already in `agent-node`. The Stack-chan face GIFs (AnimatedGIF) can be re-rendered into LVGL, or the room-node's built-in procedural LVGL face (`room_face.c`) can be used.

### Audio (M5.Speaker/M5.Mic → esp_codec_dev): NO — this is the hard blocker.

- The room-node audio port (`esp_openclaw_room_audio_port_t`) requires `open()` to return `esp_codec_dev_handle_t` handles for `record` and `playback`.
- These handles are consumed by `room_media.c` (line ~300-360) and fed into `room_capture_new_audio_aec_src()` → `room_aec_src.c`, which is a **pinned copy of esp_capture's AFE audio source** that:
  - Runs esp-sr WakeNet (`esp_srmodel_init`, `esp_afe_sr_iface`, `esp_vadn_iface`) — `room_aec_src.c:129-143`
  - Runs AEC + NLP + VAD (`AFE_TYPE_SR` / `AFE_TYPE_VC`) — `room_aec_src.c:135`
  - Reads via `esp_codec_dev_read()` — `room_aec_src.c:344, 419`
  - Opens with `esp_codec_dev_open()` + `esp_codec_dev_sample_info_t` — `room_aec_src.c:580-587`
- **M5Unified's `M5.Speaker`/`M5.Mic` are NOT esp_codec_dev handles and cannot be wrapped as such.** They use M5Unified's own I2S abstraction (legacy I2S driver), which conflicts with the new IDF I2S driver (`i2s_std`/`i2s_chan`) that esp_codec_dev uses. This is a known conflict (M5Stack community threads, esp-adf issue #1047, IDF I2S regressions).
- **The correct path (already in `agent-node`):** `main/board_cores3/cores3_audio.c` implements the audio port natively — AW88298 speaker + ES7210 mic via `esp_codec_dev` + STD I2S, adapted from the Waveshare room-node reference. This is the **only** way to satisfy the room-node audio contract.

**Conclusion for Q2:** Display bridging is possible but unnecessary (use native esp_lcd+LVGL). Audio bridging is **not feasible** — M5Unified's audio stack must be **replaced** by the esp_codec_dev pipeline. This is already done in `agent-node`.

---

## 3. Can esp_webrtc coexist with M5Unified's audio stack?

### NO — M5Unified's audio must be replaced.

- `esp-openclaw-talk` (README.md) adapts OpenClaw's Talk API to `esp_webrtc` signaling. The voice pipeline is **esp_webrtc + esp_capture + esp-sr (WakeNet) + AEC + Opus**.
- The room-node's audio source (`room_aec_src.c`) is the **single** capture path — it owns the AFE, WakeNet, AEC, and VAD. There is no "second audio path" for M5Unified to coexist with.
- The waveshare README explicitly notes: "the firmware never creates the second esp-sr WakeNet instance that aborts inside the closed library on this hardware" — meaning esp-sr is **single-instance** and the room-node owns it exclusively.
- M5Unified's `M5.Speaker`/`M5.Mic` would fight esp_codec_dev for the same I2S port and the same codec chips (AW88298/ES7210). They cannot both own the hardware.
- **Conclusion:** M5Unified's audio stack must be **completely replaced** by the esp_codec_dev pipeline. The Stack-chan firmware's raw-PCM-over-HTTP audio (`mic_service.cpp`, `pcm_stream_service.cpp`, `playback_service.cpp`) is **not used** in the OpenClaw path — WebRTC Talk replaces it. The only reusable audio concept is the **audio-gate / mic-resume-after-playback** pattern (to prevent feedback), which is a logic pattern, not a driver.

---

## 4. Binary size — will it fit in 16MB flash?

### YES — proven by the waveshare reference and the in-progress agent-node build.

**Reference: waveshare room-node** (`examples/waveshare-esp32-s3-touch-amoled-2.06-room-node/`):
- `sdkconfig.defaults`: `CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y`, octal PSRAM, 240MHz
- `partitions.csv`: `factory` app **8M** + `model` (spiffs) **2M** — within 16MB
- This is the **full** room-node stack: WebRTC Talk + WakeNet9 HiESP + AEC + LVGL animated face + canvas + dual node/operator sessions. It builds a complete ESP32-S3 image.

**In-progress agent-node build** (`<repo-root>/stackchan-node/agent-node/`):
- `sdkconfig.defaults`: 16MB flash, octal PSRAM, `SPIRAM_TRY_ALLOCATE_WIFI_LWIP`, `SPIRAM_MALLOC_ALWAYSINTERNAL=256`
- `partitions.csv`: `ota_0` **6M** + `ota_1` **6M** + `model` (spiffs) **2M** — OTA-capable, within 16MB
- `build/srmodels/srmodels.bin` = **291,142 bytes (~284 KB)** — this is the WakeNet9 HiESP model, already packaged.
- The build was in progress (bootloader + partition table + srmodels built; main app .elf not yet produced).

**Size estimate:**
- The full room-node stack (WebRTC + esp-sr + LVGL + canvas + node) fits comfortably in **6-8MB** of app flash (waveshare uses 8M factory; agent-node uses 6M OTA slots).
- esp-sr models need a **2M spiffs partition** (already configured in both).
- **Stack-chan robot features add minimal flash** — servo (SCSCL UART), camera (esp_capture/esp_video), LED (WS2812), face (LVGL or GIF arrays). These are small compared to the WebRTC/esp-sr/LVGL stack already present.
- **RAM is the real constraint, not flash.** The waveshare README documents extensive internal-RAM pressure: task stacks, DMA buffers, and the `SPIRAM_MALLOC_RESERVE_INTERNAL=262144` (256KB internal reserve) and `SPIRAM_MALLOC_ALWAYSINTERNAL=256` settings. CoreS3 has 8MB octal PSRAM, which is sufficient, but internal RAM (512KB) is tight. The agent-node sdkconfig already mirrors these settings.

**Conclusion for Q4:** **YES, fits in 16MB.** Realistic app size ~6-8MB + 2MB model partition. The constraint is internal RAM, not flash — and the agent-node config already handles this.

---

## 5. The decisive finding: `agent-node` IS Architecture B

`<repo-root>/stackchan-node/agent-node/` is a **native ESP-IDF project** that already implements Architecture B:

- **CMakeLists.txt** — `EXTRA_COMPONENT_DIRS` points at `../repos/esp-openclaw-node` for all 4 esp-openclaw components + all 6 esp-webrtc-solution components + esp_websocket_client.
- **main/idf_component.yml** — declares `esp_codec_dev ^1.5.0`, `esp-sr ^2.4.7`, `esp_lcd_ili9341`, `esp_new_jpeg`, `lvgl ^9.4.0`, plus override_paths for all esp-openclaw/webrtc components.
- **main/board_cores3/** — the CoreS3 board port:
  - `cores3_audio.c` — AW88298 + ES7210 via esp_codec_dev + STD I2S (adapted from Waveshare reference + StackChan `cores3_audio_codec.cc`)
  - `cores3_display.c` — ILI9342 via esp_lcd + LVGL 9.4.0
  - `cores3_camera.c` — GC0308 camera
  - `cores3_servo.c` — SCSCL bus servos
  - `cores3_led.c` — WS2812 LED
  - `cores3_touch.c` — FT6336 touch
- **main/main.c** — implements the room-node services port (`prepare_runtime`/`prepare_network`/`register_commands`) with Phase 2 stubs for `agent-a.look`, `agent-a.emote`, `agent-a.led`, `agent-a.gesture`.
- **main/robot/** — empty directory reserved for robot feature code (Phase 2).
- **managed_components/** — all dependencies already downloaded: `espressif__esp-sr`, `espressif__esp_capture`, `espressif__esp_codec_dev`, `espressif__esp_audio_codec`, `lvgl__lvgl`, `espressif__esp_libsrtp`, etc.

**This is the Architecture B implementation.** The Stack-chan Arduino firmware (`stackchan-mcp`) is the **feature reference** (servo gestures, camera pin config, face GIFs, audio-gate pattern) — its code is being ported into the native ESP-IDF project, not compiled alongside it.

---

## 6. What the Stack-chan Arduino firmware contributes (reusable)

From `stackchan-mcp` repo analysis + `firmware/src/main.cpp`:

| Feature | Arduino source | Reusable in agent-node? |
|---------|---------------|------------------------|
| Servo gestures (nod/shake) | `servo_service.cpp` | YES — logic pattern, port to `cores3_servo.c` |
| Servo angle ranges (yaw ±128°, pitch 5-85°) | `servo_service.cpp` | YES — confirmed ranges |
| GC0308 camera pin config | `camera_service.cpp` | YES — but **verify pin mapping** (conflicts with robot-bridge repo) |
| Camera I2C bus sharing (`M5.In_I2C.release()`) | `camera_service.cpp` | YES — critical gotcha, already noted in `cores3_audio.c` |
| GC0308 RGB565→JPEG (no HW JPEG) | `camera_service.cpp` | YES — `frame2jpg()` pattern |
| ILI9342 BGR color correction | `face_service.cpp` | YES — R/B swap in RGB565 |
| Face GIF system (AnimatedGIF) | `face_service.cpp` | MAYBE — room-node has built-in procedural LVGL face; GIFs optional |
| Audio-gate / mic-resume-after-playback | `audio_gate.h` | YES — logic pattern for feedback prevention |
| Mic VAD (RMS trigger) | `mic_service.cpp` | PARTIAL — room-node uses esp-sr VAD instead |
| HTTP server / PCM streaming | `http_server.*`, `pcm_stream_service.*` | **NO** — replaced by WebRTC Talk + node commands |

**Not reusable:** M5Unified/M5GFX/StackChan-BSP drivers, HTTP REST API, PCM-over-HTTP audio, Python MCP server.

---

## 7. Risks / UNKNOWNs

1. **UNKNOWN — needs hardware testing:** GC0308 camera pin mapping. `stackchan-mcp` and `robot-bridge` repos disagree on the pin config. Must verify on the physical CoreS3 board revision before camera bring-up.
2. **UNKNOWN — needs hardware testing:** Microphone geometry / AEC performance on CoreS3. The waveshare README explicitly lists "Microphone geometry, speaker gain, false accepts, acoustic echo performance, thermals" as requiring physical-board validation. CoreS3's AW88298/ES7210 layout differs from waveshare's ES8311/ES7210.
3. **UNKNOWN — needs hardware testing:** Whether the STD I2S stereo path (MIC1+MIC3) gives acceptable AEC reference on CoreS3. The `cores3_audio.c` comment notes the TDM→STD switch was made because IDF I2S doesn't support mixed modes; this needs board validation.
4. **Internal RAM pressure** — the room-node stack is RAM-hungry. Adding camera + servo + LED on top needs careful task-stack budgeting. The agent-node sdkconfig already reserves 256KB internal, but the full robot feature set may need tuning.
5. **esp-sr is single-instance** — the room-node owns WakeNet exclusively. Any custom wake-word handling must go through the room-node's AFE, not a second esp-sr instance.
6. **esp_capture 1.0.2 doesn't expose AFE wake events** — the room-node carries a pinned copy of the AEC source (`room_aec_src.c`) to work around this. This is a maintenance burden but already handled.

---

## 8. Recommendation

**Proceed with Architecture B as implemented in `agent-node`.** Do NOT attempt to bolt esp-openclaw components onto the PlatformIO/Arduino project. Instead:

1. **Treat `agent-node` as the Architecture B codebase** (it already is).
2. **Port Stack-chan robot features from `stackchan-mcp` firmware** into `agent-node/main/robot/` and `main/board_cores3/`:
   - Servo gestures (nod/shake) → `cores3_servo.c`
   - Camera bring-up → `cores3_camera.c` (verify GC0308 pins first)
   - LED state machine → `cores3_led.c`
   - Face (LVGL procedural or GIF) → display layer
   - Audio-gate pattern → audio layer
3. **Register robot commands** in `cores3_register_commands()` (Phase 2 stubs already in `main.c`).
4. **Complete the agent-node build** (it was in progress — main app .elf not yet produced) and validate on hardware.

**The "start from Stack-chan firmware" framing is best understood as "start from the Stack-chan feature set, ported into the native ESP-IDF OpenClaw project"** — which is exactly what `agent-node` is doing. The Arduino firmware is the feature reference, not the buildable base.

---

## Appendix: Key file references

- `stackchan-mcp/firmware/platformio.ini` — Arduino/PlatformIO, `framework = arduino`, M5Unified 0.2.15, StackChan-BSP 1.1.0, 16MB flash
- `stackchan-mcp/firmware/src/main.cpp` — Arduino setup/loop, M5StackChan + services
- `esp-openclaw-node/components/esp-openclaw-room-node/include/esp_openclaw_room_node.h` — display/audio/services/storage port contracts
- `esp-openclaw-node/components/esp-openclaw-room-node/room_board.h` — board bind contract
- `esp-openclaw-node/components/esp-openclaw-room-node/room_aec_src.c` — pinned esp_capture AFE source (WakeNet/AEC/VAD)
- `esp-openclaw-node/components/esp-openclaw-room-node/room_media.c` — audio port consumption, esp_capture open
- `esp-openclaw-node/components/esp-openclaw-room-node/CMakeLists.txt` — full REQUIRES list (esp_webrtc, esp-sr, esp_capture, esp_codec_dev, lvgl, etc.)
- `esp-openclaw-node/components/esp-openclaw-talk/README.md` — Talk→esp_webrtc signaling
- `esp-openclaw-node/examples/waveshare-esp32-s3-touch-amoled-2.06-room-node/main/main.c` — reference board port (audio via esp_codec_dev, display via LVGL)
- `esp-openclaw-node/examples/waveshare-esp32-s3-touch-amoled-2.06-room-node/sdkconfig.defaults` — 16MB flash, PSRAM, internal-RAM tuning
- `esp-openclaw-node/examples/waveshare-esp32-s3-touch-amoled-2.06-room-node/partitions.csv` — 8M factory + 2M model
- `agent-node/CMakeLists.txt` — EXTRA_COMPONENT_DIRS for all esp-openclaw/webrtc components
- `agent-node/main/idf_component.yml` — managed deps (esp-sr, esp_codec_dev, lvgl 9.4.0, etc.)
- `agent-node/main/board_cores3/cores3_audio.c` — CoreS3 AW88298/ES7210 via esp_codec_dev (STD I2S)
- `agent-node/main/board_cores3/cores3_display.c` — CoreS3 ILI9342 via esp_lcd + LVGL
- `agent-node/main/main.c` — room-node services port with Phase 2 stubs
- `agent-node/partitions.csv` — 6M ota_0 + 6M ota_1 + 2M model
- `agent-node/build/srmodels/srmodels.bin` — 291KB WakeNet9 HiESP model (already packaged)
