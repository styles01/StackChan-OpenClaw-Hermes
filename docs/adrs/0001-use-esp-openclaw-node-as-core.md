# ADR-001: Use esp-openclaw-node as firmware core

## Status
Accepted

## Date
2026-08-17

## Context
We need to replace the default Stack-chan chatbot firmware (xiaozhi cloud) with a real OpenClaw node. Four repos were analyzed:

1. **esp-openclaw-node** (openclaw/esp-openclaw-node) — OpenClaw's official ESP32 thin-client firmware
2. **StackChan** (m5stack/StackChan) — robot body firmware (servos, face, sensors)
3. **xiaozhi-esp32** (78/xiaozhi-esp32) — current firmware on the device (what we're replacing)
4. **zclaw** (tnm/zclaw) — text-only ESP32 agent (minimal relevance)

The esp-openclaw-node firmware is a thin client: the device does zero LLM/STT/TTS locally. All intelligence lives on the OpenClaw Gateway. The device is just a WebRTC audio endpoint + command executor. This is exactly the architecture we want — Rosie's brain stays on the Gateway, the robot is just her hands and voice.

## Decision
Use esp-openclaw-node as the firmware core, stolen verbatim. Write a new CoreS3 board port for the M5Stack Stack-chan hardware.

Note: esp-openclaw-node ships with an example board port for a Waveshare ESP32-S3 dev board. That Waveshare example is NOT our hardware — our hardware is M5Stack CoreS3. The Waveshare example is only useful as a structural reference (how to fill in the board port contract struct). The actual CoreS3 hardware (AW88298 codec, ILI9342 display, TDM I2S) is completely different from the Waveshare board (ES8311 codec, SH8601 AMOLED, STD I2S).

## Consequences
- We get OpenClaw protocol support for free (WebSocket JSON-RPC, Ed25519 pairing, WebRTC audio)
- No LLM runs on the device — all intelligence is Gateway-side
- We need to write a CoreS3 board port from scratch (the Waveshare S3 example in esp-openclaw-node is a structural reference only — different display, codec, and I2S mode; ~40-50% code reuse, 100% port contract reuse)
- The xiaozhi.cloud connection is abandoned — Stack-chan talks directly to our Gateway
- The current MCP server prototype (`server.py`) becomes unnecessary long-term