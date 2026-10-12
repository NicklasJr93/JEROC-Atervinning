import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, Check, ChevronRight, Layers3, Plus, Search, ShieldCheck } from 'lucide-react';
import type { ArticleGroup, ArticleImage } from '../catalog-types';
import { articleGroupPath, childArticleGroups, rootArticleGroups } from '../catalog-types';
import type { OfficeUser } from './model';
import type { PriceArticle, PricingState } from './pricing-client';
import ArticleImagesEditor from './ArticleImagesEditor';
import CatalogImage from './CatalogImage';
import CatalogMobilePreview from './CatalogMobilePreview';
import { OfficePageHeader } from './OfficePageHeader';
import './article-groups.css';

type Props = {
  header: ReactNode;
  state: PricingState;
  user: OfficeUser;
  actualUser: OfficeUser;
  editable: boolean;
  busy: boolean;
  onSave: (body: unknown) => Promise<boolean>;
  onDetailChange: (detail: boolean) => void;
  onOpenArticle: (article: PriceArticle) => void;
};

export default function ArticleGroupsWorkspace({ header, state, user, actualUser, editable, busy, onSave, onDetailChange, onOpenArticle }: Props) {
  const groups = state.groups || [];
  const [selected, setSelected] = useState<ArticleGroup>();
  const [search, setSearch] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  useEffect(() => { onDetailChange(Boolean(selected)); }, [Boolean(selected), onDetailChange]);
  useEffect(() => () => onDetailChange(false), [onDetailChange]);
  const groupMembers = (id: string) => state.articles.filter(article => article.category === id || groups.some(group => group.id === article.category && group.parentId === id));
  const matches = (group: ArticleGroup) => (!activeOnly || group.active) && `${group.name} ${group.description}`.toLocaleLowerCase('sv').includes(search.toLocaleLowerCase('sv'));
  const visibleRoots = rootArticleGroups(groups).filter(root => matches(root) || childArticleGroups(groups, root.id).some(matches));
  function create(parentId?: string) {
    setSelected({ id: '', name: '', description: '', photo: null, parentId, active: true, sortOrder: (parentId ? childArticleGroups(groups, parentId) : rootArticleGroups(groups)).length, revision: 0 });
  }
  if (selected) return <GroupEditor key={`${selected.id}:${selected.parentId || ''}:${selected.revision}`} group={selected} groups={groups} articles={groupMembers(selected.id)} user={user} actualUser={actualUser} editable={editable} busy={busy} onCancel={() => setSelected(undefined)} onSelectGroup={setSelected} onCreateChild={() => create(selected.id)} onOpenArticle={article => { onDetailChange(false); onOpenArticle(article); }} onSave={async body => {
    if (await onSave(body)) setSelected(undefined);
  }} />;
  return <>
    <OfficePageHeader controls={<>
    <div className="office-pricing-panel-title"><div><h2>Grupper i gårdsappen</h2><p>En huvudgrupp kan innehålla artiklar och undergrupper.</p></div>{editable && <button className="office-pricing-primary" disabled={busy} onClick={() => create()}><Plus size={15} /> Ny artikelgrupp</button>}</div>
    <div className="office-pricing-toolbar office-article-groups-toolbar"><label className="office-pricing-search"><Search size={15} /><input aria-label="Sök artikelgrupp" placeholder="Sök grupp eller undergrupp…" value={search} onChange={event => setSearch(event.target.value)} /></label><label className="office-article-groups-active"><input type="checkbox" checked={activeOnly} onChange={event => setActiveOnly(event.target.checked)} /> Bara aktiva</label></div>
    </>}>{header}</OfficePageHeader>
    <section className="office-panel office-article-groups-overview">
    <div className="office-article-groups-list">
      {visibleRoots.map(group => <article className="office-article-group-card" key={group.id}>
        <button className="office-article-group-main" onClick={() => setSelected(group)} aria-label={`Öppna artikelgrupp ${group.name}`}><CatalogImage image={group.photo} name={group.name} className="office-article-group-image" /><span><strong>{group.name}</strong><small>{group.description || 'Ingen beskrivning'}</small><span className="office-article-group-meta">{groupMembers(group.id).length} artiklar · {childArticleGroups(groups, group.id).length} undergrupper <span className={`office-pricing-badge ${group.active ? 'green' : 'gray'}`}>{group.active ? 'Aktiv' : 'Inaktiv'}</span></span></span><ChevronRight size={17} /></button>
        {childArticleGroups(groups, group.id).filter(child => (!search || matches(group) || matches(child)) && (!activeOnly || child.active)).map(child => <button className="office-article-group-child" key={child.id} onClick={() => setSelected(child)} aria-label={`Öppna artikelgrupp ${child.name}`}><Layers3 size={16} /><strong>{child.name}</strong><small>{state.articles.filter(article => article.category === child.id).length} artiklar</small>{!child.active && <span className="office-pricing-badge gray">Inaktiv</span>}<ChevronRight size={15} /></button>)}
      </article>)}
    </div>
    {!visibleRoots.length && <p className="office-pricing-empty">Inga artikelgrupper matchar sökningen.</p>}
    <div className="office-article-group-ungrouped"><Layers3 size={19} /><span><strong>Övrigt</strong><small>{state.articles.filter(article => !article.category).length} artiklar utan grupp visas under Övrigt i appen.</small></span></div>
  </section></>;
}

function GroupEditor({ group, groups, articles, user, actualUser, editable, busy, onSave, onCancel, onSelectGroup, onCreateChild, onOpenArticle }: {
  group: ArticleGroup; groups: ArticleGroup[]; articles: PriceArticle[]; user: OfficeUser; actualUser: OfficeUser; editable: boolean; busy: boolean;
  onSave: (body: unknown) => Promise<void>; onCancel: () => void; onSelectGroup: (group: ArticleGroup) => void; onCreateChild: () => void; onOpenArticle: (article: PriceArticle) => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(group));
  const [imageBusy, setImageBusy] = useState(false);
  const children = childArticleGroups(groups, group.id);
  const images: ArticleImage[] = draft.photo === null ? [] : [draft.photo];
  const latestGroup = group.id ? groups.find(item => item.id === group.id) : undefined;
  const stale = Boolean(latestGroup && latestGroup.revision !== group.revision);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editable || busy || imageBusy || stale) return;
    await onSave({ group: { id: draft.id || undefined, name: draft.name.trim(), description: draft.description.trim(), photo: draft.photo, parentId: draft.parentId || undefined, sortOrder: draft.sortOrder, active: draft.active }, ...(group.id ? { expectedRevision: group.revision } : {}) });
  }
  return <div className="office-article-group-detail">
    <OfficePageHeader>
    <nav className="office-pricing-breadcrumbs" aria-label="Artikelgruppens sökväg"><button onClick={onCancel}>Artikelgrupper</button>{group.parentId && <><ChevronRight size={14} /><button onClick={() => { const parent = groups.find(item => item.id === group.parentId); if (parent) onSelectGroup(parent); }}>{groups.find(item => item.id === group.parentId)?.name}</button></>}<ChevronRight size={14} /><span>{group.name || (group.parentId ? 'Ny undergrupp' : 'Ny artikelgrupp')}</span></nav>
    <div className="office-pricing-heading"><div><h1>{group.name || (group.parentId ? 'Ny undergrupp' : 'Ny artikelgrupp')}</h1><p>Presentation och innehåll i gårdsappens materialmeny.</p></div><button className="office-pricing-plain" onClick={onCancel}><ArrowLeft size={15} /> Till artikelgrupper</button></div>
    </OfficePageHeader>
    <div className="office-article-group-editor-grid">
      <form className="office-pricing-form" onSubmit={event => void submit(event)}>
        {stale && <div className="office-pricing-error" role="alert">Gruppen har ändrats sedan du öppnade den. Öppna senaste versionen innan du sparar.<button type="button" disabled={imageBusy} onClick={() => { if (latestGroup) onSelectGroup(latestGroup); }}>Öppna senaste versionen</button></div>}
        <section className="office-panel"><h2>Gruppinställningar</h2><fieldset className="office-pricing-fields" disabled={!editable || busy || imageBusy}>
          <label>Gruppnamn<input required maxLength={120} value={draft.name} onChange={event => setDraft(old => ({ ...old, name: event.target.value }))} /></label>
          <label>Beskrivning i appen<textarea maxLength={250} value={draft.description} onChange={event => setDraft(old => ({ ...old, description: event.target.value }))} /></label>
          <div className="office-pricing-form-row"><label>Överordnad grupp<select aria-label="Överordnad grupp" value={draft.parentId || ''} disabled={children.length > 0} onChange={event => setDraft(old => ({ ...old, parentId: event.target.value || undefined }))}><option value="">Ingen – huvudgrupp</option>{rootArticleGroups(groups).filter(item => item.id !== group.id).map(item => <option key={item.id} value={item.id}>{item.name}{item.active ? '' : ' (inaktiv)'}</option>)}</select></label><label>Sorteringsordning<input type="number" min={0} max={99999} step={1} required value={draft.sortOrder} onChange={event => setDraft(old => ({ ...old, sortOrder: Number(event.target.value) }))} /></label></div>
          {children.length > 0 && <small>Gruppen har undergrupper och ligger därför kvar som huvudgrupp.</small>}
          <label className="office-pricing-checkbox"><input type="checkbox" checked={draft.active} onChange={event => setDraft(old => ({ ...old, active: event.target.checked }))} /> Gruppen är aktiv i appen</label>
          <small>En inaktiv grupp döljs tillsammans med sina undergrupper och artiklar i appmenyn och sökningen.</small>
        </fieldset><ArticleImagesEditor key={`${group.id}:${actualUser.id}:${user.id}`} images={images} maxImages={1} user={user} actualUser={actualUser} disabled={!editable || busy} onChange={next => setDraft(old => ({ ...old, photo: next[0] ?? null }))} onBusyChange={setImageBusy} /></section>
        {group.id && <section className="office-panel"><div className="office-pricing-panel-title"><div><h2>Artiklar i gruppen</h2><p>Kopplingen ändras på respektive artikelsida.</p></div><span className="office-pricing-badge gray">{articles.length}</span></div><div className="office-pricing-table-wrap"><table className="office-pricing-table"><thead><tr><th>Artikel</th><th>Placering</th><th>Status</th><th /></tr></thead><tbody>{articles.map(article => <tr key={article.id}><td><span className="office-pricing-material"><CatalogImage image={article.photos[0] ?? null} name={article.name} className="office-pricing-photo" /><strong>{article.name}</strong></span></td><td>{articleGroupPath(groups, article.category).map(item => item.name).join(' › ') || 'Övrigt'}</td><td><span className={`office-pricing-badge ${article.active ? 'green' : 'gray'}`}>{article.active ? 'Aktiv' : 'Inaktiv'}</span></td><td><button type="button" className="office-pricing-edit" onClick={() => onOpenArticle(article)} aria-label={`Redigera ${article.name}`}>Öppna <ChevronRight size={14} /></button></td></tr>)}</tbody></table></div>{!articles.length && <p className="office-pricing-empty">Inga artiklar är kopplade ännu. Välj grupp på artikelsidan.</p>}
          {!group.parentId && <div className="office-article-group-subgroups"><div className="office-pricing-panel-title"><h2>Undergrupper</h2>{editable && <button type="button" className="office-pricing-plain" disabled={busy || imageBusy} onClick={onCreateChild}><Plus size={14} /> Ny undergrupp</button>}</div>{children.map(child => <button type="button" key={child.id} onClick={() => onSelectGroup(child)}>{child.name}<ChevronRight size={14} /></button>)}{!children.length && <small>Artiklar kan ligga direkt i huvudgruppen.</small>}</div>}
        </section>}
        <div className="office-pricing-editor-actions"><span><ShieldCheck size={15} /> Grupperna delas med gårdsappen.</span><button type="button" className="office-pricing-plain" disabled={imageBusy} onClick={onCancel}>{editable ? 'Avbryt' : 'Tillbaka'}</button>{editable && <button type="submit" disabled={busy || imageBusy || stale} className="office-pricing-primary"><Check size={15} />{imageBusy ? 'Laddar upp bild…' : busy ? 'Sparar…' : 'Spara artikelgrupp'}</button>}</div>
      </form>
      <CatalogMobilePreview group={draft} groups={groups} />
    </div>
  </div>;
}
