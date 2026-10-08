import { useState } from 'react';
import { safeAuditText } from './workflow';
import { articleById } from '../data';
import { kilos, money } from '../model';
import { can, type OfficeData, type OfficeUser } from './model';

export default function CorrectionsWorkspace({
  data,
  user,
  onOpenCard,
  onSubmit,
  onApprove,
  onSaveDocument,
  busy,
}: {
  data: OfficeData;
  user: OfficeUser;
  onOpenCard: (id: number) => void;
  onSubmit: (id: number) => Promise<boolean>;
  onApprove: (id: number) => Promise<boolean>;
  onSaveDocument: (id: number, document: string) => boolean;
  busy: boolean;
}) {
  const [tab, setTab] = useState('active');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<number>();
  const rows = data.corrections.filter(
    (c) =>
      (tab === 'history' ? c.status === 'approved' : c.status !== 'approved') &&
      `${c.id} ${c.cardId} ${data.customers.find((x) => x.id === c.customerId)?.name} ${c.reason} ${c.document ?? ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="office-title">
        <div>
          <span className="office-eyebrow">SPÅRBARHET OCH KUNDSALDO</span>
          <h1>Rättelseutkast</h1>
          <p>
            Rättelsekort granskas och attesteras innan de påverkar volym,
            statistik och saldo. Originalkortet ligger kvar.
          </p>
        </div>
      </div>
      <div className="office-queue-controls">
        <div
          className="office-filters"
          role="tablist"
          aria-label="Rättelsekort"
        >
          {[
            ['active', 'Aktiva'],
            ['history', 'Historik'],
          ].map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              className={tab === value ? 'active' : ''}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          aria-label="Sök rättelser"
          placeholder="Sök rättelse, originalkort, kund eller underlag…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <section className="office-panel">
        <div className="office-table-wrap">
          <table className="office-table">
            <thead>
              <tr>
                <th>Rättelse</th>
                <th>Kund / original</th>
                <th>Material / ändring</th>
                <th>Orsak och underlag</th>
                <th>Spårbarhet</th>
                <th>Åtgärd</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>R-{c.id}</strong>
                    <small>
                      {c.status === 'approved'
                        ? 'Godkänd'
                        : c.status === 'attest'
                          ? 'Väntar på attest'
                          : 'Utkast'}
                    </small>
                  </td>
                  <td>
                    <strong>
                      {data.customers.find((x) => x.id === c.customerId)?.name}
                    </strong>
                    <button
                      className="office-link"
                      onClick={() => onOpenCard(c.cardId)}
                    >
                      Vägning #{c.cardId}
                    </button>
                    {c.resultCardId && (
                      <button
                        className="office-link"
                        onClick={() => onOpenCard(c.resultCardId!)}
                      >
                        Utbetalningskort #{c.resultCardId}
                      </button>
                    )}
                  </td>
                  <td>
                    {articleById(c.articleId).name}
                    <small>
                      {c.weightDelta > 0 ? '+' : ''}
                      {kilos(c.weightDelta)} kg
                    </small>
                    {(can(user, 'attest') || can(user, 'reports')) && (
                      <strong>{money(c.amountDelta ?? 0)} kr</strong>
                    )}
                  </td>
                  <td>
                    {c.reason}
                    <small>{c.document || 'Underlag saknas'}</small>
                  </td>
                  <td>
                    {c.actor}
                    <small>
                      {c.office ?? 'Kontor Norrtälje'} ·{' '}
                      {new Date(c.at).toLocaleString('sv-SE')}
                    </small>
                    {c.approvedBy && (
                      <small>
                        Godkänd av{' '}
                        {data.users.find((u) => u.id === c.approvedBy)?.name ??
                          c.approvedBy}
                      </small>
                    )}
                  </td>
                  <td>
                    <button
                      className="office-link"
                      onClick={() =>
                        setExpanded(expanded === c.id ? undefined : c.id)
                      }
                    >
                      Granska utkast
                    </button>
                    {(!c.status || c.status === 'draft') &&
                      can(user, 'corrections') && (
                        <button
                          className="office-btn outline"
                          disabled={busy}
                          onClick={() => onSubmit(c.id)}
                        >
                          Skicka rättelse för attest
                        </button>
                      )}
                    {c.status === 'attest' && can(user, 'attest') && (
                      <button
                        className="office-btn"
                        disabled={
                          busy ||
                          Math.abs(c.amountDelta ?? 0) > user.maxAttest ||
                          (!user.ownAttest &&
                            [c.submittedBy, c.effectiveUserId].includes(
                              user.id,
                            ))
                        }
                        onClick={() => onApprove(c.id)}
                      >
                        Godkänn rättelse
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <p>
            Inga rättelser matchar listan. Skapa ett rättelseutkast från ett
            låst viktkort eller kundkortet.
          </p>
        )}
      </section>
      {expanded !== undefined &&
        data.corrections.find((c) => c.id === expanded) && (
          <section className="office-panel">
            <h2>Spårbarhet · R-{expanded}</h2>
            {can(user, 'corrections') &&
              (data.corrections.find((c) => c.id === expanded)!.status ??
                'draft') === 'draft' && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const input = e.currentTarget.elements.namedItem(
                      'document',
                    ) as HTMLInputElement;
                    onSaveDocument(expanded, input.value.trim());
                  }}
                >
                  <label>
                    Rättelseunderlag
                    <input
                      key={`${expanded}-${data.corrections.find((c) => c.id === expanded)!.document}`}
                      name="document"
                      required
                      maxLength={1000}
                      defaultValue={
                        data.corrections.find((c) => c.id === expanded)!
                          .document ?? ''
                      }
                      placeholder="Exempel RU-003 eller hänvisning till underlag"
                    />
                  </label>
                  <button className="office-btn outline" disabled={busy}>
                    Spara rättelseunderlag
                  </button>
                </form>
              )}
            <ol className="office-audit">
              {(
                data.corrections.find((c) => c.id === expanded)!.audit ?? []
              ).map((a, i) => (
                <li key={i}>
                  <i />
                  <div>
                    <strong>{safeAuditText(user, a.text)}</strong>
                    <small>
                      {a.actor} · {new Date(a.at).toLocaleString('sv-SE')}
                    </small>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}
    </>
  );
}
