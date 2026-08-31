/**
 * SafeBrowse Domain Normalizer
 * Normalizes inputs (URLs, hostnames, with or without protocol/credentials) into standard lowercase base domains.
 */
export function normalizeDomain(input: string): string {
  if (!input) return '';

  let domain = input.trim().toLowerCase();

  // Remove protocol if present
  if (domain.startsWith('http://')) {
    domain = domain.substring(7);
  } else if (domain.startsWith('https://')) {
    domain = domain.substring(8);
  } else if (domain.startsWith('//')) {
    domain = domain.substring(2);
  } else if (domain.includes('://')) {
    const idx = domain.indexOf('://');
    domain = domain.substring(idx + 3);
  }

  // Remove path, query params, hash
  const slashIdx = domain.indexOf('/');
  if (slashIdx !== -1) {
    domain = domain.substring(0, slashIdx);
  }

  const questionIdx = domain.indexOf('?');
  if (questionIdx !== -1) {
    domain = domain.substring(0, questionIdx);
  }

  const hashIdx = domain.indexOf('#');
  if (hashIdx !== -1) {
    domain = domain.substring(0, hashIdx);
  }

  // Remove userinfo (e.g. user:password@hostname)
  const atIdx = domain.indexOf('@');
  if (atIdx !== -1) {
    domain = domain.substring(atIdx + 1);
  }

  // Remove port if present (e.g. hostname:8080)
  const colonIdx = domain.indexOf(':');
  if (colonIdx !== -1) {
    domain = domain.substring(0, colonIdx);
  }

  // Remove trailing dot (DNS root)
  if (domain.endsWith('.')) {
    domain = domain.slice(0, -1);
  }

  // Remove standard 'www.' prefix for rule standardization
  if (domain.startsWith('www.')) {
    domain = domain.substring(4);
  }

  return domain.trim();
}
