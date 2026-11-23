import { readFileSync } from 'node:fs';

function readDabVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  if (
    typeof parsed !== 'object'
    || parsed === null
    || typeof (parsed as { version?: unknown }).version !== 'string'
  ) {
    throw new Error('package.json must declare a string version');
  }
  return (parsed as { version: string }).version;
}

/** Installed package version, used in CLI output and authored skill markers. */
export const DAB_VERSION: string = readDabVersion();
