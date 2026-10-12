import { randomInt } from 'node:crypto';

function checkDigit(firstNine: string): string {
  const sum = [...firstNine].reduce((total, digit, index) => {
    const product = Number(digit) * (index % 2 === 0 ? 2 : 1);
    return total + (product > 9 ? product - 9 : product);
  }, 0);
  return String((10 - sum % 10) % 10);
}

/** Synthetic identities with meaningful date/length/checksum for input tests. */
export function testOrganisationNumber(): string {
  const firstNine = `559${randomInt(100000, 1000000)}`;
  return firstNine + checkDigit(firstNine);
}

export function testPersonalNumber(): string {
  const firstEleven = `19800101${randomInt(100, 1000)}`;
  return firstEleven + checkDigit(firstEleven.slice(2));
}
