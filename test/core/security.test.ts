import { describe, expect, it } from 'vitest';
import { scanSecrets } from '../../src/core/security.ts';

describe('secret scanning', () => {
  it('detects a private key block', () => {
    const findings = scanSecrets(
      ['before', '-----BEGIN OPENSSH PRIVATE KEY-----', 'after'].join('\n'),
      '.agents/hooks/key.md',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('secret.detected');
    expect(findings[0]?.line).toBe(2);
    expect(findings[0]?.message).toContain('private key');
  });

  it('detects a GitHub token', () => {
    const findings = scanSecrets('token: ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'memory.md');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('GitHub');
  });

  it('ignores placeholders and environment references', () => {
    expect(scanSecrets('token: ${GITHUB_TOKEN}', 'a.md')).toEqual([]);
    expect(scanSecrets('api_key: example-value-123', 'a.md')).toEqual([]);
    expect(scanSecrets('password: changeme', 'a.md')).toEqual([]);
  });

  it('detects a generic password assignment', () => {
    const findings = scanSecrets('password = "correct-horse-battery"', 'config.yaml');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('credential assignment');
  });

  it('does not duplicate a specific token as a generic assignment', () => {
    const findings = scanSecrets('api_key: sk-ant-abcdefghijklmnopqrstuvwxyz', 'config.yaml');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('Anthropic');
  });
});
