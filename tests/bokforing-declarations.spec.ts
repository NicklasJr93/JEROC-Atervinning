import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const storageKey='scrapplanner-bokforing-suite-v2';
const form=(page:Page,action:string)=>page.locator(`form[data-feature-form="declarations"][data-action="${action}"]`);
const saved=(page:Page)=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),storageKey);
test.use({viewport:{width:1440,height:1000}});
async function seed(page:Page,closed=false){
 await page.goto('/bokforing/#declarations');
 await page.evaluate(async({storageKey,closed})=>{
  const corePath='/bokforing/suite/core.js',financePath='/bokforing/suite/finance.js';
  const core=await import(/* @vite-ignore */ corePath),finance=await import(/* @vite-ignore */ financePath);
  let state=core.transact(core.createEmptyState(),(draft:any)=>core.appendEntry(draft,{date:'2026-01-01',description:'Startkapital',sourceType:'opening',sourceId:'test-opening',rows:[{account:'1930',debitCents:2500000,creditCents:0},{account:'2081',debitCents:0,creditCents:2500000}]}));
  if(closed){for(let m=1;m<=12;m++)state=finance.lockPeriod(state,`2026-${String(m).padStart(2,'0')}`);state=finance.closeYear(state,{date:'2026-12-31',confirmed:true});}
  localStorage.setItem(storageKey,JSON.stringify(state));
 },{storageKey,closed});
 await page.reload();await expect(page.getByRole('heading',{name:'Från bokföring till inlämningsfil',exact:true})).toBeVisible();
}
async function open(page:Page,title:string){const panel=page.locator('details.decl-card').filter({has:page.locator('summary').filter({hasText:title})}).first();await panel.locator(':scope > summary').click();}
async function checkAll(f:ReturnType<typeof form>){for(const input of await f.locator('input[type="checkbox"][required]').all())await input.check();}
test('AGI requires checked identity and reviews, persists version and downloads actual XML',async({page})=>{
 await seed(page);const f=form(page,'create-agi');await f.locator('[name="orgNumber"]').fill('DEMO');await f.locator('[name="contactName"]').fill('Granskare Åström');await f.locator('[name="contactPhone"]').fill('0101234567');await f.locator('[name="contactEmail"]').fill('test@example.org');await f.locator('[name="month"]').fill('2026-10');await checkAll(f);await f.getByRole('button',{name:'Spara granskat AGI-underlag'}).click();await expect(page.locator('#suite-toast')).toContainText('organisationsnummer');expect((await saved(page)).declarations).toBeUndefined();
 await f.locator('[name="orgNumber"]').fill('5560269986');await f.getByRole('button',{name:'Spara granskat AGI-underlag'}).click();await expect.poll(async()=>(await saved(page)).declarations?.length).toBe(1);
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Hämta XML',exact:true}).click();const download=await downloadPromise;expect(download.suggestedFilename()).toBe('arbetsgivardeklaration-2026-10.xml');const text=await readFile((await download.path())!,'utf8');expect(text).toContain('Arbetsgivardeklaration');expect(text).toContain('Granskare Åström');expect(text).toContain('<agd:SummaSkatteavdr faltkod="497">0');
 await page.reload();await expect(page.getByRole('heading',{name:'Sparade granskningsversioner'})).toBeVisible();expect((await saved(page)).declarations).toHaveLength(1);
});
test('moms cannot export a monthly slice for a quarterly company',async({page})=>{
 await seed(page);await open(page,'Momsdeklaration · XML');const f=form(page,'create-vat');await f.locator('[name="orgNumber"]').fill('5560269986');await f.locator('[name="from"]').fill('2026-10-01');await f.locator('[name="to"]').fill('2026-10-31');await checkAll(f);await f.getByRole('button',{name:'Spara granskat momsunderlag'}).click();await expect(page.locator('#suite-toast')).toContainText('registrerade');expect((await saved(page)).declarations).toBeUndefined();
 await f.locator('[name="to"]').fill('2026-12-31');await f.getByRole('button',{name:'Spara granskat momsunderlag'}).click();await expect.poll(async()=>(await saved(page)).declarations?.length).toBe(1);
 const promise=page.waitForEvent('download');await page.getByRole('button',{name:'Hämta XML',exact:true}).click();const download=await promise;expect(await readFile((await download.path())!,'utf8')).toContain('<Period>202612</Period>');
});
test('reviewed INK2 creates a binary ZIP containing official SRU forms',async({page})=>{
 await seed(page);await open(page,'Inkomstdeklaration 2 · SRU ZIP');const f=form(page,'create-sru');await f.locator('[name="orgNumber"]').fill('5560269986');await f.locator('[name="postalCode"]').fill('12345');await f.locator('[name="city"]').fill('Örebro');await checkAll(f);await f.getByRole('button',{name:'Spara granskat INK2-underlag'}).click();await expect.poll(async()=>(await saved(page)).declarations?.length).toBe(1);
 const promise=page.waitForEvent('download');await page.getByRole('button',{name:'Hämta ZIP',exact:true}).click();const download=await promise,buffer=await readFile((await download.path())!);expect(download.suggestedFilename()).toBe('inkomstdeklaration-2026-12-31.zip');expect(buffer.readUInt32LE(0)).toBe(0x04034b50);expect(buffer.includes(Buffer.from('INFO.SRU'))).toBeTruthy();expect(buffer.includes(Buffer.from('#BLANKETT INK2-2026P4'))).toBeTruthy();
});
test('K2 annual report downloads printable full document after all required disclosures',async({page})=>{
 await seed(page,true);await open(page,'Årsredovisning · utskrivbart K2-dokument');const f=form(page,'create-annual');await f.locator('[name="orgNumber"]').fill('5560269986');await f.locator('[name="registeredOffice"]').fill('Örebro');await f.locator('[name="signaturePlace"]').fill('Örebro');await f.locator('[name="signatureDate"]').fill('2027-02-01');
 for(const name of ['managementReport','events','equityNote','accountingPolicies','assetNote','employeeNote','securityNote','debtNote','relatedPartyNote','taxNote','postBalanceEvents'])await f.locator(`[name="${name}"]`).fill('Granskad upplysning för testbolaget.');
 await f.locator('[name="signatories"]').fill('Åke Test; Styrelseledamot');await f.locator('[name="firstYear"]').check();await checkAll(f);await f.getByRole('button',{name:'Spara årsredovisning för utskrift'}).click();await expect.poll(async()=>(await saved(page)).declarations?.length).toBe(1);
 const promise=page.waitForEvent('download');await page.getByRole('button',{name:'Hämta årsredovisning',exact:true}).click();const download=await promise,text=await readFile((await download.path())!,'utf8');for(const heading of ['Förvaltningsberättelse','Resultaträkning','Balansräkning','Underskrifter','SUMMA TILLGÅNGAR'])expect(text).toContain(heading);
});
test('declarations remain usable on a narrow screen',async({page})=>{await page.setViewportSize({width:390,height:844});await seed(page);const width=await page.evaluate(()=>({actual:document.documentElement.scrollWidth,viewport:innerWidth}));expect(width.actual).toBeLessThanOrEqual(width.viewport);await expect(form(page,'create-agi').locator('[name="orgNumber"]')).toBeVisible();});
