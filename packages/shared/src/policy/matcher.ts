import { normalizeDomain } from './normalizer';

/**
 * Checks if a target domain matches a rule pattern.
 *
 * Supported patterns:
 * - Exact domain: 'youtube.com' matches 'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'
 * - Subdomain wildcard: '*.google.com' matches 'mail.google.com', 'drive.google.com'
 */
export function domainMatches(targetDomain: string, ruleDomain: string): boolean {
  const normTarget = normalizeDomain(targetDomain);
  const normRule = normalizeDomain(ruleDomain);

  if (!normTarget || !normRule) return false;

  // 1. Exact match
  if (normTarget === normRule) {
    return true;
  }

  // 2. Wildcard rule format: e.g. *.example.com
  if (normRule.startsWith('*.')) {
    const baseRule = normRule.substring(2);
    if (normTarget === baseRule || normTarget.endsWith('.' + baseRule)) {
      return true;
    }
  }

  // 3. Subdomain matching: if rule is "youtube.com", it matches "m.youtube.com" or "video.internal.youtube.com"
  if (normTarget.endsWith('.' + normRule)) {
    return true;
  }

  return false;
}
