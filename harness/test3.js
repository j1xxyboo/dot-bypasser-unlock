const puppeteer = require('puppeteer');
const fs = require('fs');

/* Render the popup with NO CDP inspector attached to the page.
   The bundle contains anti-debugger `while(true)` loops that fire when a
   DevTools inspector is attached, so we attach to the *browser* target only
   and read the DOM out-of-band via a fresh target + file dump. */

const EXT = process.argv[2];
const LABEL = process.argv[3];
const OUTDIR = process.env.OUTDIR || require('os').tmpdir();

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-features=IsolateOrigins,site-per-process',
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    ],
  });

  await new Promise((r) => setTimeout(r, 4000));
  const targets = await browser.targets();
  let extId = null;
  for (const t of targets) if (t.url().startsWith('chrome-extension://')) { extId = t.url().split('/')[2]; break; }
  console.log('### EXT:', EXT, '| id:', extId);

  // Open the popup as a normal tab, but never attach a CDP session to it.
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push('[' + m.type() + '] ' + m.text().slice(0, 300)));
  page.on('pageerror', (e) => logs.push('[PAGEERROR] ' + e.message));

  try {
    await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (e) {
    logs.push('[goto] ' + e.message);
  }
  await new Promise((r) => setTimeout(r, 8000));

  let state = null;
  try {
    state = await page.evaluate(() => {
      const app = document.getElementById('app');
      return {
        url: location.href,
        appChildren: app ? app.children.length : -1,
        appHTML: app ? app.innerHTML.slice(0, 700) : null,
        text: (document.body.innerText || '').slice(0, 300),
        bodyBg: getComputedStyle(document.body).backgroundColor,
      };
    });
  } catch (e) {
    state = { evalError: e.message };
  }
  console.log('### STATE:', JSON.stringify(state, null, 2));
  try { await page.screenshot({ path: `${OUTDIR}/${LABEL}.png` }); console.log('### screenshot saved'); }
  catch (e) { console.log('### screenshot failed:', e.message); }
  console.log('### LOGS:\n' + (logs.join('\n') || '(none)'));

  await page.close().catch(() => {});
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
