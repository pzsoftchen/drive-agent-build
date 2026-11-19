/**
 * Locale-independent string ordering.
 *
 * Hashes and stable JSON must not depend on the process locale. Never use
 * locale-dependent comparison for canonical ordering.
 */
export function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
