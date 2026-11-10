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
  await new Promise(r=>setTimeout(r,8000));
  await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(x=>/i agree/i.test(x.innerText||''));if(b)b.click();});
  await new Promise(r=>setTimeout(r,4000));

  // Which input is still disabled, and is it the "Status" master toggle?
  const out = await page.evaluate(() => {
    const dis=[...document.querySelectorAll('input,textarea,select')].filter(i=>i.disabled);
    return dis.map(i=>{
      const p=i.parentElement;
      const label=(p && (p.innerText||'').trim().slice(0,40))||'';
      return {type:i.type, label, aria:i.getAttribute('aria-label'), title:i.getAttribute('title')};
    });
  });
  console.log(JSON.stringify(out,null,1));
  await browser.close();
  process.exit(0);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
