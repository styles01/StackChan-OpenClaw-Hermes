# Stack-chan Channel Integration — Current Plan & Findings
**Saved: 2026-08-18 12:00 MDT**

## James's Direction (11:59 MDT)
> "You need a channel key not a session key because OpenClaw and Hermes reset sessions at 4am to prevent context bloat, and to enable dreaming. So you need to validate the channel surface properly."

**Key insight:** Sessions are ephemeral (reset at 4am for dreaming/compaction). The **channel** is the stable identity. Stack-chan needs to be a first-class channel — like telegram, discord, whatsapp — NOT just an HTTP client with a session key.

## What We Proved
1. ✅ `model: openclaw/agent-a` → Agent A responds with full workspace access (read + write)
2. ✅ `user: "stackchan:device-001"` → persistent session bound to Agent A (auto-scoped to `agent:agent-a:openai-user:stackchan:device-001`)
3. ❌ `x-openclaw-session-key: stackchan:device-002` → routes to <your-host> (default agent), NOT Agent A
4. ✅ Agent-prefixed session key `agent:agent-a:stackchan:device-002` → routes to Agent A correctly
5. ✅ Stack-chan can write files to Agent A's workspace through the Gateway

## What We Haven't Validated
- **Channel surface**: Is Stack-chan recognized as a channel in the Gateway? (No.)
- **Session survival across 4am reset**: Does the `user` field session survive? (Unknown — probably not, since it's still a session.)
- **Channel key stability**: Does a channel binding survive session resets? (This is what James is pointing at.)

## Research Findings (5 subagents)

### 1. Gateway Protocol (WebSocket) — COMPLETE
- WS is too heavy for ESP32 (signed device handshake, Ed25519, nonce challenge, JSON-RPC)
- Recommendation: HTTP `/v1/chat/completions` with stable `user` string
- File: `research/gateway-protocol-ws.md`

### 2. Agent Binding — COMPLETE
- The `bindings` array in Gateway config routes messages to agents:
  `{ agentId: "agent-a", match: { channel: "telegram", accountId: "agent-a" } }`
- Stack-chan needs a binding entry, not just a session key
- File: `research/hermes-and-agent-binding.md`

### 3. HTTP Endpoint Session Behavior — COMPLETE
- Root cause: bare session keys get re-scoped to default agent (<your-host>)
- `user` field auto-scopes to `agent:agent-a:openai-user:<value>` — Agent A-bound + persistent
- Agent-prefixed session keys also work
- File: `research/http-endpoint-session-behavior.md`
- **BUT**: sessions reset at 4am. `user` field sessions are still sessions — they'll reset too.

### 4. Channel Plugin Architecture — PENDING (subagent still running)
### 5. Multi-Agent Session Routing — PENDING (subagent still running)

## The Real Question
James is saying: **channel key, not session key.** The channel is the stable identity. Sessions hang off channels. When sessions reset at 4am, the channel survives and a new session is created under it.

Stack-chan needs:
1. A **channel identity** in the Gateway (like `stackchan`)
2. A **binding** that routes `stackchan` channel → `agent-a` agent
3. Sessions that get created/reset under the channel, surviving 4am resets
4. The firmware sends something that identifies its channel, not just a session

## Next Steps (after research completes)
1. Read the channel plugin + multi-agent routing research when subagents finish
2. Determine: Does Stack-chan need a full channel plugin, or can the `x-openclaw-message-channel: stackchan` header + a binding config entry do it?
3. Validate: Does the channel survive session resets?
4. Build the right thing — not reinvent what's already solved in the reference projects

## Subagent Status at Save Time
- ✅ research-gateway-protocol — COMPLETE
- ✅ research-hermes-binding — COMPLETE
- ✅ research-http-sessions — COMPLETE
- ⏳ research-channel-plugins — RUNNING
- ⏳ research-session-routing — RUNNING