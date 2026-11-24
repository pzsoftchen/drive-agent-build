English | [中文](README.zh.md)

# DAB — Drive Agent as Builder

DAB is the long-term direction: driving agents as Builders. The current implementation path is DAD (Drive Agent Development): making agents reliably drivable through governed project configuration, then proving that a single development task can be completed and accepted.

## How DAB fits

The working model is `Agent = Model + Harness`. DAB is not a third term in that equation; it drives how the harness is configured and how the resulting work converges into a deliverable.

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
- DAB is conceptually a driving system; this repository implements its control plane.
- The Harness is the execution engine: loop, tools, context, permissions and sessions.

### Nested loops

- The harness loop handles local execution: `think -> act -> observe -> continue`.
- The DAD task loop drives one development task to completion and acceptance evidence.
- The DAB goal loop is a research direction for decomposing and integrating multiple tasks into one accepted goal.

Single-task closure belongs to DAD. DAB begins when multiple tasks must converge into a larger goal.

[Read the full conceptual model](docs/concepts/why-dab.md).

## Current status

The diagram describes the combined target model. The DAD configuration-governance foundation is released as `@saydone/dab@0.1.1`. Single-task evidence is next; DAB is not yet scheduled.

| Capability | Status |
|---|---|
| DAD authored facts, projections, drift checks and policy explanation | Released in 0.1.1 |
| DAD independent project/global scopes and v2 manifests | Released in 0.1.1 |
| DAD practice layer: generic profile, single-language docs and authoring skills | Implemented; unreleased |
| DAD advanced hooks and shared memory | Optional; not scaffolded by default |
| DAD evidence for one development task | Planned for v0.2; next |
| DAD memory and operational hardening | Planned for v0.3 |
| DAD Codex and DSH adapters | After single-task evidence |
| DAB goal decomposition and cross-task convergence | Research; gated by DAD evidence |

Release: [npm](https://www.npmjs.com/package/@saydone/dab) · [GitHub Release v0.1.1](https://github.com/pzsoftchen/drive-agent-build/releases/tag/v0.1.1)

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
- `dab normalize` compiles policy, materializes instruction and projection artifacts, fills missing docs and authoring skills, and records hashes.
- `dab detect` checks authored facts, generated output, ownership and scope without writing.
- `dab policy explain` shows the effective rules and hooks for a selected target.

The generic profile focuses on configuration drift and the documentation, notes and skills discipline. Hooks and shared memory stay advanced and opt-in: existing authored files remain supported and managed.

## Why DAB exists

I started DAB from a change in where leverage lives. As agents take on more execution, I believe the Builder's advantage moves from completing every step by hand to designing the conditions under which agents can build reliably.

Two observations shaped my thinking:

- A DeepSeek operator developer described a likely shift from designing, writing and optimizing operators to driving agents that perform that work.
- Robin Li's Builder framing broadens the creator role beyond people who write code.

I first explored a narrower practice, DAD (Drive Agent Development): defining how agents should carry out development work and driving them through that process. DAB keeps DAD's authored facts, projections, drift detection and decisions, plus optional shared memory, then adds the delivery-oriented convergence described above. Development is the first scope because I am the first Builder, not because it is the endpoint.

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
- [Roadmap](docs/roadmap.md)
- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [CLI](docs/user/cli.md)
- [Claude Code integration](docs/user/claude-code.md)
- [Agent Note 0001](.agents/notes/implemented/architecture/2026-11-16-agents-source-tree.md)
- [Agent Note 0002](.agents/notes/implemented/architecture/2026-11-16-claude-md-compat-shim.md)
- [Agent Note 0003](.agents/notes/implemented/architecture/2026-11-23-practice-layer.md)

## License

MIT.
