# TODO — StackChan-OpenClaw-Hermes

## ⚠️ HARD RULE: Backup Stock Firmware Before Flashing
We have bricked multiple devices before. BEFORE flashing any firmware to the Stack-chan:
1. Plug in via USB, detect serial port
2. `esptool read_flash 0 0x1000000 backup_stackchan_stock.bin` (full 16MB dump)
3. Save partition table: `esptool read_flash 0x8000 0x1000 backup_partition_table.bin`
4. Verify backup file is exactly 16MB
5. Store backups on 1TB SSD: `/Volumes/1TBSSDClawd/stackchan-node/backups/`
6. ONLY then flash our firmware

If anything goes wrong: `esptool write_flash 0x0 backup_stackchan_stock.bin` restores brick-for-brick.

## ⚠️ THROWAWAY CODE
The `rosie-node/` ESP-IDF project is throwaway — Architecture A artifact. Kept for reference, not used.

## GitHub
- [x] Rename project to StackChan-OpenClaw-Hermes
- [x] Create GitHub repo and push
- [ ] Commit new architecture docs (BRIEF, BUILD_PLAN, TODO) — Larry V2 thin audio client

## Phase 1: Fork & Flash Stock (1 day)
- [ ] Full 16MB flash backup of stock Stack-chan firmware (HARD RULE)
- [ ] Fork plaipin repo as our base
- [ ] Flash plaipin firmware UNMODIFIED to Stack-chan — verify body works (face, servo, touch)
- [ ] **MILESTONE: Stack-chan boots with plaipin firmware, body works**

## Phase 2: Audio Pipeline Server on Mini (1-2 days)
- [ ] Port Larry V2's `lobster_audio_server.py` pattern to a new server on Clawdio-Mini
- [ ] Adapt: route to OpenClaw Gateway WebSocket (port 18789) instead of LM Studio
- [ ] Add body command marker parsing (regex — like Larry's `[trumpet]` effect markers)
- [ ] Add Kokoro TTS (already on mini, British voice — bm_george or bf_emma)
- [ ] STT: Parakeet, Whisper, or OpenClaw's built-in STT (decide based on what's on the mini)
- [ ] Test: `curl -F audio=test.wav http://mini:18790/audio` → get WAV + JSON back
- [ ] Add latency logging (reuse Larry V2's two-clock NTP-style reconciliation)
- [ ] Set up systemd service on mini (auto-start, auto-restart)
- [ ] **MILESTONE: Server works end-to-end with curl — WAV in, WAV + body commands out**

## Phase 3: Thin Audio Client Firmware (2-3 days)
- [ ] Write `ThinAudioClient` class (replaces STT/LLM/TTS pipeline)
  - [ ] M5.Mic recording (16kHz mono, button-triggered for v1 — VAD is v1.1)
  - [ ] WAV header construction (simple RIFF header, no encoding)
  - [ ] HTTP POST to mini:18790/audio (HTTPClient)
  - [ ] Parse JSON response (audio base64 + body commands)
  - [ ] M5.Speaker WAV playback (decode base64 → WAV → play)
  - [ ] Body command execution (face/servo/LED via existing plaipin API)
- [ ] Write `BodyCommandParser` class
  - [ ] Parse `[expression:happy]` → `avatar.setExpression()`
  - [ ] Parse `[gesture:nod]` → trigger gesture (nod/shake/look_around)
  - [ ] Parse `[led:blue]` → LED state (off/green/blue/rainbow)
  - [ ] Parse `[servo:yaw:-30,pitch:45]` → `servo->moveToGaze()`
- [ ] Remove/disable plaipin's STT, TTS, LLM classes from the build
  - [ ] Remove `stt/` directory from build (CloudSpeechClient, Whisper, ModuleLLMASR)
  - [ ] Remove `tts/` directory from build (WebVoiceVox, ElevenLabs, OpenAITTS, AquesTalk)
  - [ ] Remove `llm/` directory from build (ChatGPT, Gemini, OpenClawClient, ModuleLLM)
  - [ ] Or: keep files but exclude from platformio.ini build flags
- [ ] Update `platformio.ini` (remove STT/TTS API key fields, set backend to thin audio)
- [ ] Update config (point to mini's IP:18790, no API keys needed)
- [ ] Update MainLoop / Robot.cpp to call ThinAudioClient instead of STT→LLM→TTS chain
- [ ] Flash to Stack-chan
- [ ] **MILESTONE: Press button → speak → Rosie responds through robot speaker**

## Phase 4: Agent Configuration (1 day)
- [ ] Configure "rosie-robot" agent session on OpenClaw Gateway
- [ ] Write system prompt with:
  - [ ] Rosie's personality (warm, funny, household ops director)
  - [ ] Body command format: `[expression:happy] [gesture:nod] [led:blue]`
  - [ ] Instruction to keep responses short (<200 chars, ~20 seconds of speech)
  - [ ] Instruction to use body commands naturally (express emotion, look around)
  - [ ] Tool availability (household, printer, fridge, memory, Telegram)
- [ ] Wire up household tools:
  - [ ] rosie_status (household summary)
  - [ ] rosie_printer_status (3D printer)
  - [ ] rosie_fridge_update (fridge dashboard)
  - [ ] rosie_memory (memory search)
  - [ ] rosie_say (Telegram voice notes)
  - [ ] rosie_time
- [ ] Test: "Hey Rosie, what's the printer status?" → robot looks, thinks, speaks
- [ ] **MILESTONE: Robot does useful agentic work through the pipeline**

## Phase 5: Polish & Testing (1-2 days)
- [ ] End-to-end test: pet head → speak → Rosie responds through robot
- [ ] Calibrate audio levels (mic gain, speaker volume)
- [ ] Test body commands (expression changes, servo gestures, LED states)
- [ ] Test camera vision ("Hey Rosie, what do you see?")
- [ ] Add error handling:
  - [ ] Server down → play local "I can't connect" sample
  - [ ] Timeout → play local "taking a while" sample
  - [ ] Gibberish detection (reuse Larry V2's confidence threshold — low confidence → local sample)
  - [ ] Network loss → retry with backoff
- [ ] Add latency logging (reuse Larry V2's two-clock reconciliation)
- [ ] Clean up code, write README, commit and push
- [ ] **MILESTONE: Polished, documented, open-source-ready**

## Phase 6 (FUTURE): Larry the Elephant on ESP32
- [ ] Port Larry's Pi Python client logic to ESP32 C++
  - [ ] VAD (WebRTC-style in C++, or simpler energy threshold)
  - [ ] Noise calibration (reuse Larry's p95 × multiplier approach)
  - [ ] Local sample playback (greeting, trumpet — Larry's core sounds)
  - [ ] Effect markers (reuse Larry's `[trumpet]` pattern)
- [ ] Configure "larry" agent session on OpenClaw Gateway
  - [ ] Larry's HEART.md → system prompt
  - [ ] Larry's MEMORY.md → agent memory (or keep as file the gateway reads)
- [ ] Same audio pipeline server — just a different agent session
- [ ] Test with Larry's plush body (LED, speaker, mic — no screen/servos)
- [ ] **MILESTONE: Larry the Elephant runs on ESP32 instead of Pi**

## Deferred to v1.1
- [ ] Streaming audio (SSE — like Larry V2's `transcribe_respond_and_speak_stream`)
- [ ] VAD on ESP32 (button trigger is fine for v1)
- [ ] Noise calibration on ESP32 (Larry V2's p95 × 1.4 multiplier approach)

## Deferred to v2
- [ ] Hermes routing (proxy routes to OpenClaw OR Hermes based on config)
- [ ] Dual-gateway switching without firmware change

## Larry V2 Reference Files
- `/Users/clawdio/Larry-android-port/lobster_audio.py` — Pi client source (VAD, noise filtering, HTTP POST, WAV playback)
- `/Users/clawdio/Larry-android-port/lobster_audio_server.py` — Mac server source (Whisper STT, LM Studio LLM, Kokoro TTS, session manager, latency logging)

## Reference Patterns to Borrow (from robot-bridge — PATTERNS not code)
- [ ] LED state machine: idle=off, wake=green(1.8s), think=rainbow chase, reply=blue
- [ ] Face tracking: EMA smoothing=0.25, dead zone=6%, rate limit=12°/0.5s
- [ ] Per-person memory sessions: `stackchan-{name}` session IDs
- [ ] 11 MCP tool definitions as reference for our gateway tool list

## Hardware Notes (for reference if firmware needs fixes)
- ⚠️ GC0308 camera pins: SDA=GPIO12, SCL=GPIO11 (2-repo consensus), XCLK=external 20MHz (NOT LEDC)
- ⚠️ Camera I2C release: `M5.In_I2C.release()` before `esp_camera_init()`, deinit after capture
- ⚠️ `esp_codec_dev_write()` may silently fail — bypass to `i2s_channel_write()` if needed
- ⚠️ Mic quality: Reddit users report Whisper returns empty transcriptions due to low gain — may need AGC tuning
- ⚠️ Servo UART1 @ 1Mbps GPIO6/7 (NO CONFLICT — console on USB Serial/JTAG)
- ⚠️ ILI9342 BGR color correction: `color = ((c & 0x1F) << 11) | (c & 0x07E0) | (c >> 11)`
- ⚠️ Servo BSP uses 0.1° units (`deg * 10`) — yaw ±128° / pitch 0-90°