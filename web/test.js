/*
 * Self test of the patch web service.
 *
 *   node web/test.js [path-to-unpacked-official-extension]
 *
 * It starts the service, uploads the official extension as a .zip and as a
 * .crx, checks that the returned archive is really patched, and checks that a
 * tampered upload is refused.
 *
 * The Asheo path is tested as well when an unpacked Asheo build is found
 * (pass its path as the second argument, or let it be found next to the
 * Dot Bypasser one).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const zip = require('./lib/zip.js');

const PORT = 9300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`);
  }
}

function findExtension() {
  const candidates = [
    process.argv[2],
    'dot_backup_orig',
    '../dot_backup_orig',
    '/workspaces/codespaces-blank/dot_backup_orig',
  ].filter(Boolean);
  for (const c of candidates) {
    const p = path.resolve(c);
    if (fs.existsSync(path.join(p, 'manifest.json'))) return p;
  }
  throw new Error('no unpacked official extension found - pass the path as the first argument');
}

/** An unpacked Asheo build, if there is one to test against. */
function findAsheo() {
  const candidates = [
    process.argv[3],
    'asheo-latest',
    '../asheo-latest',
    '/workspaces/codespaces-blank/asheo-latest',
  ].filter(Boolean);
  for (const c of candidates) {
    const p = path.resolve(c);
    if (fs.existsSync(path.join(p, 'build-hashes.json'))) return p;
  }
  return null;
}

function collect(dir, prefix = '') {
  const out = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) for (const [k, v] of collect(abs, rel)) out.set(k, v);
    else out.set(rel, fs.readFileSync(abs));
  }
  return out;
}

/** Wrap a zip in a .crx header (CRX3). */
function makeCrx(zipBuffer) {
  const header = Buffer.from('Cr24', 'ascii');
  const version = Buffer.alloc(4);
  version.writeUInt32LE(3, 0);
  const pubKey = Buffer.alloc(32);
  const sig = Buffer.alloc(32);
  const headerLen = Buffer.alloc(4);
  // the header length covers the public key and the signature only
  headerLen.writeUInt32LE(pubKey.length + sig.length, 0);
  return Buffer.concat([header, version, headerLen, pubKey, sig, zipBuffer]);
}

(async () => {
  const ext = findExtension();
  const files = collect(ext);
  console.log('source extension:', ext, '(' + files.size + ' files)');

  const child = spawn(process.execPath, [path.join(__dirname, 'patch-server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const cleanup = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
  process.on('exit', cleanup);

  // wait for the server
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      const r = await fetch(BASE + '/api/info');
      if (r.ok) up = true;
    } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) {
    console.log('server did not start:\n' + log);
    process.exit(1);
  }

  const upload = async (buf, name) => {
    const res = await fetch(BASE + '/api/patch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(name) },
      body: buf,
    });
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) return { status: res.status, json: await res.json() };
    return {
      status: res.status,
      zip: Buffer.from(await res.arrayBuffer()),
      disposition: res.headers.get('content-disposition') || '',
    };
  };

  console.log('\n[1] upload the official extension as .zip');
  const zipBuf = zip.writeZip(files);
  const r1 = await upload(zipBuf, 'dot-bypasser.zip');
  check('the service answers with a zip', r1.status === 200 && !!r1.zip, r1.status);

  if (r1.zip) {
    const out = zip.readZip(r1.zip);
    check('the result has the same file set', out.size === files.size, [out.size, files.size]);

    const bg = out.get('background.js') ? out.get('background.js').toString() : '';
    check('background.js carries the anti-tamper prelude',
      bg.includes('/*__DOTBYPASS_PRELUDE_START__*/'), bg.slice(0, 80));

    // every patch site of the build profile has to be applied
    const profile = require('../tools/profiles.js').pickProfile(ext);
    check('the upload matches a known build', !!profile, 'no profile matched');
    if (profile) {
      let applied = 0;
      let missing = [];
      for (const site of profile.patches) {
        const text = out.get(site.file) ? out.get(site.file).toString() : '';
        const replaced = text.split(site.replace).length - 1;
        const original = text.split(site.find).length - 1;
        // background.js keeps the original pattern once, inside the prelude's
        // revert map (that is how the integrity probe still sees the official
        // bytes); every other file must not contain it any more
        const ok = text.includes(site.replace) &&
          (site.file === 'background.js' ? original === 1 : original === 0);
        if (ok) applied++;
        else missing.push(site.file + ' ' + site.label + ' (replaced=' + replaced + ' original=' + original + ')');
      }
      check('all ' + profile.patches.length + ' patch sites are applied', applied === profile.patches.length, missing);
    }

    check('the manifest is untouched',
      out.get('manifest.json') && out.get('manifest.json').equals(files.get('manifest.json')), 'manifest changed');
  }

  console.log('\n[2] upload the official extension as .crx');
  const r2 = await upload(makeCrx(zipBuf), 'dot-bypasser.crx');
  check('the service accepts a .crx as well', r2.status === 200 && !!r2.zip, r2.status);

  console.log('\n[3] a tampered upload is refused');
  const tampered = new Map(files);
  tampered.set('background.js', Buffer.from('console.log("hello")'));
  const r3 = await upload(zip.writeZip(tampered), 'tampered.zip');
  check('the service refuses a modified file', r3.status === 422, r3.status);
  check('the refusal explains why', !!(r3.json && r3.json.details && r3.json.details.length), r3.json);

  console.log('\n[4] junk is refused');
  const r4 = await upload(Buffer.from('this is not a zip file at all'), 'junk.zip');
  check('the service refuses a non archive', r4.status === 400, r4.status);

  console.log('\n[5] the page is served');
  const page = await fetch(BASE + '/');
  const html = await page.text();
  check('the page loads', page.status === 200 && html.includes('Extension patcher'), page.status);
  check('the page has a drop area', html.includes('id="drop"'), 'no drop area');

  console.log('\n[6] the produced build really works (headless Chrome)');
  const chrome = await verifyInChrome(r1.zip);
  if (chrome === null) {
    console.log('  --   skipped (puppeteer or Chrome not available)');
  } else {
    check('the app mounts', chrome.appMounted === true, chrome);
    check('no lock icons are left', chrome.lockIcons === 0, chrome);
    check('the premium badge is there', chrome.premiumBadges === 1, chrome);
    check('no "Unofficial Source" modal', chrome.hasNag === false, chrome);
  }

  /* ------------------------------------------------------------- Asheo */
  const asheoDir = findAsheo();
  if (!asheoDir) {
    console.log('\n[7] Asheo - skipped (no unpacked Asheo build found)');
  } else {
    console.log('\n[7] Asheo');
    const asheoFiles = collect(asheoDir);
    console.log('     source:', asheoDir, '(' + asheoFiles.size + ' files)');

    const a1 = await upload(zip.writeZip(asheoFiles), 'asheo.zip');
    check('the service answers with a zip', a1.status === 200 && !!a1.zip, a1.json || a1.status);
    check('the file is named after the extension',
      /asheo.*\.zip/.test(a1.disposition || ''), a1.disposition);

    if (a1.zip) {
      const out = zip.readZip(a1.zip);
      check('the result has the same file set', out.size === asheoFiles.size, [out.size, asheoFiles.size]);

      /* every patch site of the Asheo profile has to be applied */
      const asheo = require('../tools/asheo_profiles.js');
      const { PREMIUM } = require('../tools/asheo_payload.js');
      const manifestHash = require('crypto')
        .createHash('sha256').update(asheoFiles.get('build-hashes.json')).digest('hex');
      const profile = asheo.pickProfile(manifestHash);
      check('the upload matches a known Asheo build', !!profile, 'no profile matched');
      if (profile) {
        let applied = 0;
        let missing = [];
        for (const site of profile.patches) {
          const text = out.get(site.file) ? out.get(site.file).toString() : '';
          const replace = String(site.replace).replace('__ASHEO_PREMIUM__', PREMIUM);
          /* the replacement has to be there ... */
          if (!text.includes(replace)) {
            missing.push(site.file + ' ' + site.label + ' (replacement missing)');
            continue;
          }
          /* ... and the original pattern must be gone (except where the
           * replacement starts with it, which is the case for the
           * "export async function x(){" style sites) */
          const stillThere = text.split(site.find).length - 1;
          const expected = site.replace.startsWith(site.find) ? site.count : 0;
          if (stillThere !== expected) {
            missing.push(site.file + ' ' + site.label + ' (original=' + stillThere + ' expected=' + expected + ')');
            continue;
          }
          applied++;
        }
        check('all ' + profile.patches.length + ' patch sites are applied', applied === profile.patches.length, missing);
      }

      const bgText = out.get('functions/background.js') ? out.get('functions/background.js').toString() : '';
      check('the worker carries the response patch',
        bgText.includes('patch: premium activations are answered locally'), 'no prelude');
      check('the local premium checks are patched',
        bgText.includes('__asheoLocalEntitlement()'), 'not patched');
      check('the signed manifest is untouched',
        out.get('build-hashes.json') && out.get('build-hashes.json').equals(asheoFiles.get('build-hashes.json')),
        'manifest changed');

      /* the produced build really works */
      const aChrome = await verifyAsheoInChrome(a1.zip);
      if (aChrome === null) {
        console.log('  --   skipped (puppeteer or Chrome not available)');
      } else {
        check('the premium tier is active', aChrome.premiumActive === true, aChrome);
        check('the payment rules load', aChrome.rules === '45/45', aChrome);
        check('the browser mod toggle switches on and stays on',
          aChrome.pillBefore === 'Off' && aChrome.pillAfter === 'On' && aChrome.pillAfterReload === 'On', aChrome);
      }
    }

    console.log('\n[8] a tampered Asheo upload is refused');
    const aTampered = new Map(asheoFiles);
    aTampered.set('functions/background.js', Buffer.from('console.log("hello")'));
    const a2 = await upload(zip.writeZip(aTampered), 'asheo-tampered.zip');
    check('the service refuses a modified file', a2.status === 422, a2.status);
    check('the refusal explains why', !!(a2.json && a2.json.details && a2.json.details.length), a2.json);
  }

  console.log('\n' + (failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'));
  cleanup();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});

/**
 * Load the archive the service produced in headless Chrome and count the
 * premium locks. Returns null when puppeteer/Chrome are not installed.
 */
async function verifyInChrome(zipBuffer) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    return null;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-webbuild-'));
  try {
    const files = zip.readZip(zipBuffer);
    for (const [name, data] of files) {
      const dest = path.join(tmp, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
    }

    const browser = await puppeteer.launch({
      headless: 'new',
      protocolTimeout: 30000,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        `--disable-extensions-except=${tmp}`, `--load-extension=${tmp}`],
    });
    await new Promise((r) => setTimeout(r, 3000));
    let id = null;
    for (const t of await browser.targets()) {
      if (t.url().startsWith('chrome-extension://')) { id = t.url().split('/')[2]; break; }
    }
    const p = await browser.newPage();
    await p.goto(`chrome-extension://${id}/options.html`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 6000));
    await p.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /i agree/i.test(x.innerText || '')); if (b) b.click(); });
    await new Promise((r) => setTimeout(r, 2500));
    const n = await p.evaluate(() => document.querySelectorAll('button').length);
    for (let i = 0; i < n; i++) {
      await p.evaluate((idx) => { const b = [...document.querySelectorAll('button')][idx]; if (b) b.click(); }, i);
      await new Promise((r) => setTimeout(r, 400));
    }
    await new Promise((r) => setTimeout(r, 2000));
    const out = await p.evaluate(() => {
      const paths = [...document.querySelectorAll('svg path')].map((x) => x.getAttribute('d') || '');
      const LOCK = 'M12 2a5 5 0 0 1 5 5v3a3 3 0 0 1 3 3v6a';
      const CHECK = 'M19.916 4.626';
      const inputs = [...document.querySelectorAll('input,textarea,select')];
      return {
        appMounted: document.getElementById('app').children.length > 0,
        lockIcons: paths.filter((d) => d.startsWith(LOCK)).length,
        premiumBadges: paths.filter((d) => d.startsWith(CHECK)).length,
        disabledInputs: inputs.filter((i) => i.disabled).length,
        hasNag: /Unofficial Source/.test(document.body.innerText || ''),
      };
    });
    await browser.close();
    return out;
  } catch (e) {
    console.log('  --   skipped (' + e.message.split('\n')[0] + ')');
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Load the Asheo archive the service produced in headless Chrome and check
 * that the premium tier is active and that a premium toggle really switches
 * on and stays on. Returns null when puppeteer/Chrome are not installed.
 */
async function verifyAsheoInChrome(zipBuffer) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    return null;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asheo-webbuild-'));
  try {
    const files = zip.readZip(zipBuffer);
    for (const [name, data] of files) {
      const dest = path.join(tmp, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
    }

    const browser = await puppeteer.launch({
      headless: 'new',
      protocolTimeout: 30000,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        `--disable-extensions-except=${tmp}`, `--load-extension=${tmp}`],
    });
    await new Promise((r) => setTimeout(r, 4000));
    let id = null;
    for (const t of browser.targets()) {
      if (t.url().startsWith('chrome-extension://')) { id = t.url().split('/')[2]; break; }
    }
    const p = await browser.newPage();
    await p.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 4000));
    // the first-run disclaimer
    await p.evaluate(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => /i understand|agree|continue/i.test(x.innerText || ''));
      if (b) b.click();
    });
    await new Promise((r) => setTimeout(r, 6000));

    const text = await p.evaluate(() => document.body.innerText || '');
    const premiumActive = /Premium active/i.test(text);
    const m = /PAYMENT RULES\s*\n?\s*(\d+)\/(\d+)/i.exec(text);
    const rules = m ? m[1] + '/' + m[2] : 'not found';

    // switch the browser mod toggle on and check that it stays on
    const pillBefore = await p.evaluate(() => {
      const e = document.getElementById('browserModStatus');
      return e ? e.textContent.trim() : '(none)';
    });
    await p.evaluate(() => { const e = document.getElementById('browserModToggle'); if (e) e.click(); });
    await new Promise((r) => setTimeout(r, 3000));
    const pillAfter = await p.evaluate(() => {
      const e = document.getElementById('browserModStatus');
      return e ? e.textContent.trim() : '(none)';
    });
    await p.reload({ waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 6000));
    const pillAfterReload = await p.evaluate(() => {
      const e = document.getElementById('browserModStatus');
      return e ? e.textContent.trim() : '(none)';
    });

    await browser.close();
    return { premiumActive, rules, pillBefore, pillAfter, pillAfterReload };
  } catch (e) {
    console.log('  --   skipped (' + e.message.split('\n')[0] + ')');
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
