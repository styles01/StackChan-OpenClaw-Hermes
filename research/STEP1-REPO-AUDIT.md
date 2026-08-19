# STEP 1 — Repo Audit: stackchan-node

**Audit date:** 2026-08-19
**Repo:** `/Volumes/1TBSSDClawd/stackchan-node` (GitHub: `styles01/StackChan-OpenClaw-Hermes`)
**Branch:** `main`

---

## Git State

**Repo status:** Clean working tree for tracked files, but **ahead of origin by 1 commit** (not pushed), with **1 modified tracked file** and a **large set of untracked docs/analysis files**.

```
On branch main
Your branch is ahead of 'origin/main' by 1 commit.

Changes not staged:
  modified:   test-harness/web-config.html

Untracked:
  FLASHING-GUIDE.md, RECOVERY-LOG.md
  analysis-official-stackchan.md, analysis-platformio-issues.md
  analysis-stackchan-app.md, analysis-uiflow2-stackchan.md
  research/ADVERSARIAL_REVIEW.md, research/CODE_REVIEW.md
  research/MERGE_PLAN.md, research/MERGE_PLAN_V2.md
  research/existing-work-analysis.md, research/hermes-stackchan-analysis.md
  research/xiaozhi-esp32-analysis.md
  test-harness/UX_REVIEW.md, test-harness/index.html
```

### Git Log (20 most recent)

```
2c6b78b docs: update brief — dual backend (OpenClaw + Hermes), profile binding, working repos, M5Burner publishing
9872154 docs: propose firmware v1 changes (C1-C4 critical + R1-R2 recommended)
0947211 docs: update README, add web config page + code review V2
d7ad2f3 test: add workspace file I/O tests for both agents
144622e test: strict agent binding validation for OpenClaw + Hermes
bfc1479 docs: final synthesis of channel integration research
6f886df docs: professional README with project brief, architecture, v1/v2 channel table
ef834da Add config editor, test harness, and channel research
63b8876 README: make Hermes a first-class citizen alongside OpenClaw
c27e221 Clean up for public release — sanitize personal info, add README, agent template
f8bbade Refined plan: codebase specifics, verified mini deps, wake word, port assignments
aef965c swarm3 synthesis + docs rewrite: swap-backends v1, thin client v1.1
6e44261 archive Architecture A artifacts
e325144 refactor architecture: Larry V2 thin audio client pattern
f3f1458 architecture pivot: adapter pattern — fork plaipin, minimal firmware changes
44ff06c adversarial doc critique: 8 issues found and fixed
26006af docs: reuse-first principle + Arduino-ESP32 component decision
0593234 docs: integrate stackchan-gemini-firmware findings
b01cc1d analysis: taranton/stackchan-gemini-firmware
302a411 rename: StackChan-OpenClaw-Hermes — comprehensive rename + GitHub prep

**Reading:** The repo's committed history is **overwhelmingly documentation**. The vast majority of commits are `docs:`, `analysis:`, `test:` (test harness scripts), and `feat(docs)`. There is very little committed *product* code — the actual firmware and server code lives in **cloned reference repos** (gitignored) rather than in this repo itself.

---

## Directory Structure

### Top level (what's actually in our repo)

| Path | Type | Purpose |
|------|------|---------|
| `analysis/` | dir | 28+ analysis reports from swarm subagents |
| `research/` | dir | 21 research docs (deep-reads, merge plans, channel research) |
| `docs/` | dir | BRIEF.md, ADRs, agent-template.md |
| `test-harness/` | dir | Python test harnesses (agent binding, e2e, workspace write) |
| `config-editor/` | dir | Node.js Express web config editor (works) |
| `firmware/` | dir | **gitignored** — cloned reference firmware repos (StackChan, xiaozhi-esp32) |
| `repos/` | dir | **gitignored** — all cloned reference/working repos |
| `backups/` | dir | **gitignored** — firmware backups (16MB stock, factory, patched) |
| `archive/` | dir | Old Architecture A artifacts |
| `*.md` | files | BUILD_PLAN, CODE_REVIEW (V1/V2), FIRMWARE_CHANGES_PROPOSED, FLASHING-GUIDE, RECOVERY-LOG, TODO, README |

### No `server/` directory at repo root
There is **no `server/` dir in our repo**. The server code lives inside cloned repos (see below). The TODO/plan references a `server/audio_pipeline.py` that is **planned but not yet built**.

### `.gitignore` is significant
```
# Reference repos (cloned, not our code)
firmware/
repos/
```
The firmware and repos dirs are **deliberately not tracked** in this repo. They are clones.

---

## Code Files (what's real, working code)

### 1. `test-harness/` — REAL, WORKING CODE (6 files)

| File | Size | Status |
|------|------|--------|
| `e2e_test_harness.py` | 18KB | End-to-end test harness |
| `native_test_harness.py` | 34KB | Native device test harness |
| `test_agent_binding.py` | 36KB | **Strict agent binding validation** for OpenClaw + Hermes (36KB — the most substantial file) |
| `workspace_write_test.py` | 8.7KB | Stack-chan → Rosie workspace file I/O test |
| `web-config.html` | 24KB | **MODIFIED (unstaged)** — web config UI |
| `index.html` | 232B | **UNTRACKED** |
| `STACKCHAN_HANDSHAKE.txt` | 163B | Handshake marker (written by firmware→gateway test) |
| `VALIDATION_RESULTS.md` | 2KB | Results |
| `UX_REVIEW.md` | 23KB | **UNTRACKED** — UX review |

**Key finding:** The test harness is the most mature code in the repo. `test_agent_binding.py` validates: OpenClaw/Rosie + Hermes/Venus HTTP endpoints, session-key persistence, agent isolation, auth rejection, session/channel headers, and the `/v1/models` endpoint. These tests were committed and are the "proof" of the binding mechanism.

### 2. `config-editor/` — REAL, WORKING CODE (Node.js)

- `server.js` (4.4KB) — Express server on port 5570, proxies `/config` and `/config_set` to the robot over HTTP, saves config locally. Includes a JSON→YAML converter. **This is functional, self-contained, and commit-worthy.**
- `public/` — `index.html`, `app.js`, `style.css` — web UI
- `config.yaml` — current config (backend 0=OpenClaw, host 192.168.2.173, port 18789, model `openclaw/rosie`, agent `rosie`)
- `package.json` — express dependency only
- `node_modules/` — installed (committed)

**Finding:** `config-editor` is real working software, fully built, installable, runnable. This is the one piece of our own product code committed to git (aside from test harnesses).

### 3. No committed firmware/server code in our repo

Our repo itself does **NOT contain** the OpenClaw firmware client or the audio pipeline server. These live in cloned repos under `repos/`.

---

## Firmware Status — **KEY FINDING**

**Our repo has NO first-party ESP32 firmware code.** The firmware is in cloned reference repos. There are **two relevant firmware locations:**

### A. `firmware/` (gitignored clones)
- `firmware/StackChan` → `m5stack/StackChan.git` (upstream M5Stack, unmodified)
- `firmware/xiaozhi-esp32` → `78/xiaozhi-esp32.git` (upstream Xiaozhi, unmodified)

These are pristine upstream clones — reference material only.

### B. `repos/plaipin-openclaw-stackchan` — **THE ACTIVE FIRMWARE FORK**
Fork of `styles01/plaipin-openclaw-stackchan.git` (James's own fork). This is where the **real firmware work lives**:

- **Modified (uncommitted):**
  - `firmware/platformio.ini` (+2 lines)
  - `firmware/src/main.cpp` (−561 / +21 lines — heavily stripped)
- **Contains OpenClaw firmware client:**
  - `firmware/src/llm/OpenClaw/OpenClawClient.cpp` / `.h` — the OpenClaw LLM client (with emoji stripping, PSRAM-safe, streaming)
- **Backend selector already plumbed:** `StackchanExConfig.h` has `backend` (0=OpenClaw, 1=Hermes), `OpenClawConf` struct, `hermes_s` struct
- **Built artifacts exist:** `.pio/build/m5stack-cores3/` has `firmware.bin`, `bootloader.bin`, `partitions.bin` — **it HAS been compiled for CoreS3**
- **Note:** The TODO's `MiniSTT.cpp`/`MiniTTS.cpp` (v1 swap-backends) do **NOT exist yet** — only the OpenClaw LLM client exists. STT/TTS retargeting is still pending.

### C. `repos/working-repos/Hermes-StackChan` — active fork (Hermes track)
Fork of `circlemouth/Hermes-StackChan.git`, **4 commits ahead of origin, 4 local commits:**
- `e5cdbb5` fix(firmware): normalize xiaozhi-esp32.patch whitespace, `idf.py build` now works
- `afd0c5c` fix(ai-server): address code review (dex) critical + important issues
- `9c6b38f` docs: update all repo docs for OpenClaw v1 backend
- `ab53a1f` feat(ai-server): add OpenClaw as second backend (v1, env-only)

This fork has real code:
- `ai-server/src/openclaw.ts` (5.4KB) — OpenClaw backend client implementing the `HermesSessionClient` interface (HTTP POST `/v1/chat/completions`, SSE streaming, AbortController barge-in)
- `ai-server/dist/` — **compiled JS** exists (so it builds)
- 68/68 ai-server tests passing (9 new OpenClaw tests)
- Firmware `idf.py build` verified working (bootloader, partitions, stack-chan.bin 3.58MB, 35% free)
- **Untracked:** `firmware/build-host-tests/`

### Firmware summary
There are **two parallel firmware/back-end tracks** in progress:
1. **plaipin fork (OpenClaw-native, PlatformIO, CoreS3)** — OpenClawClient.cpp exists, compiled, but MiniSTT/MiniTTS not built yet
2. **Hermes-StackChan fork (Hermes ai-server + xiaozhi firmware)** — OpenClaw backend added to the TS ai-server, firmware builds, but this is the Hermes-track repo

---

## Test Harness (see Code Files above)

Summary: **6 Python test files + web UI**, all functional and committed. `test_agent_binding.py` is the flagship — strict binding validation for both OpenClaw and Hermes agents, session persistence, agent isolation, auth rejection. `workspace_write_test.py` proves the full chain: firmware-sim → Gateway → Rosie → workspace file write.

---

## Research Files (extensive, mostly untracked)

**21 files** in `research/` (tracked subset) + **7 untracked** research/analysis files at repo root. Content areas:
- **Channel/agent binding research** (deep-read-*, hermes-and-agent-binding, http-endpoint-session-behavior, multi-agent-session-routing) — the "channel key not session key" investigation
- **Merge plans** (MERGE_PLAN, MERGE_PLAN_V2) — merging OpenClaw + Hermes tracks
- **API reference, final synthesis, adversarial/CODE reviews** (performed by Dex subagent)
- **External repo analyses** (xiaozhi-esp32, hermes-stackchan, existing-work)

The research is thorough and represents real understanding of the integration problem. But **much of it is untracked/uncommitted** — at risk of loss.

---

## TODO Status — Marked vs Actual

**TODO.md** marks the vast majority of the **build work as still pending**. Completed items are mostly documentation/research. Notable gaps:

| Phase | Status | Notes |
|-------|--------|-------|
| Repo/GitHub | ~30% | Structure + docs done; rename to `stackchan-openclaw` pending, README/commit-push pending |
| **Phase 1: Fork & Flash Stock** | ~40% | **Backup done** (16MB + factory + partition), plaipin fork exists. **But:** flashing not verified end-to-end; body (servos/face/touch/speaker) not verified on the working CoreS3. Milestone NOT reached. |
| **Phase 2: Audio Pipeline Server** | **0%** | `server/audio_pipeline.py` **does not exist**. The TODO says "Mini env verified: faster-whisper ✓, kokoro ✓" but the actual FastAPI server was never written. This is the critical missing piece. |
| **Phase 3: Retarget Backends** | ~30% | OpenClawClient.cpp **exists**; `MiniSTT`/`MiniTTS`/`BodyCommandParser` **do not exist**. Config selector exists in `StackchanExConfig.h`. |
| Phase 4: Agent Configuration | 0% | Not started |
| Phase 5: Polish & Testing | 0% | Not started |
| Phase 6 (Larry) | 0% | Future |
| v1.1 thin client, v2 Hermes, v3 streaming | 0% | Deferred |

**Pending vs done:** Everything that is a concrete *build* step (server, backends, flashing, agent config, polish) is **pending**. Everything that is *research/planning/testing* is **done**. This is a **research-heavy, build-light** repo at this stage.

---

## Summary

### What's actually in this repo
1. **A planning/documentation backbone** — BUILD_PLAN, BRIEF, TODO, CODE_REVIEW (V1/V2), FIRMWARE_CHANGES_PROPOSED, FLASHING-GUIDE, RECOVERY-LOG, 21 research files, 28 analysis files
2. **Real, working test harnesses** (6 Python files) — the most substantial committed code
3. **A real, working config editor** (Node.js/Express, commits to robot + local YAML)
4. **Cloned reference repos** (gitignored) — StackChan, xiaozhi-esp32, plaipin fork (active), Hermes-StackChan fork (active), StackChan-BSP, stackchan-uiflow2, zclaw, esp-openclaw-node, working-repos (5 more)

### What's been BUILT vs just planned
- **Built & verified:** Test harnesses, config editor, OpenClawClient.cpp firmware client, Hermes ai-server OpenClaw backend (TS), compiled firmware artifacts (plaipin CoreS3 + Hermes xiaozhi), stock firmware backups
- **Planned but NOT built:** `server/audio_pipeline.py` (MiniSTT/MiniTTS/BodyCommandParser), the v1.1 thin client, agent configuration, all flashing verification on hardware

### Key risks
1. **The audio pipeline server doesn't exist** — it's the linchpin of the whole v1 architecture (STT→LLM→TTS), and it's at 0%
2. **Hardware validation incomplete** — backups are made but the flashed firmware wasn't verified working (see RECOVERY-LOG: the original "stock backup" was empty and bricked the device; recovered via M5Stack factory CDN image)
3. **Large untracked documentation** — 15+ untracked files (research + analysis) risk being lost
4. **1 unpushed commit** — ahead of origin by 1

### Overarching assessment
This repo is in a **pre-build, research-complete state**. The intellectual groundwork (architecture, channel binding research, code reviews) is thorough and mature. The executable assets are: test harnesses, config editor, OpenClaw firmware client, and a Hermes-server OpenClaw backend. **The missing next piece of concrete construction is the audio pipeline server and the MiniSTT/MiniTTS firmware backends.**
