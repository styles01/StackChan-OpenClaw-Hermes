# Gateway WebSocket Protocol vs OpenAI HTTP — for Stack-chan (ESP32)

Research date: 2026-08-18. Sources: `docs/gateway/protocol.md`, `docs/gateway/openai-http-api.md`, `docs/gateway/config-agents.md`, and `dist/server.impl-*.js`.

## How the WS Gateway Protocol works

The Gateway serves a WebSocket control plane on the **same port** as its HTTP
API (the HTTP server upgrades `/upgrade` → `WebSocketServer`). Every OpenClaw
client (CLI, web UI, macOS app, iOS/Android **nodes**, headless nodes) connects
over WS.

**Framing** — text frames, JSON payloads, three shapes:
- Request `{type:"req", id, method, params}`
- Response `{type:"res", id, ok, payload|error}`
- Event `{type:"event", event, payload, seq?}` (server-pushed: chat deltas, ticks, presence)

**Handshake** (first frame must be `connect`):
1. Server sends `connect.challenge` (nonce + ts).
2. Client replies with `connect` declaring `client` (id/version/platform/mode),
   `role` (`operator` | `node`), `scopes`, `caps`, `commands`, `auth.token`,
   and a signed `device` block (id, publicKey, signature over the nonce).
3. Server returns `hello-ok` with `protocol`, `auth.role/scopes`, optional
   `deviceToken`, and `policy` (maxPayload, maxBufferedBytes, tickIntervalMs).
4. Keepalive via periodic `tick`; silent timeout closes with code 4000.

**Auth modes:** `none` | `token` | `password` | `trusted-proxy`. After pairing
the gateway issues a per-device `deviceToken` (persisted for reconnect).
Pairing requires operator approval unless loopback auto-approval.

**Session routing (WS):** sessions are addressed by `sessionKey` in the
`sessions.*` / `chat.*` / `agent` methods (`sessions.send`, `chat.send`,
`chat.inject`). WS is designed for full operator control-plane + realtime
event push. This is the same codepath Telegram/CLI/Control-UI use internally.

## OpenAI HTTP endpoint (the alternative)

Enabled via `gateway.http.endpoints.chatCompletions.enabled=true`, served on
the same port: `POST /v1/chat/completions`, `/v1/models`, `/v1/embeddings`,
`/v1/responses`. Auth = `Authorization: Bearer <gateway-token/password>` (full
operator-equivalent credential — not a narrow per-user scope; keep on
loopback/tailnet/private ingress only).

- **Stateless by default** — a new session key is generated per request.
- **Stable sessions** via OpenAI `user` string → gateway derives a stable
  session key; reuse the same `user` per conversation thread.
- **Explicit routing** via `x-openclaw-session-key` header.
- **Model = agent target**: `openclaw/default` or `openclaw/<agentId>`.
- Streaming via SSE (`stream: true`, `data: [DONE]`), function tools supported.

## Suitability for an ESP32 client

The full WS protocol is **heavy for an ESP32**: signed device handshake,
nonce challenge, scopes/caps model, device-token pairing flow, reconnect with
backoff, tick keepalives, and a large JSON RPC surface. It is a full
operator/node control-plane protocol designed for native apps (iOS/Android),
not constrained microcontrollers. An ESP32 would need an embedded
WebSocket + JSON + crypto (Ed25519 signing) stack — significant Flash/RAM and
firmware complexity.

The **OpenAI HTTP endpoint is a much better fit** for Stack-chan:
- Plain HTTPS POST + JSON, `Authorization: Bearer` header.
- Stateless per request (or stable per `user` string).
- SSE streaming available but optional (non-streaming returns full JSON).
- No handshake, no device pairing, no reconnect state machine, no tick
  keepalives — just request/response.
- The only real cost: you hold a shared gateway token on the device.

**Recommendation: use HTTP** (`/v1/chat/completions`) for the ESP32. It maps
directly onto the OpenAI-style calls a small client already makes, with
minimal firmware footprint. Reserve WS for a host/companion (e.g. a laptop or
Raspberry Pi bridge) that can run the full gateway-client.

## WebSocket vs HTTP vs HTTP+session-headers — tradeoffs

| Approach | Pros | Cons |
|---|---|---|
| **WS protocol** | Full-duplex, realtime push (chat deltas, ticks), device-token pairing, scopes | Heavy: signed handshake, pairing, reconnect, tick; JSON-RPC surface; too much for ESP32 |
| **HTTP `/v1/chat/completions`** | Simplest; stateless; plain JSON; SSE optional; one bearer token | Stateless per call unless you supply `user`; shared token = operator-equivalent (keep private); no server push |
| **HTTP + session-headers** (`user` / `x-openclaw-session-key`) | Middle ground: stateless transport + stable conversation continuity; cheap for embedded | Still no realtime push (poll for updates); session key management on device |

**Bottom line:** For a resource-constrained device that only needs
request/response chat, use **HTTP with a stable `user` string** (or
`x-openclaw-session-key`) to get session continuity without WS complexity.
Reach for the WS protocol only when the device needs server-pushed events or
device pairing/identity — which an ESP32 Stack-chan does not.
