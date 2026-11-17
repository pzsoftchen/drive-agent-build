export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/;

export function parseSemVer(value: string): SemVer | null {
  const match = VERSION_PATTERN.exec(value.trim());
  if (match === null) {
    return null;
  }
  const major = Number.parseInt(match[1] ?? '', 10);
  const minor = Number.parseInt(match[2] ?? '', 10);
  const patch = Number.parseInt(match[3] ?? '', 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return { major, minor, patch, raw: match[0]?.trim() ?? value.trim() };
}

export function compareSemVer(left: SemVer, right: SemVer): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

export function isVersionAtLeast(actual: string, minimum: string): boolean {
  const actualVersion = parseSemVer(actual);
  const minimumVersion = parseSemVer(minimum);
  if (actualVersion === null || minimumVersion === null) {
    return false;
  }
  return compareSemVer(actualVersion, minimumVersion) >= 0;
}
