# Multi-Agent Session Routing — OpenClaw Gateway

Research: how the Gateway routes a new channel/device to a specific agent (rosie) by default, and why `model: openclaw/rosie` works without a session key but not with one.

Sources: `docs/gateway/config-agents.md`, `docs/gateway/openai-http-api.md`, `docs/concepts/multi-agent.md`, `docs/channels/channel-routing.md`, and the compiled Gateway handlers `dist/http-utils-B0BcglUl.js` + `dist/session-key-VWT_xzM9.js`.

---

## 1. How the Gateway routes messages to agents

There are **two distinct routing surfaces**:

**A. Channel routing (Telegram/WhatsApp/Discord, etc.)** — controlled by top-level `bindings`. Each binding maps a channel account (and optionally peer/guild/team) to an `agentId`. Match order (first match wins):

1. exact `peer`
2. `guildId` / `teamId`
3. `accountId` (exact)
4. `accountId: "*"` (channel-wide)
5. default agent

```json5
bindings: [
  { agentId: "rosie", match: { channel: "telegram", accountId: "rosie" } },
]
```

So a new **device/channel** is routed by adding a binding (or making the agent the default). The agent's `agents.list[].id` determines its workspace + session store (`~/.openclaw/agents/<agentId>/sessions`).

**B. OpenAI HTTP endpoint (`/v1/chat/completions`)** — this is the surface a custom device (e.g. the Stack-chan node) uses. Here the agent is selected by the **`model` field**, NOT by session key or binding.

## 2. How session keys are constructed & what determines the agent

Canonical session-key shape: `agent:<agentId>:<mainKey>` (e.g. `agent:rosie:main`, `agent:rosie:telegram:group:...`).

From `dist/http-utils-B0BcglUl.js` (`resolveGatewayRequestContext`):

```js
function resolveAgentIdForRequest(params) {
  // 1. header x-openclaw-agent-id (or x-openclaw-agent)
  // 2. model field: openclaw | openclaw/default | openclaw/<agentId> | openclaw:<agentId> | agent:<agentId>
  // 3. default agent
}
```

Agent selection is **fully independent of the session key**. The session key only picks the conversation bucket *within* the already-selected agent's store. Explicit `x-openclaw-session-key` is returned **verbatim** (after rejecting reserved namespaces `subagent:`, `cron:`, `acp:`). A `stackchan:*` key is NOT reserved, so it is accepted.

Downstream, `toAgentStoreSessionKey` scopes a bare key into the selected agent's namespace (`stackchan:*` → `agent:rosie:stackchan:*`).

## 3. Can you configure session-key-prefix → agent routing?

**No.** There is no session-key-prefix → agent binding mechanism. Bindings route by `channel`/`accountId`/`peer`/`guildId`/`teamId` only — never by session-key prefix. Session keys are opaque bucket identifiers scoped *inside* an agent; they do not select the agent.

## 4. Why `model: openclaw/rosie` works without a session key but not with one

- **Without a session key**: the endpoint auto-generates a key in the correct `agent:rosie:<...>` form via `buildAgentMainSessionKey({ agentId: "rosie", ... })`. Agent = rosie (from model), session = correctly namespaced. ✓
- **With `x-openclaw-session-key: stackchan:*`**: the agent is still rosie (model), but the *raw* session key is returned verbatim. If the downstream store fails to re-scope a bare `stackchan:*` into `agent:rosie:...` (or the caller expects it to carry an `agent:` prefix to be recognized), the conversation is stored under a mismatched bucket — the agent resolves, but the session does not attach to the expected `agent:rosie:...` conversation, so it appears to "not work."

The root cause is that the OpenAI endpoint treats the session key as an opaque override, not as an agent selector. The session key and the agent must agree; the session key alone never selects the agent.

## 5. Config changes to route `x-openclaw-session-key: stackchan:*` to Rosie

Option 1 — **Don't rely on the session key for agent selection.** Always send `model: openclaw/rosie` (or header `x-openclaw-agent-id: rosie`). Then use a session key that is already correctly namespaced for rosie, e.g.:
- `x-openclaw-session-key: agent:rosie:stackchan:<device>` — fully-qualified, unambiguous.
- Or reuse a stable OpenAI `user` string (e.g. `user: "stackchan"`), which the endpoint auto-scopes into `agent:rosie:user:stackchan`. This is the cleanest fix.

No Gateway config change is required — this is purely a request-side convention.

Option 2 — **Make rosie the default agent.** `agents.list[].default: true` (or first list entry). Then `model: openclaw` (or `openclaw/default`) routes to rosie with any session key.

There is **no config key** that maps a `stackchan:*` session-key prefix to an agent — it does not exist in the schema.

## 6. Is a channel plugin needed, or can config alone solve it?

**Config + correct request shape alone can solve it** for the OpenAI HTTP endpoint. No channel plugin is required:

1. Agent selection: send `model: openclaw/rosie` or `x-openclaw-agent-id: rosie`.
2. Session scoping: send `x-openclaw-session-key: agent:rosie:stackchan:<id>` (fully qualified), or send an OpenAI `user` string and let the Gateway build the scoped key.

A **channel plugin is only needed** if the Stack-chan node must integrate as a native messaging network (users/rooms/webhooks/outbound transport) rather than calling the HTTP endpoint — per `docs/gateway/openai-http-api.md` ("Build a channel plugin instead when integrating an external messaging network…"). For a simple device-to-agent bridge over the existing Gateway, config + headers are sufficient.

---

## TL;DR
- Agent selection on the HTTP endpoint = `x-openclaw-agent-id` header → `model` field → default agent. Never the session key.
- Session key = conversation bucket *inside* the selected agent; there is no session-key-prefix → agent routing.
- Fix: send `model: openclaw/rosie` + a fully-qualified `agent:rosie:stackchan:<id>` session key, or use a stable `user` string. No channel plugin required.
