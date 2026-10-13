import { ensureSwishMssCertificates, validateSwishMssCredentials } from '../server/swish-mss-certificates.mjs';

try {
  const credentials = await ensureSwishMssCertificates();
  const metadata = validateSwishMssCredentials(credentials);
  console.log(`Swish MSS:s publika testcertifikat är klara. Testnummer ${metadata.merchantAlias}, giltigt till ${metadata.validTo}. Inga skarpa betalningar stöds.`);
} catch {
  console.error('Swish MSS:s testcertifikat kunde inte verifieras. Kontrollera åtkomst till Swishs offentliga certifikatpaket.');
  process.exitCode = 1;
}
