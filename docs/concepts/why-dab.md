English | [中文](why-dab.zh.md)

# Why DAB exists

DAB starts from a practical observation: stronger models and better agent runtimes do not automatically produce reliable delivery. They increase what an agent can do, but they do not define what should be built, how the work should converge, or what evidence makes the result acceptable.

> Status: this page describes the target DAB model. The current `main` branch implements its configuration-governance foundation. Run records, delivery-loop evaluation and automatic recovery are planned for v0.2.

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

DAB means Drive Agent as Builder. It requires DAD's ability to make agents drivable, then adds a delivery-oriented loop that decides whether the work is complete.

> DAD makes an agent drivable. DAB makes the work deliverable.

Development is DAB's first scope because the first Builder is a developer. It is not the endpoint. The same driving model can later govern research, content, operations or other forms of building without changing the core logic.

## Two loops

There are two different loops:

- The harness loop coordinates thinking, tool calls and observations.
- The DAB delivery loop coordinates framing, execution, inspection, recovery and delivery.

The harness loop answers "what should the agent do next?" The DAB loop answers "is the work converging toward an acceptable result?"

The delivery loop branches on evidence:

```text
Frame -> Drive -> Inspect --accepted--> Deliver -> Learn
           ^          |
           |          +--failed--> Recover
           +-------------------------+
```

`Recover` means diagnose, revise the plan, adjust context or change the working configuration, then return to `Drive`. `Deliver` is allowed only when the acceptance gates pass or a human explicitly accepts the remaining risk. `Learn` records durable facts or decisions for the next cycle.

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

## How to judge DAB

The concept is useful only if it improves delivery. A meaningful comparison should hold the model, harness, task and environment constant, then measure:

- accepted outcomes on the first attempt;
- human interventions and rework;
- time and cost to reach acceptance;
- scope violations and failed gates;
- reuse of reviewed project knowledge.

DAB succeeds when governed direction and a delivery loop produce more reliable outcomes than an otherwise identical agent setup.

The planned v0.2 evidence phase is where this claim becomes testable rather than aspirational.
