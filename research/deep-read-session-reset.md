# Deep Read: OpenClaw Gateway Session Reset & Channel Persistence

**Date:** 2026-08-18
**Author:** Dex (subagent deep-read)
**Scope:** How the Gateway handles session resets (the "4am dreaming/compaction cycle") and how channels persist across resets. Critical question: does Stack-chan need a channel to survive resets, or can the HTTP endpoint's session mechanism handle it?

---

## Executive Summary

The "4am reset" is **not** a proactive cron job that wipes sessions. It is a **lazy, on-next-message evaluation** of a per-session freshness policy. When a new message arrives and the current `sessionId` is older than the daily reset boundary (default 4am local), the Gateway **rotates the `sessionId`** (generates a new UUID) but **keeps the session key and all channel/delivery bindings intact**. The old transcript is archived; a fresh transcript starts under the same key.

**The channel is the stable anchor.** The session key encodes the channel+peer (`agent:rosie:telegram:direct:8112145924`), and that key never changes across resets. The `route`, `deliveryContext`, `lastChannel`, `lastTo`, `lastAccountId`, and `origin` fields are all preserved through the rotation. Live evidence: Rosie's session key has survived **21 sessionId rotations** with the Telegram binding fully intact.

**HTTP endpoint sessions are treated identically.** A `user`-derived session key (`agent:<agentId>:<prefix>-user:<user>`) is stable and lives in the same session store, so it gets the same daily reset — the key survives, the sessionId rotates. **Stack-chan does NOT need a channel to survive resets** — a stable HTTP session key is sufficient. But a channel provides additional benefits (outbound delivery, presence, pairing) that a bare HTTP key does not.

---

## 1. When and how do sessions reset?

### It is NOT a cron job

There is **no 4am cron job** that resets sessions. The cron list (`openclaw cron list`) shows only:
- `Memory Dreaming Promotion` at `0 3 * * *` (3am ET) — this is the **memory-core dreaming sweep**, which consolidates memory into `MEMORY.md`/`DREAMS.md`. It does **not** touch session state.
- `vault-daily-enhance` at `0 4 * * *` — unrelated.
- Various Rosie/albert/podcast/trading crons — unrelated.

The dreaming cron (3am) and the session reset (4am) are **separate mechanisms**. Dreaming consolidates memory; session reset rotates conversation context. They happen to be near each other in the night, which is why they're conflated.

### It is a lazy freshness check on the next inbound message

The reset is triggered by `evaluateSessionFreshness()` in `dist/reset-Cmc2g-h4.js`, called from `initSessionStateAttemptLocked()` in `dist/get-reply-OTG64ybi.js` on **every inbound message**. The logic:

```js
// reset-Cmc2g-h4.js
const DEFAULT_RESET_MODE = "daily";
const atHour = normalizeResetAtHour(typeReset?.atHour ?? baseReset?.atHour ?? 4); // default 4

function evaluateSessionFreshness(params) {
  const dailyResetAt = params.policy.mode === "daily"
    ? resolveDailyResetAtMs(params.now, params.policy.atHour) : void 0;
  const staleDaily = dailyResetAt != null && sessionStartedAt < dailyResetAt;
  // ...
  return { fresh: !(staleDaily || staleIdle), ... };
}
```

`resolveDailyResetAtMs` computes the most recent 4am boundary. If `sessionStartedAt` (when the current sessionId began) is **before** that boundary, the session is `stale` and gets reset on the next message.

**Key detail:** freshness is based on `sessionStartedAt` (when the current sessionId began), **not** on `updatedAt` or `lastInteractionAt`. So a session that started yesterday at 3pm is stale at 4am today, regardless of how recently it was used.

### What exactly gets wiped

From `performGatewaySessionReset()` in `dist/session-reset-service-CV7slv6G.js` and `initSessionStateAttemptLocked()` in `get-reply-OTG64ybi.js`:

**Rotated (new values):**
- `sessionId` → new `randomUUID()`
- `sessionFile` → new transcript path (old one archived)
- `sessionStartedAt` → now
- `lastInteractionAt` → now
- `inputTokens`/`outputTokens`/`totalTokens` → 0
- `compactionCount` → 0 (in the reply-path reset)
- `systemSent` → false
- `abortedLastRun` → false
- `model`/`modelProvider` → re-resolved (model override preserved via `resolveResetPreservedSelection`)

**Preserved (survive the reset):**
- **`sessionKey`** (the bucket key — never changes)
- **`channel`, `lastChannel`, `lastTo`, `lastAccountId`, `lastThreadId`** (delivery route)
- **`route`, `deliveryContext`, `origin`** (full channel binding)
- `groupId`, `groupChannel`, `space`, `subject`
- `label`, `displayName`
- `thinkingLevel`, `verboseLevel`, `traceLevel`, `reasoningLevel`, `elevatedLevel`, `ttsAuto`
- `execHost`, `execSecurity`, `execAsk`, `execNode`
- `sendPolicy`, `queueMode`, `queueDebounceMs`, `queueCap`, `queueDrop`
- `spawnedBy`, `parentSessionKey`, `spawnDepth`, `subagentRole` (for subagents)
- `usageFamilyKey` + `usageFamilySessionIds` (the history of all prior sessionIds — this is how we can see the rotations)
- `modelOverride`/`providerOverride` (user-pinned model survives)

The old transcript is archived (`.jsonl` → `.jsonl.deleted.<timestamp>` or archived), and a fresh transcript starts under the new sessionId.

---

## 2. What survives a session reset?

| Item | Survives? | Evidence |
|------|-----------|----------|
| **Session key** (`agent:rosie:telegram:direct:8112145924`) | ✅ Yes | Key is the store bucket; never re-derived on reset |
| **Channel binding** (`route`, `deliveryContext`, `lastChannel`, `lastTo`, `lastAccountId`) | ✅ Yes | Explicitly copied into `nextEntry` in `performGatewaySessionReset` |
| **Agent binding** | ✅ Yes | Key embeds `agentId`; store is per-agent |
| **Session key pattern** (so a new session gets created with same key) | ✅ Yes | The key IS the anchor; new sessionId is written under the same key |
| **Transcript history** | ❌ No (archived) | Old `.jsonl` archived; fresh transcript starts |
| **Token counters** | ❌ No | Reset to 0 |
| **Model override** | ✅ Yes | Preserved via `resolveResetPreservedSelection` |
| **Compaction count** | ❌ No | Reset to 0 |

**Live proof from `~/.openclaw/agents/rosie/sessions/sessions.json`:**

```json
"agent:rosie:telegram:direct:8112145924": {
  "sessionId": "572353f4-...",          // current
  "usageFamilySessionIds": [            // 21 prior sessionIds — all under the SAME key
    "27eb94a6-...", "a5204d9d-...", ..., "572353f4-..."
  ],
  "route": { "channel": "telegram", "accountId": "rosie",
             "target": { "to": "telegram:8112145924" } },
  "deliveryContext": { "channel": "telegram", "to": "telegram:8112145924",
                       "accountId": "rosie" },
  "lastChannel": "telegram",
  "lastTo": "telegram:8112145924",
  "lastAccountId": "rosie",
  "origin": { "label": "James A (@j_aita) id:8112145924", ... }
}
```

The key has survived **21 sessionId rotations** with the Telegram binding fully intact. This is the definitive proof that the channel binding survives resets.

---

## 3. After a reset, when a new message arrives from the same channel, what happens?

The flow on each inbound message (from `get-reply-OTG64ybi.js` `initSessionStateAttemptLocked`):

1. **Resolve the session key** from the inbound context. For Telegram DM, `resolveSessionKey()` derives `agent:rosie:telegram:direct:8112145924` from the channel+peer. This is deterministic — same channel+peer always yields the same key.
2. **Load the existing entry** for that key from `sessions.json`.
3. **Evaluate freshness** via `evaluateSessionFreshness()`. If `sessionStartedAt < dailyResetAt` (4am), the entry is `stale`.
4. **If stale:** the code takes the `else` branch — generates a **new `sessionId`** (`crypto.randomUUID()`), sets `isNewSession = true`, and **rebuilds the entry** with `...baseEntry` (preserving all channel/delivery fields) but with the new sessionId, `sessionStartedAt = now`, and zeroed tokens.
5. **The new session is written under the SAME session key.** The old transcript is archived.
6. The agent runs with the fresh context, and replies go to the preserved `lastChannel`/`lastTo`/`lastAccountId`.

So: **the Gateway creates a new session under the same channel key automatically.** No manual intervention needed. The next morning, James sends a message to the same Telegram bot, and a fresh session is created under `agent:rosie:telegram:direct:8112145924` with a new sessionId.

---

## 4. For HTTP endpoint sessions (via `user` field or `x-openclaw-session-key`)

**They are treated identically.** From `dist/http-utils-B0BcglUl.js`:

```js
function resolveSessionKey(params) {
  const explicit = getHeader(params.req, "x-openclaw-session-key")?.trim();
  if (explicit) {
    if (isReservedSessionKeyOverride(explicit)) throw new GatewaySessionKeyOverrideError();
    return explicit;   // explicit key used as-is
  }
  const user = params.user?.trim();
  const mainKey = user ? `${params.prefix}-user:${user}` : `${params.prefix}:${randomUUID()}`;
  return buildAgentMainSessionKey({ agentId: params.agentId, mainKey });
}
```

Three cases:
- **`x-openclaw-session-key` header present** → used verbatim (e.g. `agent:rosie:stackchan:main`). Stable across calls.
- **`user` field present** → derives `agent:<agentId>:<prefix>-user:<user>` (e.g. `agent:rosie:http-user:stackchan`). **Stable** across calls that reuse the same `user` value.
- **Neither** → `agent:<agentId>:<prefix>:<randomUUID>` — **stateless**, a new key every call.

All three write to the **same session store** (`~/.openclaw/agents/<agentId>/sessions/sessions.json`) and are subject to the **same daily reset** logic. The `user`-derived and explicit keys are stable, so they survive resets exactly like Telegram keys — the sessionId rotates, the key stays, and the delivery fields (which for HTTP are the synthetic channel context) are preserved.

**Important caveat for HTTP:** the "channel" for an HTTP session is synthetic. There's no real outbound transport — the Gateway can't push messages to Stack-chan; Stack-chan must poll or send requests. The `lastChannel`/`lastTo` for an HTTP session point to the synthetic ingress, not a real deliverable target. So while the session *survives* resets, the *reply delivery* mechanism is different (Stack-chan must request the response, not receive a push).

---

## 5. Is there a way to make a session "persistent" or "protected" from resets?

**Yes, several knobs exist** (from `docs/concepts/session.md` and the config schema):

### a) `session.reset` — change the cadence
```json5
{
  session: {
    reset: { mode: "daily", atHour: 4 },   // default
    // or
    reset: { mode: "idle", idleMinutes: 10080 },  // reset only after 7 days idle
  }
}
```
- `mode: "daily"` (default) — reset at `atHour` (default 4).
- `mode: "idle"` — reset only after `idleMinutes` of inactivity. **This is the closest to "persistent"** — a session stays alive indefinitely as long as it's used within the idle window.
- `resetByType` / `resetByChannel` — per-chat-type or per-channel overrides.

### b) `session.maintenance` — storage bounds (not reset, but related)
```json5
{
  session: {
    maintenance: { mode: "enforce", pruneAfter: "30d", maxEntries: 500 }
  }
}
```
This prunes old *entries* (rows), not the active session. It preserves "durable external conversation pointers, including group sessions and thread-scoped chat sessions."

### c) Provider-owned CLI sessions are exempt
From `entry-freshness.js`: `hasProviderOwnedSession(entry)` — if a session has an active provider-owned CLI session (e.g. Claude Code, Codex) and no explicit reset policy is configured, the implicit daily default is **skipped** (`skipImplicitExpiry`). These sessions only reset via explicit `/reset` or configured `session.reset`.

### d) There is NO "protected/pinned" flag
There is no per-session `persistent: true` or `protected: true` flag in the schema. The closest mechanisms are:
- `mode: "idle"` with a large `idleMinutes` (effectively persistent while active).
- Provider-owned CLI session exemption.
- `resetByChannel` to disable reset for a specific channel.

**For Stack-chan:** the cleanest "persistent" approach is to set `session.reset.mode: "idle"` with a large `idleMinutes` (e.g. 10080 = 7 days), or set `resetByChannel` for the HTTP/stackchan channel. But honestly, the default daily reset is harmless for Stack-chan — the session key survives, so continuity of the *binding* is preserved; only the conversation context resets, which is usually desirable for a daily-reset device.

---

## 6. How does Telegram handle this?

**Concretely, for Rosie's Telegram DM:**

1. James messages the Rosie bot at, say, 8am after a 4am reset.
2. The Telegram plugin receives the message, derives the session key `agent:rosie:telegram:direct:8112145924` (from channel=telegram, account=rosie, peer=8112145924).
3. The Gateway loads the entry, sees `sessionStartedAt` is before today's 4am boundary → **stale**.
4. It generates a new `sessionId`, archives the old transcript, and writes a fresh entry **under the same key**.
5. The agent runs with fresh context (re-boots from AGENTS.md/MEMORY.md per the boot sequence), and replies to `telegram:8112145924` via the `rosie` account.

**The key `agent:rosie:telegram:direct:8112145924` never changes.** This is confirmed by the 21 prior sessionIds in `usageFamilySessionIds`. The channel is the stable anchor that the session hangs off.

---

## 7. What is the channel's role in session recreation?

**The channel is the stable anchor.** Technically:

- **Session key derivation** (`dist/session-key-OlXf3EQR.js`): `resolveSessionKey()` builds the key from the inbound context. For DMs with `dmScope: "per-channel-peer"` (Rosie's config), the key is `agent:<agentId>:<channel>:direct:<peerId>`. The channel+peer are baked into the key.
- **Deterministic re-derivation:** every message from the same channel+peer re-derives the *same* key. So even if the entry were deleted entirely, the next message would recreate it under the same key.
- **Reset preserves the key:** the reset logic never changes the key — it only rotates the `sessionId` under that key.
- **Delivery fields preserved:** `route`, `deliveryContext`, `lastChannel`, `lastTo`, `lastAccountId` are copied into the new entry, so replies route back to the same channel.

So the channel is not just an anchor — it's the **primary key** of the session. The sessionId is a secondary, rotatable identifier.

---

## The Critical Question: Does Stack-chan need a channel?

**No — a stable HTTP session key is sufficient to survive resets.** Here's the reasoning:

1. **HTTP sessions live in the same store and get the same reset treatment.** A `user`-derived key (`agent:rosie:http-user:stackchan`) or explicit `x-openclaw-session-key` (`agent:rosie:stackchan:main`) is stable and survives resets exactly like a Telegram key. The sessionId rotates; the key and its delivery fields persist.

2. **What a channel adds (beyond reset survival):**
   - **Outbound push delivery** — a real channel (Telegram, etc.) lets the Gateway push replies. HTTP is request/response; Stack-chan must poll or send a request to get the response.
   - **Presence/pairing** — channel plugins handle auth, allowlists, DM policies.
   - **`lastRoute` pinning** — for DMs, the channel pins the reply route so non-owner messages don't hijack it.

3. **What Stack-chan actually needs:**
   - **A stable session key** (via `user` field or `x-openclaw-session-key`) so conversation continuity survives resets. ✅ HTTP supports this.
   - **A way to receive replies** — this is the real gap. If Stack-chan only needs to *send* a request and *read* the synchronous response, HTTP is fine. If it needs the Gateway to *initiate* messages (proactive reminders, etc.), it needs a channel or a polling mechanism.

### Recommendation

- **For reset survival alone:** HTTP with a stable `user` value or `x-openclaw-session-key` is **fully sufficient**. No channel needed. The session key persists across the daily reset.
- **For proactive/outbound communication:** Stack-chan needs either a real channel binding or a polling loop that requests pending responses. The HTTP endpoint alone cannot push.
- **If you want to avoid the daily context reset entirely:** set `session.reset.mode: "idle"` with a large `idleMinutes`, or `resetByChannel` for the stackchan channel. But note this is optional — the default daily reset preserves the binding, just not the conversation context.

---

## Appendix: Key Source Files

| File | Role |
|------|------|
| `dist/reset-Cmc2g-h4.js` | Reset policy resolution + freshness evaluation (the core logic) |
| `dist/session-reset-service-CV7slv6G.js` | `performGatewaySessionReset()` — the full reset lifecycle |
| `dist/get-reply-OTG64ybi.js` | `initSessionStateAttemptLocked()` — lazy reset on inbound message |
| `dist/entry-freshness-CDmEOaOV.js` | `resolveSessionEntryResetFreshness()` — freshness wrapper |
| `dist/session-key-OlXf3EQR.js` | Session key derivation (channel+peer → key) |
| `dist/http-utils-B0BcglUl.js` | HTTP endpoint session key resolution (`user`/`x-openclaw-session-key`) |
| `dist/store-BJJhlPrk.js` | Session store, `resetSessionEntryLifecycle` |
| `docs/concepts/session.md` | Session lifecycle documentation |
| `docs/concepts/dreaming.md` | Dreaming (memory consolidation — separate from session reset) |
| `docs/gateway/openai-http-api.md` | HTTP endpoint session behavior |

## Appendix: Config State (Rosie)

- `session.dmScope: "per-channel-peer"` — DMs isolated by channel+peer.
- **No explicit `session.reset` block** → uses default `mode: "daily", atHour: 4`.
- `memory-core` dreaming: `enabled: true`, `timezone: "America/Toronto"`, cron `0 3 * * *` (3am — memory, not session).
- Rosie Telegram account: `allowFrom: ["8112145924", "8261476039"]`, `dmPolicy: "allowlist"`.
