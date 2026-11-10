#!/usr/bin/env node
/*
 * Build the distributable ZIP of the unlocked Dot Bypasser extension.
 *
 * Usage:
 *   node build_zip.js <extension-dir> [out.zip]
 *
 * The archive contains a single top-level `dot/` folder so it can be unpacked
 * and loaded with chrome://extensions -> Load unpacked -> dot/.
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
for (const f of [manifest.background.service_worker, ...manifest.content_scripts.flatMap(c => c.js)]) {
  const p = path.join(TREE, f);
  if (!fs.existsSync(p)) throw new Error(`manifest references missing file: ${f}`);
}

// The archive always uses the folder name "dot", whatever the source dir is
// called, so the instructions in the README stay valid.
const STAGE = path.join(path.dirname(OUT), '.dot-zip-stage');
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
fs.cpSync(TREE, path.join(STAGE, 'dot'), { recursive: true });

fs.rmSync(OUT, { force: true });
execFileSync('zip', ['-r', '-q', '-9', OUT, 'dot'], { cwd: STAGE });
fs.rmSync(STAGE, { recursive: true, force: true });

const st = fs.statSync(OUT);
const sha = execFileSync('sha256sum', [OUT]).toString().split(/\s+/)[0];
console.log(`built  ${OUT}`);
console.log(`size   ${st.size} bytes`);
console.log(`sha256 ${sha}`);
