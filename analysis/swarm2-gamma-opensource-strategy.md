# SWARM 2 — GAMMA: Open Source Strategy & Upstream Critique

**Reviewer:** Research Agent GAMMA (open source strategy)
**Date:** 2026-08-17 23:55 MDT
**Mandate:** Argue about the open source / upstream strategy. Is the "upstream advantage" real or wishful thinking?

---

## EXECUTIVE VERDICT

**The upstream advantage is HALF REAL.** Pulling Stack-chan updates: yes, realistic. PRing back to plaipin: no, it's a dead repo (2 stars, 1 commit, 5 months old). PRing to Stack-chan directly: maybe, but the body command format is a HARD SELL. The repo naming is confusing. The licensing gap is a real problem. And there's a genuine risk that Stack-chan themselves build native OpenClaw support, making our fork redundant — but that's actually the BEST CASE scenario for the community, and we should position for it.

---

## FINDING 1: How far has plaipin diverged from Stack-chan? — MODERATELY

Plaipin is a fork of Stack-chan that:
- Added the `OpenClaw/` LLM backend directory (new files, no conflict)
- Modified `StackchanExConfig.h` to add `openclaw_s` config struct
- Modified `main.cpp` to instantiate `OpenClawClient` instead of `ChatGPT`
- Added `openclaw-rest-proxy.js` (separate file, not in firmware)
- Added Telegram bridge polling to the proxy
- Modified partition table (`my_cores3_16MB.csv`)

**The divergence is ADDITIVE** — plaipin adds new files and new config, it doesn't deeply modify Stack-chan's core files. This means:

- **Pulling upstream Stack-chan updates: FEASIBLE.** The core files (Robot.cpp, avatar, servo, camera) are likely untouched or minimally modified. Merge conflicts would be in `main.cpp` and `StackchanExConfig.h` — manageable.
- **But plaipin hasn't pulled upstream in 5 months.** If Stack-chan has had major changes since March 2026, plaipin is already stale. We'd need to merge upstream Stack-chan → plaipin → our fork. That's a 3-way merge, not a simple pull.

**Verdict:** The "pull upstream" claim is realistic but requires active maintenance. This isn't automatic — someone has to do the merges. The docs should say "we CAN pull upstream with moderate merge effort" not "we AUTOMATICALLY benefit from upstream."

---

## FINDING 2: Is plaipin worth PRing to? — NO

**Plaipin facts:**
- 2 stars
- 1 commit (the initial commit, March 2026)
- 0 open issues
- Creator: "Nat" — no other activity
- No README, no documentation, no CI
- Last (only) commit message: "Add telegram input reaction"

**This is a throwaway POC repo, not a maintained project.** PRing to plaipin is shouting into the void. The maintainer may never respond.

**Where should we PR instead?**

Option A: **PR to Stack-chan directly.** Stack-chan (the main repo by mongonta0716) is actively maintained, has 800+ stars, regular commits. But — they may not want OpenClaw-specific code in their mainline. OpenClaw is one of many possible backends. They might accept a clean `OpenClawClient` that matches their `LLMBase` interface, but the `body` command format is a different story (see Finding 3).

Option B: **Be our own project.** "StackChan-OpenClaw-Hermes" becomes the canonical repo for connecting Stack-chan to OpenClaw/Hermes. We don't PR anywhere — we're a standalone fork that people find via Reddit/Discord. This is actually the most realistic path.

Option C: **PR the adapter to Stack-chan, keep the proxy as our project.** The `OpenClawClient.cpp` is a clean `LLMBase` implementation — that could merge upstream. The proxy is our differentiator — keep it separate.

**Recommendation: Option C.** Adapter upstream (if Stack-chan wants it), proxy stays ours.

---

## FINDING 3: Body command format as a standard — HARD SELL

**The claim:** "Body command response format could become a standard — a `body` field in LLMBase responses."

**The reality:** Stack-chan's `LLMBase::chat()` is a void function that sets internal state. It doesn't RETURN a value — it calls `robot->speech(response)` internally. There's no structured response object to add a `body` field to.

To add body commands, we'd need to either:
- (a) Change the `LLMBase` interface to return structured data instead of calling `robot->speech()` internally — **BREAKING CHANGE**, every backend would need rewriting. Stack-chan maintainers would reject this.
- (b) Add a separate `BodyCommand` class that backends can optionally populate — **ADDITIVE**, non-breaking. More likely to be accepted.
- (c) Keep body commands as our fork's extension, don't upstream — **PRAGMATIC**. We get the feature, community gets the adapter.

**Verdict:** Option (b) is the right approach for upstream PRs. Propose a `BodyCommand` struct that `LLMBase` can optionally populate. If null, robot uses default behavior. If populated, robot acts on it. Non-breaking, additive, clean.

But DON'T block v1 on this. Ship the fork first, propose the standard later.

---

## FINDING 4: Is there demand for Hermes support? — UNCERTAIN

**The claim:** "Hermes support is a differentiator — nobody else has dual-gateway."

**The question:** Does anyone in the Stack-chan community actually USE Hermes?

Evidence against:
- robot-bridge (the only Hermes + Stack-chan project) is Chinese-only, deployed in one household, and the maintainer themselves called the bridge "too thick"
- Stack-chan community is Japan-centric, most users use ChatGPT or Google Gemini
- Hermes is a niche agent framework compared to OpenClaw

Evidence for:
- OpenClaw itself is relatively niche — having TWO gateway options doubles our addressable audience
- The "dual-gateway" architecture is a DESIGN property, not just a feature. It proves the adapter is gateway-agnostic. That's valuable even if most users only use one gateway.

**Verdict:** Hermes support is a nice-to-have, not a selling point. The docs should position it as "architecture supports multiple gateways" rather than "we support Hermes!" — the former is impressive engineering, the latter is a feature nobody asked for.

**Recommendation:** Ship OpenClaw-only for v1. Add Hermes in v2 once we've validated the OpenClaw path. Don't make Hermes a headline feature in the README.

---

## FINDING 5: Repo naming — CONFUSING

**"StackChan-OpenClaw-Hermes"** is a mouthful and raises questions:
- Is this three separate things?
- Do I need both OpenClaw AND Hermes?
- Is this a Stack-chan mod or a new robot?

**Better names:**
- `stackchan-openclaw` — clear, simple, one gateway
- `stackchan-agent` — gateway-agnostic, focuses on what it does
- `stackchan-brains` — playful, memorable, community-friendly
- `openclaw-stackchan` — matches plaipin's naming pattern

**Recommendation:** Rename to `stackchan-openclaw` for v1. If we add Hermes later, the architecture speaks for itself — we don't need it in the name.

---

## FINDING 6: Licensing — MISSING

**The docs don't mention licensing AT ALL.** This is a real problem for open source:

1. **Stack-chan is MIT licensed.** If we fork it, we inherit MIT (or we can relicense, but MIT is permissive enough).
2. **Plaipin has no license file.** Technically, "all rights reserved" by default. We can't legally fork and redistribute without a license. We need to either:
   - Contact plaipin's author ("Nat") and ask them to add MIT
   - Fork from Stack-chan directly and re-implement the OpenClaw adapter from scratch (using plaipin as reference, not as base)
   - Add our own MIT license and accept the minor legal ambiguity (common in practice, technically risky)
3. **Our proxy code** is ours — we can license it however we want. MIT is the obvious choice.
4. **If we want upstream PRs**, we need to match Stack-chan's MIT license.

**This needs to be in the docs.** Add a "Licensing" section: "Fork inherits Stack-chan's MIT license. Proxy and adapter improvements are MIT. We should ask plaipin to add a license file or re-implement from Stack-chan base."

---

## FINDING 7: Will Stack-chan themselves build OpenClaw support? — MAYBE, AND THAT'S FINE

**Risk:** Stack-chan's maintainer (mongonta0716) could add native OpenClaw support, making our fork obsolete.

**How to position for this:**
1. **If they build it natively, we WIN.** Our adapter code and proxy become the reference implementation. We PR it upstream and it gets merged. The community gets native support. We get credit. This is the BEST outcome.
2. **If they don't build it, we're the canonical source.** Our fork becomes the go-to. We get GitHub stars, community recognition, and possibly contributors.
3. **If someone ELSE builds it better, we lose.** But we've still built something useful for ourselves (Rosie on a robot) and learned a lot.

**The docs should acknowledge this risk explicitly.** "We are filling a gap. If Stack-chan fills it themselves, that's a win for the community. We position our work to be mergeable upstream so we benefit either way."

---

## SUMMARY

| Claim | Reality | Recommendation |
|-------|---------|----------------|
| "Pull upstream updates" | Feasible but requires active merge effort | Say "CAN pull upstream" not "automatically benefits" |
| "PR back to plaipin" | Plaipin is dead (2 stars, 1 commit, 5 months) | PR to Stack-chan directly or be standalone |
| "Body command format as standard" | Breaking change if done wrong; additive if done right | Use additive BodyCommand struct, don't block v1 |
| "Hermes as differentiator" | Nobody asked for it, but architecture is valuable | De-scope Hermes to v2, position as "gateway-agnostic architecture" |
| "StackChan-OpenClaw-Hermes" naming | Confusing | Rename to `stackchan-openclaw` |
| Licensing | NOT MENTIONED | Add MIT license section, resolve plaipin license ambiguity |
| Stack-chan builds it themselves | Risk of obsolescence, but best case for community | Position to be mergeable upstream |