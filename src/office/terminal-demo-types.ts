import { z } from 'zod';
import { officeSchema, type OfficeCard, type OfficeCustomer } from './model';

export type ApprovalStatus = 'waiting' | 'id_requested' | 'approved' | 'change_requested' | 'cancelled' | 'expired' | 'attested';
export interface DemoSite { id: string; name: string; active?: boolean }
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
  displayedAt?: string; revision?: number;
  snapshot: {
    card: OfficeCard; customer: OfficeCustomer; rows: SettlementRow[];
    gross: number; offset: number; net: number;
    paymentMethod: 'bank' | 'swish' | 'cash' | 'balance';
    reference: string; origin: string; deliveredAt: string; termsVersion: string; hash: string;
  };
}
export interface PublicApproval {
  id: string; version: number; status: ApprovalStatus; updatedAt: string;
  displayedAt?: string; revision?: number;
  snapshot: PublicSettlement;
}
export interface TerminalDemoState {
  configured: boolean; revision: number; sites: DemoSite[]; terminals: DemoTerminal[];
  actualUserId?: string; effectiveUserId?: string;
  approvals: TerminalApproval[];
  defaults: { userId: string; siteId: string; terminalId: string }[];
}
export interface TerminalSessionState {
  terminal: DemoTerminal; approval: PublicApproval | null; siteName?: string;
  revision?: number; connectionId?: string;
}
export interface CustomerReviewCommand {
  cardId: number; terminalId: string; siteId: string; expectedCard: OfficeCard; idempotencyKey: string;
}
export interface CustomerReviewResult {
  approval: TerminalApproval; cardProjection: OfficeCard; revision: number;
}
export interface ApprovalSend {
  card: OfficeCard; customer: OfficeCustomer; terminalId: string; siteId: string;
  rows: SettlementRow[]; offset: number; correctionIds: number[]; idempotencyKey: string;
}
export const approvalLabels: Record<ApprovalStatus, string> = {
  waiting: 'Inväntar kund', id_requested: 'Inväntar ID-kontroll', approved: 'Godkänd av kund',
  change_requested: 'Ändring begärd', cancelled: 'Avbruten', expired: 'Utgången', attested: 'JEROC-attesterad',
};
export const activeApprovalStatuses: ApprovalStatus[] = ['waiting', 'id_requested', 'change_requested', 'expired'];

// Both HTTP and SSE use these same scoped DTOs. Parse before applying an event;
// malformed data must not replace a customer's current review.
const approvalStatusSchema = z.enum(['waiting', 'id_requested', 'approved', 'change_requested', 'cancelled', 'expired', 'attested']);
const finiteMoney = z.number().finite();
const terminalSchema = z.object({
  id: z.string().min(1), name: z.string(), username: z.string(), siteId: z.string().min(1),
  active: z.boolean(), online: z.boolean(), busy: z.boolean(),
  activeApprovalId: z.string().optional(), lastSeen: z.string().optional(),
});
const settlementRowSchema = z.object({
  articleId: z.string().min(1), name: z.string(), weight: z.number().finite().nonnegative(),
  price: finiteMoney, amount: finiteMoney,
});
export const publicApprovalSchema = z.object({
  id: z.string().min(1), version: z.number().int().positive(), status: approvalStatusSchema,
  updatedAt: z.string(), displayedAt: z.string().optional(), revision: z.number().int().nonnegative().optional(),
  snapshot: z.object({
    cardId: z.number().int(), version: z.number().int().positive(), customerName: z.string(), customerNumber: z.string().optional(),
    siteName: z.string(), rows: z.array(settlementRowSchema), gross: finiteMoney, offset: finiteMoney, net: finiteMoney,
    paymentMethod: z.enum(['bank', 'swish', 'cash', 'balance']), reference: z.string(), origin: z.string().optional(),
    deliveredAt: z.string(), termsVersion: z.string(), hash: z.string().min(1),
  }),
});
export const terminalApprovalSchema = z.object({
  id: z.string().min(1), cardId: z.number().int(), siteId: z.string().min(1), terminalId: z.string().min(1),
  version: z.number().int().positive(), status: approvalStatusSchema, createdAt: z.string(), updatedAt: z.string(), sentBy: z.string(),
  actualUserId: z.string(), effectiveUserId: z.string(), displayedAt: z.string().optional(), revision: z.number().int().nonnegative().optional(),
  approvedBy: z.string().optional(), approvedAt: z.string().optional(), attestedBy: z.string().optional(), attestedAt: z.string().optional(),
  comment: z.string().optional(),
  snapshot: z.object({
    card: officeSchema.shape.cards.element, customer: officeSchema.shape.customers.removeDefault().element,
    rows: z.array(settlementRowSchema),
    gross: finiteMoney, offset: finiteMoney, net: finiteMoney,
    paymentMethod: z.enum(['bank', 'swish', 'cash', 'balance']), reference: z.string(), origin: z.string(),
    deliveredAt: z.string(), termsVersion: z.string(), hash: z.string().min(1),
  }).passthrough(),
}).passthrough();
export function parseTerminalApproval(value: unknown): TerminalApproval {
  return terminalApprovalSchema.parse(value) as TerminalApproval;
}
export function parseTerminalDemoState(value: unknown): TerminalDemoState {
  return z.object({
    configured: z.boolean(), revision: z.number().int().nonnegative(),
    actualUserId: z.string().optional(), effectiveUserId: z.string().optional(),
    sites: z.array(z.object({ id: z.string(), name: z.string(), active: z.boolean().optional() })),
    terminals: z.array(terminalSchema), approvals: z.array(terminalApprovalSchema),
    defaults: z.array(z.object({ userId: z.string(), siteId: z.string(), terminalId: z.string() })),
  }).parse(value) as TerminalDemoState;
}
export function parseTerminalSession(value: unknown): TerminalSessionState {
  return z.object({
    terminal: terminalSchema, approval: publicApprovalSchema.nullable(), siteName: z.string().optional(),
    revision: z.number().int().nonnegative().optional(), connectionId: z.string().min(1).optional(),
  }).parse(value);
}
