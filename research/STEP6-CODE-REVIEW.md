# STEP 6 — Code Review (Real Diff)

**Date:** 2026-08-19
**Scope:** Actual files created/modified for the Stack-chan OpenClaw/Hermes merge.
**Reviewer:** Dex (subagent)
**Plan reference:** `STEP2-MERGE-PLAN-REVISED.md`

Reviewed files:

| Area | Files |
|------|-------|
| firmware-extras | `stackchan_ex_config.h`, `stackchan_ex_config.cc`, `web_config_endpoints.cc`, `strip_emoji.cc`, `CMakeLists.txt` |
| firmware (modified) | `CMakeLists.txt`, `sdkconfig.defaults`, `patches/xiaozhi-esp32.patch` |
| ai-server (new) | `device_config.ts`, `devices.json` |
| ai-server (modified) | `server.ts`, `session.ts` |
| test-harness | `test_ws_e2e.py` |

---

## Verdict

**FAIL — not ready to merge as-is.** No compiler-blocking syntax errors were found in the C++/TS (the code is largely clean and idiomatic), but there are **two functional correctness bugs in the core per-device routing feature** (the central deliverable of this iteration), a **security weakness in the web config endpoint**, and several **plan-consistency violations**. None are trivial formatting nits. Fix list at the bottom.

---

## 1. Bugs

### B1 (CRITICAL) — Per-device session key is NOT per-device for OpenClaw
`server.ts` resolves `binding` per device, but `session.ts` (line ~433) constructs:
```ts
new OpenClawClient({ agentId: binding.agent_id })
```
It does **not** pass `deviceId`. Inside `OpenClawClient`, the session key defaults to:
```ts
const deviceId = options?.deviceId ?? process.env.STACKCHAN_DEVICE_ID ?? 'default'
this.sessionKey = `agent:${agentId}:stackchan:${deviceId}`
```
Result: **every device routed to OpenClaw shares session key `agent:rosie:stackchan:default`** (unless `STACKCHAN_DEVICE_ID` env is set globally). The whole point of the iteration — separate sessions/memory per robot — is silently broken for OpenClaw. Two robots on the same agent would see each other's conversation context.
**Fix:** `session.ts` must pass `deviceId` into the `OpenClawClient` (it is available in the `DeviceBinding` / connection). The unused `constructSessionKey` helper in `device_config.ts` is the intended mechanism but is never called.

### B2 (HIGH) — `constructSessionKey` is dead code
`device_config.ts` exports `constructSessionKey(binding, deviceId)` (builds `agent:<agent_id>:stackchan:<device_id>`) and `reloadConfig()`, but **neither is imported or called anywhere** in `server.ts` or `session.ts` (confirmed via grep). The session key is instead assembled implicitly inside `OpenClawClient` with a different separator/location. This is duplicated, unreconciled logic — two definitions of "the session key" that can drift. Either wire it in and use it as the single source, or delete it. Given B1, this is a strong hint the feature was half-implemented.

### B3 (MEDIUM) — Hermes backend ignores `agent_id` entirely
When `binding.backend === 'hermes'`, session.ts does `new HermesClient()` with **no arguments** — `binding.agent_id` (e.g. `venus`) is discarded. HermesClient connects to the global `HERMES_DASHBOARD_URL`/token. So the per-device `agent_id` in `devices.json` is meaningless for the Hermes path. If Hermes is intended to support per-device agents, this is unimplemented; if not, the field is misleading and should be documented as OpenClaw-only.

### B4 (MEDIUM) — `strip_emoji` erases 4 bytes unconditionally with a partial-boundary hazard
```cpp
if (c >= 0xF0 && c <= 0xF4 && i + 3 < text.size()) {
    text.erase(i, 4);
```
- The `i + 3 < text.size()` guard correctly avoids reading past the end, but if a 4-byte sequence is split at the buffer tail it is **not** stripped (benign — leaves a partial char). Acceptable.
- More important: the **2nd loop** (variation selectors / ZWJ) only strips `EF B8 80-8F` and `E2 80 8D`, but a standalone emoji that is a **3-byte** sequence (U+1F300 family are 4-byte, but many pictographs + all keycap/ZWJ composites reduce to 3-byte base + VS16) is only partially handled. Combined emoji like 👨👩👧 (ZWJ chains) get their ZWJ stripped but the base 4-byte emoji also stripped — likely fine for TTS. Low risk for the stated use case, but the first loop strips **all** 4-byte supplementary-plane chars, not just emoji — e.g. mathematical alphanumerics, CJK extension B, etc. are supplementary-plane and will be dropped from TTS text. Flagged as behavior nuance, not a crash.

### B5 (LOW) — `web_config_start()` uses hardcoded port 80 and single server
`config.server_port = 80`. The firmware already uses a web server for config elsewhere (official firmware serves `httpd` on port 80 for provisioning). If both start, there's a port conflict / second `httpd_start` fails (the code guards with `if (server_handle) return;` but that only guards re-entry of *this* function, not a *different* httpd already bound to 80). Should confirm no other component binds 80, or use a distinct port. Also `max_uri_handlers = 4` while registering 3 handlers + server-internal → tight but OK.

### B6 (LOW) — `test_ws_e2e.py` can hang / give false positives
- `test_connection` sends a raw 3-byte Opus "silence" frame `[0xF8, 0xFF, 0xFE]`. On the ai-server side this hits `extractOpusPayload`/decode; if it fails the decode path (invalid Opus), it may be silently dropped — the test then reports "no response (expected for silence)" which is a **false pass**, not a real e2e verification. The test never actually verifies STT→LLM→TTS round-trip; it just checks connect+hello. It's a connectivity smoke test, not the "end-to-end through WS path" the plan's Step 5/#9 calls for.
- `test_config_endpoint` probes `http://host:port/config` on the **ai-server** port and explicitly concedes it's expected to 404 ("expected — config is on device port 80"). The device port 80 is on the ESP32, not reachable from this script's host by default. So the "config endpoint test" never tests anything.
- `await test_connection` has no outer timeout on the whole suite if a connection stalls; individual `asyncio.wait_for` calls cover recv, but the connect itself and the suite can block.

---

## 2. Security

### S1 (HIGH) — No authentication on HTTP `/config` POST (device web server on port 80)
`config_post_handler` accepts arbitrary JSON and writes to NVS with **no auth, no CSRF check, no origin check**. Anyone on the LAN who can reach port 80 can rewrite the device's backend host/port/agent and `websocket_url`, redirecting the robot to an attacker-controlled endpoint (`ws://evil:8765/ws`) and exfiltrating what it hears / feeding it arbitrary TTS. The official firmware's provisioning server has similar exposure, but this is a persistent, device-routing-changing write endpoint. **At minimum** restrict to LAN and document; ideally add a token. This is a genuine new attack surface introduced by this diff.

### S2 (MEDIUM) — `bot_token` stored in NVS, never exposed (good) but never used (odd)
`stackchan_ex_config.h` defines `bot_token` fields and `Load()`/`Save()` persist them, but the web GET/POST handlers deliberately **omit** `bot_token` (good — no leakage) and nothing in the ai-server or firmware reads it. Dead config surface that stores a credential in NVS with no consumer. Either wire it (device → ai-server auth) or remove it. Storing an unused credential is a small risk (NVS is not encrypted by default).

### S3 (LOW) — `cJSON_Parse` on untrusted POST body; no null deref on parse, but no field-type validation
`cJSON_GetObjectItem(...)->valuestring` / `->valueint` are read without `cJSON_IsString`/`cJSON_IsNumber` checks. If a client posts `"host": 123` (number) then `->valuestring` is `NULL` and `config.openclaw.host = NULL` is assigned to a `std::string` → **UB / crash** (assigning `const char* NULL` to `std::string`). Similarly `"host": {}` etc. The GET handler is safe (reads own struct). The POST handler needs `cJSON_IsString`/`cJSON_IsNumber` guards before dereferencing `valuestring`/`valueint`. This is a reachable crash on a LAN endpoint (combines with S1).

### S4 (LOW) — ai-server trusts `Device-Id` header for routing
`server.ts` reads `req.headers['device-id']` and routes purely on that client-supplied string. Any client can impersonate another MAC and get its backend/agent/session. For a LAN toy robot this is acceptable, but since it drives session-key separation (B1), note that a malicious LAN client can hijack a device's session context. Flag for awareness; not blocking.

### S5 (NONE) — patch does NOT disable OTA (see Consistency C1)
The task brief says the patch has "OTA unconditionally disabled (hard return instead of conditional guard)." **It does not.** There is no `return`/skip in `CheckNewVersion`/`CheckVersion` that is unconditional. This is both a plan violation and a security concern: first boot with no local WS URL configured will still phone home for OTA. See C1.

---

## 3. ESP-IDF Compatibility

### E1 (OK) — NVS Settings usage is correct
`Settings(NVS_NAMESPACE, false/true)` read/write pattern matches the official firmware's `settings.h` API. `Load` uses read-only, `Save` read-write. No misuse found. The config struct is cleanly populated with sane defaults and `Print()` correctly guards the backend-name ternary.

### E2 (HIGH) — Missing error handling in `Save()`
`Settings::SetInt/SetString` return values are ignored. If NVS is full or a key write fails, `Save()` silently reports success and the POST handler returns `{"status":"ok"}`. ESP32 NVS write failures are real (namespace full, wear). Should check each `Set*` return and surface an error via the handler.

### E3 (OK) — `esp_http_server` usage is idiomatic
`httpd_start` + `httpd_register_uri_handler` + `httpd_resp_*` are the standard ESP-IDF APIs. The GET handler correctly frees `cJSON_free(json_str)` and `cJSON_Delete(root)`. The POST handler frees `buf` on all paths. No obvious leak in normal flow. (The `cJSON_Parse` null → `valuestring` crash is S3, not a leak.)

### E4 (OK) — CMakeLists component registration
`idf_component_register(SRCS ... INCLUDE_DIRS "." PRIV_REQUIRES nvs_flash esp_http_server json ArduinoJson main)` is valid. **However** `PRIV_REQUIRES ... main` is a circular-ish/odd dependency (a component depending on `main`) and `ArduinoJson` is listed but **never used** in any of the three .cc files (they use `cJSON`, `settings.h`, std::string). Unnecessary `PRIV_REQUIRES` entries can cause build failures if the named components aren't available in a given target. Should drop `ArduinoJson` and reconsider `main`.

### E5 (WARN) — `web_config_start()` is never called anywhere
The function is defined but I found no caller in the reviewed files. If it's not wired into `app_main`/`Application::Initialize`, the web config editor is dead on arrival (no endpoint served). Confirm there's a call site in firmware `main/` not shown in this diff.

### E6 (OK) — strip_emoji is dependency-free and portable
Pure `std::string` + `cstdint`, no ESP-IDF calls — correct for a reusable utility.

---

## 4. TypeScript Correctness

### T1 (OK) — `device_config.ts` is type-safe and well-structured
`Backend`, `DeviceBinding`, `DeviceConfig` interfaces are clean. The `readFileSync` existence-probe + JSON parse with try/catch fallback is reasonable. Uses `process.cwd()`-relative resolution to avoid `import.meta.url` — a sensible choice given the module settings. Good.

### T2 (OK) — `server.ts` async/WS wiring
`setInterval` keepalive with `ws.ping()` guarded by `readyState`; `clearInterval` on close; `device-id` header read is properly typed with a fallback. `binding.backend === 'openclaw' ? OpenClawClient : HermesClient` is a clean ternary. Minor: `host` is computed but only used in a log string (`ws://${host}:${port}`) — the actual `server.listen(port, host)` is correct, so no bug. Fine.

### T3 (WARN) — Session constructor env fallback cast
```ts
const binding = deps.deviceBinding ?? { backend: (process.env.STACKCHAN_BACKEND ?? 'hermes') as 'openclaw' | 'hermes', ... }
```
The cast `as 'openclaw' | 'hermes'` bypasses runtime validation; if `STACKCHAN_BACKEND` is set to an unexpected string, it flows into the ternary as "not 'openclaw'" → silently routes to Hermes. Acceptable as a backward-compat fallback but worth noting. More importantly: **the default `agent_id` fallback is `'rosie'` while the backend default is `'hermes'`** — inconsistent (a Hermes-bound device defaulting to an OpenClaw agent name). Cosmetic-ish but confusing.

### T4 (HIGH — ties to B1) — `OpenClawClient` deviceId not threaded
The `DeviceBinding`/deviceId available in `server.ts` is not propagated into `OpenClawClient` (`deviceId` option exists on the constructor but session.ts omits it). This is the TS-side root cause of B1. Fix in `session.ts`.

### T5 (OK) — no import errors
`server.ts` imports `getDeviceBinding, type DeviceBinding` from `./device_config.js`; `session.ts` imports `type DeviceBinding` — all consistent with the existing `./xxx.js` ESM import style used throughout the codebase. `constructSessionKey`/`reloadConfig` being unused is B2, not an import error.

---

## 5. Build System

### B1-CMAKE (OK) — `firmware/CMakeLists.txt` EXTRA_COMPONENT_DIRS
```cmake
set(EXTRA_COMPONENT_DIRS "${FIRMWARE_EXTRAS_DIR}")
```
Setting `EXTRA_COMPONENT_DIRS` after the `sdkconfig.defaults.local` block but **before** `include($ENV{IDF_PATH}/tools/cmake/project.cmake)` is the correct ordering (must be set before project() is pulled in). Path resolution via `get_filename_component(... ABSOLUTE)` is correct. Guarded with `EXISTS`. Good.

### B2-CMAKE (WARN) — `firmware-extras/CMakeLists.txt` PRIV_REQUIRES `main` and `ArduinoJson`
Dependency on `main` from a separate component is fragile (main is the app component, not a normal library; ordering/visibility can break). `ArduinoJson` is unused. Drop both; keep `nvs_flash`, `esp_http_server`, `json`. If the component needs `settings.h` from main, that's a design smell — better to declare the correct dependency or relocate settings.

### B3-CMAKE (LOW) — sdkconfig.defaults flags
`CONFIG_USE_SERVER_AEC=y`, `CONFIG_USE_AFE_WAKE_WORD=y`, `CONFIG_USE_AUDIO_PROCESSOR=y` match the plan's Phase 2 step 9. `CONFIG_HERMES_AUTOSTART=n` is present. However, the plan's **Blocker 2 fix requires `CONFIG_OTA_URL=""`** — this is **absent** from `sdkconfig.defaults` (no `CONFIG_OTA_URL` line at all). See C1 — the OTA-hardening is missing.

---

## 6. Consistency (vs STEP2-MERGE-PLAN-REVISED.md)

### C1 (CRITICAL) — Plan Blocker 2 (unconditional OTA disable) is NOT implemented
Plan Blocker 2: *"Make OTA skip **unconditional** in our fork: comment out/remove `ota_->CheckVersion()`; set `CONFIG_OTA_URL=""` in sdkconfig.defaults."*

**Actual state:**
- The patch keeps `CheckNewVersion()` (it only early-returns when a local websocket_url is set — the **conditional** guard the plan explicitly rejected for first-boot safety).
- `sdkconfig.defaults` has **no `CONFIG_OTA_URL`** entry.
- `CONFIG_OTA_URL` is not set empty anywhere in the reviewed diff.

So the #1 blocker from the adversarial review is **not fixed**. First boot (no NVS websocket config) → `CheckNewVersion()` runs → device phones home for OTA. This is a correctness + security miss.

### C2 (PARTIAL) — Per-device binding implemented but incomplete (B1/B3)
Plan Phase 4 steps 22–28:
- Step 22 `devices.json` — ✅ present.
- Step 23 read `Device-Id` from handshake — ✅ in server.ts.
- Step 24 route to openclaw.ts/hermes.ts per-device — ✅ partial (works for choosing the client class).
- Step 25 device sends backend+agent in WS hello — ⚠️ **not implemented** (server only reads `Device-Id` header; there's no hello-message binding override).
- Step 26 session key `agent:<agent_id>:stackchan:<device_id>` — ⚠️ format matches in `OpenClawClient`/`constructSessionKey`, but deviceId isn't threaded → effectively broken (B1).
- Step 27 "two simulated devices route correctly" — the test script tests this but only checks connectivity, not actual session/agent separation (B6 false-pass risk).

### C3 (PARTIAL) — Plan Phase 3 config struct
`openclaw_s {host, port, agent_id, bot_token, default_model}` and `backend` selector 0/1 — ✅ matches. Persist to NVS — ✅. Port `/config` GET/POST to `esp_http_server` — ✅ (modulo S3 crash + E5 unregistered). `stripEmoji` — ✅. `bot_token` present but unused (S2). Config struct matches plan.

### C4 (PARTIAL) — Firmware layout matches plan
`firmware-extras/`, `ai-server/devices.json`, `test-harness/test_ws_e2e.py` all present at the planned paths. Plan's file layout lists `web_config_endpoints.cpp` (`.cpp`) but the actual file is `web_config_endpoints.cc` — minor naming drift, not an issue since CMakeLists references `.cc` consistently. `.h`/`.cc` split is fine.

### C5 (OK) — Backend binding off-device (Blocker 3)
Moved to ai-server per-device — ✅ directionally correct. The gap is the incomplete deviceId threading (B1), not the architecture choice.

### C6 (OK) — Dead-code items from plan dropped
`OpenClawClient.cpp` firmware-side is NOT present — ✅ dropped per plan (#6). Mini server/FastAPI abandoned — ✅.

---

## Fix List (ordered)

**Blocking (must fix before merge):**
1. **C1** — Implement plan Blocker 2 for real: comment out `ota_->CheckVersion()`/`CheckNewVersion()` in the patch AND add `CONFIG_OTA_URL=""` to `sdkconfig.defaults`. Do not rely on the conditional local-WS guard.
2. **B1/T4** — Thread `deviceId` into `OpenClawClient` from `server.ts`/`session.ts` so per-device session keys (`agent:rosie:stackchan:<mac>`) actually separate. Wire in `constructSessionKey` as the single source of truth (B2).
3. **S3** — Add `cJSON_IsString`/`cJSON_IsNumber` guards in `config_post_handler` before dereferencing `valuestring`/`valueint` (prevents NULL-assign-to-`std::string` crash).
4. **S1** — Add auth/origin-check (or at minimum clear LAN-only + a token) to the device HTTP `/config` POST endpoint. Document the new attack surface.
5. **B3** — Resolve Hermes `agent_id`: either pass it to HermesClient and implement per-device Hermes routing, or remove the misleading field/document as OpenClaw-only.

**Should fix (high value):**
6. **E2** — Check `Settings::Set*` return values in `Save()`; surface NVS write failures via the POST handler instead of always returning "ok".
7. **B4** — Decide whether `strip_emoji` should strip *only* emoji or all 4-byte supplementary-plane chars; document the behavior. Consider `c >= 0xF0 && c <= 0xF4` is correct range but strips math/CJK-ext too.
8. **E5** — Confirm `web_config_start()` has a real call site in firmware `main/`; if not, wire it in (otherwise the whole web editor feature is inert).
9. **B4-CMAKE / E4** — Remove unused `ArduinoJson` from `PRIV_REQUIRES`; reconsider the `main` dependency.
10. **B5** — Verify port 80 isn't already claimed by the provisioning httpd; use a distinct port or document coexistence.

**Nice to have:**
11. **B6** — Make `test_ws_e2e.py` actually verify STT→LLM→TTS round-trip (send real audio, assert audio/text response), not just connect+hello. Fix the config-endpoint test to target the device's port 80, or drop it.
12. **T3** — Align default backend/agent (`hermes` + `rosie` mismatch); validate `STACKCHAN_BACKEND` at runtime.
13. **S4** — Note the Device-Id spoofing limitation for session hijack awareness (documented, not blocking).
14. **S2** — Wire or remove the unused `bot_token` config fields.

---

*Review written from the actual diff on 2026-08-19. Line references approximate (session.ts ~433, device_config.ts ~56).*
