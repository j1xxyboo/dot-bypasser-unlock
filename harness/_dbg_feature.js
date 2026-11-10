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
  const html = await page.evaluate(()=>{
    const all=[...document.querySelectorAll('*')];
    const el=all.filter(e=>(e.textContent||'').trim()==='Browser Mods').sort((a,b)=>a.children.length-b.children.length)[0];
    if(!el) return 'not found';
    let row=el; for(let i=0;i<5&&row.parentElement;i++){row=row.parentElement; if(row.querySelector('input,button,[role=switch]')) break;}
    return row.outerHTML.slice(0,2500);
  });
  console.log(html);
  await browser.close(); process.exit(0);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
