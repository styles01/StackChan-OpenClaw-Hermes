# Deep Read: OpenClaw Channel Plugin SDK & Telegram Source

**Author:** Dex (subagent deep-read)
**Date:** 2026-08-18
**Scope:** Full read of `sdk-channel-plugins.md`, `building-plugins.md`, `channel-routing.md`, the bundled Telegram plugin source, the session-key builder, the route resolver, the reset policy, and the OpenAI HTTP endpoint. This is the authoritative reference for the StackChan node work.

---

## 1. Minimum code for a channel plugin

The SDK docs (`sdk-channel-plugins.md`) are explicit: the `ChannelPlugin` interface has many **optional** adapter surfaces. The minimum is `id`, `config`, and `setup`, composed via `createChatChannelPlugin` + `createChannelPluginBase`.

The actual minimal shape (from the walkthrough):

```typescript
// src/channel.ts
import { createChatChannelPlugin, createChannelPluginBase } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

export const acmeChatPlugin = createChatChannelPlugin<ResolvedAccount>({
  base: createChannelPluginBase({
    id: "acme-chat",
    config: {
      listAccountIds: () => ["default"],
      resolveAccount,          // reads cfg.channels["acme-chat"]
      inspectAccount(cfg, accountId) { /* enabled/configured/tokenStatus */ },
    },
    setup: {
      applyAccountConfig: ({ cfg, input }) => ({ ...cfg, channels: { ...cfg.channels, "acme-chat": { ...input } } }),
    },
  }),
  // everything below is OPTIONAL:
  security: { dm: { channelKey: "acme-chat", resolvePolicy, resolveAllowFrom, defaultPolicy: "allowlist" } },
  pairing: { text: { idLabel, message, notify } },
  threading: { topLevelReplyToMode: "reply" },
  outbound: { attachedResults: { channel: "acme-chat", sendText }, base: { sendMedia } },
});
```

The entry point wires it:

```typescript
// index.ts
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
export default defineChannelPluginEntry({
  id: "acme-chat",
  name: "Acme Chat",
  description: "Acme Chat channel plugin",
  plugin: acmeChatPlugin,
  registerCliMetadata(api) { /* optional */ },
  registerFull(api) { api.registerGatewayMethod(/* ... */); },
});
```

Manifest requirements (two files):

```jsonc
// package.json
{ "openclaw": { "extensions": ["./index.ts"], "setupEntry": "./setup-entry.ts",
  "channel": { "id": "acme-chat", "label": "Acme Chat", "blurb": "..." } } }

// openclaw.plugin.json
{ "id": "acme-chat", "channels": ["acme-chat"], "name": "Acme Chat",
  "configSchema": { "type": "object", "additionalProperties": false, "properties": {} },
  "channelConfigs": { "acme-chat": { "schema": { ... }, "uiHints": { ... } } } }
```

**Key point:** The `channels` field in `openclaw.plugin.json` (NOT a `kind` field) is what marks a manifest as owning a channel. `configSchema` validates `plugins.entries.<id>.config`; `channelConfigs.<id>.schema` validates `channels.<id>` and is the cold-path source used before the plugin runtime loads.

The bundled Telegram plugin (`dist/extensions/telegram/index.js`) is a **bundled** channel using `defineBundledChannelEntry` with lazy specifiers:

```js
var telegram_default = defineBundledChannelEntry({
  id: "telegram", name: "Telegram", description: "Telegram channel plugin",
  importMetaUrl: import.meta.url,
  plugin: { specifier: "./channel-plugin-api.js", exportName: "telegramPlugin" },
  secrets: { specifier: "./secret-contract-api.js", exportName: "channelSecrets" },
  runtime: { specifier: "./runtime-setter-api.js", exportName: "setTelegramRuntime" },
  accountInspect: { specifier: "./account-inspect-api.js", exportName: "inspectTelegramReadOnlyAccount" },
});
```

The actual `telegramPlugin` object is built with `createChatChannelPlugin({ base: {...}, pairing, security, threading, outbound })` — exactly the same builder as the docs' minimal example, just with many more adapters filled in.

---

## 2. How a channel plugin creates session keys

**The channel plugin does NOT create the session key itself.** Core owns the outer session-key shape. The plugin only provides the *conversation grammar* (how provider ids map to base chat / thread / parent), and core builds the key.

The plugin hook is `messaging.resolveSessionConversation(...)` (canonical) or the bootstrap-safe top-level `session-key-api.ts` export. Telegram's implementation (`dist/session-conversation-BZQxsRev.js`):

```js
function resolveTelegramSessionConversation(params) {
  const parsed = parseTelegramTopicConversation({ conversationId: params.rawId });
  if (!parsed) return null;
  return {
    id: parsed.chatId,
    threadId: parsed.topicId,
    baseConversationId: parsed.chatId,
    parentConversationCandidates: [parsed.chatId],
  };
}
```

The actual key construction happens in core. The two relevant functions:

**`resolveSessionKey(scope, ctx, mainKey, agentId)`** (`dist/session-key-OlXf3EQR.js`) — this is what turns an inbound message context into a session key:

```js
function resolveSessionKey(scope, ctx, mainKey, agentId = DEFAULT_AGENT_ID) {
  const explicit = ctx.SessionKey?.trim();
  if (explicit) return normalizeExplicitSessionKey(explicit, ctx);
  const raw = deriveSessionKey(scope, ctx);   // "global" | group key | sender id
  if (scope === "global") return raw;
  const canonicalAgentId = normalizeAgentId(agentId);
  const canonical = buildAgentMainSessionKey({ agentId: canonicalAgentId, mainKey: normalizeMainKey(mainKey) });
  if (!(raw.includes(":group:") || raw.includes(":channel:"))) return canonical; // DMs collapse to main
  return `agent:${canonicalAgentId}:${raw}`;
}
```

**`deriveSessionKey`** delegates to `resolveGroupSessionKey(ctx)` (`dist/store-BJJhlPrk.js`) for groups/channels:

```js
function resolveGroupSessionKey(ctx) {
  // ... parses ctx.From like "telegram:group:-100123:topic:42"
  return {
    key: `${provider}:${kind}:${finalId}`,   // e.g. "telegram:group:-100123"
    channel: provider, id: finalId, chatType: kind === "channel" ? "channel" : "group",
  };
}
```

So the **channel id becomes the first segment after the agent id** in the final key:

- Group: `agent:<agentId>:<channel>:group:<id>` → e.g. `agent:main:telegram:group:-1001234567890:topic:42`
- Channel/room: `agent:<agentId>:<channel>:channel:<id>`
- Thread: appends `:thread:<threadId>` (Slack/Discord) or embeds `:topic:<topicId>` (Telegram forum topics)
- Direct message: collapses to `agent:<agentId>:<mainKey>` (default `agent:main:main`) unless `session.dmScope` is `per-peer`/`per-channel-peer`/`per-account-channel-peer`.

The lower-level builder `buildAgentPeerSessionKey` (`dist/session-key-VWT_xzM9.js`) shows the exact DM-scope variants:

```js
if (dmScope === "per-account-channel-peer" && peerId)
  return `agent:${agentId}:${channel}:${accountId}:direct:${peerId}`;
if (dmScope === "per-channel-peer" && peerId)
  return `agent:${agentId}:${channel}:direct:${peerId}`;
if (dmScope === "per-peer" && peerId)
  return `agent:${agentId}:direct:${peerId}`;
return buildAgentMainSessionKey({ agentId, mainKey });  // dmScope === "main"
```

**Bottom line for StackChan:** if you want a *group-like* isolated session per chat, the inbound context's `From` must look like `<channel>:group:<id>` (or `:channel:`), and the channel id must be a registered/normalized channel id. If you want DMs to share one session, they collapse to main automatically.

---

## 3. How bindings work (actual match logic)

The resolver is `dist/resolve-route-EO7BJcsf.js` (`resolveAgentRoute`). It builds an index of bindings per `(channel, accountId)` and evaluates them in **tiers** (first match wins):

```js
const tiers = [
  { matchedBy: "binding.peer",          enabled: Boolean(peer), ... },          // exact peer
  { matchedBy: "binding.peer.parent",   enabled: Boolean(parentPeer?.id), ... }, // thread parent
  { matchedBy: "binding.peer.wildcard", enabled: Boolean(peer), ... },           // peer.id === "*"
  { matchedBy: "binding.guild+roles",   enabled: guildId && roles, ... },        // Discord
  { matchedBy: "binding.guild",         enabled: guildId, ... },                 // Discord
  { matchedBy: "binding.team",          enabled: teamId, ... },                  // Slack
  { matchedBy: "binding.account",       enabled: true, ... },                    // accountId (not "*")
  { matchedBy: "binding.channel",       enabled: true, ... },                    // accountId === "*"
];
for (const tier of tiers) {
  if (!tier.enabled) continue;
  const matched = tier.candidates.find((c) => tier.predicate(c) && matchesBindingScope(c.match, {...}));
  if (matched) return choose(matched.binding.agentId, tier.matchedBy, matched.binding.session);
}
return choose(resolveDefaultAgentId(cfg), "default");
```

**Fields you can match on** (from `normalizeBindingMatch`):

```js
function normalizeBindingMatch(match) {
  return {
    accountPattern: (match?.accountId ?? "").trim(),   // accountId, or "*" for any account
    peer: normalizePeerConstraint(match?.peer),          // { kind, id } | { kind, id:"*" } | none
    guildId: normalizeId(match?.guildId) || null,        // Discord
    teamId: normalizeId(match?.teamId) || null,          // Slack
    roles: normalizeRouteBindingRoles(rawRoles),          // Discord roles
  };
}
```

`normalizePeerConstraint`:
- `{ kind, id }` → `{ state: "valid", kind, id }`
- `{ kind, id: "*" }` → `{ state: "wildcard-kind", kind }`
- missing → `{ state: "none" }`

**All provided fields must match** for a binding to apply. The scope matcher (`dist/bindings-CLtaieRA.js`, `routeBindingScopeMatches`) checks guildId, teamId, and roles (roles match if ANY member role is in the binding's roles list). `peerKindMatches` treats `group` and `channel` as interchangeable:

```js
function peerKindMatches(bindingKind, scopeKind) {
  if (bindingKind === scopeKind) return true;
  return (bindingKind === "group" && scopeKind === "channel")
      || (bindingKind === "channel" && scopeKind === "group");
}
```

**Important for StackChan:** a binding can match on `channel` + `accountId` + `peer` (kind/id). For a custom channel you'd write e.g. `{ match: { channel: "stackchan", peer: { kind: "group", id: "..." } }, agentId: "..." }`. The `channel` field is normalized via `normalizeMessageChannel`, so it must resolve to a registered channel id (built-in or plugin).

---

## 4. Does a channel plugin need its own webhook/HTTP endpoint?

**Yes — each channel plugin owns its own inbound pipeline and typically registers its own HTTP route.** The SDK docs are explicit:

> "Inbound message handling is channel-specific. Each channel plugin owns its own inbound pipeline."

The pattern (from the walkthrough's `registerFull`):

```typescript
registerFull(api) {
  api.registerHttpRoute({
    path: "/acme-chat/webhook",
    auth: "plugin", // plugin-managed auth (verify signatures yourself)
    handler: async (req, res) => {
      const event = parseWebhookPayload(req);
      await handleAcmeChatInbound(api, event);
      res.statusCode = 200; res.end("ok"); return true;
    },
  });
}
```

So a channel plugin **can** piggyback on the Gateway's HTTP server (via `api.registerHttpRoute`), but it must register its **own path** and its **own handler** that parses the platform payload and dispatches it through the channel's inbound pipeline. There is no generic "channel webhook" that auto-routes arbitrary payloads. Telegram itself uses either long-polling (`getUpdates`) or a webhook it configures via `setWebhook` — both handled inside the plugin's `gateway.startAccount` → `monitorTelegramProvider` path, not a shared core endpoint.

---

## 5. What `x-openclaw-message-channel` actually does in the code

The header is read in two places:

**`dist/http-utils-B0BcglUl.js`** — `resolveGatewayRequestContext`:

```js
function resolveGatewayRequestContext(params) {
  const agentId = resolveAgentIdForRequest({ req: params.req, model: params.model });
  return {
    agentId,
    sessionKey: resolveSessionKey({ req: params.req, agentId, user: params.user, prefix: params.sessionPrefix }),
    messageChannel: params.useMessageChannelHeader
      ? normalizeMessageChannel(getHeader(params.req, "x-openclaw-message-channel")) ?? params.defaultMessageChannel
      : params.defaultMessageChannel,
  };
}
```

**`dist/tools-invoke-http-peEEDumG.js`** (line 43) — for tool-invoke HTTP:

```js
const messageChannel = normalizeMessageChannel(getHeader(req, "x-openclaw-message-channel") ?? "");
```

`normalizeMessageChannel` (`dist/message-channel-core-CmpZ4x17.js`) resolves aliases to canonical ids:

```js
function normalizeMessageChannel(raw) {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (!normalized) return;
  if (normalized === "webchat") return INTERNAL_MESSAGE_CHANNEL;
  const builtIn = normalizeChatChannelId(normalized);
  if (builtIn) return builtIn;
  return normalizeAnyChannelId(normalized) ?? normalized;  // plugin channel ids pass through
}
```

So the header value is **normalized** (aliases → canonical id, plugin ids pass through) and then flows into the agent command as `runContext.messageChannel` (`dist/agent-command-ABV9I5el.js` line 556):

```js
turnSourceChannel: opts.runContext?.messageChannel ?? opts.messageChannel,
```

From there it becomes the **`turnSourceChannel`** used by `resolveAgentDeliveryPlan` to decide **where replies get delivered** (which channel/account/thread). It is a **delivery-routing label**, not a session-identity driver.

---

## 6. Can the OpenAI HTTP endpoint be used AS a channel surface?

**Partially — and this is the critical finding.** The `/v1/chat/completions` handler (`dist/openai-http-9urlXlOE.js`) does read the header and pass it through:

```js
({agentId, sessionKey, messageChannel} = resolveGatewayRequestContext({
  req, model, user,
  sessionPrefix: "openai",
  defaultMessageChannel: "webchat",
  useMessageChannelHeader: true,   // <-- header IS honored
}));
```

And `messageChannel` is threaded into the agent command via `buildAgentCommandInput` → `agentCommandFromIngress`. So **the header is NOT just a label** — it genuinely becomes `turnSourceChannel` and influences **delivery routing** (where the reply is sent, which channel plugin's outbound is used).

**BUT** — the header does **NOT** drive the session key. The session key for the OpenAI endpoint is built by `resolveSessionKey` in `http-utils`:

```js
function resolveSessionKey(params) {
  const explicit = getHeader(params.req, "x-openclaw-session-key")?.trim();
  if (explicit) { /* validate reserved namespaces */ return explicit; }
  const user = params.user?.trim();
  const mainKey = user ? `${params.prefix}-user:${user}` : `${params.prefix}:${randomUUID()}`;
  return buildAgentMainSessionKey({ agentId: params.agentId, mainKey });
}
```

With `sessionPrefix: "openai"`, the key is `agent:<agentId>:openai-user:<user>` or `agent:<agentId>:openai:<uuid>`. **The `x-openclaw-message-channel` value is NOT part of the session key.** So:

- **Yes**, you can send `x-openclaw-message-channel: stackchan` on `/v1/chat/completions` and the Gateway will treat the *delivery* as if it came from the `stackchan` channel (assuming a `stackchan` channel plugin is registered and configured).
- **No**, it will not create a channel-scoped session key like `agent:main:stackchan:group:<id>`. The session stays under the `openai-*` namespace unless you also pass `x-openclaw-session-key` with an explicit channel-shaped key.

**Implication for StackChan:** To get real channel semantics (isolated per-chat sessions, bindings, outbound delivery to the device), you need an actual channel plugin registered with id `stackchan`, and you should pass an explicit `x-openclaw-session-key` shaped like `agent:main:stackchan:group:<deviceId>` (or use the plugin's inbound pipeline). The header alone gives you delivery routing but not channel-scoped session identity.

---

## 7. What happens to sessions at the 4am reset

The reset is **not** a hardcoded 4am wipe in core — it's a **configurable daily reset policy** that defaults to `daily` at hour `4`. The logic is in `dist/reset-Cmc2g-h4.js`:

```js
const DEFAULT_RESET_MODE = "daily";
function resolveSessionResetPolicy(params) {
  const mode = typeReset?.mode ?? baseReset?.mode ?? (!hasExplicitReset && legacyIdleMinutes != null ? "idle" : "daily");
  const atHour = normalizeResetAtHour(typeReset?.atHour ?? baseReset?.atHour ?? 4);  // default 4
  // ...
}
function resolveDailyResetAtMs(now, atHour) {
  const resetAt = new Date(now);
  resetAt.setHours(normalizedResetAtHour(atHour), 0, 0, 0);
  if (now < resetAt.getTime()) resetAt.setDate(resetAt.getDate() - 1);
  return resetAt.getTime();
}
```

A session is **stale** when `sessionStartedAt < dailyResetAt` (i.e. it started before today's 4am boundary). The freshness check (`evaluateSessionFreshness`) returns `fresh: false` in that case.

**What actually happens on reset** (`dist/session-HDnU4RDT.js`, `resolveSession`):

```js
const fresh = sessionEntry ? !terminalMainTranscriptNewerThanRegistry
  && (skipImplicitExpiry || evaluateSessionFreshness({...}).fresh) : false;
const sessionId = requestedSessionId || (fresh ? sessionEntry?.sessionId : void 0) || crypto.randomUUID();
const isNewSession = !fresh && !requestedSessionId;
const resolvedSessionEntry = isNewSession && sessionEntry ? clearRotatedSessionMetadata(sessionEntry) : sessionEntry;
```

**The channel survives.** The reset only rotates the **`sessionId`** (a fresh `crypto.randomUUID()`) and clears run metadata (`sessionFile`, `status`, `startedAt`, `endedAt`, `sessionStartedAt`, `lastInteractionAt`). The **`sessionKey` is unchanged** — it is derived from the channel/peer/agent, not from the sessionId. So after reset, the same key `agent:main:telegram:group:-100123` maps to a brand-new sessionId, and the next inbound message on that channel recreates the session **under the same channel key**.

Two important nuances:

1. **`skipImplicitExpiry`**: if `resetPolicy.configured !== true` (no explicit reset config) AND the session has a provider-owned model binding (`hasProviderOwnedSession`), the session is treated as always-fresh and never expires. This is a per-provider escape hatch.

2. **`clearRotatedSessionMetadata`** clears the run lifecycle fields but **preserves** `lastChannel`, `channel`, and `origin.provider` (those are not in the cleared list). So the channel identity is retained on the entry even across the rotation.

**Bottom line:** At the 4am daily boundary, the session's *context* is effectively reset (new sessionId, cleared run state), but the **channel and session key persist**. The session is recreated lazily on the next inbound message, and because the key is channel-derived, it lands back in the same channel bucket. There is no "channel death" at reset.

---

## Appendix: Key file map

| Concern | File |
|---|---|
| Channel plugin SDK guide | `docs/plugins/sdk-channel-plugins.md` |
| Plugin building guide | `docs/plugins/building-plugins.md` |
| Channel routing (session key shapes, binding rules) | `docs/channels/channel-routing.md` |
| Telegram plugin entry | `dist/extensions/telegram/index.js` |
| Telegram channel plugin object | `dist/channel-DP5CkqKN.js` |
| Telegram session-conversation grammar | `dist/session-conversation-BZQxsRev.js` |
| Session key builder (core) | `dist/session-key-VWT_xzM9.js` |
| Session key resolution from context | `dist/session-key-OlXf3EQR.js` |
| Group session key derivation | `dist/store-BJJhlPrk.js` (`resolveGroupSessionKey`) |
| Route/binding resolver | `dist/resolve-route-EO7BJcsf.js` |
| Binding scope matcher | `dist/bindings-CLtaieRA.js` |
| Reset policy | `dist/reset-Cmc2g-h4.js` |
| Session resolution + reset rotation | `dist/session-HDnU4RDT.js` |
| `x-openclaw-message-channel` header read | `dist/http-utils-B0BcglUl.js`, `dist/tools-invoke-http-peEEDumG.js` |
| OpenAI HTTP endpoint | `dist/openai-http-9urlXlOE.js` |
| Message-channel normalization | `dist/message-channel-core-CmpZ4x17.js`, `dist/message-channel-normalize-s5PUEeqJ.js` |
