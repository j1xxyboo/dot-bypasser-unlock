const puppeteer = require('puppeteer');
const EXT = process.argv[2];
const LABEL = process.argv[3] || 'x';
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
  const errors=[];
  page.on('pageerror', e=>errors.push('PAGEERROR: '+e.message));
  page.on('console', m=>{ if(m.type()==='error') errors.push('console.error: '+m.text().slice(0,200)); });

  await page.goto(`chrome-extension://${id}/options.html`,{waitUntil:'domcontentloaded',timeout:15000}).catch(()=>{});
  await new Promise(r=>setTimeout(r,8000));
  await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(x=>/i agree/i.test(x.innerText||''));if(b)b.click();});
  await new Promise(r=>setTimeout(r,4000));

  // Click every button (mounts every panel/modal) to exercise all locked UI.
  const n = await page.evaluate(()=>document.querySelectorAll('button').length);
  for (let i=0;i<n;i++){
    await page.evaluate((idx)=>{const b=[...document.querySelectorAll('button')][idx];if(b)b.click();},i);
    await new Promise(r=>setTimeout(r,600));
  }
  await new Promise(r=>setTimeout(r,3000));

  const out = await page.evaluate(() => {
    const paths=[...document.querySelectorAll('svg path')].map(p=>p.getAttribute('d')||'');
    const LOCK = 'M12 2a5 5 0 0 1 5 5v3a3 3 0 0 1 3 3v6a3';  // IconLockFilled
    const CHECK = 'M19.916 4.626';          // premium check badge
    const inputs=[...document.querySelectorAll('input,textarea,select')];
    const txt=document.body.innerText||'';
    return {
      appMounted: document.getElementById('app').children.length>0,
      lockIcons: paths.filter(d=>d.startsWith(LOCK)).length,
      premiumBadges: paths.filter(d=>d.startsWith(CHECK)).length,
      totalInputs: inputs.length,
      disabledInputs: inputs.filter(i=>i.disabled).length,
      hasNag: /Unofficial Source/.test(txt),
      hasJoinTelegram: /Join Telegram/.test(txt),
      disclaimer: /Welcome to Dot Bypasser/.test(txt),
    };
  });

  console.log('### '+LABEL+': '+JSON.stringify(out,null,1));
  if (errors.length) console.log('### errors:\n'+errors.slice(0,10).join('\n'));
  await page.screenshot({path:`${OUTDIR}/final-${LABEL}.png`,fullPage:true}).catch(()=>{});
  await browser.close();
  process.exit(0);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
