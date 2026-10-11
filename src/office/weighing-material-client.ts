import { officeSchema, type OfficeCard } from './model';

export type MaterialCommand = {
  cardId: number;
  expectedRows: OfficeCard['rows'];
  operation: 'add' | 'remove' | 'weight';
  rowIndex?: number;
  articleId?: string;
  weight?: number;
};

export async function changeWeighingMaterial(command: MaterialCommand, actualUserId: string, effectiveUserId: string) {
  const response = await fetch('/api/application/office/material', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Demo-Actor': actualUserId, 'X-Demo-User': effectiveUserId },
    body: JSON.stringify(command),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? result.message ?? 'Materialändringen kunde inte sparas.');
  if (!Number.isSafeInteger(result.revision) || result.revision < 0) throw new Error('Serverns bekräftelse kunde inte läsas. Läs in kortet igen.');
  return { card: officeSchema.shape.cards.element.parse(result.cardProjection), revision: result.revision as number };
}
