/*
 * Inspect the Asheo popup: what is shown, what is locked.
 *
 * Usage: node harness/asheo.js <extension-dir> [label]
 */
const puppeteer = require('puppeteer');
const EXT = process.argv[2];
const LABEL = process.argv[3] || 'asheo';

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
  if (!id) {
    console.log('extension did not load');
    await browser.close();
    process.exit(1);
  }

  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message.slice(0, 200)));
  page.on('console', (m) => {
    const t = m.text();
    if (/asheo|premium|attest|integrit|license|entitle/i.test(t)) {
      errors.push('[' + m.type() + '] ' + t.slice(0, 200));
    }
  });

  await page.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => errors.push('goto: ' + e.message));
  await new Promise((r) => setTimeout(r, 7000));

  // accept the first-run disclaimer if it is there
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => /i understand|agree|continue/i.test(x.innerText || ''));
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 5000));

  const state = await page.evaluate(() => {
    const txt = (document.body.innerText || '').replace(/\n{2,}/g, '\n').trim();
    const buttons = [...document.querySelectorAll('button')].map((b) => ({
      text: (b.innerText || '').trim().slice(0, 28),
      disabled: b.disabled,
    }));
    const inputs = [...document.querySelectorAll('input,textarea')].map((i) => ({
      type: i.type, ph: i.placeholder || '', disabled: i.disabled, vis: !!i.offsetParent,
    }));
    // elements that look locked
    const locked = [...document.querySelectorAll('*')].filter((e) => {
      const c = (e.className || '').toString().toLowerCase();
      return /lock|disabled|premium|upgrade|blur/.test(c) && e.offsetParent;
    }).length;
    return {
      title: document.title,
      text: txt.slice(0, 2500),
      buttons: buttons.slice(0, 40),
      inputs: inputs.slice(0, 20),
      lockedLike: locked,
      bodyLength: txt.length,
    };
  });

  console.log('### ' + LABEL + ' (extension ' + id + '):');
  console.log(JSON.stringify(state, null, 1));
  if (errors.length) console.log('--- console ---\n' + errors.slice(0, 25).join('\n'));

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
