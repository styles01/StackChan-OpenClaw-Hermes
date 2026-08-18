# Firmware v1 Change Proposal

**Date:** 2026-08-18
**Status:** Proposed — not yet applied
**Based on:** CODE_REVIEW_V2.md findings C1–C4 + R1–R2

---

## Overview

Four critical fixes needed before flashing the firmware to a real Stack-chan. Plus two recommended improvements that are cheap to include. The STT and TTS layers are untouched — only `OpenClawClient.cpp`, `WebAPI.cpp`, and `StackchanExConfig.h` need changes.

---

## C1: Add v1 session/channel headers to `http_post_json()`

**File:** `firmware/src/llm/OpenClaw/OpenClawClient.cpp`
**Problem:** `http_post_json()` only sends `Content-Type` + `Authorization`. No session key, no channel header, no Hermes-specific auth. Result: no agent binding, no session continuity, Hermes 401s.

**Fix:** Branch on `backend` and inject the proper headers before `http.POST()`.

```cpp
// In http_post_json(), after the existing Content-Type + Authorization headers:

if (backend == 1) {
  // Hermes backend — use Hermes bot_token, not OpenClaw's api_key
  http.addHeader("Authorization", String("Bearer ") + hermesConfig.bot_token);
  // Session key for Hermes (stable per-device identity)
  http.addHeader("X-Hermes-Session-Key", String("stackchan-") + deviceId);
} else {
  // OpenClaw backend — session key + channel header
  http.addHeader("x-openclaw-session-key",
                 String("agent:") + openclaw_agent_id + ":stackchan:" + deviceId);
  http.addHeader("x-openclaw-message-channel", "stackchan");
}
```

**New fields needed in `OpenClawClient`:**
```cpp
// In OpenClawClient.h — add:
String deviceId;       // unique per-device ID (e.g. MAC address or NVS-stored UUID)
String openclaw_agent_id;  // extracted from config (agent_id field)
```

**In the constructor:** generate or load `deviceId` from NVS (one-time, persists across reboots):
```cpp
// Generate device ID once, store in NVS
uint32_t nvs_handle;
nvs_open("stackchan", NVS_READONLY, &nvs_handle);
size_t len = 64;
char buf[64];
if (nvs_get_str(nvs_handle, "device_id", buf, &len) != ESP_OK) {
  // Generate from WiFi MAC
  uint8_t mac[6];
  WiFi.macAddress(mac);
  snprintf(buf, sizeof(buf), "sc-%02x%02x%02x%02x%02x%02x",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  nvs_close(nvs_handle);
  nvs_open("stackchan", NVS_READWRITE, &nvs_handle);
  nvs_set_str(nvs_handle, "device_id", buf);
}
nvs_close(nvs_handle);
deviceId = String(buf);
```

**Also fix:** The `Authorization` header currently uses `param.api_key` for both backends. For Hermes, it must use `hermesConfig.bot_token`. Move the Authorization header into the backend branch (as shown above) instead of sending it unconditionally.

---

## C2: Fix config YAML round-trip (data loss on POST /config + reboot)

**File:** `firmware/src/WebAPI.cpp` — `handle_config_set()`
**Problem:** Writes only `backend`, `openclaw`, `hermes` to YAML. But `setExtendSettings()` reads `llm`, `tts`, `stt`, `wakeword`, `moduleLLM` too. After a config POST + reboot, `llm.type` defaults to 0 (ChatGPT) instead of 4 (OPENCLAW).

**Fix:** Read the existing config file first, merge the new values, then write the full config back.

```cpp
void handle_config_set() {
  // ... parse incoming JSON as before ...

  ex_config_s cfg = robot->m_config.getExConfig();
  // Update cfg from JSON (as existing code does)...

  // PERSIST: merge with existing config, don't overwrite
  if (SPIFFS.begin(true)) {
    // Read existing config to preserve llm/tts/stt/wakeword/moduleLLM
    File existing = SPIFFS.open("/SC_ExConfig.yaml", "r");
    String yamlContent = "";
    if (existing) {
      yamlContent = existing.readString();
      existing.close();
    }

    // Write merged config
    File f = SPIFFS.open("/SC_ExConfig.yaml", "w");
    if (f) {
      // If we have existing content, preserve the non-OpenClaw/Hermes sections
      // by writing them first, then appending our updated sections.
      // Simplest fix: write the FULL config, not just our sections.

      // LLM
      f.print("llm:\n");
      f.print("  type: "); f.println(cfg.llm.type);
      f.print("  model: \""); f.print(cfg.llm.model); f.println("\"");
      f.print("  enableMemory: "); f.println(cfg.llm.enableMemory ? "true" : "false");

      // TTS
      f.print("tts:\n");
      f.print("  type: "); f.println(cfg.tts.type);
      f.print("  model: \""); f.print(cfg.tts.model); f.println("\"");
      f.print("  voice: \""); f.print(cfg.tts.voice); f.println("\"");

      // STT
      f.print("stt:\n");
      f.print("  type: "); f.println(cfg.stt.type);
      f.print("  model: \""); f.print(cfg.stt.model); f.println("\"");

      // WakeWord
      f.print("wakeword:\n");
      f.print("  type: "); f.println(cfg.wakeword.type);
      f.print("  keyword: \""); f.print(cfg.wakeword.keyword); f.println("\"");

      // ModuleLLM
      f.print("moduleLLM:\n");
      f.print("  rxPin: "); f.println(cfg.moduleLLM.rxPin);
      f.print("  txPin: "); f.println(cfg.moduleLLM.txPin);

      // Backend selector
      f.print("backend: "); f.println(cfg.backend);

      // OpenClaw (don't write bot_token to YAML — keep in NVS/.env)
      f.println("openclaw:");
      f.print("  host: "); f.println(cfg.openclaw.host);
      f.print("  port: "); f.println(cfg.openclaw.port);
      f.print("  model: "); f.println(cfg.openclaw.model);
      f.print("  agent_id: "); f.println(cfg.openclaw.agent_id);
      // bot_token omitted from YAML — stored in NVS only

      // Hermes
      f.println("hermes:");
      f.print("  host: "); f.println(cfg.hermes.host);
      f.print("  port: "); f.println(cfg.hermes.port);
      f.print("  model: "); f.println(cfg.hermes.model);
      f.print("  agent_id: "); f.println(cfg.hermes.agent_id);

      f.close();
      saved = true;
    }
  }
  // ...
}
```

**Note:** `bot_token` should NOT be persisted in plaintext YAML. Move it to NVS storage (like the existing API key handling). The YAML stores host/port/model/agent_id only.

---

## C3: Mask bot_token in GET /config + add simple auth

**File:** `firmware/src/WebAPI.cpp` — `serializeExConfig()` + `init_web_server()`
**Problem:** `GET /config` returns `bot_token` in plaintext over HTTP:80 with no auth.

**Fix (mask token):**
```cpp
static void serializeExConfig(JsonObject root, const ex_config_s& cfg) {
  root["backend"] = cfg.backend;

  JsonObject oc = root.createNestedObject("openclaw");
  oc["host"] = cfg.openclaw.host;
  oc["port"] = cfg.openclaw.port;
  oc["model"] = cfg.openclaw.model;
  oc["agent_id"] = cfg.openclaw.agent_id;
  // Mask the token — show last 4 chars only
  String masked = cfg.openclaw.bot_token.length() > 4
    ? String("***") + cfg.openclaw.bot_token.substring(cfg.openclaw.bot_token.length() - 4)
    : "***";
  oc["bot_token"] = masked;
  oc["default_model"] = cfg.openclaw.default_model;

  // Same for hermes...
}
```

**Fix (simple auth on mutating endpoints):** Add a shared admin token check on POST endpoints:
```cpp
// Simple token check — compare against a value stored in NVS
bool checkAdminAuth() {
  String token = server.header("X-Admin-Token");
  uint32_t nvs_handle;
  nvs_open("auth", NVS_READONLY, &nvs_handle);
  size_t len = 64;
  char stored[64];
  bool ok = (nvs_get_str(nvs_handle, "admin_token", stored, &len) == ESP_OK)
            && token == String(stored);
  nvs_close(nvs_handle);
  return ok;
}

// In handle_config_set:
if (!checkAdminAuth()) {
  server.send(401, "text/plain", "Unauthorized");
  return;
}
```

GET /config (read-only) can stay open on LAN for convenience, but with bot_token masked.

---

## C4: Enlarge DynamicJsonDocument buffers

**File:** `firmware/src/WebAPI.cpp`
**Problem:** `DynamicJsonDocument(1024)` too small for full config with two bot_tokens.

**Fix:** Change both occurrences to 4096:
```cpp
// handle_config_get:
DynamicJsonDocument doc(4096);  // was 1024

// handle_config_set:
DynamicJsonDocument doc(4096);  // was 1024
```

Also check `doc.overflowed()` after deserialize:
```cpp
DeserializationError err = deserializeJson(doc, body);
if (err || doc.overflowed()) {
  server.send(400, "text/plain", String("JSON error: ") + err.c_str());
  return;
}
```

---

## R1: Cap chatHistory length (prevent memory leak)

**File:** `firmware/src/llm/OpenClaw/OpenClawClient.cpp` — `chat()`
**Problem:** `chatHistory` grows unbounded — every turn adds 2 entries, all re-serialized each time.

**Fix:** Cap at last 20 turns (40 entries):
```cpp
// After push_back in chat():
while (chatHistory.get_size() > 40) {
  chatHistory.pop_front();  // drop oldest
}
```

(Requires `ChatHistory` to support `pop_front()` — check if it already does.)

---

## R2: Add mutex around chat/speech (thread safety)

**File:** `firmware/src/Robot.cpp`
**Problem:** HTTP web server thread and main loop can both call `chat()` / `speech()` concurrently.

**Fix:** Add a FreeRTOS mutex:
```cpp
// In Robot.h:
SemaphoreHandle_t chatMutex;

// In Robot constructor:
chatMutex = xSemaphoreCreateMutex();

// In Robot::chat():
void Robot::chat(String text, const char *base64_buf) {
  xSemaphoreTake(chatMutex, portMAX_DELAY);
  llm->chat(text, base64_buf);
  xSemaphoreGive(chatMutex);
}

// In Robot::speech():
void Robot::speech(String text) {
  xSemaphoreTake(chatMutex, portMAX_DELAY);
  // ... existing code ...
  xSemaphoreGive(chatMutex);
}
```

---

## Summary of changes

| Fix | File | Lines changed | Risk |
|-----|------|---------------|------|
| C1: v1 headers | OpenClawClient.cpp | ~30 lines added | Low — additive |
| C1: deviceId | OpenClawClient.h + .cpp | ~20 lines added | Low — NVS read/write |
| C2: YAML round-trip | WebAPI.cpp | ~40 lines rewritten | Medium — config persistence |
| C3: Mask token + auth | WebAPI.cpp | ~30 lines added | Low — security improvement |
| C4: Buffer size | WebAPI.cpp | 2 lines changed | Trivial |
| R1: History cap | OpenClawClient.cpp | ~3 lines added | Low — depends on ChatHistory API |
| R2: Mutex | Robot.cpp + .h | ~10 lines added | Low — standard FreeRTOS pattern |

**Total:** ~135 lines of changes across 4 files. No STT or TTS changes needed.

---

## What NOT to change

- **STT layer** — `Whisper.cpp`, `CloudSpeechClient.cpp`, `ModuleLLM*.cpp` — untouched
- **TTS layer** — `ElevenLabsTTS.cpp`, `OpenAITTS.cpp`, `WebVoiceVoxTTS.cpp` — untouched
- **Avatar/servo** — face animation and motor control — untouched
- **Wake word detection** — untouched
- **Main loop** — `main.cpp` — untouched

The STT → LLM → TTS pipeline stays exactly as-is. We're only fixing the LLM client's HTTP headers and the web config endpoints.

---

## Next steps

1. Apply C1–C4 (critical) to the firmware source
2. Apply R1–R2 (recommended) while we're in there
3. Build the firmware (PlatformIO)
4. Flash to a Stack-chan device
5. Open `test-harness/web-config.html` in a browser, connect to the device, configure it
6. Run the test harness against the live device
7. Test STT → Rosie → TTS end-to-end on hardware