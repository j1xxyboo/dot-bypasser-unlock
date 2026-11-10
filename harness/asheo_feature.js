/*
 * Click the premium feature toggles and report what the extension answers.
 *
 * Usage: node harness/asheo_feature.js <extension-dir> [label]
 */
const puppeteer = require('puppeteer');
const EXT = process.argv[2];
const LABEL = process.argv[3] || 'features';

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 30000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  await new Promise((r) => setTimeout(r, 4000));
  let id = null;
  for (const t of await browser.targets()) {
    if (t.url().startsWith('chrome-extension://')) { id = t.url().split('/')[2]; break; }
  }

  // attach to the service worker so its console output is visible
  for (const t of await browser.targets()) {
    if (t.type() === 'service_worker') {
      try {
        const w = await t.worker();
        w.on('console', (m) => {
          const txt = m.text();
          if (/activ|premium|error|fail|fetch|token/i.test(txt)) {
            console.log('  [sw] ' + txt.slice(0, 220));
          }
        });
      } catch (e) { /* ignore */ }
    }
  }

  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    window.__msgs = [];
    const wrap = () => {
      if (!window.chrome || !chrome.runtime || !chrome.runtime.sendMessage) return;
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      const record = (msg, res) => {
        let clone;
        try { clone = JSON.parse(JSON.stringify(res)); } catch (e) { clone = String(res); }
        window.__msgs.push({ sent: msg, got: clone });
      };
      chrome.runtime.sendMessage = function (msg, ...rest) {
        const cb = rest.find((x) => typeof x === 'function');
        if (cb) return orig(msg, function (res) { record(msg, res); return cb(res); });
        return orig(msg, ...rest).then((res) => { record(msg, res); return res; });
      };
    };
    wrap();
    document.addEventListener('DOMContentLoaded', wrap);
  });
  await page.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 4000));
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /i understand|agree|continue/i.test(x.innerText || ''));
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 5000));

  // the toggles of the premium sections
  const targets = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('input.toggle-input, input[type=checkbox]').forEach((el) => {
      if (!el.offsetParent) return;
      let sec = el.closest('section,div');
      let label = '';
      for (let i = 0; i < 4 && sec; i++) {
        const h = sec.querySelector('strong,.bypass-unit-title,h3,h4');
        if (h) { label = (h.innerText || '').trim(); break; }
        sec = sec.parentElement;
      }
      out.push({ id: el.id || '', label: label.slice(0, 30) });
    });
    return out;
  });
  console.log('toggles found:', JSON.stringify(targets));

  for (const t of targets) {
    await page.evaluate(() => { window.__msgs = []; });
    const before = await page.evaluate((id) => {
      const el = id ? document.getElementById(id) : null;
      if (!el) return false;
      el.click();
      return true;
    }, t.id);
    if (!before) continue;
    await new Promise((r) => setTimeout(r, 1500));

    const out = await page.evaluate(() => {
      const toast = [...document.querySelectorAll('*')].filter((e) => {
        const c = (e.className || '').toString().toLowerCase();
        return /toast|notif|snack|alert|error/.test(c) && e.offsetParent && (e.innerText || '').trim();
      });
      const text = toast.length ? toast[toast.length - 1].innerText.trim().slice(0, 120) : '';
      const body = document.body.innerText || '';
      const m = body.match(/(Premium check failed[^\\n]*)/i);
      return { toast: text, premiumFail: m ? m[0] : null };
    });
    const msgs = await page.evaluate(() => window.__msgs || []);
    const relevant = msgs.filter((m) => JSON.stringify(m.sent).match(/browsermod|hud|protect|feature|premium|persona/i));

    /*
     * What counts as "worked" is the worker's own answer, not the text the
     * popup happens to show: the popup shows a success message even when the
     * worker refused the feature (and then never saved the setting).
     *
     * Two shapes of refusal:
     *   {success:false, reason:"premium_required"}   a feature switch
     *   {ok:true, allowed:false}                      an entitlement query
     */
    const answers = relevant.map((m) => m.got).filter((g) => g && typeof g === 'object');
    const refused = answers.find((g) => g.success === false || g.allowed === false);
    if (!answers.length) {
      console.log(`  ${t.label || t.id}: no message`);
    } else if (refused) {
      const why = (refused.reason || (refused.allowed === false ? 'not allowed' : 'failed')) +
        (refused.message ? ' "' + refused.message + '"' : '');
      console.log(`  ${t.label || t.id}: FAIL ${why}`);
    } else {
      console.log(`  ${t.label || t.id}: ok`);
    }
    for (const m of relevant.slice(0, 4)) {
      console.log('      sent: ' + JSON.stringify(m.sent).slice(0, 160));
      console.log('      got : ' + JSON.stringify(m.got).slice(0, 200));
    }
  }

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
