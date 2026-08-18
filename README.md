# Stack-chan Node — Rosie's Physical Robot Interface

## Goal
Make the M5Stack Stack-chan (ESP32-S3 robot) a node of Rosie. The robot connects to Rosie via the xiaozhi.me MCP broker, and Rosie exposes household management tools to the robot.

## Architecture
```
Stack-chan (ESP32-S3)
    ↕ (WebSocket, xiaozhi-esp32 firmware)
xiaozhi.me Cloud MCP Broker
    ↕ (WSS, MCP protocol — broker is client, we are server)
Rosie MCP Server (this machine, Python)
    ↕ (subprocess/MQTT/API calls)
Household systems (printer, fridge, Telegram, memory, calendar)
```

## Key Insight
The xiaozhi.me broker uses a REVERSED MCP setup — the broker is the MCP **client** and we are the MCP **server**. The broker sends `initialize` and `tools/list` TO us. We expose tools, the robot calls them.

## Connection
- **WSS URL:** `wss://api.xiaozhi.me/mcp/?token=<JWT>`
- **Token:** JWT with userId=847521, agentId=2253920, endpointId=agent_2253920
- **Token expiry:** ~2027 (exp=1818559455)
- **Protocol:** MCP 2024-11-05 over WebSocket (JSON-RPC)

## Hardware
- M5Stack Stack-chan (Kickstarter 2025 version)
- ESP32-S3 (CoreS3), 16MB Flash, 8MB PSRAM
- SCS0009 servos ×2 (yaw + pitch)
- GC0308 camera (320×240)
- ILI9342 display (320×240)
- FT6336/Si12T touch sensor
- 12× WS2812C RGB LEDs (via PY32 IO expander)
- Speaker + microphone

## Firmware
- Running xiaozhi-esp32 firmware (connected to xiaozhi.me cloud)
- NOT running the kisaragi-mochi/stackchan-mcp firmware (that's for local gateway)
- The cloud broker handles the device-side MCP client connection

## Rosie's Tools (exposed to Stack-chan)
1. `rosie_status` — household status summary
2. `rosie_say` — send voice/text to James, Gabby, or group via Telegram
3. `rosie_printer_status` — Bambu A1 Mini 3D printer state
4. `rosie_fridge_update` — update E-Ink fridge dashboard
5. `rosie_memory` — search Rosie's memory files
6. `rosie_time` — current household time (ET)
7. `rosie_echo` — connectivity test

## Status
- [x] Research complete — identified xiaozhi.me cloud broker architecture
- [x] Initial WSS connection tested — broker handshake works
- [x] Prototype MCP server script written (`/tmp/stackchan_rosie_server.py`)
- [ ] Production server script in this folder
- [ ] Proper auth token management (env var, not hardcoded)
- [ ] Background service (launchd or cron to keep it running)
- [ ] Test all tools from the actual robot
- [ ] Add more tools (calendar, weather, chore tracking)
- [ ] Two-way voice (robot mic → STT → Rosie → TTS → robot speaker)