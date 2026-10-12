import { z } from 'zod';
import { storeSchema } from '../dist-server/domain-models.mjs';

const recordChange = schema => z.object({
  id: z.string().min(1).max(200), base: schema.optional(), next: schema.optional(),
}).strict().superRefine((change, context) => {
  if (!change.base && !change.next || change.base && change.base.id !== change.id || change.next && change.next.id !== change.id)
    context.addIssue({ code: 'custom', message: 'Postens identitet stämmer inte med ändringen.' });
});
const changes = schema => z.array(recordChange(schema)).max(500).superRefine((records, context) => {
  if (new Set(records.map(record => record.id)).size !== records.length)
    context.addIssue({ code: 'custom', message: 'Samma post får bara ändras en gång i ett kommando.' });
});
const commandSchema = z.object({
  kind: z.literal('records'), version: z.literal(1),
  drafts: changes(storeSchema.shape.drafts.element), customers: changes(storeSchema.shape.customers.element),
}).strict();

// Omitted records are unchanged on both sides. The established field-level
// merge, authorization, site checks and server number allocation still apply.
export function mobileRecordPayload(input) {
  const command = commandSchema.parse(input);
  return {
    base: { version: 1, drafts: command.drafts.flatMap(change => change.base ? [change.base] : []), customers: command.customers.flatMap(change => change.base ? [change.base] : []) },
    next: { version: 1, drafts: command.drafts.flatMap(change => change.next ? [change.next] : []), customers: command.customers.flatMap(change => change.next ? [change.next] : []) },
  };
}
