import { useState } from 'react';
import type { CompanyDefaultsSnapshot } from '../company-settings-defaults';

/** Only the minimal, tenant-checked settings response supplies this logo URL. */
export default function CompanyBrand({ branding, className }: {
  branding?: CompanyDefaultsSnapshot;
  className: string;
}) {
  const [failedSource, setFailedSource] = useState<string>();
  const sourceKey = `${branding?.companyId ?? ''}:${branding?.logoUrl ?? ''}`;
  const companyLogo = branding?.logoUrl && failedSource !== sourceKey;
  return <img className={className}
    src={companyLogo ? branding.logoUrl : '/images/scrappilot-logo.svg'}
    alt={companyLogo ? `${branding.profile.name} – företagslogga` : 'ScrapPilot'}
    onError={companyLogo ? () => setFailedSource(sourceKey) : undefined} />;
}
