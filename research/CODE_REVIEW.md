# Code Review — OpenClaw Backend Integration (Hermes-StackChan ai-server)

**Commit reviewed:** `git diff HEAD~1` in `Hermes-StackChan/`
**Files:** `ai-server/src/openclaw.ts` (new), `ai-server/src/session.ts` (mod), `ai-server/src/server.ts` (mod), `ai-server/.env.example` (mod), `ai-server/test/openclaw.test.ts` (new)
**Reviewer:** Dex (subagent code review)
**Date:** 2026-08-18

---

## Summary

The integration adds an `OpenClawClient` that routes LLM turns to the OpenClaw Gateway (`/v1/chat/completions` on port 18789), selectable via `STACKCHAN_BACKEND=openclaw`. The endpoint, auth header, session-key header, and SSE delta format all match the verified API reference (`research/API_REFERENCE.md`). The client is well-structured, the SSE parser handles the common edge cases, and the 9 unit tests cover the happy paths and several error paths.

**However, there is one critical regression in `server.ts` that will break existing hardware deployments, and one behavioral divergence in the streaming `complete` event that should be fixed before flashing.**

---

## Critical Issues (must fix before flashing)

### C1. `server.ts` default bind change breaks LAN device connections
**File:** `ai-server/src/server.ts:16,55`
```ts
const host = process.env.STACKCHAN_WS_HOST ?? '127.0.0.1'
...
server.listen(port, host)
```
Previously the server bound to `0.0.0.0` (all interfaces). The new default is `127.0.0.1` (loopback only). The StackChan **ESP32 is a separate device on the LAN** that connects over WiFi to a LAN IP (e.g. `ws://192.168.1.x:8765/ws` — see `firmware/main/hal/utils/sd_config/sd_config.h:44`). With the new default, the device **cannot reach the server** unless the operator explicitly sets `STACKCHAN_WS_HOST=0.0.0.0`.

This is a silent breaking change for every existing deployment that upgrades without reading the new `.env.example` note. The device will fail to connect with no obvious cause.

**Fix:** Keep the default at `0.0.0.0` (preserve prior behavior) and make `127.0.0.1` an opt-in, OR detect the backend and only tighten the bind when `STACKCHAN_BACKEND=openclaw` (where the server and gateway are co-located on the same host). At minimum, default `STACKCHAN_WS_HOST` to `0.0.0.0` and document that `127.0.0.1` is for local-only setups.

### C2. Streaming `complete` event drops the authoritative full text
**File:** `ai-server/src/openclaw.ts:91,111`
```ts
yield { type: 'complete' }   // no text
```
The Hermes client yields `{ type: 'complete', text: <full reply> }` (`hermes.ts:357-360`), and the consumer relies on this to set the authoritative `reply`:
```ts
// session.ts:1042-1044
if (event.type === 'delta') { reply += event.text }
else if (event.type === 'complete' && event.text) { reply = event.text }
```
OpenClaw's `complete` carries **no text**, so `reply` is built purely from accumulated deltas. In normal operation this is fine, but if the gateway truncates, drops, or reorders a delta, there is no recovery path — the final spoken reply will be silently incomplete. The Hermes path self-heals via the authoritative `complete.text`.

**Fix:** Emit the accumulated full text on `complete`:
```ts
let full = ''
...
if (typeof delta === 'string' && delta) { full += delta; yield { type: 'delta', text: delta } }
...
yield { type: 'complete', text: full }
```
This matches Hermes semantics and makes the two backends interchangeable.

---

## Important Issues (should fix)

### I1. `STACKCHAN_DEVICE_ID` is used but undocumented → session-key collision across devices
**File:** `ai-server/src/openclaw.ts:35`; missing from `ai-server/.env.example`
```ts
const deviceId = options?.deviceId ?? process.env.STACKCHAN_DEVICE_ID ?? 'default'
this.sessionKey = `agent:${agentId}:stackchan:${deviceId}`
```
`STACKCHAN_DEVICE_ID` is read in code but **not documented** in `.env.example`. Without it, every device defaults to `deviceId='default'`, so **all StackChan devices share the session key `agent:rosie:stackchan:default`**. The gateway uses the session key for persistent multi-turn context (per `API_REFERENCE.md`), so two devices would bleed conversation context into each other.

**Fix:** Document `STACKCHAN_DEVICE_ID` in `.env.example` and require it to be set per-device (or derive it from a per-device config). Consider failing fast (or warning) if it's still `'default'`.

### I2. API key can leak into error messages/logs
**File:** `ai-server/src/openclaw.ts:57,78`
```ts
throw new Error(`OpenClaw request failed: HTTP ${response.status}: ${text}`)
```
The response body `text` is embedded in the thrown error, which the session layer logs (`session.ts:672-673, 824-825`). If the gateway ever echoes the `Authorization` header or the request in an error body, the key would land in logs. The key itself is never logged directly (good), but the error path is unguarded.

**Fix:** Truncate/sanitize the error body (e.g. cap length, strip anything resembling a bearer token) before including it in the error.

### I3. `interrupt()`/`dispose()` abort the *latest* request only
**File:** `ai-server/src/openclaw.ts:120-127`
```ts
async interrupt(): Promise<void> { this.controller?.abort() }
```
`this.controller` is a single field overwritten by each new `submitPrompt`/`streamPrompt` call. If a second request starts while a first is in flight, the first controller is orphaned (not aborted) and `interrupt()` aborts the wrong request. In the current session flow only one LLM turn runs at a time, so this is low risk today — but it's a latent bug if concurrency is ever introduced.

**Fix:** Track a set of active controllers, or guard against concurrent requests.

---

## Minor Issues (nice to fix)

### M1. Unused import `randomUUID`
**File:** `ai-server/src/openclaw.ts:1`
```ts
import { randomUUID } from 'crypto'
```
Imported but never used. `tsconfig.json` has `strict: true` but no `noUnusedLocals`, so it won't fail the build — but it's dead code. Remove it.

### M2. SSE parser requires `data: ` with a space
**File:** `ai-server/src/openclaw.ts:84`
```ts
if (!line.startsWith('data: ')) continue
```
The parser only accepts `data: ` (with space). Some SSE implementations emit `data:` without a space. The verified gateway uses `data: <json>` (per `API_REFERENCE.md:270`), so this matches today, but it's fragile. Consider accepting `data:` without the space too.

### M3. `complete` emitted even on empty/zero-delta streams
**File:** `ai-server/src/openclaw.ts:111`
If the stream ends with no deltas and no `[DONE]`, the parser still yields `{ type: 'complete' }`. Harmless, but the consumer gets a "complete" with an empty reply. Consider only emitting `complete` if at least one delta was seen, or emitting it with the (empty) text.

### M4. Test `interrupt` uses a dead `abortController` variable
**File:** `ai-server/test/openclaw.test.ts:229-231`
```ts
abortController = (init?.signal as AbortController)?.__controller ?? null
```
`init.signal` is an `AbortSignal`, not an `AbortController`, and `__controller` doesn't exist — so `abortController` is always `null`. The test still passes (it checks the promise rejects with AbortError), but the variable is dead/misleading. Remove it.

### M5. `mockFetch` stream mode leaves `text()`/`json()` referencing undefined fields
**File:** `ai-server/test/openclaw.test.ts:52-54`
In stream mode, `text: () => Promise.resolve(response.body ?? '')` and `json: () => Promise.resolve(response.json ?? {})` reference fields that are undefined in stream tests. Not exercised by current tests, but a latent footgun if a stream test ever calls them.

### M6. No newline at EOF in `openclaw.ts` and `server.ts`
Both files end without a trailing newline (`\ No newline at end of file`). Cosmetic; some tooling/linters flag it.

---

## Test Gaps (what to add)

The 9 tests cover: happy-path submit, 401, 500, no-content, API-error-in-body, stream deltas+complete, interrupt abort, env-var defaults, dispose abort. **Not covered:**

1. **SSE partial-line split across chunks** — the parser's `buffer = lines.pop()` logic is the trickiest part and is untested. Add a test where a JSON line is split across two `ReadableStream` chunks.
2. **SSE malformed JSON line** — the `catch { /* skip */ }` path is untested. Add a test with a garbage `data:` line interleaved with valid ones.
3. **SSE stream ending without `[DONE]`** — the fallback `complete` at line 111 is untested.
4. **SSE `data:` without space** — untested (and currently unsupported, see M2).
5. **`complete` event carrying full text** — once C2 is fixed, assert the `complete.text` equals the concatenated deltas.
6. **Empty delta / empty content** — a `delta.content` of `""` or missing should be skipped (currently handled, untested).
7. **`submitPrompt` with `stream:false` body assertion** — the happy-path test asserts `body.stream === false`; good, but there's no test that `streamPrompt` sends `stream: true`.
8. **Session-key collision** — no test that two devices with the same `deviceId` produce the same key (would catch I1).
9. **`server.ts` bind host** — no test that `STACKCHAN_WS_HOST` is honored and that the default is safe (would catch C1).

---

## Regression Risk Assessment

- **`session.ts` `this.hermes` non-readonly (line 381):** Safe. It is assigned exactly once in the constructor (line 431) and never reassigned. The `readonly` removal is benign.
- **`server.ts` `host` variable (line 16, 55):** **This is the critical regression (C1).** The default bind change from `0.0.0.0` to `127.0.0.1` breaks LAN device connections. Must be addressed before flashing.
- **Imports:** `OpenClawClient` is imported in `session.ts` and used only in the constructor. No circular-import or missing-import issues. `randomUUID` in `openclaw.ts` is unused (M1).
- **TypeScript strict mode:** No strict violations in `openclaw.ts`. The `response.body!` non-null assertion and `as` casts are acceptable. `tsconfig` has no `noUnusedLocals`, so the unused import won't fail the build.

---

## Verdict

**NOT READY TO FLASH.**

The OpenClaw client itself is solid and the API contract is verified correct. But two issues block shipping:

1. **C1 (critical):** The `server.ts` default bind to `127.0.0.1` silently breaks the ESP32's LAN connection. This is a hardware-breaking regression for every existing deployment.
2. **C2 (critical):** The streaming `complete` event drops the authoritative full text, diverging from Hermes semantics and removing the self-healing path on truncated streams.

Also fix **I1** (undocumented `STACKCHAN_DEVICE_ID` → session-key collision across devices) before multi-device deployment, and add the SSE edge-case tests (partial lines, malformed JSON, no-`[DONE]`) before flashing.

Once C1, C2, and I1 are addressed and the SSE edge-case tests are added, this is ready to flash.
