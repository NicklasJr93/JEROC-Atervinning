import type { OfficeUser } from './model';
import { mayReadMail, useMailState } from './mail-client';
import './mail.css';

export default function MailNavUnreadBadge({ user, actualUser }: { user: OfficeUser; actualUser: OfficeUser }) {
  const { state } = useMailState(user, actualUser);
  const count = state?.totalUnread ?? 0;
  const partial = state?.mailboxes.some(mailbox => mailbox.enabled && mailbox.countsPartial);
  if (!mayReadMail(user, actualUser) || count <= 0) return null;
  return <span className="office-nav-count mail-nav-unread" aria-label={`${partial ? 'Minst ' : ''}${count} olästa mejl`}>{count > 99 ? '99+' : `${count}${partial ? '+' : ''}`}</span>;
}
