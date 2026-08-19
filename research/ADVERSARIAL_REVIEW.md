# Adversarial Review — MERGE_PLAN.md (Dual-Backend OpenClaw/Hermes)

**Reviewer:** Hailey (adversarial subagent)
**Date:** 2026-08-18
**Document reviewed:** `/Volumes/1TBSSDClawd/stackchan-node/research/MERGE_PLAN.md` (DRAFT)
**Corroborating docs:** hermes-stackchan-analysis.md (dex), xiaozhi-esp32-analysis.md (ernest), existing-work-analysis.md (gordon)
**Method:** Static review + **live verification against the running OpenClaw gateway (127.0.0.1:18789) and the actual ai-server source** in `repos/working-repos/Hermes-StackChan/ai-server/src/`.

---

## Executive Summary

The plan's **core seam is correct**: ai-server's `HermesSessionClient` interface (session.ts:322-325) is real, the LLM/STT/TTS split is real (session.ts:380-433), and the OpenClaw `/v1/chat/completions` + header convention works against the live gateway (I verified: 401 without key, 200 with `Bearer clawdiomax`, session-key persistence across turns, and SSE `delta.content`/`[DONE]` streaming). The plan is **not ready to build**. It has **two hard blockers** (v2 sequencing impossible as written; multi-robot control plane is a global singleton), one **unvalidated load-bearing assumption** (STT/TTS independence from HermesAgent), and it **amplifies a pre-existing security hole** (unauthenticated device→ai-server channel that now maps directly to an OpenClaw agent's workspace/memory). Verdict at the end.

---

## Critical Issues (must fix before building)

### C1. v2 per-device backend selection is unimplementable as written (sequencing bug)

**Plan §2.2:** "Constructor reads `backend` from device `hello` message OR `STACKCHAN_BACKEND` env" and routes `process()` accordingly.

**Reality (verified in code):** `server.ts` creates `new Session(ws)` with **no deps** (server.ts:37). The `Session` constructor runs *before* any `hello` arrives and sets `this.hermes` **once**, as a `readonly` field (session.ts:380 `private readonly hermes`, session.ts:427 `this.hermes = deps.hermes ?? new HermesClient()`). The `hello` message is only parsed later inside `handleJson` (session.ts:773-786), which currently reads only `type` and `version` and ignores all other fields.

**Consequence:** "read `backend` from the hello message" cannot work without either (a) making `this.hermes` non-readonly and hot-swapping it after hello, or (b) deferring client construction until the first `process()`/`submitPrompt` call, or (c) having `server.ts` peek the hello before constructing the Session. None of these are in the plan. As written, **v2 (§5, step 2-4) cannot be built** — the "profile binding" feature (the stated goal of the whole exercise, §0) is not just hard, it's architecturally contradicted by the current construction order.

### C2. The control plane is a global singleton — multi-robot profile binding is impossible with current design

**Plan §2.7 / §5-v2:** Robots A/B/C bound to different backends/agents "on the same ai-server."

**Reality (verified):** `device_control.ts` tracks a **single** `let activeSession: StackChanDeviceSession | null` (device_control.ts:55). `/internal/followup` (device_control.ts:273) and `/tools/call` (device_control.ts:179-229) both route to whichever device registered last (`registerDeviceSession`, device_control.ts:232-235, called from every `Session` constructor at session.ts:453). `stackchan_mcp_server.ts` delivers subagent results via `/internal/followup` → the **currently-active** session.

**Consequence:** With robots A/B/C all connected, robot A's LLM (OpenClaw/rosie) calling `stackchan_set_led_color` or a subagent followup will execute against **robot B or C**, whichever is currently `activeSession`. The plan's multi-robot fleet scenario (§2.7) is **not achievable** unless the control plane (MCP `TOOL_MAP`, `/tools/call`, `/internal/followup`, and `stackchan_mcp_server.ts`) is made device-addressed (e.g. keyed by device/session id in the request body or header). This is a **whole subsystem** the plan omits. Also: `stackchan_mcp_server.ts` is a **stdio** MCP server with a single device connection assumption — there is no per-device addressing anywhere in the MCP chain.

### C3. "Zero / minimal firmware changes" + profile binding is a contradiction the plan papers over

**Plan §0 & §2.5:** "firmware needs zero or minimal changes," yet §2.5 lists four firmware files to touch (config.sample.json, sd_config.cpp, hal_bridge hello, app_ai_agent.cpp) for the `backend` field, and §2.7 / Risk 5 admits per-device binding **requires** the firmware hello extension (v2).

**Reality:** C1 shows even with the firmware hello extension, the ai-server can't act on it at construction time. So the "zero firmware changes" claim only holds for **v1 global backend** (env-only), which is exactly the case the plan itself admits (Risk 5) is not the real goal. The headline claim (§0, "zero or minimal changes") is marketing, not engineering. The real cost is: firmware hello extension **and** an ai-server sequencing change **and** a control-plane addressing change. That is not "minimal."

### C4. STT/TTS "standalone, don't require HermesAgent" is unvalidated and load-bearing

**Plan Risk 2 (line ~§4):** "they're standalone, don't require HermesAgent running."

**Reality (verified):** `transcribeWithHermes` (hermes_audio.ts:127-150) spawns `python3 -c 'from tools.transcription_tools import transcribe_audio'` and `synthesizeWithHermes` (hermes_audio.ts:172-197) spawns `python3 -c 'from tools.tts_tool import text_to_speech_tool'`, both with `cwd=hermesRoot()` = `HERMES_ROOT` (default `../hermes-agent`). These are **Python modules from the hermes-agent repo**. dex's own analysis states the hermes-agent submodule is "currently empty/not checked out." The fallback (`HERMES_STT_URL` / `STACKCHAN_LOCAL_TTS_URL` / `STACKCHAN_LOCAL_ONLY`) exists but the plan never states it as a requirement or verifies either path works. TTS also silently depends on **`ffmpeg`** for non-WAV output (hermes_audio.ts:192).

**Consequence:** If OpenClaw is the whole point, and the voice loop silently dies unless a hermes-agent checkout + Python deps + a configured STT model + a TTS engine (+ `ffmpeg`) are all present, then "OpenClaw as a second backend" is really "OpenClaw as a second *brain* on top of a Hermes voice stack." That may be fine — but the plan must **state it, verify it, and test it**, not assert it. A robot that connects to OpenClaw and can't hear or speak because hermes-agent isn't set up is a broken v1 demo.

---

## Important Issues (should fix or explicitly accept risk)

### I1. `interrupt()` for OpenClaw is hand-waved, and barge-in correctness is unproven

**Plan Risk 4 / §2.1:** "`interrupt()` → no-op ... or `AbortController`."

**Reality:** `handleBargeIn` (session.ts:659-677) calls `this.hermes.interrupt()` fire-and-forget then immediately `startListening('barge-in')` and begins capturing the next utterance. `speakHermesReplyStreaming` (session.ts:1038) runs `for await (const event of streamPrompt(...))` and checks `if (this.state !== 'processing') break` per event. If `OpenClawClient.interrupt()` aborts the fetch, the `for await` will **throw** (AbortError/TypeError). The streaming function's `try` has a `finally` that clears the keepalive (session.ts:1069+), but I could not find a catch that treats abort-during-barge-in as *normal* rather than an error. If it propagates as an unhandled rejection or error-bubble, barge-in becomes a UX regression (robot speaks error bubbles instead of listening). The plan gives no abort semantics for the streaming generator. This must be designed and tested, not accepted on a guess.

### I2. OpenClaw's SSE is chunk-coarse — the "low-latency voice loop" claim is weak

**Plan Risk 1:** mitigation "Use SSE streaming... TTS pipeline already buffers sentence-by-sentence."

**Reality (live test):** a 5-item list came back as **one `delta.content` chunk** ("1\n2\n3\n4\n5"), not per-sentence. OpenClaw buffers and emits large deltas. The streaming path's low-latency benefit depends on `stableSpeechSegmentsFromPartialReply` finding stable sentence boundaries (session.ts:1042). With coarse deltas, the device gets the whole reply at once — latency ≈ the non-streaming case. So SSE buys little for v1. **Accept as-is**, but stop claiming low-latency voice as the mitigation until sentence-fragment streaming is proven from the gateway.

### I3. Unauthenticated device→ai-server channel now escalates to agent workspace/memory access

**Reality (verified):** the WS server binds `0.0.0.0` (server.ts:53 `server.listen(port, '0.0.0.0')`) with **no token/authorization check** on the `/ws` channel (grep of server.ts: no auth). Control port 8766 binds 127.0.0.1 by default (device_control.ts:239) — good — but the device WS channel is open to the LAN. Today that buys a spoofed `hello` and audio injection. **With OpenClaw**, the `x-openclaw-session-key` header the plan forwards (Risk 3 / §2.1) directly selects which agent's workspace/memory a caller can reach (verified: `agent:rosie:stackchan:*` gave Rosie full access). **Any LAN device can spoof `agent:rosie:stackchan:evil` and read/write Rosie's workspace** — the plan's Risk 3 dismisses this ("This is fine") without noting the ai-server adds no per-device trust. Pre-existing gap, but the port **amplifies its blast radius**. At minimum: ai-server must generate/authorize the device's session-key suffix server-side rather than trusting whatever the device sends, or restrict the WS to a trusted interface.

### I4. Session-key format / identity conflation — device_id source is unspecified

**Plan §2.7:** session keys `agent:rosie:stackchan:robot-a` etc. The `${device_id}` is the distinguishing part. gordon's analysis says plaipin derived it from MAC (`sc-<6-hex-mac>`, stored in NVS namespace `stackchan`). The Hermes-StackChan firmware has a different identity story. The plan never says **where** ai-server gets the stable device id for the session key. If it's the raw device-supplied string, see I3 (spoofable). If it's the WebSocket MAC header or `Device-Id`, that must be stated. Unspecified identity = spoofable identity = C3/I3 territory.

### I5. `stackchan_ask_hermes_subagent` / `ask_openclaw` tool assumes single active device (ties to C2)

**Plan §2.6:** "Add `stackchan_ask_openclaw_subagent` tool mirroring `stackchan_ask_hermes_subagent`." The existing subagent tool delivers via `/internal/followup` → `activeSession`. In a fleet this misroutes (see C2). The plan treats the tool as trivially additive; it is not, until the control plane is device-addressed.

### I6. v1 (global backend) validates almost nothing — it is a partial throwaway

**Plan §5-v1:** "global backend, no firmware changes." This tests only: OpenClawClient works for one device + Hermes regression. It does **not** exercise profile binding (the goal), the firmware hello extension, per-device routing, or multi-robot control. It's a useful smoke test, but the plan oversells it ("Ship Now"). The risky, novel work — sequencing (C1) and control-plane addressing (C2) — is all in v2 and entirely unvalidated by v1. **Do v1 as a spike, but don't present it as progress toward the stated goal.**

---

## Minor Issues (nice to fix)

### M1. Env var naming drift
Plan uses `STACKCHAN_BACKEND`, `OPENCLAW_HOST/PORT/AGENT_ID/MODEL/API_KEY`. dex's analysis proposed `OPENCLAW_CONNECT_MODE` (cli|gateway_ws|disabled). gordon's mapping uses `OPENCLAW_*` too. Pick one naming contract and the connect-mode enum before writing code; the plan silently drops dex's `OPENCLAW_CONNECT_MODE` and the stdio-transport option entirely (see Q2). Also `STACKCHAN_BACKEND=openclaw|hermes` as a string vs plaipin's integer `backend` (0/1) — the web-config.html port must be reconciled.

### M2. `.env.example` shows `OPENCLAW_API_KEY` blank with comment "# Gateway password"
Fine for a sample, but the gateway password is a **secret shared by all OpenClaw-backed robots** (Risk 3). Document rotation + that it's the *same* credential as OpenClaw's global auth, not a per-robot key. Also note the test harness hardcodes `Bearer clawdiomax` (e2e_test_harness.py:25) — that's a live secret in a committed file; the port should not copy that pattern.

### M3. "Strip emoji/markdown" reuse claim
Plan §2.1 says "reuse existing `stripMediaForSpeech` / `limitStackChanSpeechText`." These exist in session.ts and are fine, but the plan also inherits plaipin's `stripEmoji` behavior differences (gordon's R4 note). Specify which stripper OpenClaw uses and test emoji/markdown/CJK edge cases once, in TS.

### M4. Build checklist omits the control-plane work
Even the v2 checklist (§3) lists firmware + openclaw.ts + session.ts but **never lists the C2 control-plane device-addressing work** or the C1 sequencing change. The checklist is therefore incomplete for the stated v2 goal.

### M5. Warmup
Plan §2.3 says "skip OpenClaw warmup — doesn't need warming." Verify: Hermes warmup exists because Hermes stdio spawn is slow (index.ts:28-58). OpenClaw HTTP first-call latency is low, so skipping is probably right — but a cold model load on first spoken turn could add seconds. Cheap to warm with a 1-token ping. Consider it.

### M6. No error-bubble for OpenClaw auth failure in firmware
Plan §2.5 adds "OPENCLAW endpoint error" bubbles but doesn't specify that an OpenClaw 401 (bad gateway password) yields a *distinct, actionable* message vs a generic network failure. Given the shared-secret model, auth failures are likely; make them diagnosable.

---

## Questions (need clarification)

1. **Q1 — Sequencing:** Given C1, will ai-server construct the client lazily (first prompt) or hot-swap `this.hermes` after hello? The plan must pick one and update session.ts accordingly. Which is intended?

2. **Q2 — Transport:** dex proposed three OpenClaw transports (CLI one-shot, persistent stdio JSON-RPC, gateway WS). The plan commits to **only** HTTP `/v1/chat/completions`. Is the persistent-stdio/gateway-WS option rejected because it's not needed (gateway HTTP already has streaming), or just dropped? If the gateway ever moves off OpenAI-compatible HTTP, the plan's whole client is fragile. Confirm the gateway HTTP surface is a supported, stable contract.

3. **Q3 — STT/TTS:** Is a hermes-agent checkout + Python deps a hard prerequisite for v1? Will you verify `transcribe_audio`/`text_to_speech_tool` run standalone, or will you route STT/TTS to the local HTTP endpoints (`HERMES_STT_URL`/`STACKCHAN_LOCAL_TTS_URL`)? Is `ffmpeg` available on the host? (C4)

4. **Q4 — Multi-device control:** For v2, is device-addressed MCP (`/tools/call` keyed by device, per-device followup) in scope? Or is v2 explicitly single-robot and the fleet table (§2.7) aspirational? This is the single biggest scope question. (C2)

5. **Q5 — Device identity/auth:** Where does the stable device id come from, and does the ai-server trust the device-supplied value? Will any device→ai-server authentication be added before OpenClaw exposes agent workspace/memory to the LAN? (I3/I4)

6. **Q6 — Barge-in:** What is the specified abort semantics for the OpenClaw streaming generator — throw-and-catch-in-streaming-loop, or a separate "generation cancelled" signal? Is abort-on-barge-in tested as a normal path, not an error? (I1)

7. **Q7 — v1 acceptance:** Is v1 (global backend, single robot) considered "done," or must v1 already prove profile binding? If the latter, C1/C2 are not deferrable.

---

## Verdict

**NOT READY TO BUILD.**

The integration seam, the interface, and the OpenClaw HTTP/SSE contract are all **real and validated** (I confirmed them against the live gateway and source). But the plan:

- **Cannot deliver its headline feature** (per-robot profile binding, §0/§2.7) because (a) the Session is constructed before the hello that would select the backend (C1) and (b) the control plane is a single global `activeSession`, so multi-robot MCP/followup misroutes (C2). Both are architectural, not cosmetic.
- **Asserted, not verified,** that STT/TTS run without HermesAgent (C4) — the voice loop's lynchpin.
- **Escalates an existing unauthenticated device channel** into direct, spoofable access to OpenClaw agent workspaces/memory (I3) without any mitigation.
- Has a **v1 that validates little** of the actual risk (I6) and a **checklist that omits the two hard problems** (M4).

**Recommended path:** Before building, resolve Q1/Q2/Q4 (sequencing + control-plane addressing + multi-robot scope) in a revised plan; verify C4 (STT/TTS standalone) with a 10-minute test; and state a device-auth posture for the OpenClaw session-key surface. Then build v1 as a single-robot smoke test only after those are answered. Do **not** flash firmware (§3 "Do NOT flash") until the sequencing and control-plane designs are settled.
