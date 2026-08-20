# stackchan-uiflow2 — Full Technical Analysis

**Repo:** `https://github.com/haraisao/stackchan-uiflow2` (local: `<repo-root>/stackchan-node/repos/stackchan-uiflow2/`)
**Purpose:** RT Corporation Stack-chan running on **M5Stack CoreS3** via **UIFlow2** (custom MicroPython).
**License:** Apache 2.0. **Language:** Japanese comments throughout.
**Latest commit:** `82cee41 Update util.py` (branch `main`).

This is the most promising path for getting Stack-chan working on CoreS3. It is a **complete, self-contained implementation** — face rendering, motor control, TTS/ASR, LLM dialog, web server, camera, and an on-device installer. Everything runs on-device in MicroPython; no host PC needed at runtime.

---

## 1. Full File Structure

```
stackchan-uiflow2/
├── README.md                  # Japanese quick-start guide
├── LICENSE                    # Apache 2.0
├── .gitignore
│
├── apps/
│   └── stackchan_app.py       # MAIN ENTRY POINT (uploaded to /flash/apps/ or run as main.py)
│
├── libs/                      # Core Python modules (uploaded to /flash/libs/)
│   ├── StackChan.py           # Main orchestrator class (face+motors+tts+asr+dialog+web)
│   ├── Face.py                # Face rendering engine (double-buffered canvas)
│   ├── Button.py              # Invisible touch zones on the screen
│   ├── DynamixelDriver.py     # Dynamixel XL330 servo driver (UART, protocol 2.0)
│   ├── SG90Driver.py          # SG90 analog servo driver (PWM)
│   ├── Gtts.py                # Google Cloud TTS client
│   ├── Voicevox.py            # Voicevox TTS client (local server)
│   ├── MeloTts.py             # MeloTTS via M5 LlmModule (UART AI module)
│   ├── Gasr.py                # Google Cloud Speech-to-Text client
│   ├── VoskAsr.py             # Vosk ASR client (local server)
│   ├── Gemini.py              # Google Gemini dialog backend
│   ├── Chatgpt.py             # OpenAI dialog backend (Responses API)
│   ├── LmStudio.py            # LM Studio local LLM backend
│   ├── dify.py                # Dify LLM backend (unused in main flow)
│   ├── WebServer.py           # HTTP server wrapper + REST command registration
│   ├── comm.py                # Raw-socket HTTP server + WebSocket-ish framework (PyWebSock)
│   └── util.py                # Config load/save, WLAN connect, JSON helpers, RTC
│   └── old/Voicevox.py        # Older Voicevox (direct 50021 engine API) — superseded
│
├── m5b2/                      # UIFlow2 block-definition JSON files (for the GUI block editor)
│   ├── StackChan.m5b2, Face.m5b2, Button.m5b2, ChatGPT.m5b2, Gemini.m5b2,
│   ├── DynamixelDriver.m5b2, Gtts.m5b2, Gasr.m5b2, Voicevox.m5b2, VoskAsr.m5b2,
│   └── MeloTts.m5b2           # Each maps a block to a Python method (jscode JSON)
│
├── config/                    # Default config templates
│   ├── stackchan.json         # Main config (motor/tts/asr/dialog/web/camera/prompt)
│   ├── stackchan_sg90.json    # Older SG90-only config
│   ├── stackchan_old.json     # Older flat config format
│   ├── wlan.json              # WiFi AP list (Home/Work/Mobile)
│   └── apikey.txt             # API keys (KEY=VALUE lines)
│
├── html/                      # Web UI served by the on-device web server
│   ├── index.html             # Main control page (joystick, face select, camera)
│   ├── asr_tts.html           # TTS/ASR test page
│   ├── edit_file.html         # File manager (read/write/list files on device)
│   ├── params.html            # Config editor (get/set all params)
│   ├── favicon.ico
│   ├── js/joy.min.js          # Joystick widget
│   └── images/face.png
│
├── scripts/                   # On-device installers (run inside UIFlow2)
│   ├── installer.py           # GUI installer (LVGL UI, downloads from GitHub)
│   ├── install_stackchan.py   # Headless installer (downloads from GitHub)
│   ├── install.py             # Local-file installer (copies from SD)
│   └── upload.bat             # Windows ampy upload helper (stub)
│
├── server/                    # OPTIONAL host-side Python server (Flask)
│   ├── server.py              # Flask app: /vosk, /tts, /talk, /chat endpoints
│   ├── vosk_recog.py          # Vosk ASR (vosk-model-ja-0.22)
│   ├── voicevox_synth.py      # Voicevox_core TTS (resampled to 8kHz)
│   ├── gemini.py              # Gemini client (host-side)
│   ├── conf/application_key.yaml
│   ├── html/                  # Host-side web UI
│   ├── requirement_vosk.txt
│   └── old/                   # Older WebSocket-based server (comm.py, vosk-server.py)
│
└── models/                    # 3D-print STL files for the robot body
    ├── StackChan-Body-Fs90.stl, StackChan-Foot-Fs90.stl,
    ├── StackChan-plate-lego.stl, StackChan-plate-magnet.stl,
    ├── StackChan2-CoreS3-package.stl, StackChan2-plate.stl,
    └── StackChan3-Body003.stl, StackChan3-MotorBlock001.stl, StackChan3-Motor_cover.stl
```

---

## 2. How It Runs / How Code Gets Onto the Device

**Runtime model:** UIFlow2 firmware (custom MicroPython) on CoreS3. The app is a normal MicroPython program with a `setup()`/`loop()` structure, run by the UIFlow2 runtime.

**Three upload paths (all documented in README + scripts):**

1. **Manual (README method):** Upload all `libs/*.py` to `/flash/libs/`, `apps/stackchan_app.py` to `/flash/` (as `main.py`), config files to `/flash/` (or `/sd/`), and `html/*` to `/flash/html/`. Upload is done via the **UIFlow2 web IDE** (drag-and-drop file upload) or via **USB/ampy** (`upload.bat` shows `ampy -p COM10 put <file> /flash/<file>`).

2. **On-device GUI installer (`scripts/installer.py`):** A UIFlow2 program with an LVGL UI. It connects to WiFi, then **downloads all files directly from GitHub raw URLs** (`https://raw.githubusercontent.com/haraisao/stackchan-uiflow2/refs/heads/main/...`) using `requests2.get()`, writing them to `/flash/libs`, `/flash/apps`, `/flash`, `/flash/html`. Two repos selectable (RT-NET fork or haraisao main). This is the easiest path — no PC needed.

3. **Headless installer (`scripts/install_stackchan.py`):** Same GitHub-download approach, no GUI. `scripts/install.py` copies from a local SD card instead.

**Key detail:** The README says config files go to `/sd` (SD card), but the **actual code reads them from `/flash`** (`util.load_json("/flash/stackchan.json")`, `util.load_conf("/flash/apikey.txt")`, `util.load_json("/flash/wlan.json")`). The installer writes configs to `/flash`. So configs live in `/flash` in practice.

**Bootstrap:** UIFlow2 runs `main.py` at boot. `stackchan_app.py` is the main program (it's the `apps/` file; you rename/copy it to `/flash/main.py`). It calls `setup()` then loops `loop()`.

---

## 3. Face Rendering (`libs/Face.py`)

**Display API:** Uses UIFlow2's `Display` / `Widgets` from `M5` module. Specifically:
- `Display.newCanvas(320, 188, 16, True)` — creates a 16-bit color offscreen canvas (double-buffering).
- Canvas drawing primitives: `drawArc`, `fillRect`, `fillCircle`, `drawEllipse`, `drawLine`, `clear`, `push(x, y)`.
- `Widgets.FONTS.EFontJA24` — Japanese 24px font for text.
- Three canvases: `buffer` (320×188 face area), `top_buffer` (320×26 message bar), `bottom_buffer` (320×26 info bar).

**Face geometry:** Center at `[160, 120-26]` (i.e. y=94). Eyes at center±70px horizontally, 20px above center. Mouth at center+28px. Face is drawn with vector primitives (no image assets).

**Expressions** (`draw(id)` method): `normal` (with blinking), `smile`, `anger`, `unhappy`, `surprise`, `wink_r`, `wink_l`, `look_l/r/u/d`, `talk`. Eye styles via `drawEye(param0)`:
- 0 = round eyes (with blink), 1 = `^ ^` arcs, 2 = `o -`, 3 = `- o`, 4 = `- -`, 5 = `+ +`, 6 = angled `/ \`.
- Mouth via `drawMouth(mouse_flag)`: `v`, `^`, `o`, or `-` (rect, size animated by ratio).

**Blinking:** Random timer (5–20s), blink animates by drawing bg-colored circles over eyes. **Talk animation:** `start_talk()` starts a `machine.Timer` that randomly cycles mouth shapes (`a,i,u,e,o,n`) every 100ms; `stop_talk()` stops it. **Motion:** `start_motion()` rotates the whole face ±10° via `rot_pos()` (trig rotation of every vertex).

**Rotation helper:** `rot_pos(p, angle, center)` rotates a point around the face center using `math.sin/cos`.

**Text:** `print_message()` (top bar, white) and `print_info()` (bottom bar, yellow) use the top/bottom canvases with `setCursor`, `setTextColor`, `print`.

---

## 4. Dialog / LLM Integration

**Orchestration** (`StackChan.chat_update()`):
1. `self.asr.check_request()` returns recognized text.
2. If text non-empty → `self.face.print_info("考え中…")` (thinking), then `self.dialog.request(text)`.
3. If result == `"ありがとう"` (thank you) → `self.dialog.reset_chat()`.
4. `self.tts.set_request(result.replace('*',''))` → speaks the reply.

**Backend selection** (`StackChan.setup_dialog()`), driven by `config['dialog']`:
- `"gemini"` → `Gemini.Gemini()`, model from `config['gemini/model']` (default `/gemini-2.5-flash:generateContent`), lang `config['gemini/lang']`.
- `"openai"` → `Chatgpt.ChatGPT()`, model from `config['openai/model']` (default `gpt-5`).
- `"lmstudio"` → `LmStudio.LmStudio(config['lmstudio_host'])`.
- else → prints "No such classe".

All backends share the same interface: `request(text) -> str`, `set_prompt(str)`, `reset_chat()`. They maintain `chat_history` and append user/assistant turns.

**Gemini (`Gemini.py`):** POSTs to `https://generativelanguage.googleapis.com/v1beta/models{model}` with `x-goog-api-key` header. Body: `{"contents": chat_history, "system_instruction": {...}, "tools": [{"url_context":{}},{"google_search":{}}]}`. Parses `result['candidates'][0]['content']['parts'][0]['text']`.

**OpenAI (`Chatgpt.py`):** POSTs to `https://api.openai.com/v1/responses` (the **Responses API**, not chat/completions) with `Authorization: Bearer {OPENAI_KEY}`. Body: `{"model":..., "input": chat_history, "tools":[{"type":"web_search"}]}`. Prompt inserted as a `developer` role message at index 0. Parses `result['output'][*]['content'][*]['text']` where `type=='output_text'`.

**LM Studio (`LmStudio.py`):** POSTs to `http://{host}:1234/v1/responses` (LM Studio's Responses-compatible endpoint), `Authorization: Bearer lm-studio`. Same parsing as OpenAI.

**Dify (`dify.py`):** Separate class, not wired into `setup_dialog()`. Uses `https://api.dify.ai/v1/chat-messages`.

### ➕ Adding an "openclaw" backend (KEY ADAPTATION)

The cleanest approach: **copy `LmStudio.py` → `OpenClaw.py`** and change the endpoint to `http://localhost:18789/v1/chat/completions`. But note two things:

1. **The existing backends use the OpenAI *Responses* API** (`/v1/responses`, `input` array, `output` parsing). OpenClaw's `http://localhost:18789/v1/chat/completions` is the **Chat Completions** API (`messages` array, `choices[0].message.content`). So the new backend must use the chat-completions request/response format, not copy the Responses format.

2. **`localhost` on the device** refers to the CoreS3 itself, not the host PC. To reach OpenClaw running on a host, the device must use the **host's LAN IP** (e.g. `http://192.168.x.x:18789/v1/chat/completions`), and OpenClaw must listen on `0.0.0.0` (not just localhost). This is the same pattern as `LmStudio` (which takes a `host` param) and `Voicevox`/`Vosk` (which take `host` IPs).

**Recommended new `OpenClaw.py`** (chat-completions format):
```python
class OpenClaw(object):
    def __init__(self, host="192.168.0.100", port=18789):
        self._endpoint = f"http://{host}:{port}/v1/chat/completions"
        self._apikey = ''  # OpenClaw may not need auth, or use a key
        self.model = 'openclaw'  # or whatever OpenClaw expects
        self.chat_history = []
        self.prompt = ""

    def reset_chat(self): self.chat_history = []

    def set_prompt(self, prompt): self.prompt = prompt

    def gen_chat_content(self, txt, role="user"):
        res = {"content": txt, "role": role}
        self.chat_history.append(res)
        return res

    def get_system_chat_content(self, result):
        try:
            res = result['choices'][0]['message']['content']
            self.gen_chat_content(res, 'assistant')
            return res
        except:
            print(result)
            return "失敗しました"

    def request(self, txt):
        url = self._endpoint
        headers = {'Content-Type': 'application/json; charset=utf-8'}
        self.gen_chat_content(txt)
        data = {'model': self.model, 'messages': self.chat_history}
        if self.prompt:
            data['messages'].insert(0, {'role': 'system', 'content': self.prompt})
        try:
            result = requests2.post(url, data=json.dumps(data).encode('utf-8'), headers=headers)
            return self.get_system_chat_content(result.json())
        except:
            print('Error', data)
            return ""
```

**Wiring it in** (`StackChan.setup_dialog()`):
```python
elif dialog_name == 'openclaw':
    import OpenClaw
    try:
        host = util.get_config(self.config, "openclaw/host", "192.168.0.100")
        self.dialog = OpenClaw.OpenClaw(host)
        self.dialog.model = util.get_config(self.config, "openclaw/model", "openclaw")
    except:
        pass
```
And add to `config/stackchan.json`:
```json
"dialog": "openclaw",
"openclaw": {"host": "192.168.0.100", "model": "openclaw"}
```
Also add `OpenClaw.py` to the installer file lists (`installer.py` `lib_list`, `install_stackchan.py` `lib_list`).

---

## 5. TTS / STT

### TTS (`StackChan.set_tts()`), driven by `config['tts']`:
- **`"google"` (default)** → `Gtts.Gtts()`. POSTs to `https://texttospeech.googleapis.com/v1/text:synthesize?key={GOOGLE_SPEECH_KEY}`. Body has `input.text`, `voice` (languageCode/name/ssmlGender), `audioConfig` (LINEAR16, speakingRate, pitch, volumeGainDb, sampleRateHertz). Response `audioContent` is base64 → `binascii.a2b_base64` → `play_wav()`. `play_wav` parses RIFF/WAVE header, extracts PCM rate, then `Speaker.playRaw(data, rate)` (M5 `Speaker` API). Splits long text on `。`/newlines and speaks each chunk. Triggers `face.start_talk()`/`stop_talk()` around playback.
- **`"voicevox"`** → `Voicevox.Voicevox(host, voice_index)`. POSTs `{"data": txt, "speaker": id}` to `http://{host}:8000/tts` (the bundled Flask server). Response `audio` base64 → `play_wav` (rate 24000 default). Same face talk animation.
- **`"melo_tts"`** → `MeloTts.MeloTts()`. Uses M5 `LlmModule(2, tx=17, rx=18)` (an external AI UART module) with `melotts_setup(model='melotts-ja-jp')` and `melotts_inference()`. On-device neural TTS.

### ASR (`StackChan.set_asr()`), driven by `config['asr']`:
- **`"google"` (default)** → `Gasr.Gasr()`. Records mic via `Mic.record(bytearray(8000*0.5), 8000, False)` in 0.5s chunks, computes RMS power (`calc_power`), starts capturing when power > threshold (default 41), stops after `max_count` silent chunks. Sends base64 LINEAR16 8kHz audio to `https://speech.googleapis.com/v1/speech:recognize?key={GOOGLE_SPEECH_KEY}`. Parses `results[0].alternatives[0].transcript`.
- **`"vosk"`** → `VoskAsr.VoskAsr(host)`. Same mic recording, POSTs base64 audio to `http://{host}:8000/vosk` (bundled Flask server). Returns recognized text.
- `"llm_asr"` / `"llm_whisper"` → not supported (prints message, sets None).

**Mic recording pattern (both):** `Mic.begin()`, loop `Mic.record(buf, 8000, False)` + `while Mic.isRecording(): sleep`, `Mic.end()`. Voice-activity detection by RMS power threshold.

**Note for OpenClaw adaptation:** TTS/ASR are independent of the dialog backend. You can keep Google TTS/ASR, or point Voicevox/Vosk at a local server. The dialog backend only needs to return text.

---

## 6. Config Files

### `config/stackchan.json` (main config, read from `/flash/stackchan.json`)
```json
{
  "motor": "SG90",                    // "Dynamixel" or "SG90"
  "SG90": {"pan": 2, "tilt": 9, "offset": 56},
  "tts": "google",                    // "google" | "voicevox" | "melo_tts"
  "google": {"lang":"ja-JP","speakingRate":"1.2","ssmlGender":"FEMALE",
             "voiceName":"ja-JP-Standard-A","pitch":"5.0","volumeGain":"0",
             "sampleRate":"8000","effectsProfileId":"","sampleRateHertz":8000},
  "voicevox": {"host":"192.168.0.100","voice_id":1},
  "asr": "google",                    // "google" | "vosk"
  "vosk": {"host":"192.168.0.100"},
  "web_server": 80,
  "camera_setup": true,
  "vflip": false,
  "dialog": "gemini",                 // "gemini" | "openai" | "lmstudio" | (add "openclaw")
  "gemini": {"model":"/gemini-2.5-flash:generateContent","lang":"ja_JP"},
  "openai": {"model":"gpt-5"},
  "prompt": "あなたは、小さなスーパーロボット「スタックチャン」です。..."
}
```
- **Format:** JSON with `#` comments allowed (stripped by `util.load_json`).
- **Nested access:** `util.get_config(conf, "SG90/pan", default)` walks the dict by `/`-separated keys.
- **Note:** `stackchan_old.json` / `stackchan_sg90.json` use a **flat** format (`sg90_pan`, `tts_ip`, `asr_ip`) that the current code does NOT read — the current code expects the nested format above.

### `config/wlan.json` (read from `/flash/wlan.json`)
```json
{"Home": {"essid": "", "passwd": ""},
 "Work": {"essid": "", "passwd": ""},
 "Mobile": {"essid": "", "passwd": ""}}
```
`util.connect_wlan()` scans APs and tries each in order (Home→Work→Mobile→Firmware). "Firmware" comes from NVS (`esp32.NVS("uiflow")` ssid0/pswd0).

### `config/apikey.txt` (read from `/flash/apikey.txt`)
```
GOOGLE_SPEECH_KEY=
GEMINI_KEY=
OPENAI_KEY=
```
- **Format:** `KEY=VALUE` lines, parsed by `util.load_conf()` (splits on `=`).
- `GOOGLE_SPEECH_KEY` → used by both Gtts and Gasr. `GEMINI_KEY` → Gemini. `OPENAI_KEY` → Chatgpt.
- For OpenClaw: no key needed (or add `OPENCLAW_KEY=` if auth required).

---

## 7. Web Server (`libs/WebServer.py` + `libs/comm.py`)

**Architecture:** A hand-rolled raw-socket HTTP server (`comm.py`, "PyWebSock" library). `SocketServer` binds, `accept_service()` accepts a connection, `HttpReader`/`HttpCommand` parse the HTTP request line + headers, dispatch GET (serve static files from `/flash/html/`) or POST (route to registered command callbacks). Single-threaded, polled via `spin_once()` in the main loop (`StackChan.web_update()` → `WebServer.update()` → `server.spin_once(0.1)`).

**Registered REST endpoints** (`StackChan.init_web()`):
| Endpoint | Method | Handler | Purpose |
|---|---|---|---|
| `/move` | POST | `set_goal_position` | Body `[pan_deg, tilt_deg]` → motor.move |
| `/face` | POST | `face.set_face_id` | Body = face id string |
| `/get_camera_image` | POST | `capture_image` | Returns `{width,height,data}` base64 RGB565 |
| `/set_message` | POST | `set_message` | Body `{"type":"info"/"message","message":...}` |
| `/command` | POST | `request_command` | Generic command router (see below) |
| `/tts` | POST | `tts.set_request` | Speak text (if TTS configured) |
| `/asr` | POST | `asr.set_request` | Start ASR (if ASR configured) |
| `/get_file` | POST | `get_content` | Read file: `{"file_name":...}` → `{"data":...}` |
| `/save_file` | POST | `save_content` | Write file: `{"file_name":...,"data":...}` |
| `/get_file_list` | POST | `get_file_list` | List dir: `{"dir_name":...}` → `{dir_list,file_list}` |
| `/terminate` | POST | `toggle_state` | Toggle web server on/off |

**`/command` sub-commands** (`request_command`, body `{"cmd":..., ...}`):
- `detect_face` → `tracking_face()`
- `face_tracking` → set `tracking_flag`
- `set_param` / `get_param` → get/set a config key
- `get_parameters` / `set_parameters` → get/set whole config (name: apikey|wlan|config)
- `message` → print info message
- `set_key` / `get_key` → get/set an API key
- `save_apikey` / `save_config` / `save_wlan` → persist to `/flash`
- `set_wlan` → set a wlan entry

**Static files:** GET serves from `/flash/html/` (document root). `index.html`, `asr_tts.html`, `edit_file.html`, `params.html` provide the full control UI (joystick, face dropdown, camera view, file manager, config editor).

**Web server start:** `StackChan.init_web(80)` creates it; `start_web_server()` toggles it on (bound to Btn1). It's polled in the main loop, not threaded.

---

## 8. Motor Control

### Dynamixel (`libs/DynamixelDriver.py`)
- **Protocol 2.0** over UART. `Dynamixel(id, rx=6, tx=7, baud=1000000, uart_id=1)`.
- Implements packet framing (0xFF 0xFF 0xFD header, CRC16), instructions (PING/READ/WRITE/...), and registers (TORQUE_ENABLE=64, GOAL_POSITION=116, PRESENT_POSITION=132, OPERATING_MODE=11, etc.).
- `DynamixelDriver` manages **pan (id=1) + tilt (id=2)** via `PControl` (position control with current-based feedback). Reads present position to compute offsets, sets operating mode to CURRENT_BASED_POSITION, uses `setGoalCurrent` for torque.
- `move(h_deg, v_deg)` sets goal positions. `update()` runs a periodic control loop (via `machine.Timer(2)` at 125ms) and random motion.
- Pan range ±180°, tilt -20°..7°.

### SG90 (`libs/SG90Driver.py`)
- **PWM** via `machine.PWM(pin, freq=50, duty_u16=...)`. Pan on port 2 (PortA), tilt on port 9 (PortB) by default.
- Pulse width mapping: min 500µs, max 2500µs, zero at 1500µs+offset (default 56). `ddeg = (max-min)/180.0` per degree.
- `move(h_deg, v_deg)` clamps h to ±90°, v to -30°..-5°, and does a **smooth stepped interpolation** (increments toward target with `time.sleep(delay)`).
- `motor(True/False)` creates/deinits the PWM pins. Auto-sleeps after 120s idle; random motion every 10–40s when enabled.
- `get_position()` returns `[h_deg, v_deg]`.

**Selection:** `StackChan.set_motor()` reads `config['motor']`. For SG90, reads `config['SG90/pan']`, `config['SG90/tilt']`, `config['SG90/offset']`. For Dynamixel, reads `config['Dynamixel/pan_offset']`, `config['Dynamixel/tilt_offset']`.

---

## 9. Camera

- **Init** (`StackChan.setup_camera()`, only if `config['camera_setup']` truthy):
  ```python
  camera.init(pixformat=camera.RGB565, framesize=camera.QVGA)
  if 'vflip' in config: camera.set_vflip(config['vflip'])
  self.face_detector = dl.ObjectDetector(dl.model.HUMAN_FACE_DETECT)
  ```
  Uses the M5 `camera` module and `dl` (deep-learning) module for on-device face detection.
- **Capture** (`capture_image`): `camera.snapshot()` → `frame.bytearray()` → base64 → `{width, height, data}`. Served via `/get_camera_image`. The web UI decodes RGB565 → RGB888 on canvas.
- **Face tracking** (`tracking_face`): `detect_face()` runs `face_detector.infer(img)`, returns face bounding boxes. If a face is found and `tracking_flag` is on, computes center offset from frame center (160,120) and moves the motor to track. If face height > 160px (close), triggers `start_dialog()` (voice conversation).
- **Note:** `camera.snapshot()` is called in `capture_image` without checking `camera_setupted` — if camera isn't set up, it throws and returns empty response.

---

## 10. Dependencies / UIFlow2 Environment

**Imported modules (all provided by UIFlow2 firmware):**
- `M5`, `from M5 import *` (gives `Widgets`, `Display`, `Speaker`, `Mic`, `Touch`, `Power`)
- `hardware` → `sdcard` (SD card)
- `machine` → `Pin`, `UART`, `PWM`, `Timer`, `SDCard`, `RTC`
- `network` (WLAN), `ntptime`, `socket`, `select`, `esp32` (NVS), `_thread`, `gc`
- `camera`, `dl` (face detection), `module` → `LlmModule` (MeloTTS)
- `requests2` (HTTP client — UIFlow2's version of requests)
- `m5ui`, `lvgl` (only in `installer.py` GUI)
- `utility` → `print_error_msg` (error reporting, in try/except)
- Standard: `os`, `sys`, `io`, `json`, `time`, `math`, `random`, `struct`, `binascii`, `socket`, `select`

**Key UIFlow2-specific APIs used:**
- `Display.newCanvas(w,h,bpp,double_buffer)` + canvas draw primitives + `push(x,y)`
- `Widgets.setRotation(1)`, `Widgets.fillScreen(color)`, `Widgets.FONTS.EFontJA24`
- `Speaker.begin()/setVolumePercentage()/playRaw(data,rate)/isPlaying()/end()`
- `Mic.begin()/record(buf,rate,async)/isRecording()/end()`
- `M5.Touch.getX()/getY()/getCount()`, `M5.Power.getBatteryLevel()`
- `requests2.get()/post()`
- `camera.init/snapshot/set_vflip`, `dl.ObjectDetector(dl.model.HUMAN_FACE_DETECT)`

**No external pip packages on-device.** All HTTP is via `requests2`. The `server/` directory is the only place with pip deps (Flask, vosk, voicevox_core, pydub, soundfile, resampy) — and that runs on a **host PC**, not the device.

---

## 11. main.py / Entry Point (`apps/stackchan_app.py`)

```python
def setup():
    M5.begin()
    Widgets.setRotation(1)
    Widgets.fillScreen(0x000000)
    stackchan_0 = StackChan()          # loads config, connects WLAN, sets up face/motors/tts/asr/dialog
    stackchan_0.init_web(80)          # create web server + register REST endpoints
    # 5 invisible touch buttons bound to callbacks:
    button_0 = Button('Btn1', 0,180,60,60)  -> stackchan_0.start_web_server
    button_1 = Button('Btn2', 260,180,60,60)-> stackchan_0.show_battery_level
    button_2 = Button('Btn3', 130,60,60,60) -> stackchan_0.start_dialog
    button_3 = Button('Btn4', 0,0,60,60)    -> stackchan_0.toggle_rand_motion
    button_4 = Button('Btn4', 260,0,60,60)  -> stackchan_0.toggle_tracking

def loop():
    M5.update()
    if M5.Touch.getCount() > 0:
        # check which button tapped, else clear_msg
    else:
        stackchan_0.update()   # web_update + face.update + tracking_face + motor.update + chat_update
        time.sleep_ms(50)

if __name__ == '__main__':
    setup()
    while True: loop()
```

**Bootstrap flow:** `StackChan.__init__` → load config/apikeys/wlan → `util.connect_wlan()` → optional camera setup → create `Face`, `set_motor()`, `set_tts()`, `set_asr()`, `setup_dialog()`. Then `init_web(80)` registers REST endpoints. The main loop polls web server, face, tracking, motor, and chat (ASR→dialog→TTS).

**Touch buttons** are invisible zones (no visual), mapped to screen quadrants. `Button.check_tap()` reads `M5.Touch.getX/Y` and checks the rect.

---

## 12. Adapting for OpenClaw — Summary of Changes

**Goal:** Make Stack-chan talk to OpenClaw's HTTP API (`http://<host>:18789/v1/chat/completions`) instead of OpenAI/Gemini.

### Required changes:

1. **New dialog backend `libs/OpenClaw.py`** — copy `LmStudio.py` but use the **Chat Completions** format (`messages` array, `choices[0].message.content`), endpoint `http://{host}:18789/v1/chat/completions`. Take `host` as a constructor arg (device can't use `localhost` to reach the host PC — must use the host's LAN IP).

2. **Wire it into `StackChan.setup_dialog()`** — add an `elif dialog_name == 'openclaw':` branch importing `OpenClaw`, reading `config['openclaw/host']` and `config['openclaw/model']`.

3. **Config** — in `config/stackchan.json` set `"dialog": "openclaw"` and add `"openclaw": {"host": "<host-lan-ip>", "model": "openclaw"}`.

4. **Installer lists** — add `OpenClaw.py` to `lib_list` in `scripts/installer.py` and `scripts/install_stackchan.py` (and `install.py` if used).

5. **Host side** — OpenClaw must listen on `0.0.0.0:18789` (not just localhost) so the device can reach it over LAN. Confirm the `/v1/chat/completions` endpoint and whether auth is needed.

### Optional / recommended:
- **TTS/ASR:** Keep Google (needs `GOOGLE_SPEECH_KEY` in apikey.txt) or run the bundled `server/` (Flask + Voicevox + Vosk) on the host and point `config['voicevox/host']` / `config['vosk/host']` at it. These are independent of the dialog backend.
- **Prompt:** Set `config['prompt']` to a Stack-chan persona (e.g. "あなたは小さなスーパーロボット「スタックチャン」です。応答は30字以内で…"). The OpenClaw backend should insert it as a `system` message.
- **Conversation reset:** The existing "ありがとう" (thank you) → `reset_chat()` convention works unchanged.

### Key gotchas:
- **`localhost` ≠ host.** Use the host's LAN IP in config.
- **Responses API vs Chat Completions.** Don't copy the OpenAI `input`/`output` format; use `messages`/`choices`.
- **Config lives in `/flash`** (not `/sd` as README claims).
- **`requests2`** is the HTTP client on-device (not `requests`).
- **Web server is polled, not threaded** — long dialog/TTS calls block the loop; keep responses short.
- **The `m5b2/` files** are optional UIFlow2 block definitions; you don't need them for a Python-only deployment.

---

## Verdict

This repo is a **complete, working Stack-chan implementation for CoreS3** with a clean, extensible backend abstraction (`dialog` config key + `request()/set_prompt()/reset_chat()` interface). Adding an OpenClaw backend is a small, well-scoped change (~1 new file + 1 config branch + config entry). The on-device installer (`installer.py`) makes deployment trivial. This is the right foundation to build on.
