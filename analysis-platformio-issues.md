# PlatformIO Arduino Builds on M5Stack CoreS3: Black Screen / Boot Loop Analysis

**Date:** 2026-08-18
**Scope:** Why PlatformIO Arduino builds produce black screen / boot loop on M5Stack CoreS3 while the factory ESP-IDF UIFlow2.0 firmware works perfectly.

---

## Executive Summary

The black screen / boot loop is **not** caused by a single catastrophic error. It is the result of **several compounding configuration problems** in the plaipin fork's `[env:m5stack-cores3]` environment. The most likely primary culprits, in order of severity:

1. **Missing `-mfix-esp32-psram-cache-issue` compiler flag** (present in the official M5CoreS3 library and in the plaipin fork's own `atoms3r` env, but **absent** from the `cores3` env). This is a GCC workaround for the ESP32-S3 PSRAM cache-coherency bug that causes crashes/black screens when code or data lives in PSRAM.
2. **M5Unified/M5GFX version mismatch**: the fork pins `M5Unified @ 0.1.17` (old) but PlatformIO resolves `M5GFX 0.2.27` (new). These are incompatible pairings and can cause display-init API breakage.
3. **Board choice `esp32s3box`** is suboptimal but not fatal — the fork correctly overrides the PSRAM memory type to `qio_qspi` (the CoreS3 PSRAM is **QUAD**, not octal).

The factory firmware works because it is a **completely different stack**: ESP-IDF v5.5.4 with an explicit `esp_lcd_ili9341` driver and manual AW9523 IO-expander init, not the Arduino/M5Unified/M5GFX stack.

---

## 1. Board Config Comparison: `esp32s3box` vs `esp32-s3-devkitc-1`

### Board JSON files (from `~/.platformio/platforms/espressif32/boards/`)

| Setting | `esp32s3box` (plaipin) | `esp32-s3-devkitc-1` (official M5CoreS3 lib) | `m5stack-cores3` (exists but unused) |
|---|---|---|---|
| `arduino.memory_type` | `qio_opi` | *(not set → defaults to `qio_qspi`)* | *(not set → defaults to `qio_qspi`)* |
| `arduino.partitions` | *(none)* | `default_8MB.csv` | `default_16MB.csv` |
| `extra_flags` | `-DARDUINO_ESP32_S3_BOX`, `-DBOARD_HAS_PSRAM`, `-DARDUINO_USB_MODE=1`, `-DARDUINO_USB_CDC_ON_BOOT=1` | `-DARDUINO_ESP32S3_DEV`, `-DARDUINO_USB_MODE=1`, `-DARDUINO_RUNNING_CORE=1`, `-DARDUINO_EVENT_RUNNING_CORE=1` | `-DARDUINO_M5STACK_CORES3`, `-DBOARD_HAS_PSRAM`, `-DARDUINO_USB_MODE=1`, `-DARDUINO_USB_CDC_ON_BOOT=1`, `-DARDUINO_RUNNING_CORE=1`, `-DARDUINO_EVENT_RUNNING_CORE=1` |
| `f_flash` | 80 MHz | 80 MHz | 80 MHz |
| `flash_mode` | `qio` | `qio` | `qio` |
| `variant` | `esp32s3box` | `esp32s3` | `m5stack_cores3` |
| `upload.flash_size` | 16 MB | 8 MB | 16 MB |

### Key differences and their impact

**Variant pin definitions** (`pins_arduino.h`):
- `esp32s3box`: SDA=41, SCL=40, MOSI=11, MISO=13, SCK=12, SS=10
- `m5stack_cores3`: SDA=12, SCL=11, MOSI=37, MISO=35, SCK=36, SS=15

**However, this is mostly irrelevant** for M5Unified/M5GFX because they use their **own internal pin tables** (e.g. `_pin_table_spi_sd` in M5Unified, and the hardcoded pins in M5GFX's `Panel_M5StackCoreS3`), not the Arduino variant pins. The variant only matters for raw `SPI`/`Wire` calls in user code.

**`ARDUINO_ESP32_S3_BOX` define**: harmless — it is not referenced by M5Unified, M5GFX, or the Arduino core for anything that affects the CoreS3 display.

**`memory_type`**: The `esp32s3box` board defaults to `qio_opi` (octal PSRAM). The plaipin fork **correctly overrides** this to `qio_qspi` via `board_build.arduino.memory_type = qio_qspi`. This is the right call — see §2.

**Conclusion**: The board choice is **not the root cause**. The fork's `qio_qspi` override is correct. The `esp32s3box` board is a workable (if unconventional) base, and the `-DARDUINO_M5STACK_CORES3` define correctly forces M5Unified/M5GFX to use the CoreS3 board config.

---

## 2. PSRAM: The CoreS3 PSRAM is QUAD, and the fork is missing a critical flag

### The CoreS3 PSRAM is QUAD (QSPI), NOT octal (OPI)

This is a common misconception. The M5Stack CoreS3 uses an **ESP32-S3-WROOM-1-N16R8** module (16 MB flash + 8 MB PSRAM), but the **PSRAM chip is QUAD (QSPI)**, not octal.

**Definitive confirmation** — [espressif/esp-brookesia issue #16](https://github.com/espressif/esp-brookesia/issues/16), titled *"M5 Stack Core S3 - incorrect configuration of PSRAM chip - should be QUAD"*:

> "The application is crashing during start, because PSRAM chip is different. `sdkconfig` in the repo is configured with `OCTAL` which is in ESP32-S3-BOX-3, but M5Stack CoreS3 should be `QUAD`. Please, update the sdkconfig, to `CONFIG_SPIRAM_MODE_QUAD=y`"

**Implication for the fork**: The plaipin fork's `board_build.arduino.memory_type = qio_qspi` (which sets `CONFIG_SPIRAM_MODE_QUAD`) is **correct** for the CoreS3. If it had left the `esp32s3box` default of `qio_opi`, the PSRAM would fail to initialize → boot loop. So the fork got this right.

### The missing `-mfix-esp32-psram-cache-issue` flag

The **official M5CoreS3 library** `platformio.ini` includes:
```ini
build_flags =
    -DESP32S3
    -DBOARD_HAS_PSRAM
    -mfix-esp32-psram-cache-issue
    -DARDUINO_USB_CDC_ON_BOOT=1
    -DARDUINO_USB_MODE=1
```

The **plaipin fork's `[env:m5stack-cores3]`** build_flags are:
```ini
build_flags =
    -DBOARD_HAS_PSRAM
    -DUSE_SERVO
    -DARDUINO_M5STACK_CORES3
    -DENABLE_WAKEWORD
    -DARDUINOJSON_DEFAULT_NESTING_LIMIT=100
    -DARDUINO_USB_CDC_ON_BOOT=1
    -DARDUINO_USB_MODE=1
```

**`-mfix-esp32-psram-cache-issue` is MISSING** from the cores3 env. Notably, the fork's **own** `[env:m5stack-atoms3r]` env *does* include it:
```ini
build_flags =
    -DESP32S3
    -DBOARD_HAS_PSRAM
    -mfix-esp32-psram-cache-issue
    ...
```

**Why this matters**: `-mfix-esp32-psram-cache-issue` is a GCC workaround for the ESP32-S3's PSRAM cache-coherency bug (IDFGH-12243, espressif/arduino-esp32#6789, #12480). When code or data is placed in PSRAM (which M5Unified/M5GFX and the esp32-camera library do heavily), the CPU cache can become stale/incoherent without this flag, causing:
- Random crashes / watchdog resets (boot loop)
- Garbage on the display / black screen
- Memory corruption

**This is the single most likely direct cause of the black screen / boot loop.** The official library includes it; the fork's cores3 env omits it.

---

## 3. Display Initialization: ILI9342C + AW9523 IO Expander

### How the display works on CoreS3

The CoreS3 display is an **ILI9342C** (ILI9341-compatible) driven over **SPI**, with its **reset line controlled by the AW9523 IO expander** at I2C address `0x58`. The display's **D/C line is shared with the SPI MISO line on GPIO35** — a hardware quirk that requires special handling.

### How M5GFX handles it (correctly)

M5GFX 0.2.27's `Panel_M5StackCoreS3` (in `M5GFX.cpp`) handles all of this:
- `rst_control()` writes to the AW9523 at I2C `0x58` register `0x03` bit `P1_1` to toggle the LCD reset.
- `cs_control()` performs the **GPIO35 MISO/D-C sharing trick**: it switches GPIO35 between `FSPIQ_OUT_IDX` (MISO input) and `SIG_GPIO_OUT_IDX` (D/C output) on every CS transition.
- The autodetect sequence (in `M5GFX::autodetect`) initializes the AW9523 registers, sets up the SPI bus (MOSI=37, MISO=35, SCLK=36, DC=35, CS=3, SPI mode 0, 3-wire), reads the panel ID (checks for `0xE3` = ILI9342), and creates the correct panel.

**This is all automatic** — M5Unified/M5GFX handle the display init when `M5.begin()` is called. No manual IO-expander init is needed for the display (the StackChan-BSP's `io_expander_init()` is for the **robot body's** PY32 IO expander, not the CoreS3 display).

### How the official ESP-IDF firmware does it (for comparison)

The official StackChan firmware (`main/hal/board/stackchan.cc`) does the same thing manually:
- `InitializeAw9523()` — creates `Aw9523` at I2C `0x58`
- `InitializeIli9342Display()` — uses `esp_lcd_new_panel_ili9341`, SPI pins MOSI=37, SCLK=36, CS=3, DC=35, SPI mode 2, 40 MHz, and calls `aw9523_->ResetIli9342()` to reset the display through the IO expander.

### Conclusion

The display init logic in M5GFX 0.2.27 is **correct**. If the display is black, it is **not** because M5GFX doesn't know how to init it — it's because the board was **not correctly detected as CoreS3**, or the **PSRAM cache issue** corrupted the init, or the **M5Unified/M5GFX version mismatch** broke the API.

---

## 4. Bootloader / Partition Differences

### Bootloader

The plaipin build uses the standard Arduino ESP32-S3 bootloader (`bootloader.bin`, 15 KB). The ESP32-S3 bootloader is **generic** — it does not depend on the board. It is compatible with the CoreS3.

### Partitions

The plaipin fork uses a custom `my_cores3_16MB.csv`:
```
nvs,      data, nvs,     0x9000,  0x5000,
otadata,  data, ota,     0xe000,  0x2000,
app0,     app,  ota_0,   0x10000, 0x640000,
app1,     app,  ota_1,   0x650000,0x640000,
spiffs,   data, spiffs,  0xc90000,0x340000,
fr,       data,        ,  0xfd0000, 0x20000,
coredump, data, coredump,0xFF0000,0x10000,
```
This is a valid 16 MB layout with OTA support. The official StackChan firmware uses a similar layout (with `phy_init` and `assets` partitions). **The partition table is not the cause.**

### Factory firmware offset

The factory UIFlow2 firmware is a single 16 MB image at offset `0x0` (a merged bootloader+partitions+app image). PlatformIO generates separate bootloader (`0x0`), partitions (`0x8000`), and app (`0x10000`). This is a **normal difference** and is not inherently incompatible — PlatformIO's `pio run -t upload` handles the offsets correctly.

**Conclusion**: Bootloader and partitions are **not the root cause**.

---

## 5. Framework Difference: ESP-IDF vs Arduino

The factory firmware is **ESP-IDF** (v5.5.4 for the official StackChan). The PlatformIO builds are **Arduino framework**.

**Arduino framework works fine on the CoreS3** — the official M5CoreS3 library and M5Unified both support it. There is no fundamental incompatibility. However, the Arduino framework's PSRAM handling is more fragile than ESP-IDF's, which is why the `-mfix-esp32-psram-cache-issue` flag is so important (see §2).

**Conclusion**: The framework difference is not the root cause, but it makes the PSRAM cache issue more likely to manifest.

---

## 6. M5Unified Version: 0.1.17 (pinned) vs M5GFX 0.2.27 (resolved)

### The version mismatch

The plaipin fork pins `m5stack/M5Unified @ 0.1.17` in `lib_deps`. However, PlatformIO resolves the **M5GFX** dependency to **0.2.27** (the latest), because M5Unified 0.1.17 declares `M5GFX >= 0.1.17` and PlatformIO picks the newest.

The compiled build confirms:
- `lib0d0/libM5Unified@0.1.17.a` (M5Unified 0.1.17)
- `lib952/libM5GFX.a` (M5GFX 0.2.27)

**This is a version mismatch**: M5Unified 0.1.17 (old, ~2023) paired with M5GFX 0.2.27 (new, ~2025). The M5Unified 0.2.20 (in the unversioned `M5Unified/` dir) correctly requires `M5GFX >= 0.2.27`, but it is **not** the version compiled.

### Why this matters

M5Unified and M5GFX are tightly coupled. M5Unified 0.1.17 was written against an older M5GFX API. When paired with M5GFX 0.2.27, there can be:
- ABI/API mismatches in display init calls
- Behavioral changes in board autodetect
- Incompatibilities in the `Panel_M5StackCoreS3` / `cs_control` handling

The official M5CoreS3 library uses `M5Unified@^0.1.6` (which resolves to a newer 0.1.x), and the current M5Unified is 0.2.20+. The fork's pin of `0.1.17` is stale.

**Conclusion**: The M5Unified 0.1.17 + M5GFX 0.2.27 mismatch is a **likely contributor** to the display failure, especially combined with the missing PSRAM flag.

---

## 7. StackChan-BSP

The `StackChan-BSP` repo (cloned to `/Volumes/1TBSSDClawd/stackchan-node/repos/StackChan-BSP/`) is an **Arduino library**, not a board definition. It:
- Depends on `M5Unified`, `M5GFX`, `IRremoteESP8266`, `M5Unit-NFC`
- Provides `M5StackChan.h` / `M5StackChan.cpp` with `M5StackChan.begin()` which calls `M5.begin()` then `io_expander_init()` (for the **robot body's** PY32 IO expander, servos, RGB LEDs, INA226 power monitor)
- Does **not** define a PlatformIO board or `platformio.ini`

**Conclusion**: StackChan-BSP is not the source of the black screen. It relies on M5Unified/M5GFX for the display, so it inherits whatever display-init problems the M5Unified/M5GFX pairing has.

---

## 8. What the Official StackChan `firmware/` Directory Contains

The official StackChan firmware (`/Volumes/1TBSSDClawd/stackchan-node/repos/StackChan/firmware/`) is a **pure ESP-IDF v5.5.4 project**:

- **Build system**: `idf.py build` (CMake-based ESP-IDF), with `fetch_repos.py` to pull dependencies (mooncake, smooth_ui_toolkit, xiaozhi-esp32, etc.)
- **`sdkconfig.defaults`**: `CONFIG_IDF_TARGET="esp32s3"`, `CONFIG_SPIRAM=y`, `CONFIG_SPIRAM_SPEED_80M=y`, `CONFIG_BOARD_TYPE_M5STACK_STACK_CHAN=y`, 16 MB flash, QIO
- **`partitions.csv`**: custom 16 MB layout with OTA + `assets` (SPIFFS)
- **`main/hal/board/stackchan.cc`**: explicit AW9523 + ILI9342 display init (see §3)
- **`main/main.cpp`**: `app_main()` with mooncake app framework

**How M5Stack officially builds Stack-chan firmware**: via ESP-IDF (`idf.py build`), not PlatformIO. The Arduino path is supported via the separate `StackChan-BSP` library and the `stackchan-arduino` library.

**Conclusion**: The official firmware is a completely different stack. Its success does not imply the Arduino/PlatformIO path should work identically — the Arduino path has its own configuration requirements (PSRAM flag, M5Unified/M5GFX versions) that the plaipin fork does not fully meet.

---

## Root Cause Summary

| # | Issue | Severity | Evidence |
|---|---|---|---|
| 1 | **Missing `-mfix-esp32-psram-cache-issue`** in `[env:m5stack-cores3]` | **High** | Official M5CoreS3 lib includes it; fork's own atoms3r env includes it; cores3 env omits it. ESP32-S3 PSRAM cache bug causes crashes/black screen. |
| 2 | **M5Unified 0.1.17 + M5GFX 0.2.27 version mismatch** | **Medium-High** | Fork pins M5Unified 0.1.17; M5GFX resolves to 0.2.27. Incompatible pairing. |
| 3 | **Board `esp32s3box`** (suboptimal but not fatal) | Low | Correctly overridden to `qio_qspi`; `ARDUINO_ESP32_S3_BOX` harmless. |
| 4 | **Missing `-DESP32S3`** define | Low | Not required by M5Unified (uses `CONFIG_IDF_TARGET_ESP32S3`), but used by esp32-camera and M5CoreS3 lib code. |

## Recommended Fixes

1. **Add `-mfix-esp32-psram-cache-issue`** (and `-DESP32S3`) to `[env:m5stack-cores3]` build_flags.
2. **Update M5Unified to a current version** (e.g. `m5stack/M5Unified @ ^0.2.20`) so it pairs correctly with M5GFX 0.2.27. Or pin a matching M5GFX version.
3. **Optionally switch to `board = m5stack-cores3`** (the dedicated CoreS3 board JSON) instead of `esp32s3box`, for correctness and to avoid the `qio_opi` default entirely.
4. **Verify the display init** by checking the serial log for `[Autodetect] board_M5StackCoreS3` (from M5GFX) — if it's missing, the board wasn't detected and the display won't init.

---

## References

- Official M5CoreS3 library `platformio.ini`: `https://github.com/m5stack/M5CoreS3/blob/main/platformio.ini`
- esp-brookesia issue #16 (CoreS3 PSRAM is QUAD): `https://github.com/espressif/esp-brookesia/issues/16`
- espressif/arduino-esp32 #6789 (PSRAM activation reboot): `https://github.com/espressif/arduino-esp32/issues/6789`
- espressif/arduino-esp32 #12480 (PSRAM cache trashed): `https://github.com/espressif/arduino-esp32/issues/12480`
- esp-idf #13293 (PSRAM framebuffers not flushed): `https://github.com/espressif/esp-idf/issues/13293`
- M5Unified issue #181 (CoreS3 samples not working): `https://github.com/m5stack/M5Unified/issues/181`
- M5Stack CoreS3 docs: `https://docs.m5stack.com/en/core/CoreS3`
- esp-bsp m5stack_core_s3 BSP: `https://github.com/espressif/esp-bsp/tree/master/bsp/m5stack_core_s3`
