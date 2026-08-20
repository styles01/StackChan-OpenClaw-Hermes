# M5Stack CoreS3 Flashing Guide — Hard-Won Lessons

> Born from a 3-hour recovery saga. Read this BEFORE touching the device with esptool.

## Device Info

- **Board:** M5Stack CoreS3 (ESP32-S3, 16MB flash, ILI9342C display)
- **Serial port (macOS):** `/dev/cu.usbmodemXXXX` (native USB-OTG, not CH340)
- **Single USB port:** CoreS3 uses native USB-OTG — no UART/CH340 second port
- **Flash type:** Quad (QIO, 4 data lines) — set in eFuse
- **Flash size:** 16MB (0x1000000)
- **No flash encryption, no secure boot** — confirmed via `get_security_info`

## Critical Lessons

### 1. ALWAYS verify backup integrity before flashing
The "stock backup" at `backups/backup_stackchan_stock.bin` was 16MB and had valid headers — but the app partition at 0x10000 was **completely empty (all 0xFF)**. It was never a working firmware dump. Flashing it 3+ times was doomed — you can't boot what isn't there.

**Before trusting any backup:**
```bash
# Check bootloader magic at 0x0
esptool.py --port /dev/cu.usbmodemXXXX read_flash 0x0 1 /tmp/boot_magic.bin
xxd /tmp/boot_magic.bin  # Must be: e9

# Check app magic at 0x10000
esptool.py --port /dev/cu.usbmodemXXXX read_flash 0x10000 1 /tmp/app_magic.bin
xxd /tmp/app_magic.bin  # Must be: e9 — if it's ff, the partition is EMPTY
```

### 2. Otadata is NOT a simple byte — it has a CRC
The otadata partition (at 0xe000, 0x2000 size) is NOT a partition index byte. It contains **two copies** (at sector start and +0x100) of a 32-byte structured entry:

```c
typedef struct {
    uint32_t ota_seq;        // 4 bytes — sequence number
    uint8_t  seq_label[20];  // 20 bytes — label
    uint32_t ota_state;      // 4 bytes — state
    uint32_t crc;             // 4 bytes — CRC32 of ota_seq
} esp_ota_select_entry_t;    // 32 bytes total
```

The bootloader validates each copy with a CRC check. **Any entry whose CRC doesn't match is treated as invalid (same as 0xFF).** Writing a raw `0x00` or `0x01` byte to select a partition DOES NOT WORK — it's CRC-invalid and ignored.

**To select app0 (ota_0 at 0x10000):** Erase the otadata partition entirely (set to 0xFF). The bootloader will fall back to ota_0 when otadata is invalid/empty:
```bash
esptool.py --port /dev/cu.usbmodemXXXX --chip esp32s3 erase_region 0xe000 0x2000
```

### 3. Partition table subtypes — use MODERN ESP-IDF values
The ESP-IDF subtype values changed in v4.0 (2020). Many old guides use outdated values.

**Modern (correct) values:**
```
APP type (0x00):
  0x00 = factory
  0x10 = ota_0      (OTA_MIN + 0)
  0x11 = ota_1      (OTA_MIN + 1)
  0x12 = ota_2
  0x20 = test

DATA type (0x01):
  0x00 = otadata (OTA)
  0x01 = phy
  0x02 = nvs
  0x03 = coredump
  0x04 = nvs_keys
  0x06 = fat/undefined
  0x81 = fat
  0x82 = spiffs/littlefs
```

**OLD (deprecated, DO NOT USE):**
```
otadata = 0x40  ← WRONG, that's the old value
ota_1   = 0x20  ← WRONG, that's the old value
spiffs  = 0x81  ← WRONG, that's now fat
```

### 4. CoreS3 partition layout — OTA only, no factory partition
The M5Stack CoreS3 uses an **OTA-only layout** — there is NO factory partition (subtype 0x00). The bootloader handles this: when otadata is invalid (0xFF), it falls back to ota_0 (app0 at 0x10000).

Standard M5Stack partition table (`my_cores3_16MB.csv`):
```
# Name,   Type, SubType, Offset,  Size, Flags
nvs,      data, nvs,     0x9000,  0x5000,
otadata,  data, ota,     0xe000,  0x2000,
app0,     app,  ota_0,   0x10000, 0x640000,
app1,     app,  ota_1,   0x650000,0x640000,
spiffs,   data, spiffs,  0xc90000,0x340000,
fr,       data,        , 0xfd0000, 0x20000,
coredump, data, coredump,0xFF0000,0x10000,
```

### 5. The display (ILI9342C) only works if firmware fully boots
"LEDs on, black screen" means the firmware isn't completing boot. The display is initialized entirely in firmware via M5GFX/M5Unified — if the app doesn't start, the screen stays black even though power LEDs are on. This is NOT a hardware problem.

### 6. Download mode detection
If serial shows:
```
rst:0x15 (USB_UART_CHIP_RESET),boot:0x20 (DOWNLOAD(USB/UART0))
waiting for download
```
The device is in **ROM download mode** — it never found a valid app to boot. Check:
1. Is there actually an app at 0x10000? (read flash and check for 0xE9 magic)
2. Is otadata pointing to an empty partition? (erase otadata to fix)
3. Is the partition table valid? (check for 0xAA50 magic at 0x8000)

## How to Flash — Step by Step

### Option A: Flash factory firmware from M5Stack CDN (safest recovery)

The M5Stack factory firmware (UIFlow2.0) is downloadable directly from M5Stack's CDN — no M5Burner GUI needed.

```bash
ESPTOOL="/Users/<your-host>/.platformio/packages/tool-esptoolpy/esptool.py"
PORT="/dev/cu.usbmodemXXXX"

# 1. Download factory firmware (16MB, UIFlow2.0 v2.5.1)
curl -L -o /tmp/cores3_factory.bin \
  "https://m5burner-cdn.m5stack.com/firmware/6a5bd498069e4b079eb4ee097990cf9f.bin"

# 2. Verify headers
python3 -c "
with open('/tmp/cores3_factory.bin', 'rb') as f:
    f.seek(0); print(f'Bootloader: 0x{f.read(1)[0]:02X}')  # 0xE9
    f.seek(0x8000); print(f'Partition: {f.read(2).hex()}') # aa50
    f.seek(0x10000); print(f'App: 0x{f.read(1)[0]:02X}')  # 0xE9
"

# 3. Full erase
python3 "$ESPTOOL" --port "$PORT" --chip esp32s3 erase_flash

# 4. Flash factory image (same as M5Burner)
python3 "$ESPTOOL" --port "$PORT" --baud 921600 --chip esp32s3 \
  --before default_reset write_flash -z \
  --flash_mode dio --flash_freq 80m --flash_size detect \
  0x0 /tmp/cores3_factory.bin

# 5. Hard reset
python3 "$ESPTOOL" --port "$PORT" --chip esp32s3 run
```

**Note:** Use `--flash_mode dio` (NOT qio). The bootloader starts in DIO mode then switches to QIO during boot. The image header says DIO (mode 2) but the eFuse is set to quad. This is normal for ESP32-S3.

### Option B: Flash custom firmware (PlatformIO)

```bash
cd <repo-root>/stackchan-node/repos/plaipin-openclaw-stackchan/firmware
PIO="/Users/<your-host>/.platformio/penv/bin/pio"

# Build
$PIO run -e m5stack-cores3

# Flash (handles bootloader + partitions + app)
$PIO run -e m5stack-cores3 -t upload --upload-port /dev/cu.usbmodemXXXX

# Or flash manually with esptool (full control)
ESPTOOL="/Users/<your-host>/.platformio/packages/tool-esptoolpy/esptool.py"
PORT="/dev/cu.usbmodemXXXX"

python3 "$ESPTOOL" --port "$PORT" --baud 921600 --chip esp32s3 \
  --before default_reset write_flash \
  --flash_mode dio --flash_freq 80m --flash_size 16MB \
  0x0 .pio/build/m5stack-cores3/bootloader.bin \
  0x8000 .pio/build/m5stack-cores3/partitions.bin \
  0x10000 .pio/build/m5stack-cores3/firmware.bin
```

**After flashing custom firmware, erase otadata to ensure boot from app0:**
```bash
python3 "$ESPTOOL" --port "$PORT" --chip esp32s3 erase_region 0xe000 0x2000
```

### Option C: Full erase + reflash (nuclear option)

```bash
ESPTOOL="/Users/<your-host>/.platformio/packages/tool-esptoolpy/esptool.py"
PORT="/dev/cu.usbmodemXXXX"

# Full erase
python3 "$ESPTOOL" --port "$PORT" --chip esp32s3 erase_flash

# Flash all three components
python3 "$ESPTOOL" --port "$PORT" --baud 921600 --chip esp32s3 \
  --before default_reset write_flash \
  --flash_mode dio --flash_freq 80m --flash_size 16MB \
  0x0 bootloader.bin \
  0x8000 partitions.bin \
  0x10000 firmware.bin

# Erase otadata (force boot from app0)
python3 "$ESPTOOL" --port "$PORT" --chip esp32s3 erase_region 0xe000 0x2000

# Reset
python3 "$ESPTOOL" --port "$PORT" --chip esp32s3 run
```

## How to Read Serial Output

```bash
python3 -c "
import serial, time, sys
ser = serial.Serial('/dev/cu.usbmodemXXXX', 115200, timeout=2)
start = time.time()
while time.time() - start < 30:
    data = ser.read(4096)
    if data:
        sys.stdout.write(data.decode('utf-8', errors='replace'))
        sys.stdout.flush()
ser.close()
print()
print('=== END ===')
"
```

## How to Back Up Device Flash (PROPERLY)

```bash
ESPTOOL="/Users/<your-host>/.platformio/packages/tool-esptoolpy/esptool.py"
PORT="/dev/cu.usbmodemXXXX"

# Full 16MB dump
python3 "$ESPTOOL" --port "$PORT" --baud 460800 read_flash 0x0 0x1000000 /tmp/backup.bin

# VERIFY the backup is valid before trusting it!
python3 -c "
with open('/tmp/backup.bin', 'rb') as f:
    f.seek(0); boot = f.read(1)[0]
    f.seek(0x10000); app = f.read(1)[0]
    print(f'Bootloader magic: 0x{boot:02X} ({\"OK\" if boot == 0xE9 else \"EMPTY/BAD\"})')
    print(f'App magic: 0x{app:02X} ({\"OK\" if app == 0xE9 else \"EMPTY/BAD\"})')
    if app == 0xFF:
        print('WARNING: App partition is EMPTY! This backup is NOT bootable!')
"
```

## Useful esptool Commands

```bash
# Connect / identify chip
esptool.py --port /dev/cu.usbmodemXXXX --chip esp32s3 flash_id

# Get security info (flash encryption / secure boot status)
esptool.py --port /dev/cu.usbmodemXXXX --chip esp32s3 get_security_info

# Read flash at specific offset
esptool.py --port /dev/cu.usbmodemXXXX read_flash <offset> <length> /tmp/out.bin

# Erase specific region
esptool.py --port /dev/cu.usbmodemXXXX --chip esp32s3 erase_region <offset> <length>

# Full chip erase
esptool.py --port /dev/cu.usbmodemXXXX --chip esp32s3 erase_flash

# Run (hard reset)
esptool.py --port /dev/cu.usbmodemXXXX --chip esp32s3 run
```

## M5Burner Factory Firmware URLs

No M5Burner GUI needed — download directly from M5Stack's CDN:

| Version | URL |
|---------|-----|
| UIFlow2.0 v2.5.1 (latest) | `https://m5burner-cdn.m5stack.com/firmware/6a5bd498069e4b079eb4ee097990cf9f.bin` |
| UIFlow2.0 v2.4.9 | `https://m5burner-cdn.m5stack.com/firmware/adb40bb8e3e8842c31e5dc59c192edef.bin` |
| UIFlow2.0 v2.4.4 (stable) | `https://m5burner-cdn.m5stack.com/firmware/7bff7a5d962a43adc84ac36e9d1311c8.bin` |

M5Burner download page: `https://docs.m5stack.com/en/download?id=m5burner`
Factory restore guide: `https://docs.m5stack.com/en/guide/restore_factory/m5cores3`

## What NOT To Do

1. **Don't flash a backup without verifying it has a real app at 0x10000** — check for 0xE9 magic
2. **Don't write raw bytes to otadata** — it's a CRC'd 32-byte struct, not a partition index
3. **Don't use `--flash_mode qio` when flashing** — use `dio` (the bootloader switches to QIO itself)
4. **Don't assume "no serial output" means the device is bricked** — check if it's in download mode first
5. **Don't flash untested custom firmware without testing boot paths in a harness first**
6. **Don't use outdated partition subtype values** (0x40 for otadata, 0x20 for ota_1) — use modern ESP-IDF values
7. **Don't blame the hardware** — if esptool connects and flash_id works, the chip is fine

## Flash Layout Quick Reference

```
0x00000     Bootloader       (0xE9 magic, ~15KB)
0x08000     Partition Table  (0xAA50 magic, ~3KB)
0x09000     NVS              (5KB)
0x0e000     Otadata          (8KB, CRC'd 32-byte struct × 2 copies)
0x10000     App0 / ota_0     (6.25MB, 0xE9 magic = valid app)
0x650000    App1 / ota_1     (6.25MB, empty = 0xFF)
0xc90000    SPIFFS/LittleFS  (3.25MB)
0xfd0000    FR (data)        (128KB)
0xff0000    Coredump         (64KB)
```

## ESP32-S3 Boot Flow (simplified)

1. ROM bootloader runs (built into chip)
2. ROM reads eFuse for flash mode → starts in DIO, switches to QIO
3. ROM loads second-stage bootloader from 0x0
4. Bootloader reads partition table at 0x8000
5. Bootloader reads otadata at 0xe000
   - If otadata valid (CRC passes): boot selected OTA partition
   - If otadata invalid (0xFF or bad CRC): look for factory partition
   - If no factory partition: fall back to ota_0 (app0 @ 0x10000)
6. Bootloader validates app image (magic 0xE9, checksum)
7. Bootloader jumps to app entry point
8. App runs → initializes display, WiFi, etc.

If any step fails, device drops into ROM download mode (`waiting for download`).

## PlatformIO Root Cause (Aug 18, 2026 — subagent analysis)

All PlatformIO Arduino builds produced black screen / boot loop on CoreS3. Root cause confirmed:

1. **Missing `-mfix-esp32-psram-cache-issue`** — ESP32-S3 errata CACHE-126 causes random crashes under PSRAM load. The plaipin fork's `atoms3r` env had this flag but the `cores3` env did NOT. **Most likely direct cause of boot loop.**
2. **Wrong board `esp32s3box`** — I2C pins wrong (SDA=41/SCL=40 vs CoreS3's SDA=12/SCL=11), wrong touch controller (TT21100 vs FT6336), wrong audio DAC (ES8311 vs AW88298/ES7210). M5GFX hard-codes display pins so screen CAN init, but any Arduino Wire/SPI/pin usage fails → crash.
3. **M5Unified 0.1.17 mismatched with M5GFX 0.2.27** — incompatible version pairing causes runtime failures.

**Fix:** `board = esp32-s3-devkitc-1`, add `-mfix-esp32-psram-cache-issue -DESP32S3 -DBOARD_HAS_PSRAM` to build_flags, update M5Unified to `^0.2.20`.

## Official Build Method (the RIGHT way)

The official StackChan firmware is **ESP-IDF v5.5.4** (not Arduino/PlatformIO). Instructions from `StackChan/firmware/README.md`:

```bash
cd repos/StackChan/firmware/
python3 ./fetch_repos.py          # Fetch dependencies
idf.py build                      # Build
idf.py flash                      # Flash to device

# Host-side tests (NO HARDWARE NEEDED)
cmake -S tests -B build-host-tests
cmake --build build-host-tests
ctest --test-dir build-host-tests --output-on-failure
```

## UIFlow2 Path (easiest — no build system)

Device already runs UIFlow2 factory firmware. `haraisao/stackchan-uiflow2` provides complete Python Stack-chan implementation:
- Face, voice, motors, camera, web server
- Dialog backends: Gemini, OpenAI, LM Studio, Dify (adding OpenClaw = 1 new Python file)
- Deploy via `https://uiflow2.m5stack.com/` web IDE

---
*Last updated: 2026-08-18 21:25 MDT — root cause found, three paths documented.*