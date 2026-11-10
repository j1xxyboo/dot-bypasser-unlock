const puppeteer = require('puppeteer');
const fs = require('fs');
const EXT = process.argv[2];
const LABEL = process.argv[3];
const OUT = process.argv[4];

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
  await new Promise(r=>setTimeout(r,6000));

  await page.evaluate(() => {
    const b=[...document.querySelectorAll('button')].find(x=>/i agree/i.test(x.innerText||''));
    if(b) b.click();
  });
  await new Promise(r=>setTimeout(r,4000));

  // Click every nav entry so all lazily-chunked panels mount.
  const labels = await page.evaluate(()=>[...document.querySelectorAll('button,a,[role="tab"]')]
    .map(e=>(e.innerText||'').trim()).filter(t=>t && t.length<25));
  for (const t of [...new Set(labels)]) {
    await page.evaluate((l)=>{const e=[...document.querySelectorAll('button,a,[role="tab"]')].find(x=>(x.innerText||'').trim()===l); if(e) e.click();}, t);
    await new Promise(r=>setTimeout(r,900));
  }
  await new Promise(r=>setTimeout(r,3500));

  const html = await page.evaluate(()=>document.getElementById('app').innerHTML);
  fs.writeFileSync(OUT, html);
  console.log('### wrote '+OUT+' len='+html.length);
  await page.close().catch(()=>{});
  await browser.close();
  process.exit(0);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
