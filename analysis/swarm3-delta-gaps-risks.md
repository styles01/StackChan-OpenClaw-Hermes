# Swarm 3 — Delta Review: Gaps, Risks, and What the Docs Don't Say

**Reviewer:** Ernest (subagent)
**Date:** 2026-08-18
**Scope:** BRIEF.md, BUILD_PLAN.md, TODO.md vs. actual plaipin firmware source
**Verdict:** The architecture is sound in principle, but the docs **overstate how much is "already done"** and **understate the coupling** between the STT/LLM/TTS classes and the rest of the firmware. Several claims in the BRIEF are factually wrong about the current code. This will bite during implementation.

---

## 1. "DELETE plaipin's STT/TTS/LLM classes" — the coupling is DEEP, not shallow

**The claim:** BRIEF says we "DELETE" the STT/TTS/LLM classes and replace with a `ThinAudioClient` (~300-400 LOC). TODO says "Remove `stt/`, `tts/`, `llm/` directories from build."

**The reality:** These classes are not isolated leaf modules. They are the **backbone of the entire conversation flow**, and deleting them breaks the build in at least 6 places:

### 1a. `Robot.cpp` is a factory + facade over all three
`Robot.cpp` (9533 bytes) is not just "body code." It is the **AI pipeline orchestrator**:
- `Robot::initLLM()`, `initSTT()`, `initTTS()` — factory methods that `new` the concrete classes based on config
- `Robot::listen()` → `stt->speech_to_text()`
- `Robot::chat()` → `llm->chat(text, base64_buf)`
- `Robot::speech()` → `tts->stream(text)`
- `Robot::isAllOfflineService()` → checks `llm->isOfflineService && stt->isOfflineService && tts->isOfflineService`

`Robot.h` declares `LLMBase *llm; TTSBase *tts; STTBase *stt;` as **public members**. These are referenced throughout the codebase, not just in Robot.cpp.

### 1b. `main.cpp` calls `robot->tts->getLevel()` directly
The `lipSync()` task (line ~150) does:
```cpp
level = robot->tts->getLevel();
```
This drives the avatar's mouth-open ratio during speech. If you delete `TTSBase`, **lip sync breaks** — the mouth won't move when the robot talks. The BRIEF says "face stays as-is" but the face's mouth animation is wired to the TTS class you're deleting.

### 1c. `AiStackChanMod.cpp` (the conversation mod) calls the whole chain
`STT_ChatGPT()` (the core trigger handler) does:
```cpp
String ret = robot->listen();      // stt->speech_to_text()
robot->chat(ret, base64_buf);       // llm->chat()
```
And `robot->speech()` (which calls `tts->stream()`) is called from:
- `STT_ChatGPT()` error path
- `report_batt_level()`
- The Telegram polling block in `idle()`

### 1d. `asyncTtsStreamTask` in Robot.cpp
A FreeRTOS task that reads `llm->getOutputTextQueueSize()` and calls `tts->stream()`. This is the async TTS path. It's compiled in the non-REALTIME build.

### 1e. `RealtimeAiMod.cpp` (REALTIME_API build)
Casts `robot->llm` to `RealtimeLLMBase*` and calls `webSocketProcess()`, `getAudioLevel()`, `isRealtimeRecording()`, etc. If you keep the REALTIME_API build path, you can't delete the LLM classes.

### 1f. `lipSync` in main.cpp also has a REALTIME branch
```cpp
#ifdef REALTIME_API
  level = ((RealtimeLLMBase*)(robot->llm))->getAudioLevel();
#else
  level = robot->tts->getLevel();
#endif
```

### The verdict on Q1
**You cannot just "delete the directories."** You must either:
- **(A) Stub the interfaces** — keep `LLMBase`/`TTSBase`/`STTBase` as abstract classes, provide a `ThinAudioClient` that implements all three (so `robot->listen()`, `robot->chat()`, `robot->speech()`, `robot->tts->getLevel()` all still work). This is the **least invasive** path — you keep the `Robot` facade and `AiStackChanMod` flow intact, only swap the concrete implementations. **This is the recommended approach.**
- **(B) Refactor Robot.cpp + AiStackChanMod.cpp + main.cpp** — rip out the `llm`/`stt`/`tts` members, rewrite `listen()/chat()/speech()`, rewrite `STT_ChatGPT()`, rewrite `lipSync()`. This is a **much bigger change** than the docs admit — you're touching the conversation mod, the main loop, and the avatar lip-sync task.

**The docs say "~300-400 LOC of new firmware."** That's only true if you take path (A) and stub the interfaces. If you take path (B) as the TODO literally implies ("Remove stt/ tts/ llm/ directories"), you're rewriting the entire AI orchestration layer — that's 1000+ LOC of changes and a much higher regression risk.

**Recommendation:** Stub the interfaces (path A). Keep `LLMBase`/`TTSBase`/`STTBase` headers, implement a single `ThinAudioClient` that satisfies all three. This preserves `Robot.cpp`, `AiStackChanMod.cpp`, `main.cpp` lipSync, and the async TTS task with minimal changes.

---

## 2. Trigger logic — the docs are WRONG about what triggers recording

**The claim:** BRIEF says "Button press, head-pet, or VAD detects speech." TODO says "button-triggered for v1."

**The reality (from `AiStackChanMod.cpp`):**
- **Button A** (`btnA_pressed`) → `sw_tone(); STT_ChatGPT();` — **this is the button trigger.** ✓
- **Touch** (`display_touched`) → only if touch is in `box_stt` region (top-right area of screen, `setupBox(107, 0, width-107, 80)`) → `STT_ChatGPT()`. **This is NOT "head-pet."** It's a specific screen region tap.
- **Face detection** (`idle()`) → `camera_capture_and_face_detect()` → if face detected, auto-triggers `STT_ChatGPT()`. **But this is behind `#if defined(ENABLE_FACE_DETECT)` which is NOT defined in any build env.**
- **Wake word** → `wakeword_compare()` → `STT_ChatGPT()`. Behind `ENABLE_WAKEWORD` (defined for cores3).

**Critical finding: There is NO "head-pet" trigger in the code.** I searched for "pet", "head-pet", "head_pet" — zero matches. The BRIEF's "head-pet" is a **fabrication** (or a conflation with the touch region). The actual triggers are: Button A, touch on a specific screen region, face detection (disabled by default), and wake word.

**The verdict on Q2:**
- The trigger logic lives in `AiStackChanMod.cpp` (`btnA_pressed`, `display_touched`, `idle`), NOT in the STT/TTS/LLM classes.
- **You keep the trigger logic as-is** and only change what `STT_ChatGPT()` does after the trigger. Since `STT_ChatGPT()` calls `robot->listen()` → `robot->chat()` → `robot->speech()`, and you're stubbing those to route through `ThinAudioClient`, **the trigger logic needs ZERO changes.** This is the good news.
- But the docs' "head-pet" claim is wrong. If the team expects head-pet to work, it doesn't exist in plaipin's code — it would need to be **built** (touch region on the head area, or accelerometer-based pet detection). The TODO's "button-triggered for v1" is the honest version.

---

## 3. "Stack-chan body stays untouched" — FALSE for camera/vision/face-tracking

**The claim:** BRIEF says "Face, servo, camera, LED, petting, scanning — all stay as-is." TODO Phase 5 says test "camera vision ('Hey Agent A, what do you see?')".

**The reality:**
- **`ENABLE_CAMERA` is NOT defined in any build env** in `platformio.ini`. The camera code (`Camera.cpp`, `camera_init()`, `camera_capture_base64()`) is all behind `#if defined(ENABLE_CAMERA)`. **The camera is not compiled in by default.**
- **`ENABLE_FACE_DETECT` is NOT defined anywhere** — it's only referenced in `#if defined()` guards. **Face tracking is not compiled in.**
- The `stackchan-arduino` library (the actual body driver) is a **dependency** (`https://github.com/stack-chan/stackchan-arduino.git`), not vendored in plaipin's `src/`. The "body code" the BRIEF says we "keep" is largely in that external library.

**The verdict on Q3:**
- **Camera vision ("what do you see?") is NOT preserved by the plaipin fork as-is.** It requires:
  1. Defining `ENABLE_CAMERA` in the build
  2. Wiring the camera capture into the new pipeline (the current `STT_ChatGPT(base64_buf)` passes a base64 image to `llm->chat()` — the LLM does vision. If you stub `chat()` to just send audio, **you lose vision** unless the new server also accepts image data.)
  3. The GC0308 camera on CoreS3 has known issues (XCLK, I2C release) noted in TODO's hardware notes.
- **Face tracking** (auto-trigger on face detect) is disabled by default and would need `ENABLE_FACE_DETECT` + the human_face_detect library.
- **Servo gestures during speech** — these work via `servo_home` flag + the `servo` task in main.cpp, which is independent of STT/TTS/LLM. **These are preserved.** ✓
- **Touch interactions** — the touch regions in `display_touched()` are preserved (they're in the mod, not the AI classes). ✓ But "head-pet" specifically doesn't exist.

**Bottom line:** The BRIEF's "body stays untouched" is only true for **servo, LED, face display, and touch regions**. Camera and face-tracking are **not active** in the default build and need real work to enable. The TODO's Phase 5 "test camera vision" is a **new feature**, not a preserved one.

---

## 4. Response format — the docs contradict themselves

**The claim (BRIEF, two places):**
- Response Format section: server returns **structured JSON** with `body` field: `{ "expression": "happy", "servo": {...}, "gesture": "nod", "led": "blue" }`
- Same section, last line: "agent appends `[expression:happy] [gesture:nod]` to its response, **the server parses them out** before TTS and includes them in the JSON."

**The contradiction:** Is the agent returning **structured JSON** (which the server passes through), or is the agent returning **text with markers** (which the server parses into JSON)? These are two different contracts:
- If the agent returns JSON, the server just relays it — but then the agent's *spoken text* and the *body commands* are separate fields, and the agent must be trained to emit valid JSON every time (fragile with LLMs).
- If the agent returns text with `[markers]`, the server must **strip the markers before TTS** (so the robot doesn't *speak* "[expression:happy]") and parse them into the `body` field.

**The verdict on Q4:** This is genuinely underspecified and it matters a lot:
- **Marker-in-text is the safer pattern** (matches Larry V2's `[trumpet]` effect markers, and matches how plaipin's `OpenClawClient` already strips emoji/markdown from responses). The server regex-parses `[expression:...]`, `[gesture:...]`, `[led:...]`, `[servo:...]` out of the text, strips them, TTS the clean text, and puts the parsed commands in the JSON `body`.
- **The docs must pick ONE.** The current BRIEF describes both and doesn't say which the server implements. This will cause a mismatch: if the server expects JSON but the agent emits markers (or vice versa), the robot gets no body commands and possibly speaks garbage.
- **Recommendation:** Go with **markers-in-text, parsed server-side** (Larry V2 pattern). Document it as the single source of truth. Also note: plaipin's `OpenClawClient` already does `stripEmoji()` + strips `**`/`__` — the new server must add marker-stripping to that same cleanup step.

---

## 5. WiFi credentials — the "no API keys" claim is misleading

**The claim:** BRIEF says "No API keys on the ESP32 — zero cloud credentials stored on the device."

**The reality:**
- WiFi credentials **are** stored on the device. From `StackchanExConfig.cpp`:
  ```cpp
  if(read_sd_file("/wifi.txt", buf, sizeof(buf))){
      _secret_config.wifi_info.ssid = String(data);
      _secret_config.wifi_info.password = String(data);
  }
  ```
  And `SC_SecConfig.yaml.example` has:
  ```yaml
  wifi:
    ssid: "YOUR_WIFI_SSID"
    password: "YOUR_WIFI_PASSWORD"
  ```
- **The device also currently stores an OpenClaw bearer token** (`apikey.aiservice: "YOUR_OPENCLAW_BEARER_TOKEN"` in `SC_SecConfig.yaml`). The `OpenClawClient` sends it as `Authorization: Bearer <token>` to the proxy. **This is a credential on the device** — the BRIEF's "zero credentials" is only true if you remove this field from the config and the new pipeline doesn't need it.
- The new thin-client pipeline: the ESP32 POSTs WAV to `mini:18790/audio`. If that endpoint requires auth (it should, since it's on the LAN and the mini has other services), you need a token on the device — contradicting "zero credentials."

**The verdict on Q5:**
- WiFi SSID/password **must** live on the device (or be provisioned via SmartConfig, which plaipin supports). That's unavoidable and not a security problem per se.
- The real question: **does the `/audio` endpoint require auth?** If yes, the ESP32 needs a token (contradicting the BRIEF). If no, the endpoint is open on the LAN — anyone on the network can POST audio and get TTS responses (a minor abuse vector, and a **privacy** issue if the robot's mic audio is accessible).
- **Recommendation:** Decide and document this. Options: (a) no auth on `/audio` but bind to a VLAN/AP-isolated network; (b) a shared LAN token stored in the (already-present) `SC_SecConfig.yaml` — this is a credential on the device, so the BRIEF's "zero credentials" claim needs softening to "zero **cloud/API** credentials" (WiFi + LAN token are fine).

---

## 6. Error handling — "play local sample" is underspecified; plaipin has NO core sounds

**The claim:** TODO says "Server down → play local 'I can't connect' sample." BRIEF says "Stack-chan already has core sounds."

**The reality:**
- **plaipin has NO bundled sound samples.** I searched for `.mp3`/`.wav`/`.raw` files — **zero found** in the repo. The only audio is:
  - `sw_tone()` / `alarm_tone()` — **generated tones** (M5.Speaker.tone), not samples
  - `FNAME_ALARM_MP3 "alarm.mp3"` — but this is **copied from SD card at runtime** (`copySDFileToSPIFFS`), not bundled. The `Copy-to-SD/` folder has only YAML configs, no audio.
- **There is no "I can't connect" sound anywhere.** The BRIEF's claim that "Stack-chan already has core sounds" is **false** for this fork.
- The existing error handling in plaipin is **text-based on the avatar**: `OpenClawClient::chat()` sets `avatar.setSpeechText("Connection error")` / `"Parse error"` / `"API error"` and shows a Sad expression. It does **not** play a sound.

**The verdict on Q6:**
- You must **create** the local error samples (record or generate "I can't connect", "taking a while", etc.) and store them on the SD card or SPIFFS. This is **new work**, not reuse.
- The existing plaipin error UX (text on screen + Sad face) is a good fallback but the docs want audio. Decide: text-only (reuse plaipin's pattern) or audio (new samples needed).
- Also note: plaipin's `OpenClawClient` already has a **60s timeout** (`http.setTimeout(65000)`) and a 60s proxy timeout. The new pipeline needs its own timeout handling — the docs don't specify what happens if the mini is slow (TTS can take 2-5s; the ESP32 HTTPClient default timeout may be too short).

---

## 7. License — you CANNOT cleanly add MIT to a fork of an unlicensed repo

**The claim:** BUILD_PLAN "Key Decisions" #9: "Plaipin fork + add MIT license (pragmatic, attribute original)."

**The reality:**
- **plaipin's repo has NO license file** (confirmed: no `LICENSE`, no `license*`). README is one line. This means **all rights reserved** by default under copyright law — you have **no legal right** to redistribute or modify it without permission.
- The code is **derived from `m5stack/AiStackChan`** (the `AiStackChanMod`, `SC_ExConfig.yaml`, `stackchan-arduino` dependency, `STT_ChatGPT` naming all match that project). The `m5stack-avatar` library inside is MIT (Shinya Ishikawa), but the **AiStackChan application code** is a separate project.
- **You cannot "add MIT" to code you don't own.** MIT is a license *you grant* to others for code *you own*. If the underlying code is plaipin's (unlicensed) and upstream's (unknown license), you don't have the right to relicense it as MIT. Adding an MIT LICENSE file to a fork of unlicensed code is **legally dubious** — it misrepresents the licensing of code you don't hold rights to.

**The verdict on Q7:**
- **This is a real legal risk, not a formality.** Options:
  1. **Contact plaipin** (Nat/livinwater, per git author) and ask permission / get them to add a license. Best path.
  2. **Check upstream `m5stack/AiStackChan` license** — if it's MIT/Apache, the plaipin fork inherits that (with attribution), and you can keep that license. But plaipin's *additions* (OpenClawClient, proxy, Telegram) are still unlicensed.
  3. **Write the thin-client firmware as genuinely new code** (clean-room, not copying plaipin's AI classes) and license *your* new code MIT, while keeping the forked body code under its original (unknown) license. This is the honest approach but complicates the "one MIT license" goal.
- **Recommendation:** Do NOT slap an MIT LICENSE on the whole fork. At minimum, get plaipin's permission and confirm upstream's license. Document the licensing of each component (body code vs. your new thin-client code). This is a **blocker for the "open source / community adoption" success criterion** — a repo with a bogus MIT license on unlicensed code is a liability, not a win.

---

## 8. Effort estimate — "~1-1.5 weeks" is optimistic for one person

**The claim:** BUILD_PLAN: Phase 1 (1 day) + Phase 2 (1-2 days) + Phase 3 (2-3 days) + Phase 4 (1 day) + Phase 5 (1-2 days) = ~1-1.5 weeks.

**The reality (what the docs miss):**

| Hidden cost | Impact |
|---|---|
| **Camera/vision enablement** (Q3) | Not in any phase. Enabling `ENABLE_CAMERA` + wiring vision into the pipeline + GC0308 hardware quirks = 1-2 days of debugging alone. |
| **Interface stubbing vs. deletion** (Q1) | The docs imply deletion; the safe path is stubbing. Stubbing is less code but requires understanding all 6 call sites. Either way, more than "300-400 LOC." |
| **Response format ambiguity** (Q4) | Undecided contract = rework risk. If the server and agent disagree, Phase 3/4 integration fails and needs rework. |
| **Local error samples** (Q6) | Not in any phase. Creating + storing samples is new work. |
| **License resolution** (Q7) | Not in any phase. Could block the open-source goal entirely. |
| **Auth on /audio** (Q5) | Undecided. Affects both firmware and server. |
| **ESP32 audio quality** | TODO notes "Reddit users report Whisper returns empty transcriptions due to low gain — may need AGC tuning." This is a known landmine for the whole pipeline (garbage in → garbage out). Not in the estimate. |
| **Half-duplex mic/speaker switching** | `sw_tone()` does `M5.Mic.end(); M5.Speaker.begin()` — the mic and speaker share hardware. The new pipeline must handle this switching correctly or you get no audio. Not called out in the estimate. |

**The critical path:**
1. **Server (Phase 2)** — must work first (curl-testable, no hardware needed). This is the foundation.
2. **Firmware thin-client (Phase 3)** — depends on server contract being fixed (Q4).
3. **Agent config (Phase 4)** — depends on server + response format.
4. **Camera/vision (Q3)** — a parallel track that's currently unplanned.

**The verdict on Q8:**
- **1-1.5 weeks is realistic ONLY if** you take the stub-the-interfaces path, skip camera/vision in v1, resolve the response-format ambiguity up front, and accept text-only error handling. That's a **minimal v1**.
- **If you want camera vision, head-pet, audio error samples, and a clean license** (all implied by the BRIEF/TODO), it's **2-3 weeks**, and the camera + audio-quality issues are the most likely to blow the schedule.
- **Recommendation:** Cut v1 scope explicitly: button-trigger only, no camera, text-only errors, stub interfaces. Ship that in 1-1.5 weeks. Defer camera/vision, head-pet, and audio samples to v1.1. Resolve the license and response-format questions **before** writing any code.

---

## Summary of the biggest risks (ranked)

1. **License (Q7)** — You cannot legally add MIT to unlicensed forked code. This is a blocker for the open-source goal and a legal liability. **Resolve before publishing.**
2. **Response format ambiguity (Q4)** — Two contradictory contracts in the same doc. Will cause integration rework. **Decide: markers-in-text, parsed server-side.**
3. **Camera/vision is NOT preserved (Q3)** — `ENABLE_CAMERA`/`ENABLE_FACE_DETECT` are not compiled in. The BRIEF's "body stays untouched" is false for camera. **Either cut it from v1 or budget real time for it.**
4. **Deletion vs. stubbing (Q1)** — Deleting the STT/TTS/LLM classes breaks lipSync, the conversation mod, and the async TTS task. **Stub the interfaces, don't delete.**
5. **"Head-pet" doesn't exist (Q2)** — The trigger is Button A / screen-region touch / (disabled) face-detect. **Keep the existing trigger logic; don't plan around head-pet.**
6. **No local error samples (Q6)** — "Stack-chan already has core sounds" is false. **Create samples or use text-only errors.**
7. **Auth on /audio (Q5)** — "Zero credentials" is misleading; WiFi + possibly a LAN token live on the device. **Decide the auth model.**
8. **Audio quality (TODO hardware note)** — Known Whisper-empty-transcription risk from low mic gain. **Budget for AGC tuning.**

## What the docs get RIGHT
- The thin-audio-client architecture (Larry V2 pattern) is sound and genuinely reduces firmware complexity.
- Half-duplex is the right call — no AEC needed.
- The trigger logic in `AiStackChanMod.cpp` can be kept as-is if you stub the interfaces (Q2 good news).
- Servo gestures, LED, face display, and touch regions are genuinely preserved.
- The 16MB backup hard rule is correct and important.

## Key code citations
- `Robot.cpp:listen()/chat()/speech()` — the facade over STT/LLM/TTS
- `main.cpp:lipSync()` — `robot->tts->getLevel()` drives mouth animation
- `AiStackChanMod.cpp:STT_ChatGPT()` — the conversation flow calling `listen()` → `chat()` → `speech()`
- `AiStackChanMod.cpp:btnA_pressed()/display_touched()/idle()` — the actual triggers (no head-pet)
- `StackchanExConfig.cpp:51-58` — WiFi creds from `/wifi.txt` / `SC_SecConfig.yaml`
- `OpenClawClient.cpp` — already does OpenClaw chat via REST proxy (port 18790), strips emoji/markdown, 60s timeout
- `openclaw-rest-proxy.js` — the existing REST→WebSocket bridge to the gateway (port 18789)
- `platformio.ini` — `ENABLE_CAMERA`/`ENABLE_FACE_DETECT` NOT defined in any env
- `AudioWhisper.cpp` — the existing 16kHz WAV recording mechanism (reusable for the thin client!)
