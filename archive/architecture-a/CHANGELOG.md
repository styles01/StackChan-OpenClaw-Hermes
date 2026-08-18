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
- `analysis/adversarial-code-review.md` (244 lines) — adversarial review of actual firmware code against esp-openclaw-room-node contract
- Found 6 bugs: critical TDM/STD I2S mode mismatch, missing TX/RX pair validation, TDM slot over-allocation, display brightness no-op, PSRAM DMA risk, shared I2C bus (not actually a bug)
- Found 3 missing config fields: services port, storage port, display/audio ctx
- Fixed audio driver: rewrote `cores3_audio.c` from TDM to STD I2S (matching Waveshare reference pattern)
- Added TX/RX pair validation from Waveshare reference
- Created Phase 2 skeleton files: `cores3_servo.c/h`, `cores3_camera.c/h`, `cores3_led.c/h`
- Updated `main.c` with services port callbacks (prepare_runtime, prepare_network, register_commands)

### Reuse-First Principle (James's callout)
- James caught that I was reinventing the wheel — writing servo/camera/LED drivers from scratch when proven implementations exist in stackchan-mcp and plaipin
- Adversarial review should have caught "should this code exist?" not just "are there bugs in this code?" — process failure noted
- **New principle: Reuse proven code unless we have a specific architectural reason to rewrite**
- **Architecture decision: Add Arduino-ESP32 (v3.3.6, built on ESP-IDF v5.5.2) as a managed component** — TARGET, pending feasibility spike
  - Gives direct access to `M5StackChan.Motion`, `M5Unified`, `StackChan-BSP`, `esp_camera`
  - These are already proven on CoreS3 by stackchan-mcp and plaipin
  - ⚠️ NOT YET TESTED — esp-openclaw-node is pure ESP-IDF, adding Arduino is untested
  - ⚠️ M5Unified and StackChan-BSP are NOT available as ESP-IDF managed components — need manual integration
  - Phase 1.5 feasibility spike added to BUILD_PLAN to test before committing
- Updated BRIEF, BUILD_PLAN, TODO, README with reuse-first principle and Arduino-as-component decision
- From-scratch servo/camera/LED files created but are WRONG and pending replacement with thin wrappers
  - They compile but are dead code (not called from main.c)
  - Will be replaced when Arduino-ESP32 feasibility is confirmed
- Self-critique: `analysis/adversarial-doc-critique.md` — found 8 issues, all fixed in this commit

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