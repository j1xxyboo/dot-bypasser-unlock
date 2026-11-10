const puppeteer = require('puppeteer');
const EXT = process.argv[2];

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      `--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`],
  });
  await new Promise(r=>setTimeout(r,3000));
  const ts = await browser.targets();
  let id=null; for(const t of ts) if(t.url().startsWith('chrome-extension://')){id=t.url().split('/')[2];break;}

  const page = await browser.newPage();
  await page.goto(`chrome-extension://${id}/options.html`,{waitUntil:'domcontentloaded',timeout:15000}).catch(()=>{});
  await new Promise(r=>setTimeout(r,9000));

  const trace = await page.evaluate(async () => {
    const g = await chrome.storage.local.get('__trace');
    return g.__trace || null;
  }).catch(e=>({err:e.message}));
  console.log(JSON.stringify(trace,null,1));
  await browser.close();
  process.exit(0);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
