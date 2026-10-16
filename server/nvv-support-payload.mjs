export const NVV_SUPPORT_PRESET = 'support-2026-10-16';
export const NVV_TESTBOLAG1_OWN_PRESET = 'testbolag1-own-2026-10-16';
export const NVV_SUPPORT_CERTIFICATE_FINGERPRINT = '71:0F:90:58:33:AA:17:60:90:89:48:AC:2A:DD:87:F3:B0:12:64:4E:88:6C:84:B5:FB:AB:13:A7:E5:5D:72:27';

/** Synthetic support case, independent of ordinary reporter settings or cards. */
export function supportPayload(time, id) {
  return {
    tidpunkt: time.toISOString(), verksamhetsutovare: '5593593626', verksamhetensNamn: 'JEROC Återvinning AB',
    verksamhetensKontaktpersonNamn: 'Testkontakt JEROC', verksamhetensKontaktpersonEpost: 'nvv-test@example.invalid',
    verksamhetensKontaktpersonTelefonnummer: '0700000000',
    ombud: '5560000167', ombudetsNamn: 'Testbolag 1', ombudetsKontaktpersonNamn: 'Testkontakt Ombud',
    ombudetsKontaktpersonEpost: 'nvv-ombud@example.invalid', ombudetsKontaktpersonTelefonnummer: '0700000000',
    referens: `JEROC-SUPPORT-${id.replaceAll('-', '').slice(0, 24)}`, avfall: { kod: '160601', mangd: 10 },
    mottagningsDatum: time.toISOString(), tidigareInnehavare: '5560000167', transportsatt: 'R',
    senasteHanteringsPlats: { kommunkod: '0188', adress: { adressrad: 'Testgatan 12, Norrtälje', postnummer: '76141' } },
    kommandeHanteringsPlats: { kommunkod: '0188', adress: { adressrad: 'Ängsvägen 19, Norrtälje', postnummer: '76141' } },
  };
}

/** Separate synthetic control: Testbolag 1 reports for itself, without an agent. */
export function testbolag1OwnPayload(time, id) {
  const payload = supportPayload(time, id);
  for (const key of Object.keys(payload)) if (key.startsWith('ombud')) delete payload[key];
  return { ...payload, verksamhetsutovare: '5560000167', verksamhetensNamn: 'Testbolag 1',
    verksamhetensKontaktpersonNamn: 'Testkontakt Testbolag', verksamhetensKontaktpersonEpost: 'nvv-own@example.invalid',
    tidigareInnehavare: '5560000167', referens: `TESTBOLAG1-OWN-${id.replaceAll('-', '').slice(0, 24)}` };
}
