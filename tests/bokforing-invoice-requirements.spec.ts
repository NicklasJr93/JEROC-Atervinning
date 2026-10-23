import { expect, test } from '@playwright/test';
const key='scrapplanner-bokforing-suite-v2';
test.use({viewport:{width:1440,height:1050},locale:'sv-SE'});

test('invoice requirements: incomplete date remains a draft, can be completed and prints frozen identities',async({page})=>{
  await page.goto('/bokforing/#sales/new');
  const form=page.locator('#invoice-page-form');await expect(form).toBeVisible();
  await expect(form.locator('[name="performance.confirmed"]')).not.toBeChecked();
  await form.getByRole('button',{name:'Spara utkast',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Komplettera före utfärdande'})).toBeVisible();
  await expect(page.locator('[data-action="issue-invoice"]')).toBeDisabled();
  await page.locator('#suite-main [data-action="edit-invoice"]').first().click();
  await form.locator('[name="performance.confirmed"]').check();
  await form.getByRole('button',{name:'Spara utkast',exact:true}).click();
  await page.locator('#suite-main [data-action="issue-invoice"]').click();
  await page.locator('#suite-dialog [name="reviewed"]').check();
  await page.locator('#suite-dialog button[type="submit"]').click();
  await expect(page.locator('#suite-dialog')).not.toBeVisible();
  const invoice=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!).invoices.at(-1),key);
  expect(invoice.status).toBe('issued');expect(invoice.details.requirementsVersion).toBe(1);
  expect(invoice.details.performance).toEqual({mode:'date',date:invoice.date,confirmed:true});
  expect(invoice.details.seller.vatNumber).toBe('SE559999999101');
  await page.reload();await expect(page.locator('#suite-main')).toContainText('Leverans / utförande');
});

test('invoice requirements: explicit zero-VAT classification survives the editor and posting',async({page})=>{
  await page.goto('/bokforing/#sales/new');const form=page.locator('#invoice-page-form');await expect(form).toBeVisible();
  await form.locator('[data-line-field="vatRate"]').first().selectOption('0');
  const reason=form.locator('[data-vat-exemption-row]').first();await expect(reason).toBeVisible();
  await reason.locator('[data-line-field="vatExemption.code"]').selectOption('healthcare');
  await reason.locator('[data-line-field="vatExemption.legalBasis"]').fill('Fiktiv granskad vårdtjänst enligt 10 kap. ML');
  await reason.locator('[data-line-field="vatExemption.confirmed"]').check();
  await form.locator('[name="performance.confirmed"]').check();
  await form.getByRole('button',{name:'Spara utkast',exact:true}).click();
  await page.locator('#suite-main [data-action="issue-invoice"]').click();
  await page.locator('#suite-dialog [name="reviewed"]').check();await page.locator('#suite-dialog button[type="submit"]').click();
  await expect(page.locator('#suite-dialog')).not.toBeVisible();
  await expect(page.locator('#suite-main')).toContainText('Undantag från skatteplikt');
  const invoice=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!).invoices.at(-1),key);
  expect(invoice.lines[0].vatExemption.code).toBe('healthcare');expect(invoice.lines[0].vatExemption.confirmed).toBe(true);
  await page.reload();await expect(page.locator('#suite-main')).toContainText('Fiktiv granskad vårdtjänst');
});
