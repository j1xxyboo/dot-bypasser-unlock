#!/usr/bin/env node
/*
 * Dot Bypasser v4.6.6 — premium/locked-feature unlocker (final builder).
 *
 * ---------------------------------------------------------------------------
 * 1. How the premium gate works
 * ---------------------------------------------------------------------------
 * The extension gates features on a numeric "premium" value obtained from the
 * license server (premium.dotbypasser0.workers.dev/v1):
 *
 *     threshold constant = 1.1      (mIno9Zz[0x874] / U6epo37[0x3c1] / literal 1.1)
 *     premium granted when         premiumValue < 1.1
 *     no-license fallback value = 10 (mIno9Zz[0x16d])  -> 10 >= 1.1 -> locked
 *
 * The boolean "isPremium" flag is produced at 8 independent sites, each of the
 * form `value < 1.1 || !ONE` (the `|| !ONE` part is always false because
 * ONE === 1). Each site is patched to a forced-true expression, so the flag
 * is true regardless of what the server returns.
 *
 * Patched sites:
 *     background.js               service-worker state fG6cU6.isPremium (default)
 *     background.js               EUWdi4()  -> state.isPremium = premium < 1.1
 *     background.js               cj9O5Q()  -> no-license premium value 10 -> 0
 *     background.js               cj9O5Q()  -> error-path premium value 10 -> 0
 *     content-scripts/main.js     SbOnXf store .isPremium
 *     content-scripts/content.js  store .isPremium   (x2)
 *     chunks/main-D9uk0BkO.js     lr.value = premium < 1.1   (popup/options UI)
 *     chunks/main-D9uk0BkO.js     lr.value = false          (no-response path)
 *     chunks/Settings-3vmFYYj7.js Tp4VdA.value = premium < 1.1 (settings UI)
 *
 * The Vue refs `lr` (main chunk) and `Tp4VdA` (settings chunk) are the shared
 * premium state consumed by chunks/GatewaysSetting-DsAs5-Ri.js and
 * chunks/CustomGatewaysSetting-*.js, so patching the two producers unlocks
 * every consumer. The crypto / license-verification code is left untouched:
 * only the client-side "is this premium" decision is forced.
 *
 * ---------------------------------------------------------------------------
 * 2. The self-defending integrity guard (why a naive edit hangs the popup)
 * ---------------------------------------------------------------------------
 * The bundle is javascript-obfuscator style and every guarded function is
 * wrapped in:
 *
 *     function G(){var v=G.p||(G.p=VvCBdcb(T,N));
 *                  if(v===C){return T(...arguments)}else{while(true){}}}
 *
 * VvCBdcb hashes the *source text* of T. Editing T invalidates the stored
 * constant C, so the wrapper spins in `while(true){}` and the renderer hangs
 * (black popup). Any edit inside a guarded function therefore requires
 * recomputing that function's expected constant. `fix_guards.js` does that.
 *
 * ---------------------------------------------------------------------------
 * 3. The anti-tamper nag ("Unofficial Source" modal)
 * ---------------------------------------------------------------------------
 * On startup the service worker enumerates the manifest-declared scripts
 * (background.js, content-scripts/content.js, content-scripts/main.js), fetches
 * each one over chrome-extension://, SHA-256 hashes the raw response bytes and
 * compares them with the official release digests. If any file differs, the
 * extension shows a full-screen "Unofficial Source / Join Telegram" modal over
 * the entire UI.
 *
 * The probe compares raw response bytes, so it is satisfied as long as the
 * bytes served to the probe are byte-identical to the official release — it
 * does not care what Chrome actually executes.
 *
 * Fix: a small prelude injected into background.js intercepts fetch() for
 * exactly those three URLs and returns the pristine original bytes (rebuilt by
 * reversing this script's own edits, so no extra files have to be shipped).
 * The probe therefore sees the untouched official files, the nag never
 * appears, and the patched code still runs.
 */
const fs = require('fs');
const path = require('path');

/*
 * Usage:
 *   node unlock_dot.js <extension-dir>
 *
 * <extension-dir> is a copy of the official Dot Bypasser 4.6.6 unpacked
 * extension. It is modified in place.
 */
const ROOT = path.resolve(process.argv[2] || 'dot');

/* Forced-true replacements. `!0` === true.
 *
 * IMPORTANT: every `replace` string must stay unique inside its file, because
 * the anti-tamper neutraliser reverses these exact edits to rebuild the
 * pristine official bytes. So the unique left-hand side is kept and only the
 * always-false `|| !ONE` tail is neutralised. */
const PATCHES = [
  {
    file: 'background.js',
    // const fG6cU6 = { ["isPremium"]: !mIno9Zz[0x3], ... }   (mIno9Zz[0x3] === 1 -> false)
    find: '[q_7LT1h(mIno9Zz[0x870])+q_7LT1h(mIno9Zz[0x871])]:!mIno9Zz[0x3]',
    replace: '[q_7LT1h(mIno9Zz[0x870])+q_7LT1h(mIno9Zz[0x871])]:!0',
  },
  {
    file: 'background.js',
    // EUWdi4(): state.isPremium = premium < 1.1 || !mIno9Zz[0x3]
    find: ']=s7wPzlV<mIno9Zz[0x874]||!mIno9Zz[0x3]}',
    replace: ']=s7wPzlV<mIno9Zz[0x874]||!0}',
  },
  {
    file: 'content-scripts/main.js',
    // SbOnXf[...].isPremium = premium < 1.1 || !ZRc3uM[0x3]
    find: '=Z6xg7it<1.1||!ZRc3uM[0x3]}',
    replace: '=Z6xg7it<1.1||!0}',
  },
  {
    file: 'content-scripts/content.js',
    // BeU25HX[...].isPremium = premium < 1.1 || !U6epo37[0x3]
    find: '=Kg6FMg2<U6epo37[0x3c1]||!U6epo37[0x3]}',
    replace: '=Kg6FMg2<U6epo37[0x3c1]||!0}',
  },
  {
    file: 'content-scripts/content.js',
    // od9dIn[...].isPremium = premium < 1.1 || !U6epo37[0x3]
    find: '=qFSNyY<U6epo37[0x3c1]||!U6epo37[0x3]}',
    replace: '=qFSNyY<U6epo37[0x3c1]||!0}',
  },
  {
    file: 'chunks/main-D9uk0BkO.js',
    // lr.value = premium < 1.1 || !UdZOaAF[0x4]   (popup / options UI premium ref)
    find: '=Bdwbpn8<1.1||!UdZOaAF[0x4]}',
    replace: '=Bdwbpn8<1.1||!0}',
  },
  {
    file: 'chunks/main-D9uk0BkO.js',
    // lr.value = false  ->  lr.value = true   (no-response fallback path)
    find: 'lr[NF0xd1l(UdZOaAF[0x79b])]=!UdZOaAF[0x4];return}',
    replace: 'lr[NF0xd1l(UdZOaAF[0x79b])]=!0;return}',
  },
  {
    file: 'chunks/Settings-3vmFYYj7.js',
    // Tp4VdA.value = premium < 1.1 || !ix2qAS[0x4]   (settings premium ref)
    find: '=__Uint8Array<1.1||!ix2qAS[0x4]',
    replace: '=__Uint8Array<1.1||!0',
  },
];

/* Fallback "premium" numeric value 10 -> 0 so that any *numeric* premium read
 * (not just the boolean) also reports a premium-tier value. */
const VALUE_PATCHES = [
  {
    file: 'background.js',
    // cj9O5Q() no-license / invalid-license return: { premium: 10, reason: ... }
    find: 'mIno9Zz[0x2b7])+mIno9Zz[0x113]]:mIno9Zz[0x16d]',
    replace: 'mIno9Zz[0x2b7])+mIno9Zz[0x113]]:0',
  },
  {
    file: 'background.js',
    // cj9O5Q() error path: { [im74KS(...)]: 10, reason: ... }
    find: 'im74KS(mIno9Zz[0x2d2])+mIno9Zz[0x113]]:mIno9Zz[0x16d]',
    replace: 'im74KS(mIno9Zz[0x2d2])+mIno9Zz[0x113]]:0',
  },
];

/* ---------------------------------------------------------------------------
 * The anti-tamper probe prelude.
 *
 * It is injected at the very top of background.js. Two jobs:
 *   (a) when the SW fetches one of the three manifest-declared scripts, return
 *       the pristine official bytes instead;
 *   (b) be removable again, so that serving background.js itself can return
 *       the pristine official background.js.
 *
 * The pristine bytes are rebuilt at runtime by reversing this script's own
 * edits on the fetched text (patch sites) and stripping this prelude. The
 * result is byte-identical to the official release, so the probe's SHA-256
 * matches.
 * ---------------------------------------------------------------------------
 */
const START = '/*__DOTBYPASS_PRELUDE_START__*/';
const END = '/*__DOTBYPASS_PRELUDE_END__*/';

function buildPrelude(revertMap) {
  return `${START}
;(function(){
  var MAP = ${JSON.stringify(revertMap)};
  /* The marker literals are assembled from parts so that they do not appear
   * verbatim inside this prelude - otherwise stripping the prelude from the
   * served background.js would find the copy inside the prelude first. */
  var S = '/*__DOTBYPASS_PRE' + 'LUDE_START__*/';
  var E = '/*__DOTBYPASS_PRE' + 'LUDE_END__*/';
  function revert(text, file) {
    var edits = MAP[file];
    if (!edits) return text;
    for (var i = 0; i < edits.length; i++) {
      text = text.split(edits[i][0]).join(edits[i][1]);
    }
    return text;
  }
  function targetOf(url) {
    try {
      var s = String(url);
      var m = s.match(/^chrome-extension:\\/\\/[^/]+\\/(.+)$/);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }
  try {
    var of = self.fetch.bind(self);
    self.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input
               : (input && typeof input.url === 'string') ? input.url : null;
      var file = url ? targetOf(url) : null;
      if (!file || !MAP[file]) return of(input, init);
      return of(input, init).then(function (res) {
        return res.text().then(function (text) {
          if (file === 'background.js') {
            var a = text.indexOf(S);
            var b = text.indexOf(E);
            if (a !== -1 && b !== -1) text = text.slice(0, a) + text.slice(b + E.length);
          }
          text = revert(text, file);
          return new Response(text, {
            status: 200,
            statusText: 'OK',
            headers: { 'Content-Type': 'application/javascript; charset=utf-8' }
          });
        });
      });
    };
  } catch (e) {}
})();
${END}`;
}

function apply(file, find, replace, expected) {
  const p = path.join(ROOT, file);
  let src = fs.readFileSync(p, 'utf8');
  const count = src.split(find).length - 1;
  if (count !== expected) {
    throw new Error(
      `${file}: expected ${expected} occurrence(s) of ${JSON.stringify(find.slice(0, 70))}, found ${count}`
    );
  }
  fs.writeFileSync(p, src.split(find).join(replace));
  console.log(`  patched ${file}  (${count}x)  ${JSON.stringify(find.slice(0, 60))}`);
}

console.log('Dot Bypasser v4.6.6 - unlocking premium / locked features');
console.log('target:', ROOT);

console.log('[1/4] premium comparison sites');
for (const p of PATCHES) apply(p.file, p.find, p.replace, 1);

console.log('[2/4] premium fallback values');
for (const p of VALUE_PATCHES) apply(p.file, p.find, p.replace, 1);

console.log('[3/4] anti-tamper probe neutraliser');
{
  // revert map: file -> list of [patched, original]
  const revertMap = {};
  for (const p of [...PATCHES, ...VALUE_PATCHES]) {
    (revertMap[p.file] = revertMap[p.file] || []).push([p.replace, p.find]);
  }
  const p = path.join(ROOT, 'background.js');
  let src = fs.readFileSync(p, 'utf8');
  if (src.includes(START)) {
    console.log('  prelude already present, replacing');
    const a = src.indexOf(START);
    const b = src.indexOf(END);
    src = src.slice(0, a) + src.slice(b + END.length);
  }
  fs.writeFileSync(p, buildPrelude(revertMap) + src);
  console.log('  injected probe neutraliser into background.js');
}

console.log('[4/4] done.');
console.log('');
console.log('next:');
console.log('  node --experimental-vm-modules tools/fix_guards.js ' +
  path.join(ROOT, 'chunks/main-D9uk0BkO.js'));
console.log('  node build_zip.js ' + ROOT + ' dot-unlocked.zip');
