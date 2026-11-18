English | [中文](README.zh.md)

# DAB — Drive Agent as Builder

DAB is a scope-aware control plane for Builders who use agents to produce durable work. Project and global scopes are configured independently. The first implementation is developer-first and targets Claude Code.

## How DAB fits

The working model is `Agent = Model + Harness`. DAB is not a third term in that equation; it drives how the harness is configured and how the resulting work converges into a deliverable.

```text
                         Builder
             intent / constraints / acceptance
                              |
                              v
+------------------- DAB driving system -------------------+
| DAD foundation                                           |
| facts / roles / tools / permissions / verification       |
|                                                          |
| Builder delivery loop                                    |
| Frame -> Drive -> Inspect --accepted--> Deliver -> Learn |
|            ^          |                                  |
|            |          +--failed--> Recover               |
|            +-------------------------+                    |
+------------------------------+---------------------------+
                               | configures + directs
                               v
                 Harness: loop / tools / context
                               |
                               v
                         Model + Project
                               | evidence
                               +--------------> DAB
```

The actors have distinct responsibilities:

- A Builder is the person accountable for intent, constraints, judgment and acceptance.
- An Agent is the execution actor that performs building work inside the harness.
- DAB is conceptually a driving system; this repository implements its control plane.
- The Harness is the execution engine: loop, tools, context, permissions and sessions.

### Two loops

- The harness loop handles local execution: `think -> act -> observe -> continue`.
- The DAB delivery loop governs the outcome: `frame -> drive -> inspect -> recover -> deliver -> learn`.
- The harness decides what to do next; DAB decides whether the work is converging toward acceptance.

[Read the full conceptual model](docs/concepts/why-dab.md).

## Current status

The diagram describes the target DAB model. The current `main` branch implements its configuration-governance foundation; the evidence-driven delivery loop is not complete.

| Capability | Status |
|---|---|
| Authored project facts and deterministic Claude Code projections | Implemented |
| Drift detection and effective-policy explanation | Implemented |
| Independent project and global scopes with v2 manifests | Implemented on `main`; pending release |
| Codex and DSH adapters | Planned after the Claude Code target |
| Run records and delivery-loop evaluation | Planned for v0.2 |
| Shared-memory promotion | Planned for v0.3 |

## Quick start

Requirements: Node.js `>=24.9`, pnpm, Claude Code `>=2.1.277`, macOS or Linux.

```bash
pnpm install
pnpm build
pnpm link --global
dab init /path/to/project
cd /path/to/project
dab normalize --dry-run
dab detect
```

Use `dab init ~/.agents` to initialize the independent global scope.

## What the commands do

- `dab init` writes the authored project skeleton and runs normalize when it is safe.
- `dab normalize` compiles policy, materializes instruction and projection artifacts, and records hashes.
- `dab detect` checks authored facts, generated output, ownership and scope without writing.
- `dab policy explain` shows the effective rules and hooks for a selected target.

## Why DAB exists

I started DAB from a change in where leverage lives. As agents take on more execution, I believe the Builder's advantage moves from completing every step by hand to designing the conditions under which agents can build reliably.

Two observations shaped my thinking:

- A DeepSeek operator developer described a likely shift from designing, writing and optimizing operators to driving agents that perform that work.
- Robin Li's Builder framing broadens the creator role beyond people who write code.

I first explored a narrower practice, DAD (Drive Agent Development): defining how agents should carry out development work and driving them through that process. DAB keeps DAD's authored facts, projections, drift detection, decisions and shared memory, then adds the delivery-oriented convergence described above. Development is the first scope because I am the first Builder, not because it is the endpoint.

## Design principles

- DAB is a control plane, not an agent runtime.
- The Builder retains intent, constraints, acceptance and judgment; agents execute.
- Harnesses are replaceable. Claude Code is the first target, not the definition of DAB.
- Knowledge that should survive a session belongs in reviewable files, not hidden prompts.
- Repeatability beats one-off prompting; authored facts and generated configuration must remain comparable.

## What DAB does not guarantee

- v0.1 is currently a single-developer, macOS and Linux, Claude Code-first implementation.
- It does not yet run its own delivery loop, compare configurations or promote memory automatically.
- Path deny rules are tool-level guardrails, not a sandbox.
- Hooks are trusted executable code; DAB checks metadata and static safety, not runtime behavior.
- Windows junctions, a GUI, a plugin marketplace and automatic DAD migration are out of scope.

## Documentation

- [Why DAB exists](docs/concepts/why-dab.md)
- [Roadmap](docs/roadmap.md)
- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [CLI](docs/user/cli.md)
- [Claude Code integration](docs/user/claude-code.md)
- [Agent Note 0001](.agents/notes/implemented/architecture/2026-11-16-agents-source-tree.md)
- [Agent Note 0002](.agents/notes/implemented/architecture/2026-11-16-claude-md-compat-shim.md)

## License

MIT.
