import { z } from 'zod';
import { normalizePhoneNumber, phoneNumberError } from '../dist-server/domain-models.mjs';

export function customerApprovalChannel(input) {
  const channel = input?.channel ?? 'terminal';
  if (!['terminal', 'email', 'sms'].includes(channel)) throw new TypeError('Välj terminal, e-post eller SMS.');
  if (channel === 'terminal') {
    if (typeof input?.terminalId !== 'string' || !input.terminalId.trim() || input.terminalId.length > 100 || input.recipient !== undefined)
      throw new TypeError('Välj en kundterminal.');
    // Keep the original terminal command fingerprint stable across clients
    // that add the now-explicit channel selector on a retried request.
    return { terminalId: input.terminalId };
  }
  if (input.terminalId !== undefined) throw new TypeError('E-post och SMS använder ingen kundterminal.');
  if (typeof input.recipient !== 'string' || /[\u0000-\u001f\u007f]/.test(input.recipient)) throw new TypeError('Ange en giltig mottagare.');
  const recipient = channel === 'email' ? input.recipient.normalize('NFKC').trim().toLowerCase() : normalizePhoneNumber(input.recipient);
  if (channel === 'email' ? !z.string().email().max(200).safeParse(recipient).success : phoneNumberError(recipient, { required: true }))
    throw new TypeError(channel === 'email' ? 'Ange en giltig e-postadress.' : 'Ange ett giltigt mobilnummer för SMS.');
  return { channel, recipient };
}
