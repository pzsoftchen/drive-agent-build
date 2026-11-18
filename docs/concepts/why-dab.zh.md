[English](why-dab.md) | 中文

# DAB 为什么存在

DAB 来自一个实践观察：更强的模型和更好的 Agent runtime，不会自动产生可靠交付。它们提高了 Agent 能做什么的上限，却没有定义应该构建什么、工作如何收敛，以及什么证据能证明结果可以接受。

> 状态：本页描述 DAB/DAD 的组合方向。当前 `main` 分支实现的是 DAD 配置治理基础。v0.2 只验证单个开发任务，DAB 的目标级交付仍是研究阶段。

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

## 我为什么开始 DAB

我从个人杠杆正在发生变化这一点开始思考 DAB。当 Agent 承担越来越多执行工作时，我相信构建者的优势不再是亲手完成每一步，而是设计让 Agent 可靠构建的条件。

两个判断影响了我的想法：

- 一位 DeepSeek 算子开发者判断，工作重心可能从设计、编写和优化算子，转向驾驶 Agent 完成这些工作。
- 李彦宏提出的 Builder，把创造者的范围从编写代码的人扩展到更广泛的人群。

我最早实践的是一个更窄的做法：DAD（Drive Agent Development，驱动 Agent 开发），即定义 Agent 应如何开展开发工作，并驾驶 Agent 按这个过程执行。DAD 让我看到了编写源、显式投影、漂移检测、决策记录和共享记忆的价值。DAB 保留这套工程纪律，并把它扩展到不只服务开发场景的交付。

## Agent 能力不等于交付

熟悉的概念是：

```text
Agent = Model + Harness
```

Model 提供推理和生成能力，Harness 提供执行循环、工具、上下文、权限和会话。两者共同让 Agent 工作成为可能。

交付增加了它们本身不负责的条件：

- 构建者必须定义目标结果和验收标准。
- Agent 必须获得稳定的项目事实、角色和边界。
- 执行必须产生证据，而不只是活动。
- 失败的工作必须被诊断、恢复或升级。
- 最终结果必须通过明确的交付门禁。

这就是 DAB 要解决的空缺。

## DAB 位于哪里

DAB 在产品概念上是位于 Harness 之上的驾驶系统；本仓库实现的是它的控制面。DAB 不替代模型，不实现 Agent Loop，也不成为另一个 runtime。

- 构建者是对意图、约束、判断和验收负责的人。
- Agent 是在 Harness 内执行构建工作的执行主体。
- DAB 把这些决策和项目事实转化为受治理的 Harness 配置。
- Harness 使用模型和项目工具执行工作。
- 项目证据回到 DAB，驱动下一次决策。
- 只有被接受的工作才作为交付物离开循环。

DAB 同时治理方向和收敛。它的价值不是让 Agent 能行动，而是让工作被驾驶到可以交接的状态。

## DAD 与 DAB

DAD 指 Drive Agent Development，也就是驱动 Agent 开发。它定义 Agent 应如何开展开发工作，以及人如何按照项目规则、工具和验证方式驾驶 Agent。

DAB 指 Drive Agent as Builder，也就是驱动 Agent 成为构建者。它会保留 DAD 的单任务闭包，再增加目标级拆解、任务协同、集成和整体验收。

> DAD 让 Agent 可被驾驶、任务可以完成；DAB 要让多任务目标可以交付。

开发是 DAB 的第一个范围，因为第一位构建者是开发者。但开发不是终点。同一套驾驶模型未来可以治理研究、内容、运营或其他构建活动，而不需要改变核心逻辑。

## DAD 先于 DAB

Roadmap 有意把交付拆成两个层级：

- DAD 任务循环负责把单个开发任务驾驶到执行、证据和验收完成。
- DAB 目标循环未来负责把更大的目标拆成多个任务，集成各自产物，并验证整体结果。

单任务闭包属于 DAD。一个任务通过不能证明整体目标完成，但整体目标也不能在没有相关任务通过并正确集成时被接受。

DAB 只有在 DAD 实践反复暴露任务循环无法解决的目标级问题后才值得探索。目前不承诺任务图、GoalRun 或 TaskRun 模型。

## 交付层级

这些层级是嵌套的：

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

Harness Loop 回答“Agent 下一步做什么”，DAD 任务循环判断单个开发任务是否完成。未来研究的 DAB 目标循环，则判断所有必要任务及集成结果是否共同构成可接受的交付。

任务完成要被记录为证据。跨任务学习是独立的改进循环，不能用完整复盘阻塞每个原子任务。

## 交付收敛

Agent 持续行动，不代表它在自治并有效收敛。收敛需要明确控制：

- 完成定义；
- 确定性检查和评审证据；
- 时间、尝试次数、成本和范围限制；
- 检查失败后的恢复策略；
- Agent 无法推进时的停止条件；
- 超出其权限时向人升级。

DAB 的作用是让这些控制成为项目配置的一部分，而不是散落在对话里。

## DAB 不是什么

- DAB 不是模型。
- DAB 不是 Agent runtime，也不替代 Harness。
- DAB 不是提示词集合。
- DAB 不是无限自治循环。
- DAB 不承诺在没有证据的情况下生成结果一定正确。

## 如何判断 DAD 与 DAB

一个概念只有改善交付才有价值。首先，v0.2 必须在固定模型、Harness、任务和环境的条件下，证明 DAD 能改善单个开发任务。它测量：

- 第一次尝试即被接受的结果；
- 人工干预和返工次数；
- 达到验收所需的时间和成本；
- 范围越界与门禁失败；
- 已评审项目知识的复用情况。

当受治理的配置和任务证据，能让原本相同的 Agent 配置产生更可靠的单任务结果时，DAD 才真正成立。

只有真实 DAD 使用反复暴露目标拆解、跨任务集成、整体验收或跨任务学习问题时，才启动 DAB 研究。
