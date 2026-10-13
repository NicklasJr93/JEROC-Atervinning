import { CircleAlert } from 'lucide-react';
import { bankDiagnosticValue, type BankConsent } from './bank-integration-client';
import { environmentTime } from './environment-types';

/** Provider secrets and callback codes are omitted by the server projection. */
export default function BankConsentDiagnostics({ consent }: { consent?: BankConsent | null }) {
  if (!consent?.error && !consent?.authorisationDiagnostics) return null;
  const diagnostic = consent.authorisationDiagnostics;
  return <div className={`bank-feedback ${consent.error ? 'warning' : ''}`}>
    <CircleAlert size={16} /><div>
      {consent.error && <span>{consent.error.message}</span>}
      {diagnostic && <>
        <p className="bank-field-help">Godkännande hos testbanken: {diagnostic.ok ? 'aktiverat' : 'kunde inte aktiveras'}{diagnostic.httpStatus != null ? ` · HTTP ${diagnostic.httpStatus}` : ''}{diagnostic.providerCodes?.length ? ` · ${diagnostic.providerCodes.join(', ')}` : ''}{diagnostic.checkedAt ? ` · ${environmentTime(diagnostic.checkedAt)}` : ''}</p>
        <details className="bank-consent-diagnostics"><summary>Felsökningsinformation</summary><pre>{JSON.stringify(bankDiagnosticValue(diagnostic), null, 2)}</pre></details>
      </>}
      {consent.canReauthorise && <p className="bank-field-help">Prova bankgodkännandet igen för att få en ny länk till samma medgivande.</p>}
      {!consent.canReauthorise && diagnostic && !diagnostic.ok && consent.status !== 'valid' && <p className="bank-field-help">Kontrollera och försök igen kontrollerar samma medgivande hos banken innan en ny godkännandelänk kan skapas.</p>}
    </div>
  </div>;
}
