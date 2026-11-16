import type { Diagnostic } from './diagnostics.ts';

interface SecretPattern {
  label: string;
  regex: RegExp;
}

interface MatchSpan {
  start: number;
  end: number;
  label: string;
}

const SPECIFIC_PATTERNS: SecretPattern[] = [
  {
    label: 'private key',
    regex: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g,
  },
  {
    label: 'AWS access key',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    label: 'GitHub token',
    regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    label: 'Anthropic API key',
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    label: 'OpenAI API key',
    regex: /\bsk-[A-Za-z0-9]{32,}\b/g,
  },
  {
    label: 'Slack token',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
];

const ASSIGNMENT_PATTERN =
  /(?<![A-Za-z0-9_])(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?([A-Za-z0-9_\-./+=]{8,})["']?/gi;

const PLACEHOLDER_MARKERS = [
  '${',
  '<',
  '>',
  'example',
  'changeme',
  '***',
  'xxxx',
  'redacted',
  'placeholder',
  'your_',
  'your-',
];

function isPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker));
}

function lineNumber(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text[cursor] === '\n') {
      line += 1;
    }
  }
  return line;
}

function overlaps(left: MatchSpan, right: MatchSpan): boolean {
  return left.start < right.end && right.start < left.end;
}

export function scanSecrets(text: string, file: string): Diagnostic[] {
  const findings: Array<MatchSpan & { line: number }> = [];

  for (const pattern of SPECIFIC_PATTERNS) {
    for (const match of text.matchAll(pattern.regex)) {
      const value = match[0];
      const start = match.index ?? 0;
      if (isPlaceholder(value)) {
        continue;
      }
      findings.push({
        start,
        end: start + value.length,
        label: pattern.label,
        line: lineNumber(text, start),
      });
    }
  }

  for (const match of text.matchAll(ASSIGNMENT_PATTERN)) {
    const value = match[1];
    const start = match.index ?? 0;
    if (value === undefined || isPlaceholder(value)) {
      continue;
    }
    const span: MatchSpan = {
      start,
      end: start + match[0].length,
      label: 'credential assignment',
    };
    if (findings.some((finding) => overlaps(finding, span))) {
      continue;
    }
    findings.push({ ...span, line: lineNumber(text, start) });
  }

  return findings
    .sort((left, right) => left.start - right.start)
    .map((finding) => ({
      code: 'secret.detected',
      severity: 'error' as const,
      file,
      line: finding.line,
      message: `possible ${finding.label}`,
      hint: 'Remove the secret from authored source and load it from the environment or a local settings file.',
    }));
}
