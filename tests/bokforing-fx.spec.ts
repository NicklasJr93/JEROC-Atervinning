import { expect, test, type Page } from '@playwright/test';
const key='scrapplanner-bokforing-suite-v2';
test.use({viewport:{width:1500,height:1100}});
const errors=new WeakMap<Page,string[]>();
test.beforeEach(({page})=>{const values:string[]=[];errors.set(page,values);page.on('pageerror',error=>values.push(error.message));});
test.afterEach(({page})=>{expect(errors.get(page)).toEqual([]);});
const form=(page:Page,action:string)=>page.locator(`form[data-feature-form="fx"][data-action="${action}"]`).first();
const saved=(page:Page)=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),key);
async function create(page:Page,side='customer') {
 await page.goto('/bokforing/#fx');
 await expect(page.getByRole('heading',{name:'Fakturera i EUR och USD',exact:true})).toBeVisible();
 const f=form(page,'create');
 await f.locator('[name="side"]').selectOption(side);
 await f.locator('[name="date"]').fill('2026-10-01');
 await f.locator('[name="dueDate"]').fill('2026-10-31');
 await f.locator('[name="number"]').fill(side==='customer'?'FX-WEB-1':'LEV-WEB-1');
 await f.locator('[name="partyName"]').fill('Exempelkund');
 await f.locator('[name="partyAddress"]').fill('Exempelgatan 1');
 await f.locator('[name="sellerAddress"]').fill('Säljgatan 2');
 await f.locator('[name="sellerVatNumber"]').fill('SE559900123601');await f.locator('[name="sellerOrgNumber"]').fill('559900-1236');
 await f.locator('[name="partyPostalCode"]').fill('111 22');
 await f.locator('[name="partyCity"]').fill('Demostaden');
 await f.locator('[name="performanceConfirmed"]').check();
 await f.locator('[name="paymentReference"]').fill('Referens för test');
 await f.locator('[name="rate"]').fill('11,00');
 await f.locator('[name="rateSource"]').fill('Granskat kursunderlag');
 await f.locator('[name="lines"]').fill('Arbete; 80,00; 25; 6540');
 await f.locator('[name="reviewed"]').check();
 await f.getByRole('button',{name:'Spara valutautkast'}).click();
 await expect.poll(async()=>(await saved(page)).fxDocuments?.length).toBe(1);
 await form(page,'issue').getByRole('button',{name:'Utfärda och bokför'}).click();
 await expect.poll(async()=>(await saved(page)).fxDocuments[0].status).toBe('issued');
}
async function payment(page:Page,amount:string,bank:string) {
 await page.locator('.fx-document summary').filter({hasText:'Registrera betalning'}).click();
 const f=form(page,'pay');await f.locator('[name="date"]').fill('2026-10-10');await f.locator('[name="foreignAmount"]').fill(amount);await f.locator('[name="bankAmount"]').fill(bank);await f.locator('[name="reference"]').fill('PAY-'+String((await saved(page)).fxEvents.length));await f.getByRole('button',{name:'Bokför reglering och kursdifferens'}).click();
}
test('EUR invoice records partial/final settlement and keeps foreign and SEK balances after reload',async({page})=>{
 await create(page);await payment(page,'50,00','560,00');
 await expect.poll(async()=>(await saved(page)).fxEvents?.length).toBe(2);
 await page.reload();await expect(page.locator('.fx-summary')).toContainText('50,00');
 await payment(page,'50,00','540,00');
 await expect.poll(async()=>(await saved(page)).fxEvents?.length).toBe(3);
 const state=await saved(page);const entries=state.entries.filter((entry:{sourceType:string})=>entry.sourceType.startsWith('fx-'));
 expect(entries).toHaveLength(3);expect(state.fxDocuments[0].foreignGrossMinor).toBe(10000);
 await expect(page.locator('.fx-summary')).toContainText('Återstår 0,00');
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Hämta utskriftsbar faktura'}).click();expect((await download).suggestedFilename()).toContain('.html');
});
test('paid supplier invoice supports a partial credit and a separate refund',async({page})=>{
 await create(page,'supplier');await payment(page,'100,00','1100,00');
 await expect.poll(async()=>(await saved(page)).fxEvents?.length).toBe(2);
 await page.locator('.fx-document summary').filter({hasText:'Kreditera hela eller delar'}).click();
 const f=form(page,'credit');await f.locator('[name="date"]').fill('2026-10-11');await f.locator('[name="reference"]').fill('KREDIT-1');await f.locator('[name="reason"]').fill('Retur av halva leveransen');await f.locator('[name="creditLines"]').fill('1; 40,00');await f.locator('[name="rate"]').fill('11');await f.locator('[name="rateSource"]').fill('Kreditdagskurs');await f.locator('[name="rateReviewed"]').check();await f.getByRole('button',{name:'Bokför kreditnota'}).click();
 await expect.poll(async()=>(await saved(page)).fxEvents?.length).toBe(3);
 await expect(page.locator('.fx-summary')).toContainText('Tillgodo 50,00');
 await page.locator('.fx-document summary').filter({hasText:'Registrera återbetalning'}).click();
 const refund=form(page,'refund');await refund.locator('[name="date"]').fill('2026-10-12');await refund.locator('[name="foreignAmount"]').fill('50,00');await refund.locator('[name="bankAmount"]').fill('555,00');await refund.locator('[name="reference"]').fill('RETUR-1');await refund.getByRole('button',{name:'Bokför reglering och kursdifferens'}).click();
 await expect.poll(async()=>(await saved(page)).fxEvents?.length).toBe(4);await expect(page.locator('.fx-summary')).toContainText('Återstår 0,00');
});
test('mobile overpayment is rejected without a new journal entry',async({page})=>{
 await page.setViewportSize({width:390,height:844});await create(page);const before=await saved(page);await payment(page,'100,01','1100,11');
 await expect(page.locator('#suite-toast')).toContainText('överstiger');expect((await saved(page)).entries).toEqual(before.entries);
 const width=await page.evaluate(()=>({actual:document.documentElement.scrollWidth,viewport:innerWidth}));expect(width.actual).toBeLessThanOrEqual(width.viewport);
});

test('FX exempt customer invoice requires reviewed legal grounds before issuance',async({page})=>{
 await page.goto('/bokforing/#fx');const f=form(page,'create');
 await f.locator('[name="number"]').fill('FX-MOMSFRI');await f.locator('[name="date"]').fill('2026-10-01');await f.locator('[name="dueDate"]').fill('2026-10-31');
 await f.locator('[name="partyName"]').fill('Fiktiv hyresgäst');await f.locator('[name="partyAddress"]').fill('Testgatan 1');await f.locator('[name="partyPostalCode"]').fill('111 22');await f.locator('[name="partyCity"]').fill('Demostaden');
 await f.locator('[name="sellerAddress"]').fill('Testvägen 2');await f.locator('[name="sellerVatNumber"]').fill('SE559900123601');await f.locator('[name="sellerOrgNumber"]').fill('559900-1236');await f.locator('[name="sellerPostalCode"]').fill('222 33');await f.locator('[name="sellerCity"]').fill('Exempelorten');
 await f.locator('[name="performanceConfirmed"]').check();await f.locator('[name="paymentReference"]').fill('Fiktiv betalningsreferens');await f.locator('[name="rateSource"]').fill('Fiktivt kursunderlag');
 await f.locator('[name="taxTreatment"]').selectOption('no-vat');await f.locator('[name="taxReason"]').fill('Momsfri uthyrning enligt granskat hyresavtal');await f.locator('[name="lines"]').fill('Momsfri lokalhyra; 100,00; 0; 4010');await f.locator('[name="reviewed"]').check();
 await f.getByRole('button',{name:'Spara valutautkast'}).click();await expect.poll(async()=>(await saved(page)).fxDocuments?.length).toBe(1);
 await form(page,'issue').getByRole('button',{name:'Utfärda och bokför'}).click();await expect(page.locator('#suite-toast')).toContainText('momsundantag');expect((await saved(page)).fxDocuments[0].status).toBe('draft');
 await page.locator('.fx-document summary').filter({hasText:'Redigera utkast'}).click();const edit=form(page,'edit');
 await edit.locator('[name="vatExemptionCode"]').selectOption('property-rental');await edit.locator('[name="vatExemptionLegalBasis"]').fill('Fiktivt hyresavtal utan frivillig beskattning; 10 kap. 35 § ML.');await edit.locator('[name="vatExemptionConfirmed"]').check();await edit.locator('[name="reviewed"]').check();
 await edit.getByRole('button',{name:'Spara ändrat valutautkast'}).click();await form(page,'issue').getByRole('button',{name:'Utfärda och bokför'}).click();await expect.poll(async()=>(await saved(page)).fxDocuments[0].status).toBe('issued');
 expect((await saved(page)).fxDocuments[0].vatExemption.code).toBe('property-rental');
});
