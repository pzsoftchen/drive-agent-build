English | [中文](why-dab.zh.md)

# Why DAB exists

DAB starts from a practical observation: stronger models and better agent runtimes do not automatically produce reliable delivery. They increase what an agent can do, but they do not define what should be built, how the work should converge, or what evidence makes the result acceptable.

> Status: this page describes the combined DAB/DAD direction. The current `main` branch implements the DAD configuration-governance foundation. v0.2 is limited to evidence for one development task at a time. DAB goal-level delivery remains research.

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

## Why I started DAB

I started DAB from a change in where leverage lives. As agents take on more execution, I believe the Builder's advantage moves from completing every step by hand to designing the conditions under which agents can build reliably.

Two observations shaped my thinking:

- A DeepSeek operator developer described a likely shift from designing, writing and optimizing operators to driving agents that perform that work.
- Robin Li's Builder framing broadens the creator role beyond people who write code.

I first explored a narrower practice, DAD (Drive Agent Development): defining how agents should carry out development work and driving them through that process. DAD showed me the value of an authored source, explicit projections, drift detection, decision records and shared memory. DAB keeps that engineering discipline but extends it beyond development-specific delivery.

## Agent capability is not delivery

The familiar model is:

```text
Agent = Model + Harness
```

The model supplies reasoning and generation. The harness supplies the execution loop, tools, context, permissions and sessions. Together they make agent work possible.

Delivery adds requirements that neither part owns by itself:

- A Builder must define the intended outcome and acceptance criteria.
- The agent must receive stable project facts, roles and boundaries.
- Execution must produce evidence, not only activity.
- Failed work must be diagnosed, recovered or escalated.
- The final result must cross an explicit delivery gate.

This is the gap DAB addresses.

## Where DAB sits

DAB is conceptually a driving system above the harness. This repository implements its control plane. DAB does not replace the model, implement the agent loop or become another runtime.

- The Builder is the person accountable for intent, constraints, judgment and acceptance.
- The Agent is the execution actor doing building work inside the harness.
- DAB turns those decisions and project facts into governed harness configuration.
- The harness executes the work with a model and project tools.
- Project evidence returns to DAB to drive the next decision.
- Only accepted work leaves the loop as a deliverable.

DAB therefore governs both direction and convergence. Its value is not that an agent can act, but that the work can be driven toward a result that is ready to hand over.

## DAD and DAB

DAD means Drive Agent Development. It defines how agents should carry out development work and how a person drives them through the project's rules, tools and verification.

DAB means Drive Agent as Builder. It would retain DAD's single-task closure, then add goal-level decomposition, task coordination, integration and overall acceptance.

> DAD makes an agent drivable and a task completable. DAB would make a multi-task goal deliverable.

Development is DAB's first scope because the first Builder is a developer. It is not the endpoint. The same driving model can later govern research, content, operations or other forms of building without changing the core logic.

## DAD before DAB

The roadmap deliberately separates two levels of delivery:

- A DAD task loop drives one development task through execution, evidence and acceptance.
- A DAB goal loop would decompose a larger goal into tasks, integrate their outputs and verify the combined result.

Single-task closure belongs to DAD. Passing one task does not prove the overall goal, but a goal cannot be accepted unless its contributing tasks pass and integrate correctly.

DAB should be explored only after DAD practice exposes recurring goal-level failures that a task loop cannot solve. No task graph, GoalRun or TaskRun model is committed yet.

## Delivery levels

The levels are nested:

```text
DAB goal loop (research)
Goal -> Decompose -> DAD task loops -> Integrate -> Accept -> Learn

DAD task loop (current path)
Frame -> Drive -> Inspect --accepted--> Complete
           ^          |
           |          +--failed--> Recover
           +-------------------------+

Harness loop
think -> act -> observe -> continue
```

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

## How to judge DAD and DAB

The concept is useful only if it improves delivery. First, v0.2 must show that DAD improves one development task while holding the model, harness, task and environment constant. It measures:

- accepted outcomes on the first attempt;
- human interventions and rework;
- time and cost to reach acceptance;
- scope violations and failed gates;
- reuse of reviewed project knowledge.

DAD succeeds when governed configuration and task evidence produce more reliable single-task outcomes than an otherwise identical agent setup.

DAB research begins only if real DAD use reveals recurring failures at goal decomposition, cross-task integration, overall acceptance or cross-task learning.
