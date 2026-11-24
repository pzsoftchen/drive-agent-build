# DAB Managed Skills Pack 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 DAB 的 `dab-*` authoring skills 从内嵌字符串和 copy-once 安装，升级为包内 canonical `skills/` 源文件 + version/hash marker + hash-aware managed update，同时保留用户分叉。

**Architecture:** `skills/<name>/SKILL.md` 是唯一模板源，随 npm 包发布；运行时从 package root 读取，不依赖网络或 `npx skills`。安装时在 body 写入 `<!-- dab-skill: name@version sha256=... -->`；`normalize` 在 target planning 前检查 hash，只更新未修改的旧模板，保留 modified/legacy 分叉；`detect` 报告 current/stale/modified/legacy/unversioned。

**Tech Stack:** TypeScript ESM、Node >=24.9、pnpm、Vitest、SHA-256（`node:crypto`）；不新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-11-24-managed-skills-design.md`

## Global Constraints

- `.agents/skills/dab-*` 是 DAB-managed 安装副本；`skills/` 是 canonical 模板源。
- 不调用 `npx skills`、网络或外部安装器；只读已安装 DAB 包内的 `skills/`。
- marker 格式：`<!-- dab-skill: <name>@<version> sha256=<hex> -->`；hash 是去掉 marker 后 body 的 SHA-256。
- 未修改的旧模板可自动 update；用户修改过的 body 永不覆盖，报告 modified，停止自动管理。
- legacy marker（无 hash）只有 body 与当前模板一致时才 migrate；否则保留并 warning。
- `detect` 的 `skill-stale` 仍触发 strict；`skill-modified`、`skill-legacy`、`skill-unversioned` 为非 strict warning。
- managed update 在 target planning 前完成；blocking path 错误零写入；modified/legacy 不阻止其他 practice/target 写入。
- 用户自定义 skills（非 `dab-*`）和 import 的 `.claude/skills` 不受影响。
- `.claude` 仍是生成目录；不手改。
- JSON additive，`schemaVersion` 保持 1；EN/ZH 文档成对更新。

## Review Focus

- package 内 `skills/` 是否真的被 npm pack 包含，运行时路径在源码、dist、npx 三种场景一致。
- marker hash 的规范化是否稳定：插入/移除 marker 后 hash 必须可复算，换行不能漂移。
- modified/legacy 分叉是否永不覆盖；stale 自动更新后 marker/hash 是否同步。
- normalize 的 update 是否在 target planning 前、是否遵守 all-or-nothing；dry-run/JSON 是否准确。
- detect 的 state/strict 映射是否与 docs 一致，且不产生重复行。
- DAB dogfood 的三个 skills 是否通过同一机制迁移，而不是手工复制。

---

### Task 1: Canonical skills source 与 loader

**Files:**
- Create: `skills/dab-doc-writing/SKILL.md`
- Create: `skills/dab-architecture-writing/SKILL.md`
- Create: `skills/dab-decision-notes/SKILL.md`
- Create: `src/init/skill-templates.ts`
- Modify: `src/init/practice-authoring.ts`
- Modify: `package.json`
- Test: `test/init/skill-templates.test.ts`
- Test: `test/init/practice-authoring.test.ts`
- Test: `test/release.test.ts` or pack test for `files`

**Interfaces:**
- Produces: `loadAuthoringSkillTemplate(name: AuthoringSkillName): Promise<string>`; returns the canonical file text without marker.
- Produces: `renderAuthoringSkill(name, version): Promise<string>`; reads the template, inserts the marker, and returns the body.
- `authoringPack.files(context)` becomes async and calls `renderAuthoringSkill`.

- [x] **Step 1: Move canonical content into `skills/`**

Create the three Markdown files from the current `practice-authoring.ts` rendered output, **without** the `<!-- dab-skill: ... -->` marker line. Keep YAML frontmatter and all sections. They are the only template source.

- [x] **Step 2: Write failing loader/render tests**

`test/init/skill-templates.test.ts`:

```ts
it('loads each canonical skill from the package skills directory', async () => {
  for (const name of AUTHORING_SKILL_NAMES) {
    const text = await loadAuthoringSkillTemplate(name);
    expect(text).toContain(`name: ${name}`);
    expect(text).not.toContain('<!-- dab-skill:');
  }
});

it('renders a marker with version and a stable sha256', async () => {
  const text = await renderAuthoringSkill('dab-doc-writing', '9.9.9');
  expect(text).toContain('<!-- dab-skill: dab-doc-writing@9.9.9 sha256=');
  const body = stripMarker(text);
  expect(hashSkillBody(body)).toBe(hashSkillBody(await loadAuthoringSkillTemplate('dab-doc-writing')));
});
```

- [x] **Step 3: Run tests to verify RED**

Run: `pnpm vitest run test/init/skill-templates.test.ts test/init/practice-authoring.test.ts`

Expected: FAIL because `skill-templates.ts`/async renderer do not exist, and current renderer has no hash.

- [x] **Step 4: Implement loader and marker/hash helper**

`src/init/skill-templates.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function loadAuthoringSkillTemplate(name: AuthoringSkillName): Promise<string> {
  return readFile(join(PACKAGE_ROOT, 'skills', name, 'SKILL.md'), 'utf8');
}
```

From both `src/init/` and `dist/init/`, `../..` resolves to the package root. Use a shared marker regex/helpers in a module accessible to both init and detect (or export from `skill-templates.ts`).

Marker insertion: after the frontmatter closing `---` line, insert one line:

```html
<!-- dab-skill: <name>@<version> sha256=<hex> -->
```

Hash: remove the marker line from the rendered text, then SHA-256 the remaining UTF-8 text exactly as the template file. At render, compute hash from the template file text; at check, remove marker and hash the same text.

- [x] **Step 5: Update `practice-authoring.ts`**

Replace `SKILL_CONTENT`/`SHARED_*` inline strings with the loader. `renderAuthoringSkill` becomes async; `authoringPack.files` awaits it. Update tests to await render.

- [x] **Step 6: Package and path tests**

Add `"skills"` to `package.json` `files`. Add a test that reads package.json and asserts `files` includes `skills`, and that the three canonical files exist. Keep the existing pack test/CI.

- [x] **Step 7: Run focused tests, typecheck, and commit**

Run: `pnpm vitest run test/init/skill-templates.test.ts test/init/practice-authoring.test.ts && pnpm typecheck`

```bash
git add skills src/init/skill-templates.ts src/init/practice-authoring.ts package.json test/init/skill-templates.test.ts test/init/practice-authoring.test.ts
git commit -m "feat: load authoring skills from packaged templates"
```

---

### Task 2: Managed skill state and update algorithm

**Files:**
- Create: `src/init/managed-skills.ts`
- Test: `test/init/managed-skills.test.ts`

**Interfaces:**
- Produces:

```ts
export type ManagedSkillStatus =
  | 'current' | 'stale' | 'newer' | 'modified' | 'legacy' | 'unversioned' | 'missing';

export interface ManagedSkillState {
  name: AuthoringSkillName;
  file: string;
  status: ManagedSkillStatus;
  version?: string;
  hash?: string;
}

export interface ManagedSkillPlan {
  states: ManagedSkillState[];
  writes: Array<{ name; file; content }>;
  diagnostics: Diagnostic[];
}

export async function planManagedSkills(input: {
  root: string;
  version: string;
  names?: readonly AuthoringSkillName[];
}): Promise<ManagedSkillPlan>;

export async function applyManagedSkillWrites(
  root: string,
  plan: ManagedSkillPlan,
  options: { dryRun: boolean },
): Promise<{ created: string[]; updated: string[]; migrated: string[]; skipped: string[] }>;
```

- [x] **Step 1: Write failing state tests**

Cover real temp dirs and real canonical templates:
- missing → `missing`.
- current template rendered by `renderAuthoringSkill` → `current`.
- older version with matching hash → `stale`.
- body edited (marker left) → `modified`.
- legacy marker without hash + body equal to current template → `legacy` with migration allowed (plan writes).
- legacy marker without hash + differing body → `legacy` with no write.
- no marker → `unversioned` with no write.
- plan does not write; apply dry-run writes nothing; apply real writes atomic.

Use small helper to write skill files; do not mock hashing.

- [x] **Step 2: Run tests to verify RED**

Run: `pnpm vitest run test/init/managed-skills.test.ts`

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement plan/apply**

Rules:
- Read canonical template and render current candidate with current version.
- Read target if present; parse marker with optional `sha256`.
- current: hash matches and version equals current.
- stale: hash matches and installed version is strictly older than current.
- newer: hash matches and installed version is newer or unparseable; preserve with non-strict warning, no write.
- modified: hash differs.
- legacy: marker exists without hash; compare marker-stripped body to current template; migration allowed only on exact match.
- unversioned: no marker.
- writes only for `missing`, `stale` and migratable legacy; `modified`/unversioned/non-migratable legacy are diagnostics only.
- Use atomic file replacement for managed writes (write temp in same dir then rename, or existing fs-atomic helper); never write on dry-run.
- Modified/legacy diagnostics are warnings; do not throw.

- [x] **Step 4: Run focused tests and typecheck**

Run: `pnpm vitest run test/init/managed-skills.test.ts && pnpm typecheck`

- [x] **Step 5: Commit**

```bash
git add src/init/managed-skills.ts test/init/managed-skills.test.ts
git commit -m "feat: manage skill versions with marker hashes"
```

---

### Task 3: Normalize integration

**Files:**
- Modify: `src/init/adoption.ts`
- Modify: `src/commands/normalize.ts`
- Test: `test/commands/normalize-adoption.test.ts`
- Test: `test/commands/normalize.test.ts`

**Interfaces:**
- `NormalizePracticesResult.skills` gains additive `updated`, `migrated`, `modified`, `legacy`, `unversioned` arrays (or equivalent documented fields).
- Normalize actions include `create skill`, `update skill`, `migrate skill`, `skip skill (modified|legacy|unversioned)`.

- [x] **Step 1: Write failing normalize tests**

- Initialized project with an old unmodified skill → normalize updates file + marker/hash; dry-run shows update and writes nothing.
- Modified skill → normalize leaves bytes unchanged, reports `skill.modified`, still completes other writes/targets.
- Legacy unmodified body → migrates marker/hash.
- Legacy modified body → preserved, warning.
- Missing skill → created with current marker/hash.
- Global scope does not run managed skills.
- JSON `practices.skills` fields and human actions are stable.

- [x] **Step 2: Run tests to verify RED**

Run: `pnpm vitest run test/commands/normalize-adoption.test.ts test/commands/normalize.test.ts`

- [x] **Step 3: Integrate before target planning**

In `prepareNormalizeAdoption` or the initialized/converge path:
- Call `planManagedSkills` for project scope after the practice source preflight, before target planning.
- Apply writes with the practice source phase (after all blocking preflight), before target plan.
- Store actions/diagnostics in `NormalizeResult.practices`.
- Preserve all-or-nothing: path/read errors block; modified/legacy warnings do not. Dry-run uses the plan and writes nothing.
- `init` must not update existing skills; only normalize.

- [x] **Step 4: Run focused tests, full suite, typecheck**

Run: `pnpm vitest run test/commands/normalize-adoption.test.ts test/commands/normalize.test.ts && pnpm test && pnpm typecheck`

- [x] **Step 5: Commit**

```bash
git add src/init/adoption.ts src/commands/normalize.ts test/commands/normalize-adoption.test.ts test/commands/normalize.test.ts
git commit -m "feat: update managed skills during normalize"
```

---

### Task 4: Detect state reporting

**Files:**
- Modify: `src/detect/practice.ts`
- Modify: `src/commands/detect.ts` (only if entry mapping needs it)
- Test: `test/detect/practice.test.ts`
- Test: `test/commands/detect-preflight.test.ts`
- Test: `test/commands/detect.test.ts`
- Test: `test/detect/checklist.test.ts` (if group rows change)

**Interfaces:**
- Add diagnostics: `practice.skill-modified`, `practice.skill-legacy`, `practice.skill-newer`, `practice.skill-marker-mismatch` as non-strict warnings.
- Keep `practice.skill-stale` strict; `practice.skill-unversioned` non-strict; `practice.skill-missing` strict.
- States: current `ok`; stale `warn` + `dab normalize`; newer `warn` no auto-next; modified `warn` no auto-next; legacy/unversioned/marker-mismatch `warn` no auto-next.

- [x] **Step 1: Write failing detect tests**

- current marker/hash → OK.
- older version matching hash → stale warning, `--strict` exit 3, next normalize.
- newer/unparseable version matching hash → newer warning non-strict, no write/next.
- modified body → warn non-strict, no normalize next, file preserved.
- legacy without hash and old body → warn non-strict.
- unversioned / marker naming another skill → warn non-strict.
- duplicate rows collapse; exit codes unchanged.

- [x] **Step 2: Run tests to verify RED**

Run: `pnpm vitest run test/detect/practice.test.ts test/commands/detect-preflight.test.ts test/commands/detect.test.ts`

- [x] **Step 3: Implement using shared marker/hash helpers**

Do not duplicate the hash algorithm in detect. Reuse the helper from `managed-skills.ts`/`skill-templates.ts`. Update `PRACTICE_NON_STRICT_WARNING_CODES` for modified/legacy. Keep checklist entry dedupe.

- [x] **Step 4: Run focused tests, full suite, typecheck, doc-sync if docs changed**

Run: `pnpm vitest run test/detect/practice.test.ts test/commands/detect-preflight.test.ts test/commands/detect.test.ts && pnpm test && pnpm typecheck`

- [x] **Step 5: Commit**

```bash
git add src/detect/practice.ts src/commands/detect.ts test/detect/practice.test.ts test/commands/detect-preflight.test.ts test/commands/detect.test.ts
git commit -m "feat: report managed skill states in detect"
```

---

### Task 5: Dogfood migration and docs

**Files:**
- Modify: `.agents/skills/dab-doc-writing/SKILL.md`
- Modify: `.agents/skills/dab-architecture-writing/SKILL.md`
- Modify: `.agents/skills/dab-decision-notes/SKILL.md`
- Modify: `dab.yaml` (generated skill hashes/projections)
- Modify: `docs/AGENTS.md`, `docs/architecture.md`/zh/i18n, `docs/user/cli.md`/zh/i18n, `docs/user/claude-code.md`/zh/i18n, README/zh/i18n, roadmap/zh/i18n, CHANGELOG/zh, Practice Layer Agent Note/zh/i18n.

- [x] **Step 1: Run new normalize on DAB**

After Tasks 1-4, run `pnpm build && node dist/cli.js normalize`. Legacy DAB skills (marker 0.1.1 without hash) should migrate only if their body matches the new canonical template; otherwise preserve and report. Verify `detect --strict` remains 19/19 or describe any expected state changes.

- [x] **Step 2: Update docs**

Describe:
- canonical `skills/` source and packaged templates;
- marker version/hash;
- managed update: unmodified updates, modified/legacy preserved, no automatic user-fork updates;
- no `npx skills` runtime;
- detect states and strictness, including newer/marker-mismatch and CRLF legacy preservation;
- release 0.1.2 behavior.
Update EN/ZH pairs/i18n; run pairing writer and doc-sync.

- [x] **Step 3: Verify and commit**

Run:

```bash
pnpm test
pnpm typecheck
pnpm doc-sync
pnpm build
node dist/cli.js detect --strict
node dist/cli.js normalize --dry-run
git diff --check
```

Commit `docs: document managed skills and release 0.1.2`.

---

### Task 6: Release preparation 0.1.2

**Files:**
- Modify: `package.json` version to `0.1.2`
- Modify: `CHANGELOG.md`/zh (move Unreleased under `0.1.2 — 2026-11-24`)
- Modify: `README.md`/zh, `docs/roadmap.md`/zh (release status/links)
- Refresh `.agents/skills/dab-*` markers via normalize; `dab.yaml` hashes
- Create/modify release Agent Note if required by repo process

- [x] **Step 1: Bump version and refresh dogfood skills**

Set `package.json` version `0.1.2`; build; run normalize so the three dogfood skills update to `@0.1.2` with new hashes; verify `detect --strict` and normalize dry-run.

- [x] **Step 2: Update changelog and release docs**

Move Unreleased items to `0.1.2 — 2026-11-24`; update README/roadmap release links/status; EN/ZH and i18n.

- [x] **Step 3: Run release gates**

```bash
pnpm test
pnpm typecheck
pnpm doc-sync
pnpm build
node dist/cli.js detect --strict
node dist/cli.js normalize --dry-run
git diff --check
```

- [x] **Step 4: Commit release prep**

```bash
git add package.json CHANGELOG.md CHANGELOG.zh.md README.md README.zh.md README.i18n.yaml docs/roadmap.md docs/roadmap.zh.md docs/roadmap.i18n.yaml .agents/skills/dab-* dab.yaml
git commit -m "release: prepare 0.1.2"
```

Tagging/publishing is a separate human-approved step after the release PR merges; do not tag or publish in this task.
