// Renders the standalone prototype and checks its UI flow, never contacts the app.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, extname } from 'node:path';
const folder=dirname(fileURLToPath(import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'};
const server=createServer(async(req,res)=>{
 const path=resolve(folder,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
 if(!path.startsWith(folder+'/')){res.writeHead(403);res.end();return;}
 try{const bytes=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream'});res.end(bytes);}catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}/index.html`;
let navigationCount=0;
const url=hash=>base+'?screen='+(++navigationCount)+'#'+hash;
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH??(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1600,height:1120},deviceScaleFactor:1,locale:'sv-SE'});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const readable=async selector=>(await page.locator(selector).innerText()).replace(/[\u00a0\u202f]/g,' ');
let unexpectedRequest;
page.on('request',req=>{if(!req.url().startsWith(base.split('/index.html')[0]))unexpectedRequest=req.url();});
async function screenshot(file,hash){await page.goto(url(hash));await page.locator('#content h1').waitFor();await page.evaluate(()=>document.fonts.ready);if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Horizontal overflow: '+file);await page.screenshot({path:join(folder,file),fullPage:true});}
try{
 await screenshot('01_Lageroversikt.png','view=stock');
 await screenshot('02_Utleverans_Planerad.png','view=order&state=reserved');
 await page.getByRole('button',{name:'Bekräfta avfärd',exact:true}).click();
 await page.locator('#check-document').check();await page.locator('#check-signatures').check();await page.locator('#check-environment').check();
 await page.evaluate(()=>window.scrollTo(0,0));
 await page.screenshot({path:join(folder,'03_Bekrafta_Lastad_Avfard.png')});
 await page.getByRole('dialog').getByRole('button',{name:'Bekräfta avfärd',exact:true}).click();
 if(!(await readable('#content')).includes('700 kg'))throw new Error('Actual stock amount missing after980kgdeparture');
 await page.screenshot({path:join(folder,'04_Utleverans_Registrerad.png'),fullPage:true});
 await screenshot('05_Lager_Efter_Utleverans.png','view=stock&state=released');
 const paper=await browser.newPage({viewport:{width:794,height:1123},deviceScaleFactor:1.5,locale:'sv-SE'});
 await paper.goto(base.replace('index.html','transportdokument.html')+'?capture=1&state=actual');
 await paper.evaluate(()=>document.fonts.ready);
 const paperBottom=await paper.locator('.document-footer').evaluate(el=>el.getBoundingClientRect().bottom);
 if(paperBottom>1123)throw new Error('Transportdocument does not fit A4: '+paperBottom);
 await paper.screenshot({path:join(folder,'06_Transportdokument_A4.png')});
 await paper.pdf({path:join(folder,'06_Transportdokument_A4.pdf'),format:'A4',printBackground:true,preferCSSPageSize:true,margin:{top:0,bottom:0,left:0,right:0}});
 await paper.goto(base.replace('index.html','transportdokument.html')+'?capture=1&state=planned');
 const draftText=(await paper.locator('.a4').innerText()).replace(/[\u00a0\u202f]/g,' ');
 if(!draftText.includes('1 000')||!draftText.includes('350 kg')||draftText.includes('Simulerad underskrift'))throw new Error('Draftdocument falsely shows actualweight or signatures');
 await paper.close();
 // Representative plan→reservation→actualdeparture→stock; no production or API calls.
 await page.goto(url('view=stock'));
 await page.getByRole('button',{name:'Ny utleverans',exact:true}).click();
 await page.getByRole('button',{name:'Planera utleverans',exact:true}).click();
 if(!(await readable('#content')).includes('1 680 kg'))throw new Error('Reservation changed physical stock');
 await page.getByRole('button',{name:'Bekräfta avfärd',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Bekräfta avfärd',exact:true}).click();
 if(await page.locator('#departure-error').isHidden())throw new Error('Unchecked requirements accepted');
 await page.locator('#check-document').check();await page.locator('#check-signatures').check();await page.locator('#check-environment').check();
 await page.getByRole('dialog').getByRole('button',{name:'Bekräfta avfärd',exact:true}).click();
 if(await page.getByRole('button',{name:'Bekräfta avfärd',exact:true}).count())throw new Error('Repeat departure remains possible');
 await page.getByRole('button',{name:'Visa lager',exact:false}).click();
 const txt=await readable('#content');if(!txt.includes('700 kg')||!txt.includes('300 kg')||!txt.includes('400 kg'))throw new Error('Released physical/reserved/free inconsistent');
 await page.getByRole('tab',{name:'Lagerpartier',exact:true}).click();
 if(!(await readable('#content')).includes('570 kg'))throw new Error('Remaining sourceparty inconsistent');
 await page.getByRole('tab',{name:'Händelser',exact:true}).click();
 if(!(await readable('#content')).includes('−980 kg'))throw new Error('Departure missing in ledger');
 await page.getByRole('tab',{name:'Artiklar',exact:true}).click();
 await page.getByRole('textbox',{name:'Sök lager',exact:true}).fill('spillolja');
 if(await page.locator('[data-stock-row]:visible').count()!==1)throw new Error('Stock search failed');
 for(const next of ['stock','order']){await page.setViewportSize({width:390,height:844});await page.goto(url('view='+next));if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Mobile viewport overflow: '+next);}
 if(unexpectedRequest)throw new Error('Unexpected external request: '+unexpectedRequest);
 if(errors.length)throw new Error(errors.join('\n'));
 console.log('6 PNGs and A4 PDF rendered; plan/reservation/departure/ledger/search/mobile plus draft/actualdocument checked. No backend requests.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
