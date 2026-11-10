#!/usr/bin/env node
/*
 * Build the distributable ZIP of an unlocked extension.
 *
 * Usage:
 *   node build_zip.js <extension-dir> [out.zip]
 *
 * The archive contains a single top-level folder so it can be unpacked and
 * loaded with chrome://extensions -> Load unpacked -> <folder>/.
 *
 * The folder name inside the archive is derived from the extension itself
 * ("dot" for Dot Bypasser, "asheo" for Asheo), so the instructions in the
 * README stay valid for both.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TREE = path.resolve(process.argv[2] || 'dot');
const OUT = path.resolve(process.argv[3] || 'dot-unlocked.zip');

if (!fs.existsSync(path.join(TREE, 'manifest.json'))) {
  throw new Error(`not an extension tree: ${TREE}`);
}

// sanity: manifest must parse and name the expected entry points
const manifest = JSON.parse(fs.readFileSync(path.join(TREE, 'manifest.json'), 'utf8'));
const entryPoints = [
  manifest.background && manifest.background.service_worker,
  ...(manifest.content_scripts || []).flatMap((c) => c.js || []),
].filter(Boolean);
for (const f of entryPoints) {
  const p = path.join(TREE, f);
  if (!fs.existsSync(p)) throw new Error(`manifest references missing file: ${f}`);
}

/*
 * The folder name inside the archive: "asheo" for Asheo, "dot" for Dot
 * Bypasser, and the name of the source directory for anything else.
 */
const FOLDER = /asheo/i.test(manifest.name || '') ? 'asheo'
  : /dot\s*bypasser/i.test(manifest.name || '') ? 'dot'
  : path.basename(TREE);

const STAGE = path.join(path.dirname(OUT), '.' + FOLDER + '-zip-stage');
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
fs.cpSync(TREE, path.join(STAGE, FOLDER), { recursive: true });

fs.rmSync(OUT, { force: true });
execFileSync('zip', ['-r', '-q', '-9', OUT, FOLDER], { cwd: STAGE });
fs.rmSync(STAGE, { recursive: true, force: true });

const st = fs.statSync(OUT);
const sha = execFileSync('sha256sum', [OUT]).toString().split(/\s+/)[0];
console.log(`built  ${OUT}`);
console.log(`size   ${st.size} bytes`);
console.log(`sha256 ${sha}`);
