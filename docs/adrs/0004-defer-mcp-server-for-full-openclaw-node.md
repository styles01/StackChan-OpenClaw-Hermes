# ADR-004: Defer xiaozhi.me MCP server approach in favor of full OpenClaw node

## Status
Accepted

## Date
2026-08-17

## Context
The initial integration approach was to connect Stack-chan to Agent A via the xiaozhi.me MCP broker:
- Stack-chan connects to xiaozhi.me cloud (as it does by default)
- xiaozhi.me broker connects to our MCP server (`server.py`)
- Our MCP server exposes Agent A tools (agent-a_status, agent-a_say, agent-a_printer_status, etc.)
- The xiaozhi cloud LLM calls our tools when relevant

This works but has fundamental limitations:
- The xiaozhi cloud LLM is the brain, not Agent A — our tools are optional add-ons
- We can't control the system prompt from our MCP server (only from the app UI)
- Audio goes to xiaozhi's STT/TTS, not through our Gateway
- The robot's personality is xiaozhi's default, not Agent A's
- Tool calls only happen when the cloud LLM decides they're relevant

The full OpenClaw node approach (ADR-001) solves all of this:
- Stack-chan connects directly to our OpenClaw Gateway
- Agent A IS the brain — her system prompt, her tools, her personality
- Audio pipeline runs through our Gateway (STT → Agent A LLM → TTS)
- The robot is genuinely a node of Agent A, not a xiaozhi device with Agent A tools bolted on

## Decision
Pursue the full OpenClaw node approach (esp-openclaw-node firmware) as the primary path. Keep the MCP server prototype running as a fallback/interim solution while the firmware is in development.

## Consequences
- `server.py` (MCP server) remains as an interim solution — it works, just isn't the real vision
- The xiaozhi.me system prompt (if James set it) helps in the interim but is not the long-term plan
- Full OpenClaw node is more work (~1 week) but delivers the actual goal
- If the firmware approach hits blockers, the MCP server is still there as fallback