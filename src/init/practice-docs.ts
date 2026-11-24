import { join } from 'node:path';
import type { DocsLanguage } from './docs-language.ts';
import { probeLstat } from '../core/practice-paths.ts';
import type { PracticeContext, PracticePack, PracticeTargetSet } from './practice.ts';
import type { ScanResult } from './scanner.ts';

const DOC_TARGETS = ['docs/AGENTS.md', 'docs/architecture.md'] as const;
const BILINGUAL_RULE = '.agents/rules/docs-bilingual.md';

function sourceDirsText(scan: ScanResult, language: DocsLanguage): string {
  if (scan.sourceDirs.length === 0) {
    return language === 'zh' ? '未检测到' : 'not detected';
  }
  return scan.sourceDirs.join(language === 'zh' ? '、' : ', ');
}

function layoutLines(scan: ScanResult, language: DocsLanguage): string[] {
  if (scan.sourceDirs.length === 0) {
    return [language === 'zh' ? 'TODO: 记录顶层布局。' : 'TODO: Record the top-level layout.'];
  }
  return scan.sourceDirs.map((dir) =>
    language === 'zh'
      ? `- \`${dir}/\` — TODO: 说明该目录负责的内容。`
      : `- \`${dir}/\` — TODO: Describe what this directory owns.`,
  );
}

const COMMANDS = [
  ['test', 'Test', '测试'],
  ['build', 'Build', '构建'],
  ['lint', 'Lint', 'Lint'],
  ['typecheck', 'Typecheck', '类型检查'],
] as const;

function commandLines(scan: ScanResult, language: DocsLanguage): string[] {
  return COMMANDS.map(([key, english, chinese]) => {
    const command = scan.commands[key];
    if (command === undefined) {
      return language === 'zh' ? `TODO: 添加 ${key} 命令` : `TODO: add a ${key} command`;
    }
    return language === 'zh' ? `- ${chinese}：\`${command}\`` : `- ${english}: \`${command}\``;
  });
}

export function renderArchitectureMd(input: {
  language: DocsLanguage;
  scan: ScanResult;
}): string {
  const { language, scan } = input;
  return language === 'zh' ? renderArchitectureZh(scan) : renderArchitectureEn(scan);
}

function renderArchitectureEn(scan: ScanResult): string {
  return `<!-- DAB created this skeleton. It is authored documentation from here on; DAB never overwrites it. -->
# Architecture

## Project facts

- Project: ${scan.projectName}
- Language: ${scan.language}
- Package manager: ${scan.packageManager}
- Source directories: ${sourceDirsText(scan, 'en')}

### Top-level layout

${layoutLines(scan, 'en').join('\n')}

## System purpose

TODO: Describe why this system exists and who it serves.

## Composition

TODO: List the primary components and how they relate at runtime.

## Runtime flow

TODO: Describe the end-to-end flow for the main entry points.

## Module boundaries

TODO: Record what each module owns and what crosses its boundaries.

## Extension points

TODO: Note where new behavior is meant to plug in.

## Invariants

TODO: List properties that must always hold.

## Verification

${commandLines(scan, 'en').join('\n')}
TODO: Document fixtures, environments and manual checks used to verify behavior.
`;
}

function renderArchitectureZh(scan: ScanResult): string {
  return `<!-- DAB 只创建这个骨架；此后它是项目维护的文档，DAB 不会覆盖。 -->
# 架构

## 项目事实

- 项目：${scan.projectName}
- 语言：${scan.language}
- 包管理器：${scan.packageManager}
- 源码目录：${sourceDirsText(scan, 'zh')}

### 顶层布局

${layoutLines(scan, 'zh').join('\n')}

## 系统目的

TODO: 说明系统为什么存在、为谁服务。

## 组成

TODO: 列出主要组件及其运行时关系。

## 运行时流程

TODO: 描述主要入口的端到端流程。

## 模块边界

TODO: 记录各模块的职责以及跨越边界的内容。

## 扩展点

TODO: 注明新行为应接入的位置。

## 不变量

TODO: 列出必须始终成立的性质。

## 验证

${commandLines(scan, 'zh').join('\n')}
TODO: 记录验证所需的 fixture、环境和手工检查。
`;
}

export function renderDocsAgentsMd(input: {
  language: DocsLanguage;
  scan: ScanResult;
  anchors: ReadonlySet<string>;
}): string {
  return input.language === 'zh'
    ? renderDocsAgentsZh(input.scan, input.anchors)
    : renderDocsAgentsEn(input.scan, input.anchors);
}

function renderDocsAgentsEn(scan: ScanResult, anchors: ReadonlySet<string>): string {
  const rootAgents = anchors.has('AGENTS.md')
    ? '- [AGENTS.md](../AGENTS.md) — repository-wide agent rules and entry points.'
    : '- Root `AGENTS.md` — repository-wide agent rules and entry points.';
  const architecture = anchors.has('docs/architecture.md')
    ? '- [architecture](architecture.md) — architecture facts and boundaries.'
    : '- `docs/architecture.md` — architecture facts and boundaries.';
  return `# Documentation guide

This directory holds the project documentation for ${scan.projectName}. \`docs/AGENTS.md\` is the documentation standard: read it before writing, restructuring or reviewing documentation.

## Document structure

${rootAgents}
- \`docs/AGENTS.md\` — this guide: document tiers, placement and writing rules.
${architecture}
- \`.agents/notes/\` — decision records and durable findings, one note per decision.
- Cookbooks and postmortems — add them under \`docs/\` when the project needs them, and link them from here.

## Placement

- Every fact has exactly one home. The owner document holds the detail; other documents link to it.
- Architecture facts belong in the architecture document, not in this guide or in root \`AGENTS.md\`.
- Decisions belong in \`.agents/notes/\` with context, alternatives, consequences and verification.
- Procedures belong in cookbook pages; incident write-ups belong in postmortems.
- Root \`AGENTS.md\` holds agent rules only, not project documentation details.
TODO: Add project-specific placement rules.

## Writing rules

- Describe the current state. Do not narrate history, planned work or implementation progress.
- Write one paragraph per line so diffs stay reviewable.
- Use relative links to files that exist; never link to examples that are not in the repository.
- Keep headings, lists, tables, fenced code and inline code structurally stable.
- Write in English only. Do not create translations or pairing records.
TODO: Add project-specific writing rules.

## Slop checklist

Remove these before finishing:

- Rules repeated from another document instead of linked.
- History narration and changelog prose.
- Implementation-status notes such as "currently in progress".
- Hand-copied directory trees or file inventories.
- Reasoning traces and speculation.
- Paragraph walls and repeated conclusions.
- Emphasis inflation: bold text and exclamation marks that add no meaning.
TODO: Add project-specific slop patterns.

## Verification

- Run \`dab detect\` to check missing documents, broken links and TODO markers.
- Run the project documentation gate before merging.
TODO: Add the project documentation gate command.
- Use the \`dab-doc-writing\` skill for writing, restructuring and review workflows.
- Use the \`dab-architecture-writing\` skill to fill the architecture skeleton with evidence.
- Fill every project-specific TODO before handing documentation off for review.
`;
}

function renderDocsAgentsZh(scan: ScanResult, anchors: ReadonlySet<string>): string {
  const rootAgents = anchors.has('AGENTS.md')
    ? '- [AGENTS.md](../AGENTS.md) — 仓库级 agent 规则和入口。'
    : '- 根目录 `AGENTS.md` — 仓库级 agent 规则和入口。';
  const architecture = anchors.has('docs/architecture.md')
    ? '- [architecture](architecture.md) — 架构事实和边界。'
    : '- `docs/architecture.md` — 架构事实和边界。';
  return `# 文档规范

本目录存放 ${scan.projectName} 的项目文档。\`docs/AGENTS.md\` 是文档标准：编写、调整或审阅文档前先读它。

## 文档结构

${rootAgents}
- \`docs/AGENTS.md\` — 本指南：文档层级、放置规则和写作规则。
${architecture}
- \`.agents/notes/\` — 决策记录和可长期保留的结论，每个决策一条。
- Cookbook 与 postmortem — 项目需要时放到 \`docs/\` 下，并从这里链接。

## 放置规则

- 每个事实只有一个 home；细节由 owner 文档维护，其他文档只链接。
- 架构事实放在架构文档中，不写进本指南或根 \`AGENTS.md\`。
- 决策放在 \`.agents/notes/\`，包含背景、备选方案、后果和验证方式。
- 操作流程放在 cookbook；事故复盘放在 postmortem。
- 根 \`AGENTS.md\` 只放 agent 规则，不放项目文档细节。
TODO: 补充项目特定的放置规则。

## 写作规则

- 描述当前状态，不叙述历史、计划中的工作或实现进度。
- 一段一行，保证 diff 可审阅。
- 使用指向真实存在文件的相对链接，不链接不存在的示例。
- 保持标题、列表、表格、代码块和行内代码结构稳定。
- 只使用中文写作，不生成翻译或配对记录。
TODO: 补充项目特定的写作规则。

## Slop 清单

完成前删除这些内容：

- 从其他文档重复抄来的规则，而不是链接。
- 历史叙述和 changelog 式文字。
- 实现状态标注，例如“正在开发中”。
- 手抄的目录树或文件清单。
- 推理过程和猜测。
- 段落墙和重复结论。
- 强调膨胀：没有增加含义的加粗和感叹号。
TODO: 补充项目特定的 slop 模式。

## 验证

- 运行 \`dab detect\` 检查缺失文档、损坏链接和 TODO 标记。
- 合并前运行项目的文档门禁。
TODO: 补充项目文档门禁命令。
- 使用 \`dab-doc-writing\` skill 进行写作、重构和审阅。
- 使用 \`dab-architecture-writing\` skill 用证据填写架构骨架。
- 交付评审前补齐所有项目特定的 TODO。
`;
}

export const documentationPack: PracticePack = {
  id: 'documentation',
  async targets(context: PracticeContext): Promise<PracticeTargetSet> {
    if (context.scope === 'global') {
      return { paths: [] };
    }
    // A path-state error (for example a regular file at `.agents/rules`) is
    // governed by the plan targets and detection; the rule simply cannot exist.
    const bilingual = (await probeLstat(join(context.root, BILINGUAL_RULE))).info !== null;
    return bilingual
      ? { paths: [...DOC_TARGETS], policySkipped: [...DOC_TARGETS] }
      : { paths: [...DOC_TARGETS] };
  },
  files(context) {
    const language = context.docsLanguage.value;
    return {
      'docs/AGENTS.md': renderDocsAgentsMd({
        language,
        scan: context.scan,
        anchors: context.anchors,
      }),
      'docs/architecture.md': renderArchitectureMd({ language, scan: context.scan }),
    };
  },
};
