import { expect, test } from '@playwright/test';
import { OFFICE_WEIGHING_DEMO_VERSION, seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import { demoPrivateIdentityNumber } from '../src/data';

test('äldre testinvägningar ersätts en gång medan användare och kundregister behålls', () => {
  const previous = seedOffice();
  previous.weighingDemoVersion = undefined;
  previous.cards = [{ ...previous.cards[2], id: 2041, sourceId: undefined,
    status: 'ready', preparedBy: 'kajsa', approvedBy: 'anna', idVerified: true }];
  previous.users[0].name = 'Personligt ändrat demonamn';
  previous.customers[0].name = 'Bevarat kundnamn AB';
  previous.payments = [{ id: 'old-payment', cardId: 2041, customerId: 'customer-build',
    amount: 100, offset: 0, method: 'cash', date: '2026-10-08T10:00:00Z',
    reference: 'Gammalt testunderlag', actor: 'Anna', office: 'Norrtälje' }];
  previous.corrections = [{ id: 1, cardId: 2041, customerId: 'customer-build',
    articleId: 'iron', weightDelta: -10, reason: 'Äldre test', actor: 'Kajsa', at: '2026-10-08T11:00:00Z' }];

  const replaced = migrateOffice(previous);
  expect(replaced.weighingDemoVersion).toBe(OFFICE_WEIGHING_DEMO_VERSION);
  expect(replaced.cards.map((card) => card.id)).toEqual([2050, 2051, 2052, 2053]);
  expect(replaced.cards.every((card) => ['new', 'complement'].includes(card.status))).toBe(true);
  expect(replaced.cards.every((card) => !card.idVerified && !card.customerApproval && !card.approvedBy && !card.preparedBy)).toBe(true);
  expect(replaced.payments).toEqual([]);
  expect(replaced.corrections).toEqual([]);
  expect(replaced.users).toEqual(previous.users);
  expect(replaced.customers).toEqual(previous.customers);

  replaced.cards[0].reference = 'Arbetet fortsätter efter uppdateringen';
  replaced.cards.pop();
  const reloaded = migrateOffice(JSON.parse(JSON.stringify(replaced)));
  expect(reloaded.cards).toEqual(replaced.cards);
  expect(reloaded.cards).toHaveLength(3);
});

test('nya lokala kort får beständig unik källidentitet även om kortnumret krockar', () => {
  const first = seedOffice(), second = seedOffice();
  first.cards.push({ ...first.cards[0], id: 9999, sourceId: undefined });
  second.cards.push({ ...second.cards[0], id: 9999, sourceId: undefined });
  const firstMigrated = migrateOffice(first), secondMigrated = migrateOffice(second);
  expect(firstMigrated.cards.at(-1)?.sourceId).toBeTruthy();
  expect(firstMigrated.cards.at(-1)?.sourceId).not.toBe(secondMigrated.cards.at(-1)?.sourceId);
  expect(migrateOffice(firstMigrated).cards.at(-1)?.sourceId).toBe(firstMigrated.cards.at(-1)?.sourceId);
  expect(new Set(firstMigrated.cards.map((card) => card.sourceId)).size).toBe(firstMigrated.cards.length);
});

test('miljörättigheter migreras en gång och återkallade rättigheter återkommer inte', () => {
  const previous = seedOffice();
  previous.environmentPermissionsVersion = undefined;
  previous.users = previous.users.map((user) => ({ ...user,
    permissions: user.permissions.filter((permission) => !permission.startsWith('environment')) }));
  const migrated = migrateOffice(previous);
  const kajsa = migrated.users.find((user) => user.id === 'kajsa')!;
  expect(kajsa.permissions).toContain('environmentRead');
  expect(kajsa.permissions).toContain('environmentWrite');
  expect(migrated.users.find((user) => user.id === 'anna')!.permissions).toContain('environmentRead');
  kajsa.permissions = kajsa.permissions.filter((permission) => !permission.startsWith('environment'));
  const reloaded = migrateOffice(migrated);
  expect(reloaded.users.find((user) => user.id === 'kajsa')!.permissions.some((permission) => permission.startsWith('environment'))).toBe(false);
});

test('artikelrättigheten läggs till en gång utan att rensa kort eller återställa återkallad behörighet', () => {
  const previous = seedOffice();
  previous.weighingArticlePermissionsVersion = undefined;
  const kajsa = previous.users.find(user => user.id === 'kajsa')!;
  kajsa.permissions = kajsa.permissions.filter(right => right !== 'weighingAddArticle');
  previous.cards[0].origin = 'Behåll min testadress';
  const migrated = migrateOffice(previous);
  const updated = migrated.users.find(user => user.id === 'kajsa')!;
  expect(updated.permissions).toContain('weighingAddArticle');
  expect(migrated.cards[0].origin).toBe('Behåll min testadress');
  updated.permissions = updated.permissions.filter(right => right !== 'weighingAddArticle');
  expect(migrateOffice(migrated).users.find(user => user.id === 'kajsa')!.permissions).not.toContain('weighingAddArticle');
});

test('äldre demopersonnummer rättas en gång utan att ändra eget kundnummer eller låst kundsnapshot', () => {
  const previous = seedOffice();
  previous.demoPrivateIdentityVersion = undefined;
  const erik = previous.customers.find(customer => customer.id === 'customer-erik')!;
  erik.number = 'Demo · privatperson';
  previous.cards[0].customerSnapshot = { ...erik };
  previous.cards[0].reference = 'Behåll tidigare avräkningsversion';
  const originalSnapshot = structuredClone(previous.cards[0].customerSnapshot);

  const migrated = migrateOffice(previous);
  expect(migrated.customers.find(customer => customer.id === erik.id)!.number).toBe(demoPrivateIdentityNumber);
  expect(migrated.cards[0].customerSnapshot).toEqual(originalSnapshot);
  expect(migrated.cards[0].reference).toBe('Behåll tidigare avräkningsversion');
  expect(migrated.cards.map(card => card.id)).toEqual(previous.cards.map(card => card.id));

  // The one-time migration must not overwrite subsequent customer edits.
  migrated.customers.find(customer => customer.id === erik.id)!.number = 'Demo · privatperson';
  expect(migrateOffice(migrated).customers.find(customer => customer.id === erik.id)!.number).toBe('Demo · privatperson');
  const customized = structuredClone(previous);
  customized.customers.find(customer => customer.id === erik.id)!.number = '19850505-1234';
  expect(migrateOffice(customized).customers.find(customer => customer.id === erik.id)!.number).toBe('19850505-1234');
});
