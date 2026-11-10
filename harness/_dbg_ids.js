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
  await new Promise(r=>setTimeout(r,5000));
  const out = await page.evaluate(()=>{
    const els=[...document.querySelectorAll('[id]')].filter(e=>/mod|hud|persona|protection|toggle|switch|enable/i.test(e.id));
    return els.slice(0,40).map(e=>e.tagName+'#'+e.id+' .'+(e.className||'').toString().slice(0,40)+' txt='+JSON.stringify((e.innerText||'').trim().slice(0,25)));
  });
  console.log(out.join('\n'));
  await browser.close(); process.exit(0);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
