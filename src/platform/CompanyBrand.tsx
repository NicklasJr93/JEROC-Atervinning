import { useState, type ReactNode } from 'react';
import type { CompanyDefaultsSnapshot } from '../company-settings-defaults';

/** Only the minimal, tenant-checked settings response supplies this logo URL. */
export default function CompanyBrand({ branding, className, fallbackCaption }: {
  branding?: CompanyDefaultsSnapshot;
  className: string;
  fallbackCaption?: ReactNode;
}) {
  const [failedSource, setFailedSource] = useState<string>();
  const sourceKey = `${branding?.companyId ?? ''}:${branding?.logoUrl ?? ''}`;
  const companyLogo = branding?.logoUrl && failedSource !== sourceKey;
  return <><img className={className}
    src={companyLogo ? branding.logoUrl : '/images/scrapplanner-logo.png'}
    alt={companyLogo ? `${branding.profile.name} – företagslogga` : 'ScrapPlanner'}
    onError={companyLogo ? () => setFailedSource(sourceKey) : undefined} />
    {!companyLogo && fallbackCaption}</>;
}
