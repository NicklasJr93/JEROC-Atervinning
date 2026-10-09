// Render only the standalone mockup. Does not start or contact the JEROC app.
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname } from 'node:path';
const folder=dirname(fileURLToPath(import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'};
const server=createServer(async(req,res)=>{
 const path=resolve(folder,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
 if(!path.startsWith(folder+'/')){res.writeHead(403);res.end();return;}
 try{const bytes=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream'});res.end(bytes);}catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}/index.html`;
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH??(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1600,height:1050},deviceScaleFactor:1,locale:'sv-SE',timezoneId:'Europe/Stockholm'});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
const shots=[
 ['01_Personallista.png','view=list'],
 ['02_Personalkort_Oversikt.png','view=overview'],
 ['03_Anstallning_Lon.png','view=employment'],
 ['04_Schema_Tillganglighet.png','view=schedule'],
 ['05_Registrera_Franvaro.png','view=absence&modal=absence'],
 ['06_Kompetenser_Fordon.png','view=competencies'],
 ['07_Bemanning_Att_Losa.png','view=tasks&sick=1'],
 ['08_Extern_Chauffor.png','view=external'],
 ['09_Valj_Ersattare.png','view=tasks&sick=1&modal=task'],
 ['10_Bemanning_Lost.png','view=schedule&sick=1&resolved=1'],
 ['11_Extern_Anvandarkonto.png','view=external&modal=account'],
 ['12_Lon_Behorig_Vy.png','view=employment'],
];
try{
for(const [file,hash] of shots){
 await page.goto(base+'?capture='+file+'#'+hash);
 await page.waitForFunction(()=>document.querySelector('#content').innerText.includes('Designförslag'));
 if(file.startsWith('12_'))await page.getByRole('button',{name:'Visa med HR-behörighet'}).click();
 await page.evaluate(()=>document.fonts.ready);
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 if(overflow)throw new Error('Horizontal overflow: '+file);
 await page.screenshot({path:join(folder,file),fullPage:true});
}
// One representative interaction chain, no backend calls.
await page.goto(base+'?check=flow#view=absence');
await page.getByRole('button',{name:'Registrera frånvaro',exact:true}).click();
await page.locator('[data-action="confirm-absence"]').click();
if(await page.locator('#content').getByText('AO-1042',{exact:false}).count()===0)throw new Error('Affected assignment missing after absence');
await page.locator('#content [data-action="task"]').first().click();
await page.locator('[data-action="resolve-tasks"]').click();
await page.locator('.tabs [data-view="schedule"]').first().count().then(async n=>{if(n)await page.locator('.tabs [data-view="schedule"]').first().click();else await page.locator('.view-guide [data-view="schedule"]').click();});
if(!(await page.locator('#content').innerText()).includes('Lina'))throw new Error('Replacement missing after confirmation');
await page.goto(base+'?check=account#view=external');
await page.locator('[data-action="account"]').first().click();
await page.locator('[data-action="external-disable"]').last().click();
if(!(await page.locator('#overlay').innerText()).includes('Avaktiverat'))throw new Error('External account state did not change');
await page.setViewportSize({width:390,height:844});
await page.goto(base+'?check=mobile#view=overview');
if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Mobile overview overflow');
if(errors.length)throw new Error(errors.join('\n'));
console.log(`Rendered ${shots.length} mockups; absence→replacement, external account and mobile layout checked.`);
}finally{await browser.close();await new Promise(r=>server.close(r));}
