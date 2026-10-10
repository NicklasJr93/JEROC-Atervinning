export interface DocumentIdentity { actualUserId: string; userId: string }
export type DocumentStage = 'preliminary' | 'reviewed' | 'final' | 'draft';
export type DocumentKind = 'settlement' | 'receipt' | 'transport';
export interface ArchivedDocument {
  id: string; kind: DocumentKind; sourceId: string | number; sourceVersion: string | number;
  stage: DocumentStage; siteId: string; title: string; sourceHash: string; pdfHash: string;
  templateVersion: string | number; createdAt: string; downloadUrl: string;
}
export interface DocumentParty { name: string; number: string; address: string; postalCode: string; city: string }
export interface TransportDocumentRow { articleId?: string; name: string; wasteCode: string; weight: number | null }
export interface TransportDocumentDraft {
  managed?: boolean;
  orderId: string; version: number; siteId: string; direction: 'pickup' | 'outbound';
  sender: DocumentParty; receiver: DocumentParty; carrier: DocumentParty;
  driver: string; registration: string; startAt: string; requestedAt: string;
  handling: string; rows: TransportDocumentRow[]; reference: string; missing: string[]; updatedAt: string;
}
export interface DocumentSite { id: string; name: string; party?: DocumentParty }
export interface TransportDocumentResponse { sites?: DocumentSite[]; draft: TransportDocumentDraft; documents: ArchivedDocument[]; demo: true }
export type TransportDocumentChanges = Pick<TransportDocumentDraft, 'siteId' | 'direction' | 'sender' | 'receiver' | 'carrier' | 'driver' | 'registration' | 'startAt' | 'requestedAt' | 'handling' | 'rows' | 'reference'>;
export const documentStageNames: Record<DocumentStage, string> = { preliminary: 'Preliminär', reviewed: 'Kundgodkänd', final: 'Slutlig', draft: 'Utkast' };
export const documentsNewestFirst = (documents: ArchivedDocument[]) => [...documents].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || String(right.id).localeCompare(String(left.id)));
const headers = (identity: DocumentIdentity) => ({ 'X-Demo-Actor': identity.actualUserId, 'X-Demo-User': identity.userId });
async function request<T>(path: string, identity: DocumentIdentity, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/documents${path}`, { method, credentials: 'same-origin', signal,
    headers: { ...headers(identity), Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(value.error || 'Dokumentet kunde inte hämtas. Försök igen.');
  return value as T;
}
export const documentApi = {
  list: (kind: DocumentKind, sourceId: string | number, identity: DocumentIdentity, signal?: AbortSignal) => request<{documents: ArchivedDocument[]; demo: true}>(`?kind=${encodeURIComponent(kind)}&sourceId=${encodeURIComponent(sourceId)}`, identity, 'GET', undefined, signal),
  settlement: (cardId: number, stage: Exclude<DocumentStage, 'draft'>, identity: DocumentIdentity) => request<{document: ArchivedDocument}>(`/settlements/${encodeURIComponent(cardId)}/generate`, identity, 'POST', { stage }),
  receipt: (paymentId: string, identity: DocumentIdentity) => request<{document: ArchivedDocument}>(`/receipts/${encodeURIComponent(paymentId)}/generate`, identity, 'POST', {}),
  transport: (orderId: string, identity: DocumentIdentity, signal?: AbortSignal) => request<TransportDocumentResponse>(`/transport/${encodeURIComponent(orderId)}`, identity, 'GET', undefined, signal),
  saveTransport: (orderId: string, value: TransportDocumentChanges, expectedVersion: number, identity: DocumentIdentity) => request<{draft: TransportDocumentDraft; documents?: ArchivedDocument[]; demo: true}>(`/transport/${encodeURIComponent(orderId)}`, identity, 'PUT', { ...value, expectedVersion }),
  generateTransport: (orderId: string, identity: DocumentIdentity) => request<{document: ArchivedDocument; draft: TransportDocumentDraft}>(`/transport/${encodeURIComponent(orderId)}/generate`, identity, 'POST', {}),
};
/** The download route is built here: never forward identity headers to a URL from metadata. */
export async function readDocumentPdf(document: ArchivedDocument, identity: DocumentIdentity, signal?: AbortSignal): Promise<{blob: Blob; filename: string}> {
  const response = await fetch(`/api/documents/${encodeURIComponent(document.id)}/download`, {
    credentials: 'same-origin', headers: { ...headers(identity), Accept: 'application/pdf' }, signal,
  });
  if (!response.ok) { const error = await response.json().catch(() => ({})) as {error?: string}; throw new Error(error.error || 'PDF-filen kunde inte hämtas.'); }
  if (!response.headers.get('Content-Type')?.toLowerCase().includes('application/pdf')) throw new Error('Servern svarade inte med en PDF-fil.');
  const blob = await response.blob();
  const serverName = response.headers.get('Content-Disposition')?.match(/filename="([^\"]+)"/)?.[1];
  const filename = (serverName || `${document.kind}-${document.sourceId}-${document.sourceVersion}.pdf`).replace(/[\\/\u0000-\u001f]/g, '_');
  return { blob, filename };
}
