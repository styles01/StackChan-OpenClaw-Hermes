# TODO — Stack-chan Thin Audio Client

## ⚠️ HARD RULE: Backup Stock Firmware Before Flashing
We have bricked multiple devices before. BEFORE flashing any firmware to the Stack-chan:
1. Plug in via USB, detect serial port
2. `esptool read_flash 0 0x1000000 backup_stackchan_stock.bin` (full 16MB dump)
3. Save partition table: `esptool read_flash 0x8000 0x1000 backup_partition_table.bin`
4. Verify backup file is exactly 16MB
5. Store backups on 1TB SSD: `/Volumes/1TBSSDClawd/stackchan-node/backups/`
6. ONLY then flash our firmware

If anything goes wrong: `esptool write_flash 0x0 backup_stackchan_stock.bin` restores brick-for-brick.

## GitHub / Repo
- [x] Create project structure and analysis
- [x] Swarm 3 review complete (4 reports + synthesis)
- [x] BRIEF.md rewritten (swap-backends v1, thin client v1.1)
- [x] BUILD_PLAN.md rewritten
- [ ] TODO.md updated (this file)
- [ ] Rename repo to `stackchan-thin-audio-client` or `stackchan-openclaw` (current name oversells Hermes)
- [ ] Write README (community-first framing: "dumb audio terminal, no API keys")
- [ ] Commit and push updated docs

## Phase 1: Fork & Flash Stock (1 day)
- [ ] Full 16MB flash backup of stock Stack-chan firmware (HARD RULE)
- [ ] Fork from Stack-chan (MIT-licensed) — NOT plaipin (no license)
- [ ] Port plaipin's OpenClawClient + REST proxy concepts as reference (write our own code)
- [ ] Flash unmodified firmware to Stack-chan — verify body works (face, servo, touch, lip sync)
- [ ] **MILESTONE: Stack-chan boots, body works**

## Phase 2: Audio Pipeline Server on Mini (1-2 days)
- [ ] Port Larry V2's `lobster_audio_server.py` pattern to new server on Clawdio-Mini
- [ ] `/stt` endpoint: receive WAV → Whisper/Parakeet STT → return JSON `{ text, confidence }`
- [ ] `/tts` endpoint: receive text → strip body command markers → Kokoro TTS → return WAV + body commands JSON
- [ ] Body command marker parser (regex — `[expression:happy]`, `[gesture:nod]`, `[led:blue]`, `[servo:...]`)
- [ ] STT: decide Whisper vs Parakeet based on what's on the mini
- [ ] TTS: Kokoro (already on mini, British voice — bm_george or bf_emma)
- [ ] Test: `curl -F audio=test.wav http://mini:18790/stt` → text back
- [ ] Test: `curl -d "hello [expression:happy]" http://mini:18790/tts` → WAV + JSON back
- [ ] Latency logging (reuse Larry V2's two-clock NTP-style reconciliation)
- [ ] systemd service on mini (auto-start, auto-restart)
- [ ] **MILESTONE: Server works end-to-end with curl — no ESP32 needed**

## Phase 3: Retarget Backends (2-3 days)
- [ ] Write `MiniSTT` class (implements `STTBase`)
  - [ ] Record audio via M5.Mic (reuse plaipin's `AudioWhisper.cpp` recording code)
  - [ ] HTTP POST WAV to mini:18790/stt (use `http.getStream()`, NOT `getString()`)
  - [ ] Allocate buffers from PSRAM (`heap_caps_malloc(..., MALLOC_CAP_SPIRAM)`)
  - [ ] Parse JSON response (text + confidence)
  - [ ] Return text to `Robot::listen()` → `Robot::chat()`
- [ ] Write `MiniTTS` class (implements `TTSBase`)
  - [ ] HTTP POST text to mini:18790/tts
  - [ ] Receive WAV response via `http.getStream()` into PSRAM buffer
  - [ ] Play WAV through M5.Speaker
  - [ ] Provide `getLevel()` for lip sync (reuse plaipin's audio level tracking)
  - [ ] NO base64-in-JSON for audio — raw WAV body or multipart
- [ ] Write `BodyCommandParser` class
  - [ ] Parse `[expression:happy]` → `avatar.setExpression()`
  - [ ] Parse `[gesture:nod]` → trigger gesture (nod/shake/look_around)
  - [ ] Parse `[led:blue]` → LED state (off/green/blue/rainbow)
  - [ ] Parse `[servo:yaw:-30,pitch:45]` → `servo->moveToGaze()`
- [ ] Update `platformio.ini`
  - [ ] Select new backends (MiniSTT, MiniTTS) instead of cloud backends
  - [ ] Remove cloud API key fields from config
  - [ ] Add PSRAM allocation flags if needed
- [ ] Update config (point to mini's IP:18790, no cloud API keys)
- [ ] Verify lip sync still works (`robot->tts->getLevel()` must return audio level)
- [ ] Verify triggers still work (Button A, screen touch — unchanged from plaipin)
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
- [ ] Wire up tools:
  - [ ] rosie_status (household summary)
  - [ ] rosie_printer_status (3D printer)
  - [ ] rosie_fridge_update (fridge dashboard)
  - [ ] rosie_memory (memory search)
  - [ ] rosie_say (Telegram voice notes)
  - [ ] rosie_time
- [ ] Test: "What's the printer status?" → robot looks, thinks, speaks + body commands
- [ ] **MILESTONE: Robot does useful agentic work through the pipeline**

## Phase 5: Polish & Testing (1-2 days)
- [ ] End-to-end test: button → speak → Rosie responds + body commands execute
- [ ] Calibrate audio levels (mic gain, speaker volume)
- [ ] Test body commands (expression changes, servo gestures, LED states)
- [ ] Error handling (reuse plaipin's existing pattern: avatar text "Connection error" + sad face)
- [ ] Latency logging (reuse Larry V2's two-clock reconciliation)
- [ ] Write README (community-first framing per swarm3-gamma):
  - [ ] Headline: "The ESP32 is a dumb audio terminal. No API keys on the device."
  - [ ] Architecture diagram
  - [ ] "What can it do?" section (printer status, fridge, camera vision examples)
  - [ ] Comparison table vs other Stack-chan forks
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
  - [ ] Larry's HEART.md → system prompt (PRIVATE — not in repo)
  - [ ] Larry's MEMORY.md → agent memory (PRIVATE — not in repo)
- [ ] Same mini server — just a different agent session
- [ ] Test with Larry's plush body (LED, speaker, mic — no screen/servos)
- [ ] **MILESTONE: Larry the Elephant runs on ESP32 instead of Pi**

## v1.1: Thin Audio Client (after v1 is working)
- [ ] Collapse 3 round-trips to 1 (`ThinAudioClient` class — single HTTP POST)
- [ ] Delete plaipin's STT/TTS/LLM classes (now safe — server validated)
- [ ] Add VAD on ESP32 (energy threshold or WebRTC-style in C++)
- [ ] Add streaming audio (SSE — like Larry V2's `transcribe_respond_and_speak_stream`)
- [ ] Add local error audio samples ("I can't connect", "taking a while")
- [ ] Add noise calibration (Larry's p95 × 1.4 multiplier approach)
- [ ] Add gibberish detection (confidence < -0.8 → TME mode, play local sample)
- [ ] Add VAD cooldown (1.8s after playback — prevents echo-loop)

## v2: Hermes Routing (deferred)
- [ ] Proxy routes to OpenClaw OR Hermes based on config
- [ ] Dual-gateway switching without firmware change

## v3: Real-time Streaming with Interruption (deferred)
- [ ] Borrow patterns from ChatGPT-live and OpenClaw/Hermes live modes
- [ ] Streaming audio chunks with interruption handling
- [ ] Same skeleton (audio in → STT → LLM → TTS → audio out), different transport

## 🧠 ESP32 Memory Rules (from swarm3-alpha)
- **`HTTPClient.getString()` is FORBIDDEN for audio responses** — buffers in internal SRAM (~320KB), will OOM on any real audio. Use `http.getStream()`.
- **All audio buffers MUST use PSRAM** — `heap_caps_malloc(size, MALLOC_CAP_SPIRAM)`. The 8MB PSRAM is more than enough, but only if explicitly allocated.
- **No base64-in-JSON for audio** — inflates payload 33%, forces full in-memory decode. Use raw WAV body + metadata in headers or small JSON.
- **M5.Speaker.playWav() needs full PCM in contiguous memory** — allocate from PSRAM, not fragmented heap.

## Reference Patterns to Borrow (from robot-bridge — PATTERNS not code)
- [ ] LED state machine: idle=off, wake=green(1.8s), think=rainbow chase, reply=blue
- [ ] Face tracking: EMA smoothing=0.25, dead zone=6%, rate limit=12°/0.5s
- [ ] Per-person memory sessions: `stackchan-{name}` session IDs
- [ ] 11 MCP tool definitions as reference for our gateway tool list

## Larry V2 Reference Files
- `/Users/clawdio/Larry-android-port/lobster_audio.py` — Pi client source (VAD, noise filtering, HTTP POST, WAV playback)
- `/Users/clawdio/Larry-android-port/lobster_audio_server.py` — Mac server source (Whisper STT, LM Studio LLM, Kokoro TTS, session manager, latency logging)

## Hardware Notes (for reference if firmware needs fixes)
- ⚠️ GC0308 camera pins: SDA=GPIO12, SCL=GPIO11 (2-repo consensus), XCLK=external 20MHz (NOT LEDC)
- ⚠️ Camera I2C release: `M5.In_I2C.release()` before `esp_camera_init()`, deinit after capture
- ⚠️ `esp_codec_dev_write()` may silently fail — bypass to `i2s_channel_write()` if needed
- ⚠️ Mic quality: Reddit users report Whisper returns empty transcriptions due to low gain — may need AGC tuning
- ⚠️ Servo UART1 @ 1Mbps GPIO6/7 (NO CONFLICT — console on USB Serial/JTAG)
- ⚠️ ILI9342 BGR color correction: `color = ((c & 0x1F) << 11) | (c & 0x07E0) | (c >> 11)`
- ⚠️ Servo BSP uses 0.1° units (`deg * 10`) — yaw ±128° / pitch 0-90°
- ⚠️ Camera NOT compiled in by default — `ENABLE_CAMERA` undefined in platformio.ini. Enabling is future work, not a preserved feature.
- ⚠️ "Head-pet" trigger does NOT exist in plaipin — real triggers are Button A, screen touch (top-right region), wake word (cores3)