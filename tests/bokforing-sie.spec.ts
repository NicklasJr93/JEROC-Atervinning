import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const key = 'scrapplanner-bokforing-suite-v2';
test.use({ viewport: { width: 1450, height: 1000 }, isMobile: false, hasTouch: false });
test.setTimeout(90_000);
const errors = new WeakMap<Page,string[]>();
test.beforeEach(({page})=>{ const caught:string[]=[]; errors.set(page,caught); page.on('pageerror',error=>caught.push(error.message)); });
test.afterEach(({page})=>expect(errors.get(page)).toEqual([]));
const saved=(page:Page)=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),key);
async function open(page:Page) {
  await page.goto('/bokforing/index.html#sie');
  await expect(page.getByRole('heading',{name:'SIE · flytta din bokföring',exact:true})).toBeVisible();
}
const form=(page:Page)=>page.locator('#sie-import-form');

// File upload and submit exercise the ordinary shared UI/storage transaction.
test('SIE file upload previews Swedish content, imports real ledger entries and blocks replay after reload',async({page})=>{
  await open(page);
  const source='#FLAGGA 0\r\n#PROGRAM "Extern Bokforing" "1.0"\r\n#FORMAT PC8\r\n#GEN 20261023\r\n#SIETYP 4\r\n#FNAMN "Fiktiva Exportbolaget"\r\n#RAR 0 20260101 20261231\r\n#VER "EX" "17" 20261022 "Köp i Örebro"\r\n{\r\n#TRANS 6570 {} 159.90\r\n#TRANS 1930 {} -159.90\r\n}\r\n';
  const siePath='../public/bokforing/suite/sie.js';
  const {encodeSiePc8}=await import(siePath);
  await page.locator('#sie-file').setInputFiles({name:'extern.se',mimeType:'application/octet-stream',buffer:Buffer.from(encodeSiePc8(source))});
  await expect(page.locator('#sie-source')).toHaveValue(source.replaceAll('\r\n','\n'));
  await page.getByRole('button',{name:'Granska import',exact:true}).click();
  await expect(page.locator('#sie-preview-result')).toContainText('Köp i Örebro');
  await expect(page.locator('#sie-preview-result')).toContainText('1 nya verifikationer');
  await form(page).locator('[name="confirmed"]').check();
  await page.getByRole('button',{name:'Importera granskade verifikationer',exact:true}).click();
  await expect.poll(async()=> (await saved(page))?.sieImports?.length).toBe(1);
  let state=await saved(page); const before=structuredClone(state);
  const imported=state.entries.filter((entry:{sourceType:string})=>entry.sourceType==='sie-import');
  expect(imported).toHaveLength(1);
  expect(imported[0].description).toBe('EX17 · Köp i Örebro');
  expect(imported[0].rows).toEqual([{account:'6570',debitCents:15990,creditCents:0},{account:'1930',debitCents:0,creditCents:15990}]);
  await page.reload();
  await expect(page.getByRole('heading',{name:'Importerade filer',exact:true})).toBeVisible();
  await page.locator('#sie-source').fill(source);
  await page.getByRole('button',{name:'Granska import',exact:true}).click();
  await expect(page.locator('#sie-preview-error')).toContainText('redan importerats');
  state=await saved(page); expect(state).toEqual(before);
});

test('SIE download preserves PC8 bytes and matches the selected ledger year',async({page})=>{
  await open(page);
  const pending=page.waitForEvent('download');
  await page.getByRole('button',{name:'Hämta SIE-fil',exact:true}).click();
  const download=await pending; expect(download.suggestedFilename()).toMatch(/2026.*\.se$/);
  const file=await download.path(); expect(file).toBeTruthy();
  const bytes=await readFile(file!);
  expect(bytes[0]).toBe(35); // Starts with #FLAGGA; no UTF-8/UTF-16 BOM or JSON serialization.
  const siePath='../public/bokforing/suite/sie.js';
  const {parseSie4,decodeSie}=await import(siePath);
  const parsed=parseSie4(bytes); expect(parsed.companyName).toBe('Åkes Hantverk AB');
  expect(parsed.years[0]).toMatchObject({start:'2026-01-01',end:'2026-12-31'});
  expect(parsed.vouchers.length).toBeGreaterThan(0);
  expect(decodeSie(bytes)).toContain('\r\n'); expect([...bytes]).toContain(0x8f);
});

test('mobile SIE workspace previews safely and rejects unsupported dimensions without a write',async({page})=>{
  await page.setViewportSize({width:390,height:844}); await open(page);
  await page.getByRole('button',{name:'Fyll med ett fiktivt prov',exact:true}).click();
  const source=await page.locator('#sie-source').inputValue();
  await page.locator('#sie-source').fill(source.replace('6570 {}','6570 {1 "X"}'));
  await page.getByRole('button',{name:'Granska import',exact:true}).click();
  await expect(page.locator('#sie-preview-error')).toContainText('dimensioner');
  expect((await saved(page))?.sieImports?.length??0).toBe(0);
  const width=await page.evaluate(()=>({full:document.documentElement.scrollWidth,view:innerWidth}));
  expect(width.full).toBeLessThanOrEqual(width.view+1);
});

test('empty practice company receives matching external opening balance through the ordinary UI',async({page})=>{
  await page.goto('/bokforing/index.html#setup');
  await page.getByRole('button',{name:'Nytt tomt övningsbolag',exact:true}).click();
  const create=page.locator('form[data-form="new-empty-company"]');
  await create.locator('[name="name"]').fill('Fiktiva Inflyttningen AB');
  await create.locator('[name="orgNumber"]').fill('DEMO');
  await create.locator('[name="start"]').fill('2026-01-01');
  await create.locator('[name="end"]').fill('2026-12-31');
  await create.locator('[name="resetConfirmed"]').check();
  await create.locator('button[type="submit"]').click();
  await expect.poll(async()=> (await saved(page))?.entries?.length).toBe(0);
  await page.goto('/bokforing/index.html#sie');
  const source='#FLAGGA 0\n#PROGRAM "Inflyttningsprov" "1.0"\n#FORMAT PC8\n#GEN 20261023\n#SIETYP 4\n#FNAMN "Fiktiva Inflyttningen AB"\n#ORGNR "DEMO"\n#RAR 0 20260101 20261231\n#IB 0 1930 1000.00\n#IB 0 2081 -1000.00\n#UB 0 1930 900.00\n#UB 0 2081 -1000.00\n#RES 0 6570 100.00\n#VER "F" "1" 20260102 "Fiktiv avgift"\n{\n#TRANS 6570 {} 100.00\n#TRANS 1930 {} -100.00\n}\n';
  await page.locator('#sie-source').fill(source);
  await page.getByRole('button',{name:'Granska import',exact:true}).click();
  await expect(page.locator('#sie-preview-result')).toContainText('förs in med egen verifikation');
  await form(page).locator('[name="confirmed"]').check();
  await page.getByRole('button',{name:'Importera granskade verifikationer',exact:true}).click();
  await expect.poll(async()=> (await saved(page))?.entries?.length).toBe(2);
  await page.reload();
  const state=await saved(page);
  expect(state.sieImports).toHaveLength(1);
  expect(state.entries.flatMap((entry:{rows:unknown[]})=>entry.rows).filter((row:{account:string})=>row.account==='1930').reduce((sum:number,row:{debitCents:number;creditCents:number})=>sum+row.debitCents-row.creditCents,0)).toBe(90000);
});
