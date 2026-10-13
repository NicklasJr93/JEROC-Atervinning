import type { RefObject } from 'react';
import NvvConnectionCheckDialog, { type ExternalConnectionTest, type NvvCheckProgress } from './NvvConnectionCheckDialog';
import { bankDiagnosticValue, bankJournalEntries, type BankConnectionResult } from './bank-integration-client';

export type BankCheckState = { scope: string; progress: NvvCheckProgress; result?: BankConnectionResult };
export const bankCheckResult = (scope: string, result: BankConnectionResult): BankCheckState => ({ scope, result, progress: result.ok
  ? { phase: 'success', mode: 'test', wasteCodes: 0, transportModes: 0 }
  : { phase: 'error', mode: 'test', message: result.error?.message || result.message || 'Bankanslutningen kunde inte verifieras.' } });

/** Both bank pages show the same actual, redacted connection result. */
export default function BankConnectionCheckDialog({ check, onClose, onReadHistory, returnFocus }: {
  check: BankCheckState; onClose: () => void; onReadHistory: () => void; returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const last = bankJournalEntries(check.result?.journal).at(-1);
  const response = last?.response;
  const data = response && typeof response === 'object' && 'data' in response ? (response as { data: unknown }).data : response ?? last?.data;
  const httpStatus = last?.httpStatus ?? last?.statusCode ?? (response && typeof response === 'object' && 'httpStatus' in response ? (response as { httpStatus: number }).httpStatus : undefined);
  const external: ExternalConnectionTest = { provider: 'Open Payments', environmentLabel: 'BANK · SANDBOX', method: last?.request?.method ?? last?.method ?? 'GET',
    path: last?.request?.path ?? last?.path ?? '/bank/test', payload: last?.request?.payload ? bankDiagnosticValue(last.request.payload) as ExternalConnectionTest['payload'] : undefined,
    run: check.result ? { status: check.result.ok ? 'accepted' : 'rejected', httpStatus, response: bankDiagnosticValue(data ?? check.result.error), trackingId: last?.requestId, finishedAt: check.result.checkedAt } : undefined };
  return <NvvConnectionCheckDialog progress={check.progress} onClose={onClose} onRetry={onReadHistory} returnFocus={returnFocus} externalTest={external} />;
}
