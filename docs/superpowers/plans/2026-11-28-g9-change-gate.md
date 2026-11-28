# G9 同变更门禁实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 G1 的 gate runner 中加入可选的 `change` 维度，按 git diff 检查 code 变更是否伴随 tests/docs/notes，并保持 advisory-first、无新命令、旧配置兼容。

**Architecture:** `.agents/gates.yaml` 新增可选 `change` 配置；`normalize` 只在缺失配置时生成 starter；snapshot 解析并携带已解析的 change 配置；稳定 `scripts/dab-check.mjs` 读取 git diff、分类路径、执行 change gate。`dab detect` 只检查 change 配置，不执行 diff。没有 `change` 的旧配置/旧快照等价于 off。

**Tech Stack:** TypeScript ESM、Node >=24.9、Zod、YAML、Vitest、`node:child_process`、`node:path.matchesGlob`；不新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-11-27-g9-change-gate-design.md`

## Global Constraints

- `change` 可选；缺少时等价于 `off`，旧配置和旧 snapshot 保持有效。
- starter 默认写入 `change: { mode: advisory, checks: [tests, docs], base: origin/main }`；不覆盖已有 `.agents/gates.yaml`。
- 默认不检查 notes；项目显式加入 `checks: [..., notes]`。
- 只做路径级分类，不读文件内容、不做 AST、不判断代码正确性或文档质量。
- 默认 advisory；`required`、`check`、`off` 由项目显式配置。
- `required` 缺失耦合失败 exit `1`；`check`/`advisory` 为 WARN，`--strict` 可提升；`CONFIG` 始终 exit `2`。
- 不新增 `dab` 命令，不自动生成 CI workflow，不 fetch，不访问网络。
- diff 只使用只读 git 命令；base 不可解析、git 不可用、配置无效是 `CONFIG`，不是 pass。
- 路径分类优先级：ignore → tests → docs → notes → code → other。
- 现有 G1 `source` gate 仍是不可绕过且 required。
- 生成物继续由 normalize 管理；modified/unversioned/newer runner/snapshot 保留并 warning。
- 文档、Agent Note、dogfood 和 EN/ZH/i18n 在同一次变更中更新。

## Review Focus

- code-only 变更缺 tests/docs 是否输出 WARN，required 是否失败，advisory 是否不阻断。
- docs-only、tests-only、generated-only 是否不会误触发 code 耦合。
- tests 路径是否优先于 code；`.agents/notes/**` 是否不会被误分类为 code。
- base 不可用/无 git 是否 `CONFIG` + exit 2，而不是 pass。
- 旧配置/旧 snapshot 是否无需迁移即可运行。
- `dab detect` 是否只检查配置、不执行 diff。
- runner 是否仍无内嵌项目命令，且 source/code/docs/change 全量运行不短路。

---

### Task 1: Gate config schema and starter

**Files:**
- Modify: `src/model/gates.ts`
- Modify: `src/init/gate-templates.ts`
- Test: `test/model/gates.test.ts`
- Test: `test/init/gate-templates.test.ts`

**Interfaces:**
- Produce:

```ts
export const GATE_CHANGE_CHECKS = ['tests', 'docs', 'notes'] as const;
export type GateChangeCheck = (typeof GATE_CHANGE_CHECKS)[number];

export interface AuthoredGateChangeConfig {
  mode: GateMode;
  checks?: GateChangeCheck[];
  base?: string;
  paths?: Partial<Record<GateChangeCheck | 'code', string[]>>;
  ignore?: string[];
}

// GateConfig.gates:
change?: AuthoredGateChangeConfig;
```

- `GateChangeConfigSchema` is strict; `checks` defaults to `['tests','docs']`; `base` defaults `origin/main`; arrays must be non-empty when present.
- If `mode === 'off'`, empty `checks` is allowed; otherwise at least one check.
- `renderGateStarter(scan)` adds:
  ```yaml
  change:
    mode: advisory
    checks: [tests, docs]
    base: origin/main
  ```
  Paths/ignore are omitted and resolved from defaults. If `scan.sourceDirs` is non-empty, the starter may include those source directories under `paths.code`; manually authored change configs without paths use the static defaults.

- [ ] **Step 1: Write failing schema/starter tests**

```ts
it('accepts a config without change', ...);
it('accepts change with default checks and base', ...);
it('rejects empty checks when change is not off', ...);
it('allows empty checks when change is off', ...);
it('rejects unknown change keys and blank base', ...);
it('starter includes advisory tests/docs change', ...);
it('starter does not overwrite an existing change config', ...); // through normalize/starter boundary where applicable
```

- [ ] **Step 2: Run focused tests to verify RED**

Run: `pnpm vitest run test/model/gates.test.ts test/init/gate-templates.test.ts`
Expected: FAIL because `change` schema/starter do not exist.

- [ ] **Step 3: Implement schema and starter**

Add `change` to the strict `GateConfigSchema`; do not change `version: 1`. Update `GateConfig` types and `renderGateStarter`. Keep YAML deterministic.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm vitest run test/model/gates.test.ts test/init/gate-templates.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/gates.ts src/init/gate-templates.ts test/model/gates.test.ts test/init/gate-templates.test.ts
git commit -m "feat: add optional change gate config"
```

---

### Task 2: Change path classification and git diff collection

**Files:**
- Create: `src/core/change-gate.ts`
- Test: `test/core/change-gate.test.ts`

**Interfaces:**
- Produce:

```ts
export const DEFAULT_CHANGE_PATHS = {
  code: ['src/**', 'app/**', 'lib/**', 'packages/**', 'cmd/**', 'server/**'],
  tests: [
    'test/**', 'tests/**', '__tests__/**', '**/*.test.*', '**/*.spec.*',
    'src/test/**', 'app/src/test/**', 'androidTest/**',
  ],
  docs: ['docs/**', 'README*', 'CHANGELOG*', 'AGENTS.md', 'CONTRIBUTING*'],
  notes: ['.agents/notes/**'],
} as const;

export const DEFAULT_CHANGE_IGNORE = [
  '.claude/**', 'dist/**', 'build/**', 'node_modules/**',
  'scripts/dab-check.mjs', 'scripts/dab-gates.json',
  '.agents/skills/dab-*/**', 'dab.yaml', 'pnpm-lock.yaml',
  'package-lock.json', 'yarn.lock', 'bun.lockb',
] as const;

export interface ResolvedGateChangeConfig {
  mode: GateMode;
  checks: GateChangeCheck[];
  base: string;
  paths: { code: string[]; tests: string[]; docs: string[]; notes: string[] };
  ignore: string[];
}

export interface ChangePathSet {
  code: string[];
  tests: string[];
  docs: string[];
  notes: string[];
  ignored: string[];
  other: string[];
}

export interface ChangeFinding {
  check: GateChangeCheck;
  status: 'pass' | 'warn' | 'skip';
  message: string;
}

export function classifyChangePaths(
  paths: readonly string[],
  config: ResolvedGateChangeConfig,
): ChangePathSet;

export function evaluateChange(
  changes: ChangePathSet,
  config: ResolvedGateChangeConfig,
): ChangeFinding[];

export async function collectChangePaths(input: {
  root: string;
  config: ResolvedGateChangeConfig;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
}): Promise<{ paths: string[]; error?: string }>;
```

- Classification uses POSIX paths and `path.matchesGlob`; no new dependency.
- Diff collection:
  - base = `DAB_CHANGE_BASE` env > `config.base`.
  - `git merge-base <base> HEAD`; missing → error.
  - union `git diff --name-only --diff-filter=ACMR <base>...HEAD`, `--cached`, and unstaged.
  - dedupe and sort; strip CR.
- `evaluateChange`:
  - no code paths → all configured checks `skip`.
  - code changed and missing test/doc/note path → `warn`; multiple missing findings.
  - satisfied → `pass`.
- The core helper does not apply mode severity; the runner converts WARN to FAIL/WARN by mode.

- [ ] **Step 1: Write failing classification tests**

```ts
it('classifies test paths before code', ...);
it('classifies notes before code', ...);
it('ignores generated and dependency paths', ...);
it('counts docs-only changes without code', ...);
it('evaluates missing tests/docs/notes', ...);
it('skips checks when no code changed', ...);
it('uses configured path overrides and ignore', ...);
```

- [ ] **Step 2: Write failing diff tests**

Use a temp git repo and real commits:
- base commit + feature branch with code/test/docs changes;
- staged and unstaged files included;
- missing base returns an error;
- `DAB_CHANGE_BASE` overrides `config.base`;
- no git repo returns an error.

Run: `pnpm vitest run test/core/change-gate.test.ts`
Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement core change gate**

Implement defaults, glob classification, diff collection with `runCommand`, and evaluation. Fail loud with a string error; do not throw for expected git/config failures.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm vitest run test/core/change-gate.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/change-gate.ts test/core/change-gate.test.ts
git commit -m "feat: add change path classification and diff collection"
```

---

### Task 3: Snapshot and stable runner change gate

**Files:**
- Modify: `src/core/gate-artifacts.ts`
- Modify: `src/init/gate-runner-template.ts`
- Test: `test/core/gate-artifacts.test.ts`
- Test: `test/init/gate-runner.test.ts`
- Test: `test/init/gate-artifacts.test.ts`

**Interfaces:**
- `GateSnapshot.gates.change?: ResolvedGateChangeConfig`.
- `canonicalGateGates(config)` resolves:
  - checks default `['tests','docs']`;
  - base default `'origin/main'`;
  - paths default from `DEFAULT_CHANGE_PATHS`, overridden field-wise;
  - ignore default from `DEFAULT_CHANGE_IGNORE`, replaced by explicit config when present.
- Hash covers `change` when present.
- Old snapshots without `change` remain valid; runner treats absent as off.
- Runner:
  - parser accepts optional `change` and validates mode/checks/base/paths/ignore;
  - runs change after source/code/docs, no short-circuit;
  - computes diff via read-only git commands;
  - classification mirrors the core fixture matrix (shared test fixtures, not import);
  - `change` status:
    - no change config or `mode: off` → SKIP;
    - configured change with no code changes → PASS with `no code changes`;
    - missing checks → WARN; `mode: required` → FAIL;
    - git/base/parse error → CONFIG/exit 2;
  - `--strict` promotes WARN to exit 1;
  - JSON adds `change`.
- `applyGateArtifacts` unchanged except snapshot content/hash; managed update still preserves modified/newer.

- [ ] **Step 1: Write failing snapshot tests**

- canonical change defaults and hash stability;
- change paths/ignore override;
- old snapshot without change parses;
- invalid change snapshot rejected.

- [ ] **Step 2: Write failing runner tests**

Execute generated runner in temp git repos with fake DAB/commands:
- code-only → WARN;
- code + test → PASS;
- code + docs only when docs check configured → WARN/PASS accordingly;
- required missing → FAIL exit 1;
- advisory missing → WARN; `--strict` exit 1;
- docs-only/generated-only → PASS/SKIP;
- missing base → CONFIG exit 2;
- old snapshot no change → SKIP;
- JSON includes change.

- [ ] **Step 3: Run tests to verify RED**

Run: `pnpm vitest run test/core/gate-artifacts.test.ts test/init/gate-runner.test.ts test/init/gate-artifacts.test.ts`
Expected: FAIL because change is not in snapshot/runner.

- [ ] **Step 4: Implement snapshot/runner change support**

Update canonicalization, hash, parser, runner body and tests. Keep runner self-contained; do not embed project commands. Use the shared fixture cases to keep core and runner classification aligned.

- [ ] **Step 5: Run focused tests and full typecheck**

Run: `pnpm vitest run test/core/gate-artifacts.test.ts test/init/gate-runner.test.ts test/init/gate-artifacts.test.ts && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/gate-artifacts.ts src/init/gate-runner-template.ts test/core/gate-artifacts.test.ts test/init/gate-runner.test.ts test/init/gate-artifacts.test.ts
git commit -m "feat: run change gate in the project runner"
```

---

### Task 4: Detect and compatibility

**Files:**
- Modify: `src/detect/verification.ts`
- Test: `test/detect/verification.test.ts`
- Test: `test/commands/detect.test.ts`
- Test: `test/commands/normalize.test.ts` (only if starter/snapshot changes need assertions)

**Interfaces:**
- `Verification` group adds a `change` row:
  - absent config: `ok`/`SKIP: change gate off` (non-strict);
  - valid config: detail with `mode`, `checks`, `base`;
  - invalid config remains `verification.config-invalid` error.
- `inspectVerification` does not run git diff.
- Normalize does not add `change` to existing config; starter does.
- Old `.agents/gates.yaml` and `scripts/dab-gates.json` remain valid.

- [ ] **Step 1: Write failing detect tests**

```ts
it('reports change as SKIP when absent', ...);
it('reports change mode, checks and base', ...);
it('reports invalid change config as config-invalid', ...);
it('does not execute git diff during detect', ...);
it('keeps old snapshots/configs compatible', ...);
```

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm vitest run test/detect/verification.test.ts test/commands/detect.test.ts test/commands/normalize.test.ts`
Expected: FAIL because the change row is absent.

- [ ] **Step 3: Implement detect config row and compatibility**

Add `change` entry after command entries, before CI. Do not add a new diagnostic for missing change; it is explicitly optional. Keep one row per path/group.

- [ ] **Step 4: Run focused tests, full suite, typecheck**

Run: `pnpm vitest run test/detect/verification.test.ts test/commands/detect.test.ts test/commands/normalize.test.ts && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/detect/verification.ts test/detect/verification.test.ts test/commands/detect.test.ts test/commands/normalize.test.ts
git commit -m "feat: report change gate configuration in detect"
```

---

### Task 5: Docs, dogfood and end-to-end verification

**Files:**
- Modify: `.agents/gates.yaml`, `scripts/dab-check.mjs`, `scripts/dab-gates.json`, `dab.yaml`
- Modify: `AGENTS.md`
- Modify: `README.md`/zh/i18n
- Modify: `docs/user/cli.md`/zh/i18n
- Modify: `docs/user/gates.md`/zh/i18n
- Modify: `docs/architecture.md`/zh/i18n
- Modify: `docs/roadmap.md`/zh/i18n (G9 status if appropriate)
- Create: `.agents/notes/implemented/architecture/2026-11-28-g9-change-gate.md`, `.zh.md`, `.i18n.yaml`
- Modify: `docs/superpowers/specs/2026-11-27-g9-change-gate-design.md` status/link
- Modify: `docs/superpowers/plans/2026-11-28-g9-change-gate.md` after execution
- Modify: `docs/superpowers/plans/README.md`, `docs/superpowers/README.md`, gap register G9 status

- [ ] **Step 1: Document the change gate**

Document:

- optional `change` config and advisory default;
- `checks: [tests, docs]`, notes opt-in;
- `required`/`check`/`advisory`/`off` and exit behavior;
- path classification, ignore precedence, generated-only/docs-only behavior;
- git base resolution, `DAB_CHANGE_BASE`, CI `fetch-depth: 0`;
- detect only checks config; runner executes diff;
- no new command, no auto CI;
- old config/snapshot compatibility.

- [ ] **Step 2: Add Agent Note**

Create the note triplet covering problem, decision, alternatives (hard gate, PR checklist only, new command, GitHub-only, AST), consequences (advisory first, required opt-in, base failure, local/CI diff scope), verification and G1 relationship.

- [ ] **Step 3: Dogfood and status**

- Add `change` to DAB's `.agents/gates.yaml` as `mode: advisory`, `checks: [tests, docs]`, `base: origin/main`. Do not set `required`; the final G9 change includes tests and docs, so `node scripts/dab-check.mjs --strict` should pass, while future code-only changes surface a WARN.
- Run `pnpm build && node dist/cli.js normalize` to refresh runner/snapshot and `dab.yaml`.
- Mark design approved with plan link; plan implemented only after final gates; update plans/specs/gap indexes.

- [ ] **Step 4: Run end-to-end gates**

```bash
pnpm test
pnpm typecheck
pnpm doc-sync
pnpm build
node scripts/dab-check.mjs --strict
node dist/cli.js detect --strict
node dist/cli.js normalize --dry-run
git diff --check
```

Fixture smoke:

- temp git repo with a base commit;
- code-only change with change advisory → `WARN`;
- add a test → `PASS`;
- `mode: required` without test → exit `1`;
- missing base → `CONFIG` / exit `2`;
- old snapshot without change → `SKIP`.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md README.md README.zh.md README.i18n.yaml docs .agents scripts dab.yaml
git commit -m "docs: document the change gate"
```
