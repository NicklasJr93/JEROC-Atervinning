// Renders and checks this local prototype only. No production app or API calls.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const folder = dirname(fileURLToPath(import.meta.url));
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.png':'image/png' };
const server = createServer(async (req,res)=>{
  const path = resolve(folder, `.${decodeURIComponent(new URL(req.url,'http://localhost').pathname)}`);
  if(!path.startsWith(`${folder}/`)){res.writeHead(403);res.end();return;}
  try{const data=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream'});res.end(data);}
  catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH??(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--no-sandbox']});
const context=await browser.newContext({locale:'sv-SE',timezoneId:'Europe/Stockholm',viewport:{width:1600,height:1080},deviceScaleFactor:1});
const page=await context.newPage();
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('request',request=>{if(!request.url().startsWith(`${origin}/`))errors.push(`External request: ${request.url()}`);});
page.on('response',response=>{if(response.status()>=400)errors.push(`Asset failed: ${response.url()} (${response.status()})`);});
const click=action=>page.locator(`[data-action="${action}"]`).first().click();
const state=()=>page.evaluate(()=>window.JEROCPrototype.state);
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
async function view(name){
  if(page.url().startsWith(origin))await page.evaluate(name=>{window.JEROCPrototype.navigate(name);},name);
  else await page.goto(`${origin}/index.html#view=${name}`);
  await page.waitForFunction(name=>document.body.dataset.view===name&&document.querySelector('#app')?.textContent.trim().length>0,name);
  await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(image=>image.complete?Promise.resolve():new Promise(resolve=>{image.onload=resolve;image.onerror=resolve;})));});
}
async function screenshot(file,fullPage=true){
  assert(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)),`Horizontal overflow: ${file}`);
  await page.evaluate(()=>{
    document.querySelector('#toast').hidden=true;
    // Chromium's native date control uses the host locale in headless mode.
    // Export an unambiguous Swedish ISO date; keep the real picker in the prototype.
    for(const input of document.querySelectorAll('input[type="date"]')){
      input.dataset.exportDate=input.value;
      input.type='text';
      input.value=input.dataset.exportDate;
    }
  });
  try{await page.screenshot({path:join(folder,file),fullPage});}
  finally{await page.evaluate(()=>{
    for(const input of document.querySelectorAll('[data-export-date]')){
      const value=input.dataset.exportDate;input.type='date';input.value=value;delete input.dataset.exportDate;
    }
  });}
}
try{
  await view('orders');
  await screenshot('01_Arbetsorder_Oversikt.png');
  assert((await page.locator('.order-table tbody tr').count())===6,'Initial active order count incorrect.');
  await page.locator('[data-field="typeFilter"]').selectOption('exchange');
  assert((await page.locator('.order-table tbody tr').count())===2,'Type filter does not select exchanges.');
  await click('reset-filters');
  await click('tab-history');
  assert((await page.locator('.order-table tbody tr').count())===1,'History does not select completed orders.');
  await click('tab-active');
  await click('new-order');
  assert((await state()).form.mode==='own'&&(await state()).form.driver==='Ej tilldelad','Own driver default promises a particular driver.');
  await click('type-exchange');
  await screenshot('02_Skapa_Arbetsorder.png');
  await click('mode-external'); await click('save-order'); await view('orders');
  assert((await state()).orders[0].status==='carrier_pending'&&!(await state()).orders[0].bookedDate,'External request became a confirmed booking.');
  await click('new-order');
  for(const type of ['pickup','placement','outbound','exchange']){
    await click(`type-${type}`);
    assert((await state()).form.type===type,`Type switch failed: ${type}`);
  }
  await click('type-outbound');
  await page.locator('[data-field="item"]').selectOption('Kabel (koppar)');
  assert(!(await page.locator('#content').innerText()).includes('Farligt avfall:'),'Ordinary cable material inherits hazardous transport warning.');
  await click('nav-orders'); await click('warehouse-start');
  assert((await state()).form.type==='outbound'&&(await state()).form.source==='warehouse'&&(await state()).form.site==='Norrtälje','Warehouse shortcut did not prefill outbound order.');
  await screenshot('07_Utleverans_Fran_Lager.png');
  await click('save-order'); await view('orders');
  assert((await state()).orders[0].status==='pending'&&!(await state()).orders[0].bookedDate,'Requested date became a confirmed booking.');
  await click('reset');
  await view('login'); await screenshot('04_Kundportal_Inloggning.png');
  await click('customer-login-demo'); await view('customer');
  await screenshot('03_Kundportal_Karl.png');
  assert(!(await page.locator('#content').innerText()).includes('Roslagens Däck'),'Portal includes another customer’s request.');
  await page.setViewportSize({width:390,height:844});
  await screenshot('06_Kundportal_Mobil.png');
  for(const name of ['orders','new','login']){
    await view(name);
    assert(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)),`Mobile overflow: ${name}`);
  }
  await page.setViewportSize({width:1600,height:1080});
  await view('customer'); await click('customer-book-K-0660');
  await screenshot('05_Kund_Bestall_Byte.png',false);
  await page.locator('[data-field="customer-comment"]').fill('Kärlet är fullt. Ring gärna när ni närmar er.');
  await click('customer-submit-request');
  let snapshot=await state();
  const request=snapshot.requests.find(item=>item.assetId==='K-0660');
  assert(request&&snapshot.orders.some(order=>order.id===request.orderId&&order.status==='pending'),'Customer exchange not linked to one pending order.');
  assert(await page.locator('[data-action="customer-book-K-0660"]').isDisabled(),'Duplicate exchange request remains available.');
  await view('orders');
  assert(await page.locator(`[data-order-id="${request.orderId}"]`).count()===1,'Exchange appears as duplicate office orders.');
  await screenshot('08_Kundbestallning_Pa_Kontoret.png');
  await view('customer'); await click('customer-book-C-1042');
  await click('customer-submit-request');
  snapshot=await state();
  const changes=snapshot.requests.filter(item=>item.assetId==='C-1042');
  const oldOrder=snapshot.orders.find(order=>order.id==='AO-1052');
  assert(changes.length===1&&changes[0].orderId==='AO-1052','Earlier pickup created another work order.');
  assert(oldOrder.bookedDate==='2026-10-19'&&oldOrder.status==='booked'&&oldOrder.changeRequestDate==='2026-10-15','Pickup wish overwrote the confirmed booking.');
  assert(await page.locator('[data-action="customer-book-C-1042"]').isDisabled(),'Duplicate earlier-pickup request remains available.');
  assert(snapshot.orders.filter(order=>order.id==='AO-1052').length===1,'Pickup work order duplicated.');
  if(errors.length)throw new Error(errors.join('\n'));
  console.log('Eight PNGs rendered. Type/status filters, dynamic order types, warehouse prefill, own-driver default, customer exchange linkage/deduplication and earlier-pickup wish preserving the booked AO passed. Desktop/mobile overflow and local-only assets passed. No app/API/database changes.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
