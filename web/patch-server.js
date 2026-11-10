#!/usr/bin/env node
'use strict';
/*
 * ============================================================================
 *  Dot Bypasser patcher — web service
 * ============================================================================
 *
 *  A small website where somebody who has never seen a terminal can patch the
 *  extension:
 *
 *      1. open the page
 *      2. drop the official extension (a .zip or a .crx) on it
 *      3. press "Patch it"
 *      4. download the patched .zip and load it in Chrome
 *
 *  The service does exactly what the command line does:
 *
 *      node unlock_dot.js <tree>
 *      node --experimental-vm-modules tools/fix_guards.js <tree>/chunks/main-D9uk0BkO.js
 *
 *  and hands the result back as a zip.
 *
 *  ---------------------------------------------------------------------------
 *  WHY THE UPLOAD IS CHECKED AGAINST THE KNOWN BUILDS
 *  ---------------------------------------------------------------------------
 *  Repairing the obfuscator's self-defending guards means *evaluating* the
 *  uploaded JavaScript. So an unchecked upload would be remote code
 *  execution. The service therefore only accepts a Dot Bypasser build it
 *  knows: every known build has a profile (tools/profiles.json) with the
 *  patch sites of that build, and the upload has to match one of them.
 *  Anything else is rejected with a clear message.
 *
 *  ---------------------------------------------------------------------------
 *  RUN
 *  ---------------------------------------------------------------------------
 *      node web/patch-server.js
 *      # -> http://localhost:8787
 *
 *  Environment:
 *      PORT        port to listen on                (default 8787)
 *      HOST        interface to bind                 (default 127.0.0.1)
 *      MAX_UPLOAD  maximum upload size in MB        (default 64)
 *      TIMEOUT     seconds a patch job may take      (default 180)
 *      KEEP_FILES  keep the temporary files          (default false)
 *
 *  Put it behind a reverse proxy with TLS if you want to offer it to others.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const zip = require('./lib/zip.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD || 64) * 1024 * 1024;
const TIMEOUT = Number(process.env.TIMEOUT || 180) * 1000;

const { load: loadProfiles, pickProfile } = require('../tools/profiles.js');
const PROFILES = loadProfiles();

/* ------------------------------------------------------------------ utils */


function send(res, status, type, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(buf);
}

function sendJson(res, status, obj) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj, null, 2));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('file is too big'), { code: 'TOO_BIG' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Run a command, capture its output, fail on a non-zero exit code. */
function run(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, timeout: timeoutMs, killSignal: 'SIGKILL' });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${path.basename(cmd)} exited with ${code}\n${out}\n${err}`.trim()));
    });
  });
}

/* ------------------------------------------------------------- validation */

/**
 * Which known build is this upload?
 *
 * The obfuscator re-randomises its string tables with every release, so the
 * patch sites differ per build. Every known build has a profile, and the
 * profile that matches decides whether the upload can be patched.
 *
 * @returns {{profile: object|null, problems: string[]}}
 */
function identify(files) {
  const problems = [];
  if (!files.has('manifest.json')) {
    return { profile: null, problems: ['the archive has no manifest.json - it is not an unpacked extension'] };
  }
  let manifest = {};
  try {
    manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  } catch (e) {
    return { profile: null, problems: ['the manifest.json in the archive is not valid JSON'] };
  }
  if (!/dot\s*bypasser/i.test(String(manifest.name || ''))) {
    problems.push(`the archive is "${manifest.name}", not Dot Bypasser`);
  }
  if (!manifest.background || !manifest.background.service_worker) {
    problems.push('the manifest has no service worker - this is not the browser extension');
  }
  if (problems.length) return { profile: null, problems };

  // write the tree out so the profile can be matched against it
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-ident-'));
  try {
    for (const [name, data] of files) {
      const dest = path.join(tmp, zip.safeName(name));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
    }
    const profile = pickProfile(tmp);
    if (!profile) {
      problems.push('this build of Dot Bypasser is not known to the patcher yet');
      return { profile: null, problems };
    }
    return { profile, problems: [] };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ----------------------------------------------------------------- patch */

/**
 * Patch an unpacked tree in place.
 * @returns {Promise<string>} the log of the patch run
 */
async function patchTree(tree) {
  const log = [];
  const unlock = await run(process.execPath, [path.join(ROOT, 'unlock_dot.js'), tree], ROOT, TIMEOUT);
  log.push(unlock.out.trim());

  // the tool finds the app chunk itself (its name changes with every build)
  const guards = await run(
    process.execPath,
    ['--experimental-vm-modules', path.join(ROOT, 'tools', 'fix_guards.js'), tree],
    ROOT,
    TIMEOUT
  );
  log.push(guards.out.trim());
  return log.join('\n');
}

/* ---------------------------------------------------------------- routes */

async function handlePatch(req, res) {
  let upload;
  try {
    upload = await readBody(req, MAX_UPLOAD);
  } catch (e) {
    return sendJson(res, e.code === 'TOO_BIG' ? 413 : 400, {
      error: e.code === 'TOO_BIG' ? `file is bigger than ${MAX_UPLOAD / 1024 / 1024} MB` : e.message,
    });
  }
  if (!upload.length) return sendJson(res, 400, { error: 'no file uploaded' });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-patch-'));
  const tree = path.join(tmp, 'dot');
  try {
    // 1. unpack
    let files;
    try {
      files = zip.readZip(zip.crxToZip(upload));
    } catch (e) {
      return sendJson(res, 400, { error: 'that does not look like a .zip or .crx file: ' + e.message });
    }
    if (!files.size) return sendJson(res, 400, { error: 'the archive is empty' });

    // 2. which build is it? (the patch sites differ per build)
    const { profile, problems } = identify(files);
    if (!profile) {
      return sendJson(res, 422, {
        error: 'This file is not a Dot Bypasser build the patcher knows.',
        details: problems.slice(0, 12),
        hint: 'Download the newest Dot Bypasser from the official release page and upload that file.',
      });
    }

    // 3. unpack to disk
    for (const [name, data] of files) {
      const safe = zip.safeName(name);
      const dest = path.join(tree, safe);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
    }

    // 4. patch
    let log;
    try {
      log = await patchTree(tree);
    } catch (e) {
      return sendJson(res, 500, { error: 'patching failed: ' + e.message.split('\n')[0], log: e.message });
    }

    // 5. pack it back
    const out = new Map();
    const walk = (dir, prefix = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else out.set(rel, fs.readFileSync(path.join(dir, entry.name)));
      }
    };
    walk(tree);
    const archive = zip.writeZip(out);

    const name = `dot-bypasser-${profile.version || 'unlocked'}-unlocked.zip`;
    send(res, 200, 'application/zip', archive, {
      'Content-Disposition': `attachment; filename="${name}"`,
      'X-Patch-Log': encodeURIComponent(log.slice(0, 2000)),
    });
  } finally {
    if (process.env.KEEP_FILES === 'true') {
      console.log('kept', tmp);
    } else {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

function handleIndex(res) {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'));
  send(res, 200, 'text/html; charset=utf-8', html);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return handleIndex(res);
    }
    if (req.method === 'POST' && url.pathname === '/api/patch') {
      return await handlePatch(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/info') {
      return sendJson(res, 200, {
        builds: PROFILES.map((p) => ({ name: p.name, version: p.version })),
        maxUploadMB: MAX_UPLOAD / 1024 / 1024,
      });
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log('Dot Bypasser patcher');
  console.log('  open  http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
  console.log('  accepts ' + PROFILES.map((p) => p.name).join(', ') + ' (.zip or .crx)');
});

module.exports = server;
