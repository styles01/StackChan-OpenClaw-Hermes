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
- [ ] Commit new architecture docs (BRIEF, BUILD_PLAN, TODO)

## Phase 1: Fork & Flash (1-2 days)
- [ ] Full 16MB flash backup of stock Stack-chan firmware (HARD RULE)
- [ ] Fork plaipin repo (`repos/plaipin-openclaw-stackchan/`) as our base
- [ ] Configure `OpenClawClient` to point to Clawdio-Mini's IP:18790
- [ ] Copy plaipin's `openclaw-rest-proxy.js` to Clawdio-Mini
- [ ] Configure proxy: `OPENCLAW_WS_URL=ws://localhost:18789`, gateway token
- [ ] Set up systemd service for proxy on mini (auto-start, auto-restart)
- [ ] Set `platformio.ini` LLM backend to `OpenClaw`
- [ ] Flash plaipin firmware to Stack-chan
- [ ] **MILESTONE: Stack-chan talks to OpenClaw Gateway through the proxy**
- [ ] Verify: pet head → record → send to gateway → get response → speak through robot speaker
- [ ] Test: Rosie's personality comes through (not generic ChatGPT)

## Phase 2: Improve Adapter (2-3 days)
- [ ] Add streaming support (`stream: true` — robot speaks first sentence while agent still generating)
  - [ ] Parse SSE/streaming response format in `OpenClawClient::chat()`
  - [ ] Feed text to TTS sentence-by-sentence instead of waiting for full response
  - [ ] Test: noticeable latency reduction vs `stream: false`
- [ ] Add body-command parsing in `OpenClawClient::chat()` response handler
  - [ ] Parse `body.expression` → `avatar.setExpression()`
  - [ ] Parse `body.servo` → `servo->moveToGaze(yaw, pitch, speed)`
  - [ ] Parse `body.gesture` → trigger gesture state machine (nod/shake/look_around)
  - [ ] Parse `body.led` → LED state (off/green/blue/rainbow)
- [ ] Add emoji stripping (copy plaipin's `stripEmoji()` if not already in our fork)
- [ ] Add response sanitization (strip markdown, cap text at ~200 chars for TTS)
- [ ] Add error handling (connection errors, timeouts, parse errors, gateway down)
- [ ] Add retry logic with backoff (gateway temporarily unavailable)
- [ ] **MILESTONE: Streaming responses + body commands work**

## Phase 3: Hermes Path (1-2 days)
- [ ] Add Hermes routing to the proxy (same HTTP interface, different gateway endpoint)
  - [ ] Add config option: `GATEWAY=openclaw|hermes` (or route based on path/header)
  - [ ] Implement Hermes webhook flow: HTTP from ESP32 → Hermes agent webhook
  - [ ] Format Hermes response into same OpenAI-shaped JSON + body field
- [ ] Add Hermes auth/webhook configuration
- [ ] Test: swap OpenClaw → Hermes by changing one config value on the mini
- [ ] Verify: same firmware binary, different gateway, same body behavior
- [ ] **MILESTONE: Dual-gateway switching works without firmware change**

## Phase 4: Agent Configuration (1 day)
- [ ] Configure Rosie as the agent for this node on OpenClaw Gateway
- [ ] Set Rosie's system prompt for robot interaction
  - [ ] Include body command format in system prompt (so agent knows it can drive the body)
  - [ ] Include personality guidance (Rosie persona, but robot-appropriate)
  - [ ] Include tool availability (household, printer, fridge, memory, Telegram)
- [ ] Wire up household tools:
  - [ ] rosie_status (household summary)
  - [ ] rosie_printer_status (3D printer)
  - [ ] rosie_fridge_update (fridge dashboard)
  - [ ] rosie_memory (memory search)
  - [ ] rosie_say (Telegram voice notes)
  - [ ] rosie_time
- [ ] Map robot commands (borrow patterns from robot-bridge's 11 MCP tools):
  - [ ] "Look at me" → `body.servo` lookAtNormalized
  - [ ] "Show me [image]" → camera capture + display
  - [ ] Emotion mapping → `body.expression` (happy/sad/angry/sleepy/doubt)
  - [ ] LED states → `body.led` (idle=off, wake=green, think=rainbow, reply=blue)
  - [ ] Gestures → `body.gesture` (nod/shake/look_around)
- [ ] **MILESTONE: "Hey Rosie, what's the printer status?" → robot looks, thinks, speaks**

## Phase 5: Polish & Testing (1-2 days)
- [ ] End-to-end test: pet head → speak → Rosie responds through robot with personality
- [ ] Calibrate audio levels (mic gain, speaker volume)
- [ ] Test camera vision ("Hey Rosie, what do you see?")
- [ ] Test servo gestures during speech (nod when happy, shake when doubtful)
- [ ] Test LED emotion states (blue when replying, rainbow when thinking)
- [ ] Test error states (gateway down, network loss, timeout)
- [ ] Test dual-gateway switch (OpenClaw → Hermes → back)
- [ ] Clean up code, write README, commit and push
- [ ] **MILESTONE: Polished, documented, open-source-ready**

## Reference Patterns to Borrow (from robot-bridge — PATTERNS not code)
- [ ] LED state machine: idle=off, wake=green(1.8s), think=rainbow chase, reply=blue
- [ ] Face tracking: EMA smoothing=0.25, dead zone=6%, rate limit=12°/0.5s
- [ ] LLM→TTS streaming: sentence-level with barge-in
- [ ] Per-person memory sessions: `stackchan-{name}` session IDs
- [ ] Natural stranger registration: LLM-driven, no regex state machine
- [ ] 11 MCP tool definitions as reference for our gateway tool list
- [ ] Opus params (if we ever need Opus): 16kHz, 60ms frames, complexity=10

## Hardware Notes (for reference if firmware needs fixes)
- ⚠️ GC0308 camera pins: SDA=GPIO12, SCL=GPIO11 (2-repo consensus), XCLK=external 20MHz (NOT LEDC)
- ⚠️ Camera I2C release: `M5.In_I2C.release()` before `esp_camera_init()`, deinit after capture
- ⚠️ `esp_codec_dev_write()` may silently fail — bypass to `i2s_channel_write()` if needed
- ⚠️ Mic quality: Reddit users report Whisper returns empty transcriptions due to low gain — may need AGC tuning
- ⚠️ Servo UART1 @ 1Mbps GPIO6/7 (NO CONFLICT — console on USB Serial/JTAG)
- ⚠️ ILI9342 BGR color correction: `color = ((c & 0x1F) << 11) | (c & 0x07E0) | (c >> 11)`
- ⚠️ Servo BSP uses 0.1° units (`deg * 10`) — yaw ±128° / pitch 0-90°