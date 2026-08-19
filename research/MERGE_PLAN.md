# Merge Plan: Porting OpenClaw into Hermes-StackChan

**Date:** 2026-08-18
**Status:** DRAFT — pending adversarial review + James signoff
**Author:** Rosie (synthesized from dex, ernest, gordon subagent analyses)

---

## 0. Executive Summary

**Goal:** Make Hermes-StackChan support BOTH OpenClaw and Hermes as backend options, with per-robot profile binding. Each robot binds to a specific backend + agent via SD card config.

**Key finding from all three subagents:** The firmware needs **zero or minimal changes**. The entire port happens in the **ai-server TypeScript bridge** — adding an `OpenClawClient` alongside the existing `HermesClient`, both implementing the same `HermesSessionClient` interface. The 13 robot MCP tools work unchanged for both backends.

**Why not port the plaipin C++?** It's Arduino/PlatformIO (broken on CoreS3). Hermes-StackChan is ESP-IDF with WebSocket/Opus voice streaming. Architecturally incompatible. The correct seam is the ai-server bridge, not the firmware.

---

## 1. Architecture (Dual Backend)

```
                    ┌─────────────────────────────────┐
                    │       ESP32 Stack-chan          │
                    │   (firmware — UNCHANGED)        │
                    │   WebSocket → ai-server:8765     │
                    └──────────┬──────────────────────┘
                               │ ws://host:8765/ws
                               ▼
                    ┌─────────────────────────────────┐
                    │      ai-server (TypeScript)     │
                    │                                 │
                    │   Session.ts reads `backend`    │
                    │   from device hello/config      │
                    │                                 │
                    │   ┌─────────────┐  ┌──────────┐ │
                    │   │ HermesClient│  │OpenClaw  │ │
                    │   │ (existing)  │  │Client   │ │
                    │   │ → Hermes:9119│  │→ OC:18789│ │
                    │   └─────────────┘  └──────────┘ │
                    │                                 │
                    │   STT/TTS: Hermes Python tools   │
                    │   (shared by both backends)      │
                    └─────────────────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    ▼                     ▼
           ┌─────────────┐      ┌─────────────┐
           │ HermesAgent │      │  OpenClaw   │
           │ (Venus:8643)│      │  Gateway    │
           │             │      │  (Rosie:    │
           │ STT/LLM/TTS │      │  18789)     │
           │ MCP tools   │      │  Workspace  │
           └─────────────┘      │  File I/O   │
                                │  Memory     │
                                └─────────────┘
```

**Key insight:** Both backends share the same STT/TTS pipeline (Hermes Python tools). Only the LLM turn differs — HermesClient.submitPrompt vs OpenClawClient.submitPrompt.

---

## 2. What We're Building

### 2.1 New File: `ai-server/src/openclaw.ts`

An `OpenClawClient` class implementing the `HermesSessionClient` interface:

```typescript
interface HermesSessionClient {
    submitPrompt(prompt: string): Promise<string>
    streamPrompt?(prompt: string): AsyncIterable<{type:'delta'|'complete', text?:string}>
    interrupt(): Promise<void>
    dispose(): Promise<void>
}
```

**Implementation:**
- `submitPrompt(prompt)` → HTTP POST to `http://<OPENCLAW_HOST>:<OPENCLAW_PORT>/v1/chat/completions`
- Headers:
  - `Authorization: Bearer <OPENCLAW_API_KEY>`
  - `Content-Type: application/json`
  - `x-openclaw-session-key: agent:<OPENCLAW_AGENT_ID>:stackchan:<device_id>`
  - `x-openclaw-message-channel: stackchan`
- Body: `{ "model": "openclaw/<OPENCLAW_AGENT_ID>", "stream": false, "messages": [{"role":"user","content":prompt}] }`
- Parse: check `error`, extract `choices[0].message.content`
- Strip emoji/markdown/newlines (reuse existing `stripMediaForSpeech` / `limitStackChanSpeechText`)
- `interrupt()` → no-op (HTTP request-response, can't cancel mid-flight) or `AbortController`
- `dispose()` → cleanup any state

**Optional streaming (v2):**
- `streamPrompt(prompt)` → `"stream": true`, parse SSE (`data: {delta:{content}}` chunks, `data: [DONE]` terminator)
- Feed into existing streaming TTS path in `session.ts`

### 2.2 Modify: `ai-server/src/session.ts`

- Constructor reads `backend` from device `hello` message OR `STACKCHAN_BACKEND` env
- If `backend === 'openclaw'`: construct `OpenClawClient` instead of `HermesClient`
- `process()` and `processFollowup()` route to the selected client
- `getBridgeStatus()` reports which backend is active
- STT/TTS pipeline stays unchanged (both backends use Hermes Python STT/TTS helpers)

### 2.3 Modify: `ai-server/src/index.ts`

- Wire backend selection at startup
- Read `OPENCLAW_*` env vars
- Optional OpenClaw warmup (skip — OpenClaw doesn't need warming like Hermes)

### 2.4 Modify: `ai-server/.env.example`

Add:
```env
# Backend selection (openclaw | hermes)
STACKCHAN_BACKEND=hermes

# OpenClaw backend (used when STACKCHAN_BACKEND=openclaw)
OPENCLAW_HOST=127.0.0.1
OPENCLAW_PORT=18789
OPENCLAW_AGENT_ID=rosie
OPENCLAW_MODEL=openclaw/rosie
OPENCLAW_API_KEY=  # Gateway password
```

### 2.5 Firmware Changes (MINIMAL)

**`firmware/sdcard/config.sample.json`** — add optional `backend` field:
```json
{
  "wifi_networks": [...],
  "websocket_url": "ws://192.168.1.100:8765/ws",
  "websocket_version": 3,
  "backend": "openclaw",
  "timezone": "MST7"
}
```

**`hal/utils/sd_config/sd_config.cpp`** — parse `backend` field from SD config, store in NVS.

**`hal_bridge` hello message** — include `backend` in the WebSocket `hello` JSON so ai-server knows which backend to use for this device.

**`apps/app_ai_agent/app_ai_agent.cpp`** — backend-aware error messages ("OPENCLAW endpoint error" vs "HERMES endpoint error").

**No changes to:** xiaozhi-esp32 protocol, audio pipeline, MCP server, display/avatar, or the core hal_bridge logic.

### 2.6 MCP Tools (NO CHANGES)

The 13 `stackchan_*` MCP tools work unchanged for both backends:
- `stackchan_mcp_server.ts` talks to `device_control.ts` (port 8766) → WebSocket → firmware
- The MCP server is backend-agnostic — it's a bridge between the AI agent and the robot hardware
- OpenClaw agents can use the same MCP tools by registering `stackchan_mcp_server.ts` as an MCP server in OpenClaw config

**Future enhancement:** Add `stackchan_ask_openclaw_subagent` tool mirroring `stackchan_ask_hermes_subagent` (spawns OpenClaw subagent, delivers result via `/internal/followup`).

### 2.7 Profile Binding

Each robot has a profile defined in SD `config.json`:

| Robot | `backend` | `agent_id` (config) | ai-server routes to | Session Key |
|-------|-----------|---------------------|---------------------|-------------|
| A | `openclaw` | `rosie` | OpenClaw:18789 | `agent:rosie:stackchan:robot-a` |
| B | `hermes` | `venus` | Hermes:8643 | `venus-stackchan-robot-b` |
| C | `openclaw` | `dex` | OpenClaw:18789 | `agent:dex:stackchan:robot-c` |

- `backend` + `agent_id` stored in SD config, sent to ai-server in `hello` message
- ai-server constructs the right client + session key for that robot
- No reflash needed to rebind — just edit SD config (or future web/BLE config)

---

## 3. Build Checklist

### ai-server (TypeScript) — PRIMARY WORK
- [ ] Create `ai-server/src/openclaw.ts` — `OpenClawClient` implementing `HermesSessionClient`
- [ ] Modify `ai-server/src/session.ts` — backend selection in constructor + `process()`
- [ ] Modify `ai-server/src/index.ts` — wire `OpenClawClient` selection + env loading
- [ ] Update `ai-server/.env.example` — add `STACKCHAN_BACKEND` + `OPENCLAW_*` vars
- [ ] Build + compile: `cd ai-server && npm run build`
- [ ] Test: OpenClaw backend routes to correct agent, session persists, auth rejection works
- [ ] Test: Hermes backend still works (regression)
- [ ] (Optional) SSE streaming on OpenClaw client

### Firmware (ESP-IDF) — MINIMAL
- [ ] `firmware/sdcard/config.sample.json` — add `backend` field
- [ ] `hal/utils/sd_config/sd_config.cpp` — parse `backend` into NVS
- [ ] `hal_bridge` — include `backend` in hello message to ai-server
- [ ] `apps/app_ai_agent/app_ai_agent.cpp` — backend-aware error bubbles
- [ ] Build: `idf.py build` (verify no breakage)
- [ ] (Do NOT flash yet — wait for James signoff)

### Config / Docs
- [ ] Port `web-config.html` — add `backend` selector + agent_id fields for Hermes-StackChan SD config
- [ ] Update `README.md` — add ai-server backend selection docs
- [ ] Create `CHANGELOG.md` — entry for this iteration
- [ ] Create `docs/adr/001-dual-backend-ai-server.md` — architecture decision record
- [ ] Update `TODO.md` — mark completed, add new items

### Testing
- [ ] Port `test_agent_binding.py` header builders as TS test against ai-server
- [ ] Verify: OpenClaw backend → correct agent (rosie says "rosie")
- [ ] Verify: Hermes backend → correct agent (venus says "venus")
- [ ] Verify: Profile binding (robot A → Rosie, robot B → Venus) on same ai-server
- [ ] Verify: Auth rejection (401 on missing/invalid key) for both backends

---

## 4. Key Risks & Decisions

### Risk 1: OpenClaw HTTP latency vs Hermes streaming
- **Issue:** OpenClaw HTTP is request-response (~2-5s latency). Hermes uses streaming JSON-RPC with delta updates. The voice loop may feel slower with OpenClaw.
- **Mitigation:** Use SSE streaming (`"stream": true`) for the OpenClaw LLM turn. The TTS pipeline already buffers sentence-by-sentence.
- **Acceptance:** For v1, non-streaming is acceptable. The device speaks in sentences, not tokens.

### Risk 2: STT/TTS dependency on Hermes Python tools
- **Issue:** ai-server uses Hermes Python STT/TTS helpers. If Hermes isn't running, the voice loop breaks even for OpenClaw backend.
- **Mitigation:** Document that Hermes Python tools must be installed (they're standalone, don't require HermesAgent running). Or add OpenClaw-native STT/TTS later.
- **Acceptance:** For v1, keep Hermes STT/TTS. They work independently of HermesAgent.

### Risk 3: API key in ai-server `.env` (not per-device)
- **Issue:** `OPENCLAW_API_KEY` is a single gateway password in `.env`. All robots using OpenClaw backend share it.
- **Mitigation:** This is fine — the gateway password authenticates the ai-server to OpenClaw. Per-agent routing happens via `model: openclaw/<agent_id>`. Per-device identity happens via session keys.
- **Acceptance:** OK. Different robots can use different agents on the same gateway.

### Risk 4: No `interrupt` on OpenClaw HTTP
- **Issue:** `HermesClient.interrupt()` sends `session.interrupt` JSON-RPC. OpenClaw HTTP can't cancel a mid-flight request easily.
- **Mitigation:** Use `AbortController` to abort the fetch. The device will get an error response and return to idle.
- **Acceptance:** OK for v1. Barge-in still works at the device level (stops listening, sends abort).

### Risk 5: The `hello` message protocol extension
- **Issue:** Adding `backend` to the WebSocket `hello` message requires firmware changes. If we don't change firmware, ai-server must rely on env-only backend selection (global, not per-device).
- **Mitigation:** For v1, use `STACKCHAN_BACKEND` env (global). For v2, add `backend` to hello message (per-device). Profile binding across multiple robots on one ai-server requires v2.
- **Acceptance:** v1 = global backend selection (one ai-server = one backend). v2 = per-device backend (profile binding).

---

## 5. Implementation Order (v1 → v2)

### v1 (Ship Now — Global Backend)
1. Create `OpenClawClient` in ai-server
2. Backend selection via `STACKCHAN_BACKEND` env
3. Keep Hermes STT/TTS pipeline
4. Test with one robot → Rosie/OpenClaw
5. Test regression → Venus/Hermes
6. No firmware changes needed

### v2 (Per-Device Profile Binding)
1. Add `backend` to SD config → NVS → hello message
2. ai-server routes per-device
3. Web config editor for profile binding
4. Multiple robots on one ai-server
5. Optional: OpenClaw-native STT/TTS
6. Optional: `stackchan_ask_openclaw_subagent` tool

---

## 6. Evidence (Subagent Analysis Docs)

- `research/hermes-stackchan-analysis.md` (dex, 621 lines) — firmware HAL, ai-server bridge, MCP tools, config, integration points
- `research/xiaozhi-esp32-analysis.md` (ernest, 392 lines) — WebSocket protocol, audio pipeline, Protocol interface, OpenClaw integration strategies
- `research/existing-work-analysis.md` (gordon, 457 lines) — plaipin work review, config mapping, port checklist, header conventions

---

## 7. What NOT to Do

- **Do NOT port plaipin C++ to ESP-IDF** — architecturally incompatible (Arduino vs ESP-IDF, HTTP vs WebSocket/Opus)
- **Do NOT change the xiaozhi-esp32 protocol layer** — the Protocol interface is clean but adding a third implementation is high-risk for v1
- **Do NOT change the audio pipeline** — Opus encode/decode works, STT/TTS works, don't touch it
- **Do NOT put API keys on the SD card** — keep them in ai-server `.env` (server-side only)
- **Do NOT flash firmware until James signs off** — build and test in harness first

---

*This plan is a DRAFT. It will be reviewed by an adversarial subagent (Step 3), revised (Step 4), and presented to James for signoff (Step 5) before any building begins.*