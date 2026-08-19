# Merge Plan v2: Porting OpenClaw into Hermes-StackChan

**Date:** 2026-08-18 (revised 23:30 MDT)
**Status:** REVISED — addressing adversarial review (C1-C4, I1-I6)
**Author:** Rosie

---

## 0. Goal

**Working v1:** OpenClaw as a backend option for a single Stack-chan robot, firmware-push-ready, passing all existing unit tests + firmware CMake/CTest harness tests.

**Not in v1:** Per-device profile binding, multi-robot fleet, firmware hello extension. Those are v2.

---

## 1. Architecture (v1 — Single Robot, Global Backend)

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
                    │   Backend selected by env:       │
                    │   STACKCHAN_BACKEND=openclaw     │
                    │                                 │
                    │   ┌─────────────┐  ┌──────────┐ │
                    │   │ HermesClient│  │OpenClaw  │ │
                    │   │ (existing)  │  │Client   │ │
                    │   │ → Hermes    │  │→ OC:18789│ │
                    │   └─────────────┘  └──────────┘ │
                    │                                 │
                    │   STT: HTTP endpoint or Python  │
                    │   TTS: HTTP endpoint or Python  │
                    └─────────────────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    ▼                     ▼
           ┌─────────────┐      ┌─────────────┐
           │ HermesAgent │      │  OpenClaw   │
           │ (optional   │      │  Gateway    │
           │  for STT/   │      │  (18789)    │
           │  TTS only)  │      │  Rosie      │
           └─────────────┘      └─────────────┘
```

---

## 2. Addressing Critical Issues from Adversarial Review

### C1 Fix: Lazy client construction

**Problem:** `Session` constructor sets `this.hermes` as `readonly` before hello arrives.
**Fix:** Make `this.hermes` non-readonly. Construct it lazily on first use (first `process()` call). Read `STACKCHAN_BACKEND` env at construction time. No hello message parsing needed for v1 (global backend via env).

```typescript
// session.ts change:
private hermes: HermesSessionClient  // remove 'readonly'

private ensureClient(): HermesSessionClient {
    if (this.hermesClient) return this.hermesClient
    const backend = process.env.STACKCHAN_BACKEND ?? 'hermes'
    this.hermesClient = backend === 'openclaw'
        ? new OpenClawClient()
        : new HermesClient()
    return this.hermesClient
}
```

This is a minimal change — 3 lines. The existing tests inject `hermes` via deps, so they bypass this entirely (no regression).

### C2 Fix: Out of scope for v1

**Problem:** `device_control.ts` has a single global `activeSession`. Multi-robot MCP calls misroute.
**Fix:** v1 is single-robot only. Document this limitation. v2 will add per-device addressing. No code change needed for v1.

### C4 Fix: STT/TTS via HTTP endpoints

**Problem:** Python STT/TTS imports from hermes-agent which isn't checked out.
**Fix:** Document that v1 requires either:
  - `HERMES_STT_URL` + `STACKCHAN_LOCAL_TTS_URL` (HTTP endpoints), OR
  - A hermes-agent checkout with Python deps

The code already supports both paths (hermes_audio.ts:127-197). For v1 testing, we use the `hermes` dep injection in tests (MockWebSocket pattern), so STT/TTS providers aren't needed for unit tests.

### I3 Fix: Bind WebSocket to localhost

**Problem:** WS server binds 0.0.0.0 with no auth.
**Fix:** Make the bind address configurable via `STACKCHAN_WS_HOST` env (default `127.0.0.1`). This is a one-line change in server.ts:

```typescript
const host = process.env.STACKCHAN_WS_HOST ?? '127.0.0.1'
server.listen(port, host)
```

Users who need LAN access can set `STACKCHAN_WS_HOST=0.0.0.0` explicitly.

### I1 Fix: AbortController for OpenClawClient.interrupt()

**Problem:** Barge-in abort semantics undefined for HTTP client.
**Fix:** `OpenClawClient.interrupt()` calls `AbortController.abort()`. The streaming generator catches `AbortError` and treats it as normal completion (not error). The `for await` loop in `speakHermesReplyStreaming` already checks `if (this.state !== 'processing') break` per event, so aborted generators exit cleanly.

---

## 3. What We're Building

### 3.1 New File: `ai-server/src/openclaw.ts`

```typescript
import { randomUUID } from 'crypto'

export class OpenClawClient implements HermesSessionClient {
    private controller: AbortController | null = null
    private readonly baseUrl: string
    private readonly apiKey: string
    private readonly model: string
    private readonly sessionKey: string

    constructor() {
        const host = process.env.OPENCLAW_HOST ?? '127.0.0.1'
        const port = process.env.OPENCLAW_PORT ?? '18789'
        this.baseUrl = `http://${host}:${port}`
        this.apiKey = process.env.OPENCLAW_API_KEY ?? ''
        this.model = process.env.OPENCLAW_MODEL ?? 'openclaw/rosie'
        const agentId = process.env.OPENCLAW_AGENT_ID ?? 'rosie'
        const deviceId = process.env.STACKCHAN_DEVICE_ID ?? 'default'
        this.sessionKey = `agent:${agentId}:stackchan:${deviceId}`
    }

    async submitPrompt(prompt: string): Promise<string> {
        this.controller = new AbortController()
        const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
                'x-openclaw-session-key': this.sessionKey,
            },
            body: JSON.stringify({
                model: this.model,
                stream: false,
                messages: [{ role: 'user', content: prompt }],
            }),
            signal: this.controller.signal,
        })
        if (!response.ok) {
            const text = await response.text()
            throw new Error(`OpenClaw request failed: HTTP ${response.status}: ${text}`)
        }
        const data = await response.json()
        const content = data?.choices?.[0]?.message?.content
        if (typeof content !== 'string') throw new Error('OpenClaw returned no content')
        return content
    }

    async *streamPrompt(prompt: string): AsyncGenerator<HermesPromptStreamEvent> {
        this.controller = new AbortController()
        const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
                'x-openclaw-session-key': this.sessionKey,
            },
            body: JSON.stringify({
                model: this.model,
                stream: true,
                messages: [{ role: 'user', content: prompt }],
            }),
            signal: this.controller.signal,
        })
        if (!response.ok) {
            const text = await response.text()
            throw new Error(`OpenClaw request failed: HTTP ${response.status}: ${text}`)
        }
        // Parse SSE stream
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split('\n')
                buffer = lines.pop() ?? ''
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue
                    const data = line.slice(6).trim()
                    if (data === '[DONE]') {
                        yield { type: 'complete' }
                        return
                    }
                    try {
                        const json = JSON.parse(data)
                        const delta = json?.choices?.[0]?.delta?.content
                        if (typeof delta === 'string' && delta) {
                            yield { type: 'delta', text: delta }
                        }
                    } catch { /* skip malformed */ }
                }
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') return
            throw error
        }
    }

    async interrupt(): Promise<void> {
        this.controller?.abort()
    }

    async dispose(): Promise<void> {
        this.controller?.abort()
    }
}
```

### 3.2 Modify: `ai-server/src/session.ts`

Minimal changes:
1. Make `this.hermes` non-readonly (already not explicitly readonly in the type — it's `private readonly hermes: HermesSessionClient`)
2. Add lazy construction via `ensureClient()`
3. Replace `this.hermes` references in `process()` and `processFollowup()` with `this.ensureClient()`
4. Export `HermesSessionClient` type (already exported)

**Actually, looking at the code more carefully:** The constructor takes `deps.hermes ?? new HermesClient()`. Tests inject a mock. For v1, we can keep this pattern — just change the default construction:

```typescript
// In constructor:
const backend = process.env.STACKCHAN_BACKEND ?? 'hermes'
this.hermes = deps.hermes ?? (backend === 'openclaw' ? new OpenClawClient() : new HermesClient())
```

This is even simpler — one line change, no lazy construction needed for v1. The backend is selected at startup via env, which is the v1 design.

### 3.3 Modify: `ai-server/src/server.ts`

One line change — configurable bind host:

```typescript
const host = process.env.STACKCAN_WS_HOST ?? '127.0.0.1'
// was: server.listen(port, '0.0.0.0')
server.listen(port, host)
```

### 3.4 Modify: `ai-server/.env.example`

Add:
```env
# Backend selection (openclaw | hermes)
STACKCHAN_BACKEND=hermes

# OpenClaw backend (used when STACKCHAN_BACKEND=openclaw)
OPENCLAW_HOST=127.0.0.1
OPENCLAW_PORT=18789
OPENCLAW_AGENT_ID=rosie
OPENCLAW_MODEL=openclaw/rosie
OPENCLAW_API_KEY=

# WebSocket bind host (default 127.0.0.1 for security; set to 0.0.0.0 for LAN)
STACKCHAN_WS_HOST=127.0.0.1
```

### 3.5 Firmware Changes: NONE for v1

v1 uses env-only backend selection. No firmware changes needed. The existing firmware connects to ai-server via WebSocket — it doesn't care which backend ai-server uses.

---

## 4. Build Checklist

### ai-server (TypeScript)
- [ ] Create `ai-server/src/openclaw.ts` — `OpenClawClient` class
- [ ] Modify `ai-server/src/session.ts` — backend selection in constructor (1 line)
- [ ] Modify `ai-server/src/server.ts` — configurable WS host (1 line)
- [ ] Import `OpenClawClient` in session.ts
- [ ] Update `ai-server/.env.example`
- [ ] Build: `cd ai-server && npm run build`
- [ ] Run existing tests: `npm test` (8 test files, must all pass)

### New Tests
- [ ] Create `ai-server/test/openclaw.test.ts` — unit tests for OpenClawClient
  - Mock fetch, verify request format (URL, headers, body)
  - Verify submitPrompt returns content
  - Verify streamPrompt yields deltas + complete
  - Verify interrupt() aborts
  - Verify error handling (401, 500, network error)
  - Verify session key header format

### Firmware
- [ ] Run existing CMake/CTest: `cmake -S firmware/tests -B build-firmware-tests && cmake --build build-firmware-tests && ctest --test-dir build-firmware-tests --output-on-failure`
- [ ] Run `idf.py build` to verify firmware still compiles (no changes, should pass)

### Regression
- [ ] All 8 existing test files pass
- [ ] Firmware motion_math_test passes
- [ ] Firmware builds with `idf.py build`

---

## 5. What NOT to Do (v1)

- No firmware changes
- No hello message protocol extension
- No per-device profile binding
- No multi-robot control plane changes
- No MCP tool changes
- No flashing (until James says go)

---

## 6. v2 Roadmap (after v1 ships)

1. Per-device backend selection (hello message extension + lazy client construction)
2. Per-device MCP addressing (replace global `activeSession` with device-keyed map)
3. SD card config for backend + agent_id
4. Web config editor for profile binding
5. Optional OpenClaw-native STT/TTS

---

*This plan is READY TO BUILD. Adversarial review issues C1/C2/C4/I3/I1 addressed. Proceeding to implementation.*