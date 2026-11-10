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

/*
 * The patch sites.
 *
 * The obfuscator re-randomises its string tables with every build, so the
 * sites are different in every release. They are therefore kept as *profiles*
 * (tools/profiles.json), one per known build, and the right one is picked by
 * looking at the files in the tree.
 *
 * A new profile is created with:
 *
 *     node --experimental-vm-modules tools/emit_patches.js <extension-dir> \
 *          --save "<name>"
 *
 * which finds the sites by decoding the string tables of the build.
 */
const { load: loadProfiles, profileMatches, pickProfile } = require('./tools/profiles.js');
const PROFILES = loadProfiles();

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

/**
 * Everything the patcher changes, in one list, so that tools/inspect.js can
 * report on it without duplicating the patterns.
 */
/* ------------------------------------------------------------------ main */

function main() {
  console.log('Dot Bypasser - unlocking premium / locked features');
  console.log('target:', ROOT);

  // a tree that was patched before is not an error - say so and stop
  {
    const bgFile = path.join(ROOT, 'background.js');
    if (!fs.existsSync(path.join(ROOT, 'manifest.json')) || !fs.existsSync(bgFile)) {
      throw new Error(
        'there is no unpacked extension in ' + ROOT +
        ' (manifest.json and background.js are missing).\n' +
        '  Extract the archive first, so that you get a folder with manifest.json in it,\n' +
        '  and point the patcher at that folder.'
      );
    }
    const bg = fs.readFileSync(bgFile, 'utf8');
    if (bg.includes(START)) {
      // the prelude is only ever added by this patcher
      console.log('');
      console.log('This tree is already patched.');
      console.log('  Load the "' + path.basename(ROOT) + '" folder in Chrome, or start from a fresh');
      console.log('  copy of the official release if you want to patch it again.');
      console.log('');
      console.log('  (node tools/inspect.js ' + ROOT + ' explains what a tree contains)');
      return;
    }
  }

  const profile = pickProfile(ROOT);
  if (!profile) {
    throw new Error(
      'this build of the extension is not known to the patcher.\n' +
      '  The premium gate moved, so the patch sites have to be found again:\n' +
      '    node --experimental-vm-modules tools/emit_patches.js ' + ROOT + ' --save "<name>"\n' +
      '  and add the result to tools/profiles.json.'
    );
  }

  console.log('build     : ' + profile.name + (profile.version ? ' (version ' + profile.version + ')' : ''));
  console.log('app chunk : ' + (profile.appChunk || '(unknown)'));
  console.log('[1/3] premium gate (' + profile.patches.length + ' sites)');
  for (const site of profile.patches) {
    apply(site.file, site.find, site.replace, 1);
  }

  console.log('[2/3] anti-tamper probe neutraliser');
  {
    // revert map: file -> list of [patched, original]
    const revertMap = {};
    for (const site of profile.patches) {
      (revertMap[site.file] = revertMap[site.file] || []).push([site.replace, site.find]);
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

  console.log('[3/3] done.');
  console.log('');
  console.log('next:');
  console.log('  node --experimental-vm-modules tools/fix_guards.js ' + ROOT);
  console.log('  node build_zip.js ' + ROOT + ' dot-unlocked.zip');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('');
    console.error('Could not patch ' + ROOT + ': ' + e.message);
    console.error('');
    console.error('What to check:');
    console.error('  node tools/inspect.js ' + ROOT);
    console.error('');
    console.error('It prints the extension version, whether the tree is already patched and');
    console.error('which patch sites are missing. The patcher only works on a pristine copy of');
    console.error('Dot Bypasser 4.6.6 (the release it was written for).');
    console.error('');
    console.error('If you do not want to use the command line at all, use the web page:');
    console.error('  npm run web      ->  http://localhost:8787');
    console.error('');
    process.exit(1);
  }
}

module.exports = { PROFILES, pickProfile, profileMatches, START, END };
