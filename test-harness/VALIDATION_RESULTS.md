# Agent Binding Validation Results
**Date: 2026-08-18 13:49 MDT**
**All 10 tests PASSED ✅ (strict validation)**

## Test Results

### Unit Tests (no network) ✅
- OpenClaw header construction: session key, channel, auth all correct
- Hermes header construction: session key, auth correct
- Session key structure validation: 6/6 cases (agent-prefixed valid, bare keys invalid)
- Hermes dedicated port URL construction: no `/p/` prefix needed

### OpenClaw / Agent A ✅
- Auth rejection: 401 without token, 401 with invalid token
- Models endpoint: 17 agents listed including `openclaw/agent-a`
- **Identity validation (STRICT):** "I'm Agent A, your household operations director..." ✅ contains "agent-a"
- Session persistence: "Your name is TestBot." ✅ contains "testbot"

### Hermes / Agent B (dedicated port 8643, Option B) ✅
- Auth rejection: 401 without token, 401 with invalid token
- Models endpoint: lists `agent-b`
- **Identity validation (STRICT):** "I'm Agent B, a product strategist and market researcher..." ✅ contains "agent-b"
- Session persistence: "Your name is TestBot." ✅ contains "testbot"

### Cross-System Isolation ✅
- Agent A says: "Agent A."
- Agent B says: "Agent B"
- Confirmed: completely separate agents with correct identities

## Architecture Validated

```
ESP32 → HTTP POST → [OpenClaw Gateway :18789] → Agent A (agent:agent-a:stackchan:device)
         OR
ESP32 → HTTP POST → [Hermes Gateway :8643] → Agent B (X-Hermes-Session-Key)
```

Both paths work. Both require Bearer auth. Both maintain sessions across requests. Both agents correctly identify themselves with strict validation.

## Previous False Positive (fixed)
- Initial test used loose keyword matching → Agent B test accepted "Maïs" (default profile) as valid
- Multiplex was OFF, so `/p/agent-b/` prefix was silently ignored → hit default profile
- Fix: Agent B now runs on dedicated port 8643 (Option B) with her own API_SERVER_KEY
- Fix: Tests now use STRICT identity validation (must contain "agent-a" / "agent-b")