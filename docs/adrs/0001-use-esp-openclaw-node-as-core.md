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
Use esp-openclaw-node as the firmware core, stolen verbatim. Adapt the Waveshare ESP32-S3 board port template for the M5Stack CoreS3 hardware.

## Consequences
- We get OpenClaw protocol support for free (WebSocket JSON-RPC, Ed25519 pairing, WebRTC audio)
- No LLM runs on the device — all intelligence is Gateway-side
- We need to write a CoreS3 board port (but the Waveshare S3 example is 90% there)
- The xiaozhi.cloud connection is abandoned — Stack-chan talks directly to our Gateway
- The current MCP server prototype (`server.py`) becomes unnecessary long-term