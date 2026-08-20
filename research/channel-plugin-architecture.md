# OpenClaw Channel Plugin Architecture — Research Summary

Research into how OpenClaw channel plugins (Telegram, Discord) handle session routing, agent binding, and channel identity. Sources: `docs/plugins/sdk-channel-plugins.md`, `docs/plugins/building-plugins.md`, bundled Telegram plugin (`dist/extensions/telegram/`, `dist/channel-*.js`, `dist/session-key-*.js`, `dist/resolve-route-*.js`), and `docs/gateway/openai-http-api.md`.

## 1. How channel plugins register with the Gateway

A channel plugin is a package with an `openclaw.channel` metadata block and a manifest (`openclaw.plugin.json`) declaring `channels: ["<id>"]`. The entry point uses `defineChannelPluginEntry(...)` (channel plugins) vs `definePluginEntry(...)` (other plugins). The plugin object (`ChannelPlugin`) is built via `createChatChannelPlugin`/`createChannelPluginBase`, exposing `id`, `config`, `setup`, `security.dm`, `pairing`, `threading`, and `outbound`/`message` adapters. Discovery loads the module to register capabilities without activating the transport; `registerFull(api)` wires runtime-only work (webhooks, gateway RPC methods). The plugin receives inbound events via its own webhook and dispatches them through the shared inbound pipeline.

## 2. Session key construction

The canonical builder is `buildAgentPeerSessionKey` (`dist/session-key-*.js`). With `dmScope = per-channel-peer` (this machine's setting), a direct message becomes:

```
agent:<agentId>:<channel>:direct:<peerId>
```

e.g. `agent:agent-a:telegram:direct:<chatId>`. For groups it's `...:group:<peerId>`, and threads append `:thread:<id>`. With `per-account-channel-peer` scope the accountId is inserted: `agent:<agentId>:<channel>:<accountId>:direct:<peerId>`. The peerId is normalized/lowercased; Telegram's `resolveTelegramSessionConversation` parses topic vs group ids from the raw chat id. Core owns the outer `agent:<id>:...` shape; the plugin supplies the inner conversation grammar via `messaging.resolveSessionConversation(...)`.

## 3. Agent binding (how Telegram routes to agent-a vs <your-host>)

The message is NOT routed by "which bot received it" alone — it's routed by the configured **bindings** (`cfg.bindings`). `resolveAgentRoute` (`dist/resolve-route-*.js`) iterates binding tiers: peer → parent-peer → peer-wildcard → guild+roles → guild → team → account → channel → default agent. Each binding is `{ agentId, match: { channel, accountId, peer? } }`. On this host, bindings map `agentId ↔ accountId` per channel (e.g. `agent-a`→`telegram` account `agent-a`, `dex`→`dex`, `main`→`default`). Each agent has its own Telegram bot token; the binding ties that bot account to its agent. `choose()` builds the session key with the resolved agentId, so the session key's agent segment always matches the routed agent. Identity flows: bot account (via `accountId`) + chat peer (via chatId) → binding match → agentId → session key `agent:<agentId>:telegram:direct:<peerId>`.

## 4. Minimum viable channel plugin

A package with `openclaw.channel` metadata + `openclaw.plugin.json` (declares `channels`, `configSchema`), an entry using `defineChannelPluginEntry`, a `ChannelPlugin` with at least `id`, `config` (account resolution), `setup`, `security.dm`, and an `outbound`/`message` adapter; plus an inbound webhook (registered via `api.registerHttpRoute`) that verifies the platform signature and calls the shared inbound dispatch. Full examples: bundled Telegram/Microsoft Teams/Google Chat plugins.

## 5. Stack-chan: HTTP endpoint vs full plugin

**Stack-chan can use the OpenAI HTTP endpoint with proper headers — no channel plugin required.** The Gateway exposes `POST /v1/chat/completions` (and `/v1/responses`, `/v1/embeddings`) on port 18789 when `gateway.http.endpoints.chatCompletions.enabled: true`. It's disabled by default (config flag must be set). It treats the OpenAI `model` field as an **agent target**: `openclaw/default` → default agent, `openclaw/<agentId>` → specific agent. Headers enable routing: `x-openclaw-agent-id` (agent override), `x-openclaw-session-key` (explicit session routing, e.g. a per-device/conversation key), `x-openclaw-message-channel` (synthetic channel context), and `x-openclaw-model` (backend model override). Auth is `Authorization: Bearer <gateway token/password>`.

**Recommendation:** Since Stack-chan is a single physical device talking to one agent (Agent A), the HTTP endpoint is the pragmatic fit — use `model: openclaw/agent-a`, a stable `user`/`x-openclaw-session-key` per conversation for continuity, and `x-openclaw-message-channel` to give it a channel identity. A full channel plugin is only warranted if Stack-chan needs to behave as a first-class messaging network (its own users/rooms/webhooks/outbound transport) or appear in `channels list`/status.
