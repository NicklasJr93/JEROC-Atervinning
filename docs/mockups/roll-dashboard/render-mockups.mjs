import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const folder=dirname(fileURLToPath(import.meta.url));
const source=resolve(folder,'../../../public/mockups/roll-dashboard');
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
  const page=await browser.newPage({viewport:{width:1440,height:1040},locale:'sv-SE',timezoneId:'Europe/Stockholm',deviceScaleFactor:1});
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort();}return route.continue();});
  let visit=0;
  async function open(hash){await page.goto(`${origin}/index.html?preview=${++visit}#${hash}`);await page.locator('#content > div').first().waitFor();}
  async function shot(file){await page.screenshot({path:resolve(folder,file),fullPage:true});}
  async function noOverflow(label){assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${label}: horizontal overflow`);}
  const profiles=[['kontor','01_Kontorist.png'],['ekonomi','02_Ekonomi_Attest.png'],['transport','03_Transportledare.png'],['gruppledare','04_Gruppledare.png'],['vd','05_VD.png'],['systemadmin','06_Systemadmin.png'],['gard','07_Gard.png'],['chauffor','08_Chauffor.png']];
  for(const[id,file]of profiles){await open(id);assert.equal(await page.locator('[data-dashboard-profile]').getAttribute('data-dashboard-profile'),id);await noOverflow(id);await shot(file);}
  await open('kontor');
  await page.getByRole('button',{name:'Behöver åtgärd',exact:true}).click();
  assert.equal(await page.locator('.dashboard-task-entry:visible').count(),2);
  await page.getByRole('button',{name:'Kontrollera ID',exact:true}).click();
  assert(await page.getByRole('dialog',{name:'Kunden väntar på legitimationskontroll'}).isVisible());
  await page.getByRole('button',{name:'Stäng ärende',exact:true}).click();
  await page.getByRole('tab',{name:'Verksamheten',exact:true}).click();
  assert.equal(await page.getByRole('heading',{level:1}).textContent(),'Verksamheten');
  await page.getByRole('tab',{name:'Mitt arbete',exact:true}).click();
  await page.getByRole('tab',{name:'Verksamheten',exact:true}).click();
  assert.equal(await page.getByRole('heading',{level:1}).textContent(),'Verksamheten');
  await page.getByRole('combobox',{name:'Förhandsvisa arbetsprofil'}).selectOption('vd');
  const all=await page.locator('.stat strong').first().textContent();
  await page.getByRole('combobox',{name:'Anläggning',exact:true}).selectOption('rimbo');
  assert.notEqual(await page.locator('.stat strong').first().textContent(),all,'Site filter changes KPI');
  await page.getByRole('combobox',{name:'Anläggning',exact:true}).selectOption('all');

  await open('mejl');await noOverflow('inbox');await shot('09_Mejlinkorg.png');
  await page.getByRole('button',{name:'Förbered arbetsorder',exact:true}).click();
  assert(await page.getByRole('dialog',{name:'Granska arbetsorderförslaget'}).isVisible());
  assert.equal(await page.locator('[name=requestedDate]').inputValue(),'2026-10-16');
  await page.screenshot({path:resolve(folder,'10_Mejl_Arbetsorderutkast.png'),fullPage:false});
  await page.getByRole('button',{name:'Avbryt',exact:true}).click();
  await page.getByRole('button',{name:'Föreslå svar',exact:true}).first().click();
  await page.getByRole('textbox',{name:'Redigera svarsutkast'}).fill('Hej Maria! Vi har tagit emot önskemålet. Planeringen återkommer med tid.');
  await page.getByRole('button',{name:'Spara utkast',exact:true}).click();
  await page.locator('#toast').evaluate(node=>node.hidden=true);
  await shot('11_Mejl_Svarsutkast.png');
  await page.getByRole('button',{name:'Förbered arbetsorder',exact:true}).click();
  await page.locator('[name=place]').fill('Nordvägen 22, 761 42 Norrtälje');
  await page.getByRole('button',{name:'Skapa utkast · demo',exact:true}).click();
  assert(await page.getByRole('button',{name:'Granska kopplad order',exact:true}).isVisible());
  await page.getByRole('button',{name:'Granska kopplad order',exact:true}).click();
  assert(await page.getByRole('dialog',{name:'Granska AO-DEMO-1101'}).isVisible());
  assert.equal(await page.locator('[name=place]').inputValue(),'Nordvägen 22, 761 42 Norrtälje','Reviewed changes are retained');
  assert.equal(await page.getByRole('button',{name:'Skapa utkast · demo',exact:true}).count(),0);
  await page.getByRole('button',{name:'Avbryt',exact:true}).click();
  await page.getByRole('button',{name:'Öppna Hämtning av blybatterier',exact:true}).click();
  await page.getByRole('button',{name:'Förbered arbetsorder',exact:true}).click();
  await page.getByRole('button',{name:'Skapa utkast · demo',exact:true}).click();
  assert(await page.getByText('Fyll i hämtplats eller be kunden komplettera.',{exact:true}).isVisible());
  await page.getByRole('button',{name:'Avbryt',exact:true}).click();
  await page.getByRole('button',{name:'Öppna SV: Förfrågan AO-1052 – vi kan köra',exact:true}).click();
  await page.getByRole('button',{name:'Granska AO-1052',exact:true}).click();
  assert(await page.getByRole('dialog',{name:'Granska AO-1052'}).isVisible());
  assert.equal(await page.getByRole('button',{name:'Skapa utkast · demo',exact:true}).count(),0);
  await page.getByRole('button',{name:'Avbryt',exact:true}).click();

  await page.setViewportSize({width:390,height:844});
  await open('kontor');await noOverflow('mobile dashboard');await shot('12_Dashboard_Mobil.png');
  await open('mejl');await noOverflow('mobile inbox');await shot('13_Mejl_Mobil.png');
  await page.getByRole('button',{name:'Öppna Utbyte av kabelkärl på fredag',exact:true}).click();
  await noOverflow('mobile email detail');await shot('14_Mejl_Laslage_Mobil.png');
  await page.getByRole('button',{name:'Förbered arbetsorder',exact:true}).click();
  assert(await page.getByRole('dialog',{name:'Granska arbetsorderförslaget'}).isVisible());
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(),0);
  await open('chauffor');await noOverflow('mobile driver');await shot('15_Chauffor_Mobil.png');
  assert.deepEqual(errors,[],'Browser errors');assert.deepEqual(external,[],'External requests');
  console.log('15 mockup images exported. Eight profiles, filters, repeated tabs, ID dialog, email drafts, duplicate protection, missing fields and mobile views checked. No external requests.');
}finally{await browser.close();await new Promise(done=>server.close(done));}
