# UX Review: Stack-chan Web Config Page

**File reviewed:** `test-harness/web-config.html`
**Date:** 2026-08-18
**Reviewer:** Hailey (UX subagent)

---

## 1. First Impression

**Verdict: Solid amateur-to-mid-tier. Not embarrassing, but not polished.**

The dark theme (`#1a1a2e` background, `#00d4ff` cyan accents) is a reasonable choice for a "robot config tool" and feels appropriately techy. The cohesive color palette — cyan for OpenClaw, magenta for Hermes — is a nice touch that gives each backend a visual identity.

However, several things undercut the polish:

- **No favicon, no app icon.** Browser tabs show a generic icon. For a robot with a known face/logo, this is a missed opportunity.
- **The emoji header (`🤖 Stack-chan Config`)** is cute but flat. There's no logo, no Stack-chan face image, no branding. It reads like a quickly thrown-together tool, not a product.
- **Inconsistent border radius.** Inputs are `6px`, sections are `10px`, badges are `4px`. Pick two sizes max (e.g., 6px for small elements, 10px for sections).
- **No visual hierarchy beyond headings.** The sections all look the same weight. The "Connection" section should feel more prominent since it's the gatekeeper to everything else.
- **The `<code>` element in the API Keys hint** has no styling — it renders as plain monospace text without the typical background/padding that makes inline code readable in a dark theme.

**What's good:** The color scheme is coherent. The badge system for OpenClaw vs Hermes is smart. The dark theme is appropriate for the audience (makers/developers).

---

## 2. Auto-Discovery Flow

**Verdict: Functional but rough. The scanning UX needs significant improvement.**

### What happens on load:
The page calls `autoScan()` after a 500ms delay on `window.load`. This scans the `/24` subnet by fetching `http://<ip>/config` on port 80 for all 254 addresses, in batches of 20, with a 1.5s timeout per request.

### Issues:

1. **No indication on initial load that scanning is happening.** The user sees a blank page with a "Connection" section. The scan button still says "🔍 Auto-Find Stack-chan" — it doesn't change until the user clicks it. The `autoScan()` function IS being called, but since `btn.disabled` and `btn.innerHTML` are set inside `autoScan()`, the button DOES update… but only if the function runs. Let me re-check.

   **Actually, re-reading the code:** `autoScan()` IS called on load. It DOES set `btn.innerHTML` to the spinner + "Scanning..." text. So the button DOES update. Good. But:

2. **The scan results area (`#scan-results`) is empty and invisible until results arrive.** There's no "scanning..." placeholder in the results div itself. The only feedback is the button text changing and the status line. The user might not notice the button changed if they're looking at the middle of the page.

3. **Scanning 254 IPs takes 15-20 seconds** (ceil(254/20) = 13 batches × up to 1.5s timeout = ~20s worst case). That's a LONG time with no progress indicator. No progress bar, no "scanning 40/254..." counter, no estimated time. The user just sees a spinner on the button and "Scanning 192.168.X.0/24..." in the status line.

4. **No cancel/abort for scanning.** Once started, the user can't stop it. If they realize they're on the wrong network, they have to wait or refresh.

5. **No devices found state** shows `❌ No Stack-chan found on 192.168.X.0/24. Make sure it's powered on and connected to WiFi.` — This is decent messaging. But:
   - It's an error-red color, which feels punitive for a not-actually-an-error situation.
   - There's no "Retry" button next to the message.
   - There's no troubleshooting guidance (e.g., "Check that your computer and Stack-chan are on the same WiFi network" or "Try entering the IP manually").

6. **Subnet detection assumes the page is served from a LAN IP.** If loaded via `localhost`, `127.0.0.1`, or a hostname that isn't a dotted quad, `getSubnet()` returns `null` and the user gets a scary error. The page is apparently served from the Stack-chan device itself, so this is probably fine in practice — but if someone opens the file directly (`file://`), it fails with `⚠️ Cannot determine subnet` which is confusing.

7. **Auto-scan on load is aggressive.** Scanning 254 IPs on every page load is heavy. If the user already knows the IP and just wants to type it in, the scan is still running in the background, consuming network resources. Consider: only auto-scan if the base-url field is empty, or add a "Skip scan" option.

8. **Single-device auto-select** (`selectDevice` called when exactly 1 found) is a nice touch — seamless when there's one robot. But it happens silently. The user might not realize they've been connected. A brief "Found your Stack-chan! Connecting..." state would help.

### What's good:
- Batch scanning (20 at a time) is smart for speed.
- 1.5s timeout per IP is reasonable.
- The scan result cards showing IP, backend, and agent name are informative.
- Auto-selecting when only one device is found is a great UX decision.
- The spinner animation is clean.

---

## 3. Information Architecture

**Verdict: Section order is logical, but there are structural issues.**

Current order:
1. Connection (IP input + auto-find)
2. Backend selector
3. OpenClaw settings
4. Hermes settings
5. Actions (Save, Reload, Test Chat, Show Raw)
6. Test Chat (hidden)
7. Raw JSON (hidden)
8. API Keys (info only)

### Issues:

1. **The "API Keys" section at the bottom is anti-climactic.** It's just a hint saying "go use the /apikey endpoint." It feels like an afterthought. Consider: integrate this as a callout/info box within the backend settings sections (where API keys would actually be relevant), or move it higher as a note.

2. **All three config sections (Backend, OpenClaw, Hermes) are shown simultaneously** after connecting, regardless of which backend is selected. The `openclaw-section` and `hermes-section` both get `display:''` in `loadConfig()`. There's no JavaScript to hide the inactive backend's settings. This means the user sees both OpenClaw AND Hermes forms even if they only care about one. **This is the biggest IA problem.** The backend selector should toggle which settings section is visible.

3. **The Actions section has no heading.** It's a section with just buttons. It should have an `<h2>` like "Actions" or be integrated into the config flow differently.

4. **Test Chat and Raw JSON sections appear below the actions with no visual connection.** When you click "Test Chat", a section appears further down the page, but the page doesn't scroll to it. The user might not realize anything appeared.

5. **No "you have unsaved changes" warning.** If the user edits fields and clicks "Reload" (or navigates away), changes are lost silently.

### What's good:
- Connection → Config → Actions is the right top-level flow.
- Hiding sections until connected prevents confusion.
- The hint text under the backend selector is helpful.

---

## 4. Form Design

**Verdict: Decent but has several issues.**

### Backend Selector:
```html
<select id="backend">
  <option value="0">OpenClaw (0)</option>
  <option value="1">Hermes (1)</option>
</select>
```
The `(0)` and `(1)` in the option labels are implementation details leaking into the UI. The user doesn't care that OpenClaw is backend `0` internally. Just say "OpenClaw" and "Hermes." The numeric values can stay in the `value` attributes.

### Labels:
- All labels use `<label for="...">` which is correct for accessibility.
- Labels are `font-weight: bold` and `font-size: 0.85em` — they're small and somewhat low-contrast (`color: #aaa`). On the dark background, `#aaa` on `#16213e` has a contrast ratio of about 5.7:1, which passes WCAG AA for normal text but is still visually muted. Consider `#ccc` or `#d0d0d0`.

### Inputs:
- The `placeholder` attributes serve as default-value hints, but several inputs ALSO have `value` attributes (e.g., `oc-port` has `value="18789"` AND `placeholder="18789"`). This is redundant. The placeholder is invisible when a value is set. Pick one.
- Port inputs use `type="number"` which is correct, but there's no min/max validation. A user could enter `99999` or `-1`.
- No `inputmode` hints for mobile (e.g., `inputmode="numeric"` for port fields would show the numeric keyboard).

### Grouping:
- Host + Port in a `.row` (side by side) is good.
- Model + Agent ID in a row is also good.
- But the rows don't have visual separation beyond spacing. Consider subtle dividers or group labels like "Connection Settings" and "Identity."

### The `base-url` input:
- `placeholder="http://<stack-chan-ip>"` is helpful.
- But there's no URL validation. The user could type "hello" and the fetch would fail with a confusing error.
- No protocol auto-prefixing. If the user types just "192.168.1.50", the fetch to `192.168.1.50/config` fails because it's not a valid URL. Consider auto-prepending `http://`.

---

## 5. Feedback & Status

**Verdict: Basic but functional. Missing several key feedback patterns.**

### What works:
- `showStatus()` displays messages with color-coded backgrounds (green/red/blue).
- Connection success shows `✅ Connected — config loaded from <url>`.
- Save success shows the response from the device.
- Errors are caught and displayed.

### What's missing:

1. **No loading state on the "Connect" button.** When `loadConfig()` is called, the Connect button doesn't change. No spinner, no disabled state. The user could click it repeatedly.

2. **No loading state on the "Save" button.** Same issue. The status line says "Saving..." but the button itself gives no feedback.

3. **No loading state on "Test Chat" / "Send".** The chat output says "Sending..." in the `<pre>` but the Send button doesn't change.

4. **Status messages are ephemeral and easily missed.** They appear at the top of the Connection section. If the user has scrolled down to edit config and clicks Save, the success message appears off-screen. Consider: toast notifications that appear in a fixed position, or scroll the status into view.

5. **No optimistic UI.** Every action requires a full round-trip. The Save button could show a brief checkmark animation on success.

6. **Error messages are technical.** `❌ HTTP 404: Not Found` means something to a developer but not to a maker. Consider friendlier messages: "Couldn't reach Stack-chan at that address. Check the IP and try again."

7. **No timeout on config fetch/save.** If the device is slow or unresponsive, the fetch hangs indefinitely. No abort controller, no timeout.

8. **The Test Chat output is raw text in a `<pre>`.** No formatting, no markdown rendering, no distinction between user message and response. For a "test" feature this is acceptable, but it could show a chat-bubble style exchange.

---

## 6. Mobile Responsiveness

**Verdict: Bare minimum. Works but not great.**

### What exists:
```css
@media (max-width: 500px) { .row { flex-direction: column; } }
```
This is the ONLY responsive rule. It stacks the `.row` flex containers vertically on small screens.

### Issues:

1. **Base font size is 18px** (`html { font-size: 18px; }`) — this is large for mobile. Most mobile designs use 16px and let the device scale. 18px isn't terrible, but it means less content fits on screen.

2. **The `#ip-group` flex row doesn't collapse on mobile.** The IP input and Connect button stay side by side. On a 375px screen, the text input gets squished. Add `#ip-group` to the mobile breakpoint.

3. **The `.actions` buttons wrap with `flex-wrap: wrap`** which is good, but the buttons themselves are `0.95em` font size with `0.6em 1.5em` padding. On mobile, they're a bit small as tap targets. Apple's HIG recommends 44pt minimum. Consider increasing padding on mobile.

4. **No `viewport` issues** — the meta tag is correct (`width=device-width, initial-scale=1`).

5. **The scan results are tappable** (`cursor: pointer`, `onclick`) but the tap target is the full row width, which is good. However, there's no `:active` state for touch feedback.

6. **The `<pre>` blocks** have `overflow-x: auto` which is good for code, but on mobile the raw JSON could be very wide and hard to read.

7. **No safe-area insets** for notched phones. Consider `padding: env(safe-area-inset-top)` etc.

8. **The container max-width is 600px** which is good — it doesn't stretch absurdly on tablets.

---

## 7. Accessibility

**Verdict: Some good basics, but several gaps.**

### What's good:
- Labels are properly associated via `for`/`id`.
- The language is declared (`<html lang="en">`).
- Semantic-ish use of headings (h1, h2).
- Focus styles exist (`input:focus { border-color: #00d4ff; }`).

### Issues:

1. **No `aria-live` on the status div.** The `#status` div updates dynamically, but screen readers won't announce changes. Add `aria-live="polite"` (or `aria-live="assertive"` for errors).

2. **No `aria-live` on scan results.** When devices are found, they appear dynamically. Screen reader users won't know.

3. **The scan results use `div` with `onclick`** — these aren't keyboard accessible. They should be `<button>` or have `role="button"` + `tabindex="0"` + keyboard event handlers.

4. **The scan button uses an emoji (🔍) as part of the label.** Screen readers will read "Magnifying glass Auto-Find Stack-chan." Consider `aria-hidden="true"` on decorative emojis, or use them only as CSS pseudo-elements.

5. **Color contrast:**
   - `#aaa` labels on `#16213e` background: ~5.7:1 — passes AA, fails AAA. Fine.
   - `#666` hint text on `#1a1a2e` background: ~3.5:1 — **FAILS WCAG AA for normal text** (requires 4.5:1). This is a real issue. The hint text is hard to read.
   - `#00d4ff` on `#1a1a2e`: ~8.4:1 — excellent.
   - `#e0e0e0` on `#1a1a2e`: ~11:1 — excellent.
   - `#8b949e` (pre text) on `#0d1117`: ~5.8:1 — passes AA.

6. **No `skip to content` link.** For a single-page tool this is minor but still a best practice.

7. **Buttons in the actions section have no accessible names beyond their text content.** This is fine since the text is descriptive, but emoji in button text (💾, 🔄, 💬, 📋) will be read aloud by screen readers.

8. **The hidden sections use `display: none`** which correctly removes them from the accessibility tree. Good.

9. **No fieldset/legend for form groups.** The `.row` divs group related fields (Host+Port, Model+Agent) but don't use `<fieldset>` + `<legend>`. This is a semantic improvement that also helps screen readers.

10. **Keyboard navigation through scan results** isn't possible (see #3 above).

---

## 8. Edge Cases

### Empty fields:
- **Empty host:** `buildConfigJson()` sends `host: ''` — the device will likely fail to connect to an empty host. No client-side validation.
- **Empty port:** `parseInt('')` returns `NaN`, which becomes `null` in JSON. The device will likely reject this or crash.
- **Empty model:** Sent as empty string. Robot may use a default or fail.
- **Empty agent_id:** Sent as empty string.

**Fix:** Add client-side validation before save. Disable the Save button if required fields are empty. Show inline validation errors.

### Robot unreachable mid-config:
- If the robot goes offline after loading config but before saving, the `fetch` to `/config` POST will fail. The error shows `❌ Save failed: HTTP <error>` or a network error. This is handled, but the message isn't user-friendly.
- No retry mechanism. No "last known good config" to fall back to.

### Save fails:
- The error message from the device is displayed, which is good.
- But the form retains the user's (failed) input, which is correct — they can fix and retry.
- No indication of WHAT failed (validation error? network error? device rejected?). Just the raw error string.

### Multiple devices:
- The scan shows multiple results and lets the user pick. Good.
- But there's no way to compare configs between devices, or save to multiple devices at once. (Probably out of scope.)

### Concurrent edits:
- If two people are configuring the same Stack-chan, last-save-wins with no warning. No etag/optimistic locking. (Acceptable for a LAN config tool.)

### Network errors during scan:
- Each failed fetch is silently swallowed. The user has no idea how many IPs were tried vs. how many timed out vs. how many refused. Consider a subtle "Scanned X/254" counter.

### Port edge cases:
- Port 0 or negative ports aren't validated.
- Port > 65535 isn't validated.
- Non-numeric port input (via DOM manipulation) would produce `NaN`.

### CORS:
- The page fetches from `http://<ip>/config` while being served from `http://<different-ip>:<port>`. This will trigger CORS errors unless the Stack-chan firmware sets `Access-Control-Allow-Origin: *`. The page doesn't mention this requirement or handle CORS errors gracefully. A CORS failure shows up as a generic "Failed to fetch" which is confusing.

---

## 9. Delight & Personality

**Verdict: This is for a CUTE robot. The page should reflect that.**

Stack-chan is a small, adorable robot with a face. It has personality. The config page… does not.

### Current tone:
- Clinical, functional, dark-theme.
- One emoji in the header (`🤖`).
- Emoji in buttons (💾, 🔄, 💬, 📋).
- No Stack-chan imagery anywhere.

### Suggestions:

1. **Add the Stack-chan face.** Use an SVG or small image of the Stack-chan face in the header. This immediately makes the page feel like it belongs to the product, not a generic admin tool.

2. **Personality in copy.** Instead of "Stack-chan Config", try "Configure your Stack-chan" or "Stack-chan Setup." Instead of "No Stack-chan found", try "No Stack-chan detected nearby 😢 — is your robot powered on?"

3. **Loading states with personality.** While scanning: "Looking for Stack-chan on your network..." While connecting: "Knocking on Stack-chan's door..." While saving: "Telling Stack-chan about your changes..."

4. **Success celebrations.** When save succeeds, a brief Stack-chan face animation or a "Stack-chan is happy! ✓" message. Even a CSS-only bounce on the header emoji.

5. **The dark theme is fine.** It doesn't need to be bright and cartoony. But small touches of warmth — rounded corners, a face, playful microcopy — would go a long way. Think "developer-friendly but cute," not "enterprise admin panel."

6. **Easter egg:** If the test chat response contains certain keywords, the header emoji could react. (Optional, but fun.)

7. **The badge colors are good** (cyan for OpenClaw, magenta for Hermes). Lean into this more — maybe a subtle background tint on the corresponding section.

---

## 10. Specific Improvements

### High Priority

| # | Issue | Fix | Line ref |
|---|-------|-----|----------|
| 1 | Both OpenClaw and Hermes sections shown at once | Add JS to toggle `hermes-section`/`openclaw-section` visibility based on `#backend` value | `loadConfig()` ~line 175, `backend` change handler missing |
| 2 | Hint text fails WCAG AA contrast | Change `.hint` color from `#666` to `#999` or `#aaa` | `.hint` CSS rule |
| 3 | No loading state on buttons | Disable buttons + show spinner during async operations | `loadConfig()`, `saveConfig()`, `testChat()` |
| 4 | No input validation | Add `required` attributes, port min/max (`min="1" max="65535"`), and pre-save validation function | All input elements |
| 5 | Scan results not keyboard accessible | Change `.scan-result` divs to `<button>` elements or add `role="button" tabindex="0"` + keydown handler | `addScanResult()` function |
| 6 | No `aria-live` on dynamic regions | Add `aria-live="polite"` to `#status` and `#scan-results` | `<div id="status">`, `<div id="scan-results">` |
| 7 | No fetch timeout on config load/save | Add `AbortController` with 5s timeout to all fetches | `loadConfig()`, `saveConfig()` |

### Medium Priority

| # | Issue | Fix | Line ref |
|---|-------|-----|----------|
| 8 | Backend selector leaks internal numeric values | Remove `(0)` and `(1)` from option labels | `<option>` elements |
| 9 | No auto-protocol on IP input | If input doesn't start with `http`, prepend `http://` in `getBaseUrl()` | `getBaseUrl()` |
| 10 | `#ip-group` doesn't stack on mobile | Add `#ip-group` to the `@media` breakpoint | `@media (max-width: 500px)` |
| 11 | No progress indicator during scan | Show "Scanned X/254 IPs" counter that updates per batch | `autoScan()` |
| 12 | Actions section has no heading | Add `<h2>Actions</h2>` | `#actions-section` |
| 13 | No unsaved changes warning | Track dirty state, warn before reload/navigate | Global |
| 14 | Status messages appear off-screen after scroll | Use a fixed-position toast or scroll `#status` into view | `showStatus()` |
| 15 | API Keys section feels orphaned | Move as a callout inside backend settings or add a link to the `/apikey` endpoint | Bottom section |

### Low Priority / Polish

| # | Issue | Fix | Line ref |
|---|-------|-----|----------|
| 16 | No favicon | Add an SVG favicon (Stack-chan face) | `<head>` |
| 17 | No Stack-chan branding/face | Add SVG or `<img>` of Stack-chan face in header | `<h1>` area |
| 18 | Inline `<code>` unstyled | Add `code { background: #0d1117; padding: 2px 6px; border-radius: 3px; }` | `<style>` |
| 19 | Inconsistent border-radius | Standardize: 6px for inputs/badges, 10px for sections | CSS |
| 20 | Emoji in buttons read by screen readers | Wrap emoji in `<span aria-hidden="true">` | All buttons |
| 21 | No `:active` state on scan results for touch | Add `.scan-result:active { transform: scale(0.98); }` | CSS |
| 22 | Redundant placeholder + value on some inputs | Remove `placeholder` when `value` is set, or vice versa | Port/model inputs |
| 23 | No fieldset/legend for form groups | Wrap rows in `<fieldset><legend>` | `.row` divs |
| 24 | No safe-area insets for notched phones | Add `env(safe-area-inset-*)` to body padding | `body` CSS |
| 25 | Auto-scan runs even if user knows IP | Only auto-scan if `#base-url` is empty | `window.load` handler |

---

## Summary

The page is a functional, no-framework config tool that gets the job done. The dark theme and color-coded backend badges are smart choices. But it has three categories of problems:

1. **The backend selector doesn't filter the visible form sections** — this is the most impactful bug. Users see both OpenClaw and Hermes forms regardless of selection, which is confusing and overwhelming.

2. **Feedback gaps** — buttons don't show loading states, status messages can be missed, scanning has no progress indicator, and error messages are too technical.

3. **Accessibility gaps** — hint text fails contrast minimums, scan results aren't keyboard accessible, dynamic regions aren't announced, and decorative emojis aren't hidden from AT.

The page also misses an opportunity to reflect Stack-chan's personality. A robot face in the header, playful microcopy, and a small success animation would transform this from "admin panel" to "delightful robot companion tool" without sacrificing the clean technical aesthetic.

**Overall rating: 6/10.** Functional, not broken, but not polished and not accessible. The fixes above are all achievable in a single editing pass — no architecture changes needed.