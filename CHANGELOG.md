# Changelog

All notable changes to the Stack-chan → Rosie Node project.

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

### Backup Rule
- HARD RULE added to TODO.md: backup stock firmware before flashing
- `backups/` directory created on 1TB SSD
- Procedure: full 16MB `esptool read_flash` dump + partition table save + size verify BEFORE any flash
- Restore: `esptool write_flash 0x0 backup_stackchan_stock.bin`