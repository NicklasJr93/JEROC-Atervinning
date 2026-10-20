import { test, expect } from '@playwright/test';
import { completeCustomerIdentifier } from '../src/customer-identity';

// Synthetic, locally generated checksum identities. These tests never look up
// a person, use a customer's real identifier, or launch a browser.
function identifier(shortDate: string, serial = '042'): string {
  const prefix = `${shortDate}${serial}`;
  const sum = [...prefix].reduce((total, character, index) => {
    const value = Number(character) * (index % 2 === 0 ? 2 : 1);
    return total + (value > 9 ? value - 9 : value);
  }, 0);
  return `${prefix}${(10 - sum % 10) % 10}`;
}
const dashed = (value: string) => `${value.slice(0, 6)}-${value.slice(6)}`;
const plus = (value: string) => `${value.slice(0, 6)}+${value.slice(6)}`;
const today = new Date('2026-10-20T10:00:00.000Z');

test('tio giltiga siffror kompletteras till senaste riktiga födelsedatum som inte ligger i framtiden', () => {
  const pastCentury = identifier('900101'), thisYearBorn = identifier('261020'), notBornYet = identifier('261021');
  expect(completeCustomerIdentifier(pastCentury, today)).toBe(`19${pastCentury}`);
  expect(completeCustomerIdentifier(thisYearBorn, today)).toBe(`20${thisYearBorn}`);
  expect(completeCustomerIdentifier(notBornYet, today)).toBe(`19${notBornYet}`);
  const futureYear = identifier('270101');
  expect(completeCustomerIdentifier(futureYear, today)).toBe(`19${futureYear}`);
});

test('giltiga tio siffror med bindestreck eller mellanslag får samma fullständiga identitet', () => {
  const value = identifier('900101');
  for (const input of [value, dashed(value), ` ${dashed(value)} `, `${value.slice(0, 6)} ${value.slice(6)}`])
    expect(completeCustomerIdentifier(input, today), input).toBe(`19${value}`);
});

test('datumgränsen följer Stockholm även när UTC fortfarande visar föregående dag eller år', () => {
  const birthday = identifier('261021');
  expect(completeCustomerIdentifier(birthday, new Date('2026-10-20T21:59:59.000Z'))).toBe(`19${birthday}`);
  expect(completeCustomerIdentifier(birthday, new Date('2026-10-20T22:00:00.000Z'))).toBe(`20${birthday}`);
  const newYear = identifier('270101');
  expect(completeCustomerIdentifier(newYear, new Date('2026-12-31T22:59:59.000Z'))).toBe(`19${newYear}`);
  expect(completeCustomerIdentifier(newYear, new Date('2026-12-31T23:00:00.000Z'))).toBe(`20${newYear}`);
});

test('plustecken använder kalenderåret personen fyller hundra, även före födelsedagen', () => {
  const laterBirthday = identifier('261201'), earlierBirthday = identifier('260101');
  expect(completeCustomerIdentifier(plus(laterBirthday), today)).toBe(`19${laterBirthday}`);
  expect(completeCustomerIdentifier(plus(earlierBirthday), today)).toBe(`19${earlierBirthday}`);
  // Do not derive this from a rolling date cutoff such as today minus 100 years.
  const december = identifier('241231');
  expect(completeCustomerIdentifier(plus(december), new Date('2023-12-31T22:59:59.000Z'))).toBe(`18${december}`);
  expect(completeCustomerIdentifier(plus(december), new Date('2023-12-31T23:00:00.000Z'))).toBe(`19${december}`);
});

test('plus väljer inte ett år vars hundraårsår fortfarande ligger framför oss', () => {
  const nextYear = identifier('270101');
  expect(completeCustomerIdentifier(plus(nextYear), today)).toBe(`18${nextYear}`);
  const previousYear = identifier('251231');
  expect(completeCustomerIdentifier(plus(previousYear), today)).toBe(`19${previousYear}`);
});

test('skottdagen verifieras i det faktiska århundradet och rullas aldrig till första mars', () => {
  const leapDay = identifier('000229');
  expect(completeCustomerIdentifier(leapDay, today)).toBe(`20${leapDay}`);
  // 1900 and 1800 were not leap years. The plus sign excludes 2000 here.
  expect(completeCustomerIdentifier(plus(leapDay), today)).toBe(plus(leapDay));
  expect(completeCustomerIdentifier(leapDay, new Date('1926-10-20T10:00:00.000Z'))).toBe(leapDay);
  const ordinaryLeap = identifier('040229');
  expect(completeCustomerIdentifier(plus(ordinaryLeap), today)).toBe(`19${ordinaryLeap}`);
});

test('explicit angivet århundrade och juridiska organisationsnummer ändras inte', () => {
  const person = identifier('900101'), org = identifier('559999');
  const explicit = [`19${person}`, `19${person.slice(0, 6)}-${person.slice(6)}`, `20${person}`];
  for (const input of [...explicit, org, dashed(org), `16${org}`, `16${dashed(org)}`])
    expect(completeCustomerIdentifier(input, today), input).toBe(input);
});

test('samordningsnummer lämnas oförändrade i stället för att gissa födelseår', () => {
  const coordination = identifier('900161');
  for (const input of [coordination, dashed(coordination), plus(coordination), `19${coordination}`])
    expect(completeCustomerIdentifier(input, today), input).toBe(input);
});

test('ofullständiga, felaktiga och ogiltiga datum får ingen automatisk komplettering', () => {
  const valid = identifier('900101'), badChecksum = `${valid.slice(0, -1)}${(Number(valid.at(-1)) + 1) % 10}`;
  const inputs = ['', ' ', valid.slice(0, 9), `${valid}0`, badChecksum, dashed(badChecksum),
    ...['900231', '901301', '900000', '990229'].map(value => identifier(value)),
    `${valid.slice(0, 6)}++${valid.slice(6)}`, `${valid.slice(0, 5)}+${valid.slice(5)}`, `x${valid}`];
  for (const input of inputs) expect(completeCustomerIdentifier(input, today), input).toBe(input);
});

test('ett ogiltigt uttryckligt klockvärde ersätts inte med en gissning från datorns datum', () => {
  const value = identifier('900101');
  expect(completeCustomerIdentifier(value, new Date('invalid'))).toBe(value);
});

test('ett ofärdigt långt format med bindestreck efter åtta siffror behandlas inte som färdiga tio siffror', () => {
  const short = identifier('200101', '017');
  expect(completeCustomerIdentifier(`${short.slice(0, 8)}-${short.slice(8)}`, today)).toBe(`${short.slice(0, 8)}-${short.slice(8)}`);
  expect(completeCustomerIdentifier(`${short.slice(0, 3)}-${short.slice(3)}`, today)).toBe(`${short.slice(0, 3)}-${short.slice(3)}`);
  const older = identifier('201201');
  expect(completeCustomerIdentifier(`${older.slice(0, 6)}＋${older.slice(6)}`, today)).toBe(`19${older}`);
});
