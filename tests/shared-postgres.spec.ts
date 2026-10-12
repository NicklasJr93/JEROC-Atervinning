import {test,expect,type Page} from '@playwright/test';

const mobileCache='jeroc.mobile.demo.v1.employee.person-mobile-demo';
async function login(page:Page){
 const authenticated=await page.request.post('/api/employee/login',{data:{username:'niklas',password:'Demo123!'}});
 expect(authenticated.ok(),await authenticated.text()).toBe(true);
 await page.goto('/mobil#/yard');
 await expect(page.getByRole('heading',{name:'Gårdsarbete',exact:true})).toBeVisible();
}

test('mobilens färdiga vägning visas på kontoret och återläses från servern',async({page,request,browser})=>{
 await login(page);
 await expect.poll(()=>page.evaluate(()=>localStorage.getItem('jeroc.mobile.demo.v1.employee.person-mobile-demo.postgres-imported'))).toBe('yes');
 await page.getByRole('button',{name:/Starta invägning/}).click();
 await page.getByRole('button',{name:/Materialvåg/}).click();
 await page.locator('.material-choice').filter({hasText:'Koppar'}).click();
 await page.locator('.material-choice').filter({hasText:'Koppar klass 1'}).click();
 await page.getByRole('button',{name:'Välj Koppar klass 1',exact:true}).click();
 await page.getByRole('textbox',{name:'Vikt i kg'}).fill('17');
 await page.getByRole('button',{name:/Färdigvägt/}).click();
 await page.getByRole('button',{name:/Lägg till kund/}).click();
 await page.locator('.customer-choice').filter({hasText:'Bygg & Riv AB'}).click();
 await page.getByRole('button',{name:/Referens & ursprung/}).click();
 await page.getByLabel('Materialets ursprungsadress (valfritt)').fill('Testgatan 17, 761 41 Norrtälje');
 await page.getByRole('button',{name:'Spara uppgifter'}).click();
 await page.getByRole('button',{name:'Spara färdig vägning'}).click();
 await expect(page.getByRole('heading',{name:'Vägningen är sparad'})).toBeVisible();
 const id=await page.evaluate(()=>location.hash.split('/')[2]);
 await expect.poll(async()=>{const r=await request.get('/api/application/office',{headers:{'X-Demo-Actor':'admin'}});return (await r.json()).data.cards.filter((c:{sourceId:string})=>c.sourceId===id).length;}).toBe(1);
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),office=await context.newPage();
 await office.goto('/kontor');await office.getByRole('button',{name:/Systemadmin/}).click();
 const data=await (await request.get('/api/application/office',{headers:{'X-Demo-Actor':'admin'}})).json();
 const card=data.data.cards.find((c:{sourceId:string})=>c.sourceId===id);
 await office.goto(`/kontor#/weighings/${card.id}`);
 await expect(office.locator('.office-title')).toContainText(`Invägning #${card.id}`);
 await expect(office.getByLabel('Ursprungsadress',{exact:true})).toHaveValue('Testgatan 17, 761 41 Norrtälje');
 await page.reload();await expect(page.getByTestId('total-weight')).toHaveText('17 kg');
 await context.close();
});

test('oläsbar lokal cache bevaras och serveruppgifterna kan ändå öppnas',async({page})=>{
 await page.addInitScript(key=>localStorage.setItem(key,'{invalid legacy cache'),mobileCache);
 await login(page);
 await expect.poll(()=>page.evaluate(()=>localStorage.getItem('jeroc.mobile.demo.v1.employee.person-mobile-demo.postgres-imported'))).toBe('yes');
 expect(await page.evaluate(key=>localStorage.getItem(`${key}.legacy-before-postgres`),mobileCache)).toBe('{invalid legacy cache');
 await expect(page.getByRole('button',{name:/Starta invägning/})).toBeVisible();
});
