# Reddit r/StackChan — "Openclaw + StackChan 🦞🦞" Thread Analysis

**Date:** 2026-08-17
**Source:** https://www.reddit.com/r/StackChan/comments/1tey028/stackchan_open_claw/
**Posted:** ~2 months ago (June 2026)
**Subreddit:** r/StackChan (small community, ~8 months old)

## Verdict: VERY HELPFUL — real-world OpenClaw + Stack-chan integration findings

## Thread Summary

A community member (OP) sharing their progress getting OpenClaw talking through Stack-chan. They used their OpenClaw agent to modify the stock firmware. Several commenters are also trying the same thing.

## Key Technical Findings

### 1. CRITICAL: codec→Write() silently fails on XiaoZhi firmware
**This is the most important finding in the thread.**

OP discovered that `esp_codec_dev_write()` (the standard codec audio output path) **silently fails** in the integrated XiaoZhi firmware. The root cause is an I2S format conflict with the duplex config.

**Their fix:**
- Bypass `codec->Write()` / `esp_codec_dev_write()` entirely
- Use the codec layer ONLY for amp/volume management (`EnableOutput` / `SetOutputVolume`)
- Write PCM **directly to the I2S TX channel** via `i2s_channel_write()`

**Why this matters for us:** Our `cores3_audio.c` uses `esp_codec_dev_write()` for audio output. If we hit the same silent failure, we need the same fix — bypass the codec and write directly to I2S. This could save us hours of debugging.

### 2. 16kHz WAV is the proven working sample rate
OP's working pipeline: `edge-tts → ffmpeg 16kHz mono WAV → POST /speak → I2S direct write → StackChan speaker`

Our firmware is already configured for 16kHz sample rate (we chose this vs StackChan's 24000). Good — matches their proven pipeline.

### 3. Mic quality is a known problem
OP and commenter both report mic quality issues:
- Recordings are small (11-26KB) — decent sizes but audio quality/volume is too low
- Whisper returns empty transcriptions — the mic gain is insufficient even with higher firmware gain
- One commenter switched to 11labs for transcription (possibly better than Whisper for low-quality audio)
- Commenter: "The mic quality is just too low for accurate transcriptions"

**Why this matters for us:** We should expect mic quality to be a challenge. Our TDM I2S with ES7210 and AEC might help (we're using 4-slot TDM with MIC1+MIC3 for AEC reference), but we should plan for gain/volume issues and test early.

### 4. Head-pet as push-to-talk
OP uses head-hold (petting the Stack-chan's head) as the trigger for voice recording:
- Hold head → lights red → records → release → packages WAV → sends to agent
- Green flash confirms successful recording

This is a different UX than wake word — it's manual push-to-talk via the touch sensor. Our Phase 1 uses WakeNet ("Hi ESP") but we could add head-pet as an alternative trigger in Phase 2.

### 5. Someone wrote custom firmware with Tailscale support
Commenter: "I just wrote custom firmware for openclaw with tailscale support. Was a royal pain in the ass but works well now."

This validates our approach — custom firmware for OpenClaw on Stack-chan is possible but challenging. Tailscale support is interesting (remote access without port forwarding).

### 6. Full STT+TTS pipeline works but mic quality is the bottleneck
OP's pipeline:
1. StackChan records (head-hold trigger) → WAV
2. Recording pulled by agent
3. Whisper STT → empty transcription (mic quality issue)
4. LLM responds with fallback text
5. TTS generates audio → sends to StackChan
6. StackChan speaks it

The pipeline WORKS end-to-end. The only issue is mic quality → STT accuracy.

### 7. People are buying Stack-chan specifically for OpenClaw integration
Multiple commenters: "I'm buying one specifically for this" / "Looking to buy specifically for this. Any progress update or a github link?"

There's real demand for a Stack-chan + OpenClaw solution. Our project could be the reference implementation.

## What This Means For Our Project

### Immediate Action Items
1. **Watch for the I2S codec write issue** — if our audio output silently fails, bypass `esp_codec_dev_write()` and write directly to `i2s_channel_write()`. Document this as a known gotcha in our board port.
2. **16kHz confirmed** — our 16kHz sample rate matches the proven working pipeline. Good choice.
3. **Plan for mic quality issues** — our TDM I2S + ES7210 with AEC is more sophisticated than what OP is using, but we should test mic quality early and have a gain/AGC plan.
4. **Head-pet as alternative trigger** — consider adding touch sensor (Si12T) as a push-to-talk fallback to wake word in Phase 2.

### What We're Doing Better
- **Native WebSocket + WebRTC** instead of HTTP POST + port proxy — lower latency, no proxy server
- **ESP-SR WakeNet** instead of manual head-hold — hands-free voice
- **TDM I2S with AEC** — proper echo cancellation for full-duplex (OP is using half-duplex)
- **Dual-OTA partitions** — firmware updates without bricking risk
- **Proper ESP-IDF build** instead of Arduino/PlatformIO modifications to stock firmware

### What We Should Watch For
- The `esp_codec_dev_write()` silent failure — this is the #1 risk for our Talk voice path
- Mic gain/quality — even with AEC, the ES7210 might need gain tuning
- I2S format conflicts with duplex config — exactly what OP hit

## Community Signal
- Real demand for Stack-chan + OpenClaw integration
- People are buying hardware specifically for this use case
- No one has published a clean reference implementation yet
- Our project could fill this gap