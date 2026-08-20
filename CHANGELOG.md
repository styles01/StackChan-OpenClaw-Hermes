# CHANGELOG

## v0.1 — 2026-08-19 — First Release

### What's Working
- **Full voice conversation loop** — device connects to ai-server via WebSocket, streams Opus audio, gets STT → LLM → TTS back
- **Custom wake word** — "Hey Rosie" WakeNet9 model trained on DGX Spark, flashed to model partition
- **Stock wake word disabled** — compiled-in "Hi Stack Chan" removed from sdkconfig
- **ai-server bridge** — TypeScript WebSocket server (port 8765), connects device to OpenClaw agent (Rosie)
- **English voice** — TTS (`en-GB-LibbyNeural`), STT (faster-whisper, English), English fast-acks
- **Fast-ack** — "Yes, darling?" on wake word detection
- **VAD + cooldown** — local VAD for speech detection, 3s post-TTS cooldown to prevent self-triggering
- **Volume control** — correct MCP tool (`self.audio_speaker.set_volume`), boot volume boost on connect
- **Full sentence responses** — streaming segment alignment bug fixed
- **Configurable via .env** — fast-ack text, cooldown, segment limits, VAD params, boot volume

### Known Issues (v0.1)
- Volume may need manual tuning per device
- Wake word model loads from assets partition on some boots (overrides model partition)
- POST /config endpoint untested with larger payloads
- PlatformIO/Arduino build path still broken (use ESP-IDF)
- ai-server is ~4000 lines of TypeScript (FastAPI rewrite considered for v2)

### Firmware Binaries
- `stack-chan.bin` — 3.7MB main app (0x20000)
- `bootloader.bin` — 24KB bootloader (0x0)
- `partition-table.bin` — 3KB partition table (0x8000)
- `ota_data_initial.bin` — 8KB OTA data (0xd000)
- Flash with ESP-IDF: `idf.py -p /dev/cu.usbmodem211301 flash`
- Or esptool: see FLASHING-GUIDE.md

---

## 2026-08-19 — Three-Repo Merge (Official + Circlemouth + Plaipin)

### What Changed
- **Merged official StackChan v1.4.3 firmware** (231 clean source files) into `firmware/` — no build cruft
- **Merged circlemouth/Hermes-StackChan** — canonical xiaozhi-esp32 patch (1188 lines, 11 files), ai-server (TypeScript WS bridge), 72/72 tests pass
- **Merged plaipin-openclaw-stackchan** — config structs (`openclaw_s`, `hermes_s`, `backend` selector), web config endpoints (GET/POST /config), emoji stripper — ported from Arduino/PlatformIO to ESP-IDF/NVS
- **OTA auto-update unconditionally disabled** — hard `return` before any version check, not conditional on config existing
- **Per-device backend binding** — ai-server reads `Device-Id` from WS handshake, looks up `devices.json` for per-device backend+agent routing
- **Dropped OpenClawClient.cpp** — dead code under thin-client architecture (device only talks to ai-server over WS)
- **Declared BUILD_PLAN.md v1 superseded** — FastAPI mini server (ports 18791/18790/18789), MiniSTT/MiniTTS/BodyCommandParser abandoned

### Build Status
- Firmware: ✅ Builds successfully (`stack-chan.bin` 3.7MB, 27% free)
- ai-server: ✅ TypeScript compiles clean, 72/72 tests pass
- firmware-extras: ✅ Compiles and links into firmware

### 2026-08-19 — Phase 3: Web Config Server (DONE)
- **Web config server running on device port 80** — GET /config (JSON), POST /config (save), GET / (HTML editor)
- **Three bugs fixed in sequence:**
  1. Wrong file edited (`xiaozhi-esp32/main/main.cc` was dead code; real entry = `firmware/main/main.cpp`)
  2. C/C++ linkage mismatch (`web_config_endpoints.cc` didn't include its own header → C++ name mangling)
  3. TCP/IP not initialized (`startNetwork()` must be called before httpd can bind)
- **POST handler crash fixed** — httpd stack size bumped 4096 → 8192 → 16384, malloc→calloc
- **mDNS confirmed working** — `CONFIG_LWIP_DNS_SUPPORT_MDNS_QUERIES=y` already in sdkconfig; `gethostbyname()` resolves `.local` via lwip multicast DNS. No firmware code change needed.

### 2026-08-19 — Phase 4: Device Connected to ai-server (DONE)
- **Device connects to `ws://clawdio-mini.local:8765/ws`** via mDNS — NO IP address!
- `start_ai_on_boot = true` written to `"xiaozhi"` NVS namespace (key `"boot_ai"`)
- Device skips Mooncake launcher, goes straight to AI Agent on boot
- ai-server accepts WS connection, reads `Device-Id` from handshake (MAC address)
- Backend routing: `openclaw` → `agent=rosie`
- Audio pipeline active: VAD detects speech, STT/LLM/TTS chain running
- Minor issue: TTS fast-ack Python script not found (`spawn python3 ENOENT`) — non-blocking
- **Full connection chain: device → mDNS → WS → ai-server → OpenClaw → Rosie**

### Why
The device is a thin audio client — STT/LLM/TTS happen on the server, not the device. The old BUILD_PLAN v1 assumed device-side STT/TTS seams that don't exist in the ESP-IDF firmware. The correct architecture is: device streams OPUS over WebSocket → ai-server does STT/LLM/TTS → streams audio back. Circlemouth already built this; we merge it into our repo.

### Blockers Fixed (from adversarial review)
1. **Patch collision** — circlemouth is canonical, official patch dropped. All 3 official-only changes already present in circlemouth's patch.
2. **First-boot OTA hole** — unconditional skip (hard return), not conditional on config.
3. **Backend binding off-device** — per-device lookup in ai-server via `devices.json` + WS handshake `Device-Id`.

### 2026-08-19 — Phase 5: Firmware Crash Fix — Device Talks and Survives (DONE)

**Root cause found and fixed:** Device crashed 100% at `listening → speaking` transition. Two bugs:

1. **WiFi power save killing TCP** — `OnAudioChannelClosed` callback set WiFi to `LOW_POWER (MAX_MODEM)` after TTS finished. WiFi modem sleep killed the TCP connection (`TCP receive failed: -1`). Device tried to reconnect after wake word → crashed.
   - **Fix:** Stay in `PERFORMANCE` mode while WebSocket session is active. Only drop to `LOW_POWER` when truly idle (`OnDisconnected`).

2. **EspTcp::Connect stale socket/task leak** — When reconnecting after unexpected TCP drop, old receive task was already dead. Creating new 4KB receive task on top of exhausted 29KB free SRAM → crash.
   - **Fix:** Force-close stale sockets before creating new ones. Wait for old receive tasks to exit. Reduced receive task stack 4096 → 2048 (saves 2KB SRAM).

**Results:**
- Free SRAM at boot: **61KB** (up from 29KB)
- Full conversation cycle works: `listening → speaking → listening` ✅ (no crash!)
- Device survived 4+ consecutive conversation cycles (was crashing on the first one every time before fix)
- ai-server log confirms: STT → LLM → TTS → 64 Opus frames sent → played successfully

**Files modified:**
- `firmware/managed_components/78__esp-ml307/src/esp/esp_tcp.cc` — force cleanup stale sockets, reduce task stack 4096→2048
- `firmware/xiaozhi-esp32/main/application.cc` — WiFi power save fix (stay PERFORMANCE during session)

**Remaining issue: STT quality** — VAD threshold too low (0.025), picking up room noise. `max duration reached` hitting timeout before speech finishes. LLM responses incoherent because STT input is garbage. Segment limit (1) cuts off responses prematurely. This is a tuning issue, NOT a firmware crash issue.