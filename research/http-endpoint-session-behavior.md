# OpenAI HTTP Endpoint — Session & Agent Routing Behavior

**Date:** 2026-08-18 · **Researched by:** Dex (subagent) · **Gateway:** http://127.0.0.1:18789 (auth mode: password)

## TL;DR

The OpenAI HTTP endpoint (`/v1/chat/completions`) routes each request to an agent through a **session key**. The agent binding lives in the *session key*, not just the `model` field. A bare session key like `stackchan:device-002` is a **legacy/unscoped** key that gets scoped to the **default agent** (<your-host>) at run time — silently overriding both `model: openclaw/agent-a` and `x-openclaw-agent-id: agent-a`. This is why the response came from <your-host>.

**Correct fix:** Use an **agent-prefixed session key** (`x-openclaw-session-key: agent:agent-a:stackchan:device-002`), **OR** use the OpenAI `user` field (`user: "stackchan:device-002"`) which the Gateway auto-wraps into an agent-bound key. Both produce a persistent session that stays bound to Agent A. Verified live.

## Source-of-truth code paths

- Request context resolution: `dist/http-utils-B0BcglUl.js`
  - `resolveAgentIdForRequest` — picks agent: `x-openclaw-agent-id` header > `model` alias > default.
  - `resolveSessionKey` — the critical function (see below).
- Session-key scoping: `dist/session-key-VWT_xzM9.js`
  - `buildAgentMainSessionKey` → `agent:<agentId>:<mainKey>`
  - `scopeLegacySessionKeyToAgent` / `classifySessionKeyShape`
  - `resolveAgentIdFromSessionKey` → returns `main` for unscoped keys.
- Run dispatch: `dist/agent-command-ABV9I5el.js`
  - `prepareAgentCommandExecution` → `shouldScopeDefaultAgentKey` logic.
- Handler: `dist/openai-http-9urlXlOE.js`
  - `buildAgentCommandInput` (line 50) — **does NOT pass `agentId` into the run.**

## How each header/field affects routing

| Input | Effect on agent routing |
|---|---|
| `model: openclaw/agent-a` | Resolves agent to `agent-a` via `resolveAgentIdForRequest`. Used to build session key **only when no explicit key is given**; NOT propagated into the run itself. |
| `x-openclaw-agent-id: agent-a` | Highest-priority agent selector for key-building/validation, but the raw session key still wins at run time. |
| `x-openclaw-session-key: stackchan:device-002` | Returned **verbatim** by `resolveSessionKey`. It's a `legacy_or_alias` shape (not `agent:<id>:<rest>`). At run time `shouldScopeDefaultAgentKey=true` (because `agentIdOverride` is undefined), so it's re-scoped to the **default agent (main/<your-host>)** via `scopeLegacySessionKeyToAgent`. ❌ overrides model + agent-id. |
| `x-openclaw-session-key: agent:agent-a:stackchan:device-002` | Already agent-bound → resolves to `agent-a`. ✅ (Reserved `subagent:`/`cron:`/`acp:` namespaces rejected with 400.) |
| `user: "stackchan:device-002"` (OpenAI field) | `resolveSessionKey` builds `agent:agent-a:openai-user:stackchan:device-002` (wraps with the resolved `agentId`). Agent-bound → resolves to `agent-a`. ✅ Also gives a **stable, persistent** session across repeated calls. |
| `x-openclaw-message-channel: ...` | Sets synthetic ingress channel context (default `webchat`) for channel-aware prompts/policies. Does **not** affect agent routing. |

## WHY the session key overrides the model's agent binding

1. `buildAgentCommandInput` (openai-http-9urlXlOE.js:50) passes `sessionKey` into the run but **omits `agentId`**. So the agent resolved from `model`/header is used only to *build* a session key when none is supplied — it is not forwarded to the run.
2. The run (`agentCommandFromIngress` → `prepareAgentCommandExecution`) derives the agent from the **session key**.
3. For a raw legacy key (`stackchan:device-002`), `classifySessionKeyShape` returns `legacy_or_alias` and, since `agentIdOverride` is undefined, `shouldScopeDefaultAgentKey` is `true`. `scopeLegacySessionKeyToAgent` then scopes it to `resolveDefaultAgentId(cfg)` = **main (<your-host>)**.

Net: any bare `x-openclaw-session-key` not in `agent:<id>:...` form silently pins the request to the default agent, regardless of the `model`/`agent-id` fields.

## Does the `user` field create persistent, agent-bound sessions?

**Yes — verified live.** With `model: openclaw/agent-a` + `user: "stackchan:device-persist-test"`:
- Turn 1 set a marker; Turn 2 (same `user`) recalled it → **persistent session**, bound to **Agent A**.
- Why: `user` derives `agent:agent-a:openai-user:<user>` via `buildAgentMainSessionKey`, so the agent is encoded in the key itself and survives even though `agentId` isn't passed to the run.

## Correct header combination for Stack-chan (persistent Agent A session)

**Recommended (preferred):** use the OpenAI `user` field as the per-device conversation key, with the model targeting Agent A:
```json
{
  "model": "openclaw/agent-a",
  "user": "stackchan:device-002",
  "messages": [{ "role": "user", "content": "..." }]
}
```
Reuse the same `user` value on every call for that device to continue the same Agent A session.

**Alternative:** explicit agent-prefixed session key:
```
x-openclaw-session-key: agent:agent-a:stackchan:device-002
```

**Avoid:** bare `x-openclaw-session-key: stackchan:device-002` (routes to default agent / <your-host>) — this was the root cause of the observed misrouting.

## Is the OpenAI HTTP endpoint viable for Stack-chan, or is a channel plugin needed?

**Viable — no channel plugin required.** The endpoint already:
- Routes correctly to Agent A when `model: openclaw/agent-a` is used (with `user` or an agent-prefixed session key).
- Supports stable per-device sessions via the `user` field (agent-bound).
- Supports streaming (SSE), tool calling, and multi-turn follow-ups.

Notes/caveats:
- **Security:** a valid gateway password = full operator access. Keep on loopback/private ingress only (per official docs). Stack-chan connecting over the LAN/VPN needs to treat the token as sensitive.
- The `user` field should be a per-conversation/device identifier (`stackchan:device-002`), not an account-level ID shared across devices, to keep sessions distinct.
- If you later need rich inbound events (rooms, webhooks, outbound push, per-user identity from an external network), that's when a channel plugin is the right call — but for a single OpenAI-compatible client talking to Agent A, the built-in endpoint is sufficient.

## Live test results (all against 127.0.0.1:18789)

| Test | Request | Agent answered |
|---|---|---|
| 1 | `model: openclaw/agent-a`, no key | Agent A ✅ |
| 2 | `model: openclaw/agent-a` + `x-openclaw-session-key: stackchan:device-002` | **<your-host> ❌** |
| 3 | `model: openclaw/agent-a` + `user: stackchan:device-002` | Agent A ✅ |
| 4 | `model: openclaw/agent-a` + `x-openclaw-session-key: agent:agent-a:stackchan:device-002` | Agent A ✅ |
| 5 | `model: openclaw/agent-a` + `x-openclaw-agent-id: agent-a` + `x-openclaw-session-key: stackchan:device-002` | **<your-host> ❌** |
| 6/6b | `model: openclaw/agent-a` + `user: stackchan:device-persist-test` (2 turns) | Agent A ✅ persistent |
| 7/7b | `model: openclaw/agent-a` + `x-openclaw-session-key: agent:agent-a:stackchan:device-persist2` (2 turns) | Agent A ✅ persistent |
