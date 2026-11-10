#!/usr/bin/env node
/*
 * Inspect an extension tree and say what is wrong with it.
 *
 *   node tools/inspect.js dot
 *
 * It answers the questions that come up when the patcher refuses to run:
 *
 *   - is this the Dot Bypasser extension at all, and which version?
 *   - is the tree pristine, already patched, or from a different build?
 *   - which patch sites are missing?
 *
 * The digests in web/official-files.json are used to tell an official release
 * apart from a repackaged one (the Chrome Web Store build, for example, is
 * not byte identical to the release the patcher was written for).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || 'dot');

const { load: loadProfiles } = require('./profiles.js');
const PROFILES = loadProfiles();

const sha256 = (buf) => require('crypto').createHash('sha256').update(buf).digest('hex');
const { identifyProfile } = require('./profiles.js');
const profile = identifyProfile(ROOT);

const read = (rel) => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

console.log('tree:', ROOT);

/* --- what is this? --------------------------------------------------- */

const manifestRaw = read('manifest.json');
if (!manifestRaw) {
  console.log('\n  X  no manifest.json - this is not an unpacked extension');
  process.exit(1);
}
let manifest = {};
try {
  manifest = JSON.parse(manifestRaw);
} catch (e) {
  console.log('\n  X  manifest.json is not valid JSON');
  process.exit(1);
}
console.log('  name    :', manifest.name);
console.log('  version :', manifest.version);
console.log('  id      :', manifest.key ? 'fixed (manifest key present)' : 'not fixed');

if (manifest.version && !PROFILES.some((p) => p.version === manifest.version)) {
  console.log(`  !  no known profile has version ${manifest.version}`);
}

/* --- how many files? -------------------------------------------------- */

const walk = (dir, prefix = '') => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
};
const files = fs.existsSync(ROOT) ? walk(ROOT) : [];
console.log('  files   :', files.length);

/* --- already patched? ------------------------------------------------- */

const bg = read('background.js');
const hasPrelude = bg ? bg.includes('/*__DOTBYPASS_PRELUDE_START__*/') : false;
// the forced premium flag is one of the profile's patch sites
const premiumSite = profile
  ? (profile.patches || []).find((x) => x.label === 'isPremium default' && x.file === 'background.js')
  : null;
const premiumForced = premiumSite && bg ? bg.includes(premiumSite.replace) : false;
console.log('  prelude :', hasPrelude ? 'present (the tree is patched)' : 'absent (pristine)');
console.log('  premium :', premiumForced ? 'forced on (the tree is patched)' : 'not forced (pristine)');

if (hasPrelude && premiumForced) {
  console.log('\nVERDICT: this tree is ALREADY PATCHED.');
  console.log('  Nothing to do - load the dot/ folder in Chrome.');
  console.log('  To patch again, start from a fresh copy of the official release.');
  process.exit(0);
}

/* --- how does it compare to the known releases? -------------------------- */

for (const known of PROFILES) {
  const files = known.files || {};
  const mismatched = [];
  const missing = [];
  for (const [rel, digest] of Object.entries(files)) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { missing.push(rel); continue; }
    if (sha256(fs.readFileSync(p)) !== digest) mismatched.push(rel);
  }
  const same = Object.keys(files).length - mismatched.length - missing.length;
  console.log('\n  vs "' + known.name + '": ' + same + '/' + Object.keys(files).length + ' files identical');
  for (const rel of missing.slice(0, 6)) console.log('    missing  :', rel);
  for (const rel of mismatched.slice(0, 6)) console.log('    different:', rel);
  if (missing.length + mismatched.length > 12) {
    console.log('    ... and', missing.length + mismatched.length - 12, 'more');
  }
}

/* --- which patch sites are there? ------------------------------------- */

if (profile) {
  console.log('\n  build profile: ' + profile.name + (profile.appChunk ? '  (app chunk ' + profile.appChunk + ')' : ''));
  console.log('\n  patch sites:');
  for (const site of profile.patches) {
    const src = read(site.file);
    if (src === null) {
      console.log(`    ?  ${site.file}  (file missing)`);
      continue;
    }
    const n = src.split(site.find).length - 1;
    const a = src.split(site.replace).length - 1;
    const state = n === 1 ? 'ok' : a >= 1 ? 'already patched' : 'MISSING';
    console.log(`    ${state.padEnd(15)} ${site.file}  ${site.label || ''}`);
  }
} else {
  console.log('\n  no known build profile matches this tree.');
  console.log('  The premium gate moved - the sites have to be found again:');
  console.log('    node --experimental-vm-modules tools/emit_patches.js ' + ROOT + ' --save "<name>"');
}

console.log('\nDone.');
