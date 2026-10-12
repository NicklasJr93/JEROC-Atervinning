import { ArrowLeft, Check, ChevronRight, Smartphone, X } from 'lucide-react';
import { articleGroupPath, type ArticleGroup, type ArticleImage } from '../catalog-types';
import { CatalogImage } from './CatalogImage';
import './catalog-mobile-preview.css';

export type CatalogPreviewArticle = {
  name: string;
  description: string;
  photos: ArticleImage[];
  includes: string[] | string;
  excludes: string[] | string;
  category?: string;
};

function lines(value: string[] | string) { return (Array.isArray(value) ? value : value.split(/\r?\n/)).map(item => item.trim()).filter(Boolean); }

export function CatalogMobilePreview({ article, group, groups = [] }: { article?: CatalogPreviewArticle; group?: ArticleGroup; groups?: ArticleGroup[] }) {
  const path = article?.category ? articleGroupPath(groups, article.category) : group ? articleGroupPath([...groups.filter(item => item.id !== group.id), group], group.id) : [];
  const includes = lines(article?.includes ?? []);
  const excludes = lines(article?.excludes ?? []);
  const parent = group?.parentId ? groups.find(item => item.id === group.parentId) : undefined;
  const hiddenByParent = Boolean(group?.parentId && !parent?.active);
  return <section className="office-catalog-preview" aria-label="Mobilförhandsvisning">
    <div className="office-catalog-preview-label"><Smartphone size={15} aria-hidden="true" /><strong>Förhandsvisning i gårdsappen</strong></div>
    <div className="office-catalog-preview-phone">
      <div className="office-catalog-preview-status" aria-hidden="true"><span>09:41</span><span>●●● ▰</span></div>
      <div className="office-catalog-preview-appbar"><ArrowLeft size={18} aria-hidden="true" /><strong>{article ? 'Materialinformation' : 'Välj material'}</strong><span /></div>
      <div className="office-catalog-preview-body">
        <div className="office-catalog-preview-path">Material{path.map(item => <span key={item.id}><ChevronRight size={10} aria-hidden="true" />{item.name || 'Ny artikelgrupp'}</span>)}{article && !path.length && <span><ChevronRight size={10} aria-hidden="true" />Övrigt</span>}</div>
        {article ? <>
          <h3>{article.name || 'Artikelnamn'}</h3>
          {article.description && <p className="office-catalog-preview-description">{article.description}</p>}
          <div className="office-catalog-preview-gallery">{(article.photos.length ? article.photos : [null]).map((photo, index) => <CatalogImage image={photo} alt={`${article.name || 'Artikel'} – exempel ${index + 1}`} key={photo ?? 'empty'} variant="thumb" />)}</div>
          {includes.length > 0 && <div className="office-catalog-preview-info includes"><div><Check size={14} aria-hidden="true" /><strong>Detta ingår</strong></div><ul>{includes.map((text, index) => <li key={index}>{text}</li>)}</ul></div>}
          {excludes.length > 0 && <div className="office-catalog-preview-info excludes"><div><X size={14} aria-hidden="true" /><strong>Detta ingår inte</strong></div><ul>{excludes.map((text, index) => <li key={index}>{text}</li>)}</ul></div>}
        </> : <>
          <h3>Vilket material lämnas?</h3>
          <p className="office-catalog-preview-description">Välj grupp för att hitta rätt artikel.</p>
          <div className="office-catalog-preview-group"><CatalogImage image={group?.photo} alt={group?.name || 'Artikelgrupp'} /><div><strong>{group?.name || 'Artikelgrupp'}</strong><p>{group?.description || 'Gruppens beskrivning visas här.'}</p></div><ChevronRight size={17} aria-hidden="true" /></div>
          {group && !group.active && <p className="office-catalog-preview-inactive">Gruppen är inaktiv och visas inte i appen.</p>}
          {group?.active && hiddenByParent && <p className="office-catalog-preview-inactive">{parent ? 'Överordnad grupp är inaktiv.' : 'Överordnad grupp saknas.'} Undergruppen och dess artiklar visas därför inte i appmenyn eller sökningen.</p>}
        </>}
      </div>
      <div className="office-catalog-preview-homebar" aria-hidden="true" />
    </div>
    <p className="office-catalog-preview-help">Förhandsvisningen följer dina ändringar. Spara för att uppdatera appen.</p>
  </section>;
}

export default CatalogMobilePreview;
