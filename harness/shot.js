const puppeteer = require('puppeteer');
const EXT = process.argv[2];
const OUT = process.argv[3];

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
  await page.setViewport({width:900,height:1000,deviceScaleFactor:1});
  await page.goto(`chrome-extension://${id}/options.html`,{waitUntil:'domcontentloaded',timeout:15000}).catch(()=>{});
  await new Promise(r=>setTimeout(r,8000));
  await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(x=>/i agree/i.test(x.innerText||''));if(b)b.click();});
  await new Promise(r=>setTimeout(r,4000));
  await page.screenshot({path:OUT,fullPage:true}).catch(e=>console.log('shot err',e.message));
  const txt = await page.evaluate(()=>document.body.innerText.slice(0,400));
  console.log(JSON.stringify(txt));
  await browser.close();
  process.exit(0);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
