/*
 * Trace the popup's runtime messages: what the popup asks the background and
 * what it gets back (the plan / entitlement / license state).
 *
 * Usage: node harness/asheo_trace.js <extension-dir>
 */
const puppeteer = require('puppeteer');
const EXT = process.argv[2];

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

  const page = await browser.newPage();
  // install the hook before any page script runs
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
        if (cb) {
          return orig(msg, function (res) { record(msg, res); return cb(res); });
        }
        return orig(msg, ...rest).then((res) => { record(msg, res); return res; });
      };
    };
    wrap();
    document.addEventListener('DOMContentLoaded', wrap);
  });
  await page.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 4000));

  // accept the disclaimer
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => /i understand|agree|continue/i.test(x.innerText || ''));
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 6000));

  const msgs = await page.evaluate(() => window.__msgs || []);
  if (process.env.DUMP) {
    const fs = require('fs');
    fs.writeFileSync(process.env.DUMP, JSON.stringify(msgs, null, 1));
    console.log('wrote ' + process.env.DUMP);
  }
  console.log('--- runtime messages ---');
  for (const m of msgs) {
    const s = JSON.stringify(m.sent);
    const g = JSON.stringify(m.got);
    console.log('  sent: ' + (s || '').slice(0, 220));
    console.log('  got : ' + (g || '').slice(0, 1400));
  }
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
