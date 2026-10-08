import type { OfficeCard, OfficeCustomer } from './model';

export type ApprovalStatus = 'waiting' | 'id_requested' | 'approved' | 'change_requested' | 'cancelled' | 'expired' | 'attested';
export interface DemoSite { id: string; name: string }
export interface DemoTerminal {
  id: string; name: string; username: string; siteId: string; active: boolean;
  online: boolean; busy: boolean; activeApprovalId?: string; lastSeen?: string;
}
export interface SettlementRow { articleId: string; name: string; weight: number; price: number; amount: number }
export interface PublicSettlement {
  cardId: number; version: number; customerName: string; customerNumber?: string;
  siteName: string; rows: SettlementRow[]; gross: number; offset: number; net: number;
  paymentMethod: 'bank' | 'swish' | 'cash' | 'balance'; reference: string;
  origin?: string; deliveredAt: string; termsVersion: string; hash: string;
}
export interface TerminalApproval {
  id: string; cardId: number; siteId: string; terminalId: string; version: number;
  status: ApprovalStatus; createdAt: string; updatedAt: string; sentBy: string;
  actualUserId: string; effectiveUserId: string; comment?: string;
  approvedBy?: string; approvedAt?: string; attestedBy?: string; attestedAt?: string;
  snapshot: {
    card: OfficeCard; customer: OfficeCustomer; rows: SettlementRow[];
    gross: number; offset: number; net: number;
    paymentMethod: 'bank' | 'swish' | 'cash' | 'balance';
    reference: string; origin: string; deliveredAt: string; termsVersion: string; hash: string;
  };
}
export interface PublicApproval {
  id: string; version: number; status: ApprovalStatus; updatedAt: string;
  snapshot: PublicSettlement;
}
export interface TerminalDemoState {
  configured: boolean; revision: number; sites: DemoSite[]; terminals: DemoTerminal[];
  approvals: TerminalApproval[];
  defaults: { userId: string; siteId: string; terminalId: string }[];
}
export interface TerminalSessionState { terminal: DemoTerminal; approval: PublicApproval | null; siteName?: string }
export interface ApprovalSend {
  card: OfficeCard; customer: OfficeCustomer; terminalId: string; siteId: string;
  rows: SettlementRow[]; offset: number; correctionIds: number[]; idempotencyKey: string;
}
export const approvalLabels: Record<ApprovalStatus, string> = {
  waiting: 'Inväntar kund', id_requested: 'Inväntar ID-kontroll', approved: 'Godkänd av kund',
  change_requested: 'Ändring begärd', cancelled: 'Avbruten', expired: 'Utgången', attested: 'JEROC-attesterad',
};
export const activeApprovalStatuses: ApprovalStatus[] = ['waiting', 'id_requested', 'change_requested', 'expired'];
