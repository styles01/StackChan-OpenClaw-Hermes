#!/usr/bin/env python3
"""
Wake Word Flasher for Stack-chan CoreS3
========================================
Packs and flashes ESP-SR wake word models to the device's model partition.

Three modes:
  list    — show available pre-trained wake word models
  pack    — pack a model into a flashable srmodels.bin
  flash   — pack + flash a model to the device (no firmware reflashing)
  sdcard  — generate SD card folder format (for CONFIG_MODEL_IN_SDCARD)

Usage:
  python3 wake_word_flasher.py list
  python3 wake_word_flasher.py pack --model wn9_heyivy_tts2
  python3 wake_word_flasher.py flash --model wn9_heyivy_tts2 [--port /dev/cu.usbmodem211301]
  python3 wake_word_flasher.py sdcard --model wn9_heyivy_tts2 --output /sdcard-models/

Available English models:
  wn9_heyivy_tts2    — "Hey, Ivy"
  wn9_heykira_tts3   — "Hey, Kira"
  wn9_heywanda_tts   — "Hey, Wanda"
  wn9_heywillow_tts  — "Hey, Willow"
  wn9_hijason_tts2   — "Hi, Jason"
  wn9_alexa          — "Alexa"
  wn9_jarvis_tts     — "Jarvis"
  wn9_sophia_tts     — "Sophia"
  wn9_hifairy_tts2  — "Hi, Fairy"
  wn9_hiandy_tts2   — "Hi, Andy"
  wn9_hijolly_tts2   — "Hi, Jolly"
  wn9_hijoy_tts      — "Hi, Joy"
  wn9_hitelly_tts    — "Hi, Telly"
  wn9_hiwalle_tts2  — "Hi, Walle"
  wn9_hixiaoxing_tts — "Hi, Xiaoxing"
  wn9_himfive        — "Hi, M Five"
  wn9_hilili_tts     — "Hi, Lili"
  wn9_himiaomiao_tts — "Hi, Miaomiao"
  wn9_computer_tts   — "Computer"
  wn9_bluechip_tts2  — "Blue Chip"
  wn9_astrolabe_tts  — "Astrolabe"
  wn9_sophia_tts_v1  — "Sophia (v1)"

Default (current):
  wn9_histackchan_tts3 — "Hi, Stack Chan"
"""

import argparse
import os
import struct
import sys
import shutil
import subprocess

# Paths
# Tool lives at stackchan-node/tools/wake_word_flasher.py
# FIRMWARE_DIR = stackchan-node/ (parent of tools/)
# Models are under stackchan-node/firmware/managed_components/...
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FIRMWARE_DIR = os.path.dirname(SCRIPT_DIR)  # stackchan-node/
ESP_SR_MODELS = os.path.join(FIRMWARE_DIR, "firmware", "managed_components", "espressif__esp-sr", "model", "wakenet_model")
OUTPUT_DIR = os.path.join(FIRMWARE_DIR, "build", "wake_word")
PARTITIONS_CSV = os.path.join(FIRMWARE_DIR, "partitions.csv")

# Model partition config — we'll add this to the partition table
MODEL_PARTITION_NAME = "model"
MODEL_PARTITION_OFFSET = 0xE00000  # After assets (0xA00000 + 4MB = 0xE00000)
MODEL_PARTITION_SIZE = 0x100000    # 1MB — fits multiple models (292KB each)

# English wake word models available in ESP-SR
ENGLISH_MODELS = {
    "wn9_heyivy_tts2":     "Hey, Ivy",
    "wn9_heykira_tts3":    "Hey, Kira",
    "wn9_heywanda_tts":    "Hey, Wanda",
    "wn9_heywillow_tts":   "Hey, Willow",
    "wn9_hijason_tts2":    "Hi, Jason",
    "wn9_alexa":           "Alexa",
    "wn9_jarvis_tts":      "Jarvis",
    "wn9_sophia_tts":      "Sophia",
    "wn9_sophia_tts_v1":   "Sophia (v1)",
    "wn9_hifairy_tts2":    "Hi, Fairy",
    "wn9_hiandy_tts2":     "Hi, Andy",
    "wn9_hijolly_tts2":    "Hi, Jolly",
    "wn9_hijoy_tts":       "Hi, Joy",
    "wn9_hitelly_tts":     "Hi, Telly",
    "wn9_hiwalle_tts2":    "Hi, Walle",
    "wn9_hixiaoxing_tts":  "Hi, Xiaoxing",
    "wn9_himfive":         "Hi, M Five",
    "wn9_hilili_tts":      "Hi, Lili",
    "wn9_himiaomiao_tts":  "Hi, Miaomiao",
    "wn9_computer_tts":    "Computer",
    "wn9_bluechip_tts2":   "Blue Chip",
    "wn9_astrolabe_tts":   "Astrolabe",
}

ALL_MODELS = dict(ENGLISH_MODELS)
ALL_MODELS["wn9_histackchan_tts3"] = "Hi, Stack Chan (current default)"


def struct_pack_string(string, max_len):
    """Pack string to fixed-length binary, padded with null bytes."""
    assert len(string) <= max_len, f"String '{string}' too long: {len(string)} > {max_len}"
    out = string.encode('ascii')
    out += b'\x00' * (max_len - len(out))
    return out


def read_file(path):
    with open(path, "rb") as f:
        return f.read()


def pack_model_to_srmodels(model_dir, out_file):
    """
    Pack a single wake word model directory into srmodels.bin format.
    Format: { model_num: int, model_info_t[], file_data[] }
    model_info_t: { model_name: char[32], file_num: int, file_name: char[32], file_start: int, file_len: int }[]
    """
    # Collect files from the model directory
    model_name = os.path.basename(model_dir)
    files = {}
    for fname in os.listdir(model_dir):
        fpath = os.path.join(model_dir, fname)
        if os.path.isfile(fpath):
            files[fname] = read_file(fpath)

    model_num = 1
    file_num = len(files)
    header_len = 4 + model_num * (32 + 4) + file_num * (32 + 4 + 4)

    # Build header
    out = struct.pack('<I', model_num)  # model number
    data_bin = b''

    out += struct_pack_string(model_name, 32)  # model name
    out += struct.pack('<I', file_num)  # file number

    for fname, fdata in files.items():
        out += struct_pack_string(fname, 32)  # file name
        if not data_bin:
            out += struct.pack('<I', header_len)  # file start
            data_bin = fdata
        else:
            out += struct.pack('<I', header_len + len(data_bin))  # file start
            data_bin += fdata
        out += struct.pack('<I', len(fdata))  # file length

    assert len(out) == header_len
    out += data_bin

    os.makedirs(os.path.dirname(out_file), exist_ok=True)
    with open(out_file, "wb") as f:
        f.write(out)

    return out_file, len(out)


def cmd_list(args):
    """List all available wake word models."""
    print("\n📋 Available wake word models:\n")
    print(f"{'Model ID':<30} {'Wake Word':<25} {'Size':<10}")
    print("-" * 65)

    for model_id, wake_word in sorted(ALL_MODELS.items()):
        model_path = os.path.join(ESP_SR_MODELS, model_id)
        if os.path.exists(model_path):
            size = sum(os.path.getsize(os.path.join(model_path, f))
                      for f in os.listdir(model_path)
                      if os.path.isfile(os.path.join(model_path, f)))
            size_str = f"{size/1024:.0f}KB"
        else:
            size_str = "NOT FOUND"
        marker = " ← current" if model_id == "wn9_histackchan_tts3" else ""
        print(f"{model_id:<30} {wake_word:<25} {size_str:<10}{marker}")

    print(f"\n💡 English models: {len(ENGLISH_MODELS)}")
    print(f"📁 Models directory: {ESP_SR_MODELS}")
    print()


def cmd_pack(args):
    """Pack a wake word model into srmodels.bin."""
    model_id = args.model
    model_path = os.path.join(ESP_SR_MODELS, model_id)

    if not os.path.exists(model_path):
        print(f"❌ Model not found: {model_id}")
        print(f"   Path checked: {model_path}")
        print(f"\nAvailable models:")
        for mid in sorted(ALL_MODELS):
            print(f"   {mid}")
        sys.exit(1)

    out_file = args.output or os.path.join(OUTPUT_DIR, f"srmodels_{model_id}.bin")
    out_file, size = pack_model_to_srmodels(model_path, out_file)

    print(f"✅ Packed: {model_id}")
    print(f"   Wake word: {ALL_MODELS.get(model_id, 'unknown')}")
    print(f"   Output: {out_file}")
    print(f"   Size: {size/1024:.0f}KB")
    print(f"\nTo flash: python3 wake_word_flasher.py flash --model {model_id}")


def cmd_flash(args):
    """Pack and flash a wake word model to the device."""
    model_id = args.model
    port = args.port or "/dev/cu.usbmodem211301"
    model_path = os.path.join(ESP_SR_MODELS, model_id)

    if not os.path.exists(model_path):
        print(f"❌ Model not found: {model_id}")
        sys.exit(1)

    # Pack the model
    out_file = os.path.join(OUTPUT_DIR, f"srmodels_{model_id}.bin")
    out_file, size = pack_model_to_srmodels(model_path, out_file)
    print(f"✅ Packed: {model_id} ({size/1024:.0f}KB)")

    # Check if esptool is available
    esptool = shutil.which("esptool.py") or shutil.which("esptool")
    if not esptool:
        # Try ESP-IDF's esptool
        idf_path = os.environ.get("IDF_PATH", "/Volumes/1TBSSDClawd/esp-idf")
        esptool_py = os.path.join(os.path.expanduser("~/.espressif/python_env/idf5.5_py3.9_env"),
                                  "bin", "esptool.py")
        if os.path.exists(esptool_py):
            esptool = esptool_py
        else:
            print(f"❌ esptool not found. Activate ESP-IDF first:")
            print(f"   export IDF_PATH=/Volumes/1TBSSDClawd/esp-idf")
            print(f"   . $IDF_PATH/export.sh")
            sys.exit(1)

    # Check if port exists
    if not os.path.exists(port):
        print(f"❌ Serial port not found: {port}")
        print(f"   Is the device plugged in?")
        sys.exit(1)

    # Flash the model to the model partition
    print(f"📡 Flashing to {port} at offset 0x{MODEL_PARTITION_OFFSET:X}...")

    cmd = [
        esptool, "--chip", "esp32s3",
        "-p", port,
        "-b", "460800",
        "--before=default_reset", "--after=hard_reset",
        "write_flash",
        "--flash_mode", "dio", "--flash_size", "16MB", "--flash_freq", "80m",
        f"0x{MODEL_PARTITION_OFFSET:X}", out_file,
    ]

    print(f"   {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode == 0:
        print(f"✅ Flashed! Wake word '{ALL_MODELS.get(model_id, model_id)}' is now active.")
        print(f"   Press the reset button on the device to reboot.")
        print(f"\n⚠️  NOTE: This only works if the firmware has a 'model' partition")
        print(f"   at offset 0x{MODEL_PARTITION_OFFSET:X}. If not, you need to")
        print(f"   add it to partitions.csv and rebuild firmware first.")
    else:
        print(f"❌ Flash failed:")
        print(result.stderr)
        sys.exit(1)


def cmd_sdcard(args):
    """Generate SD card folder format for CONFIG_MODEL_IN_SDCARD mode."""
    model_id = args.model
    model_path = os.path.join(ESP_SR_MODELS, model_id)
    output_dir = args.output or os.path.join(OUTPUT_DIR, "sdcard")

    if not os.path.exists(model_path):
        print(f"❌ Model not found: {model_id}")
        sys.exit(1)

    # Copy the model folder as-is — SD card mode reads folders directly
    dest = os.path.join(output_dir, model_id)
    if os.path.exists(dest):
        shutil.rmtree(dest)
    shutil.copytree(model_path, dest)

    print(f"✅ SD card model folder created:")
    print(f"   {dest}")
    print(f"\n📋 Contents:")
    for f in os.listdir(dest):
        fpath = os.path.join(dest, f)
        print(f"   {f} ({os.path.getsize(fpath)} bytes)")
    print(f"\nTo use: copy this folder to the SD card root,")
    print(f"   set CONFIG_MODEL_IN_SDCARD=y in sdkconfig,")
    print(f"   rebuild and flash firmware.")


def cmd_info(args):
    """Show current partition table and model partition info."""
    print("\n📋 Current partition table:")
    if os.path.exists(PARTITIONS_CSV):
        with open(PARTITIONS_CSV) as f:
            print(f.read())
    else:
        print(f"   {PARTITIONS_CSV} not found")

    print(f"\n📐 Proposed model partition:")
    print(f"   Name:   {MODEL_PARTITION_NAME}")
    print(f"   Offset: 0x{MODEL_PARTITION_OFFSET:X} ({MODEL_PARTITION_OFFSET/1024/1024:.1f}MB)")
    print(f"   Size:   0x{MODEL_PARTITION_SIZE:X} ({MODEL_PARTITION_SIZE/1024/1024:.1f}MB)")
    print(f"   Free flash space: ~1.9MB (between assets end 0xE00000 and coredump 0xFF0000)")

    print(f"\n📝 Partition table line to add:")
    print(f"   model, data, spiffs, 0x{MODEL_PARTITION_OFFSET:X}, 0x{MODEL_PARTITION_SIZE:X},")


def main():
    parser = argparse.ArgumentParser(
        description="Wake Word Flasher for Stack-chan CoreS3",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    sub = parser.add_subparsers(dest="command")

    # list
    sub.add_parser("list", help="List available wake word models")

    # pack
    p_pack = sub.add_parser("pack", help="Pack a model into srmodels.bin")
    p_pack.add_argument("--model", required=True, help="Model ID (e.g. wn9_heyivy_tts2)")
    p_pack.add_argument("--output", "-o", help="Output file path")

    # flash
    p_flash = sub.add_parser("flash", help="Pack and flash a model to the device")
    p_flash.add_argument("--model", required=True, help="Model ID (e.g. wn9_heyivy_tts2)")
    p_flash.add_argument("--port", default="/dev/cu.usbmodem211301", help="Serial port")

    # sdcard
    p_sd = sub.add_parser("sdcard", help="Generate SD card folder format")
    p_sd.add_argument("--model", required=True, help="Model ID")
    p_sd.add_argument("--output", "-o", help="Output directory")

    # info
    sub.add_parser("info", help="Show partition table and model partition info")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    if args.command == "list":
        cmd_list(args)
    elif args.command == "pack":
        cmd_pack(args)
    elif args.command == "flash":
        cmd_flash(args)
    elif args.command == "sdcard":
        cmd_sdcard(args)
    elif args.command == "info":
        cmd_info(args)


if __name__ == "__main__":
    main()