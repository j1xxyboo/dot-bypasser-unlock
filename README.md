# dot-bypasser-unlock

Unlock the premium / locked features of the **Dot Bypasser** Chrome extension
(MV3, v4.6.6) — the "bypass CVV on many payment gateways" tool.

The extension ships as an obfuscated `javascript-obfuscator` bundle that gates
features behind a license-server check. This repo contains the tooling that
patches a copy of the official extension so every premium feature is enabled,
plus the analysis notes explaining how the gate (and the extension's two
anti-tamper mechanisms) actually work.

> You supply the extension. This repo does **not** redistribute it — point the
> tools at your own unpacked copy of the official release.

---

## Quick start

```bash
# 1. get the official extension and unpack it into ./dot
#    (Chrome Web Store -> "Dot Bypasser" -> download / unpack the .crx,
#     or use the chrome.zip asset from the official release)

# 2. patch it
node unlock_dot.js dot

# 3. repair the obfuscator's self-defending guard (see "Why step 3 exists")
node --experimental-vm-modules tools/fix_guards.js dot

# 4. package it
node build_zip.js dot dot-unlocked.zip

# 5. install
#    chrome://extensions -> Developer mode -> Load unpacked -> select ./dot
#    (or unzip dot-unlocked.zip and load the dot/ folder inside it)
```

Requirements: **Node 18+** (for the patcher) and `zip` + `sha256sum`
(for packaging). No npm dependencies for the patch itself.

---

## What "unlocked" means, measured

Driving the extension's own UI in headless Chrome 131 — loading the extension
unpacked, dismissing the disclaimer, then clicking every button so that all
panels and modals mount — and counting the DOM:

| metric | stock | unlocked |
|---|---|---|
| premium lock icons | 53 | **0** |
| disabled inputs | 53 | **1**¹ |
| premium "verified" badge next to the title | 0 | **1** |
| "Unofficial Source" nag modal | – | **absent** |
| app mounted / JS errors | yes / none | yes / none |

¹ the one remaining disabled checkbox is the extension's own master
enable/disable switch, which is disabled in the stock build as well — it is not
a premium gate.

The premium badge is the emerald check mark that appears next to the
"Dot Bypasser" title once the extension considers itself licensed.

Reproduce it yourself:

```bash
npm install                      # pulls puppeteer
node harness/final.js ./dot      # -> lockIcons 0, premiumBadges 1, hasNag false
node harness/final.js /path/to/stock/dot   # -> lockIcons 53, disabledInputs 53
```

---

## How the premium gate works

Features are gated on a numeric *premium value* obtained from the license
server (`premium.dotbypasser0.workers.dev/v1`):

| constant | value | meaning |
|---|---|---|
| threshold | `1.1` | premium granted when `premiumValue < 1.1` |
| no-license fallback | `10` | `10 >= 1.1` → locked |

The boolean `isPremium` is produced at **8 independent sites**, each of the form
`value < 1.1 || !ONE`. The `|| !ONE` tail is always false (`ONE === 1`), so
every site reduces to `value < 1.1`. All 8 sites are patched to a forced-true
form, plus the two numeric fallbacks that return `10` are changed to `0` so that
*numeric* premium reads also report a premium-tier value.

| file | what |
|---|---|
| `background.js` | service-worker state `fG6cU6.isPremium` (default) |
| `background.js` | `EUWdi4()` → `state.isPremium = premium < 1.1` |
| `background.js` | `cj9O5Q()` no-license premium value `10` → `0` |
| `background.js` | `cj9O5Q()` error-path premium value `10` → `0` |
| `content-scripts/main.js` | `SbOnXf` store `.isPremium` |
| `content-scripts/content.js` | store `.isPremium` (×2) |
| `chunks/main-D9uk0BkO.js` | `lr.value = premium < 1.1` (popup/options UI) |
| `chunks/main-D9uk0BkO.js` | `lr.value = false` → `true` (no-response path) |
| `chunks/Settings-3vmFYYj7.js` | `Tp4VdA.value = premium < 1.1` (settings UI) |

`lr` (main chunk) and `Tp4VdA` (settings chunk) are the **shared** premium
state read by `chunks/GatewaysSetting-DsAs5-Ri.js`,
`chunks/CustomGatewaysSetting-*.js` and `chunks/Unofficial-DSGqBefk.js` — so
patching the two producers unlocks every consumer. The individual panels never
need to be touched.

The license server is still contacted and its response is still verified
cryptographically. Only the final client-side *decision* is forced, so the
extension behaves as premium offline as well.

---

## "expected 1 occurrence(s) ... found 0"

The patcher only works on a **pristine** copy of Dot Bypasser 4.6.6. This
error means the folder you pointed it at is not one. The usual reasons:

| what you have | what to do |
|---|---|
| the folder is **already patched** (for example the `dot/` folder from a release ZIP) | nothing to do - load it in Chrome, or start from a fresh copy of the official release |
| the files come from a **build the patcher does not know yet** | add a profile for it (see "One patcher, many builds") - the patcher then works on it too |
| the folder is not an unpacked extension at all | extract the archive first, so you get a folder with `manifest.json` in it |

The known builds are listed in `tools/profiles.json`; the web page accepts
every one of them.

`tools/inspect.js` tells you which of the three it is:

```bash
node tools/inspect.js dot
```

```
tree: dot
  name    : Dot Bypasser
  version : 4.6.6
  files   : 30
  prelude : present (the tree is patched)
  premium : forced on (the tree is patched)

VERDICT: this tree is ALREADY PATCHED.
```

It compares every file with the checksums of the official release, so it also
tells you when the build is simply different.

If you would rather not touch a terminal at all, use the web page
(`npm run web`) - it checks the upload the same way and tells the user in
plain words what is wrong.

## One patcher, many builds

The obfuscator re-randomises its string tables with **every release**, so the
exact text of the premium gate is different in every build
(`chunks/main-D9uk0BkO.js` in one release, `chunks/main-2cPWhpKU.js` in the
next, and so on).

The patcher therefore works from **build profiles** (`tools/profiles.json`):
one profile per known build, holding the patch sites of that build. The
patcher looks at the tree, finds the profile that matches and applies it:

```
$ node unlock_dot.js dot
build     : 4.6.6-2026-10-27 (version 4.6.6)
app chunk : chunks/main-2cPWhpKU.js
[1/3] premium gate (12 sites)
  patched background.js  (1x)  ...
```

When the vendor ships a new build, the sites are found again by decoding the
string tables of that build:

```bash
node --experimental-vm-modules tools/emit_patches.js dot --save "<name>"
```

and the new profile is added to `tools/profiles.json`. The tool finds the
sites by their *meaning* (the property `isPremium`, the comparison against
the threshold 1.1, the fallback value 10), not by fixed text.

`node tools/inspect.js dot` says which build a folder is and which patch
sites are missing.

## Why step 3 exists (the black screen)

This is the part that is easy to get wrong, and the reason a naive edit
produces an extension that opens to a **black page** instead of the UI.

The bundle is `javascript-obfuscator` style, and every guarded function is
wrapped like this:

```js
function G(){var v=G.p||(G.p=VvCBdcb(T,N));
             if(v===C){return T(...arguments)}else{while(true){}}}
```

`VvCBdcb` hashes the **source text** of `T`. Editing `T` invalidates the
stored constant `C`, so the wrapper spins in `while(true){}` — the renderer
busy-loops and the extension page never paints. The main chunk has **341**
such guards.

So after editing anything inside a guarded function you must recompute that
function's expected constant:

```bash
node --experimental-vm-modules tools/fix_guards.js dot/chunks/main-D9uk0BkO.js
```

which reports:

```
   fixed imSIiSI: 5553490361431100 -> 8138264842955113
dot/chunks/main-D9uk0BkO.js: 341 guards OK (round 2)
```

`tools/audit_guards.js` re-checks every guard in a tree without modifying it:

```bash
node --experimental-vm-modules tools/audit_guards.js dot/chunks/*.js dot/background.js
# dot/chunks/main-D9uk0BkO.js: 341 guards, 0 MISMATCHED
```

**Diagnosing a black page.** The symptom is not a JS exception — it is
`Protocol error … Target closed` (the renderer is stuck in the loop). To
confirm the cause, audit the guards: a single mismatched constant is enough
to hang the whole UI. Note that CDP-driven runs can also be misleading
because the bundle contains anti-debugger traps that fire when an inspector
is attached; `chrome --headless=new --screenshot` (no CDP) is the reliable
check.

---

## Why the nag modal is neutralised

The stock extension shows a full-screen **"Unofficial Source / Join
Telegram"** modal over the entire UI if it detects that its own files were
modified.

On startup the **service worker** enumerates the manifest-declared scripts
(`background.js`, `content-scripts/content.js`, `content-scripts/main.js`),
fetches each one over `chrome-extension://`, SHA-256 hashes the raw response
bytes and compares them with the official release digests. Any differing file
trips the check.

The important detail: the probe compares **raw response bytes**. It is
satisfied as long as the bytes served *to the probe* are byte-identical to the
official release — it does not care what Chrome actually executes.

`unlock_dot.js` therefore injects a small prelude at the top of
`background.js` that wraps `fetch()` and, for exactly those three URLs,
returns the pristine official bytes. The pristine bytes are rebuilt at runtime
by reversing the patcher's own edits and stripping the prelude itself, so no
duplicate copies of the vendor's files need to be shipped.

Verified — with the patched tree, the probe computes digests byte-identical to
the official release:

```
222f2d3aad60c3f7624a76ef209275f56ad65dfa196e19c9c15675dd642306a4  background.js
e8c085a9709b81bcb1cc588bc2b0e28fae42287042a39b9e434fe00355a805a2  content-scripts/content.js
ae73090340002bee1c3aec5954aba0842f1189ac2f9a0ce77dd17260e5b2dd92  content-scripts/main.js
```

Check it yourself with `tools/probecheck.sh`.

Two details make this work and are easy to get wrong:

- **The patch strings must be unique.** The prelude reverses them by string
  replacement, so if a patched fragment occurs more than once the reversal is
  ambiguous and the served bytes no longer match. Every edit therefore keeps
  its unique left-hand side and only neutralises the always-false
  `|| !ONE` tail.
- **The prelude's own marker literals must not appear inside the prelude**, or
  stripping it would find the wrong copy. They are assembled from two parts at
  runtime for exactly that reason.

---

## Patch it from a browser (no terminal)

`web/` is a tiny website around the patcher: somebody who has never opened a
terminal drops the official extension on the page and gets the patched file
back.

```bash
npm install          # only needed for the optional browser check
npm run web          # -> http://localhost:8787
```

The page takes a `.zip` or a `.crx` of Dot Bypasser 4.6.6, patches it and
hands the result back as `dot-bypasser-unlocked.zip`. The page also explains
how to load it in Chrome, because that is the part people get stuck on.

```
   ┌──────────────┐   upload    ┌──────────────────┐
   │  the browser │ ──────────► │  patch-server.js │
   │   (the UI)   │             │  unpack_dot.js   │
   └──────────────┘             │  fix_guards.js   │
          ▲                     └──────────────────┘
          │   download                 │
          └───────────────────────────┘
                dot-bypasser-unlocked.zip
```

**Only the official release is accepted.** Repairing the obfuscator's
self-defending guards means *evaluating* the uploaded JavaScript, so an
unchecked upload would be remote code execution. The service therefore
compares every file of the upload with the sha256 list in
`web/official-files.json` and refuses anything else with a clear message.

```
node web/test.js      # the whole chain: upload -> patch -> load in Chrome
```

The test uploads the official extension as a `.zip` and as a `.crx`, checks
that the returned archive carries the patched files, and loads it in headless
Chrome to confirm it really is unlocked (0 lock icons, premium badge, no
"Unofficial Source" modal).

To offer it to others, put it behind a reverse proxy with TLS:

```bash
HOST=0.0.0.0 PORT=80 node web/patch-server.js
```

## Unlocking a different extension (Asheo 1.6.2)

The same idea works for other extensions. Asheo (also an MV3 extension, also
obfuscated, also with a signed build attestation) is unlocked with

```bash
node tools/asheo_unlock.js ../asheo-latest
```

Asheo gates the premium tier in **three** places, not one. All of them have
to go, otherwise a feature is unlocked in the list but refuses to switch on:

| file | what |
|---|---|
| `functions/premium-gate.js` | `can()` and `require()` always allow, `getEntitlement()` returns the premium entitlement, the plan object reports the premium tier |
| `functions/license-client.js` | the license status reports the premium tier |
| `functions/background.js` | the worker's own premium checks see a premium entitlement; a small prelude reports the premium tier in every answer |
| `functions/build-attest.js` | the per-file hash comparison is skipped |

**What is deliberately *not* patched:** the cached entitlement that the
worker sends to the vendor's server, and the activation token. Those are
what the server sees, and faking them makes the server refuse:

```
No payment rules found.          <- the worker asked for the premium rule pack
Timeout: entitlement.refresh     <- the worker sent a token the server rejects
```

The worker keeps talking to the server with the real (free tier) state, so
the rule pack downloads normally (45 rules) and the entitlement refresh
answers normally - and the premium tier is applied to what the *popup* sees
and to the feature activations.

The three gates, in the order the extension meets them:

| gate | how it shows up |
|---|---|
| the entitlement | `{action:"entitlement.can"}` -> `{allowed:false}` |
| the activation | `{action:"browsermod.setEnabled"}` -> `{success:false, reason:"premium_required", message:"This is a premium feature."}` |
| the activation token | the same action -> `{success:false, reason:"activation_failed", message:"Premium check failed. Try again."}` |

### Why the toggle stayed on "Off"

The popup said "Browser modifications enabled" but the pill stayed on
"Off". Two different gates were in the way, and both live in the worker:

1. `premiumGate.require()` answers with an *object*
   (`{ok:false, reason:"premium_required"}`), not a boolean. Patching it to
   the bare `true` makes the worker read `ok` as `undefined` and treat the
   answer as a failure.
2. after `require()` says ok, the worker reads the cached verified
   entitlement and refuses the feature unless `ent.tier === "premium"` and
   the feature flag is on:

   ```js
   const ent = await getCachedVerifiedEntitlement().catch(()=>null);
   if (!ent || ent.tier !== "premium" || ent.features.browserMods !== true) {
     answer({success:false, reason:"premium_required",
             message:"This is a premium feature."});
     return;                       // <-- returns BEFORE the setting is saved
   }
   ```

   Without a license on file that getter yields `null`, so the worker
   answers "This is a premium feature." and returns before it saves the
   setting. The popup ignored that failure and showed the success message,
   which is why it looked like it had worked.

The fix answers the *local* read - the 18 sites that use the
`.catch(()=>null)` form - with a premium entitlement, and leaves the getter
itself alone. The getter is also what the worker sends to the server: a
"premium" tier there makes the server refuse the premium rule pack and the
extension ends up with no payment rules at all.

The prelude in `functions/background.js` additionally reports the premium
tier in every answer, so a manual entitlement refresh does not flip the
popup back to "free".

The entitlement shape was captured from the running extension (`{action:
"premium.get"}`):

```json
{ "tier": "free", "source": "license", "isFounder": false,
  "features": { "browserMods": false, "ruleOpsLab": false, "liveHud": false,
                "advancedProtection": false, "apiAccess": false,
                "experimentalFeatures": false },
  "capabilities": { "customEncryptedGateways": false, "binGenerator": false,
                     "adyenGateway": false },
  "limits": { "binPool": 2, "ccQueue": 10, "ruleLimit": 20,
              "profileLimit": 2, "randomRouting": false },
  "plan": "free", "planDisplayName": "Free", "licenseType": "free",
  "status": "inactive" }
```

...and the patched build reports `tier: "premium"` with every feature and
capability enabled.

**About the build attestation.** Asheo ships `build-hashes.json` (a list of
every packaged file with its sha256) plus an ES256 signature over it, made
with a key that only exists on the release machine. Editing any file makes the
*signature* check fail and the extension locks itself down. But the signature
covers the **manifest** (`build-hashes.json`), not the files themselves - so
only the per-file hash comparison has to go. The signature check stays, the
digest the extension reports to the vendor's server is still the genuine one,
and the extension does not notice the modification.

Verification:

```bash
node harness/asheo.js ../asheo-latest        # before
node harness/asheo.js ../asheo-patched        # after -> "Premium active - all features unlocked."
node harness/asheo_trace.js ../asheo-patched  # the premium.get answer
node harness/asheo_feature.js ../asheo-patched  # click every premium toggle
```

`asheo_feature.js` clicks the toggles of the premium panel and prints what the
worker answers - before the patch:

```
Enable persona: FAIL "Premium check failed. Try again."
      got : {"success":false,"reason":"activation_failed","feature":"browserMods",...}
```

after the patch:

```
Enable persona: ok
      got : {"success":true,"reason":"unlocked","feature":"browserMods","message":"Activated."}
```

And the setting actually sticks - the pill goes "Off" -> "On" and stays
there across a reload of the popup:

```
pill: Off -> On | after reload: On
getState.enabled = true
asheo.browsermod.config.v1  {"enabled":true, ...}
asheo.hud.enabled.v1        true
PAYMENT RULES 45/45
Premium active - all features unlocked.
```

The dashboard reads `PAYMENT RULES 45/45` and `Premium active - all features
unlocked.` at the same time - the rule pack still comes from the vendor's
server, the premium tier is local.

## Repo layout

```
unlock_dot.js            the patcher: premium edits + anti-tamper prelude
build_zip.js              packages an extension tree into dot-unlocked.zip
UNLOCK_NOTES.md           full technical write-up (gate, guards, nag)

web/
  patch-server.js         the patch website (upload -> patched download)
  index.html              its page
  lib/zip.js              dependency free zip reader/writer
  official-files.json     sha256 of the official release (upload validation)
  test.js                 end to end test, including a real Chrome check

tools/
  asheo_unlock.js         unlock the premium tier of the Asheo extension
  decode_strings.mjs      decode an obfuscated module's string table
  fix_guards.js           recompute + rewrite self-defending guard constants
  audit_guards.js         verify every guard constant in a tree
  emit_patches.js         find the premium gate of any build (new profiles)
  profiles.js             load the build profiles and match a tree against them
  profiles.json           the known builds and their patch sites
  inspect.js              explain what a tree contains (and what is wrong with it)
  mprobe.js               evaluate expressions inside a module's own scope
  tbl.js tbl2.js tbl3.js  dump the obfuscated string tables
  cfg.js                  extract the embedded hash-algorithm configuration
  probecheck.sh           verify the anti-tamper probe sees the official bytes

harness/                  puppeteer verification (headless Chrome)
  final.js                the main check: locks, disabled inputs, badge, nag
  probe.js                check that the anti-tamper probe sees official bytes
  asheo.js                load the Asheo popup and report what is locked
  asheo_trace.js          trace the popup's runtime messages and answers
  clickall.js             click every button so all panels/modals mount
  readtrace.js            read a trace the background wrote to chrome.storage
  shot.js                 screenshot the UI
  badge.js disabled.js    targeted DOM assertions
  test3.js dump_dom.js    render check / raw DOM dump
```

---

## Notes and limitations

- The patch is **client-side only**. The license server is still contacted and
  its response still verified; only the final comparison is forced true.
- The anti-tamper probe is *neutralised*, not removed: it still runs and still
  sees the official bytes. That keeps the extension's own startup path intact
  and avoids patching the guard chain a second time.
- The extension ID is fixed by the manifest `key`
  (`njkdeekcjnbkngichbifiednjoibhnon`), so a patched build keeps the same ID
  and the same settings as the stock install.
- `unlock_dot.js` verifies the expected occurrence count of every edit and
  aborts if it does not match, so a version bump fails loudly instead of
  silently producing a half-patched tree.

---

## Legal

This repository contains **only tooling and analysis notes** (MIT, see
`LICENSE`). It does not contain the Dot Bypasser extension itself — you
supply your own copy of the official release, and the tools modify it locally
on your machine.

Dot Bypasser is third-party software by its respective authors; it is not
affiliated with or endorsed by this project. Use it only in accordance with
its licence and with applicable law, and only for legitimate purposes you
are authorised to carry out.
