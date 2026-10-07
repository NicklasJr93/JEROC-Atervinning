import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Check, ChevronRight, Clock3, Plus, Save, Truck } from 'lucide-react';
import {
  Button,
  CustomerLink,
  Empty,
  Header,
  Notice,
  Photo,
  ReferenceLink,
  Search,
  Total,
} from '../components';
import { articleById } from '../data';
import {
  dateTime,
  kilos,
  parseWeight,
  vehicleError,
  type Draft,
  type VehicleRow,
} from '../model';
import { useDemo } from '../store';
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
  function update(field: keyof typeof input, value: string) {
    const next = { ...input, [field]: value };
    setInput(next);
    setError('');
    saveDraft({ ...draft!, vehicleInput: next });
  }
  function commit(e: FormEvent) {
    e.preventDefault();
    if (!row) {
      setError('Välj materialet som vägs på fordonsvågen.');
      return;
    }
    const registration = input.registration.trim().toUpperCase();
    if (!/^[A-ZÅÄÖ0-9 -]{2,12}$/.test(registration)) {
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
              r.registration.replace(/\s/g, '') ===
                registration.replace(/\s/g, ''),
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
      navigate(
        exit ? `/weigh/${draft!.id}/summary` : `/pending?just=${draft!.id}`,
      );
  }
  const add = () => navigate(`/weigh/${draft.id}/materials?back=vehicle`);
  return (
    <>
      <Header
        title={`Fordonsvåg · ${exit ? 'Utfart' : 'Infart'}`}
        back={exit ? '/pending' : '/'}
      />
      <main className="page-body vehicle-page">
        <p className="eyebrow">INVÄGNING #{draft.number}</p>
        <form onSubmit={commit} className="stack">
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
          <div>
            <label className="field-title">Material på fordonet</label>
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
              <Button variant="outline" icon={Plus} onClick={add}>
                Lägg till material
              </Button>
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
              <p className="field-help">
                Andra material tas av före första fordonsvägningen och vägs
                separat.
              </p>
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
              Lägg till material
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
          <CustomerLink draftId={draft.id} customerId={draft.customerId} />
          <ReferenceLink
            draftId={draft.id}
            customerId={draft.customerId}
            reference={draft.reference}
            origin={draft.origin}
          />
          {error && <Notice tone="red">{error}</Notice>}
          <Button
            type="submit"
            icon={exit ? Check : Save}
            disabled={Boolean(exit && draft.pendingWeight)}
          >
            {exit ? 'Färdigvägd' : 'Spara infart'}
          </Button>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              if (saveDraft({ ...draft, vehicleInput: input }))
                navigate(exit ? '/pending' : '/drafts');
            }}
          >
            <Save size={16} /> Spara och pausa
          </button>
        </form>
      </main>
    </>
  );
}
export function PendingPage() {
  const { data } = useDemo();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [params] = useSearchParams();
  const pending = data.drafts
    .filter((d) => d.status === 'awaiting-exit')
    .filter((d) =>
      d.rows.some(
        (r) =>
          r.method === 'vehicle' &&
          r.registration.toLowerCase().includes(search.toLowerCase()),
      ),
    );
  return (
    <>
      <Header title="Pågående fordon" />
      <main className="page-body">
        <p className="intro">Gårdsplan · Lokalt i demon</p>
        {params.get('just') && (
          <Notice tone="green">
            Infartsvikten är sparad. Öppna fordonet när det är dags att
            registrera utfart.
          </Notice>
        )}
        <Search
          value={search}
          setValue={setSearch}
          placeholder="Sök registreringsnummer"
        />
        <div className="stack">
          {pending.map((d) => (
            <PendingCard draft={d} key={d.id} />
          ))}
        </div>
        {!pending.length && (
          <Empty
            title="Inga fordon hittades"
            text={
              search
                ? 'Prova ett annat registreringsnummer.'
                : 'Här visas fordon som har en sparad infartsvikt.'
            }
            action={
              <Button icon={Plus} onClick={() => navigate('/new')}>
                Starta invägning
              </Button>
            }
          />
        )}
      </main>
    </>
  );
}
function PendingCard({ draft }: { draft: Draft }) {
  const { data } = useDemo();
  const navigate = useNavigate();
  const row = draft.rows.find((r): r is VehicleRow => r.method === 'vehicle');
  if (!row) return null;
  const article = articleById(row.articleId);
  return (
    <article className="pending-card">
      <div className="heading-row">
        <div className="pending-card-title">
          <Photo index={article.photos[0]} label={article.name} />
          <div>
            <h2>{row.registration}</h2>
            <p>{article.name}</p>
          </div>
        </div>
        <span className="badge amber">Väntar på utfart</span>
      </div>
      <dl>
        <div>
          <dt>Infart</dt>
          <dd>{kilos(row.gross ?? 0)} kg</dd>
        </div>
        <div>
          <dt>Registrerad</dt>
          <dd>{row.entryAt && dateTime(row.entryAt)}</dd>
        </div>
        <div>
          <dt>Kund</dt>
          <dd>
            {data.customers.find((c) => c.id === draft.customerId)?.name ??
              'Ej vald'}
          </dd>
        </div>
        <div>
          <dt>Invägd av</dt>
          <dd>Niklas · Gårdsplan</dd>
        </div>
      </dl>
      <Button
        variant="blue"
        onClick={() => navigate(`/weigh/${draft.id}/vehicle`)}
      >
        Registrera utfart <ChevronRight size={18} />
      </Button>
    </article>
  );
}
