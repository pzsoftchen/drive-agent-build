English | [中文](why-dab.zh.md)

# Why DAB exists

Stronger models and better harnesses do not produce reliable delivery on their own. They increase what an agent can do, but they do not define what should be built, how the work should converge, or what evidence makes the result acceptable.

DAB is the long-term direction: driving agents as Builders. The current development-specific path is DAD (Drive Agent Development). This page explains the problems DAB addresses, where it sits, and how the DAD task loop and the DAB goal loop relate. Capability gates and release status live in [Roadmap](../roadmap.md).

## The four problems DAB addresses

DAB starts from four concrete failures. They are ordered: the first two make an agent drivable; the third makes one development task completable; the fourth addresses larger goals.

### Configuration drift and cross-agent interference

The same project fact is often duplicated across harness configuration. Copies drift, generated files are edited by hand, and target-specific settings leak into shared instructions. Agents that read another agent's configuration then inherit semantics that were never meant for them.

DAB's answer is one authored source (`AGENTS.md` and `.agents/`), explicit per-target projections, ownership records and drift detection. Target-specific policy lives in adapter overlays; shared instructions stay target-neutral.

### Engineering discipline that is not enforceable

Project discipline often lives in prompts and conversations. Tests-first, documentation, decision records, least privilege and fail-loud behavior are wishes rather than configuration. A new agent or a new session cannot reproduce them.

DAB's answer is to make the discipline part of the authored source and the projected configuration. Rules that can be checked become gates; the rest are explicitly labeled behavioral rules. The model is in [Engineering discipline](engineering-discipline.md).

### Single-task delivery that is not measured

An agent can keep acting without producing an accepted result. Acceptance is often conversational, with no baseline, no fixed task set and no record of interventions, cost or scope violations.

DAB's answer is task evidence: a fixed task suite, deterministic tests, stable harness events and a baseline comparison. This is the DAD task loop, not the DAB goal loop.

### Goal-level delivery that has no model

A larger goal requires decomposition, task coordination, integration, overall acceptance and cross-task learning. None of these is defined by a single-task loop.

DAB treats goal-level delivery as research. It starts only when real DAD use produces recurring goal-level failures that the task loop cannot solve.

## Where DAB sits

DAB is conceptually a driving system above the harness. This repository implements its control plane. DAB does not replace the model, implement the agent loop or become another runtime.

- The Builder is the person accountable for intent, constraints, judgment and acceptance.
- The Agent is the execution actor doing building work inside the harness.
- DAB turns those decisions and project facts into governed harness configuration.
- The harness executes the work with a model and project tools.
- Project evidence returns to DAB to drive the next decision.
- Only accepted work leaves the loop as a deliverable.

The boundary matters. If DAB becomes a runtime, it competes with every harness and loses the cross-agent value of a common source. DAB governs configuration and convergence; the harness executes.

## DAD and DAB

DAB is the long-term direction and product name. DAD is the current development-specific path within it. The `dab` command is the CLI that implements that path.

| Level | Question | Scope |
|---|---|---|
| DAD task loop | Is one development task complete and accepted? | One development task. |
| DAB goal loop | Do multiple tasks integrate into an accepted goal? | Multiple tasks and their integration. |

DAD is not merely a predecessor. It is the part of DAB that is currently being built and measured. DAB begins when multiple tasks must converge into a larger goal.

## Delivery levels

The levels are nested. [How DAB fits](../../README.md#how-dab-fits) shows the diagram.

The harness loop answers "what should the agent do next?" The DAD task loop asks whether one development task is complete. The DAB goal loop, once researched, would ask whether all required tasks and integrations form an accepted delivery.

Task completion is recorded as evidence. Cross-task learning is a separate improvement loop and must not block every atomic task with a full retrospective.

## Delivery convergence

An agent must not be considered autonomous merely because it keeps taking actions. Convergence needs explicit controls:

- a definition of done;
- deterministic checks and review evidence;
- limits on time, attempts, cost and scope;
- a recovery strategy when checks fail;
- a stop condition when the agent cannot progress;
- human escalation for decisions outside its authority.

DAB's role is to make those controls part of the project configuration instead of leaving them in a conversation.

## What DAB is not

- DAB is not a model.
- DAB is not an agent runtime or a replacement harness.
- DAB is not a prompt collection.
- DAB is not an infinite autonomous loop.
- DAB is not a guarantee that generated work is correct without evidence.

## How DAD and DAB are judged

The concept is useful only if it improves delivery. DAD is judged on accepted outcomes on the first attempt, human interventions and rework, time and cost to acceptance, scope violations and failed gates, and reuse of reviewed project knowledge.

DAB research is not triggered by finishing DAD. It starts only when real DAD use exposes recurring failures at goal decomposition, cross-task integration, overall acceptance or cross-task learning. The evidence gates are in [Roadmap](../roadmap.md).
