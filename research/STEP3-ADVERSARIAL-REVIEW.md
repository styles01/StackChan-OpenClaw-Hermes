# STEP 3 — Adversarial Review of STEP2-MERGE-PLAN.md

**Reviewer:** Ernest (subagent, adversarial)
**Date:** 2026-08-19
**Documents reviewed:**
- `README.md` (the brief)
- `BUILD_PLAN.md` (old 486-line plan, v1 swap-backends)
- `research/STEP2-MERGE-PLAN.md` (the 5-phase merge plan under review)
- `research/STEP1-REPO-AUDIT.md`, `STEP1-HERMES-REUSABLE.md`, `STEP1-FIRMWARE-CODE-PATH.md`

**Ground truth verified on disk during this review:**
- Official `repos/StackChan/firmware/patches/xiaozhi-esp32.patch` = **273 lines**, 5 files, already applied by `fetch_repos.py`.
- circlemouth `Hermes-StackChan/firmware/patches/xiaozhi-esp32.patch` = **1188 lines**, 11 files.
- Both `repos.json` files are **byte-identical** and both declare `patch: patches/xiaozhi-esp32.patch` against the **same** `78/xiaozhi-esp32 @ v2.2.4`.
- The two patches **overlap in 5 files**: `main/application.cc`, `assets.cc`, `assets.h`, `boards/common/i2c_device.cc`, `i2c_device.h`.
- Official `sdkconfig` compiles `CONFIG_OTA_URL="https://api.tenclass.net/xiaozhi/ota/"` (live cloud endpoint).
- Official firmware dir carries ~**1.2 GB of build cruft** (`build/` 573M, `managed_components/` 615M, `xiaozhi-esp32/` 22M).
- Our repo's `.gitignore` ignores `firmware/` and `repos/` entirely (STEP1-REPO-AUDIT).

---

## 1. Alignment with the Brief

### 1a. Does the merge plan actually build what the brief describes?

**Partially — and on the wrong side of the line in one important way.**

The brief's centerpiece is **profile binding so each physical robot knows which backend AND which agent it belongs to**, delivered as a **per-robot config on the device** (`backend: 0/1` selector + agent-binding headers). The merge plan keeps this concept but **relocates the binding decision from the device to the ai-server**.

- Merge plan Phase 4 step 18 adds a `backend: "openclaw" | "hermes"` selector to ai-server. STEP1-HERMES-REUSABLE §8/§9 explicitly warns circlemouth's `STACKCHAN_BACKEND` is **global** — *one ai-server = one backend*, and that per-device binding is "v2 feature."
- The merge plan never specifies whether the Phase 4 selector is **per-session/per-device** or **global env**. If it inherits circlemouth's global-env design (which the plan does not override), then **Robot A (OpenClaw) and Robot B (Hermes) cannot coexist on one ai-server** — violating the brief's whole "one fleet spans both worlds" premise and the README's own Robot A/B/C table.
- The merge plan **drops plaipin's device-side `backend` selector as a runtime-reconfigurable knob.** Phase 3 says "port the struct shape" but frames the backend choice as an ai-server concern, not a device-profile concern. The brief explicitly says profiles are "configured via BLE provisioning or the web config editor — no reflashing needed" and that the `backend` field in *config* selects the backend. The merge plan's web-config editor (Phase 3 step 15) edits firmware `/config`, but if backend routing lives in ai-server `.env`, the web editor on the device cannot switch backends. **This is the single biggest alignment failure.**

### 1b. Profile binding — delivered?

**Not as specified.** The plan preserves the session-key format (`agent:<agent_id>:stackchan:<device_id>`) which is the *agent* half of binding, and that's good. But the *backend* half of binding is either global or unstated. The plan also never addresses per-robot identity propagation: how does ai-server learn the `device_id` / MAC to build the per-device session key? STEP1-FIRMWARE-CODE-PATH §4 says the device sends `Device-Id` (MAC) and `Client-Id` (UUID) in the WebSocket handshake — the plan should specify that ai-server reads `device_id` from the hello handshake to construct `agent:<agent_id>:stackchan:<device_id>`. It does not.

### 1c. Dual backend — actually wired up?

**Both backends exist in the source, but the plan wires up only OpenClaw end-to-end.**

- OpenClaw: ai-server `openclaw.ts` (68/68 tests, 9 OpenClaw tests passing per STEP1) + firmware WS bridge → **credible**.
- Hermes: ai-server `hermes.ts` exists in circlemouth, but STEP1-HERMES-REUSABLE notes Hermes depends on the `hermes-agent` submodule for STT/TTS/LLM. The merge plan's Phase 4 step 20 ("Hermes session key routing already exists") is the **only** Hermes action item, and it's a checkbox, not a build step. There is **no plan to stand up the Hermes sidecar, no test for the Hermes path in this merge, and no verification step for Robot B talking to Agent B.** The brief's "validated — Agent B on Hermes:8643" claim comes from the *old* test harness (`test_agent_binding.py`), which talks to an HTTP endpoint — **not** through the new ai-server WebSocket bridge. The merge plan does not port or re-run those tests against the new architecture.

### 1d. Web config editor and test harness — preserved?

**The web config editor is preserved but semantically broken; the test harness is preserved but not wired to the new architecture.**

- `test-harness/web-config.html` talks to the device's `/config` endpoint (Phase 3 step 15). But under the new architecture the device config no longer controls the backend — the ai-server does. **So the editor's "Switch active backend" control (a README feature) would edit a field that no longer has any effect.** Either the editor must be re-pointed to ai-server, or the backend selector must move back to the device. The plan does neither.
- The test harness (`test_agent_binding.py`, `e2e_test_harness.py`) is listed as "already exists" but the merge plan's Phase 5 verification steps (25–27) do **not** include running these. They test HTTP `/v1/chat/completions` + session-key semantics against the Gateway — valuable, but they do **not** test the new path (device → WS → ai-server → OpenClaw). The plan never adds a test that exercises the WebSocket/Opus bridge against an agent. STEP1-HERMES notes the ai-server itself has 68/68 unit tests — the plan should re-run those in OUR repo, but doesn't list it.

### 1e. The brief's "thin audio client" fact vs. the merge plan — actually consistent

The brief (and STEP1-FIRMWARE-CODE-PATH) correctly describes the device as a thin audio client where STT/LLM/TTS happen on the server. The merge plan is **consistent with this** — good. This is a point in the plan's favor (see §3c below).

---

## 2. Alignment with the Old BUILD_PLAN.md

### 2a. v1 Swap-Backends vs. the merge plan architecture — do they conflict?

**They are two different architectures and the merge plan does not explicitly supersede the old one.** This is a real problem: the repo has a 486-line BUILD_PLAN that says "fork from Stack-chan, keep plaipin's body, add MiniSTT/MiniTTS/BodyCommandParser, audio_pipeline.py on port 18791." The merge plan silently replaces this with "official firmware + circlemouth WS bridge + ai-server." Nothing in STEP2 says "BUILD_PLAN.md is obsolete." If the merge proceeds, **BUILD_PLAN.md, its `server/audio_pipeline.py` spec, MiniSTT/MiniTTS, the 18791/18790/18789 port map, and the "swap-backends" decision record all become dead — and nobody has been told.**

Notably the two are **not even the same STT/TTS approach**:
- Old plan: device captures WAV, POSTs to FastAPI `/stt` + `/tts` on 18791; LLM via OpenClawClient → proxy 18790 → gateway 18789.
- New plan: device streams OPUS over WebSocket to ai-server:8765; ai-server does STT/TTS and routes LLM.
These **cannot both be true.** The merge plan must state which is canonical. It does not.

### 2b. The mini server vs. circlemouth's ai-server — which are we building?

**The plan never answers this.** Two completely different servers exist in the plan universe:
- Old: `server/audio_pipeline.py` (FastAPI, faster-whisper + Kokoro, ports 18791, LLM proxy 18790). **Per STEP1-REPO-AUDIT it does not exist yet (0% built).**
- New: circlemouth `ai-server/` (TypeScript, WebSocket 8765, Opus, `openclaw.ts`).

The merge plan only mentions ai-server. It is silent on whether `audio_pipeline.py` is abandoned. The README's status table still lists the OpenClaw Path as "HTTP POST /v1/chat → Gateway :18789" (the *old* design) while the Hermes Path is the ai-server. **So the README itself is internally inconsistent with the new architecture** — the OpenClaw path diagram is the plaipin HTTP model, not the ai-server WS model. The merge plan does not reconcile the README.

### 2c. Old plan "keep STT/TTS in place" (device-side) vs. thin audio client

**The old BUILD_PLAN is factually wrong about the device, and the merge plan is right — but this contradiction is never acknowledged.**

STEP1-FIRMWARE-CODE-PATH is unambiguous: the device is a **thin audio client**; STT/TTS run on the server by default; the firmware only OPUS-encodes mic input and decodes TTS. The old plan's "keep STT/TTS in place / swap backends device-side / M5.Mic → WAV POST" model does **not** match the official firmware at all (the official firmware has no `STTBase`/`TTSBase`/`Whisper.cpp` — those are plaipin's Arduino constructs that don't exist in the ESP-IDF tree). So the old plan's entire Phase 3 (retarget backends) is **inapplicable to the official firmware**. The merge plan correctly abandons it, but **never says so**, leaving future readers to reconcile two mutually exclusive plans.

---

## 3. Technical Risks

### 3a. ⚠️ CRITICAL: The circlemouth patch will NOT apply cleanly on top of the official firmware's copy of xiaozhi-esp32.

**This is the most serious technical flaw in the merge plan, and it is demonstrable from disk:**

- The merge plan's Phase 1 copies the **official** firmware — which already has its own **273-line `patches/xiaozhi-esp32.patch`**, applied by `fetch_repos.py` at dependency-fetch time.
- Phase 2 then copies circlemouth's **1188-line** `xiaozhi-esp32.patch` and updates `repos.json` to apply it.
- **But both patches target the SAME `78/xiaozhi-esp32 @ v2.2.4`, and they overlap in 5 files** (`application.cc`, `assets.cc`, `assets.h`, `i2c_device.cc`, `i2c_device.h`).

Concrete collision on `application.cc::ShowActivationCode()`:
- Official patch **comments out** the function body (verified: `-struct digit_sound {...}` → `+// struct digit_sound {...}`).
- circlemouth patch **replaces** the whole function (verified: `-void Application::ShowActivationCode(...)` → `+void Application::ShowActivationCode(...)` at line 250/305).

Because `fetch_repos.py` applies the official patch to the pristine v2.2.4 checkout, and Phase 2 then applies circlemouth's patch to that **already-patched** tree, the second `git apply` will either (a) **reject hunks** on `application.cc`/`assets.cc`/`assets.h`/`i2c_device.cc`/`i2c_device.h`, or (b) **silently apply** to already-commented-out/replaced code producing a **duplicate or malformed function body** that compiles wrong or not at all. The plan's Phase 2 step 8 ("verify the patch applies cleanly against xiaozhi-esp32 v2.2.4") verifies against **stock** v2.2.4, not against the **officially-patched** tree — so even a "clean" check is the wrong check.

**Required fix:** either (1) copy the official firmware *without* its `xiaozhi-esp32.patch` and apply only circlemouth's, then port the 3 official-only changes (backlight, i2c, assets) by hand; or (2) generate a **combined/rebased** single patch. The plan does neither.

### 3b. Also CRITICAL: `assets.cc`/`assets.h` conflict is not just cosmetic.

STEP1-FIRMWARE-CODE-PATH says the official patch's assets changes are the `EmoteStrategy` comment-out (display strategy). Circlemouth's patch **also** touches `assets.cc/.h`. If both apply, you get two competing edits to the same emote/asset logic. Given the official firmware is the one that actually boots on this CoreS3 (built & flashed Aug 18), overwriting its assets logic with circlemouth's could regress the working display. The plan treats circlemouth's patch as a drop-in, which it is not.

### 3c. plaipin Arduino → ESP-IDF port — how hard, what differs?

**The merge plan seriously understates this.** Phase 3 step 14 says "adapt from Arduino HTTP to ESP-IDF HTTP client (different API)" as one bullet. The real gaps:

- **No STT/TTS seams exist in the official firmware.** plaipin's `STTBase`/`TTSBase`/`Whisper.cpp`/`PlayMP3.cpp` are Arduino constructs; the ESP-IDF firmware has none of these (STT/TTS are server-side). So "port OpenClawClient.cpp" is not a small HTTP-API swap — you are porting a class into a codebase whose audio pipeline **does not have the hooks it expects** (`M5.Mic`, `AudioWhisper`, `PlayMP3`, `M5.Speaker.playRaw`).
- **HTTP API surface differs fundamentally:** Arduino `HTTPClient` (getString/getStream, multipart) vs. ESP-IDF `esp_http_client` (event-driven, chunked, TLS cert config). Session-key/header injection, auth, and streaming all need rework.
- **Config persistence differs:** plaipin uses SPIFFS YAML (`StackchanExConfig.h`); official firmware uses **NVS** (`websocket` namespace) + SD `/config.json`. Porting plaipin's config struct + `/config` endpoints onto an NVS-based device means re-writing the persistence layer, not just the HTTP layer.
- **Danger of redundant OpenClaw paths:** Phase 3 ports `OpenClawClient.cpp` into the *firmware*, while Phase 4 does OpenClaw routing in the *ai-server* (`openclaw.ts`). Under the new architecture the firmware should **not** talk to the Gateway directly at all (it talks to ai-server over WS). Porting OpenClawClient into the firmware either duplicates the path (firmware→Gateway HTTP *and* firmware→ai-server→Gateway) or is dead code. **The plan never decides which OpenClaw client is authoritative.** This is a contradiction, not a port.

Verdict on port difficulty: **not 1 bullet — it's 1–2 days of real work, minimum**, and it conflicts with the thin-client design.

### 3d. Copy official firmware → `firmware/` — clean source or cruft?

**The plan says "Copy `repos/StackChan/firmware/` into our repo root as `firmware/`" with zero filtering.** On disk that directory contains **~1.2 GB** of `build/` (573M), `managed_components/` (615M), `xiaozhi-esp32/` (22M), plus `sdkconfig` (121K), `dependencies.lock`. If you `cp -R` the whole thing and commit, you push a gigabyte of binary cruft. If you copy clean, you must run `git clean`/`rm` of build artifacts AND handle the `.git` in the clone. The plan needs an explicit "copy **clean tracked source only** (repos.json, fetch_repos.py, CMakeLists, main/, patches/, sdkconfig.defaults, partitions.csv, tests/)" instruction. Not stated.

### 3e. ⚠️ CRITICAL: Auto-update disable has a first-boot hole.

The plan's Phase 1 Option B (recommended) = "skip OTA when local WS configured" (circlemouth's approach). Verified in circlemouth's patch:
```cpp
if (explicit_ota_url.empty() && !local_websocket_url.empty()) {
    ESP_LOGI(TAG, "Skipping cloud version check because a local websocket is configured");
```
`local_websocket_url` comes from NVS `websocket` namespace. **On first boot there is no config → `local_websocket_url` is empty → the guard is false → the device performs the cloud version check against the live `CONFIG_OTA_URL="https://api.tenclass.net/xiaozhi/ota/"`.** So a freshly-flashed, unconfigured device will **still phone home and can auto-update before you ever get a chance to configure it.** The plan's Phase 5 step 26 ("verify auto-update does NOT fire") checks the *post-config* state and would miss this window.

**Required fix:** this must be an **unconditional** skip in our fork (or `CONFIG_OTA_URL` set to empty/local in `sdkconfig.defaults`), *not* a conditional-on-config skip. The plan explicitly recommends the conditional approach — that's the bug.

### 3f. Other technical notes
- Both `sdkconfig.defaults` are ~identical except circlemouth adds `CONFIG_HERMES_AUTOSTART`, `CONFIG_USE_SERVER_AEC`, `CONFIG_USE_AFE_WAKE_WORD`, `CONFIG_USE_AUDIO_PROCESSOR`. The merge plan (Phase 1 step 3/4) doesn't say which defaults win. If we keep the official `sdkconfig.defaults` and drop circlemouth's audio flags, we lose server-AEC/wake-word behavior the ai-server path may rely on. Needs explicit decision.
- The ai-server is a **Node/TypeScript** service on the mini (or wherever). The old plan wanted a **systemd-managed Python FastAPI** service. No deployment story (systemd unit, pm2, Docker, port binding to LAN) is given for ai-server in the merge plan. "A working device" requires the ai-server to be running and reachable — the plan has no runbook for it.

---

## 4. Gaps

### 4a. What's missing that the BRIEF requires
1. **Per-device backend binding in ai-server** (device_id → backend/agent lookup). Not specified; inherited global-env model breaks the fleet premise.
2. **How the device's `device_id`/MAC flows into the session key.** Not specified (handshake has `Device-Id` — plan never uses it).
3. **Web config editor must control the backend** — currently edits a field that (under this architecture) no longer routes anything.
4. **Hermes path is not built/tested in this plan** — only a checkbox. No Hermes sidecar provisioning, no Robot-B test.
5. **README reconciliation** — the README's OpenClaw path diagram is the old HTTP model; the plan doesn't update it to the ai-server WS model.

### 4b. What's missing that the old BUILD_PLAN.md required
1. **An explicit "BUILD_PLAN.md v1 swap-backends is superseded" statement** and an archiving decision for `audio_pipeline.py`/MiniSTT/MiniTTS/BodyCommandParser specs.
2. **The body-command / marker pipeline** (`[expression:happy] [gesture:nod]`) — the old plan defined this as a first-class feature; the merge plan never carries it over. ai-server's `device_control.ts` MCP tools cover *agent→robot* tool calls, but the old plan's *agent-text-marker→avatar/servo/LED* path (and the MCP tools like `stackchan_set_head_angles`) are not wired into the merge's STT→LLM→TTS flow. The agent can't currently make the robot emote during speech.
3. **Wake word registration** (`register_wakeword`/`delete_wakeword`, "record Agent A") — absent from the merge plan.
4. **Error handling UX** (server-down/no-WiFi/STT-empty sad faces) — absent.
5. **`firmware-extras/` vs. `ai-server/` responsibility split** — the merge plan's file tree puts plaipin's config/endpoints in `firmware-extras/` but never says which parts are device-resident vs. server-resident, so duplication (see 3c) is unresolved.

### 4c. What's missing for a WORKING device (talking to an agent)
1. **ai-server deployment/runbook** (see 3f) — nothing about how it runs, auto-restarts, or is reachable at `ws://<host>:8765`.
2. **The firmware config provisioning path** — how does the device get `websocket:url=ws://host:8765/ws`? Via OTA config fetch (needs a config endpoint), via SD `/config.json`, via BLE? STEP1-FIRMWARE-CODE-PATH lists Option A (run a mini OTA endpoint) vs Option B (patch websocket_protocol to fixed URL). The merge plan never picks one.
3. **STT/TTS backend for the ai-server** — STEP1-HERMES says Hermes STT/TTS can be replaced by local endpoints (`HERMES_STT_URL`, `STACKCHAN_LOCAL_TTS_URL`) but the merge plan doesn't specify what STT/TTS the ai-server actually uses in our build. The old plan's faster-whisper/Kokoro server was the STT/TTS answer; if that's abandoned, what replaces it? Unstated.
4. **First-boot OTA auto-update** (see 3e) — could overwrite the device before it's ever configured.
5. **End-to-end test through the new WS path** — no test exercises firmware→ai-server→agent→TTS→device. The existing harness tests the old HTTP path only.
6. **MCP robot tools actually exposed to the OpenClaw agent** — STEP1-HERMES lists `device_control.ts`/`stackchan_mcp_server.ts` (13 tools). The merge plan never says the OpenClaw agent will be given these tools, or that `stackchan_*` tools are registered in the Gateway agent config.

---

## 5. Contradictions

1. **Patch provenance misattribution.** The merge plan (Phase 2) credits "ShowActivationCode() gutted" to circlemouth. **The official StackChan patch already gutted it** (verified). So Phase 2 is not "adding" a change — it's *reapplying* a conflicting change to code already changed. Plan as written will produce a patch conflict.
2. **Two OpenClaw clients.** Phase 3 ports plaipin `OpenClawClient.cpp` into firmware; Phase 4 routes OpenClaw in ai-server (`openclaw.ts`). A thin-audio-client device should use **only** the ai-server path. The plan has both and never reconciles them (redundant or dead code).
3. **Backend binding location.** Brief/README: backend is a **per-robot device config** (web editor + BLE, no reflash). Merge plan: backend is an **ai-server setting** (Phase 4, likely global env). Direct contradiction; the plan moves a core brief feature off the device.
4. **README vs. merge plan architecture.** README OpenClaw path = HTTP to Gateway:18789 (old). Merge plan = WS to ai-server:8765 (new). The plan builds the new but doesn't update the README, leaving the docs describing the abandoned path.
5. **Merge plan vs. old BUILD_PLAN.** The old plan's whole v1 (swap-backends, mini server, MiniSTT/MiniTTS, 18791/18790/18789) is silently dropped; the merge plan never states it supersedes BUILD_PLAN.md. Two authoritative-but-incompatible plans coexist.
6. **`.gitignore` contradiction.** Our repo ignores `firmware/` (and `repos/`). The merge plan wants `firmware/` **committed** to our repo (Phase 1, and the "Key Files" tree). Either the gitignore must be updated or the plan's premise (firmware lives in-repo) fails. Not addressed.
7. **Test harness vs. new architecture.** README claims "12/12 strict identity tests pass" for OpenClaw+Hermes binding — but those test the HTTP path, not the new WS bridge. The merge plan doesn't port/rerun them, so the "proof" no longer validates what we're building.
8. **`backend` selector semantics.** plaipin's config struct has `backend: 0/1` on the device. circlemouth's ai-server has `STACKCHAN_BACKEND` global env. The merge plan Phase 4 step 18 says "add config to ai-server: backend selector" — implicitly confirming the move off-device, which contradicts 3.

---

## 6. Verdict

### **NO-GO as written.** Conditional go with mandatory fixes.

The **direction is right** (official ESP-IDF firmware + circlemouth WS bridge + ai-server is the correct target architecture, and it correctly treats the device as a thin audio client — consistent with STEP1-FIRMWARE-CODE-PATH). But the plan in its current form has **one blocker (patch collision) and one design regression (backend binding moved off-device)** that must be resolved before Phase 1 starts.

### Blocking issues (must fix before/within Phases 1–2)
1. **Patch collision on xiaozhi-esp32 (3a/3b).** Decide the single source of truth for the xiaozhi patch. Recommended: start from **circlemouth's** patch as canonical, apply it to **stock** v2.2.4, and hand-port the official-only changes (backlight, i2c `TryReadRegs`, assets) that the working Aug-18 build needs. Do **not** apply both patches to the same tree. Validate by rebuilding the exact binary that boots on CoreS3.
2. **First-boot OTA (3e).** Make OTA skip **unconditional** in our fork (or blank `CONFIG_OTA_URL` in `sdkconfig.defaults`), not conditional on config existing. Otherwise the device can self-update before configuration.
3. **Backend binding (1b/1c, Contradiction 3/8).** Re-state where the backend decision lives. To satisfy the brief, ai-server must do **per-device** binding (device_id → backend+agent), or the device config must select the backend and ai-server must honor it per-connection. Resolve the conflict between device-side `backend` and ai-server global `STACKCHAN_BACKEND`.

### Required (non-blocking but must not be skipped)
4. **Clean source copy (3d).** Copy tracked source only; exclude `build/`, `managed_components/`, `xiaozhi-esp32/`, `sdkconfig`; reconcile our `.gitignore`.
5. **Declare the mini server dead (2a/2b).** Explicitly supersede `audio_pipeline.py`/18791 and the old BUILD_PLAN v1, or justify keeping it.
6. **Resolve the redundant OpenClaw client (3c, Contradiction 2).** Under thin-client, drop firmware-side `OpenClawClient.cpp`; keep `openclaw.ts` in ai-server. If any firmware HTTP client is kept, state why.
7. **Specify STT/TTS for ai-server (4c-3), device config provisioning (4c-2), and ai-server runbook (4c-1).**
8. **Add a real end-to-end test through the WS path (1d, 4c-5)** and re-run the ai-server's 68 tests in our repo.
9. **Carry over body-command markers + MCP tools (4b-2/4c-6)** so the agent can drive avatar/servos/LED during speech.
10. **Update README/architecture docs (Contradiction 4)** to the ai-server WS model, and add Hermes sidecar provisioning + Robot-B verification (1c).

**Bottom line:** Approve the *concept*, reject the *plan as written*. The patch-collision and first-boot-OTA issues are concrete, verified, and will bite on day one. The backend-binding relocation silently reneges on the brief's headline feature. Fix those three, and the merge is a sound path to a working dual-backend device.
