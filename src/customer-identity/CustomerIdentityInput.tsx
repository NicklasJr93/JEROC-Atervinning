import { useEffect, useId, useState } from 'react';
import { customerTypeFromIdentifier, inspectCustomerIdentifier, type CustomerIdentifierInspection } from '../customer-identity';
import ElectricFocusBorder from '../office/ElectricFocusBorder';
import './customer-identity.css';

export interface CustomerIdentityInputProps {
  value: string;
  onChange(value: string): void;
  type: string;
  onTypeChange(type: string): void;
  /** Start existing or transferred customers in manual mode to preserve their chosen role. */
  autoDetect?: boolean;
  disabled?: boolean;
  error?: string;
}

function identityHelp(inspection: CustomerIdentifierInspection, automatic: boolean, type: string): string {
  if (inspection.kind === 'empty') return 'Börja med organisations- eller personnummer. Du kan också välja kundtyp manuellt.';
  if (inspection.kind === 'incomplete') return 'Fortsätt skriva hela numret. Kundtypen föreslås först när numret är komplett och giltigt.';
  if (inspection.kind === 'invalid') return inspection.error!;
  if (inspection.kind === 'organisation') return automatic
    ? 'Organisationsnummer identifierat. Företag föreslås; välj BRF manuellt för en bostadsrättsförening.'
    : 'Organisationsnummer identifierat. Den kundtyp du har valt behålls.';
  const identity = inspection.kind === 'coordination' ? 'Samordningsnummer' : 'Personnummer';
  if (!automatic && type === 'Företag') return `${identity} används för enskild firma. Personuppgifter söks inte i företagsregistret.`;
  return `${identity} identifierat. ${automatic ? 'Privatperson föreslås' : 'Den kundtyp du har valt behålls'}; välj Företag för enskild firma.`;
}

/** Identity-first assistance only: no lookup, persistence or changes to saved customers. */
export default function CustomerIdentityInput({ value, onChange, type, onTypeChange, autoDetect = true, disabled = false, error }: CustomerIdentityInputProps) {
  const id = useId();
  const [automatic, setAutomatic] = useState(autoDetect);
  const inspection = inspectCustomerIdentifier(value);
  const inferredType = customerTypeFromIdentifier(value);
  const complete = Boolean(inferredType);
  const message = error || identityHelp(inspection, automatic, type);
  const invalid = Boolean(error) || inspection.kind === 'invalid';

  useEffect(() => { setAutomatic(autoDetect); }, [autoDetect]);
  useEffect(() => {
    if (automatic && !disabled && inferredType && inferredType !== type) onTypeChange(inferredType);
  }, [automatic, disabled, inferredType, onTypeChange, type]);

  return <div className="customer-identity-input">
    <div className="customer-identity-number">
      <label htmlFor={`${id}-number`}>Organisations-/personnummer</label>
      <div className={`customer-identity-number-outline${!disabled && !complete ? ' is-active' : ''}`}>
        <input id={`${id}-number`} value={value} onChange={event => onChange(event.target.value)}
          type="text" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={30} disabled={disabled}
          aria-invalid={invalid || undefined} aria-describedby={`${id}-help`} />
        <ElectricFocusBorder active={!disabled && !complete} />
      </div>
    </div>
    <div className="customer-identity-type">
      <label htmlFor={`${id}-type`}>Kundtyp</label>
      <select id={`${id}-type`} value={automatic ? 'automatic' : type} disabled={disabled}
        aria-describedby={`${id}-help`} onChange={event => {
          const selected = event.target.value;
          setAutomatic(selected === 'automatic');
          if (selected !== 'automatic') onTypeChange(selected);
          else if (inferredType) onTypeChange(inferredType);
        }}>
        <option value="automatic">Automatiskt{inferredType ? ` – ${inferredType}` : ''}</option>
        <option value="Företag">Företag</option>
        <option value="Privatperson">Privatperson</option>
        <option value="BRF">BRF</option>
      </select>
    </div>
    <p id={`${id}-help`} className={`customer-identity-help${invalid ? ' is-error' : ''}`} role="status" aria-live="polite" aria-atomic="true">{message}</p>
  </div>;
}
