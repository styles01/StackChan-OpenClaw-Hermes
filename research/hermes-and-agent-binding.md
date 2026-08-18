# Hermes & Agent-to-Channel Binding — Research Summary

**Date:** 2026-08-18 | **Researcher:** Dex (subagent) | **Source:** `/Users/clawdio/.openclaw/openclaw.json`, `/Users/clawdio/.openclaw/agents/hermes/`, `/Users/clawdio/.hermes/hermes-agent/`, Rosie memory files

---

## 1. How Hermes is configured as an agent

**Workspace is NOT under `openclaw-workspaces/hermes/`** (that path doesn't exist). Hermes lives in two places:

- **Agent dir:** `/Users/clawdio/.openclaw/agents/hermes/` → contains `TEAM.md`, an `agent/` folder (sqlite, codex-home), and `sessions/`. It's a stateful OpenClaw agent profile.
- **Workspace/home:** `/Users/clawdio/.hermes/hermes-agent/` → a full check-out of the **Hermes AI agent (by Nous Research)** — its own Python codebase (`cli.py`, `hermes_state.py`, `run_agent.py`, `acp_adapter/`, `gateway/`, etc.).

**Gateway registration** (`agents.list` entry):
```json
{
  "id": "hermes",
  "workspace": "/Users/clawdio/.hermes/hermes-agent",
  "identity": { "name": "Hermes", "emoji": "🦽" },
  "subagents": { "allowAgents": [...], "requireAgentId": true },
  "sandbox": { "mode": "off" },
  "runtime": { "type": "acp", "acp": { "agent": "hermes", "backend": "acpx",
             "mode": "persistent", "cwd": "/Users/clawdio" } }
}
```

So Hermes is an **external ACP agent** (AI-code-provider protocol), launched via the `acpx` plugin entry:
```json
"plugins.entries.acpx.config.agents.hermes.command":
  "env HERMES_HOME=/Users/clawdio/.hermes NO_COLOR=1 TERM=dumb .../venv/bin/python3 -m acp_adapter.entry"
```
Note: `plugins.entries.acpx.enabled` is currently **false**, so Hermes as an ACP agent is wired up but not currently activated at the plugin level.

## 2. Agent-to-channel binding in the Gateway config

Binding is done by the top-level **`bindings`** array. Each entry matches an inbound message (by `channel` + `accountId`) to an `agentId`:

```json
[
  { "agentId": "main",    "match": { "accountId": "default", "channel": "telegram" } },
  { "agentId": "webby",   "match": { "accountId": "webby",   "channel": "telegram" } },
  { "agentId": "dex",     "match": { "accountId": "dex",     "channel": "telegram" } },
  { "agentId": "ernest",  "match": { "accountId": "ernest",  "channel": "telegram" } },
  { "agentId": "deborah", "match": { "accountId": "deborah", "channel": "telegram" } },
  { "agentId": "pedro",   "match": { "accountId": "pedro",   "channel": "telegram" } },
  { "agentId": "albert",  "match": { "accountId": "albert",  "channel": "telegram" } },
  { "agentId": "gordon",  "match": { "accountId": "gordon",  "channel": "telegram" } },
  { "agentId": "thomas",  "match": { "accountId": "thomas",  "channel": "telegram" } },
  { "agentId": "rosie",   "match": { "accountId": "rosie",   "channel": "telegram" } }
]
```
- **Hermes is NOT in `bindings`** — it has no human-facing channel. It is reached via ACP (agent-to-agent), not Telegram.
- `session.dmScope = "per-channel-peer"` — DM sessions are scoped per channel+peer.

## 3. What routes Telegram messages from James to Rosie (not Clawdio/main)

Two layers combine:

**(a) `bindings`**: `rosie` agent is bound to telegram `accountId: "rosie"`. (Clawdio/main is bound to `accountId: "default"` — a *different* bot token.)

**(b) `channels.telegram.accounts.rosie`** — each agent owns a **separate Telegram bot** (unique `botToken`). Rosie's account:
```json
"rosie": {
  "botToken": "8160822997:...",
  "allowFrom": ["8112145924", "8261476039"],   // James's chat IDs
  "dmPolicy": "allowlist",
  "groupAllowFrom": ["8112145924", "8261476039"],
  "groupPolicy": "allowlist"
}
```
**Why James reaches Rosie, not Clawdio:** James messages *Rosie's bot* (token `8160822997`), whose accountId is `rosie`. The `bindings` entry `{agentId: rosie, accountId: rosie}` routes that bot's DMs to the Rosie agent. The top-level `allowFrom: ["8112145924"]` + `dmPolicy: pairing` also restricts who may DM. Rosie's `allowFrom` allowslist additionally gates it to James's IDs.

## 4. Pattern for binding a new channel/device to an agent

For a *new Telegram bot / channel* → agent:
1. Add `channels.telegram.accounts.<name>` with a fresh `botToken` (+ `allowFrom`, `dmPolicy`, `groupPolicy`).
2. Add a `bindings` entry: `{ "agentId": "<agent>", "match": { "accountId": "<name>", "channel": "telegram" } }`.

For the **Stack-chan robot (not a messaging channel)**, the relevant existing pattern is different — see next section.

## 5. Existing device / hardware / robot channel integrations

- **No dedicated "device" or "robot" channel exists** in `channels` (`devices`, `rooms`, `multiAgent` are all empty `{}`). Only `discord`, `telegram`, `whatsapp` channels.
- **Gateway `nodes.allowCommands`** already has a **robot command allowlist** — the closest thing to a device binding:
  ```
  rosie.status, rosie.servo.look, rosie.servo.home, rosie.vision.capture
  (plus generic: talk.start, talk.stop, face.set, face.gesture, canvas.*, device.info, device.status, wifi.status)
  ```
- **`gateway.http.endpoints.chatCompletions.enabled: true`** — the Gateway serves an OpenAI-compatible `/v1/chat/completions`. Rosie's memory (2026-08-18) confirms the **Stack-chan firmware can hit the Gateway directly** (`Authorization: Bearer clawdiomax`, password auth mode, WS `ws://localhost:18789`) — no device pairing or middleware needed. This is the intended robot→agent path.
- **`talk`** section configures realtime/voice (`interruptOnSpeech`, `realtime.mode: realtime`, `brain: direct-tools`).
- **`robot-bridge`** (from Rosie research): a separate-machine Python FastAPI bridge that speaks XiaoZhi/WebSocket protocol to the ESP32, with ASR/TTS/MCP tool design — a **Goldmine of protocol patterns** (Opus params, face-tracking, LED state machine) to reuse, not copy. ESP32 runs stock firmware; bridge handles the AI side.
- **`acp.allowedAgents`** includes `hermes`, `droid`, etc. — ACP lets agents invoke each other as code agents (a device could expose itself as an ACP agent too).

---

### Bottom line for Stack-chan / Rosie robot
No existing hardware-channel integration to copy. The established, working pattern is:
1. **Agent** = a `bindings`-bound agent (like `rosie`) with its own channel account, OR just the existing `rosie` agent.
2. **Device access** = Gateway `nodes.allowCommands` allowlist (add robot commands like `rosie.*`).
3. **LLM path** = firmware → Gateway HTTP `/v1/chat/completions` (already working per Rosie's tests), or a thin `robot-bridge`-style WebSocket layer.
4. **Voice/realtime** = the `talk` config + a `robot-bridge`-style audio pipeline.
