const puppeteer = require('puppeteer');
const EXT = process.argv[2];
(async () => {
  const browser = await puppeteer.launch({headless:'new', protocolTimeout:30000,
    args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      `--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`]});
  await new Promise(r=>setTimeout(r,4000));
  let id=null; for(const t of await browser.targets()) if(t.url().startsWith('chrome-extension://')){id=t.url().split('/')[2];break;}
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`,{waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{});
  await new Promise(r=>setTimeout(r,4000));
  await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(x=>/i understand|agree|continue/i.test(x.innerText||''));if(b)b.click();});
  await new Promise(r=>setTimeout(r,6000));
  const all = await page.evaluate(async () => {
    const s = await chrome.storage.local.get(null);
    const out = {};
    for (const [k,v] of Object.entries(s)) {
      out[k] = (typeof v === 'object' && v !== null) ? JSON.stringify(v).slice(0, 600) : String(v).slice(0,200);
    }
    return out;
  });
  console.log(JSON.stringify(all, null, 1));
  await browser.close(); process.exit(0);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
