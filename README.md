English | [中文](README.zh.md)

# DAB — Drive Agent as Builder

DAB is the long-term direction: driving agents as Builders. The current implementation path is DAD (Drive Agent Development): making agents reliably drivable through governed project configuration, then proving that a single development task can be completed and accepted.

## How DAB fits

The working model is `Agent = Model + Harness`. DAB is not a third term in that equation; it is the control plane that configures the harness and governs how the resulting work converges into a deliverable.

```text
                         Builder
             intent / constraints / acceptance
                              |
                              v
+------------------- DAB direction (research) --------------+
| Goal loop                                                |
| Frame goal -> Decompose -> Integrate -> Accept -> Learn  |
|                              |                           |
|                              v                           |
| DAD path (current)                                       |
| facts / roles / tools / permissions / verification       |
| Task loop: Frame -> Drive -> Inspect -> Recover          |
|                           accepted -> Complete Task       |
+------------------------------+---------------------------+
                               | configures + directs
                               v
                 Harness loop: think -> act -> observe
                               |
                               v
                         Model + Project
                               | evidence
                               +--------------> DAD / DAB
```

The actors have distinct responsibilities:

- A Builder is the person accountable for intent, constraints, judgment and acceptance.
- An Agent is the execution actor that performs building work inside the harness.
- DAB is the control plane; this repository implements it.
- The Harness is the execution engine: loop, tools, context, permissions and sessions.

### Nested loops

- The harness loop handles local execution: `think -> act -> observe -> continue`.
- The DAD task loop drives one development task to completion and acceptance evidence.
- The DAB goal loop is a research direction for decomposing and integrating multiple tasks into one accepted goal.

Single-task closure belongs to DAD; DAB begins when multiple tasks must converge into a larger goal.

DAB does not replace the model, implement the agent loop or become another runtime. The full model is in [Why DAB exists](docs/concepts/why-dab.md).

## The problems DAB addresses

DAB exists because agent capability and project configuration alone do not produce reliable delivery. It addresses four problems in order:

1. Configuration drift and cross-agent interference: the same fact is duplicated across targets, generated configuration is edited by hand, and target-specific semantics leak into shared instructions.
2. Engineering discipline that is not enforceable: practices live in prompts and conversations instead of configuration and checks.
3. Single-task delivery that is not measured: agent activity is confused with accepted work, and acceptance is not reproducible.
4. Goal-level delivery that has no model: decomposition, integration, overall acceptance and cross-task learning are undefined.

The first two problems are the foundation; the third validates the development loop; the fourth is research. The detailed argument is in [Why DAB exists](docs/concepts/why-dab.md).

## The route at a glance

The route is a capability ladder. Versions are milestones, not the route itself.

| Layer | Question | Evidence gate |
|---|---|---|
| L1 Config governance and target isolation | Can authored facts be projected into each target without drift or cross-agent leakage? | `detect --strict`, idempotent `normalize`, foreign-edit detection, target-neutral shared instructions, cross-agent contract test. |
| L2 Engineering discipline | Are the project's rules explicit, enforceable where possible, and portable across targets? | Every rule has an enforcement level; gate rules have checks; target-specific rules live in adapter overlays. |
| L3 Single-task delivery | Can one development task be completed and accepted with reproducible evidence? | Fixed task suite, baseline comparison, stable harness events, recorded time/cost/interventions/scope violations. |
| L4 Goal-level delivery | Can multiple tasks be integrated into one accepted goal? | Recurring goal-level failures from L3 use, then a minimal goal-loop prototype. |

The evidence gates and release mapping are in [Roadmap](docs/roadmap.md).

## Current status

The Claude Code governance foundation and the practice layer are released in `0.1.2`. Capability and milestone status is tracked in [Roadmap](docs/roadmap.md).

## Quick start

Requirements: Node.js `>=24.9`, Claude Code `>=2.1.277`, macOS or Linux.

Run the CLI without installing:

```bash
npx @saydone/dab init /path/to/project
cd /path/to/project
npx @saydone/dab normalize --dry-run
npx @saydone/dab detect
```

Install globally to use the shorter `dab` command:

```bash
npm install -g @saydone/dab
dab --version
```

The npm package is `@saydone/dab`; `npx dab` resolves to a different package.

For source development:

```bash
pnpm install
pnpm build
pnpm link --global
```

Use `dab init ~/.agents` to initialize the independent global scope.

## What the commands do

- `dab init` writes the authored project skeleton, including `docs/AGENTS.md`, `docs/architecture.md` and the `dab-*` authoring skills, and runs normalize when it is safe. It does not scaffold advanced hooks or shared memory.
- `dab normalize` compiles policy, materializes instruction and projection artifacts, fills missing docs and authoring skills, updates unmodified older managed authoring skills, and records hashes.
- `dab detect` checks authored facts, generated output, ownership and scope without writing.
- `dab policy explain` shows the effective rules and hooks for a selected target.

The generic profile focuses on configuration drift and the documentation, notes and skills discipline. Hooks and shared memory stay advanced and opt-in: existing hooks are still validated and compiled where applicable, and existing memory is still preserved and validated.

## Design principles

- DAB is a control plane, not an agent runtime.
- The Builder retains intent, constraints, acceptance and judgment; agents execute.
- Harnesses are replaceable. Claude Code is the first target, not the definition of DAB.
- Knowledge that should survive a session belongs in reviewable files, not hidden prompts.
- Repeatability beats one-off prompting; authored facts and generated configuration must remain comparable.

## What DAB does not guarantee

- v0.1 is currently a single-developer, macOS and Linux, Claude Code-first implementation.
- It does not implement the DAB goal loop, a task graph, cross-task learning or automatic memory promotion.
- v0.2 will validate one development task at a time; it will not by itself prove DAB.
- Path deny rules are tool-level guardrails, not a sandbox.
- Hooks are trusted executable code; DAB checks metadata and static safety, not runtime behavior.
- Windows junctions, a GUI, a plugin marketplace and automatic DAD migration are out of scope.

## Documentation

Full documentation: [docs](https://github.com/pzsoftchen/drive-agent-build/tree/main/docs)

- [Documentation guide](docs/AGENTS.md)
- [Why DAB exists](docs/concepts/why-dab.md)
- [Engineering discipline](docs/concepts/engineering-discipline.md)
- [Roadmap](docs/roadmap.md)
- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [CLI](docs/user/cli.md)
- [Claude Code integration](docs/user/claude-code.md)
- [Superpowers docs](docs/superpowers/README.md)
- [Agent Note 0001](.agents/notes/implemented/architecture/2026-11-16-agents-source-tree.md)
- [Agent Note 0002](.agents/notes/implemented/architecture/2026-11-16-claude-md-compat-shim.md)
- [Agent Note 0003](.agents/notes/implemented/architecture/2026-11-23-practice-layer.md)
- [Agent Note 0004](.agents/notes/implemented/architecture/2026-11-24-managed-skills.md)
- [Agent Note 0005](.agents/notes/implemented/process/2026-11-24-route-and-discipline-docs.md)

## License

MIT.
