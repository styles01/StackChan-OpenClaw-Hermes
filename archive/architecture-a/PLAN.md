# StackChan-OpenClaw-Hermes — Project Plan

## Two Work Streams

### A. Wake Word: "Hey Rosie" (firmware recompile)
### B. Make the robot actually route to Rosie (MCP integration depth)

---

## A. Wake Word Customization Plan

### How it works now
- The xiaozhi-esp32 firmware uses **ESP-SR** (Espressif Speech Recognition) for offline wake word detection
- Default wake word: "Hey XiaoZhi" (嗨小智) — baked into the ESP-SR wake word model
- Runs entirely on-device (no cloud round-trip for wake detection — that's why it's fast)
- After wake, audio streams to xiaozhi.me cloud for STT → LLM → TTS

### What we need to do
ESP-SR supports custom wake words. The firmware has a "Wake Word Customization" doc in their docs. The process:

1. **Set up ESP-IDF build environment** (v6.0.2 preferred)
   - Install ESP-IDF + VSCode plugin on a machine (this Mac or your laptop)
   - Clone `https://github.com/78/xiaozhi-esp32`
   - Configure for the M5Stack CoreS3 board (stackchan board profile)

2. **Generate a custom ESP-SR wake word model for "Hey Rosie"**
   - ESP-SR uses Espressif's wake word model format
   - Options:
     a. Use Espressif's online wake word generator (if available)
     b. Train a custom model using their ESP-SR toolkit
     c. Use a pre-trained multi-wake-word model that includes a slot we can map
   - The firmware docs page "Wake Word Customization & Configuration Steps" (d12 in their docs nav) has the exact process
   - May need to check the `esp-sr` repo: `https://github.com/espressif/esp-sr`

3. **Configure the firmware to use our custom wake word**
   - Modify the board config or menuconfig to point to our wake word model
   - The firmware already supports customizable wake words (confirmed in README: "Offline voice wake-up with ESP-SR, including customizable wake words")

4. **Compile and flash**
   - `idf.py build` → `idf.py flash`
   - Flash via USB (plug Stack-chan into the Mac)
   - The device reboots with "Hey Rosie" as the wake word

5. **Verify**
   - Say "Hey Rosie" → device transitions from Standby to Listening
   - Say "Hey Rosie, what's the printer status?" → Quick Wake mode (skips greeting, goes straight to processing)

### What we need from James
- Stack-chan plugged into USB on a machine with ESP-IDF installed
- We can do the build on Clawdio-Mini (macOS arm64) — ESP-IDF supports macOS
- OR James's laptop if that's easier

### Research still needed
- [ ] Read the exact "Wake Word Customization" doc from xiaozhi.me (page d12)
- [ ] Check if ESP-SR has a simple config option or requires full model training
- [ ] Check if there's a pre-built "Hey Rosie" wake word model or if we need to generate one
- [ ] Find the exact menuconfig/board-config settings for custom wake words
- [ ] Check the stackchan board profile in the firmware repo

### Estimated effort
- Environment setup: 1-2 hours (ESP-IDF install + build)
- Wake word model: 30 min - 2 hours (depends on whether we can use a generator or need to train)
- Compile + flash: 30 min
- Testing/debugging: 30 min
- **Total: 2-5 hours**

---

## B. MCP Integration Depth — Why the robot doesn't feel like Rosie

### Current state
- Our MCP server is connected to the xiaozhi.me broker
- We expose 7 tools (rosie_status, rosie_say, rosie_printer_status, etc.)
- The broker accepted our tools
- BUT: zero tool calls have come through

### Why it responds fast but doesn't use our tools
The xiaozhi.me cloud handles the full pipeline:
```
User speaks → device sends audio to xiaozhi cloud → cloud STT → cloud LLM (Qwen/DeepSeek) → cloud TTS → audio back to device
```
Our MCP tools are available to the cloud LLM, but:
1. The cloud LLM has its own system prompt (xiaozhi's, not Rosie's)
2. The LLM only calls MCP tools when the conversation context makes it relevant
3. If you just chat, it uses its own brain — our tools sit idle
4. The LLM needs to "know" that Rosie exists and what Rosie tools are for

### What we need to investigate
- [ ] Can we configure the agent's system prompt on xiaozhi.me console?
- [ ] Does the broker pass our tool descriptions to the cloud LLM?
- [ ] Can we make Rosie the primary "personality" instead of xiaozhi's default?
- [ ] Is there a way to route ALL conversations through our MCP server instead of xiaozhi's LLM?

### Option 1: Configure the xiaozhi agent prompt (simplest)
- Log into xiaozhi.me console
- Find the agent settings for our agentId (2253920)
- Set a system prompt like: "You are Rosie, a household operations director. When asked about household status, chores, printer, or schedule, use the rosie_* tools."
- This makes the cloud LLM aware of Rosie and more likely to call our tools

### Option 2: Self-host the xiaozhi server (full control)
- Run `xinnan-tech/xiaozhi-esp32-server` (Python) on this machine
- Point the device at our server instead of xiaozhi.me cloud
- We control the LLM, the system prompt, the TTS voice, everything
- The MCP broker becomes local too
- More work but full control — Rosie IS the brain, not a tool provider

### Option 3: Hybrid — xiaozhi cloud for STT/TTS, our server for LLM
- Keep xiaozhi cloud for audio pipeline (fast STT/TTS)
- But route the LLM step to our own model/server
- This would need investigation — may not be supported

### Recommendation
Try **Option 1 first** — check the xiaozhi.me console for agent prompt configuration. If we can set Rosie's personality as the system prompt, the cloud LLM will naturally route to our tools when household questions come up. That's the 80/20 solution.

If the console doesn't allow prompt customization, **Option 2** (self-host) is the real path. We'd run the full xiaozhi server stack locally with Rosie as the brain. More work but that's how we make Stack-chan truly a node of Rosie.

---

## Timeline

| Step | Task | Effort | Dependency |
|------|------|--------|------------|
| 1 | Research xiaozhi.me console agent settings | 30 min | James's login |
| 2 | Set Rosie system prompt on xiaozhi agent | 15 min | Step 1 |
| 3 | Test tool calls from the robot | 30 min | Step 2 |
| 4 | Research ESP-IDF wake word customization | 1 hour | — |
| 5 | Set up ESP-IDF build environment | 1-2 hours | — |
| 6 | Generate "Hey Rosie" wake word model | 30 min-2 hours | Step 4 |
| 7 | Compile + flash firmware | 30 min | Steps 5,6 |
| 8 | Test wake word | 15 min | Step 7 |
| 9 | (If needed) Self-host xiaozhi server | 4-8 hours | Step 3 fails |

## Next Actions
1. James: Can you log into xiaozhi.me console and check if there's a system prompt / agent personality setting? That's the quickest win.
2. I'll research the ESP-SR wake word model format and the firmware customization doc in parallel.
3. We need the Stack-chan plugged into USB on a machine for flashing — whenever you're ready for that step.