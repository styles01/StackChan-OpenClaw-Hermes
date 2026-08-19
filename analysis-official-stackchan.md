# Analysis: Official M5Stack StackChan Firmware vs. PlatformIO Arduino Fork

**Date:** 2026-08-18
**Analyzed repo:** `/Volumes/1TBSSDClawd/stackchan-node/repos/StackChan/` (official, commit `b72b3ed`, branch `main`)
**BSP repo:** `/Volumes/1TBSSDClawd/stackchan-node/repos/StackChan-BSP/` (cloned, commit HEAD)
**Fork compared:** `/Volumes/1TBSSDClawd/stackchan-node/repos/plaipin-openclaw-stackchan/firmware/`

---

## 1. Firmware Architecture — ESP-IDF, NOT Arduino/PlatformIO

The official StackChan firmware is a **native ESP-IDF (Espressif IoT Development Framework) project** — a fork of the open-source **xiaozhi-esp32** AI-assistant firmware. It is **not** an Arduino sketch and does **not** use PlatformIO.

**Evidence:**
- `firmware/CMakeLists.txt` — standard ESP-IDF project file:
  ```cmake
  cmake_minimum_required(VERSION 3.16)
  set(PROJECT_VER "1.4.3")
  include($ENV{IDF_PATH}/tools/cmake/project.cmake)
  project(stack-chan)
  ```
- `firmware/main/CMakeLists.txt` — `idf_component_register(...)` with `PRIV_REQUIRES` for `esp_pm`, `esp_psram`, `esp_driver_*`, `bt`, `fatfs`, `ArduinoJson`, `esp-now`, `mooncake`, etc.
- `firmware/sdkconfig.defaults` — ESP-IDF sdkconfig (target `esp32s3`, 16MB flash, QIO, PSRAM, NimBLE, LVGL 9.4, esp-sr wake word).
- `firmware/partitions.csv` — ESP-IDF partition table.
- `firmware/main/idf_component.yml` — IDF Component Manager manifest (pulls ~50 managed components).
- `firmware/main/Kconfig.projbuild` — custom Kconfig menus (Board Type, Language, Wake Word, WiFi provisioning, etc.).
- `firmware/main/main.cpp` — `extern "C" void app_main(void)` (ESP-IDF entry point), not `setup()/loop()`.

**Build system:** ESP-IDF's `idf.py` (CMake + Ninja under the hood). No `platformio.ini` anywhere in the official repo.

**Framework stack (layered):**
1. **ESP-IDF v5.5.4** (required `>=5.5.2` per idf_component.yml)
2. **xiaozhi-esp32 v2.2.4** — the base AI-assistant framework (cloned by `fetch_repos.py`, patched by `patches/xiaozhi-esp32.patch`)
3. **Mooncake** (v2.3.3) + **mooncake_log** (v1.5.0) + **smooth_ui_toolkit** (v2.12.0) — M5Stack's UI framework (from Forairaaaaa)
4. **LVGL 9.4.0** + **esp_lvgl_port 2.7.0** — graphics
5. **esp-sr 2.3.0** — wake word / speech recognition
6. **esp_audio_codec / esp_codec_dev** — audio
7. **esp-now** — wireless remote control
8. **ArduinoJson 7.4.2** — JSON (used as a component, not the Arduino framework)

**Dependency fetching:** `firmware/fetch_repos.py` reads `firmware/repos.json` and clones/pins 6 git repos into `components/` and `xiaozhi-esp32/`:
- `Forairaaaaa/mooncake` @ v2.3.3
- `Forairaaaaa/mooncake_log` @ v1.5.0
- `Forairaaaaa/smooth_ui_toolkit` @ v2.12.0
- `78/xiaozhi-esp32` @ v2.2.4 (+ patch)
- `bblanchon/ArduinoJson` @ v7.4.2
- `espressif/esp-now` @ commit c33383d

The remaining ~50 dependencies (esp_lcd_*, esp_io_expander_*, esp-sr, lvgl, esp32-camera, esp_video, etc.) are pulled automatically by the **IDF Component Manager** from `idf_component.yml`.

---

## 2. CoreS3 Board Configuration (in the official firmware)

The board is defined in `firmware/main/hal/board/stackchan.cc` (class `M5StackCoreS3Board : public WifiBoard`), selected via Kconfig `CONFIG_BOARD_TYPE_M5STACK_STACK_CHAN=y` (which maps to `BOARD_TYPE "m5stack-stack-chan"` in CMakeLists).

**Board definition approach:** The official firmware does **NOT** use M5Unified or M5CoreS3 libraries. It drives the hardware **directly** with ESP-IDF drivers (`esp_lcd_*`, `esp_driver_i2c`, `esp_driver_spi`, `esp_driver_i2s`, `esp_video`, `esp_codec_dev`). This is the key architectural difference from the Arduino fork.

### Display (ILI9342C) — `InitializeIli9342Display()`
- **SPI bus:** `SPI3_HOST`, MOSI=GPIO37, SCLK=GPIO36, MISO=NC, `max_transfer_sz = 320*240*2`
- **Panel IO:** CS=GPIO3, DC=GPIO35, `spi_mode=2`, `pclk_hz=40MHz`, 8-bit cmd/param
- **Panel driver:** `esp_lcd_new_panel_ili9341` (the ILI9342C is register-compatible with ILI9341), `rgb_ele_order=BGR`, `bits_per_pixel=16`
- **Reset:** `reset_gpio_num=NC` — reset is done via the **AW9523 IO expander** (`aw9523_->ResetIli9342()`)
- **Post-init:** `esp_lcd_panel_invert_color(panel, true)` (ILI9342C needs color inversion), swap_xy/mirror from config
- **Display class:** `StackChanAvatarDisplay` (extends `LvglDisplay`), LVGL RGB565, 320×240, PSRAM image cache (2MB if ≥8MB PSRAM)

### AW9523 IO Expander — `Aw9523` class (I2C addr 0x58)
- I2C bus 1, SDA=GPIO12, SCL=GPIO11
- Registers written: P0=0x02, P1=0x03, CONFIG_P0=0x04, CONFIG_P1=0x05, GCR=0x11, LEDMODE_P0=0x12, LEDMODE_P1=0x13
- **ResetIli9342():** toggles P1 bit to reset the display
- **ResetAw88298():** toggles P0 bit to reset the audio amp

### AXP2101 PMIC — `Pmic` class (I2C addr 0x34)
- Power management, battery level, charging detection
- **Backlight is controlled via AXP2101 DLDO1** (not a GPIO): `CustomBacklight` → `Pmic::SetBrightness()` writes reg 0x99 (20–28) and toggles DLDO1 (reg 0x90 bit 7)
- Charge current set to 700mA

### Touch — `Ft6336` class (I2C addr 0x38)
- FT6336 capacitive touch, polled via 20ms `esp_timer` (not interrupt-driven)
- Reads 6 bytes from reg 0x02, feeds into `hal_bridge::set_touch_point()`

### Camera — `StackChanCamera` (GC0308, DVP)
- Uses `esp_video` (V4L2-style) + `esp32-camera` component
- DVP pins: D0=39, D1=40, D2=41, D3=42, D4=15, D5=16, D6=48, D7=47, VSYNC=46, HREF=38, PCLK=45, XCLK=NC (external 20MHz crystal)
- sdkconfig: `CONFIG_CAMERA_GC0308=y`, `CONFIG_CAMERA_GC0308_DVP_YUV422_320X240_20FPS=y`

### Audio — `CoreS3AudioCodec`
- **Output:** AW88298 I2S amp (I2C addr 0x5A), I2S0, MCLK=0, BCLK=34, WS=33, DOUT=13
- **Input:** ES7210 4-ch ADC (I2C addr 0x40), DIN=14, 24kHz, input_reference for AEC
- Uses `esp_audio_codec` + `esp_codec_dev` components

### I2C bus
- Single I2C master bus (port 1), SDA=12, SCL=11, internal pullups, glitch_ignore=7
- Devices: AXP2101 (0x34), AW9523 (0x58), FT6336 (0x38), AW88298 (0x5A), ES7210 (0x40)

### PSRAM
- `CONFIG_SPIRAM=y`, 80MHz, `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=512`, reserve 64KB internal
- LVGL image cache sized from `esp_psram_get_size()` (2MB if ≥8MB)

### Servos / RGB / NFC / IR / touch panel
- Servos: SCSCL (serial bus servos) via `FTServo_Arduino` driver (in `hal/drivers/`)
- RGB LEDs, NFC, IR, 3-zone touch: handled in the HAL layer (`hal_servo.cpp`, `hal_mcp.cpp`, etc.) and via the robot body's PY32 IO expander (in the BSP, not the main firmware)

---

## 3. Why PlatformIO Arduino Builds Fail (Black Screen / Boot Loop)

The fork at `plaipin-openclaw-stackchan/firmware/` uses:
```ini
[env:m5stack-cores3]
platform = espressif32@6.3.2
board = esp32s3box          # ← WRONG BOARD
framework = arduino
board_build.arduino.memory_type = qio_qspi
board_build.arduino.partitions = my_cores3_16MB.csv
board_build.f_flash = 80000000L
build_flags = -DARDUINO_M5STACK_CORES3 ...
```

### Root cause: `board = esp32s3box` is the WRONG board definition

`esp32s3box` is the **Espressif ESP32-S3-Box** — a completely different physical board from the M5Stack CoreS3. Its variant `pins_arduino.h` defines hardware that does not exist on the CoreS3:

| Resource | esp32s3box variant | Actual CoreS3 hardware |
|----------|-------------------|------------------------|
| I2C SDA/SCL | 41 / 40 | **12 / 11** |
| Wire1 I2C | 8 / 18 | — |
| TFT (display) | SPI: DC=4, CS=5, MOSI=6, CLK=7, BL=45, RST=48 | SPI3: CS=3, DC=35, MOSI=37, SCLK=36, reset via AW9523 |
| Touch | TT21100 (0x24) | **FT6336 (0x38)** |
| Audio DAC | ES8311 (0x18) | **AW88298 (0x5A)** |
| Audio ADC | ES7210 (0x40) | ES7210 (0x40) ✓ |
| IMU | ICM-42607-P (0x68) | BMI270 |
| IO expander | none | **AW9523 (0x58)** |

**Why M5Unified still "works" at the API level:** The fork defines `-DARDUINO_M5STACK_CORES3`, which makes M5Unified internally override the pin tables with the correct CoreS3 mappings (I2C 12/11, display SPI 36/37/35, etc. — confirmed in `M5Unified.cpp` lines 89, 154, 205, 320). So `M5.Display` and `M5.Lcd` get the right pins.

**Why it still black-screens / boot-loops despite the macro:**

1. **Wrong linker script & memory layout.** The `esp32s3box` board JSON uses `esp32s3_out.ld` and defaults to `qio_opi` (Octal PSRAM). The fork overrides to `qio_qspi` (Quad PSRAM) — which is correct for CoreS3 — but the **linker script and variant still come from the esp32s3box board**, and the PSRAM/flash init sequence in the Arduino core is driven by the board's `memory_type`. Any mismatch between the flash/PSRAM mode the bootloader was built for and the actual hardware causes a **boot loop** (the ROM can't initialize PSRAM correctly, or the app crashes on PSRAM access).

2. **Partition table mismatch (see §6).** The fork's `my_cores3_16MB.csv` uses `app0`/`app1` at offset `0x10000` with 6.25MB each and a `spiffs` partition at `0xc90000`. The official firmware uses `ota_0`/`ota_1` at `0x20000` with 4.94MB each and an `assets` (spiffs) partition at `0xA00000`. If the fork's partition table doesn't match what the bootloader/OTA expects, or if the app image is flashed to the wrong offset, you get a boot loop.

3. **No proper display reset / backlight init.** The CoreS3 display reset is done through the **AW9523 IO expander** and backlight through the **AXP2101 DLDO1**. M5Unified handles this internally for CoreS3, but if the AW9523 init fails or the AXP2101 isn't brought up in the right order, the display stays black even though the MCU is running. The official firmware explicitly sequences: I2C → AXP2101 → AW9523 → SPI → display → camera → touch.

4. **Flash mode / speed.** The fork sets `f_flash = 80000000L` (80MHz) and `qio`. The CoreS3 uses 16MB QIO flash at 80MHz — this part is likely OK, but combined with the wrong board's bootloader config it can cause instability.

5. **The fork's `main.cpp` is a trivial "Hello from CoreS3" test** that calls `M5.begin(cfg)` with `cfg.output_power = true` etc. It does not initialize the AW9523, AXP2101 backlight, or display reset explicitly — it relies entirely on M5Unified's CoreS3 board init. If M5Unified's board detection or the underlying variant config is off, nothing displays.

**Bottom line:** The official firmware avoids all of this by **not using Arduino/M5Unified at all** — it drives the CoreS3 hardware directly with ESP-IDF drivers and a hand-written board class (`M5StackCoreS3Board`) that explicitly initializes every peripheral in the correct order. The PlatformIO fork's failure is fundamentally a **board-definition mismatch** (`esp32s3box` ≠ CoreS3) compounded by partition-table and PSRAM/linker config differences.

---

## 4. UIFlow2 Support

**The official firmware repo itself contains NO UIFlow2 / MicroPython code.** The only Python files are build tooling:
- `firmware/fetch_repos.py` — dependency fetcher
- `firmware/scan_secrets.py` — secret scanner

**How UIFlow2 support actually works:** The README states the product "supports programming via Arduino, UiFlow2, and other methods." This is a **separate firmware** — UIFlow2 is M5Stack's MicroPython-based IDE that flashes its own runtime (UIFlow firmware) onto the device. It is **not** part of this open-source repo. The factory UIFlow2.0 firmware that "works perfectly" on the CoreS3 is a different binary from the xiaozhi-based firmware in this repo.

**The Arduino path** is provided by the separate **StackChan-BSP** (see §8), not by this repo.

So: UIFlow2 = separate M5Stack runtime, flashed independently. This repo's firmware is the "AI Agent / factory" firmware.

---

## 5. Build Instructions (from `firmware/README.md`)

**Tools required:**
- **ESP-IDF v5.5.4** (specifically for esp32s3): `https://docs.espressif.com/projects/esp-idf/en/v5.5.4/esp32s3/index.html`
- **Python 3** (for `fetch_repos.py` and IDF build scripts)
- **CMake + Ninja** (bundled with ESP-IDF)
- **git** (for dependency fetching)

**Build steps:**
```bash
# 1. Fetch dependencies (clones mooncake, xiaozhi-esp32, ArduinoJson, esp-now, etc.)
python3 ./fetch_repos.py

# 2. Build (requires IDF env sourced: . $IDF_PATH/export.sh)
idf.py build

# 3. Flash
idf.py flash
```

**Host-side tests** (motion math, no hardware):
```bash
cmake -S tests -B build-host-tests
cmake --build build-host-tests
ctest --test-dir build-host-tests --output-on-failure
```

**Customization:** `firmware/CMakeLists.txt` auto-loads a git-ignored `sdkconfig.defaults.local` overlay to pin `CONFIG_STACKCHAN_SERVER_URL`, `CONFIG_OTA_URL`, etc. for self-hosted deployments.

**Note:** The official repo does NOT ship a prebuilt binary in the firmware folder. (The `remote/code/` folder does contain a prebuilt ESP-NOW remote controller binary: `k151-R-StackChan-RemoteControl-ESPNow-v1.2-jyy-20260617_0x0.bin`.)

---

## 6. Partition Table Comparison

### Official (`firmware/partitions.csv`) — ESP-IDF OTA layout
```
nvs,      data, nvs,     0x9000,    0x4000,
otadata,  data, ota,     0xd000,    0x2000,
phy_init, data, phy,     0xf000,    0x1000,
ota_0,    app,  ota_0,   0x20000,   0x4f0000,   (4.94 MB)
ota_1,    app,  ota_1,   ,          0x4f0000,   (4.94 MB)
assets,   data, spiffs,  0xA00000,  4M,         (4 MB assets)
coredump, data, coredump,,          0x10000,
```
- **Two OTA app slots** (ota_0/ota_1) for A/B OTA updates
- **`assets` spiffs partition (4MB)** for downloadable assets (fonts, emoji, sounds)
- App starts at `0x20000`

### Fork (`my_cores3_16MB.csv`) — Arduino-style layout
```
nvs,      data, nvs,     0x9000,  0x5000,
otadata,  data, ota,     0xe000,  0x2000,
app0,     app,  ota_0,   0x10000, 0x640000,   (6.25 MB)
app1,     app,  ota_1,   0x650000,0x640000,   (6.25 MB)
spiffs,   data, spiffs,  0xc90000,0x340000,   (3.25 MB)
fr,       data,        ,  0xfd0000, 0x20000,
coredump, data, coredump,0xFF0000,0x10000,
```
- App starts at `0x10000` (vs official `0x20000`)
- Larger app slots (6.25MB vs 4.94MB), smaller spiffs (3.25MB vs 4MB)
- Has an `fr` partition (factory reset data) the official lacks
- No `phy_init` partition

**Key differences:** Different app offset (`0x10000` vs `0x20000`), different partition sizes, and the fork's `spiffs` is used for the Arduino filesystem while the official uses `assets` for downloadable content. If the fork's bootloader/partition table is flashed inconsistently with the app, or if the app image is built for a different partition layout than what's on the chip, you get a boot loop.

---

## 7. Dependencies

### Official firmware (ESP-IDF)
- **Base framework:** xiaozhi-esp32 v2.2.4 (forked + patched)
- **UI:** Mooncake v2.3.3, mooncake_log v1.5.0, smooth_ui_toolkit v2.12.0, LVGL 9.4.0, esp_lvgl_port 2.7.0
- **Audio:** esp_audio_codec 2.4.1, esp_codec_dev 1.5.4, esp_audio_effects 1.2.1, adc_mic, adc_battery_estimation
- **Speech:** esp-sr 2.3.0 (wake word + AFE)
- **Display:** esp_lcd_ili9341 1.2.0 (for ILI9342C), plus many other esp_lcd_* for other boards
- **Camera:** esp32-camera 2.1.4, esp_video 1.3.1, esp_image_effects
- **IO:** esp_io_expander_tca9554, esp_io_expander_tca95xx_16bit, custom_io_expander_ch32v003
- **Touch:** esp_lcd_touch_ft5x06, gt911, gt1151, cst816s, cst9217, st7123
- **Network:** esp-now, 78/esp-wifi-connect, mqtt, websocket
- **JSON:** ArduinoJson 7.4.2
- **Other:** led_strip, button, knob, esp_mmap_assets, esp_new_jpeg, bmi270_sensor, otto-emoji-gif, etc.

**Notably:** The official firmware does **NOT** depend on M5Unified or M5CoreS3. It uses raw ESP-IDF drivers. This is deliberate — it gives full control over the CoreS3 hardware.

### StackChan-BSP (Arduino, separate repo)
- **M5Unified** (required)
- **M5GFX** (required)
- **IRremoteESP8266** (required)
- **M5Unit-NFC** (required)

### Fork (PlatformIO Arduino)
- M5Unified 0.1.17, M5GFX, ESP8266Audio, ArduinoJson 7, ESP32WebServer, SimpleVox, FastLED, esp8266FTPServer, esp32-camera, YAMLDuino, stackchan-arduino, SCServo, ServoEasing, Dynamixel2Arduino, ESP32Servo

---

## 8. StackChan-BSP (Board Support Package)

Cloned to `/Volumes/1TBSSDClawd/stackchan-node/repos/StackChan-BSP/`. This is the **Arduino** board support package (separate from the ESP-IDF firmware).

**Identity:**
- `library.json`: name `StackChan-BSP`, version 1.1.0, `frameworks: arduino`, `platforms: espressif32`
- `library.properties`: `architectures=esp32`, depends on M5Unified, IRremoteESP8266, M5Unit-NFC
- License: MIT

**Structure:**
- `src/M5StackChan.h` / `M5StackChan.cpp` — main class `M5StackChan_Class` (namespace `m5`)
- `src/drivers/PY32IOExpander/` — PY32 IO expander (robot body: servo power, RGB LEDs)
- `src/drivers/Si12T/` — Si12T (proximity/ambient light sensor)
- `src/drivers/FTServo_Arduino/` — SCSCL serial-bus servo driver
- `src/utils/motion/` — servo/motion control
- `src/utils/touch_sensor/` — 3-zone touch panel
- `src/utils/settings/` — NVS settings
- `src/utils/uitk/` — smooth_ui_toolkit (UI toolkit)
- `src/utils/compat/` — make_unique compat
- `examples/` — Servo (BasicMovement, HomeCalibration, Dance), TouchSensor, NFC (Emulation, Detect), INA226, IR (Receive, Send), RGB_LED

**Board init (`M5StackChan_Class::begin()`):**
```cpp
M5.begin();          // M5Unified init (CoreS3)
TouchSensor.begin();
io_expander_init();  // PY32 IO expander (servo power, RGB)
servo_init();        // SCSCL servos
ina226_init();       // battery monitor
```

**Key difference from the ESP-IDF firmware:** The BSP uses **M5Unified** (`M5.begin()`) to initialize the CoreS3, then adds StackChan-specific peripherals (PY32 IO expander for the robot body, servos, touch, RGB). The ESP-IDF firmware in the main repo bypasses M5Unified entirely and drives the hardware directly.

**Note:** The BSP's `M5StackChan_Class` uses the **PY32 IO expander** for the robot body (servo power, RGB LEDs), whereas the main ESP-IDF firmware's `stackchan.cc` uses the **AW9523** for the CoreS3 head (display reset, audio reset). These are two different IO expanders on different parts of the hardware.

---

## 9. Summary / Key Takeaways

1. **The official firmware is ESP-IDF (C++), not Arduino/PlatformIO.** It's a fork of xiaozhi-esp32 with a custom M5Stack StackChan board class. Build with `idf.py build` / `idf.py flash` using ESP-IDF v5.5.4.

2. **The CoreS3 is driven directly with ESP-IDF drivers** (esp_lcd_ili9341 for the ILI9342C, esp_driver_i2c for AW9523/AXP2101/FT6336, esp_video for the camera, esp_audio_codec for AW88298/ES7210). No M5Unified/M5CoreS3 dependency.

3. **The PlatformIO fork fails because `board = esp32s3box` is the wrong board definition.** The esp32s3box variant has different pins, linker script, PSRAM/flash memory type, and partition expectations than the CoreS3. Even though `-DARDUINO_M5STACK_CORES3` makes M5Unified override the pin tables, the underlying board's linker/PSRAM/flash config and the partition table mismatch cause black screen / boot loop.

4. **UIFlow2 is a separate M5Stack runtime**, not part of this repo. The repo's Python files are only build tooling.

5. **Partition tables differ significantly** (app offset `0x20000` vs `0x10000`, different sizes, `assets` vs `spiffs`).

6. **StackChan-BSP is the Arduino path** — a separate library using M5Unified + M5GFX + IRremoteESP8266 + M5Unit-NFC, with examples for servos, touch, NFC, IR, RGB, and INA226.

### Recommendation for fixing the PlatformIO fork
To make the Arduino fork work on CoreS3, the correct approach is to use the **M5Stack CoreS3 board definition** (not `esp32s3box`), or better, use the **StackChan-BSP** library which is designed for this exact hardware. The `esp32s3box` board must be replaced with a proper CoreS3 board config (correct variant, linker, PSRAM `qio_qspi`, and a partition table matching the CoreS3's 16MB layout with the app at the right offset).
