const puppeteer = require('puppeteer');
const EXT = process.argv[2];
const LABEL = process.argv[3] || 'x';

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

  const info = await page.evaluate(() => {
    const paths = [...document.querySelectorAll('svg path')].map(p=>p.getAttribute('d')||'');
    const CHECK = 'M19.916 4.626';
    const h1 = document.querySelector('h1');
    // the premium badge lives next to the title
    const titleRow = h1 ? h1.parentElement : null;
    const rowPaths = titleRow ? [...titleRow.querySelectorAll('path')].map(p=>(p.getAttribute('d')||'').slice(0,24)) : [];
    return {
      premiumBadge: paths.filter(d=>d.includes(CHECK)).length,
      badgeInTitleRow: rowPaths.some(d=>d.startsWith(CHECK)),
      rowPaths,
      // lock icon = IconLockFilled (heroicons lock-closed): search for its distinctive path
      lockPaths: paths.filter(d=>d.includes('M17.997 4.17')||d.includes('M4.012 16.737')).length,
      titleRowHtml: titleRow ? titleRow.innerHTML.slice(0,400) : null,
    };
  }).catch(e=>({evalError:e.message}));

  console.log('### '+LABEL+': '+JSON.stringify(info,null,1));
  await page.close().catch(()=>{});
  await browser.close();
  process.exit(0);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
