import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Check,
  ChevronRight,
  Clock3,
  Plus,
  Save,
  Truck,
  X,
} from 'lucide-react';
import { Button, Header, Notice, Photo, Total } from '../components';
import { articleById } from '../data';
import {
  dateTime,
  kilos,
  normalizeRegistration,
  parseWeight,
  vehicleError,
  type VehicleRow,
} from '../model';
import { MissingDraft, useDraft } from './shared';

export function VehiclePage() {
  const { draft, data, saveDraft } = useDraft();
  const navigate = useNavigate();
  const row = draft?.rows.find((r): r is VehicleRow => r.method === 'vehicle');
  const [input, setInput] = useState(
    draft?.vehicleInput ?? {
      registration: row?.registration ?? '',
      gross: row?.gross != null ? String(row.gross) : '',
      tare: row?.tare != null ? String(row.tare) : '',
      deduction: String(row?.deduction ?? 0),
      reason: row?.deductionReason ?? '',
    },
  );
  const [error, setError] = useState('');
  const [deductionOpen, setDeductionOpen] = useState(Boolean(row?.deduction));
  if (!draft) return <MissingDraft />;
  const exit = Boolean(row?.entryAt);
  const article = row ? articleById(row.articleId) : undefined;
  const gross = exit ? (row?.gross ?? null) : parseWeight(input.gross);
  const tare = parseWeight(input.tare);
  const deduction = parseWeight(input.deduction || '0');
  const net =
    gross != null && tare != null && gross > tare
      ? Math.round((gross - tare) * 1000) / 1000
      : 0;
  const materialWeight = Math.max(
    0,
    Math.round((net - (deduction ?? 0)) * 1000) / 1000,
  );
  const customer = data.customers.find((c) => c.id === draft.customerId);
  function update(field: keyof typeof input, value: string) {
    const next = { ...input, [field]: value };
    setInput(next);
    setError('');
    let customerId = draft!.customerId;
    if (field === 'registration' && !exit) {
      const previous = data.customers.find((c) =>
        c.registrations?.some(
          (r) =>
            normalizeRegistration(r) ===
            normalizeRegistration(input.registration),
        ),
      );
      const match = data.customers.find((c) =>
        c.registrations?.some(
          (r) => normalizeRegistration(r) === normalizeRegistration(value),
        ),
      );
      if (!customerId || previous?.id === customerId) customerId = match?.id;
    }
    saveDraft({
      ...draft!,
      vehicleInput: next,
      customerId,
      reference: customerId === draft!.customerId ? draft!.reference : '',
      origin: customerId === draft!.customerId ? draft!.origin : '',
    });
  }
  function commit(e: FormEvent) {
    e.preventDefault();
    if (!row) {
      setError('Välj materialet som vägs på fordonsvågen.');
      return;
    }
    const registration = input.registration.trim().toUpperCase();
    if (!/^[A-ZÅÄÖ0-9]{2,12}$/.test(normalizeRegistration(registration))) {
      setError('Ange fordonets registreringsnummer.');
      return;
    }
    if (
      !exit &&
      data.drafts.some(
        (d) =>
          d.id !== draft!.id &&
          d.status === 'awaiting-exit' &&
          d.rows.some(
            (r) =>
              r.method === 'vehicle' &&
              normalizeRegistration(r.registration) ===
                normalizeRegistration(registration),
          ),
      )
    ) {
      setError(
        'Det här fordonet väntar redan på utfart. Öppna den pågående vägningen i stället.',
      );
      return;
    }
    if (exit) {
      const invalid = vehicleError(gross, tare, deduction, input.reason);
      if (invalid) {
        setError(invalid);
        return;
      }
    } else if (gross == null || gross <= 0) {
      setError('Ange en infartsvikt större än 0 kg.');
      return;
    }
    const now = new Date().toISOString();
    const savedRow: VehicleRow = exit
      ? {
          ...row,
          registration,
          gross: gross!,
          tare: tare!,
          deduction: deduction!,
          deductionReason: input.reason.trim(),
          exitAt: now,
        }
      : {
          ...row,
          registration,
          gross: gross!,
          deduction: 0,
          deductionReason: '',
          entryAt: now,
        };
    if (
      saveDraft({
        ...draft!,
        status: exit ? 'draft' : 'awaiting-exit',
        vehicleInput: undefined,
        rows: draft!.rows.map((r) => (r.id === row.id ? savedRow : r)),
      })
    )
      navigate(exit ? `/weigh/${draft!.id}/summary` : '/', {
        state: exit ? undefined : { entrySaved: registration },
      });
  }
  const add = () => navigate(`/weigh/${draft.id}/materials?back=vehicle`);
  return (
    <>
      <Header title={`Fordonsvåg · ${exit ? 'Utfart' : 'Infart'}`} back="/">
        <button
          className="icon-button red-text"
          aria-label="Stäng fordonskort"
          onClick={() => navigate('/')}
        >
          <X />
        </button>
      </Header>
      <main className="page-body vehicle-page">
        <p className="eyebrow">INVÄGNING #{draft.number}</p>
        <form onSubmit={commit} className="stack">
          {!exit && (
            <>
              {' '}
              <label>
                Registreringsnummer
                <div className="registration-input">
                  <input
                    value={input.registration}
                    maxLength={12}
                    placeholder="ABC123"
                    onChange={(e) =>
                      update('registration', e.target.value.toUpperCase())
                    }
                    readOnly={exit}
                    autoCapitalize="characters"
                  />
                  <Truck size={24} />
                </div>
              </label>
            </>
          )}
          {(exit || customer) && (
            <section className="vehicle-customer">
              <div className="heading-row">
                <div>
                  <h2>
                    {customer?.name ?? (input.registration || 'Kund ej vald')}
                  </h2>
                  <small>
                    {input.registration}
                    {customer ? ' · Vald kund' : ' · Ingen kundkoppling hittad'}
                  </small>
                </div>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => navigate(`/weigh/${draft.id}/customer`)}
                >
                  {customer ? 'Byt kund' : 'Välj kund'}
                </button>
              </div>
              {exit && customer && (
                <div className="stack tight">
                  <label>
                    Referens (valfritt)
                    <input
                      list="vehicle-references"
                      value={draft.reference}
                      placeholder="Projekt eller märkning"
                      onChange={(e) =>
                        saveDraft({ ...draft, reference: e.target.value })
                      }
                    />
                  </label>
                  <datalist id="vehicle-references">
                    {customer.references.map((r) => (
                      <option key={r} value={r} />
                    ))}
                  </datalist>
                  <label>
                    Materialets ursprungsadress (valfritt)
                    <input
                      list="vehicle-origins"
                      value={draft.origin}
                      placeholder="Gatuadress, postnummer och ort"
                      onChange={(e) =>
                        saveDraft({ ...draft, origin: e.target.value })
                      }
                    />
                  </label>
                  <datalist id="vehicle-origins">
                    {customer.origins.map((o) => (
                      <option key={o} value={o} />
                    ))}
                  </datalist>
                </div>
              )}
            </section>
          )}
          <div>
            <label className="field-title">Material på fordonsvågen</label>
            <button
              className="material-choice"
              type="button"
              onClick={() =>
                navigate(
                  `/weigh/${draft.id}/materials?target=vehicle&back=vehicle`,
                )
              }
            >
              {article ? (
                <>
                  <Photo index={article.photos[0]} label={article.name} />
                  <span>
                    <strong>{article.name}</strong>
                    <small>{article.description}</small>
                  </span>
                </>
              ) : (
                <>
                  <span className="quick-icon blue">
                    <Truck size={25} />
                  </span>
                  <span>
                    <strong>Välj material</strong>
                    <small>Artikeln som vägs på fordonsvågen</small>
                  </span>
                </>
              )}
              <ChevronRight />
            </button>
          </div>
          {!exit && (
            <>
              <Notice>
                Ta bort material som ska vägas separat från lasten innan bilen
                vägs.
              </Notice>
              <label>
                Vikt vid infart
                <div className="kg-input">
                  <input
                    inputMode="decimal"
                    placeholder="0"
                    value={input.gross}
                    onChange={(e) => update('gross', e.target.value)}
                  />
                  <span>kg</span>
                </div>
              </label>
              <section className="separate-section">
                <h2>Material som vägs separat</h2>
                <Button variant="outline" icon={Plus} onClick={add}>
                  Lägg till separat material
                </Button>
                <p className="field-help">
                  Registrera material som tagits bort före infarten.
                </p>
              </section>
            </>
          )}
          {exit && (
            <>
              <div className="entry-evidence">
                <Clock3 size={18} />
                <span>
                  Infart: <strong>{kilos(gross ?? 0)} kg</strong>
                  <small>{row?.entryAt && dateTime(row.entryAt)}</small>
                </span>
              </div>
              <label>
                Vikt vid utfart
                <div className="kg-input">
                  <input
                    inputMode="decimal"
                    placeholder="0"
                    value={input.tare}
                    onChange={(e) => update('tare', e.target.value)}
                  />
                  <span>kg</span>
                </div>
              </label>
              <Total weight={net} label="Nettovikt" />
              <div className="deduction-panel">
                <button
                  className="deduction-toggle"
                  type="button"
                  onClick={() => setDeductionOpen(!deductionOpen)}
                >
                  <strong>Viktavdrag</strong>
                  <span>
                    {kilos(deduction ?? 0)} kg{' '}
                    <ChevronRight
                      size={17}
                      className={deductionOpen ? 'rotate' : ''}
                    />
                  </span>
                </button>
                {deductionOpen && (
                  <div className="stack tight">
                    <label>
                      Viktavdrag i kg
                      <div className="kg-input small-input">
                        <input
                          inputMode="decimal"
                          value={input.deduction}
                          onChange={(e) => update('deduction', e.target.value)}
                        />
                        <span>kg</span>
                      </div>
                    </label>
                    <label>
                      Orsak
                      <input
                        value={input.reason}
                        placeholder="Till exempel betongrester"
                        onChange={(e) => update('reason', e.target.value)}
                      />
                    </label>
                  </div>
                )}
              </div>
              <Total weight={materialWeight} label="Materialvikt" />
            </>
          )}
          {draft.rows.some((r) => r.method === 'direct') && (
            <div className="extra-materials">
              <span className="section-caption">
                SEPARAT VÄGT PÅ SAMMA KORT
              </span>
              {draft.rows
                .filter((r) => r.method === 'direct')
                .map((r) => (
                  <button
                    type="button"
                    className="material-choice"
                    key={r.id}
                    onClick={() =>
                      navigate(
                        `/weigh/${draft.id}/weight/${r.articleId}?row=${r.id}&back=vehicle`,
                      )
                    }
                  >
                    <Photo
                      index={articleById(r.articleId).photos[0]}
                      label={articleById(r.articleId).name}
                    />
                    <span>
                      <strong>{articleById(r.articleId).name}</strong>
                      <small>
                        {r.method === 'direct' && kilos(r.weight)} kg · Separat
                        våg
                      </small>
                    </span>
                    <ChevronRight />
                  </button>
                ))}
            </div>
          )}
          {exit && (
            <Button variant="outline" icon={Plus} onClick={add}>
              Lägg till separat material
            </Button>
          )}
          {draft.pendingWeight && (
            <Notice tone="amber">
              En separat vikt behöver färdigställas.
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  navigate(
                    `/weigh/${draft.id}/weight/${draft.pendingWeight!.articleId}?back=vehicle${draft.pendingWeight!.rowId ? `&row=${draft.pendingWeight!.rowId}` : ''}`,
                  )
                }
              >
                Fortsätt ange vikt
              </button>
            </Notice>
          )}
          {error && <Notice tone="red">{error}</Notice>}
          <Button
            type="submit"
            icon={exit ? Check : Save}
            disabled={Boolean(exit && draft.pendingWeight)}
          >
            {exit ? 'Färdigvägt' : 'Spara infart'}
          </Button>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              if (saveDraft({ ...draft, vehicleInput: input }))
                navigate('/drafts');
            }}
          >
            <Save size={16} /> Spara och pausa
          </button>
        </form>
      </main>
    </>
  );
}
