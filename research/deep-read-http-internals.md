# Deep Read: OpenAI HTTP Endpoint Internals

**Date:** 2026-08-18
**Source:** `openclaw` npm package (dist/), version as installed at `~/homebrew/lib/node_modules/openclaw`
**Scope:** Full trace of the `/v1/chat/completions` handler from HTTP request to agent execution, answering 7 specific questions about `x-openclaw-message-channel`, `user`, `x-openclaw-session-key`, channel registration, session lifecycle, bindings, and whether HTTP can masquerade as a Telegram message.

---

## 1. Request Flow Overview

The entry point is `handleOpenAiHttpRequest` in `dist/openai-http-9urlXlOE.js`. The critical routing decision happens in one call:

```js
// dist/openai-http-9urlXlOE.js
({agentId, sessionKey, messageChannel} = resolveGatewayRequestContext({
    req,
    model,
    user,
    sessionPrefix: "openai",
    defaultMessageChannel: "webchat",
    useMessageChannelHeader: true
}));
```

This single call resolves **all three** of the routing inputs (agent, session key, message channel). It lives in `dist/http-utils-B0BcglUl.js`:

```js
function resolveGatewayRequestContext(params) {
    const agentId = resolveAgentIdForRequest({ req: params.req, model: params.model });
    return {
        agentId,
        sessionKey: resolveSessionKey({
            req: params.req, agentId, user: params.user, prefix: params.sessionPrefix
        }),
        messageChannel: params.useMessageChannelHeader
            ? normalizeMessageChannel(getHeader(params.req, "x-openclaw-message-channel")) ?? params.defaultMessageChannel
            : params.defaultMessageChannel
    };
}
```

The resolved values are then packed into an agent command via `buildAgentCommandInput`:

```js
function buildAgentCommandInput(params) {
    return {
        message: params.prompt.message,
        extraSystemPrompt: params.prompt.extraSystemPrompt,
        images: params.prompt.images,
        clientTools: params.clientTools,
        model: params.modelOverride,
        sessionKey: params.sessionKey,
        runId: params.runId,
        deliver: false,                    // <-- KEY: delivery is disabled
        messageChannel: params.messageChannel,
        bestEffortDeliver: false,
        allowModelOverride: params.modelOverride !== void 0,
        abortSignal: params.abortSignal,
        streamParams: params.streamParams
    };
}
```

Note **`deliver: false`** — this is the single most important fact for the "behave like Telegram" question. The HTTP endpoint is a **request/response** surface: it runs the agent turn and returns the text in the HTTP response. It never triggers outbound delivery.

The command is executed via `agentCommandFromIngress` (in `dist/agent-command-ABV9I5el.js`), which is the same codepath as `openclaw agent` CLI runs and channel ingress runs.

---

## 2. What `x-openclaw-message-channel` Actually Does

**Trace:** Header → `resolveGatewayRequestContext` → `normalizeMessageChannel(...)` → `runContext.messageChannel`.

```js
// dist/http-utils-B0BcglUl.js
messageChannel: params.useMessageChannelHeader
    ? normalizeMessageChannel(getHeader(req, "x-openclaw-message-channel")) ?? params.defaultMessageChannel
    : params.defaultMessageChannel
```

`normalizeMessageChannel` (in `dist/message-channel-core-CmpZ4x17.js`):

```js
function normalizeMessageChannel(raw) {
    const normalized = normalizeOptionalLowercaseString(raw);
    if (!normalized) return;
    if (normalized === "webchat") return INTERNAL_MESSAGE_CHANNEL; // "webchat"
    const builtIn = normalizeChatChannelId(normalized);
    if (builtIn) return builtIn;
    return normalizeAnyChannelId(normalized) ?? normalized; // falls through to raw string
}
```

So `x-openclaw-message-channel: stackchan` normalizes to the literal string `"stackchan"` (it is not a built-in channel id and not a registered plugin id, so it passes through unchanged). It is **accepted** as a channel label.

**What it affects (all downstream uses):**

1. **`modelByChannel` resolution** — `dist/agent-command-ABV9I5el.js` line ~1277:
   ```js
   const currentRunModelChannel = [runContext.messageChannel, opts.replyChannel, opts.channel]
       .find((c) => Boolean(c && isDeliverableMessageChannel(c)));
   const channelModelOverride = cfg.channels?.modelByChannel && !hasExplicitRunOverride
       ? resolveChannelModelOverride({ cfg, channel: currentRunModelChannel ?? ... }) : null;
   ```
   So if you configure `channels.modelByChannel.stackchan = "some/model"`, an HTTP request with `x-openclaw-message-channel: stackchan` **would** pick up that model override — **but only if `isDeliverableMessageChannel("stackchan")` is true**, which it is **not** (see below). So in practice this override path is skipped for a non-registered channel.

2. **Delivery planning** — `resolveCurrentRunDeliveryContext` (line ~546) uses `turnSourceChannel: opts.runContext?.messageChannel ?? opts.messageChannel`. **But this whole function short-circuits:**
   ```js
   if (opts.deliver !== true) return;
   ```
   Since HTTP sets `deliver: false`, delivery is never planned. The message channel never reaches an outbound transport.

3. **Diagnostics label** — `ingressDiagnosticChannel(opts)` returns `opts.runContext?.messageChannel ?? opts.messageChannel ?? opts.channel ?? "http"`, used only for the `model.usage` diagnostic event channel tag.

4. **Run context** — `resolveAgentRunContext` (in `dist/run-context-D9olx1SB.js`) copies `messageChannel` into `runContext.messageChannel`, which is what the agent's prompt/policy layer sees as the "channel" for channel-aware prompts.

**Does it affect routing?** No. Agent selection is done by `resolveAgentIdForRequest` (headers/model/default), completely independent of the message channel.

**Does it affect session key construction?** No. The session key is built from `user`/`x-openclaw-session-key` only (see below). The message channel is **not** part of the session key.

**Does it affect agent binding?** No. Bindings are never consulted in the HTTP path (see §6).

**Is it just metadata?** Mostly yes. It is a **synthetic ingress channel label** that flows into `runContext.messageChannel` for channel-aware prompts/policies and diagnostics. It does not create a real channel, does not register anything, and does not enable delivery.

---

## 3. What the `user` Field Does

**Trace:** `payload.user` → `resolveSessionKey` → `buildAgentMainSessionKey`.

```js
// dist/http-utils-B0BcglUl.js
function resolveSessionKey(params) {
    const explicit = getHeader(params.req, "x-openclaw-session-key")?.trim();
    if (explicit) {
        if (isReservedSessionKeyOverride(explicit)) throw new GatewaySessionKeyOverrideError();
        return explicit;
    }
    const user = params.user?.trim();
    const mainKey = user ? `${params.prefix}-user:${user}` : `${params.prefix}:${randomUUID()}`;
    return buildAgentMainSessionKey({ agentId: params.agentId, mainKey });
}
```

With `sessionPrefix: "openai"`:

- **With `user`:** `mainKey = "openai-user:<user>"` → session key = `agent:<agentId>:openai-user:<user>`
- **Without `user`:** `mainKey = "openai:<randomUUID>"` → session key = `agent:<agentId>:openai:<uuid>` (stateless per request)

`buildAgentMainSessionKey` (in `dist/session-key-VWT_xzM9.js`):

```js
function buildAgentMainSessionKey(params) {
    return `agent:${normalizeAgentId(params.agentId)}:${normalizeMainKey(params.mainKey)}`;
}
```

So the format is **`agent:<agentId>:openai-user:<user>`**. The `user` value is used verbatim (after `.trim()`), lowercased only by the session-key normalization layer (`normalizeSessionKeyPreservingOpaquePeerIds` lowercases everything except case-preserving peer channels like signal/matrix). For a plain `user` like `conv:abc123`, the stored key is effectively `agent:agent-a:openai-user:conv:abc123`.

**Does it survive 4am resets?** Yes. This is a **main session key** (not a peer/channel key). It is persisted in the agent's session store under that exact key and is stable across restarts and the dream/reset cycle. Reusing the same `user` value on later calls resumes the same session. The docs explicitly recommend `user: "conv:YOUR_CONVERSATION_ID"` for stable per-conversation sessions.

**Important caveat:** the `user` value is not namespaced by channel. Two different HTTP clients using the same `user` string share one OpenClaw session. The docs warn against account-level identifiers for this reason.

---

## 4. What `x-openclaw-session-key` Does

**Trace:** Header → `resolveSessionKey` → returned verbatim as the session key.

```js
const explicit = getHeader(params.req, "x-openclaw-session-key")?.trim();
if (explicit) {
    if (isReservedSessionKeyOverride(explicit)) throw new GatewaySessionKeyOverrideError();
    return explicit;
}
```

- It **overrides** the `user`-derived key entirely (checked first).
- It is returned **verbatim** (not wrapped in `agent:` unless the caller already provides an `agent:`-prefixed key).
- **Reserved namespaces rejected with `400 invalid_request_error`:** `subagent:`, `cron:`, `acp:` (checked via `isReservedSessionKeyOverride`, which also catches the `agent:<id>:subagent:...` wrapped forms).

**When does it override model/agent selection?** It does **not** override agent selection. Agent selection is done separately by `resolveAgentIdForRequest` (from `x-openclaw-agent-id` header, the `model` field, or the default agent). The session key only determines **which session** the turn runs in. However, if the explicit session key is `agent:<otherAgent>:...` and it conflicts with the resolved agent, `prepareAgentCommandExecution` throws:

```js
if (agentIdOverride && explicitSessionKey && classifySessionKeyShape(explicitSessionKey) === "agent") {
    const sessionAgentId = resolveAgentIdFromSessionKey(explicitSessionKey);
    if (sessionAgentId !== agentIdOverride)
        throw new Error(`Agent id "${agentIdOverrideRaw}" does not match session key agent "${sessionAgentId}".`);
}
```

So the session key's embedded agent must match the resolved agent, or the request fails. The session key does not *select* the agent; it must be *consistent* with it.

---

## 5. Does the HTTP Endpoint Create a Channel in the Registry?

**No.** There is no code path in the HTTP handler that registers a channel. The channel registry (`dist/registry-BUWrOy2m.js`) is populated only by **channel plugin registration** (`listRegisteredChannelPluginIds` reads plugin entries). The HTTP endpoint:

- Never calls any `register*` function.
- Always runs with `deliver: false`, so it never touches the delivery/outbound layer.
- Produces a **synthetic/ephemeral session context** — the `messageChannel` is just a label in `runContext`, and the session key is either a fresh UUID (stateless) or a `user`-derived main key.

The session is a normal persisted agent session (stored under `agent:<agentId>:openai-...`), but it is **not** bound to any channel plugin. There is no "stackchan channel" created; `stackchan` exists only as a string label.

---

## 6. Session Lifecycle for HTTP Sessions

HTTP sessions are **regular persisted agent sessions**, not ephemeral in-memory ones:

- **Persistence:** `resolveSessionKeyForRequest` (in `dist/session-HDnU4RDT.js`) uses the explicit session key as the store key, loads the store via `loadSessionStore`, and the run persists via `persistSessionEntry`. The transcript is written to the agent's session store on disk.
- **Dream/reset at 4am:** The dream/memory cycle enumerates sessions via `listSessionTranscriptCorpusEntriesForAgent` (in `dist/engine-qmd-zad3_Bbe.js`), which reads **all** session entries for an agent from the session store — **it does not filter by channel**. The dreaming phases loop (`dist/dreaming-phases-DCJr5DsV.js` line ~480) iterates every session transcript file for each agent:
  ```js
  for (const agentId of agentIds)
      for (const entry of await listSessionTranscriptCorpusEntriesForAgent(agentId)) { ... }
  ```
  So HTTP sessions (`agent:<agentId>:openai-...`) **are** included in the dream corpus and are treated **identically** to Telegram sessions at the dream level. They are not special-cased.

- **Difference from Telegram:** The only real differences are (a) no outbound delivery (Telegram sessions get replies pushed to the chat; HTTP sessions return text in the HTTP response), and (b) no channel-plugin lifecycle (no pairing, no inbound webhook, no channel-specific config like `dmPolicy`/`allowFrom`). At the session-store and dream level they are the same.

---

## 7. Can HTTP Route to a Specific Agent via Bindings?

**No.** Bindings are resolved in the **channel plugin dispatch path**, not the HTTP path.

`resolveConfiguredBindingRoute` / `resolveRuntimeConversationBindingRoute` (in `dist/binding-routing-CR51Xysx.js`) are called from `resolveTelegramConversationRoute` (in `dist/conversation-route-C2X1h63l.js`) and other channel-plugin route resolvers:

```js
// dist/conversation-route-C2X1h63l.js
function resolveTelegramConversationRoute(params) {
    ...
    const configuredRoute = resolveConfiguredBindingRoute({
        ... , channel: "telegram", ...
    });
    ...
}
```

The HTTP endpoint's `resolveGatewayRequestContext` **never** calls into binding routing. There is no `binding` reference anywhere in `http-utils-B0BcglUl.js` or `openai-http-9urlXlOE.js` (verified by grep — zero matches).

**Bindings only work for real channel plugins.** A binding like `{ agentId: "agent-a", match: { channel: "stackchan" } }` is only consulted when a message arrives through a channel plugin whose route resolver runs binding matching. The HTTP endpoint bypasses that entirely.

To route an HTTP request to a specific agent, you must use one of:
- `model: "openclaw/agent-a"` or `model: "agent:agent-a"`
- `x-openclaw-agent-id: agent-a`
- the configured default agent

---

## 8. Can HTTP with `x-openclaw-message-channel: stackchan` Behave Exactly Like a Telegram Message?

**No — not without a plugin, and not even fully with one via the HTTP endpoint.** Here is the precise gap analysis:

### What the HTTP endpoint CAN do today
- Set `runContext.messageChannel = "stackchan"` (a synthetic label).
- Run the agent turn in a persisted session.
- Pick up channel-aware **prompts/policies** that key off `runContext.messageChannel`.
- Emit `model.usage` diagnostics tagged with channel `stackchan`.

### What it CANNOT do (the Telegram-equivalent behaviors)
1. **Outbound delivery.** Telegram messages get replies pushed back to the chat via the Telegram plugin's outbound transport. HTTP sets `deliver: false`, so there is no outbound delivery at all. The response is only the HTTP body. To "behave like Telegram" you'd need the agent's reply to be sent to a StackChan device — which requires an outbound transport, i.e. a channel plugin.
2. **Binding routing.** Bindings are only consulted in the channel-plugin route resolver. The HTTP path never runs binding matching, so `{ agentId: "agent-a", match: { channel: "stackchan" } }` is ignored for HTTP requests.
3. **`modelByChannel` override.** Even though the message channel label is set, `isDeliverableMessageChannel("stackchan")` is `false` (it's not in `CHANNEL_IDS` or registered plugin ids), so the `modelByChannel` override path is skipped.
4. **Channel-plugin lifecycle.** No pairing, no `dmPolicy`/`allowFrom` access control, no inbound webhook, no channel-specific config, no native approvals, no reactions/buttons.
5. **Session key shape.** A Telegram DM session key looks like `agent:<id>:telegram:<account>:direct:<peer>` (peer-scoped). An HTTP session key is `agent:<id>:openai-user:<user>` (main-scoped). They are different session namespaces, so an HTTP request can never join a Telegram session by session key.

### What it would take to make HTTP behave like a Telegram message
The honest answer: **you cannot do it through the HTTP endpoint alone.** The HTTP endpoint is deliberately a request/response operator surface, not a channel. To get StackChan to behave like a Telegram channel you must build a **channel plugin** (per the docs' own guidance: "Build a channel plugin instead when integrating an external messaging network with its own users, rooms, webhook delivery, or outbound transport"). A plugin would:

- Register a channel id (e.g. `stackchan`) in the channel registry, making it a **deliverable** channel (so `isDeliverableMessageChannel("stackchan")` becomes true, enabling `modelByChannel` and delivery).
- Provide an inbound path (webhook or polling) that calls the channel dispatch path (which runs binding routing, pairing, access control).
- Provide an outbound transport to push replies to the device.
- Build peer-scoped session keys (`agent:<id>:stackchan:...:direct:<peer>`) so sessions are channel-native.

Only then would `x-openclaw-message-channel: stackchan` (or, more accurately, a real inbound StackChan message) behave like a Telegram message. The HTTP endpoint's `x-openclaw-message-channel` header is a **label only** — it cannot conjure a channel plugin's behavior.

---

## 9. Summary Table

| Question | Answer |
|----------|--------|
| `x-openclaw-message-channel` | Synthetic ingress label → `runContext.messageChannel`. Affects channel-aware prompts, diagnostics, and (only if deliverable) `modelByChannel`. Does **not** affect routing, session key, or bindings. |
| `user` field | Derives stable main session key `agent:<agentId>:openai-user:<user>`. Persisted; survives 4am resets. Reuse same `user` to continue a session. |
| `x-openclaw-session-key` | Overrides `user`-derived key, returned verbatim. Rejects `subagent:`/`cron:`/`acp:` namespaces. Does not select agent; must be consistent with resolved agent. |
| Channel registry | HTTP never registers a channel. Always synthetic/ephemeral session context. |
| Session lifecycle | Regular persisted agent session; included in dream corpus; treated same as Telegram at store/dream level. |
| Bindings | Not consulted in HTTP path. Bindings only work for real channel plugins. |
| HTTP as Telegram | Not possible via HTTP endpoint alone. Requires a channel plugin for delivery, bindings, access control, and peer-scoped sessions. |

---

## 10. Key Source Files

| File | Role |
|------|------|
| `dist/openai-http-9urlXlOE.js` | `/v1/chat/completions` handler; calls `resolveGatewayRequestContext`, builds command, runs `agentCommandFromIngress`. |
| `dist/http-utils-B0BcglUl.js` | `resolveGatewayRequestContext`, `resolveSessionKey`, `resolveAgentIdForRequest`. |
| `dist/session-key-VWT_xzM9.js` | `buildAgentMainSessionKey`, `normalizeAgentId`. |
| `dist/session-key-utils-A-JGvyXu.js` | Session key parsing, reserved-namespace detection. |
| `dist/agent-command-ABV9I5el.js` | `agentCommandFromIngress`, `prepareAgentCommandExecution`, delivery short-circuit (`deliver !== true`). |
| `dist/run-context-D9olx1SB.js` | `resolveAgentRunContext` — copies `messageChannel` into run context. |
| `dist/message-channel-core-CmpZ4x17.js` | `normalizeMessageChannel`, `isDeliverableMessageChannel`. |
| `dist/binding-routing-CR51Xysx.js` | Binding resolution — channel-plugin path only. |
| `dist/conversation-route-C2X1h63l.js` | Telegram route resolver that calls binding routing. |
| `dist/engine-qmd-zad3_Bbe.js` | `listSessionTranscriptCorpusEntriesForAgent` — dream corpus enumeration (all sessions, no channel filter). |
| `dist/session-HDnU4RDT.js` | `resolveSessionKeyForRequest` — store key resolution. |
