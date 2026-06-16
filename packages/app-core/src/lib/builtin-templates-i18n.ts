/**
 * Localized text for the built-in templates. The base templates live in
 * `@shared/builtin-templates` (English, framework-free); here we overlay
 * translated name/description/titleTemplate/body per template id when the UI
 * language has a translation. Keyed by id (not content) so editing a base
 * template body never silently breaks a translation.
 */
import type { Language } from '../store'
import type { NoteTemplate } from '@bridge-contract/templates'
import { BUILTIN_TEMPLATES } from '@shared/builtin-templates'

type TemplateText = {
  name: string
  description: string
  titleTemplate?: string
  body: string
}

const ZH: Record<string, TemplateText> = {
  'builtin.adr': {
    name: 'ADR',
    description: '架构决策记录',
    body: `# {{title}}

- **状态:** 提议中
- **日期:** {{date}}
- **决策者:**

## 背景

{{cursor}}

## 决策

## 影响

### 正面

### 负面

## 相关

`
  },
  'builtin.rfc': {
    name: 'RFC / 设计文档',
    description: '含动机、设计与备选方案的提案',
    body: `# {{title}}

- **作者:**
- **状态:** 草稿
- **日期:** {{date}}

## 概述

{{cursor}}

## 动机

## 方案

## 备选方案

## 推进与风险

## 相关

`
  },
  'builtin.bug': {
    name: 'Bug 报告',
    description: '可复现的缺陷,含预期与实际表现',
    body: `# {{title}}

- **日期:** {{date}}
- **严重程度:**
- **环境:**

## 复现步骤

1. {{cursor}}

## 预期

## 实际

## 备注

`
  },
  'builtin.postmortem': {
    name: '复盘',
    description: '事故回顾:时间线、根本原因、行动项',
    body: `# {{title}}

- **日期:** {{date}}
- **作者:**
- **影响:**

## 概述

{{cursor}}

## 时间线

## 根本原因

## 解决

## 行动项

- [ ]

## 相关

`
  },
  'builtin.meeting': {
    name: '会议记录',
    description: '议程、记录、决议与行动项',
    titleTemplate: '会议 — {{date:YYYY-MM-DD}}',
    body: `# {{title}}

- **日期:** {{date}}
- **参会人:**

## 议程

- {{cursor}}

## 记录

## 决议

## 行动项

- [ ]

`
  },
  'builtin.oneonone': {
    name: '1:1',
    description: '一对一:成果、阻碍、成长、跟进',
    titleTemplate: '1-1 — {{date:YYYY-MM-DD}}',
    body: `# {{title}}

- **日期:** {{date}}

## 成果

{{cursor}}

## 挑战与阻碍

## 成长与反馈

## 跟进

- [ ]

`
  },
  'builtin.reading': {
    name: '读书笔记',
    description: '书或文章的笔记:观点、摘录、收获',
    body: `# {{title}}

- **作者:**
- **开始:** {{date}}
- **状态:** 阅读中

## 核心观点

- {{cursor}}

## 摘录

>

## 收获

## 相关

`
  },
  'builtin.journal': {
    name: '日记',
    description: '自由书写的第一人称当日记录',
    titleTemplate: '{{date:YYYY-MM-DD}}',
    body: `# {{date:YYYY年M月D日}}

{{cursor}}

`
  },
  'builtin.kickoff': {
    name: '项目启动',
    description: '目标、范围、里程碑与干系人',
    body: `# {{title}}

- **日期:** {{date}}
- **负责人:**

## 目标

- {{cursor}}

## 范围

### 范围内

### 范围外

## 里程碑

## 干系人

## 风险

## 相关

`
  },
  'builtin.todo': {
    name: '待办',
    description: '一个简单的清单骨架',
    body: `# {{title}}

- [ ] {{cursor}}
- [ ]
- [ ]

`
  }
}

/** Built-in templates with text localized to the given UI language. */
export function localizedBuiltinTemplates(language: Language): NoteTemplate[] {
  if (language !== 'zh') return BUILTIN_TEMPLATES
  return BUILTIN_TEMPLATES.map((tpl) => {
    const text = ZH[tpl.id]
    return text ? { ...tpl, ...text } : tpl
  })
}
