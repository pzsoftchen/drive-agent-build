#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const candidate = input?.tool_input?.file_path ?? input?.tool_input?.path;
if (typeof candidate !== 'string') {
  process.exit(0);
}

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const rel = relative(root, resolve(root, candidate)).split('\\').join('/');
if (/^\.claude\/(settings\.json|CLAUDE\.md|agents\/|skills\/|rules\/)/.test(rel)) {
  process.stderr.write('DAB: .claude/ is generated. Edit .agents/ and run dab normalize.\n');
  process.exit(2);
}
process.exit(0);
