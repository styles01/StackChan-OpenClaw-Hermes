# Custom Wake Word: "Hey Agent A"

## Research Summary

**Goal:** Replace the default wake word "Hi, Stack Chan" (`wn9_histackchan_tts3`) with a custom "Hey Agent A" wake word on the ESP32-S3 CoreS3.

## How Wake Words Work in ESP-SR

WakeNet models are **compiled neural network binaries** — not text strings. Each model is a folder containing:
- `wn9_data` — the trained model weights (binary)
- `wn9_index` — model index/metadata
- `_MODEL_INFO_` — human-readable model info string

The model is selected at **compile time** via `sdkconfig`:
```
CONFIG_SR_WN_WN9_HISTACKCHAN_TTS3=y    # currently selected
```

The `movemodel.py` script reads `sdkconfig`, copies the selected model folder into `srmodels.bin`, and flashes it to the device. There is no runtime model switching — the model binary is baked into the firmware image.

### What is `wn9_customword`?

The `wn9_customword` folder contains a model with `_MODEL_INFO_` reading:
```
WakeNet9_v1h24_小爱同学_3_0.620_0.627
```
This is NOT a generic custom word model — it's a pre-trained model for "小爱同学" (Xiao Ai Tong Xue, a Chinese wake word). The name "customword" is misleading; it's just another pre-trained model in the catalog.

### Can the Model Be Selected at Runtime?

**No.** The `esp_srmodel_init("model")` call loads whatever model binary is packed into `srmodels.bin` at flash time. The firmware code in `esp_wake_word.cc` simply takes the first model found:
```cpp
char *model_name = wakenet_model_->model_name[0];
wakenet_iface_ = (esp_wn_iface_t*)esp_wn_handle_from_name(model_name);
```

To change the wake word, you must:
1. Change `sdkconfig` to select a different `CONFIG_SR_WN_*` option
2. Rebuild the firmware
3. Flash the new `srmodels.bin`

### Can Multiple Models Be Included?

Theoretically yes — `WakeNet supports up to 5 wake words` per the docs. You could enable multiple `CONFIG_SR_WN_*` options and the model packer would include all of them. But the firmware code only uses `model_name[0]` (the first one). You'd need to modify the firmware to iterate models and select one at boot — possible but requires C++ firmware changes.

## Two Paths to "Hey Agent A"

### Path 1: Request a Free Custom Model from Espressif (RECOMMENDED — Free)

Per the [ESP-SR README](https://github.com/espressif/esp-sr):
> Espressif offers two ways to customize the wake word:
> 1. [Espressif Speech Wake Words Customization Process](https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/wake_word_engine/ESP_Wake_Words_Customization.html)
> 2. [Training Wake Words by TTS sample](https://github.com/espressif/esp-sr/issues/88)

**Option 1 — Espressif's Customization Service:**
- Submit a request to Espressif with your desired wake word
- They train a WakeNet9 model using their TTS pipeline
- The model is added to ESP-SR and becomes available as `CONFIG_SR_WN_WN9_HEYROISIE_TTS` (or similar)
- **Cost: Free** (community wake words are added to the public catalog)
- **Timeline: Typically 2-4 weeks** (based on community reports)

**Option 2 — TTS Training (GitHub Issue #88):**
- Espressif maintains [issue #88](https://github.com/espressif/esp-sr/issues/88) as a community wake word request thread
- You can request a wake word there and they'll train it via their TTS pipeline
- Multiple users have requested custom English wake words this way
- **This is the fastest free path**

### Path 2: Use an Existing English Wake Word (IMMEDIATE — Temporary)

Available English wake words in the current ESP-SR catalog:
| Model | Wake Word | 
|-------|-----------|
| `wn9_heyivy_tts2` | "Hey, Ivy" |
| `wn9_heykira_tts3` | "Hey, Kira" |
| `wn9_heywanda_tts` | "Hey, Wand" |
| `wn9_heywillow_tts` | "Hey, Willow" |
| `wn9_heyprinter_tts` | "Hey, Printer" |
| `wn9_hijason_tts2` | "Hi, Jason" |
| `wn9_hijolly_tts2` | "Hi, Jolly" |
| `wn9_hiandy_tts2` | "Hi, Andy" |
| `wn9_hijoy_tts` | "Hi, Joy" |
| `wn9_hifairy_tts2` | "Hi, Fairy" |
| `wn9_heyily_tts2` | "Hey, Ily" |
| `wn9_jarvis_tts` | "Jarvis" |
| `wn9_alexa` | "Alexa" |
| `wn9_mycroft_tts` | "Mycroft" |
| `wn9_computer_tts` | "Computer" |
| `wn9_sophia_tts` | "Sophia" |

None of these is "Hey Agent A." The closest phonetically would be:
- **"Hey, Ivy"** (`wn9_heyivy_tts2`) — similar "Hey" prefix, two syllables
- **"Sophia"** (`wn9_sophia_tts`) — ends in similar "ee-uh" sound

### Path 3: Train a Custom Model Yourself (HARD — Not Recommended)

ESP-SR does not ship a public training toolkit for WakeNet. The training pipeline is Espressif-internal. You would need:
- Large dataset of "Hey Agent A" audio samples (1000+ clips, varied speakers/accents)
- TTS-generated synthetic training data
- Espressif's internal training scripts (not publicly available)
- GPU training time

**This is not feasible without Espressif's cooperation.**

## Recommended Plan

### Step 1: Submit a wake word request to Espressif (NOW — Free, 2-4 weeks)
- Post on [GitHub issue #88](https://github.com/espressif/esp-sr/issues/88) requesting "Hey, Agent A" as a wake word
- Also follow the [official customization process](https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/wake_word_engine/ESP_Wake_Words_Customization.html)
- Include: wake word text, language (English), target chip (ESP32-S3), use case (robot assistant)

### Step 2: Use a temporary wake word (IMMEDIATE — 30 min effort)
- Switch to `wn9_heyivy_tts2` ("Hey, Ivy") as a temporary wake word
- Change sdkconfig: `CONFIG_SR_WN_WN9_HEYIVY_TTS2=y`, disable `CONFIG_SR_WN_WN9_HISTACKCHAN_TTS3`
- Rebuild and flash
- Device responds to "Hey, Ivy" until "Hey, Agent A" model is ready

### Step 3: Switch to "Hey, Agent A" when the model is available (2-4 weeks)
- Once Espressif adds the model to ESP-SR, update the managed component
- Change sdkconfig to the new model
- Rebuild and flash

## Can This Be a Config Page Setting?

**Not with current ESP-SR architecture.** The wake word model is a compiled binary packed into the firmware image at build time. To make it configurable:

1. **Include all models in the firmware** — pack multiple WakeNet models into `srmodels.bin` (possible, ESP-SR supports up to 5)
2. **Modify firmware to select at boot** — change `esp_wake_word.cc` to iterate available models and select one based on an NVS config value
3. **Add config page UI** — add wake word selection to the web config endpoints

This is a **Phase 2 enhancement** — requires C++ firmware modifications to the xiaozhi-esp32 audio service layer. Doable but not trivial.

## Summary

| Path | Effort | Timeline | Quality |
|------|--------|----------|---------|
| Request from Espressif | 10 min to post | 2-4 weeks | Production-grade |
| Temporary English word | 30 min (rebuild + flash) | Immediate | Good (not "Agent A") |
| Train yourself | Weeks | Unknown | Unknown |
| Config page selector | 2-3 days coding | Phase 2 | Best UX |

**Recommendation:** Submit the request to Espressif now (Step 1), use "Hey, Ivy" temporarily (Step 2), and plan the config page selector as a Phase 2 enhancement.