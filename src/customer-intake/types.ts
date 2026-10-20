import { z } from 'zod';
import { paymentDetailsSchema, type PaymentDetails } from '../payment-details';

export type CustomerIntakeInput = {
  type: 'Företag' | 'Privatperson' | 'BRF';
  name: string;
  number: string;
  phone: string;
  email: string;
  address: string;
  postalCode: string;
  city: string;
  countryCode: string;
  paymentProfile?: PaymentDetails;
};

export const customerIntakeStatusSchema = z.enum(['waiting', 'submitted', 'applied', 'cancelled', 'expired', 'failed', 'unknown']);
export type CustomerIntakeStatus = z.infer<typeof customerIntakeStatusSchema>;
export const customerIntakeInputSchema = z.object({
  type: z.enum(['Företag', 'Privatperson', 'BRF']), name: z.string().max(300), number: z.string().max(30),
  phone: z.string().max(80), email: z.string().max(200), address: z.string().max(300),
  postalCode: z.string().max(20), city: z.string().max(200), countryCode: z.string().max(2),
  paymentProfile: paymentDetailsSchema.omit({ phone: true, recipient: true }).extend({ method: z.literal('bank') }).strict().optional(),
}).strict();
export const customerIntakeSchema = z.object({
  id: z.string().min(1).max(200), draftId: z.string().min(1).max(200), channel: z.enum(['terminal', 'sms']),
  status: customerIntakeStatusSchema, terminalName: z.string().max(300).optional(), recipientMasked: z.string().max(100).optional(),
  expiresAt: z.string().datetime({ offset: true }), proposal: customerIntakeInputSchema.omit({ paymentProfile: true }).optional(),
  hasPaymentProfile: z.boolean().optional(), bankWillBeSaved: z.boolean().optional(), existingCustomerName: z.string().max(300).optional(),
}).strict();
export type CustomerIntake = z.infer<typeof customerIntakeSchema>;
export type IntakeDTO = CustomerIntake;
export const publicCustomerIntakeStateSchema = z.object({
  intake: z.object({ id: z.string().min(1).max(200), status: customerIntakeStatusSchema, expiresAt: z.string().datetime({ offset: true }) }).strict(),
  company: z.object({ name: z.string().min(1).max(300), logoUrl: z.string().max(1000).optional() }).strict(),
}).strict();
export type PublicCustomerIntakeState = z.infer<typeof publicCustomerIntakeStateSchema>;
