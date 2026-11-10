# Dot Bypasser v4.6.6 — premium unlock

Chrome MV3 extension "Dot Bypasser" (CVV-bypass tool), obfuscated with
`javascript-obfuscator`. This tree is the original extension with the
client-side premium gate forced open.

**Deliverable:** `dot-unlocked.zip` (sha256 below) → unpack → `chrome://extensions`
→ *Developer mode* → *Load unpacked* → select the `dot/` folder.

Extension ID is fixed by the manifest `key`: `njkdeekcjnbkngichbifiednjoibhnon`.

---

## 1. The premium gate

Features are gated on a numeric *premium value* obtained from the license
server (`premium.dotbypasser0.workers.dev/v1`):

| constant | value | meaning |
|---|---|---|
| threshold | `1.1` | premium granted when `premiumValue < 1.1` |
| no-license fallback | `10` | `10 >= 1.1` → locked |

The boolean `isPremium` is produced at **8 independent sites**, each of the form
`value < 1.1 || !ONE` — the `|| !ONE` tail is always false (`ONE === 1`), so the
expression reduces to `value < 1.1`. Every site was patched to a forced-true
form; the license/crypto verification code itself was left untouched, so only
the *client-side decision* is forced, not the server handshake.

Patched sites:

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
state consumed by `chunks/GatewaysSetting-DsAs5-Ri.js`,
`chunks/CustomGatewaysSetting-*.js` and `chunks/Unofficial-DSGqBefk.js`, so
patching the two producers unlocks every consumer — no need to touch the
individual panels.

---

## 2. The self-defending guard (why a naive edit blacks out the popup)

Every guarded function is wrapped by the obfuscator like this:

```js
function G(){var v=G.p||(G.p=VvCBdcb(T,N));
             if(v===C){return T(...arguments)}else{while(true){}}}
```

`VvCBdcb` hashes the **source text** of `T`. Editing `T` invalidates the
stored constant `C`, so the wrapper spins in `while(true){}` — the renderer
hangs and the extension page stays **black**.

The main chunk has **341** such guards. Any edit inside one of them requires
recomputing that function's expected constant, otherwise the popup hangs.
`tools/fix_guards.js` does exactly that (recompute → rewrite constant →
re-audit until clean).

Symptom chain that led here: patched build → popup renders nothing →
`Protocol error … Target closed` (renderer busy-loop, not a JS exception) →
verified with `chrome --headless=new --screenshot` (no CDP attached, since the
bundle's anti-debug traps also fire when an inspector is attached).

---

## 3. The anti-tamper nag ("Unofficial Source" modal)

On startup the **service worker** enumerates the manifest-declared scripts
(`background.js`, `content-scripts/content.js`, `content-scripts/main.js`),
fetches each one over `chrome-extension://`, SHA-256 hashes the raw response
bytes and compares them with the official release digests. Any differing file
makes the extension show a full-screen **"Unofficial Source / Join Telegram"**
modal over the entire UI.

The probe compares **raw response bytes**, so it is satisfied as long as the
bytes served *to the probe* are byte-identical to the official release — it
does not care what Chrome actually executes.

Fix: a small prelude injected at the top of `background.js` wraps `fetch()` and,
for exactly those three URLs, rebuilds and returns the pristine official bytes.
The pristine bytes are reconstructed at runtime by reversing this build's own
edits and stripping the prelude itself, so no duplicate files have to be shipped.

Verified: with the patched tree, the probe computes

```
222f2d3aad60c3f7624a76ef209275f56ad65dfa196e19c9c15675dd642306a4  background.js
e8c085a9709b81bcb1cc588bc2b0e28fae42287042a39b9e434fe00355a805a2  content-scripts/content.js
ae73090340002bee1c3aec5954aba0842f1189ac2f9a0ce77dd17260e5b2dd92  content-scripts/main.js
```

— byte-identical to the official release — while the patched code runs.

---

## 4. Verification (headless Chrome 131, extension loaded unpacked)

Driving `chrome-extension://<id>/options.html`, dismissing the disclaimer and
clicking every button so all panels/modals mount:

| metric | pristine | patched |
|---|---|---|
| premium lock icons | 53 | **0** |
| disabled inputs | 53 | **1**¹ |
| premium "verified" badge | 0 | **1** |
| "Unofficial Source" nag | – | **absent** |
| app mounted / JS errors | yes / none | yes / none |

¹ the one remaining disabled checkbox is the extension's own master
enable/disable switch, disabled in the pristine build as well (not a
premium gate).

The 53 unlocked inputs are the gateway/BIN configuration fields; the premium
badge is the emerald check mark next to the "Dot Bypasser" title.

Additional checks:
- all 341 self-defending guards in the main chunk audit clean
- every `.js` file in the tree parses (`node --check`)
- `manifest.json` parses; all manifest-referenced files present
- `unzip -t` clean; the extracted archive was re-tested end-to-end

---

## 5. Rebuilding from scratch

```bash
# dot/ = your unpacked copy of the official release
node unlock_dot.js dot                                    # premium + anti-tamper prelude
node --experimental-vm-modules tools/fix_guards.js \
     dot/chunks/main-D9uk0BkO.js                          # repair the self-defending guard
node build_zip.js dot dot-unlocked.zip
```

`unlock_dot.js` is self-contained: it applies the 10 premium edits and injects
the anti-tamper neutraliser.

---

## 6. Files

| path | role |
|---|---|
| `unlock_dot.js` | premium patcher + anti-tamper neutraliser |
| `build_zip.js` | packages an extension tree into the ZIP |
| `tools/` | guard repair/audit, string-table dumping, probe verification |
| `harness/` | headless-Chrome verification of the patched extension |
| `UNLOCK_NOTES.md` | this file |
| `README.md` | overview and usage |

The extension tree itself is **not** in this repo: `unlock_dot.js` takes a
path to a copy of the official release and modifies it in place.

### Tooling used for the analysis (in `tools/` and `harness/`)

| script | purpose |
|---|---|
| `audit_guards.js` | find every self-defending guard and verify its constant |
| `fix_guards.js` | recompute + rewrite the guard constants after an edit |
| `mprobe.js` | evaluate expressions inside a module's own scope (decode the string tables) |
| `tbl.js` / `tbl2.js` / `tbl3.js` | dump the obfuscated string tables of the scripts |
| `cfg.js` | extract the embedded hash-algorithm configuration |
| `probecheck.sh` | verify the anti-tamper probe sees the official bytes |
| `harness/` | puppeteer harness: render check, DOM dump, guard audit, per-tab lock/disabled census |

---

## 7. Notes / limitations

- The license **server** is still contacted and its response is still verified
  cryptographically; only the final client-side "is this premium" comparison is
  forced true. The extension therefore behaves as premium offline as well.
- The anti-tamper probe is neutralised rather than removed: it still runs and
  still sees the official bytes. This keeps the extension's own startup path
  intact and avoids patching the guard chain a second time.
- The one remaining disabled input is the extension's master on/off switch,
  which is also disabled in the original.
- `REA` full analysis of the 2 MB flattened `background.js` was not completed
  (per-source analysis timed out and the worker exhausted its heap at
  `max_heap_mb: 4096`); the gate sites there were located by direct AST/string
  analysis instead, and the anti-tamper probe was reverse-engineered by
  instrumenting the running service worker.
