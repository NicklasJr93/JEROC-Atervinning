import { useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleX,
  Maximize2,
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
  DemoBadge,
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
  const [mode, setMode] = useState<'direct' | 'vehicle'>('direct');
  const { data, saveDraft } = useDemo();
  const navigate = useNavigate();
  function start() {
    const draft = createDraft(data, mode);
    if (saveDraft(draft))
      navigate(
        `/weigh/${draft.id}/${mode === 'vehicle' ? 'vehicle' : 'materials'}`,
      );
  }
  return (
    <>
      <Header title="Vägningssätt" />
      <main className="page-body flow-body">
        <div>
          <p className="intro">Hur ska materialet vägas?</p>
          <div className="mode-options">
            {(
              [
                {
                  id: 'direct',
                  title: 'Materialvägning',
                  text: 'Ange materialets vikt direkt',
                  icon: Scale,
                },
                {
                  id: 'vehicle',
                  title: 'Fordonsvåg',
                  text: 'Vikt vid infart och utfart',
                  icon: Truck,
                },
              ] as const
            ).map(({ id: key, title, text, icon: Icon }) => (
              <button
                key={key}
                className={`mode-card ${mode === key ? 'selected' : ''}`}
                onClick={() => setMode(key)}
                aria-pressed={mode === key}
              >
                <span className="radio-dot">
                  {mode === key && <Check size={15} />}
                </span>
                <Icon size={53} strokeWidth={1.5} />
                <strong>{title}</strong>
                <span>{text}</span>
              </button>
            ))}
          </div>
        </div>
        <Button variant="blue" onClick={start}>
          Fortsätt <ChevronRight size={19} />
        </Button>
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
  const article = articles.find((a) => a.id === articleId);
  if (!draft) return <MissingDraft />;
  if (!article) return <MissingDraft />;
  const query = params.toString();
  const target = params.get('target');
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
    <>
      <Header
        title={article.name}
        back={`/weigh/${draft.id}/materials/${article.category}?${query}`}
      />
      <main className="page-body article-info">
        <div
          className="gallery"
          onTouchStart={(e) => {
            e.currentTarget.dataset.touch = String(e.touches[0].clientX);
          }}
          onTouchEnd={(e) => {
            const dx =
              e.changedTouches[0].clientX -
              Number(e.currentTarget.dataset.touch);
            if (Math.abs(dx) > 45)
              setPhoto((photo + (dx < 0 ? 1 : -1) + 4) % 4);
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
          <button
            className="gallery-arrow left"
            aria-label="Föregående referensbild"
            onClick={() => setPhoto((photo + 3) % 4)}
          >
            <ChevronLeft />
          </button>
          <button
            className="gallery-arrow right"
            aria-label="Nästa referensbild"
            onClick={() => setPhoto((photo + 1) % 4)}
          >
            <ChevronRight />
          </button>
          <span className="gallery-counter">{photo + 1} / 4</span>
        </div>
        <div className="gallery-dots">
          {article.photos.map((_, i) => (
            <button
              key={i}
              aria-label={`Visa exempel ${i + 1}`}
              className={i === photo ? 'active' : ''}
              onClick={() => setPhoto(i)}
            />
          ))}
          <small>Svep för fler exempel</small>
        </div>
        <div className="gallery-thumbs">
          {article.photos.map((p, i) => (
            <button
              key={i}
              aria-label={`Välj referensbild ${i + 1}`}
              onClick={() => setPhoto(i)}
              className={i === photo ? 'active' : ''}
            >
              <Photo index={p} label={article.name} />
            </button>
          ))}
        </div>
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
        <Button variant="blue" onClick={select}>
          Välj {article.name}
        </Button>
      </main>
      {zoom && (
        <Modal
          title={`${article.name} · ${photo + 1} av 4`}
          onClose={() => setZoom(false)}
        >
          <Photo
            index={article.photos[photo]}
            label={article.name}
            className="zoom-photo"
          />
          <div className="split">
            <Button
              variant="outline"
              onClick={() => setPhoto((photo + 3) % 4)}
              icon={ChevronLeft}
            >
              Förra
            </Button>
            <Button
              variant="outline"
              onClick={() => setPhoto((photo + 1) % 4)}
              icon={ChevronRight}
            >
              Nästa
            </Button>
          </div>
        </Modal>
      )}
    </>
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
  const [error, setError] = useState('');
  const article = articles.find((a) => a.id === articleId);
  if (!draft || !article) return <MissingDraft />;
  const back = params.get('back') === 'vehicle' ? 'vehicle' : 'summary';
  function update(s: string) {
    setValue(s);
    setError('');
    saveDraft({
      ...draft!,
      status: 'draft',
      pendingWeight: {
        articleId: article!.id,
        value: s,
        rowId: edit?.id,
        back,
      },
    });
  }
  function key(s: string) {
    if (s === 'backspace') update(value.slice(0, -1));
    else if (s === ',') {
      if (!/[,.]/.test(value)) update((value || '0') + ',');
    } else if (value.length < 12) update(value === '0' ? s : value + s);
  }
  function save(next: boolean) {
    const weight = parseWeight(value);
    if (weight == null || weight <= 0) {
      setError('Ange en vikt större än 0 kg, med högst tre decimaler.');
      return;
    }
    const row: MaterialRow = {
      id: edit?.id ?? id(),
      articleId: article!.id,
      method: 'direct',
      weight,
    };
    const updated = {
      ...draft!,
      status:
        draft!.status === 'awaiting-exit'
          ? ('awaiting-exit' as const)
          : ('draft' as const),
      pendingWeight: undefined,
      rows: edit
        ? draft!.rows.map((r) => (r.id === edit.id ? row : r))
        : [...draft!.rows, row],
    };
    if (saveDraft(updated))
      navigate(
        next
          ? `/weigh/${draft!.id}/materials?back=${back}`
          : `/weigh/${draft!.id}/${back}`,
      );
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    save(false);
  }
  return (
    <>
      <Header
        title="Ange vikt"
        back={`/weigh/${draft.id}/materials?back=${back}`}
      />
      <main className="page-body weight-page">
        <div className="selected-material">
          <Photo index={article.photos[0]} label={article.name} />
          <span>
            <strong>{article.name}</strong>
            <small>{article.description}</small>
          </span>
        </div>
        <form onSubmit={submit} className="stack">
          <label className="weight-entry-label">
            Vikt
            <div className="big-weight">
              <input
                aria-label="Vikt i kg"
                inputMode="decimal"
                value={value}
                placeholder="0"
                onChange={(e) => update(e.target.value)}
              />
              <span>kg</span>
            </div>
          </label>
          <p className="field-help">Läggs till på invägning #{draft.number}.</p>
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
                onClick={() => key(k)}
              >
                {k === 'backspace' ? <span>⌫</span> : k}
              </button>
            ))}
          </div>
          {error && <Notice tone="red">{error}</Notice>}
          {back === 'vehicle' ? (
            <Button type="submit" icon={Plus}>
              Lägg till på kortet
            </Button>
          ) : (
            <div className="split">
              <Button variant="blue" icon={Plus} onClick={() => save(true)}>
                Material<small>Lägg till och fortsätt</small>
              </Button>
              <Button type="submit" icon={Check}>
                Färdigvägd<small>Till sammanställning</small>
              </Button>
            </div>
          )}
          <button
            className="text-button"
            type="button"
            onClick={() => {
              if (
                saveDraft({
                  ...draft,
                  pendingWeight: {
                    articleId: article.id,
                    value,
                    rowId: edit?.id,
                    back,
                  },
                })
              )
                navigate(
                  draft.rows.some(
                    (r) =>
                      r.method === 'vehicle' && r.entryAt && r.tare == null,
                  )
                    ? '/pending'
                    : '/drafts',
                );
            }}
          >
            <Save size={16} /> Spara och pausa
          </button>
        </form>
      </main>
    </>
  );
}
export function SummaryPage() {
  const { draft, saveDraft } = useDraft();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState<MaterialRow | null>(null);
  const [error, setError] = useState('');
  if (!draft) return <MissingDraft />;
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
      <Header title="Sammanställning" />
      <main className="page-body summary-page">
        <div className="heading-row">
          <p className="eyebrow">INVÄGNING #{draft.number}</p>
          <span className="badge amber">Lokalt utkast</span>
        </div>
        <div className="summary-materials">
          {draft.rows.map((row) => (
            <SummaryRow
              key={row.id}
              row={row}
              draftId={draft.id}
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
        <Button
          variant="outline"
          icon={Plus}
          onClick={() => navigate(`/weigh/${draft.id}/materials?back=summary`)}
        >
          Lägg till material
        </Button>
        <Total weight={totalWeight(draft)} count={draft.rows.length} />
        <CustomerLink draftId={draft.id} customerId={draft.customerId} />
        <ReferenceLink
          draftId={draft.id}
          customerId={draft.customerId}
          reference={draft.reference}
          origin={draft.origin}
        />
        {error && <Notice tone="red">{error}</Notice>}
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
      </main>
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
}: {
  row: MaterialRow;
  draftId: string;
  remove: () => void;
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
  const { draft } = useDraft();
  const navigate = useNavigate();
  if (!draft) return <MissingDraft />;
  return (
    <>
      <Header title="Vägningen sparad" />
      <main className="page-body done-page">
        <span className="done-icon">
          <CircleCheck size={68} strokeWidth={1.5} />
        </span>
        <h1>Klart i demon!</h1>
        <p>Invägning #{draft.number} är sparad på den här enheten.</p>
        <Notice tone="green">
          Inget har skickats till kontoret. Du hittar kortet i Mina utkast och
          kan fortsätta redigera det.
        </Notice>
        <Total weight={totalWeight(draft)} count={draft.rows.length} />
        <CustomerLink draftId={draft.id} customerId={draft.customerId} />
        <Button variant="blue" icon={Plus} onClick={() => navigate('/new')}>
          Ny vägning
        </Button>
        <Button
          variant="outline"
          onClick={() => navigate(`/weigh/${draft.id}/summary`)}
        >
          Öppna vägningen
        </Button>
        <button className="text-button" onClick={() => navigate('/')}>
          Till startsidan
        </button>
        <DemoBadge />
      </main>
      <Nav />
    </>
  );
}
