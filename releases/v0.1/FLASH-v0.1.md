# Stack-chan OpenClaw Hermes — v0.1 Firmware

## What This Is

Firmware for M5Stack CoreS3 that turns Stack-chan into a voice agent client. Connects to an ai-server via WebSocket, streams Opus audio, and bridges to an OpenClaw or Hermes agent.

**Version:** 0.1 (Aug 19, 2026)
**Hardware:** M5Stack CoreS3 (ESP32-S3, 16MB flash)
**Firmware base:** Official Stack-chan v1.4.3 (ESP-IDF v5.5.4)
**Custom wake word:** "Hey Agent A" (WakeNet9)

## Flashing

### Option A: ESP-IDF (recommended)

```bash
# Activate ESP-IDF v5.5.4
export IDF_PATH=/path/to/esp-idf
. "$IDF_PATH/export.sh"

cd firmware
idf.py set-target esp32s3
idf.py -p /dev/cu.usbmodemXXXX flash
```

### Option B: esptool (no ESP-IDF needed)

```bash
esptool.py --chip esp32s3 -p /dev/cu.usbmodemXXXX -b 460800 \
  --before=default_reset --after=hard_reset \
  write_flash --flash_mode dio --flash_size 16MB --flash_freq 80m \
  0x0     bootloader.bin \
  0x8000  partition-table.bin \
  0xd000  ota_data_initial.bin \
  0x20000 stack-chan.bin
```

## Flash Layout

| Address | File | Size |
|---------|------|------|
| 0x00000 | bootloader.bin | 24KB |
| 0x08000 | partition-table.bin | 3KB |
| 0x0d000 | ota_data_initial.bin | 8KB |
| 0x20000 | stack-chan.bin | 3.7MB |
| 0xE00000 | wake word model (flashed separately) | 1MB |

## Wake Word

Custom "Hey Agent A" WakeNet9 model is flashed separately to the model partition at 0xE00000 using `tools/wake_word_flasher.py`. The stock "Hi Stack Chan" wake word is disabled in this build.

## ai-server Setup

The firmware connects to an ai-server via WebSocket. You'll need to run the ai-server (in `ai-server/`) on a machine on your network:

```bash
cd ai-server
cp .env.example .env  # edit with your agent config
npx tsx src/index.ts
```

The device connects to `ws://<server-hostname>.local:8765/ws` via mDNS.

## Factory Restore

If something goes wrong, flash the original M5Stack UIFlow2 firmware:

```bash
esptool.py --chip esp32s3 -p /dev/cu.usbmodemXXXX -b 460800 \
  write_flash --flash_mode dio --flash_size 16MB --flash_freq 80m \
  0x0 cores3_factory_uiflow2_v2.5.1.bin
```

Factory firmware: `https://m5burner-cdn.m5stack.com/firmware/6a5bd498069e4b079eb4ee097990cf9f.bin`

## Known Issues (v0.1)

- Volume may need manual tuning per device
- Wake word model may load from assets partition on some boots
- ai-server is ~4000 lines of TypeScript
- PlatformIO/Arduino build path not working (use ESP-IDF)

## License

MIT