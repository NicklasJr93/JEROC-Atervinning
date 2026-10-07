import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Check,
  ChevronRight,
  CircleCheck,
  CircleX,
  Maximize2,
  X,
  LockKeyhole,
  Pencil,
  Plus,
  Save,
  Scale,
  Trash2,
  Truck,
} from 'lucide-react';
import {
  Button,
  CustomerLink,
  Empty,
  Header,
  Modal,
  Nav,
  Notice,
  Photo,
  ReferenceLink,
  Search,
  Total,
} from '../components';
import { articleById, articles, categories } from '../data';
import {
  createDraft,
  dateTime,
  id,
  isComplete,
  kilos,
  parseWeight,
  rowWeight,
  totalWeight,
  type MaterialRow,
} from '../model';
import { useDemo } from '../store';
import { MissingDraft, useDraft } from './shared';

export function ModePage() {
  const { data, saveDraft } = useDemo();
  const navigate = useNavigate();
  const starting = useRef(false);
  function start(mode: 'direct' | 'vehicle') {
    if (starting.current) return;
    starting.current = true;
    const draft = createDraft(data, mode);
    if (saveDraft(draft))
      navigate(
        `/weigh/${draft.id}/${mode === 'vehicle' ? 'vehicle' : 'materials'}`,
      );
    else starting.current = false;
  }
  return (
    <>
      <Header title="Vägningssätt" />
      <main className="page-body">
        <h2>Hur vill du väga?</h2>
        <p className="muted">Tryck på ett alternativ för att fortsätta.</p>
        <div className="direct-mode-options">
          <button className="direct-mode-card" onClick={() => start('direct')}>
            <Scale size={38} />
            <span>
              <strong>Materialvåg</strong>
              <small>Väg materialet direkt och ange vikten.</small>
            </span>
            <ChevronRight />
          </button>
          <button className="direct-mode-card" onClick={() => start('vehicle')}>
            <Truck size={38} />
            <span>
              <strong>Fordonsvåg</strong>
              <small>Väg bilen före och efter avlastning.</small>
            </span>
            <ChevronRight />
          </button>
        </div>
        <Notice>
          <strong>Ska något vägas separat?</strong>
          <p>
            Ta bort material som ska vägas separat från lasten innan bilen vägs.
          </p>
        </Notice>
      </main>
    </>
  );
}
export function MaterialsPage() {
  const { draft, saveDraft } = useDraft();
  const { categoryId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  if (!draft) return <MissingDraft />;
  const query = params.toString();
  const category = categories.find((c) => c.id === categoryId);
  const target = params.get('target');
  const back = category
    ? `/weigh/${draft.id}/materials?${query}`
    : `/weigh/${draft.id}/${params.get('back') === 'vehicle' || target === 'vehicle' ? 'vehicle' : 'summary'}`;
  const listed = articles.filter(
    (a) =>
      (!categoryId || a.category === categoryId) &&
      `${a.name} ${a.description}`.toLowerCase().includes(search.toLowerCase()),
  );
  function openArticle(articleId: string) {
    if (
      draft!.pendingWeight &&
      !draft!.pendingWeight.rowId &&
      target !== 'vehicle'
    )
      saveDraft({ ...draft!, pendingWeight: undefined });
    navigate(`/weigh/${draft!.id}/article/${articleId}?${query}`);
  }
  return (
    <>
      <Header title={category?.name ?? 'Välj material'} back={back} />
      <main className="page-body">
        <Search
          value={search}
          setValue={setSearch}
          placeholder="Sök material eller artikel"
        />
        {category && <p className="section-caption">VÄLJ ARTIKEL</p>}
        <div className="material-list">
          {!categoryId && !search
            ? categories.map((c) => (
                <button
                  className="material-choice"
                  key={c.id}
                  onClick={() =>
                    navigate(`/weigh/${draft.id}/materials/${c.id}?${query}`)
                  }
                >
                  <Photo index={c.photo} label={c.name} />
                  <span>
                    <strong>{c.name}</strong>
                    <small>{c.description}</small>
                  </span>
                  <ChevronRight />
                </button>
              ))
            : listed.map((a) => (
                <button
                  className="material-choice"
                  key={a.id}
                  onClick={() => openArticle(a.id)}
                >
                  <Photo index={a.photos[0]} label={a.name} />
                  <span>
                    <strong>{a.name}</strong>
                    <small>{a.description}</small>
                  </span>
                  <ChevronRight />
                </button>
              ))}
        </div>
        {(categoryId || search) && !listed.length && (
          <Empty title="Inget material hittades" text="Prova ett annat namn." />
        )}
        <Notice>
          Saknas en artikel? Be kontoret lägga till den. I demon finns ett urval
          av artiklar.
        </Notice>
      </main>
    </>
  );
}
export function ArticlePage() {
  const { draft, saveDraft } = useDraft();
  const { articleId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [photo, setPhoto] = useState(0);
  const [zoom, setZoom] = useState(false);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const article = articles.find((a) => a.id === articleId);
  if (!draft || !article) return <MissingDraft />;
  const query = params.toString();
  const target = params.get('target');
  const count = article.photos.length;
  function swipe(x: number, y: number) {
    const start = touch.current;
    touch.current = null;
    if (!start) return;
    const dx = x - start.x,
      dy = y - start.y;
    if (Math.abs(dx) > 35 && Math.abs(dx) > Math.abs(dy))
      setPhoto((p) => (p + (dx < 0 ? 1 : -1) + count) % count);
  }
  function select() {
    if (target === 'vehicle') {
      const current = draft!.rows.find((r) => r.method === 'vehicle');
      const vehicle: MaterialRow = current
        ? { ...current, articleId: article!.id }
        : {
            id: id(),
            articleId: article!.id,
            method: 'vehicle',
            registration: '',
            deduction: 0,
            deductionReason: '',
          };
      if (
        saveDraft({
          ...draft!,
          status: 'draft',
          rows: current
            ? draft!.rows.map((r) => (r.id === current.id ? vehicle : r))
            : [vehicle, ...draft!.rows],
        })
      )
        navigate(`/weigh/${draft!.id}/vehicle`);
    } else navigate(`/weigh/${draft!.id}/weight/${article!.id}?${query}`);
  }
  return (
    <div className="article-screen">
      <Header
        title={article.name}
        back={`/weigh/${draft.id}/materials/${article.category}?${query}`}
      />
      <main className="page-body article-info">
        <div
          className="gallery swipe-gallery"
          role="region"
          aria-label="Materialets exempelbilder"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault();
              setPhoto(
                (p) => (p + (e.key === 'ArrowRight' ? 1 : -1) + count) % count,
              );
            }
          }}
          onTouchStart={(e) => {
            touch.current = {
              x: e.touches[0].clientX,
              y: e.touches[0].clientY,
            };
          }}
          onTouchEnd={(e) =>
            swipe(e.changedTouches[0].clientX, e.changedTouches[0].clientY)
          }
          onTouchCancel={() => {
            touch.current = null;
          }}
        >
          <Photo
            index={article.photos[photo]}
            label={`${article.name}, exempel ${photo + 1}`}
            className="gallery-photo"
          />
          <button
            className="gallery-zoom"
            aria-label="Förstora referensbild"
            onClick={() => setZoom(true)}
          >
            <Maximize2 size={20} />
          </button>
          <div
            className="overlay-dots"
            aria-label={`Bild ${photo + 1} av ${count}`}
          >
            {article.photos.map((_, i) => (
              <span key={i} className={i === photo ? 'active' : ''} />
            ))}
          </div>
        </div>
        <p className="swipe-help">Svep för fler exempel</p>
        <div className="classification included">
          <CircleCheck size={21} />
          <div>
            <strong>Ingår</strong>
            <p>{article.includes}</p>
          </div>
        </div>
        <div className="classification excluded">
          <CircleX size={21} />
          <div>
            <strong>Ingår inte</strong>
            <p>{article.excludes}</p>
          </div>
        </div>
      </main>
      <footer className="sticky-action">
        <Button variant="blue" onClick={select}>
          Välj {article.name}
        </Button>
      </footer>
      {zoom && (
        <Modal
          title={`${article.name} · ${photo + 1} av ${count}`}
          onClose={() => setZoom(false)}
        >
          <div
            className="swipe-gallery"
            onTouchStart={(e) => {
              touch.current = {
                x: e.touches[0].clientX,
                y: e.touches[0].clientY,
              };
            }}
            onTouchEnd={(e) =>
              swipe(e.changedTouches[0].clientX, e.changedTouches[0].clientY)
            }
          >
            <Photo
              index={article.photos[photo]}
              label={article.name}
              className="zoom-photo"
            />
          </div>
          <p className="swipe-help">Svep för fler exempel</p>
        </Modal>
      )}
    </div>
  );
}
export function WeightPage() {
  const { draft, saveDraft } = useDraft();
  const { articleId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const edit = draft?.rows.find((r) => r.id === params.get('row'));
  const pending = draft?.pendingWeight;
  const [value, setValue] = useState(
    pending && pending.articleId === articleId && pending.rowId === edit?.id
      ? pending.value
      : edit?.method === 'direct'
        ? String(edit.weight).replace('.', ',')
        : '',
  );
  const valueRef = useRef(value);
  const latest = useRef({ draft, saveDraft });
  latest.current = { draft, saveDraft };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saving = useRef(false);
  const [error, setError] = useState('');
  const [cancel, setCancel] = useState(false);
  const article = articles.find((a) => a.id === articleId);
  const back = params.get('back') === 'vehicle' ? 'vehicle' : 'summary';
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!draft || !article) return <MissingDraft />;
  function update(next: string) {
    valueRef.current = next;
    setValue(next);
    setError('');
    clearTimeout(timer.current);
    // Do not serialize all demo data on every key press. This remains provisional input, not a material row.
    timer.current = setTimeout(() => {
      const current = latest.current;
      if (current.draft)
        current.saveDraft({
          ...current.draft,
          pendingWeight: {
            articleId: article!.id,
            value: valueRef.current,
            rowId: edit?.id,
            back,
          },
        });
    }, 200);
  }
  function key(k: string) {
    const current = valueRef.current;
    if (k === 'backspace') update(current.slice(0, -1));
    else if (k === ',') {
      if (!/[,.]/.test(current)) update((current || '0') + ',');
    } else if (current.length < 12) update(current === '0' ? k : current + k);
  }
  function clearPending(destination: string) {
    clearTimeout(timer.current);
    if (
      latest.current.saveDraft({
        ...latest.current.draft!,
        pendingWeight: undefined,
      })
    )
      navigate(destination);
  }
  function abort() {
    clearPending(
      `/weigh/${draft!.id}/${draft!.rows.length ? 'summary' : 'materials'}`,
    );
  }
  function save(next: boolean) {
    if (saving.current) return;
    const weight = parseWeight(valueRef.current);
    if (weight == null || weight <= 0) {
      setError('Ange en vikt större än 0 kg, med högst tre decimaler.');
      return;
    }
    clearTimeout(timer.current);
    saving.current = true;
    const current = latest.current.draft!;
    const row: MaterialRow = {
      id: edit?.id ?? id(),
      articleId: article!.id,
      method: 'direct',
      weight,
    };
    const updated = {
      ...current,
      pendingWeight: undefined,
      rows: edit
        ? current.rows.map((r) => (r.id === edit.id ? row : r))
        : [...current.rows, row],
    };
    if (saveDraft(updated))
      navigate(
        next
          ? `/weigh/${current.id}/materials?back=${back}`
          : `/weigh/${current.id}/${back}`,
      );
    else saving.current = false;
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    save(false);
  }
  return (
    <>
      <Header
        title="Ange vikt"
        onBack={() =>
          clearPending(
            `/weigh/${draft.id}/article/${article.id}?${params.toString()}`,
          )
        }
      >
        <button
          className="icon-button red-text"
          aria-label="Avbryt materialrad"
          onClick={() => (valueRef.current ? setCancel(true) : abort())}
        >
          <X />
        </button>
      </Header>
      <main className="page-body weight-page">
        <div className="selected-material">
          <Photo index={article.photos[0]} label={article.name} />
          <span>
            <strong>{article.name}</strong>
            <small>Materialvåg</small>
          </span>
        </div>
        <form onSubmit={submit} className="weight-form">
          <label className="weight-entry-label">
            <span className="visually-hidden">Vikt</span>
            <div className="big-weight">
              <input
                aria-label="Vikt i kg"
                inputMode="none"
                value={value}
                placeholder="0"
                style={{
                  fontSize:
                    value.length > 8
                      ? '28px'
                      : value.length > 5
                        ? '38px'
                        : undefined,
                }}
                onChange={(e) => update(e.target.value)}
              />
              <span>kg</span>
            </div>
          </label>
          <p className="field-help">
            Spara vikten med någon av knapparna nedan.
          </p>
          <div className="keypad">
            {[
              '1',
              '2',
              '3',
              '4',
              '5',
              '6',
              '7',
              '8',
              '9',
              ',',
              '0',
              'backspace',
            ].map((k) => (
              <button
                type="button"
                key={k}
                aria-label={k === 'backspace' ? 'Radera sista siffran' : k}
                onPointerDown={(e) => {
                  if (!e.isPrimary || e.button !== 0) return;
                  e.preventDefault();
                  key(k);
                }}
                onClick={(e) => {
                  if (e.detail === 0) key(k);
                }}
              >
                {k === 'backspace' ? '⌫' : k}
              </button>
            ))}
          </div>
          {error && <Notice tone="red">{error}</Notice>}
          <div className="weight-actions">
            <div>
              <Button variant="outline" icon={Plus} onClick={() => save(true)}>
                Nästa material
              </Button>
              <p>Spara vikten och välj nästa material.</p>
            </div>
            <div>
              <Button type="submit">
                Färdigvägt <ChevronRight size={18} />
              </Button>
              <p>
                {back === 'vehicle'
                  ? 'Spara vikten och återgå till fordonskortet.'
                  : 'Spara vikten och gå till sammanställningen.'}
              </p>
            </div>
          </div>
        </form>
      </main>
      {cancel && (
        <Modal
          title="Avbryt utan att spara vikten?"
          onClose={() => setCancel(false)}
        >
          <p>
            Den här inmatningen sparas inte som materialrad. Tidigare sparade
            material finns kvar.
          </p>
          <Button variant="outline" onClick={() => setCancel(false)}>
            Fortsätt väga
          </Button>
          <Button variant="danger" onClick={abort}>
            Avbryt
          </Button>
        </Modal>
      )}
    </>
  );
}
export function SummaryPage() {
  const { draft, saveDraft, data } = useDraft();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState<MaterialRow | null>(null);
  const [error, setError] = useState('');
  if (!draft) return <MissingDraft />;
  const locked = draft.status === 'ready';
  const customer = data.customers.find((c) => c.id === draft.customerId);
  const complete =
    isComplete(draft) && !draft.pendingWeight && !draft.vehicleInput;
  function finish() {
    if (!complete) {
      setError(
        'Färdigställ alla materialvikter innan du sparar vägningen som färdig.',
      );
      return;
    }
    if (saveDraft({ ...draft!, status: 'ready' }))
      navigate(`/weigh/${draft!.id}/done`);
  }
  return (
    <>
      <Header
        title={locked ? `Vägning #${draft.number}` : 'Sammanställning'}
        back={locked ? '/drafts' : '/'}
      />
      <main className={`page-body summary-page ${locked ? 'with-nav' : ''}`}>
        <div className="heading-row">
          <p className="eyebrow">INVÄGNING #{draft.number}</p>
          <span className={`badge ${locked ? 'green' : 'amber'}`}>
            {locked ? 'Färdig · låst' : 'Lokalt utkast'}
          </span>
        </div>
        <div className="summary-materials">
          {draft.rows.map((row) => (
            <SummaryRow
              key={row.id}
              row={row}
              draftId={draft.id}
              locked={locked}
              remove={() => setDeleting(row)}
            />
          ))}
        </div>
        {draft.pendingWeight && (
          <Notice tone="amber">
            En vikt är inte färdigregistrerad.
            <button
              className="text-button"
              onClick={() =>
                navigate(
                  `/weigh/${draft.id}/weight/${draft.pendingWeight!.articleId}?back=${draft.pendingWeight!.back}${draft.pendingWeight!.rowId ? `&row=${draft.pendingWeight!.rowId}` : ''}`,
                )
              }
            >
              Fortsätt ange vikt
            </button>
          </Notice>
        )}
        {draft.vehicleInput && (
          <Notice tone="amber">
            Fordonsvikten har påbörjade ändringar.
            <button
              className="text-button"
              onClick={() => navigate(`/weigh/${draft.id}/vehicle`)}
            >
              Fortsätt fordonsvägningen
            </button>
          </Notice>
        )}
        {!draft.rows.length && (
          <Empty
            title="Lägg till första materialet"
            text="Välj artikel och registrera vikten."
          />
        )}
        {!locked && (
          <Button
            variant="outline"
            icon={Plus}
            onClick={() =>
              navigate(`/weigh/${draft.id}/materials?back=summary`)
            }
          >
            Lägg till material
          </Button>
        )}
        <Total weight={totalWeight(draft)} count={draft.rows.length} />
        {locked ? (
          <>
            <section className="readonly-customer">
              <h2>{customer?.name ?? 'Kund ej vald'}</h2>
              <p>Referens: {draft.reference || 'Ej angiven'}</p>
              <p>Ursprung: {draft.origin || 'Ej angivet'}</p>
            </section>
            <Notice>
              <LockKeyhole size={18} /> Sparad vägning. Uppgifterna visas utan
              möjlighet att ändra.
            </Notice>
          </>
        ) : (
          <>
            {' '}
            <CustomerLink draftId={draft.id} customerId={draft.customerId} />
            <ReferenceLink
              draftId={draft.id}
              customerId={draft.customerId}
              reference={draft.reference}
              origin={draft.origin}
            />
          </>
        )}
        {error && <Notice tone="red">{error}</Notice>}
        {!locked && (
          <div className="stack tight">
            <Button icon={Check} onClick={finish} disabled={!complete}>
              Spara färdig vägning
            </Button>
            <Button
              variant="outline"
              icon={Save}
              onClick={() => {
                if (saveDraft(draft)) navigate('/drafts');
              }}
            >
              Spara utkast
            </Button>
            <p className="demo-footnote">
              Sparas i demon. Inget skickas till kontoret.
            </p>
          </div>
        )}
      </main>
      {locked && <Nav />}
      {deleting && (
        <Modal title="Ta bort material?" onClose={() => setDeleting(null)}>
          <p>
            {articleById(deleting.articleId).name}, {kilos(rowWeight(deleting))}{' '}
            kg tas bort från kortet.
          </p>
          <Button
            variant="danger"
            onClick={() => {
              if (
                saveDraft({
                  ...draft,
                  status: 'draft',
                  rows: draft.rows.filter((r) => r.id !== deleting.id),
                })
              )
                setDeleting(null);
            }}
          >
            Ta bort material
          </Button>
          <Button variant="outline" onClick={() => setDeleting(null)}>
            Behåll material
          </Button>
        </Modal>
      )}
    </>
  );
}
function SummaryRow({
  row,
  draftId,
  remove,
  locked = false,
}: {
  row: MaterialRow;
  draftId: string;
  remove: () => void;
  locked?: boolean;
}) {
  const article = articleById(row.articleId);
  const navigate = useNavigate();
  return (
    <div className="summary-row-wrap">
      <div className="summary-row">
        <Photo index={article.photos[0]} label={article.name} />
        <div className="summary-row-copy">
          <strong>{article.name}</strong>
          <b>
            {row.method === 'vehicle' && row.tare == null
              ? 'Väntar på utfart'
              : `${kilos(rowWeight(row))} kg`}
          </b>
          <small>
            {row.method === 'vehicle' ? (
              <>
                <Truck size={13} /> Fordonsvåg · {row.registration}
              </>
            ) : (
              <>
                <Scale size={13} /> Separat våg
              </>
            )}
          </small>
        </div>
        {!locked && (
          <>
            <button
              className="icon-button blue-text"
              aria-label={`Ändra ${article.name}`}
              onClick={() =>
                navigate(
                  row.method === 'vehicle'
                    ? `/weigh/${draftId}/vehicle`
                    : `/weigh/${draftId}/weight/${row.articleId}?row=${row.id}&back=summary`,
                )
              }
            >
              <Pencil size={19} />
            </button>
            <button
              className="icon-button red-text"
              aria-label={`Ta bort ${article.name}`}
              onClick={remove}
            >
              <Trash2 size={19} />
            </button>
          </>
        )}
      </div>
      {row.method === 'vehicle' && (
        <details className="evidence">
          <summary>
            Vågunderlag <ChevronRight size={17} />
          </summary>
          <dl>
            <div>
              <dt>Registreringsnummer</dt>
              <dd>{row.registration}</dd>
            </div>
            <div>
              <dt>Infart</dt>
              <dd>
                {row.gross == null
                  ? 'Ej registrerad'
                  : `${kilos(row.gross)} kg`}
              </dd>
            </div>
            {row.entryAt && (
              <div className="evidence-time">
                <dt>Registrerad</dt>
                <dd>{dateTime(row.entryAt)}</dd>
              </div>
            )}
            <div>
              <dt>Utfart</dt>
              <dd>
                {row.tare == null ? 'Ej registrerad' : `${kilos(row.tare)} kg`}
              </dd>
            </div>
            {row.exitAt && (
              <div className="evidence-time">
                <dt>Registrerad</dt>
                <dd>{dateTime(row.exitAt)}</dd>
              </div>
            )}
            {row.tare != null && (
              <>
                <div>
                  <dt>Nettovikt</dt>
                  <dd>{kilos((row.gross ?? 0) - row.tare)} kg</dd>
                </div>
                <div>
                  <dt>Viktavdrag</dt>
                  <dd>
                    −{kilos(row.deduction)} kg{' '}
                    {row.deductionReason && `· ${row.deductionReason}`}
                  </dd>
                </div>
                <div>
                  <dt>Materialvikt</dt>
                  <dd>
                    <strong>{kilos(rowWeight(row))} kg</strong>
                  </dd>
                </div>
              </>
            )}
          </dl>
        </details>
      )}
    </div>
  );
}
export function DonePage() {
  const { draft, data } = useDraft();
  if (!draft) return <MissingDraft />;
  const customer = data.customers.find((c) => c.id === draft.customerId);
  return (
    <>
      <Header title="Klart" />
      <main className="page-body done-page">
        <span className="done-icon">
          <CircleCheck size={68} strokeWidth={1.5} />
        </span>
        <h1>Vägningen är sparad</h1>
        <p>Sparad i demohistoriken.</p>
        <div className="readonly-customer">
          <h2>Vägning #{draft.number}</h2>
          <p>{customer?.name ?? 'Kund ej vald'}</p>
          <Total weight={totalWeight(draft)} count={draft.rows.length} />
          {draft.rows
            .filter((r) => r.method === 'vehicle')
            .map((r) => (
              <p key={r.id}>{r.registration}</p>
            ))}
        </div>
        <p>Inget skickas till kontoret i demon.</p>
      </main>
      <Nav />
    </>
  );
}
