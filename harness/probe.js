/*
 * Anti-tamper probe check.
 *
 * The service worker fetches its own manifest-declared scripts, hashes the raw
 * response bytes and compares them with the official release digests. If a
 * single byte differs, the extension shows the full screen "Unofficial Source"
 * modal.
 *
 * This harness copies the patched tree, injects a tracer into the prelude
 * region (which is stripped again before the bytes are served), loads the
 * extension and reads the digests the probe computed.
 *
 * The expected digests come from the build profile that matches the tree, so
 * this works for every known release.
 *
 * Usage: node harness/probe.js <extension-dir>
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT = path.resolve(process.argv[2] || 'dot');
const { identifyProfile } = require('../tools/profiles.js');

const PROBED = ['background.js', 'content-scripts/content.js', 'content-scripts/main.js'];

const profile = identifyProfile(EXT);
if (!profile) {
  console.log('no build profile matches ' + EXT + ' - run tools/inspect.js');
  process.exit(1);
}
const OFFICIAL = {};
for (const f of PROBED) OFFICIAL[f] = profile.files[f];
console.log('build profile: ' + profile.name);

const HOOK = `
;(function(){
  var T = chrome.storage && chrome.storage.local;
  function rec(e){ if(!T) return; try{ T.get('__trace').then(function(g){var a=(g&&g.__trace)||[];a.push(e);T.set({'__trace':a.slice(-40)});}); }catch(e){} }
  var oj = Array.prototype.join;
  Array.prototype.join = function(sep){
    var r = oj.call(this, sep);
    try { if (typeof r === 'string' && /^[0-9a-f]{64}$/.test(r)) rec(r); } catch(e){}
    return r;
  };
})();
`;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-probe-'));
  fs.cpSync(EXT, path.join(tmp, 'ext'), { recursive: true });
  const bg = path.join(tmp, 'ext', 'background.js');
  let src = fs.readFileSync(bg, 'utf8');
  const END = '/*__DOTBYPASS_PRELUDE_END__*/';
  if (src.split(END).length - 1 !== 1) {
    console.log('no prelude in the tree - run unlock_dot.js first');
    process.exit(1);
  }
  src = src.replace(END, HOOK + END);
  fs.writeFileSync(bg, src);

  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 30000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      `--disable-extensions-except=${path.join(tmp, 'ext')}`, `--load-extension=${path.join(tmp, 'ext')}`],
  });
  await new Promise((r) => setTimeout(r, 3000));
  let id = null;
  for (const t of await browser.targets()) {
    if (t.url().startsWith('chrome-extension://')) { id = t.url().split('/')[2]; break; }
  }
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${id}/options.html`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 8000));

  const trace = await page.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return all.__trace || [];
  });

  const seen = trace.filter((t) => /^[0-9a-f]{64}$/.test(t));
  const digests = new Set(seen);
  console.log('digests seen by the probe:');
  for (const d of seen) console.log('  ' + d);

  let ok = true;
  for (const [file, want] of Object.entries(OFFICIAL)) {
    const hit = digests.has(want);
    console.log(`  ${hit ? 'ok  ' : 'FAIL'} ${file}`);
    if (!hit) ok = false;
  }
  if (seen.length !== Object.keys(OFFICIAL).length) {
    console.log('  note: the probe reported ' + seen.length + ' digest(s), expected ' + Object.keys(OFFICIAL).length);
  }

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(ok ? '\nPROBE SEES THE OFFICIAL BYTES' : '\nPROBE MISMATCH');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
