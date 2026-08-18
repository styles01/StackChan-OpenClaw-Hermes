# zclaw — Technical Analysis for the Stack-chan → Rosie ESP32 Node

**Repo:** `github.com/tnm/zclaw` (local: `/Volumes/1TBSSDClawd/stackchan-node/repos/zclaw`)
**Version analyzed:** 2.13.0 (git `main`, commit `e3ad271`)
**License:** MIT
**Analysis date:** 2026-08-17

---

## 1. What Is This Project?

**zclaw is a text-based AI personal assistant firmware for ESP32 boards, written entirely in C.** It is *not* a voice/audio device — there is **no STT, TTS, wake word, or audio pipeline at all**. It is a chat agent that talks to the outside world over **Telegram** (primary) and **USB serial** (local console / host bridge), and calls cloud LLM APIs directly over HTTPS.

Key identity facts:
- **Language:** C (ESP-IDF component, `main/` component). Host tooling in Python 3.
- **Framework:** ESP-IDF **v5.4** (pinned in `install.sh`: `ESP_IDF_VERSION="v5.4"`), FreeRTOS.
- **Target hardware:** ESP32, ESP32-C3, ESP32-S3, ESP32-C6. Recommended starter: Seeed XIAO ESP32-C3.
- **Firmware budget:** strict all-in cap of **≤ 888 KiB** (app + ESP-IDF runtime + WiFi + TLS + cert bundle). Current default build ≈ 833 KiB.
- **Purpose:** "The smallest possible AI personal assistant for ESP32" — scheduled tasks, GPIO control, persistent memory, and custom tool composition via natural language.
- **Interaction model:** You chat with it via Telegram (or a hosted web relay that bridges over serial). It replies with text and can execute on-device tools (GPIO, I2C, DHT, memory, cron, persona).

**Critical takeaway for our project:** zclaw is a *text/chat* agent, not a voice assistant. It is architecturally the closest existing ESP32 "OpenClaw-style agent" we can study, but it has **no audio, no wake word, no MCP, and no OpenClaw integration**. Its value to us is the **agent loop, tool system, LLM transport, provisioning, and build discipline** — not the I/O model.

---

## 2. Architecture

FreeRTOS task graph with queue handoff (from `docs-site/architecture.html`):

```
app_main
  ├─ memory_init (NVS)
  ├─ http_gate_init (mutex serializing outbound HTTPS)
  ├─ ota_init
  ├─ boot_guard (boot-loop protection / safe mode)
  ├─ llm_init, ratelimit_init, tools_init, channel_init
  ├─ channel_start  → channel_read_task ──┐
  ├─ agent_start    → agent_task          │  input_queue
  ├─ telegram_start → telegram_poll_task ─┤  (channel_msg_t)
  │                 → telegram_send_task   │
  └─ cron_start     → cron_task ───────────┘
```

**Message lifecycle:**
1. Inbound text arrives from **serial** (channel), **Telegram** (long-poll), or **cron** (scheduled action).
2. `agent_task` receives it from `input_queue`, appends to a rolling history buffer (max 12 turns).
3. Agent builds request JSON (Anthropic *or* OpenAI format) and calls `llm_request()`.
4. If the model returns a `tool_use`/`tool_calls`, the firmware executes the tool handler and loops (max 5 rounds).
5. Final assistant text is queued to the channel output queue and optionally Telegram.

**Main components (all in `main/`):**
- `agent.c` — the decision engine / tool loop (the heart).
- `llm.c` — HTTP transport to LLM backends.
- `telegram.c` — Telegram Bot API long-polling client.
- `channel.c` — USB serial / UART local console + host bridge.
- `tools.c` + `tools_*.c` — tool registry and handlers.
- `cron.c` — scheduler (daily / periodic / once).
- `memory.c` — NVS persistent storage wrapper.
- `local_admin.c` — USB serial admin console (safe mode / recovery).
- `ota.c`, `boot_guard.c`, `ratelimit.c`, `http_gate.c`, `security.c` — ops/robustness.

---

## 3. Communication Protocol

**zclaw talks to the outside world over HTTPS (TLS) only — no MQTT, no WebSocket, no custom binary protocol.** Two outbound paths:

### 3a. Telegram Bot API (primary chat channel)
- Base URL: `https://api.telegram.org/bot<TOKEN>/`
- **Polling:** `getUpdates?timeout=<N>&limit=1&offset=<id>` — long-poll, one update at a time.
  - Poll timeout: 30s default; 8s for OpenRouter; 5s on classic ESP32 (heap/TLS overlap mitigation).
- **Sending:** `sendMessage` with JSON body `{chat_id, text}`.
- **Auth:** bot token in NVS; **chat-ID allowlist** (comma-separated) enforced — messages from unauthorized chats are rejected.
- **Robustness:** exponential backoff (5s→5min), stale-update resync, truncation recovery, HTTP gate (mutex) so Telegram polling and LLM HTTPS don't overlap on small targets.

### 3b. USB Serial / UART (local console + host bridge)
- UART0 at **115200 baud** (or USB Serial/JTAG on supported targets).
- Plain newline-delimited text lines. The host `web_relay.py` writes a line, reads echoed line + response lines until idle timeout.
- **LLM bridge protocol** (emulator mode only): lines prefixed `__zclaw_llm_req__:` / `__zclaw_llm_resp__:` — used to route LLM calls to a host-side proxy when the device has no network.

### 3c. LLM API (outbound HTTPS)
- Direct HTTPS POST to the configured backend (see §5). No intermediary.

### 3d. Web relay (host-side, optional)
- `scripts/web_relay.py` is a Python `http.server` that serves a mobile chat UI and forwards messages to the ESP32 over serial. It is a **host process**, not firmware. Supports CORS + optional API key.

**No OpenClaw endpoint, no MCP, no WebSocket server, no inbound HTTP server on the device.** The device is a pure outbound HTTPS client.

---

## 4. Audio Pipeline

**None.** zclaw has **no STT, no TTS, no wake word, no microphone, no speaker, no Opus codec, no ESP-SR, no I2S audio driver.** It is a text-only agent.

This is the single biggest gap versus what we need for a Stack-chan → Rosie voice node. We would have to add the entire audio stack (ESP-SR wake word + STT, TTS, I2S codec) ourselves — zclaw gives us nothing here.

---

## 5. LLM Integration

**zclaw calls cloud LLM APIs directly over HTTPS using the standard REST chat-completions / messages format.** It supports **four backends**, selectable at runtime via NVS:

| Backend | URL | Default model | Auth |
|---|---|---|---|
| **Anthropic** | `https://api.anthropic.com/v1/messages` | `claude-sonnet-4-6` | `x-api-key` + `anthropic-version: 2023-06-01` |
| **OpenAI** | `https://api.openai.com/v1/chat/completions` | `gpt-5.4` | `Authorization: Bearer` |
| **OpenRouter** | `https://openrouter.ai/api/v1/chat/completions` | `openrouter/auto` | Bearer + `HTTP-Referer`/`X-Title` |
| **Ollama** | `http://127.0.0.1:11434/v1/chat/completions` | `qwen3:8b` | optional Bearer (reverse-proxy auth) |

- **Custom endpoint override:** `llm_api_url` NVS key lets you point any backend at a custom URL (e.g. a local Ollama server on your LAN, or a proxy). This is the hook we'd use to point at an OpenClaw/MCP bridge.
- **Request format:** `json_util.c` builds either Anthropic `messages` format or OpenAI `chat/completions` format (with `tools` array, `tool_use`/`tool_calls`/`tool_result` handling). `max_tokens` vs `max_completion_tokens` handled per backend.
- **Tool calling:** full function-calling loop — model requests a tool, firmware executes it, feeds result back, loops up to 5 rounds.
- **Transport:** `esp_http_client` + `esp_crt_bundle_attach` (TLS), 20s timeout, 3 retries with exponential backoff (2s→10s, 45s budget), HTTP gate mutex, extensive NETDIAG logging.
- **Rate limiting:** 100/hour, 1000/day (compile-time in `config.h`).

**No MCP, no OpenClaw-specific protocol.** It's a plain REST LLM client. To integrate with OpenClaw we'd either (a) point the custom URL at an OpenClaw/MCP HTTP bridge, or (b) replace `llm.c`'s request builder with an MCP client.

---

## 6. OpenClaw Integration

**There is none.** zclaw does not connect to OpenClaw, has no MCP client, no MCP server, and no OpenClaw-specific API. It is a standalone agent that calls LLM providers directly.

The closest thing to a "bridge" is the **emulator LLM bridge** (`channel_llm_bridge_exchange` + `scripts/qemu_live_llm_bridge.py`), which routes LLM requests over serial to a host-side proxy. That pattern (device → serial → host proxy → cloud) is directly reusable as a template for a device → OpenClaw bridge, but it is not OpenClaw-aware as-is.

---

## 7. Wake Word Handling

**None.** There is no wake word detection. Input is either a Telegram message (which "wakes" the agent) or a serial line. There is no always-on listening, no keyword spotting, no ESP-SR.

For our Rosie node we'd need to add wake word detection from scratch (ESP-SR `wakenet` or similar).

---

## 8. Hardware Abstraction

**Portable across ESP32 family via ESP-IDF + Kconfig presets.** Tested targets: **ESP32, ESP32-C3, ESP32-S3, ESP32-C6.**

- **Board presets** (sdkconfig files):
  - `sdkconfig.defaults` — default target `esp32c3`, 4MB flash, size-optimized.
  - `sdkconfig.esp32s3-box-3.defaults` — ESP32-S3-BOX-3: restricts GPIO tool access to PMOD pins, factory-reset on GPIO0.
  - `sdkconfig.esp32-t-relay.defaults` — classic ESP32 T-Relay: GPIO allowlist for relays.
  - `sdkconfig.qemu.defaults` — QEMU emulator profile.
- **Abstraction layers:**
  - `gpio_policy.c` — GPIO safety range/allowlist (Kconfig `ZCLAW_GPIO_MIN_PIN/MAX_PIN/ALLOWED_PINS`).
  - `channel.c` — abstracts UART vs USB Serial/JTAG via `SOC_USB_SERIAL_JTAG_SUPPORTED`.
  - `wifi_credentials.c` — NVS vs compile-time fallback.
- **Portability:** high within the ESP32 family. Adding a new board = a new `sdkconfig.<board>.defaults` + GPIO policy. No board-specific BSP beyond ESP-IDF.

---

## 9. Build System

- **ESP-IDF v5.4** (pinned in `install.sh`; `include($ENV{IDF_PATH}/tools/cmake/project.cmake)`).
- **CMake** component build (`main/CMakeLists.txt` with `idf_component_register`).
- **Not** PlatformIO, not Arduino.
- **Partition table:** custom `partitions.csv` — OTA-capable, 4MB flash, two 0x170000 app slots.
- **Size discipline:** `CONFIG_COMPILER_OPTIMIZATION_SIZE=y`, `NEWLIB_NANO_FORMAT`, reduced cert bundle, WPA3/SAE disabled, IPv6 disabled, mbedTLS TLS-client-only. CI enforces firmware size + stack-usage guards.
- **Host tests:** `test/host/` — C unit tests compiled against mocks (FreeRTOS, ESP-IDF headers) run on the host, plus Python API tests (`test/api/`).
- **Tooling:** `install.sh` (bootstrap), `scripts/build.sh`, `flash.sh`, `provision.sh`, `monitor.sh`, `emulate.sh` (QEMU), `test.sh`.

---

## 10. Key Files (Top 5)

1. **`main/agent.c`** — The agent loop: message intake, rolling history, tool-call loop (max 5 rounds), LLM retry/backoff, rate limiting, command handling (`/start`, `/help`, `/gpio`, `/diag`). This is the decision engine we'd adapt.
2. **`main/llm.c`** — HTTP transport to all four LLM backends, TLS, NETDIAG, HTTP gate. The place to swap in an OpenClaw/MCP bridge or custom endpoint.
3. **`main/json_util.c`** — Builds Anthropic-format and OpenAI-format request JSON with full tool-calling support; parses responses (text + tool_use/tool_calls). The protocol layer.
4. **`main/telegram.c`** — Telegram Bot API long-poll client with chat-ID allowlist auth, backoff, stale-update resync. The primary chat channel.
5. **`main/builtin_tools.def`** — The tool registry: every built-in tool (GPIO, I2C, DHT, memory, cron, persona, diagnostics) with name, description, JSON input schema, and handler. Adding a tool = one line here + a handler.

Honorable mentions: `main/config.h` (all tunables), `main/tools.c`/`tools_*.c` (tool handlers), `main/memory.c` (NVS), `main/cron.c` (scheduler), `main/local_admin.c` (serial recovery console), `scripts/web_relay.py` (host chat bridge).

---

## 11. What We Can Steal (for Stack-chan → Rosie node)

zclaw is a **text agent**, so we steal its *agent/ops architecture*, not its I/O. Directly reusable:

### High value — steal as-is / adapt
1. **The tool-calling agent loop** (`agent.c` + `json_util.c`): rolling history, tool registry, multi-round tool execution, retry/backoff, rate limiting. This is the core "agent on ESP32" pattern and is exactly what an OpenClaw node needs. We'd keep the loop and swap the LLM transport for an OpenClaw/MCP bridge.
2. **Tool registry pattern** (`builtin_tools.def` + `tools.c` + `tools_*.c`): declarative tool definitions (name/description/JSON schema/handler) that get injected into the model prompt. Perfect for exposing Stack-chan hardware (servo, LED, mic, speaker) as tools. The "Build Your Own Tool" two-approach model (runtime user tools vs firmware C tools) is a great design.
3. **LLM transport with custom endpoint override** (`llm.c` + `llm_api_url` NVS key): the ability to point at a custom URL is the cleanest hook for routing to an OpenClaw/MCP HTTP bridge or a local Ollama server. We can reuse the whole HTTP/TLS/backoff/NETDIAG stack.
4. **NVS provisioning + credential model** (`memory.c`, `nvs_keys.h`, `scripts/provision.sh`): WiFi/LLM/Telegram creds stored in NVS, provisioned over serial without reflash. Directly applicable to Rosie.
5. **Boot-loop protection + safe mode** (`boot_guard.c`, `local_admin.c`): boot counter, safe mode after N failures, USB serial recovery console (`/gpio`, `/diag`, `/reboot`, `/wifi`, `/factory-reset`). Excellent robustness pattern for a physical device.
6. **HTTP gate mutex** (`http_gate.c`): serializes outbound HTTPS so long-poll and LLM calls don't overlap on small-heap targets. Important for any ESP32 node doing concurrent network I/O.
7. **Scheduler** (`cron.c`): daily/periodic/once tasks with NTP time sync — useful for scheduled Rosie behaviors.
8. **Build/size discipline**: 888 KiB budget, size-optimized sdkconfig, CI size/stack guards, host unit tests with mocks. The whole build+test harness is reusable.
9. **Host bridge pattern** (`channel_llm_bridge_exchange` + `web_relay.py`/`qemu_live_llm_bridge.py`): device → serial → host proxy. This is the template for a device → OpenClaw bridge.

### Low value / must build ourselves
- **Audio pipeline (STT/TTS/wake word):** zclaw has none. We must add ESP-SR wake word + STT, TTS, and I2S codec for Stack-chan's mic/speaker.
- **OpenClaw/MCP integration:** zclaw has none. We must build the MCP client or OpenClaw bridge (reusing the custom-endpoint + host-bridge patterns above).
- **Servo/motor control for Stack-chan:** zclaw has GPIO/I2C tools but no servo driver. We'd add a `servo` tool following the `builtin_tools.def` pattern.

### Bottom line
zclaw is the best available reference for **"how to build a small, robust, tool-calling AI agent that runs on an ESP32 with a strict firmware budget."** We should reuse its agent loop, tool registry, LLM transport (with custom endpoint), NVS provisioning, boot-guard/safe-mode, HTTP gate, scheduler, and build/test discipline — and build the audio + OpenClaw/MCP layers ourselves on top.
