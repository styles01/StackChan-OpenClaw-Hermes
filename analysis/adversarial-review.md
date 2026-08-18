# Adversarial Review: Stack-chan → Rosie OpenClaw Node

**Reviewer:** Senior embedded systems engineer (adversarial)
**Date:** 2026-08-17
**Scope:** PROJECT.md, BUILD_PLAN.md, TODO.md, ADRs 0001–0004, and the four analysis reports, verified against the actual source of `esp-openclaw-node`, `StackChan`, `xiaozhi-esp32`, `zclaw`, and the live OpenClaw Gateway on this machine.

---

## 1. Verdict

**The plan is architecturally sound but operationally under-scoped and contains three concrete factual errors that will bite on day one.** The core decision — use `esp-openclaw-node` as a thin, gateway-owned voice/command endpoint and bolt the StackChan robot body on top — is correct and well-supported by the source. The core components (`esp-openclaw-node`, `esp-openclaw-talk`, `esp-openclaw-room-node`, provisioning) are genuinely board-agnostic and reusable verbatim. But the plan (a) hardcodes the wrong Gateway port (19001 vs the actual 18789), (b) overstates the Waveshare board port as "90% there" (it is ~40–50% reusable as board *code*, though the port *contract* is 100% reusable), and (c) mischaracterizes the StackChan robot layer as "cleanly separable" when the display and camera are deeply coupled to the xiaozhi-esp32 class hierarchy and build tree. The wake-word "2–5 hours" estimate is a research/external-vendor problem, not a task. The "~1 week" total is optimistic by roughly 2–3×. The plan is **fixable and worth doing**, but only after the corrections below are applied.

---

## 2. What's Right (verified against source)

### 2.1 "Steal esp-openclaw-node verbatim" — TRUE for the core components
The core is genuinely self-contained. `components/esp-openclaw-node/CMakeLists.txt` requires only `cjson`, `esp_app_format`, `esp_websocket_client`, `libsodium`, `mbedtls`, `nvs_flash` — no board code. The room-node product is board-agnostic behind a narrow C struct (`esp_openclaw_room_node_config_t` in `components/esp-openclaw-room-node/include/esp_openclaw_room_node.h`): a board port supplies `display`, `audio`, `services`, `storage` callbacks. The `services.register_commands` hook is exactly where the robot layer (servo/face/camera commands) plugs in. **This is the single strongest part of the plan and it is correct.**

### 2.2 Protocol: WebSocket JSON-RPC to the Gateway — TRUE
`components/esp-openclaw-node/src/esp_openclaw_node_protocol.c` implements `connect.challenge` → signed `connect` → `hello-ok`, then `node.invoke.request`/`node.invoke.result`, with `minProtocol:3, maxProtocol:4` (lines 265–266). Transport is `esp_websocket_client` (`esp_openclaw_node.c:23-30`). The architecture diagram's WebSocket + JSON-RPC + Ed25519 pairing description is accurate.

### 2.3 WebRTC audio (Opus 16 kHz) — TRUE
`room_media.c` configures the Talk sink at `sample_rate=16000, channel=1` (lines 346–348) and the capture at 16 kHz. The WebRTC voice path via `esp-openclaw-talk` (`talk.client.create` → offer-URL SDP exchange → provider-direct media) is real and matches the diagram.

### 2.4 The Gateway supports the node protocol — TRUE (but see §3.1 for the port)
The live gateway (OpenClaw 2026.7.1-2) implements `connect.challenge` and `node.invoke.request` (found in `dist/server-methods-list-L_OppjbT.js`), has `talk.client.create` (`dist/server-methods-NpEcZnvp.js`), and exposes `openclaw nodes approve/pending/invoke`. `gateway.bind` is already `lan`. So the protocol path is viable.

### 2.5 The StackChan `stackchan/` robot brain is self-contained — TRUE (with caveats, see §3.3)
`stackchan/motion/`, `stackchan/avatar/`, `stackchan/modifiers/`, `stackchan/animation/` have **no xiaozhi includes** — they depend only on LVGL, `smooth_ui_toolkit`, and `ArduinoJson`. The servo driver (`hal/hal_servo.cpp`) uses `_scs_bus.begin(UART_NUM_1, 1000000, 6, 7)` — UART1 @ 1 Mbps, GPIO6/7, exactly as the plan states. The spring-damper motion model, `lookAtNormalized`, `lookAtPoint` IK, and NVS zero-calibration are all real and portable.

### 2.6 The custom wake word path is real — TRUE (but not "2–5 hours", see §3.4)
The xiaozhi firmware has a genuine `USE_CUSTOM_WAKE_WORD` (MultiNet) path (`main/Kconfig.projbuild:891`, `main/audio/wake_words/custom_wake_word.cc`) that reads a `multinet_model` from the assets `index.json`. And critically, **the StackChan firmware already ships a custom-trained WakeNet model** — `CONFIG_SR_WN_WN9_HISTACKCHAN_TTS3=y` ("Hi StackChan") in its `sdkconfig.defaults`. This proves a custom wake word for this exact hardware is achievable. The plan's "Option C: multi-wake-word model with a slot we can map" is also real (WakeNet supports up to 5 wake words per the ESP-SR docs).

### 2.7 zclaw dismissal is mostly fair
zclaw is text-only (no audio, no wake word, no MCP, no OpenClaw). The plan's "smallest contributor" label is accurate. The analysis report correctly identifies the reusable patterns (agent loop, tool registry, boot-guard/safe-mode, HTTP gate, NVS provisioning), but since the agent loop lives on the Gateway in this architecture, zclaw's value is genuinely marginal. See §6.2 for the one thing worth stealing.

---

## 3. What's Wrong (with evidence and fixes)

### 3.1 ❌ WRONG PORT: The Gateway is on 18789, not 19001
**Evidence:** The live gateway listens on `*:18789` (`lsof`), config `gateway.port = 18789`, and `openclaw.json` has `"port": 18789`. Port **19001 is the `--dev` profile default** (`dist/cli-startup-metadata.json`: "default gateway port 19001"), not the production port. The plan's architecture diagram (`ws://gateway:19001`), BUILD_PLAN (`ws://host:19001`), and TODO (`ws://localhost:19001`) are all wrong.

**Fix:** Use `ws://<Clawdio-Mini-LAN-IP>:18789`. The gateway is bound to `lan` and listening on all interfaces, so it's reachable over Wi-Fi. Generate the setup code with `openclaw qr --voice-node --setup-code-only` (the Waveshare README documents this exact flow) — the setup code embeds the correct URL, so the firmware doesn't hardcode the port.

### 3.2 ❌ WRONG AUTH MODEL: The gateway uses password auth, and `gateway.nodes.commands.allow` is unset
**Evidence:** `openclaw.json` has `"auth": {"mode": "password", "password": "clawdiomax"}`. The esp-openclaw-node supports `gateway password <ws://host:port> <password>` (documented in `docs/getting-started.md`), so this is workable — but the plan's pairing flow only mentions setup codes and never accounts for the password auth mode. Worse, `gateway.nodes.commands.allow` is **not set** (only `denyCommands` is). The esp-openclaw-node getting-started doc explicitly warns: "If the gateway does not allow the example's commands, the node can connect and still show `commands: []`."

**Fix:** Before pairing, run `openclaw config set gateway.nodes.commands.allow '<json-array-from-example>' --strict-json` and `openclaw gateway restart`. Decide the auth path: either use a setup code (requires the gateway to issue one) or the password mode. The plan must add this as an explicit Phase-1 step, not leave it implicit.

### 3.3 ❌ OVERSTATED: "Waveshare S3 is 90% there" — it's ~40–50% as board code, 100% as port contract
**Evidence:** The Waveshare board port (`examples/waveshare-.../main/main.c`, 249 lines) is a thin adapter. But the actual hardware differs substantially from CoreS3:

| Aspect | Waveshare S3 (template) | M5Stack CoreS3 (target) |
|---|---|---|
| Display | SH8601 **QSPI AMOLED** 466×466, cannot DMA from PSRAM (special even-row workaround) | **ILI9342 SPI LCD** 320×240, different driver (`esp_lcd_ili9341`) |
| Speaker codec | **ES8311** | **AW88298** |
| Mic codec | ES7210 (MIC1+MIC3) | ES7210 (with reference channel) |
| I2S mode | **STD** stereo (`I2S_STD_PHILIP_SLOT_DEFAULT_CONFIG`) | **TDM** 4-slot (for AEC reference, `AUDIO_INPUT_REFERENCE=true`) |
| BSP | `bsp/esp-bsp.h` (Waveshare BSP) | M5Stack/xiaozhi board files |
| Extra HW | BOOT button only | AXP2101 PMIC, AW9523 IO expander, FT6336 touch, BMI270 IMU, GC0308 camera, PCF8563 RTC, Si12T touch, servos |

The **port contract** (the `esp_openclaw_room_node_config_t` struct) is 100% reusable — that's the "90%" the plan is really getting. But the **board code** is maybe 40–50% reusable: the display init, audio codec wiring, and I2S mode all differ. The Waveshare `audio_open` uses `I2S_STD_PHILIP_SLOT_DEFAULT_CONFIG`; CoreS3 needs TDM for the reference channel. The display DMA constraints are completely different.

**Fix:** Reframe the estimate. The Waveshare example is a *structural* template (how to fill the port struct), not a *code* template. The CoreS3 board port is real engineering: reuse the Waveshare's `audio_open` skeleton but swap ES8311→AW88298 and STD→TDM; write the ILI9342 display init from scratch (or borrow from the StackChan `stackchan_display.cc`); wire the AXP2101 PMIC, FT6336 touch, and the extra sensors. Budget this as a **2–3 day** task, not a "copy and adapt" task.

### 3.4 ❌ OVERSTATED: "StackChan robot layer is cleanly separable" — the display and camera are deeply coupled to xiaozhi
**Evidence:** Two hard couplings:
1. **Display:** `hal/board/stackchan_display.h` — `class StackChanAvatarDisplay : public LvglDisplay`, where `LvglDisplay` is a **xiaozhi-esp32 class** (`display/lvgl_display/lvgl_display.h`). The robot's face is a subclass of the xiaozhi display system. You cannot drop it into esp-openclaw-node's LVGL display without re-parenting it.
2. **Build tree:** `firmware/main/CMakeLists.txt` compiles the **entire xiaozhi-esp32 `main/` tree** (audio, display, protocols, MCP, application, OTA, all board common files) together with the robot layer. The `hal_bridge.cc` directly calls `Application::GetInstance().Run()` (xiaozhi's app loop) and includes `application.h`, `board.h`, `display.h`, `assets.h`.
3. **Camera:** `hal/board/stackchan_camera.cc` includes `esp_video_device.h`, `mcp_server.h`, `system_info.h`, `board.h`, `display.h`, `lvgl_display.h` — all xiaozhi classes. The camera is not separable.

**Fix:** Do NOT try to "borrow" the whole robot layer. Extract only the self-contained pieces:
- **Servo + motion:** `stackchan/motion/` + `hal/hal_servo.cpp` + `drivers/FTServo_Arduino/` — these are portable (depend only on LVGL/smooth_ui_toolkit/ArduinoJson). This is the high-value, low-risk extraction.
- **Avatar face:** `stackchan/avatar/` is self-contained, but the `StackChanAvatarDisplay` wrapper is not. Re-parent the avatar widget tree onto esp-openclaw-node's LVGL display (the room-node already has a procedural face in `room_face.c` — consider mapping emotions to that instead of porting the whole StackChan avatar).
- **Camera:** treat as a separate, later task. The `Explain()` vision hook is real but depends on xiaozhi's `mcp_server`/`board`/`display`. Rewrite it as a standalone `esp_video` capture → JPEG → POST, not a port.
- **Sensors (IMU/touch):** the drivers (`drivers/bmi270`, `drivers/Si12T`) are portable; the gesture recognizers are in `stackchan/modifiers/` and are self-contained.

### 3.5 ❌ OVERSTATED: "~1 week of focused work" — realistically 2–3 weeks
**Evidence:** The plan's phases underestimate the real work:
- Phase 1 (1–2 days) assumes the Waveshare port is "90% there" — it's not (see §3.3). The CoreS3 board port alone is 2–3 days.
- Phase 2 (2–3 days) assumes the robot layer is "cleanly separable" — it's not (see §3.4). Extracting and re-parenting the servo/face/camera is 3–5 days.
- Phase 3 (2–5 hours) assumes a wake word generator exists — it doesn't (see §3.6). This is a research + external-vendor task.
- Phase 4 (1 hour) is fine.
- Phase 5 (1–2 days) is fine but assumes Phases 1–3 completed.

**Fix:** Re-baseline to **2–3 weeks** of focused work, with the wake word as a parallel/decoupled track (see §3.6).

### 3.6 ❌ WRONG: "Custom Hey Rosie wake word via ESP-SR" is a 2–5 hour task — it's a research + external-vendor problem
**Evidence:** There is **no self-service online generator** for ESP-SR custom wake words. The ESP-SR customization process is a **submission to Espressif** — the official path is the GitHub issue "Want to suggest a wake word?" (`espressif/esp-sr#88`, still open and updated 2026-08-17) or an application form. Espressif trains the model for you; there is turnaround time and no guarantee they accept "Hey Rosie" (English, non-standard). The esp-openclaw-node README itself states: "an arbitrary text trigger cannot replace a compiled local WakeNet model."

**What's actually available:**
- **Pre-trained WakeNet models** ship with esp-sr (e.g. `wn9_hiesp`, `wn9_nihaoxiaoan`, `wn9_jarvis_tts`). None is "Hey Rosie."
- **MultiNet** (the `USE_CUSTOM_WAKE_WORD` path) supports up to 200 command words and is the xiaozhi-assets-generator flow — but the model must still be trained externally (via the assets generator / Espressif tooling).
- **The StackChan firmware already has a custom model** (`HISTACKCHAN_TTS3` = "Hi StackChan") — proof it's possible, but it was trained by/for M5Stack, not self-served.

**Fix:** Treat the wake word as a **decoupled research track with a fallback**, not a Phase-3 task:
1. **Immediate (works today):** Ship with a stock WakeNet model (`wn9_hiesp` = "Hi ESP") or the StackChan `HISTACKCHAN_TTS3` ("Hi StackChan") to get the device working end-to-end. Change the wake callback string in `room_media.c:61` (`wake_callback("hiesp", ...)`) to match.
2. **Parallel research:** Submit "Hey Rosie" to Espressif (issue #88 / application form) and/or evaluate the `xiaozhi-assets-generator` MultiNet flow. This is a **days-to-weeks external dependency**, not 2–5 hours.
3. **Fallback:** Keep "Hi StackChan" or "Hi ESP" and rely on the Gateway for routing (the room-node already handles `voicewake.changed` events). This is a perfectly acceptable v1.

---

## 4. What's Hand-Waving (claims needing real research, with what to check)

### 4.1 "The OpenClaw Gateway supports the esp-openclaw-node protocol" — mostly verified, but the Talk voice path is unproven
The control plane (`connect.challenge`, `node.invoke`) is confirmed in the gateway dist. But the **`gateway-control-v1` Talk capability** (required by `esp-openclaw-talk` for voice) was **not found** in the gateway dist (`grep -r "gateway-control-v1" dist/` returned nothing). The esp-openclaw-node analysis warns "older Gateways fail with 'Gateway upgrade required'" for this. The gateway here is 2026.7.1-2 (recent), and it has `talk.client.create` and `createRealtimeVoiceBridgeSession`, so it *likely* supports it — but this is the **single highest-risk unknown** and must be verified with an actual device before committing to the WebRTC voice path.

**What to check:** After Phase-1 bring-up, run a Talk smoke test (`openclaw> wake` console command on the device) and confirm the gateway returns a valid offer URL + clientSecret rather than "Gateway upgrade required." If it fails, the fallback is the interim MCP server (`server.py`) per ADR-004.

### 4.2 "esp-sr ~2.3.0 (StackChan) vs ^2.4.7 (esp-openclaw-node)" — a real version conflict to resolve
StackChan pins `espressif/esp-sr: ~2.3.0`; esp-openclaw-node requires `^2.4.7`. The component manager will resolve to 2.4.7, but StackChan's audio/wake code was written against 2.3.0. **This only matters if you reuse StackChan's audio/wake code** — which you should NOT (use esp-openclaw-node's `room_media.c` pipeline instead). The robot layer pieces you *do* reuse (servo/face/camera/sensors) don't use esp-sr. So this is a non-issue **if** you keep the audio pipeline entirely on esp-openclaw-node. Flag it only if you try to reuse StackChan's `afe_audio_engine` or wake code.

### 4.3 "ESP-IDF v5.5.4 vs v5.5.5" — a non-issue, resolvable now
Both satisfy the requirements: core `>=5.0`, talk `>=5.3`, CI uses `release-v5.5`. The Tab5 pins `==5.5.5` only because of its `esp_hosted`/`esp_wifi_remote` P4+C6 dependencies, not a core requirement. The Waveshare example (our template) uses `release-v5.5` with no pin. **Pick 5.5.4** to match the StackChan robot layer's tested environment (its `dependencies.lock` pins `idf 5.5.4`), or 5.5.5 if you want the latest patch. Either works; this is not a blocker.

### 4.4 "Servo UART1 conflict" — RESOLVED, no conflict (see §5.1)

---

## 5. Resolved Questions (the plan lists these as "decisions needed"; I resolved them from source)

### 5.1 ✅ Servo UART1 conflict — NO CONFLICT
The StackChan servos use **UART1** (GPIO6/7, `_scs_bus.begin(UART_NUM_1, 1000000, 6, 7)`). The esp-openclaw-node **does not use UART1** — its only UART usage is the provisioning REPL, which uses **UART0** (default `ESP_CONSOLE_DEV_UART_CONFIG_DEFAULT()`) or **USB Serial/JTAG** (`CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y` in the Waveshare sdkconfig). The only UART1 usage in the entire esp-openclaw-node repo is the **Tab5** example's RS-485 (GPIO20/21), a different board. **Resolution: servos on UART1, console on USB Serial/JTAG (as the Waveshare template already does). No conflict. Remove this from the decision list.**

### 5.2 ✅ ESP-IDF version — pick 5.5.4 (see §4.3). Non-issue.

### 5.3 ✅ Gateway connection — the protocol is supported, but the port is 18789 (not 19001) and auth is password (see §3.1, §3.2). The "verify ws://localhost:19001" TODO is testing the wrong port.

### 5.4 ✅ Wake word model generation — there is NO online self-service generator; it's a submission to Espressif (see §3.6). The "research if Espressif has an online generator" TODO is answered: **it does not.** Use a stock model + fallback, and submit "Hey Rosie" as a parallel track.

---

## 6. Missing Risks (not in the plan's risk register)

### 6.1 ⚠️ esp-sr / esp_video / LVGL version skew between the two repos
StackChan pins `esp_video ==1.3.1`, `esp-sr ~2.3.0`, `esp_codec_dev ~1.5.4`, `LVGL ~9.4.0`. esp-openclaw-node uses `esp-sr ^2.4.7` and LVGL 9.x via BSP. If you extract the StackChan camera (which needs `esp_video ==1.3.1`) into a firmware that also pulls esp-openclaw-node's deps, the component manager may resolve conflicting versions. **Mitigation:** keep the camera on a separate, later track; verify the resolved dependency graph early (`idf.py reconfigure` + inspect `dependencies.lock`).

### 6.2 ⚠️ The `smooth_ui_toolkit` + `ArduinoJson` + `mooncake` dependency chain
The StackChan robot brain (`stackchan/`) depends on `smooth_ui_toolkit` (v2.12.0) and `ArduinoJson` (v7.4.2), fetched by `fetch_repos.py`. These are external repos, not part of xiaozhi. Extracting the servo/face code means pulling these in too. **Mitigation:** add them as managed components in the new firmware's `idf_component.yml`. This is mechanical but must be planned, not assumed.

### 6.3 ⚠️ The room-node's procedural face vs the StackChan avatar — a design collision
esp-openclaw-node's room-node already has a procedural LVGL face (`room_face.c`) driven by Talk state. The plan wants to port the StackChan avatar (eyes/mouth/bubble with emotions). These are **two competing face systems**. You must pick one or reconcile them. **Mitigation:** start with the room-node's built-in face (zero work, already wired to Talk state), then optionally replace it with the StackChan avatar later. Don't port both.

### 6.4 ⚠️ Camera + Talk media contention
The room-node has `esp_openclaw_room_node_try_acquire_camera()` / `release_camera()` to serialize camera capture against Talk media. The StackChan camera code doesn't know about this. If you add camera vision while a voice call is active, you can corrupt the audio pipeline. **Mitigation:** wire the camera capture through the room-node's camera-acquire/release API.

### 6.5 ⚠️ The gateway's `denyCommands` blocks `camera.snap`/`camera.clip`
The live gateway config denies `camera.snap` and `camera.clip`. If the plan's "Show me [image]" → camera capture feature relies on a `camera.*` command, it will be blocked. **Mitigation:** either remove those from `denyCommands` or use a differently-named custom command (e.g. `rosie.vision`) via the board's `register_commands` hook.

### 6.6 ⚠️ No OTA/rollback plan for the new firmware
The StackChan firmware has dual-OTA + rollback (`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`). The plan doesn't mention OTA for the new `rosie-node`. For a physical device you'll iterate on, a bricked flash is a real risk. **Mitigation:** keep the dual-OTA partition table and rollback from the start.

### 6.7 ⚠️ The `server.py` MCP fallback is a trap
ADR-004 keeps `server.py` as a fallback. But the xiaozhi cloud path (which `server.py` bridges) is a **different protocol** (xiaozhi WebSocket hello + Opus) than the OpenClaw node protocol. The fallback is not a drop-in — it's a separate integration. **Mitigation:** treat `server.py` as a genuinely separate interim system, not a "fallback" for the firmware work. Don't let it absorb effort from the primary path.

---

## 7. Revised Effort Estimate

Grounded in the actual source, here is a realistic re-baseline:

| Phase | Plan estimate | Revised | Why |
|---|---|---|---|
| **0. Gateway prep** | (missing) | **0.5 day** | Set `gateway.nodes.commands.allow`, confirm port 18789, decide auth (password vs setup code). |
| **1. Core bring-up** | 1–2 days | **2–3 days** | CoreS3 board port is real work: ILI9342 display init, AW88298+ES7210 TDM audio, AXP2101 PMIC, FT6336 touch. Waveshare is a structural template, not a code template. |
| **2. Robot layer** | 2–3 days | **3–5 days** | Extract servo+motion (portable) + re-parent avatar onto room-node display (or use built-in face) + standalone camera. The "cleanly separable" claim is false for display/camera. |
| **3. Wake word** | 2–5 hours | **1–2 days (fallback) + parallel research (days–weeks)** | No self-service generator. Ship stock model now; submit "Hey Rosie" to Espressif as a decoupled track. |
| **4. Gateway config** | 1 hour | **1 hour** | Unchanged. |
| **5. Polish** | 1–2 days | **2–3 days** | Audio calibration, wake sensitivity, servo-speech coordination, camera vision. |
| **Total** | **~1 week** | **~2.5–3 weeks** | Plus the wake word is an external dependency that may not land in that window. |

**Key de-risking moves (in priority order):**
1. **Verify the Talk voice path first** (the `gateway-control-v1` capability) — this is the make-or-break unknown. Do it in Phase 1, not Phase 5.
2. **Use the room-node's built-in procedural face** for v1 instead of porting the StackChan avatar — zero work, already wired to Talk state.
3. **Ship with a stock wake word** ("Hi ESP" or "Hi StackChan") and submit "Hey Rosie" as a parallel external track.
4. **Extract only the servo+motion code** from StackChan (the genuinely portable, high-value piece); treat camera and sensors as later, separate tasks.
5. **Fix the port to 18789 and set `gateway.nodes.commands.allow`** before any device work.

---

## Appendix: Key Source References

- **esp-openclaw-node core is board-agnostic:** `components/esp-openclaw-node/CMakeLists.txt` (REQUIRES: cjson, esp_app_format, esp_websocket_client, libsodium, mbedtls, nvs_flash).
- **Board port contract:** `components/esp-openclaw-room-node/include/esp_openclaw_room_node.h` (`esp_openclaw_room_node_config_t`).
- **Protocol v3–4:** `components/esp-openclaw-node/src/esp_openclaw_node_protocol.c:265-266`.
- **Waveshare board port (249 lines):** `examples/waveshare-.../main/main.c`.
- **Waveshare wake word hardcoded:** `components/esp-openclaw-room-node/room_media.c:61` (`wake_callback("hiesp", ...)`).
- **StackChan servo UART1:** `firmware/main/hal/hal_servo.cpp:335` (`_scs_bus.begin(UART_NUM_1, 1000000, 6, 7)`).
- **StackChan display coupled to xiaozhi:** `firmware/main/hal/board/stackchan_display.h` (`class StackChanAvatarDisplay : public LvglDisplay`).
- **StackChan build compiles all of xiaozhi:** `firmware/main/CMakeLists.txt` (globs xiaozhi `main/` sources).
- **StackChan custom wake model:** `firmware/sdkconfig.defaults` (`CONFIG_SR_WN_WN9_HISTACKCHAN_TTS3=y`).
- **StackChan deps:** `firmware/main/idf_component.yml` (esp-sr ~2.3.0, esp_video ==1.3.1, LVGL ~9.4.0).
- **xiaozhi custom wake word path:** `firmware/xiaozhi-esp32/main/Kconfig.projbuild:891` (`USE_CUSTOM_WAKE_WORD`), `main/audio/wake_words/custom_wake_word.cc`.
- **Gateway port/auth:** live `openclaw.json` (`port: 18789`, `auth.mode: password`), `lsof` (`*:18789`).
- **Gateway node protocol:** `dist/server-methods-list-L_OppjbT.js` (`connect.challenge`, `node.invoke.request`).
- **19001 is dev-only:** `dist/cli-startup-metadata.json` ("default gateway port 19001" under `--dev`).
