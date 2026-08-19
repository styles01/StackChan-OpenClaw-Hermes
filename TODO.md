# TODO — Stack-chan OpenClaw Audio Client

## ⚠️ HARD RULE: Backup Stock Firmware Before Flashing
We have bricked multiple devices before. BEFORE flashing any firmware to the Stack-chan:
1. Plug in via USB, detect serial port (`ls /dev/cu.usb*`)
2. `esptool read_flash 0 0x1000000 backup_stackchan_stock.bin` (full 16MB dump)
3. Save partition table: `esptool read_flash 0x8000 0x1000 backup_partition_table.bin`
4. Verify backup file is exactly 16MB
5. Store backups on SSD: `/Volumes/1TBSSDClawd/stackchan-node/backups/`
6. ONLY then flash our firmware

If anything goes wrong: `esptool write_flash 0x0 backup_stackchan_stock.bin` restores brick-for-brick.

## GitHub / Repo
- [x] Create project structure and analysis
- [x] Swarm 3 review complete (4 reports + synthesis)
- [x] BRIEF.md rewritten (swap-backends v1, thin client v1.1)
- [x] BUILD_PLAN.md rewritten with codebase specifics
- [x] TODO.md updated (this file)
- [ ] Rename repo to `stackchan-openclaw` (current name oversells Hermes)
- [ ] Write README (community-first framing: "dumb audio terminal, no API keys")
- [ ] Commit and push updated docs

## Phase 1: Fork & Flash Stock (1 day) — ✅ DONE
- [x] Plug in Stack-chan, detect serial port (`/dev/cu.usbmodem211301`)
- [x] Full 16MB flash backup of stock firmware → `backups/cores3_factory_uiflow2_v2.5.1.bin`
- [x] Save partition table backup
- [x] Store on SSD: `/Volumes/1TBSSDClawd/stackchan-node/backups/`
- [x] Official StackChan v1.4.3 firmware cloned and copied to `firmware/` (231 files)

## Phase 2: Three-Repo Merge — ✅ DONE
- [x] Circlemouth patch merged (1188 lines, 11 files) — canonical xiaozhi-esp32 patch
- [x] Plaipin config structs ported to ESP-IDF/NVS
- [x] OTA auto-update unconditionally disabled (hard return)
- [x] ai-server (TypeScript WS bridge) — 72/72 tests pass
- [x] Build succeeds: `stack-chan.bin` 3.7MB, 27% free

## Phase 3: Web Config Server — ✅ DONE
- [x] GET /config — returns JSON config
- [x] POST /config — saves config to NVS
- [x] GET / — serves HTML config editor (mobile-friendly)
- [x] Web config server starts on boot (after WiFi connects)
- [x] httpd stack size fixed (16384)
- [x] POST handler crash fixed (calloc + stack bump)
- [x] mDNS confirmed working (`CONFIG_LWIP_DNS_SUPPORT_MDNS_QUERIES=y`)
- [x] Config saved with `clawdio-mini.local` hostname (bare, no http://)

## Phase 4: WebSocket URL Writing — 🔄 IN PROGRESS
- [x] POST /config writes `ws://<host>:8765/ws` into `"websocket"` NVS namespace
- [x] Auto-builds URL from config host (port 8765, path /ws)
- [x] Custom `websocket_url` field overrides auto-built URL
- [ ] Rebuild with port 8765 fix (was 18789, now corrected)
- [ ] Flash to device
- [ ] Verify device connects to `ws://clawdio-mini.local:8765/ws`
- [ ] End-to-end test: voice in → STT → LLM → TTS → voice out

## Phase 5: Per-Device Backend Binding — PENDING
- [ ] ai-server reads `Device-Id` from WS handshake
- [ ] Looks up `devices.json` for per-device backend+agent routing
- [ ] Test with multiple devices

## Phase 6: Code Review + Cleanup — PENDING
- [ ] Code review on actual diff (Step 6)
- [ ] Fix review issues (Step 7)
- [ ] Update README, BUILD_PLAN (mark superseded), TODO, CHANGELOG, MEMORY (Step 8)
- [ ] Rename repo to `stackchan-openclaw`
- [ ] Commit and push
- [ ] Keep plaipin cloned as reference (concepts only, not code)
- [ ] Flash plaipin firmware unmodified to Stack-chan — verify body works:
  - [ ] Face/avatar displays and animates
  - [ ] Servos move (yaw + pitch)
  - [ ] Touch screen responds
  - [ ] Button A triggers conversation flow
  - [ ] Speaker plays audio
  - [ ] Mic records audio
  - [ ] Wake word works (if cores3 build with ENABLE_WAKEWORD)
- [ ] **MILESTONE: Stack-chan boots, body works, plaipin firmware verified**

## Phase 2: Audio Pipeline Server on Mini (1-2 days)
**Mini environment verified: faster-whisper ✓, kokoro ✓, fastapi ✓, uvicorn ✓**
- [ ] Create `server/audio_pipeline.py` (FastAPI, port 18791)
- [ ] Port Larry V2's `transcribe()` → `POST /stt` endpoint (faster-whisper, returns text + confidence)
- [ ] Port Larry V2's `generate_speech()` → `POST /tts` endpoint (Kokoro, bm_george, 24kHz)
- [ ] Write `parse_body_commands()` — extend Larry's `parse_effects()` regex from `[tag]` to `[key:value]`
- [ ] `/tts` strips markers from text → TTS → returns WAV + `X-Body-Commands` header JSON
- [ ] `GET /health` endpoint (for systemd watchdog)
- [ ] Port 18791 (18789=gateway, 18790=REST proxy, 18791=audio)
- [ ] Test: `curl -F audio=test.wav http://localhost:18791/stt` → JSON text back
- [ ] Test: `curl -d "hello [expression:happy]" http://localhost:18791/tts` → WAV + header back
- [ ] Test: `curl http://localhost:18791/health` → 200 OK
- [ ] systemd service: `audio-pipeline.service` (auto-start, auto-restart, watchdog)
- [ ] **MILESTONE: Server works end-to-end with curl — no ESP32 needed**

## Phase 3: Retarget Backends (2-3 days)
**Swap at the abstract interface — keep plaipin's pipeline intact**

### Config changes (StackchanExConfig.h)
- [ ] Add `#define STT_TYPE_MINI_WHISPER 4`
- [ ] Add `#define TTS_TYPE_MINI_KOKORO 5`
- [ ] Add `mini_audio_s` struct (host + port) to ExConfig

### MiniSTT (stt/MiniSTT.cpp + .h)
- [ ] Implement `speech_to_text()`:
  - [ ] Record audio via M5.Mic (reuse plaipin's AudioWhisper.cpp — 16kHz mono, PSRAM buffer)
  - [ ] HTTP POST multipart WAV to `http://<host>:18791/stt` (use WiFiClient, HTTP not HTTPS)
  - [ ] Parse JSON response `{text, confidence}` (small response — `getString()` OK here)
  - [ ] Return text string
  - [ ] 10s timeout (same as plaipin's Whisper STT)
- [ ] Pattern: plaipin's `Whisper.cpp` does exactly this but sends to Groq — adapt for LAN HTTP

### MiniTTS (tts/MiniTTS.cpp + .h)
- [ ] Implement `stream(String text)`:
  - [ ] HTTP POST text to `http://<host>:18791/tts`
  - [ ] Receive WAV via `http.getStream()` into PSRAM buffer (`heap_caps_malloc(..., MALLOC_CAP_SPIRAM)`)
  - [ ] Play WAV through M5.Speaker
  - [ ] Parse `X-Body-Commands` header → execute body commands
  - [ ] **NEVER use `getString()` for audio** — use `getStream()` + PSRAM
- [ ] Implement `getLevel()` for lip sync (return current audio sample amplitude)
- [ ] Pattern: plaipin's `OpenAITTS.cpp` streams MP3 via buffer + `playMP3()` — adapt for HTTP WAV

### BodyCommandParser (BodyCommandParser.cpp + .h)
- [ ] Parse JSON body commands from TTS response header
- [ ] `expression` → `avatar.setExpression()` (happy, sad, angry, sleepy, surprised, doubting, etc.)
- [ ] `gesture` → servo gesture sequence (nod, shake, look_around)
- [ ] `led` → LED state (off, green, blue, rainbow)
- [ ] `servo` → `servo->moveToGaze(yaw, pitch)` with params

### Robot.cpp changes (~8 LOC total)
- [ ] Add `#include "stt/MiniSTT.h"` and `#include "tts/MiniTTS.h"`
- [ ] Add to `initSTT()`: `case STT_TYPE_MINI_WHISPER: stt = new MiniSTT(stt_param, mini_audio); break;`
- [ ] Add to `initTTS()`: `case TTS_TYPE_MINI_KOKORO: tts = new MiniTTS(tts_param, mini_audio); break;`

### platformio.ini changes
- [ ] Set STT type to 4 (MINI_WHISPER)
- [ ] Set TTS type to 5 (MINI_KOKORO)
- [ ] Set LLM type to 4 (OPENCLAW — already works)
- [ ] Remove cloud API key fields
- [ ] Add mini audio server host/port to config
- [ ] Keep `-DENABLE_WAKEWORD` (cores3)

### Flash & Test
- [ ] Flash to Stack-chan
- [ ] Verify lip sync still works (`robot->tts->getLevel()` returns audio level)
- [ ] Verify triggers still work (Button A, screen touch, wake word — unchanged)
- [ ] **MILESTONE: Press button → speak → Rosie responds through robot speaker + body moves**

## Phase 4: Agent Configuration (1 day)
- [ ] Configure "rosie-robot" agent session on OpenClaw Gateway
- [ ] Write system prompt with:
  - [ ] Rosie's personality (warm, funny, household ops director)
  - [ ] Body command format: `[expression:happy] [gesture:nod] [led:blue]`
  - [ ] Instruction to keep responses short (<200 chars, ~20 seconds of speech)
  - [ ] Instruction to use body commands naturally (express emotion, look around)
  - [ ] Tool availability (household, printer, fridge, memory, Telegram)
- [ ] Wire up tools:
  - [ ] rosie_status (household summary)
  - [ ] rosie_printer_status (3D printer)
  - [ ] rosie_fridge_update (fridge dashboard)
  - [ ] rosie_memory (memory search)
  - [ ] rosie_say (Telegram voice notes)
  - [ ] rosie_time
- [ ] Test: "What's the printer status?" → robot looks, thinks, speaks + body commands
- [ ] Optional: record "Rosie" as custom wake word via plaipin's registration flow
- [ ] **MILESTONE: Robot does useful agentic work through the pipeline**

## Phase 5: Polish & Testing (1-2 days)
- [ ] End-to-end test: button → speak → Rosie responds + body commands execute
- [ ] End-to-end test: wake word → speak → Rosie responds
- [ ] Calibrate audio levels (mic gain, speaker volume)
- [ ] Test all body commands (expression changes, servo gestures, LED states)
- [ ] Error handling:
  - [ ] Server down → avatar text "Connection error" + sad face
  - [ ] WiFi not connected → avatar text "No WiFi" + sad face
  - [ ] STT returned empty → avatar text "Didn't catch that" + confused face
  - [ ] LLM timeout → avatar text "Thinking..." → "Sorry, took too long"
- [ ] Latency logging (reuse Larry V2's two-clock NTP-style reconciliation)
- [ ] Write README (community-first framing):
  - [ ] Headline: "The ESP32 is a dumb audio terminal. No API keys on the device."
  - [ ] Architecture diagram
  - [ ] "What can it do?" section (printer status, fridge, camera vision examples)
  - [ ] "Bring your own personality" — agent template, not actual prompts
  - [ ] "Also powers Larry" — one paragraph footnote
  - [ ] License: MIT, credit Stack-chan + plaipin inspiration
- [ ] Clean up code, commit, push
- [ ] **MILESTONE: Polished, documented, open-source-ready**

## Phase 6 (FUTURE): Larry the Elephant on ESP32
- [ ] Larry ESP32 firmware uses thin audio client pattern (v1.1), not swap-backends
- [ ] Port Larry's Pi Python client logic to ESP32 C++:
  - [ ] VAD (WebRTC-style in C++, or simpler energy threshold)
  - [ ] Noise calibration (reuse Larry's p95 × multiplier approach)
  - [ ] Local sample playback (greeting, trumpet — Larry's core sounds)
  - [ ] Effect markers (reuse Larry's `[trumpet]` pattern)
- [ ] Configure "larry" agent session on OpenClaw Gateway
- [ ] Same mini server — just a different agent session
- [ ] Test with Larry's plush body (LED, speaker, mic — no screen/servos)
- [ ] **MILESTONE: Larry the Elephant runs on ESP32 instead of Pi**

## v1.1: Thin Audio Client (after v1 is working)
- [ ] Add `POST /chat` endpoint to mini server (WAV in → STT → LLM → TTS → WAV out, one call)
- [ ] Write `ThinAudioClient` class — single HTTP POST, single WAV response
- [ ] Delete plaipin's STT/TTS/LLM classes (now safe — server validated)
- [ ] Add VAD on ESP32 (energy threshold or WebRTC-style in C++)
- [ ] Add VAD cooldown (1.8s after playback — prevents echo-loop)
- [ ] Add streaming audio (SSE — like Larry V2's streaming endpoint)
- [ ] Add local error audio samples ("I can't connect", "taking a while")
- [ ] Add noise calibration (Larry's p95 × 1.4 multiplier approach)
- [ ] Add gibberish detection (confidence < -0.8 → TME mode, play local sample)

## v2: Hermes Routing (deferred)
- [ ] Proxy routes to OpenClaw OR Hermes based on config
- [ ] Dual-gateway switching without firmware change

## v3: Real-time Streaming with Interruption (deferred)
- [ ] Borrow patterns from ChatGPT-live and OpenClaw/Hermes live modes
- [ ] Streaming audio chunks with interruption handling

## 🧠 ESP32 Memory Rules (from swarm3-alpha)
- **`HTTPClient.getString()` is FORBIDDEN for audio responses** — buffers in internal SRAM (~320KB), will OOM. Use `http.getStream()`.
- **All audio buffers MUST use PSRAM** — `heap_caps_malloc(size, MALLOC_CAP_SPIRAM)`. 8MB PSRAM is sufficient IF allocated correctly.
- **No base64-in-JSON for audio** — raw WAV body + metadata in HTTP headers.
- **M5.Speaker needs full PCM in contiguous memory** — allocate from PSRAM.

## Reference Patterns (verified from plaipin source)
- `stt/Whisper.cpp` → multipart WAV POST pattern (adapt for LAN HTTP, no TLS)
- `tts/OpenAITTS.cpp` → HTTP POST text + stream response via buffer (adapt for WAV)
- `llm/OpenClawClient.cpp` → already works, NO CHANGES
- `driver/AudioWhisper.cpp` → mic recording code (reuse as-is)
- `driver/PlayMP3.cpp` → audio playback + `getLevel()` for lip sync
- `driver/WakeWord.cpp` → SimpleVox MFCC+DTW wake word (keep as-is)

## Larry V2 Reference Files
- `<your-home>/Larry-android-port/lobster_audio.py` — Pi client source
- `<your-home>/Larry-android-port/lobster_audio_server.py` — Mac server source
  - `transcribe()` line 103 → faster-whisper
  - `generate_speech()` line 123 → Kokoro
  - `parse_effects()` line 165 → regex marker stripping
  - `_log_latency()` line 180 → latency logging

## Hardware Notes
- ⚠️ GC0308 camera pins: SDA=GPIO12, SCL=GPIO11, XCLK=external 20MHz (NOT LEDC)
- ⚠️ Camera NOT compiled in by default — `ENABLE_CAMERA` undefined. Future work.
- ⚠️ "Head-pet" trigger does NOT exist in plaipin — real triggers: Button A, screen touch (top-right), wake word (cores3)
- ⚠️ Servo UART1 @ 1Mbps GPIO6/7 (NO CONFLICT — console on USB Serial/JTAG)
- ⚠️ Servo BSP uses 0.1° units (`deg * 10`) — yaw ±128° / pitch 0-90°
- ⚠️ ILI9342 BGR color correction: `color = ((c & 0x1F) << 11) | (c & 0x07E0) | (c >> 11)`
- ⚠️ Mic quality: Reddit users report Whisper returns empty transcriptions due to low gain — may need AGC tuning