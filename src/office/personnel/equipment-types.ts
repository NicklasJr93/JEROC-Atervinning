export type EquipmentCategory = 'phone' | 'tool' | 'ppe' | 'key' | 'other';
export type EquipmentStatus = 'available' | 'issued' | 'maintenance' | 'retired';
export type EquipmentReturnCondition = 'available' | 'maintenance';
export interface EquipmentItem {
  id: string; inventoryNumber: string; name: string; category: EquipmentCategory; siteId: string;
  serialNumber: string; description: string; status: EquipmentStatus; revision: number;
  createdAt: string; updatedAt: string;
}
export interface EquipmentAssignment {
  id: string; itemId: string; personId: string; siteId?: string; itemName?: string; inventoryNumber?: string; issuedAt: string; issuedBy?: string;
  issuedActualUserId?: string; issuedEffectiveUserId?: string; issueNote: string;
  returnedAt?: string; returnedBy?: string; returnedActualUserId?: string; returnedEffectiveUserId?: string;
  returnCondition?: EquipmentReturnCondition; returnNote?: string;
}
export interface EquipmentEvent {
  id: string; action: 'item.save' | 'item.issue' | 'item.return'; itemId: string; personId?: string;
  assignmentId?: string; at: string; actualUserId?: string; effectiveUserId?: string; actor?: string; text: string; note?: string;
}
export interface EquipmentData {
  version: 1; revision: number; items: EquipmentItem[]; assignments: EquipmentAssignment[]; events: EquipmentEvent[];
}
export interface EquipmentResponse {
  data: EquipmentData; people: { id: string; name: string; role: string; team: string; siteIds: string[]; active: boolean }[];
  sites: { id: string; name: string }[]; revision: number; storage: 'database';
  capabilities: ('equipmentRead' | 'equipmentWrite')[];
}
export interface EmployeeEquipmentResponse { items: EquipmentItem[]; assignments: EquipmentAssignment[]; events: EquipmentEvent[]; revision: number }
export type EquipmentCommand = ({ requestId?: string } & (
  | { action: 'item.save'; item: { id?: string; inventoryNumber: string; name: string; category: EquipmentCategory; siteId: string; serialNumber?: string; description?: string; status?: Exclude<EquipmentStatus, 'issued'>; revision?: number } }
  | { action: 'item.issue'; id: string; revision: number; personId: string; note?: string }
  | { action: 'item.return'; id: string; revision: number; condition?: EquipmentReturnCondition; note?: string }));

export const equipmentCategoryLabels: Record<EquipmentCategory, string> = { phone: 'Telefon', tool: 'Verktyg', ppe: 'Skyddsutrustning', key: 'Nyckel', other: 'Övrigt' };
export const equipmentStatusLabels: Record<EquipmentStatus, string> = { available: 'Tillgänglig', issued: 'Utlämnad', maintenance: 'Service / kontroll', retired: 'Avregistrerad' };
export const equipmentTime = (value?: string) => value ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
