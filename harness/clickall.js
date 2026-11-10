const puppeteer = require('puppeteer');
const fs = require('fs');
const EXT = process.argv[2];
const LABEL = process.argv[3];
const OUT = process.argv[4];
const OUTDIR = process.env.OUTDIR || require('os').tmpdir();

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
  await new Promise(r=>setTimeout(r,7000));
  await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(x=>/i agree/i.test(x.innerText||''));if(b)b.click();});
  await new Promise(r=>setTimeout(r,3000));

  // Click EVERY button, including icon-only ones, to mount all panels/modals.
  const before = await page.evaluate(()=>document.body.innerHTML.length);
  const n = await page.evaluate(()=>document.querySelectorAll('button').length);
  for (let i=0;i<n;i++){
    await page.evaluate((idx)=>{
      const b=[...document.querySelectorAll('button')][idx];
      if(b) b.click();
    }, i);
    await new Promise(r=>setTimeout(r,700));
  }
  await new Promise(r=>setTimeout(r,4000));

  const html = await page.evaluate(()=>document.getElementById('app').innerHTML + document.getElementById('modals').innerHTML);
  fs.writeFileSync(OUT, html);

  const stats = await page.evaluate(()=>{
    const paths=[...document.querySelectorAll('svg path')].map(p=>p.getAttribute('d')||'');
    const uniq={};
    paths.forEach(d=>{ const k=d.slice(0,30); uniq[k]=(uniq[k]||0)+1; });
    return {
      totalPaths: paths.length,
      premiumBadge: paths.filter(d=>d.includes('M19.916 4.626')).length,
      distinct: Object.keys(uniq).length,
      inputs: document.querySelectorAll('input,textarea,select').length,
      disabled: [...document.querySelectorAll('input,textarea,select')].filter(i=>i.disabled).length,
    };
  });
  console.log('### '+LABEL+' len='+html.length+' '+JSON.stringify(stats));
  await page.screenshot({path:`${OUTDIR}/${LABEL}-all.png`,fullPage:true}).catch(()=>{});
  await page.close().catch(()=>{});
  await browser.close();
  process.exit(0);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
