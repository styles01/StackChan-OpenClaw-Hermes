# ADR-003: Custom "Hey Rosie" wake word via ESP-SR/WakeNet

## Status
Accepted

## Date
2026-08-17

## Context
The default xiaozhi firmware uses "Hey XiaoZhi" (嗨小智) as the wake word, baked into an ESP-SR/WakeNet model running on the ESP32-S3 audio processor. This is on-device, offline detection — no cloud round-trip, which is why wake response is fast.

Options to change the wake word:
1. **ESP-SR custom model** — generate or train a WakeNet model for "Hey Rosie", compile into firmware
2. **Cloud-side wake word** — stream audio to Gateway and detect there (adds latency, bad UX)
3. **Keep default wake word** — "Hey XiaoZhi" (confusing, wrong identity)

ESP-SR (v2.4.7) supports custom wake words. The xiaozhi firmware already uses this system. The question is how to generate the model — Espressif may have an online generator, or we may need the ESP-SR training toolkit.

## Decision
Generate a custom "Hey Rosie" ESP-SR/WakeNet model and compile it into our firmware. Keep on-device offline wake word detection (no latency, works without network).

## Consequences
- Wake word is "Hey Rosie" — matches the robot's identity
- Still works offline (on-device detection, no cloud dependency for wake)
- Need to research model generation options (online generator vs training toolkit)
- One-time effort: 2-5 hours to generate and integrate the model
- May need to adjust wake sensitivity to balance false triggers vs miss rate