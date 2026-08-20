# SWARM 3 — GAMMA: Open Source Strategy & Dual-Robot Roadmap

**Reviewer:** Research Agent GAMMA (open source strategy)
**Date:** 2026-08-18 00:13 MDT
**Mandate:** Review the new thin-audio-client architecture from a stranger's perspective on GitHub. Is the open source story coherent? Does the dual-robot framing help or hurt? What would make this repo attractive to the Stack-chan community?

**Inputs:** BRIEF.md, BUILD_PLAN.md, TODO.md, swarm2-gamma-opensource-strategy.md, swarm2-synthesis.md, plaipin-repo-analysis.md

---

## EXECUTIVE VERDICT

**The thin audio client is a genuinely novel, genuinely attractive open source contribution — but the current framing buries it under a confusing dual-project story.** The "pilot for Larry" framing is a liability for community adoption. The repo name oversells Hermes. The licensing is unresolved. And the private-vs-public boundary for Larry is not yet drawn.

**The good news:** the core contribution (thin audio client, no API keys on device) is strong enough to stand on its own. The fix is reframing, not re-engineering. This report gives you the exact reframe.

---

## FINDING 1: The "pilot for Larry" framing is a LIABILITY for community adoption

**The problem.** The BRIEF's opening line is: *"Build a thin audio client pipeline for ESP32 robots — piloted on Stack-chan, designed for reuse on Larry the Elephant."* A stranger on GitHub reads this and thinks: *"This is a personal project for someone's kid's toy. Why should I care?"*

Larry is:
- A **toddler's plush elephant** (sound machine, nightlight, trumpet sounds)
- A **private family project** (James's kid)
- **Not a developer platform** — no community, no r/Larry, no GitHub stars

Stack-chan is:
- A **developer robot** (open source, 800+ stars, active community, r/StackChan)
- A **platform** people build on and share
- **The thing a stranger would search for and find**

**The risk.** When the README leads with "this is a pilot for my kids' toy," it signals *"this is a personal hack, not a project for you."* Contributors don't invest in personal hacks. The dual framing makes the repo feel smaller, not bigger.

**The fix — invert the framing.** Lead with the Stack-chan contribution. Larry becomes a *footnote*, not the headline:

> **Bad:** "This is a pilot for Larry the Elephant, my kid's toy."
> **Good:** "A thin audio client for Stack-chan — no API keys on the device. The ESP32 just records audio and plays back what your server sends. Works with any agent backend. (Also powers my kid's plush elephant, Larry.)"

The second version is a *platform pitch* with a charming personal detail. The first is a *personal project* with a platform bolted on. Same facts, opposite energy.

**Does the dual framing confuse contributors?** Yes, if it's the headline. No, if it's a "see also" note. The architecture genuinely supports two robots — that's a *feature* worth mentioning. But it should be framed as "the pipeline is robot-agnostic" (a technical strength) not "this is a pilot for my kid's toy" (a personal story).

**Recommendation:**
- README headline = "Thin audio client for Stack-chan" (platform-first)
- A short "Also powers Larry" section = personal charm, one paragraph
- The BRIEF can keep the Larry framing (it's an internal doc) but the README must be community-first

---

## FINDING 2: Rename the repo NOW — "StackChan-OpenClaw-Hermes" oversells what ships

**The problem.** The repo is named `StackChan-OpenClaw-Hermes`, but Hermes is deferred to v2. A stranger sees three nouns and asks:
- *Is this three separate things?*
- *Do I need both OpenClaw AND Hermes?*
- *Is Hermes required to use this?*

The name promises a feature (Hermes) that doesn't ship in v1. That's a trust problem — the first thing a contributor reads is a promise the repo doesn't keep.

**The counter-argument (keep the name):** "The architecture supports Hermes later, so the name is future-proof." This is weak. The architecture supporting Hermes is a *design property*, not a *shipped feature*. Nobody searches GitHub for "Hermes Stack-chan." Nobody is waiting for this repo because of the name.

**The counter-counter-argument (rename):** The swarm2 report already recommended `stackchan-openclaw`. I agree, with one refinement: since the thin audio client is gateway-agnostic (it just POSTs WAV and gets WAV back), the name could even be gateway-neutral.

**Name options, ranked:**
1. **`stackchan-thin-audio-client`** — describes the actual contribution. A stranger instantly knows what it is. Best for discoverability.
2. **`stackchan-openclaw`** — clear, matches plaipin's naming pattern, one gateway. Good if you want to signal the OpenClaw integration specifically.
3. **`stackchan-agent`** — gateway-agnostic, focuses on "this gives Stack-chan a brain." Playful, memorable.
4. **`StackChan-OpenClaw-Hermes`** — current. Confusing, oversells Hermes. **Reject.**

**Recommendation:** Rename to `stackchan-thin-audio-client` (or `stackchan-openclaw` if you want the OpenClaw signal). Do it NOW, before the repo has any stars or contributors. Renaming a repo with 0 stars is free. Renaming a repo with 50 stars and 3 contributors is a migration. The architecture supporting Hermes later is a *README sentence*, not a *repo name*.

---

## FINDING 3: "No API keys on the ESP32" is your STRONGEST selling point — lead with it

**This is the differentiator.** Every other Stack-chan fork requires the user to configure Google STT, OpenAI Whisper, ElevenLabs TTS, or Gemini API keys ON THE DEVICE. Plaipin's firmware needs an OpenAI key for STT. robot-bridge needs cloud credentials. The standard Stack-chan experience is "set up 3 API keys before your robot can talk."

**Ours doesn't.** The ESP32 has zero cloud credentials. It records audio, POSTs WAV to your server, plays back what comes back. The server holds all the keys.

**Why this matters to a stranger:**
1. **Security** — a device with no keys can't leak keys. If the robot is stolen, lost, or hacked, there's nothing to steal.
2. **Cost control** — all API usage is centralized on one server. No surprise bills from a device that went rogue.
3. **Simplicity** — setup is "point the robot at your server." No key provisioning, no key rotation, no key management on embedded hardware.
4. **Privacy** — the device never talks to a cloud provider directly. All audio goes to YOUR server. This is a real privacy story for a device with a microphone in your home.

**How to message it:**
- **README headline:** "Zero API keys on the device. The ESP32 is a dumb audio terminal — your server does all the thinking."
- **Comparison table** (this is gold for the README): a table showing Stack-chan stock / plaipin / robot-bridge / OURS, with a column "API keys on device: YES/YES/YES/**NO**."
- **Security section:** "The robot can't leak what it doesn't have. No cloud credentials, no API keys, no secrets on the ESP32. All audio routes through your server."

**The "dumb terminal" framing is the hook.** A stranger immediately understands the architecture from one sentence: *"The ESP32 is a dumb audio terminal. It records, sends, plays back. Your server does STT, LLM, TTS."* That's the whole pitch. Lead with it.

**Recommendation:** Make "no API keys on the device" the README's first line after the title. Add a comparison table. This is the reason someone forks this repo instead of plaipin's.

---

## FINDING 4: You're not a "fork" anymore — you're "original work inspired by plaipin." Reframe it.

**The licensing problem.** Plaipin has NO license file. Under copyright law, that means "all rights reserved" by default. You cannot legally redistribute plaipin's code without permission. The BRIEF says "add MIT license" — but you can't just add a license to code you don't own.

**The code problem.** You're deleting plaipin's STT classes (CloudSpeechClient, Whisper, ModuleLLMASR), TTS classes (WebVoiceVox, ElevenLabs, OpenAITTS, AquesTalk), and LLM classes (ChatGPT, Gemini, OpenClawClient, ModuleLLM). That's the bulk of plaipin's *new* code. What you keep is:
- The **body code** (face, servo, camera, LED, touch, MainLoop) — which plaipin itself forked from Stack-chan (MIT licensed)
- The **config structure** and **platformio.ini** — modified
- The **partition table** — modified

**At what point does this stop being a fork?** When you delete the STT/TTS/LLM pipeline (the thing that makes plaipin "plaipin") and replace it with your own ThinAudioClient, you're no longer distributing plaipin's *distinctive* work. You're distributing Stack-chan's body code (MIT) plus your own new client code (yours to license).

**The reframe:**
- **Don't call it a "fork of plaipin."** Call it **"based on Stack-chan (MIT), with the thin audio client pattern inspired by plaipin's OpenClaw integration."**
- **Fork from Stack-chan directly**, not from plaipin. Stack-chan is MIT-licensed — clean. Port the *concept* of plaipin's OpenClaw integration (the REST proxy pattern) as reference, but write your own code.
- **This is legally cleaner AND more honest.** You're not redistributing plaipin's unlicensed code. You're building on Stack-chan (MIT) and crediting plaipin as inspiration.

**The attribution question.** Even if you don't copy plaipin's code, you should credit them in the README: *"The thin audio client pattern is inspired by PlaiPin's OpenClaw integration for Stack-chan."* This is good open source citizenship AND it protects you — if there's any ambiguity about what you borrowed, explicit attribution covers you.

**Recommendation:**
1. Fork from **Stack-chan** (MIT), not plaipin (no license).
2. Port plaipin's *concepts* (REST proxy, emoji stripping, partition table) as reference, write your own code.
3. Add MIT license to YOUR code.
4. Credit plaipin in the README as inspiration.
5. **Reframe the repo as "original work inspired by plaipin," not "a fork of plaipin."**

---

## FINDING 5: Larry's personality and memory are PRIVATE — keep them out of the repo entirely

**The boundary is clear, and the BRIEF already hints at it.** Larry's HEART.md (personality) and MEMORY.md (child facts) are private family data. They should NEVER be in the open source repo. This isn't just privacy — it's also *scope*. A stranger doesn't want your kid's elephant's personality in the repo. It's noise.

**What's public (goes in the repo):**
- The **audio pipeline server** (STT → LLM → TTS → WAV back)
- The **thin audio client firmware** (ESP32 records, sends, plays)
- The **body command parser** (`[expression:happy]` → face/servo/LED)
- The **agent configuration template** (system prompt *format*, not the actual personality)
- **Documentation** (README, architecture, setup guide)

**What's private (stays out of the repo):**
- Larry's **HEART.md** (personality)
- Larry's **MEMORY.md** (child facts, family details)
- Agent A's **actual system prompt** (if it contains household specifics)
- Any **API keys, server IPs, or credentials**

**The clean architecture — "shared pipeline, private personalities":**

```
PUBLIC REPO (stackchan-thin-audio-client)
├── firmware/          # Thin audio client (ESP32)
├── server/           # Audio pipeline server (STT→LLM→TTS)
├── docs/             # README, architecture, setup
└── config/
    └── agent-template.md   # SYSTEM PROMPT FORMAT (not the actual prompt)
                            # Shows: "here's how to write a robot personality"
                            # NOT: "here's Larry's personality"

PRIVATE (NOT in repo — James's machine / private config)
├── larry/HEART.md    # Larry's personality (private)
├── larry/MEMORY.md   # Larry's child facts (private)
└── agent-a/system-prompt.md  # Agent A's actual prompt (private)
```

**The key insight:** the repo ships a **template** for robot personalities, not the personalities themselves. A stranger clones the repo, writes their own system prompt, and their robot has its own personality. This is BETTER for the community — it's a framework, not a one-off.

**Recommendation:**
- Ship `agent-template.md` showing the system prompt *format* (personality section, body command format, response length rules) with placeholder text.
- Keep Larry's and Agent A's actual prompts in a private location (James's machine, or a private submodule).
- The README should say: *"Bring your own personality. The repo includes a system prompt template — write your robot's character and go."*

---

## FINDING 6: Architecture — "shared pipeline, private personalities" is a MONOREPO with a private config layer

**The question:** Should Larry ESP32 be a separate repo, a monorepo with private configs, or something else?

**The answer: a single public monorepo for the pipeline, with private configs kept OUT of the repo entirely.**

**Why not a separate repo for Larry?** Larry shares 100% of the pipeline (server, firmware, body command parser). A separate repo would duplicate all of it. Two repos = two READMEs, two issue trackers, two places to update the shared code. Bad.

**Why not a monorepo with private configs committed?** Because private configs in a public repo is a leak waiting to happen. One bad commit and Larry's HEART.md is public forever. Git history doesn't forget.

**The clean architecture:**

```
PUBLIC REPO: stackchan-thin-audio-client
  The pipeline. Robot-agnostic. No personalities, no secrets.
  ├── firmware/   # Thin audio client (works for ANY robot body)
  ├── server/     # Audio pipeline server (works for ANY agent)
  ├── docs/       # README, architecture, setup
  └── config/agent-template.md  # Personality FORMAT, not content

PRIVATE (James's machine, NOT in the repo):
  ├── larry/HEART.md + MEMORY.md   # Larry's personality + facts
  ├── agent-a/system-prompt.md       # Agent A's actual prompt
  └── .env / secrets               # API keys, server IPs
```

**How the two connect:** The public repo's server reads a config file (e.g., `config.json` or env vars) that specifies *which agent session to talk to*. James's private config points the server at the "larry" agent session. A stranger's config points it at their own agent. Same code, different personality, zero private data in the repo.

**The "bring your own personality" pattern is the cleanest possible architecture for this.** It's how every good open source project handles user-specific config: ship the framework, let users supply their own content. It's also the most community-friendly — a stranger can use the repo without any Larry baggage.

**Recommendation:**
- **One public monorepo** for the pipeline (firmware + server + docs + agent template).
- **Private configs live outside the repo** (James's machine, or a private git repo / submodule).
- The server reads a config file that selects the agent session — this is the seam between public pipeline and private personality.
- Document this seam clearly: *"Point the server at your agent session. The repo is robot-agnostic."*

---

## FINDING 7: The thin audio client IS the main contribution — emphasize it as the headline

**Why this is novel.** No other Stack-chan fork does this. Let me be precise about what's actually new:

| Approach | Who does it | What the ESP32 does |
|----------|-------------|---------------------|
| Stock Stack-chan | mongonta0716 | STT on-device (needs Google/OpenAI key), LLM via API, TTS on-device |
| Plaipin | PlaiPin | STT on-device (OpenAI key), LLM via proxy, TTS on-device |
| robot-bridge | waynecc-at | Thick client — WebRTC, MCP, lots of on-device logic |
| **Ours** | **You** | **Records audio, POSTs WAV, plays back WAV. That's it.** |

**The thin client is a genuinely different design philosophy.** Every other fork pushes intelligence onto the device (STT, TTS, wake word, local LLM). Ours pushes ALL intelligence to the server and keeps the device dumb. This is:
- **Easier to maintain** (~300-400 LOC firmware vs ~2000 LOC of STT/TTS/LLM pipeline)
- **Easier to upgrade** (improve the server, robot gets smarter — no firmware reflash)
- **More secure** (no keys on device)
- **More flexible** (swap the agent backend without touching firmware)

**This is the contribution.** Not "Stack-chan + OpenClaw" (plaipin did that). Not "Stack-chan + Hermes" (nobody asked). The contribution is **"a thin audio client pattern for ESP32 robots"** — a reusable architecture that happens to be demonstrated on Stack-chan.

**How to emphasize it:**
- **README title:** "Thin Audio Client for ESP32 Robots" (not "Stack-chan + OpenClaw")
- **README first paragraph:** "The ESP32 is a dumb audio terminal. It records, sends, plays back. Your server does STT, LLM, TTS. No API keys on the device. Works with any agent backend."
- **Architecture diagram** at the top (the BRIEF's diagram is excellent — put it in the README)
- **"Why thin?" section:** the 4 bullets above (maintainable, upgradeable, secure, flexible)
- **Comparison table** vs other Stack-chan forks

**Recommendation:** Make the thin audio client the headline. Stack-chan is the *demonstration platform*, not the *contribution*. The contribution is the pattern. This is what makes the repo attractive to the community — it's a new way to build a robot brain, not just another Stack-chan mod.

---

## FINDING 8: The gateway-tools-to-robot-actions story is CLEAR and is a strong demo — but it needs to be spelled out

**The question:** Is there a story for how gateway tools map to robot actions? E.g., "Agent A, check the printer" → gateway calls printer tool → result spoken through robot. Is this clear to a newcomer?

**The story is clear, but it's not written down anywhere.** The BRIEF mentions tools ("household, printer, fridge, memory, Telegram") and the TODO lists them, but neither explains the *flow* to a newcomer. This is a missed opportunity — it's the most compelling demo the project has.

**The flow (spell this out in the README):**

```
"Hey Agent A, what's the printer status?"
        │
        ▼
ESP32 records audio → POSTs WAV to server
        │
        ▼
Server: STT → "what's the printer status?" → sends to OpenClaw Gateway
        │
        ▼
Gateway: Agent A agent → calls agent-a_printer_status tool → gets result
        │
        ▼
Gateway: Agent A forms response + body commands → returns to server
        │
        ▼
Server: TTS → WAV + body commands JSON → returns to ESP32
        │
        ▼
ESP32: plays WAV ("The printer is 40% done with the benchy") 
       + drives face/servo/LED (looks at you, LED turns blue)
```

**This is the "wow" moment.** A stranger sees a robot that can *do things* — check the printer, look at the fridge, remember things — not just chat. This is what separates a "toy that talks" from a "robot that works."

**Why it's clear (and why it's not yet):**
- **Clear:** the architecture naturally supports it. The gateway has tools; the robot is an audio I/O device; the server connects them. The flow is obvious once you see the diagram.
- **Not yet clear:** nobody has written the flow down. The README doesn't exist yet. The BRIEF is internal. A newcomer has to reverse-engineer the architecture from the docs.

**Recommendation:**
- Add a **"What can it do?"** section to the README with 2-3 concrete examples (printer status, fridge check, "what do you see?" camera vision).
- Include the **flow diagram** above (or the BRIEF's diagram) showing the full round-trip.
- Add a **"Tools" section** explaining that the robot is an audio I/O device for the agent's tools — the agent does the thinking, the robot does the talking.
- This is the demo that gets people to fork the repo. Lead with it.

---

## STRANGER'S-EYE VIEW: What a newcomer sees on GitHub

Let me walk through the repo as a stranger would, with the current framing vs. the recommended framing.

### Current framing (as written in BRIEF/BUILD_PLAN):
1. **Repo name:** `StackChan-OpenClaw-Hermes` — "Do I need all three? Is Hermes required?"
2. **README (hypothetical):** "A pilot for Larry the Elephant, my kid's toy." — "This is a personal project. Not for me."
3. **License:** none mentioned — "Can I even use this?"
4. **What it does:** buried under the Larry story — "I don't get it. Is this a Stack-chan mod or a new robot?"
5. **Why it's different:** not stated — "Why this over plaipin's repo?"

**Result:** the stranger closes the tab. Too confusing, too personal, too unclear.

### Recommended framing:
1. **Repo name:** `stackchan-thin-audio-client` — "A thin audio client for Stack-chan. I know what this is."
2. **README first line:** "The ESP32 is a dumb audio terminal. It records, sends, plays back. Your server does STT, LLM, TTS. No API keys on the device." — "Oh, that's clever. And no API keys? That's better than every other fork."
3. **License:** MIT, clearly stated — "I can use this."
4. **What it does:** architecture diagram + "What can it do?" examples (printer status, fridge, camera vision) — "This robot can DO things. I want to try this."
5. **Why it's different:** comparison table vs other forks (thin client, no keys, server-side intelligence) — "This is a new approach. I'll fork it."

**Result:** the stranger forks the repo, flashes their Stack-chan, and posts to r/StackChan. That's the goal.

---

## SUMMARY TABLE

| # | Question | Verdict | Recommendation |
|---|----------|---------|----------------|
| 1 | "Pilot for Larry" framing | **Liability** | Invert: lead with Stack-chan platform, Larry as a charming footnote |
| 2 | Repo name "StackChan-OpenClaw-Hermes" | **Confusing, oversells Hermes** | Rename to `stackchan-thin-audio-client` (or `stackchan-openclaw`) NOW, before stars |
| 3 | "No API keys on ESP32" | **Strongest selling point** | Lead with it. Add comparison table vs other forks. "Dumb terminal" framing. |
| 4 | Fork vs original work | **Not a fork anymore** | Fork from Stack-chan (MIT), port plaipin concepts as reference, credit plaipin, add MIT |
| 5 | Larry's private data | **Keep out of repo** | Ship `agent-template.md` (format), keep HEART/MEMORY private |
| 6 | Repo architecture | **Single public monorepo** | Public pipeline + private configs outside repo. "Bring your own personality." |
| 7 | Thin audio client as contribution | **Yes, it's the headline** | Make it the README title. It's a new pattern, not just a Stack-chan mod. |
| 8 | Gateway tools → robot actions | **Clear but unwritten** | Add "What can it do?" section + flow diagram. This is the demo that sells it. |

---

## CONCRETE NEXT STEPS (for the README, before pushing)

1. **Rename the repo** to `stackchan-thin-audio-client` (or `stackchan-openclaw`). Do it before any stars.
2. **Write the README with this structure:**
   - Title: "Thin Audio Client for ESP32 Robots"
   - First line: "The ESP32 is a dumb audio terminal. No API keys on the device."
   - Architecture diagram (from BRIEF)
   - "What can it do?" — 3 concrete examples (printer, fridge, camera)
   - Comparison table vs other Stack-chan forks
   - "Bring your own personality" — agent template, not Larry's actual prompt
   - "Also powers Larry" — one charming paragraph, not the headline
   - License: MIT, clearly stated
   - Credits: Stack-chan (MIT), plaipin (inspiration)
3. **Resolve the license** — fork from Stack-chan (MIT), not plaipin (no license). Add MIT to your code. Credit plaipin.
4. **Draw the public/private boundary** — ship the pipeline + agent template; keep Larry's HEART/MEMORY and Agent A's prompt private.
5. **Add the gateway-tools flow diagram** — this is the demo that gets people to fork.

---

## BOTTOM LINE

**The thin audio client is a real, novel, attractive open source contribution.** It's simpler, more secure, and more flexible than every other Stack-chan fork. The problem is purely framing: the "pilot for Larry" story buries the platform pitch, the repo name oversells Hermes, the license is unresolved, and the private/public boundary isn't drawn.

**Fix the framing, not the engineering.** Lead with the platform, keep Larry as a footnote, rename the repo, resolve the license, and ship the "bring your own personality" pattern. A stranger on GitHub will then understand what this is, why it exists, and how to use it — and will fork it.
