# M5Stack CoreS3 Flashing — Lessons Learned (2026-08-18)

## The Saga

3 hours. Multiple failed flash attempts. One root cause: **the backup had no app firmware in it.**

### Timeline
1. Flashed "stock backup" with esptool → black screen, download mode
2. Reflashed with QIO mode → same result
3. Full erase + reflash → same result
4. Built clean firmware, flashed bootloader + partitions + app separately → same result
5. Found otadata pointing to empty app1 → wrote raw 0x00 byte → didn't work
6. Swarm research: otadata is CRC'd struct, raw bytes rejected
7. Erased otadata to 0xFF → still no boot
8. PlatformIO upload → still no boot
9. Swarm found M5Stack factory firmware on CDN → downloaded 16MB image
10. Full erase + factory image flash → **DEVICE BOOTS** ✅

### Root Cause
The "stock backup" at `backup_stackchan_stock.bin` was 16MB with valid headers, but the app partition at 0x10000 was **completely empty (all 0xFF)**. It was never a working firmware dump. Every flash attempt using it was doomed.

### What Worked
- Downloading M5Stack's factory firmware directly from their CDN
- Flashing with `--flash_mode dio --flash_freq 80m --flash_size detect` (same as M5Burner)
- Full chip erase before flashing (clean slate)

### Key Learnings
1. **Verify backups before trusting them** — check for 0xE9 magic at 0x10000
2. **Otadata is a CRC'd 32-byte struct** — not a simple partition index byte
3. **Use DIO flash mode** — bootloader switches to QIO itself
4. **M5Burner factory images are on M5Stack's CDN** — no GUI needed
5. **Subagent swarms crack problems fast** — 3 parallel agents found the answer in ~2 min
6. **CoreS3 has no factory partition** — OTA-only layout, bootloader falls back to ota_0
7. **Modern ESP-IDF partition subtypes** differ from pre-v4.0 values — don't use old references
8. **"LEDs on, black screen" = firmware not booting** — display is firmware-initialized

Full flashing guide with all commands: `/Volumes/1TBSSDClawd/stackchan-node/FLASHING-GUIDE.md`