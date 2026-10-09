import { CheckCircle2, CircleAlert, LoaderCircle } from 'lucide-react';
import { articles } from '../data';
import { environmentTime, environmentWeight, formatWasteCode, type EnvironmentalStorageAssessment } from './environment-types';
import './storage-assessment.css';

export default function StorageAssessmentSummary({ assessment, loading = false, error = '', detailed = false, recorded = false }: {
  assessment?: EnvironmentalStorageAssessment; loading?: boolean; error?: string; detailed?: boolean; recorded?: boolean;
}) {
  const blocked = assessment?.checks.some(check => check.severity === 'blocked');
  const warnings = assessment?.checks.filter(check => check.severity === 'warning') ?? [];
  const status = blocked ? 'blocked' : warnings.length || error || !assessment ? 'warning' : 'ok';
  const title = loading ? 'Kontrollerar lagringsplats och kapacitet…' : error ? 'Lagringskontrollen kunde inte hämtas'
    : !assessment ? 'Lagringskontroll saknas för denna äldre version'
    : blocked ? 'Mottagningen ryms inte inom lagringsreglerna'
    : warnings.length ? 'Lagringsvillkor behöver kontrolleras' : 'Inom angivna lagringsgränser';
  return <section className={`storage-assessment ${status}`} aria-label="Lagringskontroll" aria-busy={loading}>
    <div className="storage-assessment-heading">{loading ? <LoaderCircle size={16} /> : status === 'ok' && assessment ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}<div><strong>{title}</strong>{recorded && assessment && <small>Kontroll vid registrering · {environmentTime(assessment.checkedAt)}</small>}</div></div>
    {error && <p>{error}</p>}
    {!detailed && blocked && <p>{assessment?.checks.find(check => check.severity === 'blocked')?.message}</p>}
    {detailed && assessment && !loading && <ul>{assessment.checks.map((check, index) => <li key={`${check.code}/${check.articleId ?? check.wasteCode ?? ''}/${index}`} className={check.severity}>
      <div><strong>{check.articleId ? articles.find(article => article.id === check.articleId)?.name ?? check.articleId : check.wasteCode ? `Avfallskod ${formatWasteCode(check.wasteCode, false)}` : 'Anläggningen'}</strong><span>{check.message}</span></div>
      <small>Registrerat {environmentWeight(check.currentKg)} · {check.incomingKg < 0 ? 'Justering' : 'Tillkommer'} {environmentWeight(check.incomingKg)} · Efter {environmentWeight(check.projectedKg)}{check.maxKg != null && ` / ${environmentWeight(check.maxKg)}`}</small>
    </li>)}</ul>}
    {detailed && <small>Kontrollen bygger på registrerade mottagningar och rättelser. Utgående lager och inventering kopplas på i en senare etapp.</small>}
  </section>;
}
