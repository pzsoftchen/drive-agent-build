# DAB Practice Layer 工程纪律差距登记

## 状态

记录，供后续迭代认领；它不是已批准的范围，也不替代 roadmap。当前设计见 [Practice Layer 设计](2026-11-23-practice-layer-design.md)。

## 判断标准

- **L1（v1 设计）**：scaffold 单语文档骨架和 authoring skills，`detect` 检查缺失、链接和 TODO。
- **L2（执行层）**：把检查变成项目本地和 CI 上的强制门禁，补齐决策记忆、交付技能和文档深度。
- **L3（度量层）**：任务证据、eval、评审策略和跨项目度量。
- 复刻不等于复制：DAB 提供机制、默认值和检查；项目提供架构事实、阈值、命令和评审策略。

## 当前 v1 覆盖

v1 设计覆盖：`generic` profile、`feature` 别名、core baseline + documentation/authoring packs、单语 `docs/AGENTS.md` 与 `docs/architecture.md` 骨架、`docs.language` 语言检测、`dab-doc-writing` / `dab-architecture-writing` / `dab-decision-notes` skills、TODO 和空章节检测、缺失/落后版本标记检查、只写缺失、dry-run、project scope、`detect --strict` 的缺失 docs/skills、TODO、空章节、落后版本标记检查（unversioned 标记和 bilingual policy warning 不触发 strict）。双语文档不进入 generic。0.1.2 进一步覆盖受管 authoring skills：包内 `skills/` canonical 模板、版本/hash marker、apply 前重校验，以及仅更新严格较旧且未修改的副本；modified/newer/legacy 分叉保留。

## 差距清单

| ID | 差距 | deepseek-harness 参照 | 为什么重要 | 建议迭代 | 验收要点 |
|---|---|---|---|---|---|
| G1 | 项目本地执行入口和 CI 门禁 | `check:all`、docs gates、CI run-gates | 没有强制，文档和 skills 会腐烂；`detect` 只是检查器，项目需要稳定入口 | A，设计已批准；[设计](2026-11-25-g1-gate-design.md) / [计划](../plans/2026-11-25-g1-gate.md) | 生成或文档化项目本地 check 脚本与最小 CI workflow，串起 `dab detect --strict`、docs 检查和项目 test/typecheck；不新增 `dab` 命令 |
| G2 | Agent Notes 完整生命周期与归档 | proposed/implemented/rejected/archived、统一格式、归档 skill、supersession | v1 只有写作 skill，没有格式检查、归档和替代检查；决策记忆会退化 | B | notes 目录/README/格式 gate、归档与 supersession 检查、归档 skill、模板和测试 |
| G3 | Delivery skills pack | code review、pre-push、PR description、simplification、doc writing | v1 只有 authoring skills；交付过程和审查仍靠个人习惯 | C | curated skills 安装、项目命令引用、detect 存在性/版本检查、使用结果可审查 |
| G4 | Skill 更新与版本治理 | skill 随仓库演进，由维护者更新 | v1 只写缺失；skill 内容更新后，项目里的副本会过期 | 已完成 0.1.2 | 版本标记、未修改自动更新、modified/legacy 分叉保留、apply 前并发重校验；不创建备份。实现见 [设计](2026-11-24-managed-skills-design.md) 和 [计划](../plans/2026-11-24-managed-skills.md)。 |
| G5 | 文档预算与语料检查 | 字数预算、wrap/links/refs/concrete terms/subsystem 页检查 | v1 的文档检查只做 pack 内存在性、链接、TODO 和空章节；authoring skill 检查不属于 G5；文档会膨胀或漂移 | D | 项目预算 manifest、wrap/refs/concrete terms 等可选检查、detect/doc-sync 集成 |
| G6 | Subtree AGENTS 生成 | root、packages/、docs/、.agents/notes/ 的子树指令 | v1 只有 root 和 docs/；多包/多子系统项目缺少就近规则 | D | 扫描顶层源码目录，生成缺失的 subtree AGENTS，不覆盖，detect 检查 |
| G7 | 架构文档深度 | subsystems 页、package README、生成 API、config catalog | v1 只有 architecture 骨架；复杂项目需要分层 owner | D | subsystem/package 模板、按语言生成 catalog/API 的可选 pack、链接检查 |
| G8 | 可选 bilingual pack | terminology、style guide、translate skill、line-aligned pairs | 有些项目确实需要双语，但默认强加会增加复杂度和维护；用户选择不纳入 generic | 可选，不排期 | 仅在显式启用时生成配对、术语/翻译检查 |
| G9 | 同变更更新门禁 | 文档/notes/tests 在同一 PR 更新 | 没有门禁，agent 容易只改代码不改文档 | A | pre-push 或 CI 检查变更范围与文档/notes 的关联；至少提供 PR checklist 和 detect 提示 |
| G10 | 项目规则与防御模式 | root AGENTS standing orders、defensive patterns、secrets/.env | v1 生成通用规则；项目特定约束仍靠人补 | B | 规则/防御模式模板、项目命令/边界注入、detect 链接/大小检查 |
| G11 | Review ownership 与审批策略 | `.github/review-ownership`、approval tests | v1 没有评审归属和审批规则；团队规模变大后失控 | C | 可选的 CODEOWNERS/审批策略模板和检查；保持 GitHub-specific 可选 |
| G12 | 任务证据与 eval | 测试/CI/评审证据链 | 这是 DAB/DAD 的 L3；practice layer 只覆盖配置和文档 | E | `dab run --record`、`dab eval --suite`、时间/尝试/成本/干预/越界记录 |
| G13 | 项目类型 profile | 不同项目有不同 docs/roles 组合 | v1 只有 generic/feature 别名；未来需要按项目/工作方式组合 packs | E | profile registry、archetype 模板、pack 组合、未知 profile fail loud |
| G14 | Memory/notes retention | notes 归档、supersession、frozen archive | DAB roadmap v0.3 已有 memory promote/expiry；v1 未覆盖 | E | memory promote、expiry/supersession、归档 workflow |
| G15 | 跨 harness 实践投影 | Claude/Codex/DSH 等 harness | DAB roadmap v0.4；practice layer 最终要跨 harness | E | Codex/DSH adapter 复用同一 practice 定义和检查 |
| G16 | Skill 效果度量 | 无直接对应；DSH 用 docs/CI 证据 | 无法证明 agent 真的按 skill 执行 | E | eval suite、skill adherence 指标、失败样本 |
| G17 | 既有文档/skill 的 adoption 与 reconcile | 项目已有成熟 docs/skills | v1 只补缺失；存量标准不会自动对齐 | C | 只读检查、差异报告、人工确认的合并/迁移；不覆盖 authored 内容 |

## 建议迭代顺序

### 迭代 A：执行层基础

先做 G1（项目本地 check/CI）和 G9（同变更门禁）；G4（skill 更新治理）已在 0.1.2 完成。原因是：没有执行入口，v1 的骨架和 skills 只是模板；G4 已解决 skill 随 DAB 版本过期的问题。

### 迭代 B：决策记忆与项目规则

做 G2（Agent Notes 完整生命周期）和 G10（项目规则/防御模式）。这两项把“为什么”和“项目边界”沉淀下来，是后续 delivery 和 review 的基础。

### 迭代 C：交付技能与评审

做 G3（delivery skills）和 G11（review ownership/审批），同时评估 G17（存量文档/skill adoption）。交付技能必须引用项目命令，不能复制 DSH 的流程。

### 迭代 D：文档深度

做 G5（预算/语料检查）、G6（subtree AGENTS）、G7（架构深度）。G8（双语）是可选 pack，不排期，也不进入 generic。这些依赖 A/B 的 gate 和 notes 基础，优先做能确定性检查的部分。

### 迭代 E：度量与扩展

做 G12（任务证据/eval）、G16（skill 效果）、G13（项目类型 profile）、G14（memory retention）、G15（跨 harness）。这些属于 L3 或 roadmap 已排期的方向。

## 明确不复刻的内容

- deepseek-harness 的领域文档（Cordis、API gateway、session format 等）和项目特定阈值。
- 默认双语文档和翻译；generic 只生成单语，双语是可选 pack。
- 它的 CI 矩阵、review ownership 具体规则、docs 网站发布流程；DAB 只提供可选机制和模板。
- 自动生成架构、决策理由和项目约束；这些必须由项目里的 agent 依据代码、测试和命令证据填写，或由人确认。
- 把 DSH 的 skill 原文直接复制到其他项目；只提炼通用方法、证据要求和质量标准。

## 维护方式

- 每个差距实现后，在对应条目补上设计/计划链接并标记完成；不要把本文件扩写成第二份 roadmap。
- 新差距先判断是 L1/L2/L3 哪一层，再决定是否进入 roadmap；不要把所有建议都塞进 v1。
- 与 [Roadmap](../../roadmap.md) 的排期冲突时，以 roadmap 为准，本文件只保留能力差距和验收要点。
