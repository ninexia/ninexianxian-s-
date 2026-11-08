# dsh-report-docx 设计文档

> 描述 v0.4.x 的实现。更早的架构（v0.1 Python 子进程、v0.2 Markdown 往返）见文末「历史」。

## 1. 目标与非目标

目标：

- **模板化**：章节结构、封面字段、页眉页脚、目录、排版样式、校验阈值都由模板与配置驱动。
- **省 token**：文档只读需要的部分；计划、章节内容、渲染结果、历史索引都带缓存；工具返回值按用途裁剪。
- **可复用**：同一门课学一次模板，之后直接套用它的结构和封面。
- **可信**：不编造实验数据；缺失封面字段与缺失章节显式暴露；输出限制在工作区内；学到的模板不写入姓名/学号。

非目标：

- 不做 Word 排版引擎（目录页码、域更新交给 Word/WPS）；
- 不生成实验测量值、截图或运行日志；
- 不做 OCR、公式识别、复杂图文混排。

## 2. 工具面

一个 Host 工具 `report_docx`，六个动作：

| action | 关键参数 | 返回要点 |
| --- | --- | --- |
| `status` | `force` | 默认模板、模板清单（学过的带 `course`/`from`）、历史摘要 |
| `plan` | `requirements`、`course`、`templateId`、`cover`、`options` | `planId`、模板 id 与命中方式 `via`、章节行（id/标题/字数预算/提示）、缺的封面字段 |
| `build` | `planId`、`sections`、`outPath`、`options` | 输出路径、渲染统计、**缺失章节 id 列表**、`errors`/`warnings` |
| `validate` | `path`、`planId` | 错误、警告、结构指标（段数/表数/图数/字数/重复率） |
| `template` | `path`、`course`、`templateId` | 学到的模板 id、章节数、封面字段、保存位置 |
| `search` | `path`、`mode`、`query`、`limit`、`offset` | 大纲 / 命中片段 / 单节全文 |

## 3. 架构

```text
requirements ─────────────► plan ──────────► plan cache (.dsh-report-cache/plans)
                              │
旧报告 DOCX ──► template ─────┤
                              ▼
内置/覆盖/学到的模板 ──► template registry ──► buildPlan（章节 + 字数预算 + 封面）
                                                   │
模型按章节写内容 ──► normalizeSectionsInput ──► 去重 ──► section store
                                                   │
                                                   ▼
                                        sectionsToDocx（docx 库，进程内）
                                        封面页 / 标题 / 表格 / 图片 / 页眉 / 页脚 / TOC
                                                   │
                                                   ▼
                                        inspectDocx（纯 JS 解 ZIP）→ validateBuild
                                                   │
                                                   ▼
                                        build manifest + project state

任意 DOCX ──► inspectDocx ──► search（outline / text / section）
```

分层：

| 层 | 模块 | 职责 |
| --- | --- | --- |
| DSH 接入 | `src/plugin.js` | 注册工具、参数 schema、系统提示、错误兜底、工作区解析 |
| 编排 | `src/engine.js` | 六个动作、模板选择、缓存读写、输出路径与校验 |
| 配置 | `src/config.js` + `config.schema.json` | 默认值、路径解析、阈值归一化 |
| 模板 | `src/templates.js`、`templates/*.json` | 加载、按 id 合并、校验 |
| 学习 | `src/learn.js` | DOCX → 模板 JSON（章节、封面字段、关键词） |
| 计划 | `src/plan.js` | 要求解析、模板打分、封面提取、章节与任务分节 |
| 内容 | `src/content.js` | block 规范化、去重、占位符、复用判定 |
| 渲染 | `src/markdown2docx.js` | blocks → DOCX；纯 JS DOCX 检查（ZIP + document.xml） |
| 检索 | `src/search.js` | 标题推断、大纲、片段检索、单节读取 |
| 校验 | `src/validate.js` | 封面、必备标题、占位符、字数、重复率、结构 |
| 历史 | `src/history.js` | 工作区 DOCX 与 session 日志的有界扫描 |
| 缓存 | `src/cache.js` | plans / projects / builds / history / templates |

## 4. 核心流程

### plan

```text
text = normalizeText(requirements)
courseLabel = args.course ?? 从 "课程名称：" 提取
template = templateId ? 指定模板
         : 学过的模板里课程名匹配 ? 那个模板（via=course）
         : 关键词打分最高 ? 该模板（via=keywords）
         : 默认模板

cover   = 显式传入 > 从要求文本正则提取 > 字段默认值
sections = 模板章节 ∩ (必填 ∪ 触发词命中 ∪ 显式 include) − exclude
         + 任务组按 "任务N ..." 拆子节
planId  = rpt_ + hash(模板 id/版本/摘要, 要求摘要, 封面, 章节 id 列表)[:18]
写 plans/<planId>.json，返回 compactPlan（见第 7 节）
```

### build

```text
plan    = plans/<planId>.json
normalized = normalizeSectionsInput(sections)   # 未知 id 只告警
reuse   = options.reuse !== false && (要求摘要一致 || 同一 plan)
store   = 旧章节（可复用）+ 本次章节（按内容 hash 记录）
        ↓ buildRenderSections：缺失的必备章节 → 【待补充：…】占位
buildHash = hash(rendererVersion, planId, 模板摘要, 各节内容 hash, 输出路径, 去重配置)
命中 builds/<buildHash>.json 且文件在 → 直接返回（cacheHit）
否则 sectionsToDocx → inspectDocx → validateBuild → 写 manifest 与 project state
```

### template（学模板）

```text
inspectDocx → blocks
标题来源：Word 标题样式 ≥3 个则直接用，否则按 "一、/第X章" 正则推断
每个标题 → 一节：id=sN、层级、kind、minWords = 原节字数×0.8（40–400）
封面字段：只在原文里出现过的才标 required；默认值只写课程名
课程 → 模板 id：常见课程查表（hci/se/os/ai/javaee…），否则 course-<hash6>
写入 <templateOverlayDir>/<id>.json；重复学习递增 version，沿用已有 styles/page
```

### search

```text
inspectDocx → blocks（无标题样式时按 "一、/第X章" 推断层级）
mode=outline → 每个标题 + 其后正文的字数
mode=text    → 空格分词 AND 匹配，每段一条：para / section / snippet(±60 字) / matches
mode=section → 标题模糊命中，返回该节正文（上限 2000 字，标 truncated）
分页：limit + offset，结果未取完时返回 next: "offset=N"
```

## 5. 模板模型

```jsonc
{
  "id": "hci", "name": "人机交互实验报告", "version": 3, "priority": 40,
  "course": { "name": "人机交互", "aliases": ["人机交互", "界面设计"] },
  "match": { "keywords": { "人机交互": 3, "可用性": 1 } },
  "page":   { "size": "A4", "orientation": "portrait",
              "margins": { "top": 1, "bottom": 1, "left": 1.1, "right": 1.1 },
              "headerDistance": 0.45, "footerDistance": 0.45 },
  "styles": { "body": { "latin": "Times New Roman", "eastAsia": "宋体", "size": 10.5,
                        "lineSpacing": 1.3, "firstLineIndent": 2, "align": "justify" },
              "h1": { "size": 15, "bold": true, "spaceBefore": 10 },
              "h2": { "size": 13, "bold": true } },
  "cover":  { "enabled": true, "layout": "center", "courseSize": 24, "titleSize": 20,
              "infoSize": 14, "spacerLines": 3,
              "fields": [ { "key": "course", "label": "课程名称", "required": true } ] },
  "header": { "enabled": true, "text": "{{course}} — {{experiment}}" },
  "footer": { "enabled": true, "pageNumber": true },
  "toc":    { "enabled": true, "minSections": 6, "title": "目　　录" },
  "sections": [ { "id": "s1", "title": "一、实验目的", "level": 1, "kind": "list",
                  "required": true, "minWords": 40, "maxWords": 500,
                  "triggers": ["实验目的"], "hint": "…" } ],
  "source": { "docx": "旧报告.docx", "digest": "…", "learnedAt": "…" }
}
```

- `kind`：`paragraphs | list | table | mixed | task-group`；`task-group` 会按 `taskPatterns` 拆子节。
- 覆盖机制：`templateOverlayDir` 中与内置同 id 的 JSON 做浅合并，`templateDir` 追加第三方模板。
- 学到的模板与手写模板格式一致，可直接改。

## 6. 渲染管线

`sectionsToDocx(sections, path, { cover, styles, page, header, footer, toc, title })`：

1. 每节先输出标题段落（Heading 1–3，尺寸来自 `styles.h1..h3`）。
2. 逐 block：段落（首行缩进/对齐来自 `styles.body`）、列表（`bullet-list`/`number-list` 编号定义）、表格（表头底纹）、代码（等宽 + 底纹）、提示段、图片、分页符。
3. 图片：读文件 → 解析 PNG/JPEG/GIF/BMP 头拿宽高比 → 按 `width`（厘米）换算像素 → `ImageRun` 嵌入，附「图 N 说明」。
4. 封面：`cover.fields` 按固定顺序渲染，`course`/`experiment` 用大字号无标签，其余「标签：值」；末页分页。
5. 页眉：`{{key}}` 用封面字段替换，右对齐 + 下边框；首页（封面）留空（`titlePage`）。
6. 页脚：「第 X 页 / 共 Y 页」用 `PAGE` / `NUMPAGES` 域。
7. 目录：`TableOfContents`({\o "1-3" \h})，后接分页；`features.updateFields` 让 Word 打开时刷新。

`inspectDocx` 不依赖外部库：手工解析 ZIP 中央目录 → `zlib` 解压 `word/document.xml` → 正则抽段落/标题/表格/图片 → 统计字数、重复率、超长段落。

## 7. token 策略

- **返回按用途裁剪**：`plan` 只给写正文需要的四要素（id/标题/层级/字数预算 + 提示）；`build` 给缺失章节 id 而不是数量；`validate` 不再重复 `checks`/`metrics`/`structure`。
- **紧凑 JSON**：所有结果 `JSON.stringify` 不带缩进，格式开销占旧版三成。
- **读文档分档**：`search` 三档（大纲/片段/单节），实测同一份 1.5 万字报告 12,886 tok → 147 / 292 / 606 tok。
- **参数表精简**：只保留模型实际会用的参数，同一事实只说一次。

## 8. 缓存与状态

| 位置 | 内容 | 失效条件 |
| --- | --- | --- |
| `plans/<planId>.json` | 完整计划（含 requirements、章节、封面） | 由 planId 哈希决定 |
| `projects/<key>/state.json` | 项目章节内容与 hash | 按章节 hash 更新 |
| `builds/<buildHash>.json` | 构建 manifest | 章节/模板/路径/去重配置任一变化 |
| `history/index.json` | 工作区 DOCX 与 session 摘要 | 24 小时或 `force` |
| `templates/index.json` | 模板摘要与 digest | 模板文件变化 |

## 9. 安全与不编造

- 输出路径、图片路径默认限制在 workspace 内（`allowOutsideWorkspace` 可放开）。
- 缺失的必备封面字段 → 校验 error；缺失的必备章节 → 文档里写 `【待补充：…】` 且校验报错，不会静默编造。
- 学模板只继承结构与课程名，不继承姓名、学号、日期。
- 图片不存在或越界 → 跳过并告警，不生成假图。

## 10. 已知限制

- 模板里的 `styles.xml` / `sectPr` 尚未从旧 DOCX 抽取，课程间字体排版的细微差异仍需手改 JSON。
- 目录页码依赖 Word/WPS 更新域；纯 JS 无法预知分页。
- `src/render.js`、`renderer/report_tool.py` 为 v0.1 遗留，保留以便回退，当前不调用。

## 11. 历史

- **v0.1**：Python 子进程 + `python-docx`，`render.js` 负责 Node↔Python 契约。
- **v0.2**：改为进程内纯 JS（`docx` 包），内容先序列化成 Markdown 再渲染；图片只留占位。
- **v0.3**：抛弃 Markdown 往返，直接由 blocks 渲染；加入课程模板、封面页、页眉页脚、目录。
- **v0.4**：加入 `search`，读文档改为按需取片段。
