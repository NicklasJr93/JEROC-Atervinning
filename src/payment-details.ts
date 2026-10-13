import { z } from 'zod';

export const bankRecipientLabels = { account: 'Svenskt bankkonto', bankgiro: 'Bankgiro', plusgiro: 'Plusgiro', iban: 'IBAN' } as const;

// This is a storage/input shape, not a migration. In particular, older frozen
// bank instructions must keep their original bytes instead of receiving defaults.
export const paymentDetailsSchema = z.object({
  method: z.enum(['bank', 'swish', 'cash', 'balance']),
  bankType: z.enum(['account', 'bankgiro', 'plusgiro', 'iban']).optional(),
  bank: z.string().max(100).optional(),
  clearing: z.string().max(20).optional(),
  account: z.string().max(100).optional(),
  holder: z.string().max(200).optional(),
  bankgiro: z.string().max(30).optional(),
  plusgiro: z.string().max(30).optional(),
  iban: z.string().max(50).optional(),
  bic: z.string().max(20).optional(),
  bankCountry: z.string().max(10).optional(),
  beneficiaryAddress: z.string().max(500).optional(),
  ocr: z.string().max(100).optional(),
  phone: z.string().max(40).optional(),
  recipient: z.string().max(200).optional(),
});
export type PaymentDetails = z.infer<typeof paymentDetailsSchema>;
