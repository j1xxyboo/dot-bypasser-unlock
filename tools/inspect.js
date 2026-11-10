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

const OFFICIAL_FILE = path.join(__dirname, '..', 'web', 'official-files.json');
const OFFICIAL = fs.existsSync(OFFICIAL_FILE)
  ? JSON.parse(fs.readFileSync(OFFICIAL_FILE, 'utf8'))
  : { files: {} };

const sha256 = (buf) => require('crypto').createHash('sha256').update(buf).digest('hex');

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

if (OFFICIAL.version && manifest.version !== OFFICIAL.version) {
  console.log(`  !  this patcher targets ${OFFICIAL.name} ${OFFICIAL.version}, the tree is ${manifest.version}`);
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
const premiumForced = bg ? bg.includes('[q_7LT1h(mIno9Zz[0x870])+q_7LT1h(mIno9Zz[0x871])]:!0') : false;
console.log('  prelude :', hasPrelude ? 'present (the tree is patched)' : 'absent (pristine)');
console.log('  premium :', premiumForced ? 'forced on (the tree is patched)' : 'not forced (pristine)');

if (hasPrelude && premiumForced) {
  console.log('\nVERDICT: this tree is ALREADY PATCHED.');
  console.log('  Nothing to do - load the dot/ folder in Chrome.');
  console.log('  To patch again, start from a fresh copy of the official release.');
  process.exit(0);
}

/* --- how does it compare to the official release? --------------------- */

const mismatched = [];
const missing = [];
for (const [rel, digest] of Object.entries(OFFICIAL.files || {})) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { missing.push(rel); continue; }
  if (sha256(fs.readFileSync(p)) !== digest) mismatched.push(rel);
}
if (mismatched.length || missing.length) {
  console.log('\n  vs the official release:');
  for (const rel of missing.slice(0, 10)) console.log('    missing  :', rel);
  for (const rel of mismatched.slice(0, 10)) console.log('    different:', rel);
  if (mismatched.length > 10 || missing.length > 10) {
    console.log('    ... and', mismatched.length + missing.length - 20, 'more');
  }
  if (mismatched.length) {
    console.log('\n  The files differ from the official release. That is why the patcher');
    console.log('  cannot find its patch sites: the obfuscation is different.');
    console.log('  Use the original release archive (the one the patcher was written for).');
  }
} else {
  console.log('\n  vs the official release: identical');
}

/* --- which patch sites are there? ------------------------------------- */

const sites = require('../unlock_dot.js').PATCH_SITES || [];
if (sites.length) {
  console.log('\n  patch sites:');
  for (const s of sites) {
    const src = read(s.file);
    if (src === null) {
      console.log(`    ?  ${s.file}  (file missing)`);
      continue;
    }
    const n = src.split(s.find).length - 1;
    const a = src.split(s.replace).length - 1;
    const state = n === 1 ? 'ok' : a >= 1 ? 'already patched' : 'MISSING';
    console.log(`    ${state.padEnd(15)} ${s.file}  ${s.label || ''}`);
  }
}

console.log('\nDone.');
