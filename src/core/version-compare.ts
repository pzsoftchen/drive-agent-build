/**
 * Parse the dotted numeric versions used by skill markers and detect checks.
 * Prerelease, `v` prefixes and partial numeric runs are rejected so callers can
 * treat an unparseable version as "unknown", never as older.
 */
export function parseVersion(value: string): number[] | undefined {
  if (!/^\d+(?:\.\d+)*$/.test(value)) {
    return undefined;
  }
  return value.split('.').map((part) => Number(part));
}

/** Compare numeric version parts; missing trailing parts count as zero. */
export function compareVersions(
  left: readonly number[],
  right: readonly number[],
): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
