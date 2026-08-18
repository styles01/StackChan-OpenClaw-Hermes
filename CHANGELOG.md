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