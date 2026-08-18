# Changelog — StackChan-OpenClaw-Hermes

All notable changes to the StackChan-OpenClaw-Hermes project.

## [Unreleased]

### Added
- Project structure initialized on 1TB SSD (`/Volumes/1TBSSDClawd/stackchan-node/`)
- Git repository initialized with `main` branch
- `PROJECT.md` — full project overview, architecture diagram, source repo inventory
- `TODO.md` — phase-by-phase task checklist
- `BUILD_PLAN.md` — detailed 5-phase build plan with file structure and effort estimates
- `PLAN.md` — original exploratory plan (wake word + MCP integration strategy)
- `README.md` — project introduction
- `server.py` — Rosie MCP server for xiaozhi.me broker (7 tools, current prototype)
- `.env` — MCP server token config
- `docs/adrs/` — architecture decision records directory

### Cloned
- `firmware/xiaozhi-esp32/` — xiaozhi firmware (24M, github.com/78/xiaozhi-esp32)
- `firmware/StackChan/` — M5Stack StackChan repo (47M, github.com/m5stack/StackChan)
- `repos/zclaw/` — tnm/zclaw reference repo
- `repos/esp-openclaw-node/` — openclaw/esp-openclaw-node core firmware (with submodules)

### Analyzed
- 4 subagent technical analysis reports completed:
  - `analysis/zclaw-analysis.md` (198 lines)
  - `analysis/esp-openclaw-node-analysis.md` (249 lines)
  - `analysis/xiaozhi-firmware-analysis.md` (433 lines)
  - `analysis/stackchan-firmware-analysis.md` (336 lines)

### Adversarial Review
- `analysis/adversarial-review.md` (198 lines) — Thomas verified every claim against actual source code
- Found 3 factual errors: wrong Gateway port (18789 not 19001), missing auth setup, overstated board port reuse
- Resolved 4 open questions: UART1 (no conflict), ESP-IDF version (5.5.4), wake word generator (doesn't exist), Gateway connection (port + auth)
- Flagged 8 risks: Talk capability unproven, version skew, dependency chain, face system collision, camera contention, denyCommands, no OTA plan, MCP fallback trap
- Revised effort: ~2.5-3 weeks (not ~1 week)
- BUILD_PLAN.md and TODO.md updated with all corrections

### Decisions
- ADR-001: Use esp-openclaw-node as firmware core
- ADR-002: Port StackChan robot layer (servos/face/camera) on top
- ADR-003: Custom "Hey Rosie" wake word via ESP-SR/WakeNet
- ADR-004: xiaozhi.me MCP server approach deferred in favor of full OpenClaw node

### Phase 1 Progress
- ESP-IDF v5.5.4 installed on 1TB SSD at `/Volumes/1TBSSDClawd/esp-idf/`
- CoreS3 board port written: `cores3_audio.c` (AW88298+ES7210 TDM I2S), `cores3_display.c` (ILI9342 SPI), `cores3_touch.c` (BOOT button)
- `rosie-node/` firmware project created with CMakeLists.txt, idf_component.yml, partitions.csv, sdkconfig.defaults
- First successful build: `rosie_node.bin` (3.4MB, 46% free in 6MB OTA partition)
- All 80+ components resolved: WebRTC, LVGL, esp-sr (wn9_hiesp wake word), esp_codec_dev, esp_lcd_ili9341
- Dual-OTA partition table (6MB each) + 2MB SPIFFS model partition

### PlaiPin Repo Analysis
- Cloned `PlaiPin/plaipin-openclaw-stackchan` — Stack-chan + OpenClaw via REST proxy (different architecture)
- `analysis/plaipin-repo-analysis.md` (118 lines) — full investigation
- Worth borrowing: emoji-stripping for TTS, coredump partition, servo API pattern
- NOT useful: REST proxy architecture, SimpleVox wake word, LLM/TTS/STT abstraction layers
- Key insight: validates Stack-chan → OpenClaw is viable; our native approach is harder but better

### stackchan-mcp Repo Analysis
- Cloned `migratorywhale/stackchan-mcp` (55 stars) — MCP bridge for Stack-chan on CoreS3
- `analysis/stackchan-mcp-repo-analysis.md` (170 lines) — full investigation
- BEST hardware reference found: same CoreS3, GC0308 camera, SCSCL servos, ILI9342 display
- Key borrowable patterns: GC0308 pin config, camera I2C release gotcha, servo gestures, BGR color correction, audio gate/mic resume, face state machine
- Architecture: MCP Python server → HTTP REST → ESP32 (different from our WebSocket+WebRTC approach)
- Firmware is a goldmine for Phase 2 robot layer work

### Reddit r/StackChan Thread Analysis
- Thread: "Openclaw + StackChan 🦞🦞" (June 2026) — real-world integration findings
- `analysis/reddit-openclaw-stackchan-thread.md` (120 lines)
- CRITICAL: `esp_codec_dev_write()` silently fails in XiaoZhi firmware — I2S format conflict with duplex config. Fix: bypass codec, write directly to `i2s_channel_write()`
- 16kHz WAV confirmed as proven working sample rate — matches our choice
- Mic quality is a known problem — plan for gain/AGC tuning early
- Real demand for Stack-chan + OpenClaw integration — no clean reference implementation exists yet

### stackchan-atoms3r Repo Analysis
- Cloned `kkdev92/stackchan-atoms3r` — AtomS3R + Voice Base firmware, ESP-IDF 6.0.1
- `analysis/stackchan-atoms3r-repo-analysis.md` (200 lines) — full investigation
- BEST architecture reference found — excellent core/platform separation pattern
- Key borrowable patterns: port abstractions (AudioSource/AudioSink/Face), deadline-based I/O, speech segmenter, half-duplex direction lock, command registry, versioned protocol envelope
- Different hardware (AtomS3R vs CoreS3, ES8311 vs AW88298) but same build system (ESP-IDF)
- Their core/platform separation directly enables our OpenClaw + Hermes dual-target architecture

### README + Brief Rewrite
- Complete README rewrite — frames project as "the open-source reference firmware"
- New `docs/BRIEF.md` — project brief with vision, problem, solution, dual-target architecture
- Dual-target design: same firmware works with OpenClaw OR Hermes by swapping connection layer
- Acknowledgments section crediting all reference repo authors
- Known Gotchas section with all 5 critical findings from reference repos

### robot-bridge Repo Analysis
- Cloned `waynecc-at/robot-bridge` — PRODUCTION-DEPLOYED Stack-chan → Hermes Agent bridge
- `analysis/robot-bridge-repo-analysis.md` (270 lines) — full investigation
- THE most directly relevant repo found — someone already built and shipped Stack-chan + Hermes
- 21 completed features, 15 bug fixes, 11 E2E tests — production-mature
- 11 MCP tools: listen, speak, see, face, face_register, look, track_target, led, emote, status, idle
- Multi-user face recognition (OpenCV + LBPH + Hermes Vision + LLM natural registration)
- Face tracking → servo (smooth EMA, dead zone, rate limit, multi-person priority, LLM override)
- LED state machine (idle=off, wake=green, think=rainbow, reply=blue)
- LLM→TTS streaming pipeline (sentence-level, barge-in, emotion before LLM)
- XiaoZhi protocol server-side confirmed — same message flow as esp-openclaw-node
- Opus params: 16kHz mono, 60ms frames, complexity=10, soxr resampling
- ⚠️ GC0308 pin mapping DIFFERENT from stackchan-mcp — must verify correct config for our CoreS3
- REFACTOR-PLAN.md self-critique validates our native approach (no bridge needed)
- This IS the Hermes integration blueprint for our dual-target design

### Project Rename + GitHub Publication
- Project renamed from "rosie-node" → **StackChan-OpenClaw-Hermes**
- README, BRIEF, BUILD_PLAN, TODO, CHANGELOG all updated with new name
- GitHub repository created and pushed
- Frames project as the open-source reference firmware for Stack-chan + AI agent integration
- Dual-target architecture (OpenClaw + Hermes) front and center

### stackchan-gemini-firmware Repo Analysis
- Cloned `taranton/stackchan-gemini-firmware` — PlatformIO/Arduino CoreS3 firmware with Google Gemini Live API
- `analysis/stackchan-gemini-firmware-repo-analysis.md` (244 lines) — full investigation
- GC0308 pin mapping CONFIRMS stackchan-mcp (SDA=GPIO12, SCL=GPIO11) — second repo to agree, robot-bridge is outlier
- ⚠️ CRITICAL: XCLK via LEDC causes audio choppy — must use external 20MHz clock (XCLK=-1). Third repo to warn about camera/audio interference.
- Camera I2C release pattern confirmed again (`M5.In_I2C.release()` before init, deinit after)
- Borrowable patterns: non-blocking servo gesture queue (16-step, anchor tracking), 10-mode emotion state machine, SD-backed config + setup AP, boot/wake sound effects, VAD defaults (800ms/900ms)
- Gemini Live WebSocket protocol architecturally similar to OpenClaw WS flow (setup → bidirectional audio → tool calls)
- Verdict: 6/10 — hardware patterns useful, AI backend not reusable

### Backup Rule
- HARD RULE added to TODO.md: backup stock firmware before flashing
- `backups/` directory created on 1TB SSD
- Procedure: full 16MB `esptool read_flash` dump + partition table save + size verify BEFORE any flash
- Restore: `esptool write_flash 0x0 backup_stackchan_stock.bin`