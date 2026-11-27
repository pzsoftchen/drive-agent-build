import { describe, expect, it } from 'vitest';
import { extractReleaseSection, renderReleaseNotes } from '../src/release/notes.ts';

const ENGLISH = `# Changelog

## Unreleased

- Unreleased item.

## 0.1.3 — 2026-11-27

- Added bilingual release notes.
- Fixed another thing.

## 0.1.2 — 2026-11-24

- Old item.
`;

const CHINESE = `# 变更日志

## Unreleased

- 未发布条目。

## 0.1.3 — 2026-11-27

- 新增中英文发布日志。
- 修复另一个问题。

## 0.1.2 — 2026-11-24

- 旧条目。
`;

describe('release notes', () => {
  it('extracts only the requested version section', () => {
    const section = extractReleaseSection(ENGLISH, '0.1.3');
    expect(section).toContain('Added bilingual release notes.');
    expect(section).not.toContain('Unreleased item.');
    expect(section).not.toContain('Old item.');
  });

  it('accepts a v-prefixed tag', () => {
    expect(extractReleaseSection(ENGLISH, 'v0.1.3')).toContain('Added bilingual release notes.');
  });

  it('fails loud when the version section is missing', () => {
    expect(() => extractReleaseSection(ENGLISH, '0.1.4')).toThrow(/0\.1\.4/);
  });

  it('renders English and Chinese sections with versioned changelog links', () => {
    const notes = renderReleaseNotes({
      version: 'v0.1.3',
      english: ENGLISH,
      chinese: CHINESE,
      repositoryUrl: 'https://github.com/pzsoftchen/drive-agent-build.git',
    });

    expect(notes).toContain('## English');
    expect(notes).toContain('Added bilingual release notes.');
    expect(notes).toContain('## 中文');
    expect(notes).toContain('新增中英文发布日志。');
    expect(notes).toContain(
      '[English](https://github.com/pzsoftchen/drive-agent-build/blob/v0.1.3/CHANGELOG.md)',
    );
    expect(notes).toContain(
      '[中文](https://github.com/pzsoftchen/drive-agent-build/blob/v0.1.3/CHANGELOG.zh.md)',
    );
    expect(notes).not.toContain('Unreleased item.');
    expect(notes).not.toContain('未发布条目。');
  });

  it('does not duplicate the section heading inside the language blocks', () => {
    const notes = renderReleaseNotes({
      version: '0.1.3',
      english: ENGLISH,
      chinese: CHINESE,
      repositoryUrl: 'https://github.com/pzsoftchen/drive-agent-build',
    });

    expect(notes.match(/^## 0\.1\.3/m)).toBeNull();
    expect(notes.match(/^## English$/m)).not.toBeNull();
    expect(notes.match(/^## 中文$/m)).not.toBeNull();
  });
});
