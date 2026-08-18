# Adversarial Code Review — StackChan-OpenClaw-Hermes Firmware

**Reviewer:** Rosie (self-review, adversarial mode)
**Date:** 2026-08-17 21:16 MDT
**Files reviewed:** All source in `rosie-node/` against esp-openclaw-room-node contract

## Summary

The firmware compiles but has **5 real bugs** and **3 missing fields** that will cause runtime failures or missed functionality. The Waveshare reference board port reveals several patterns we got wrong or missed.

---

## BUGS FOUND

### BUG 1: I2C bus conflict — camera pins ALIAS system I2C (CRITICAL)

**File:** `cores3_board.h`
**Lines:** `CORES3_I2C_SDA = GPIO_NUM_12`, `CORES3_I2C_SCL = GPIO_NUM_11`

**Problem:** We defined the system I2C bus on GPIO12/GPIO11. But the GC0308 camera on CoreS3 ALSO uses GPIO12 (SDA) / GPIO11 (SCL) — confirmed by stackchan-mcp AND stackchan-gemini-firmware. When we enable the camera in Phase 2, the camera and system I2C will conflict on the same pins.

**However:** This is actually CORRECT for the current design. The CoreS3 has ONE shared I2C bus — AW88298, ES7210, AXP2101, FT6336, and the camera all share it. The camera driver must `M5.In_I2C.release()` before init and deinit after capture. Our I2C init on these pins is correct.

**Verdict:** NOT a bug — but document the shared-bus constraint clearly. The camera code in Phase 2 must acquire/release the bus, not init a second one.

### BUG 2: TDM I2S config — slot_mask includes ALL 4 slots but we only need 2 (REAL BUG)

**File:** `cores3_audio.c`
**Line:** `.slot_mask = (i2s_tdm_slot_mask_t)(I2S_TDM_SLOT0 | I2S_TDM_SLOT1 | I2S_TDM_SLOT2 | I2S_TDM_SLOT3)`

**Problem:** We enable all 4 TDM slots but only capture MIC1 + MIC3 (2 channels). The `record_channels = 2` and `channel_mask = 0x3` in the config struct tell the AFE to use 2 channels, but the I2S driver is set up for 4-slot TDM. This mismatch can cause:
- Extra DMA bandwidth consumption (2x what we need)
- The AFE receiving 4 channels of data when it expects 2
- Potential clock timing issues

**Fix:** The Waveshare reference uses STD I2S (not TDM) for both TX and RX with the ES7210. They use `I2S_STD_PHILIP_SLOT_DEFAULT_CONFIG` for both directions. This is simpler and proven to work. We should check if TDM is actually needed for the AEC reference channel or if STD stereo suffices.

**Action:** Keep TDM for now (CoreS3 ES7210 does use TDM for multi-mic), but reduce slot_mask to `I2S_TDM_SLOT0 | I2S_TDM_SLOT1` (2 slots, matching record_channels=2).

### BUG 3: Missing I2S TX/RX pair validation (REAL BUG)

**File:** `cores3_audio.c`
**Missing:** The Waveshare reference validates that TX and RX channels form a reciprocal pair:
```c
i2s_chan_info_t tx_info = {0};
i2s_chan_info_t rx_info = {0};
i2s_channel_get_info(tx, &tx_info);
i2s_channel_get_info(rx, &rx_info);
ESP_RETURN_ON_FALSE(tx_info.pair_chan == rx && rx_info.pair_chan == tx, ...);
```

**Problem:** We don't validate the TX/RX pair. If the pair isn't reciprocal, audio capture and playback will be misaligned. This is a proven pattern from the reference.

**Fix:** Add pair validation after channel init, before enable.

### BUG 4: TDM TX + STD RX on same I2S port — mode conflict (REAL BUG)

**File:** `cores3_audio.c`
**Problem:** We init TX as STD mode and RX as TDM mode on the same I2S port (I2S_NUM_0). The ESP-IDF I2S driver does NOT support mixed modes (STD + TDM) on the same port. The second init will either fail or silently misconfigure the first channel.

**The Waveshare reference uses STD for BOTH TX and RX** — same config struct, same init call. This is the proven pattern.

**Fix:** Use STD I2S for both TX and RX. The ES7210 can operate in STD stereo mode — we don't need TDM for 2-channel capture. TDM is for 4+ channel arrays. With MIC1 + MIC3 we can use STD stereo with the appropriate slot config.

This is a SIGNIFICANT change — rewrite the entire RX section to use `i2s_channel_init_std_mode` instead of `i2s_channel_init_tdm_mode`.

### BUG 5: Display `set_brightness` is a no-op stub (MINOR)

**File:** `cores3_display.c`
**Problem:** `cores3_display_set_brightness` does nothing — returns ESP_OK without setting brightness. The CoreS3 backlight is controlled via the AW9523 IO expander, which we haven't wired up.

**Impact:** Display is always at full brightness. Not a crash bug, but a missing feature.

**Fix:** Add a TODO comment (already there) and leave for Phase 2. The contract requires the function to exist — a no-op stub is acceptable for Phase 1.

### BUG 6: `heap_caps_aligned_alloc` for PSRAM DMA may fail on ILI9342 (POTENTIAL)

**File:** `cores3_display.c`
**Problem:** We allocate draw buffers with `MALLOC_CAP_DMA | MALLOC_CAP_SPIRAM`. The Waveshare reference explicitly says "SH8601 QSPI cannot DMA from PSRAM" and uses `MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL`. The ILI9342 uses SPI (not QSPI), and SPI CAN DMA from PSRAM on ESP32-S3 — but only if the SPI driver is configured for it. Need to verify this actually works.

**Risk:** If PSRAM DMA doesn't work for SPI, the display will show garbage or crash. The Waveshare uses internal RAM for safety.

**Action:** Test on hardware. If it fails, switch to `MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL` and reduce buffer rows.

---

## MISSING FIELDS IN CONFIG STRUCT

### MISSING 1: `services` port not populated (REAL ISSUE)

**File:** `main.c`
**Problem:** The `esp_openclaw_room_node_config_t` struct has a `services` field with:
- `prepare_runtime` — called early in startup
- `prepare_network` — called before Wi-Fi init
- `register_commands` — called to register custom commands

We leave this as `{0}` (all NULL). The room-node code checks for NULL before calling, so it won't crash. But we miss the opportunity to:
- Initialize the AW9523 IO expander (prepare_runtime)
- Register custom robot commands like `rosie.look`, `rosie.emote` (register_commands)

**Fix for Phase 1:** Leave as NULL — the robot works without custom commands. Add a `prepare_runtime` callback in Phase 2 to init the IO expander for display backlight.

### MISSING 2: `storage` port not populated (MINOR)

**File:** `main.c`
**Problem:** The `storage` field is `{0}`. This means no file commands are registered. Not a crash bug — just no file storage capability.

**Fix:** Leave for Phase 3. Not needed for voice test.

### MISSING 3: `display.ctx` and `audio.ctx` not set (MINOR)

**File:** `main.c`
**Problem:** We don't set `.ctx` on the display and audio port structs. The Waveshare reference also doesn't set them (they use `(void)ctx` in their callbacks). This is fine — the ctx is optional for passing board-specific state to callbacks.

---

## BUILD PLAN ISSUES

### ISSUE 1: Build plan says "port StackChan servo/motion" but UART1 conflict not tested

**File:** BUILD_PLAN.md, Phase 2
**Problem:** We claim "UART1 @ 1Mbps GPIO6/7 (NO CONFLICT — console on USB Serial/JTAG)". This is correct per the sdkconfig (`CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y`). But the StackChan-BSP servo driver uses `Serial1` which maps to UART1. We need to verify the GPIO6/7 pin mapping matches the CoreS3 hardware.

**Action:** Verify in Phase 2. Not a current issue.

### ISSUE 2: Wake word model path not configured

**File:** sdkconfig.defaults
**Problem:** We set `CONFIG_SR_WN_WN9_HIESP=y` but don't configure the model partition path. The `model` partition (2MB SPIFFS at 0xC20000) needs to be flashed with the wake word model. The esp-openclaw-node may handle this automatically — need to verify.

**Action:** Check if esp-openclaw-node auto-loads the model or if we need to flash it separately.

### ISSUE 3: No WiFi credentials provisioning path

**File:** main.c
**Problem:** We don't set any WiFi credentials. The esp-openclaw-room-node code handles this via:
1. NVS-stored credentials from previous provisioning
2. USB console: `wifi set <ssid> <passphrase>`
3. `gateway setup-code <code>` for gateway pairing

This is fine — the room-node handles it. But we should document that first boot requires USB console provisioning.

---

## FIXES APPLIED

### Fix 1: TDM → STD I2S for both TX and RX (BUG 4 + BUG 2)

Rewrite `cores3_audio.c` to use STD I2S for both TX and RX, matching the Waveshare reference pattern. This is the proven working configuration.

### Fix 2: Add TX/RX pair validation (BUG 3)

Add the pair validation check from the Waveshare reference.

### Fix 3: Reduce TDM slot_mask (BUG 2 — moot if switching to STD)

If we keep TDM, reduce to 2 slots. If we switch to STD, this is resolved.

---

## WHAT WE CAN BUILD WITHOUT HARDWARE

1. ✅ Fix the audio driver (TDM → STD, add pair validation)
2. ✅ Add `prepare_runtime` callback for AW9523 IO expander init (stub for now)
3. ✅ Add `register_commands` callback with custom robot commands (stub)
4. ✅ Add display backlight control via AW9523 (stub — need I2C address)
5. ✅ Create servo driver skeleton (SCSCL on UART1, non-blocking gesture queue)
6. ✅ Create camera driver skeleton (esp_camera init/deinit, GC0308 pin config)
7. ✅ Create LED driver skeleton (WS2812C via AW9523, emotion state machine)
8. ✅ Add WiFi provisioning documentation
9. ✅ Create a provisioning README
10. ✅ Verify the build still compiles after fixes