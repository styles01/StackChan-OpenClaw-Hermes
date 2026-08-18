# Agent Binding Validation Results
**Date: 2026-08-18 13:49 MDT**
**All 10 tests PASSED ✅ (strict validation)**

## Test Results

### Unit Tests (no network) ✅
- OpenClaw header construction: session key, channel, auth all correct
- Hermes header construction: session key, auth correct
- Session key structure validation: 6/6 cases (agent-prefixed valid, bare keys invalid)
- Hermes dedicated port URL construction: no `/p/` prefix needed

### OpenClaw / Rosie ✅
- Auth rejection: 401 without token, 401 with invalid token
- Models endpoint: 17 agents listed including `openclaw/rosie`
- **Identity validation (STRICT):** "I'm Rosie, your household operations director..." ✅ contains "rosie"
- Session persistence: "Your name is TestBot." ✅ contains "testbot"

### Hermes / Venus (dedicated port 8643, Option B) ✅
- Auth rejection: 401 without token, 401 with invalid token
- Models endpoint: lists `venus`
- **Identity validation (STRICT):** "I'm Venus, a product strategist and market researcher..." ✅ contains "venus"
- Session persistence: "Your name is TestBot." ✅ contains "testbot"

### Cross-System Isolation ✅
- Rosie says: "Rosie."
- Venus says: "Venus"
- Confirmed: completely separate agents with correct identities

## Architecture Validated

```
ESP32 → HTTP POST → [OpenClaw Gateway :18789] → Rosie (agent:rosie:stackchan:device)
         OR
ESP32 → HTTP POST → [Hermes Gateway :8643] → Venus (X-Hermes-Session-Key)
```

Both paths work. Both require Bearer auth. Both maintain sessions across requests. Both agents correctly identify themselves with strict validation.

## Previous False Positive (fixed)
- Initial test used loose keyword matching → Venus test accepted "Maïs" (default profile) as valid
- Multiplex was OFF, so `/p/venus/` prefix was silently ignored → hit default profile
- Fix: Venus now runs on dedicated port 8643 (Option B) with her own API_SERVER_KEY
- Fix: Tests now use STRICT identity validation (must contain "rosie" / "venus")