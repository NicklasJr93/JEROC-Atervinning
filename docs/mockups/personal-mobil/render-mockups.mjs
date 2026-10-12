import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const folder=dirname(fileURLToPath(import.meta.url));
const source=resolve(folder,'../../../public/mockups/personal-mobil');
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png'};
const server=createServer(async(req,res)=>{
  const file=resolve(source,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
  if(relative(source,file).startsWith('..')){res.writeHead(403);res.end();return;}
  try{const body=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream'});res.end(body);}
  catch{res.writeHead(404);res.end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH??(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--no-sandbox']});
const errors=[],external=[];
try{
  const page=await browser.newPage({viewport:{width:390,height:844},locale:'sv-SE',timezoneId:'Europe/Stockholm',deviceScaleFactor:1});
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort();}return route.continue();});
  let visit=0;
  async function open(hash){await page.goto(`${origin}/index.html?preview=${++visit}#${hash}`);await page.locator('#screen > *').first().waitFor();}
  async function shot(file){
    assert(await page.locator('img').evaluateAll(images=>images.every(image=>image.complete && image.naturalWidth>0)),`${file}: image assets loaded`);
    // Keep fixed/sticky controls from being painted over off-screen content in
    // full-page exports. The interactive prototype retains its sticky controls.
    const exportStyle=await page.addStyleTag({content:'.personal-mobile-shell .pm-bottom-nav,.personal-mobile-shell .pm-form-footer{position:static!important}'});
    await page.screenshot({path:resolve(folder,file),fullPage:true});
    await exportStyle.evaluate(node=>node.remove());
  }
  async function noOverflow(label){assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${label}: horizontal overflow`);}
  const screens=[['profil','01_Profil.png'],['start','02_Min_Personal.png'],['schema','03_Mitt_Schema.png'],['tid','04_Min_Tid.png'],['registrera','05_Rapportera_Tid.png'],['ledighet','06_Min_Ledighet.png'],['ansok','07_Ansok_Ledighet.png'],['saldo','08_Mina_Saldon.png']];
  for(const[route,file]of screens){await open(route);await noOverflow(route);await shot(file);}

  await open('registrera');
  await page.locator('[data-form="time"] [name="end"]').fill('17:00');
  await page.locator('[data-form="time"] [name="note"]').fill('Lastningen krävde en extra timme.');
  await page.getByRole('button',{name:'Spara arbetstid',exact:true}).click();
  await page.waitForFunction(()=>window.PersonalMock.state.route==='tid');
  assert.equal(await page.evaluate(()=>window.PersonalMock.reportSummary().variance),60,'Edited times update the actual deviation');
  assert.equal(await page.locator('.pm-variance strong').textContent(),'+1 h');
  await open('ansok');
  await page.locator('[data-form="leave"] [name="note"]').fill('Önskar ledigt i november.');
  await page.getByRole('button',{name:'Skicka ansökan',exact:true}).click();
  await page.waitForFunction(()=>window.PersonalMock.state.route==='ledighet');
  assert.equal(await page.evaluate(()=>window.PersonalMock.leaveBalance().balance),10,'Sending a request does not reserve leave');
  assert.equal(await page.evaluate(()=>window.PersonalMock.leaveBalance().pending),10);
  assert.equal(await page.evaluate(()=>window.PersonalMock.state.staffingCreated),false,'Sending a request does not change staffing');

  await open('tid');
  assert.equal(await page.evaluate(()=>window.PersonalMock.reportSummary().worked),2310);
  await page.getByRole('button',{name:'Skicka för granskning',exact:true}).click();
  await page.getByRole('button',{name:'Skicka tidrapport',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.PersonalMock.state.report.status),'submitted');
  const locked=await page.evaluate(()=>window.PersonalMock.saveTimeEntry({id:'tue',date:'2026-10-06',start:'07:00',end:'17:00',breakMinutes:60,note:'Provar låsningen'}));
  assert.equal(locked.ok,false,'A submitted report is locked');
  await page.getByRole('combobox',{name:'Förhandsvisa som',exact:true}).selectOption('manager');
  await page.waitForFunction(()=>window.PersonalMock.state.route==='chef');
  await page.setViewportSize({width:1440,height:1040});await noOverflow('manager queue');await shot('09_Chef_Granskning.png');
  await page.evaluate(()=>window.PersonalMock.go('chef-ledighet'));
  await page.waitForFunction(()=>window.PersonalMock.state.route==='chef-ledighet');
  await noOverflow('manager leave');await shot('10_Chef_Ledighet.png');
  await page.evaluate(()=>window.PersonalMock.go('chef-tid'));
  await page.waitForFunction(()=>window.PersonalMock.state.route==='chef-tid');
  await noOverflow('manager report');await shot('11_Chef_Tidrapport.png');

  assert.equal(await page.evaluate(()=>window.PersonalMock.returnReport('').ok),false,'Returning a report needs a comment');
  assert.equal(await page.evaluate(()=>window.PersonalMock.returnReport('Förtydliga lastningen på tisdagen.').ok),true);
  await page.evaluate(()=>window.PersonalMock.go('tid'));
  await page.waitForFunction(()=>window.PersonalMock.state.route==='tid');
  assert.equal(await page.evaluate(()=>window.PersonalMock.state.report.status),'returned');
  await page.getByRole('button',{name:'Skicka för granskning',exact:true}).click();
  await page.getByRole('button',{name:'Skicka tidrapport',exact:true}).click();
  await page.evaluate(()=>window.PersonalMock.go('chef-tid'));
  await page.waitForFunction(()=>window.PersonalMock.state.route==='chef-tid');
  assert.equal(await page.evaluate(()=>window.PersonalMock.approveReport().ok),true);
  assert.equal(await page.evaluate(()=>window.PersonalMock.leaveBalance().flex),195,'Time approval does not silently accrue flex');

  await page.evaluate(()=>window.PersonalMock.go('chef-ledighet'));
  await page.waitForFunction(()=>window.PersonalMock.state.route==='chef-ledighet');
  const before=await page.evaluate(()=>window.PersonalMock.leaveBalance());
  assert.equal(before.balance,10);assert.equal(before.pending,5);
  await page.getByRole('button',{name:/^Godkänn( ledighet| ansökan)?$/}).click();
  const after=await page.evaluate(()=>window.PersonalMock.leaveBalance());
  assert.equal(after.balance,5);assert.equal(after.approved,8);assert.equal(after.pending,0);
  assert.equal(await page.evaluate(()=>window.PersonalMock.state.staffingCreated),true);
  await shot('12_Chef_Godkand_Ledighet.png');
  assert.equal(await page.evaluate(()=>window.PersonalMock.approveLeave('LE-1045').ok),false,'A decision cannot reserve leave twice');
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>window.PersonalMock.go('saldo'));
  await page.waitForFunction(()=>window.PersonalMock.state.route==='saldo');
  await noOverflow('updated balance');await shot('13_Mobil_Uppdaterat_Saldo.png');
  assert.equal(await page.evaluate(()=>window.PersonalMock.approveLeave('LE-1045').ok),false,'Employee view cannot approve requests');

  await page.setViewportSize({width:320,height:780});
  for(const[route]of screens){await open(route);await noOverflow(`320px ${route}`);}
  await open('chef');await noOverflow('320px manager');
  assert.deepEqual(errors,[],'Browser errors');assert.deepEqual(external,[],'External requests');
  console.log('13 mockup images exported. Mobile screens, 320px layouts, time submission/return, leave approval, balances and staffing checked. No external requests.');
}finally{await browser.close();await new Promise(done=>server.close(done));}
