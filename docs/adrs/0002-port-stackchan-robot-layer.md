# ADR-002: Port StackChan robot layer on top of esp-openclaw-node

## Status
Accepted

## Date
2026-08-17

## Context
esp-openclaw-node gives us the OpenClaw connection and audio pipeline, but it has no concept of the Stack-chan robot body — servos, LCD face, camera, or touch sensors. The M5Stack StackChan firmware has all of these as cleanly separable drivers.

StackChan robot layer components:
- **SCSCL serial servos** (UART1 @ 1Mbps) — yaw + pitch, spring-damper motion, 3D lookAtPoint IK
- **LVGL face/avatar** — eye/mouth/bubble widgets, emotion states, blink/breath modifiers
- **GC0308 camera** — capture → JPEG → POST to AI endpoint
- **BMI270 IMU** — shake/pickup detection
- **Si12T head touch** — petting gestures

## Decision
Port the StackChan robot layer (servos, face, camera, sensors) as command handlers on top of the esp-openclaw-node core. The robot layer receives commands from the Gateway (via the OpenClaw protocol) and translates them into physical actions.

## Consequences
- We reuse proven hardware drivers instead of writing from scratch
- Servo/face/camera become Gateway-controllable — Rosie can move the head, show expressions, take photos
- Need to resolve UART1 conflict (StackChan uses UART1 for servos — check if esp-openclaw-node needs it)
- Need to map esp-openclaw-node talk states (idle/listening/speaking) to StackChan face emotions
- Build target is ESP-IDF v5.5.4+ (both repos use compatible versions)