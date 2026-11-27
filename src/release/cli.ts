#!/usr/bin/env node
import { loadReleaseNotes } from './notes.ts';

const tag = process.argv[2];
if (tag === undefined || tag.length === 0) {
  process.stderr.write('usage: release-notes <vX.Y.Z>\n');
  process.exitCode = 2;
} else {
  try {
    process.stdout.write(await loadReleaseNotes(process.cwd(), tag));
  } catch (error) {
    process.stderr.write(
      `release notes: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
