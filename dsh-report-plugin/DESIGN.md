# dsh-report-docx 设计文档

## 1. 目标

- **模板化**：报告流程、排版规格、章节结构、封面字段、校验规则均由模板与配置驱动。
- **节省 token**：历史结构提取一次、计划一次、内容按节缓存、构建结果按哈希缓存、工具返回压缩摘要。
- **灵活可扩展**：模板可替换、可覆盖；章节可包含/排除；输出可增量重建。
- **可信**：不编造实验数据；缺失封面字段与缺失章节必须显式暴露；输出默认限制在工作区内。

非目标：

- 不替代 Word 排版引擎；
- 不自动生成实验测量值、截图或真实运行日志；
- 不做 OCR、公式识别或复杂图文混排。

## 2. 总体架构

```text
 experiment requirements
        |
        v
 resolveConfig + loadTemplates -----> template registry / overlay
        |
        v
 buildPlan
   - normalizeText
   - scoreTemplates
   - extractCover / extractTitle / extractTasks
   - section plan + word budgets
        |
        v
 history index (DOCX + DSH sessions) -> hints
        |
        v
 model writes sections
        |
        v
 normalizeSectionsInput -> section store -> dedupe -> render payload
        |
        v
 Python renderer (python-docx) -> DOCX
        |
        v
 inspect DOCX -> validateBuild -> build manifest / project state
```

分层职责：

| 层 | 模块 | 职责 |
| --- | --- | --- |
| DSH 接入 | `src/plugin.js` | 注册 `report_docx`，注入系统提示，处理错误与工作区 |
| 用例编排 | `src/engine.js` | status/plan/build/validate/ingest 与缓存策略 |
| 配置 | `src/config.js`, `config.schema.json` | 默认值、规范化、路径解析、Python 探测 |
| 模板 | `src/templates.js`, `templates/*.json` | 加载、合并、校验模板 |
| 计划 | `src/plan.js` | 要求解析、模板评分、章节计划 |
| 内容 | `src/content.js` | 章节规范化、去重、占位符、渲染负载 |
| 渲染 | `src/render.js`, `renderer/report_tool.py` | Node/Python 进程契约与 DOCX 生成/检查 |
| 校验 | `src/validate.js` | 封面、标题、占位符、字数、重复率、结构 |
| 历史 | `src/history.js` | DOCX 与 session 日志提取 |
| 缓存 | `src/cache.js` | plans/projects/builds/history/templates |

## 3. 核心流程伪代码

### plan

```text
function plan(requirements, templateId, cover, options):
    text = normalizeText(requirements)
    scores = scoreTemplates(templates, text)
    template = templateId ? templates[templateId] : bestOrDefault(scores)
    template = merge(template, options.templateOverrides)

    coverValues = extractCoverFields(text, template.cover.fields, cover)
    tasks = extractTaskLines(text)
    experimentTitle = extractTitle(text, coverValues)

    sections = planSections(template, tasks, options.includeSections, options.excludeSections)
    missingCover = required cover fields not present

    plan = {
      planId: hash(requirementsDigest, templateDigest, coverValues, tasks, options),
      projectKey: safeTitle + shortHash(course|title),
      requirementsDigest, templateId, templateVersion,
      cover: coverValues, sections, missingCover, stats
    }

    cache.putPlan(plan)
    ensureProjectState(plan)
    return compactPlan(plan, scores, historyHints)
```

### build

```text
function build(planId, sections, outPath, options):
    plan = cache.getPlan(planId) or plan from requirements
    previous = cache.getProject(plan.projectKey)

    incoming = normalizeSectionsInput(sections, plan)
    allowReuse = options.reuse === true
        || (options.reuse !== false && (
            previous.requirementsDigest === plan.requirementsDigest
            || previous.lastPlanId === plan.planId))

    store = allowReuse ? previous.sections : {}
    store[incomingSection] = normalizeBlocks(incomingSection)

    built = buildRenderSections(plan, store, config)
      - required + empty -> placeholder
      - task-group parent -> structural heading only
      - dedupe blocks
      - compute section hashes

    outputPath = resolveOutputPath(outPath, plan)   # must stay in workspace
    buildHash = hash(rendererVersion, planId, templateDigest, sectionHashes, outputPath, dedupeConfig)

    if cache.getBuild(buildHash)?.path === outputPath and file exists:
        return compactBuild(plan, cached, cacheHit=true)

    payload = buildRenderPayload(plan, template, built.sections, config)
    rendered = pythonRenderer.render(payload, outputPath)
    inspect = rendered.inspect or pythonRenderer.inspect(outputPath)
    validation = validateBuild(plan, template, rendered, inspect, config, built)

    cache.putBuild(buildHash, manifest)
    cache.putProject(plan.projectKey, storeWithLastBuild)
    return compactBuild(plan, result)
```

### history ingest

```text
function ingestHistory(scope, force):
    docxRows = discoverWorkspaceDocx()          # skip cache/plugin/temp files
    fingerprint = hash(docxRows.path:mtime:bytes)

    if not force and cache.history matches scope and fingerprint and age < 24h:
        return cached

    docs = pythonRenderer.scanDocx(docxRows.paths)
    docs = uniqueByContentHash sorted by words

    sessions = discoverSessionLogs()
    for session in sessions:
        text = decompressZstdFrames(session)
        parse session/user/tool/assistant events
        keep report keyword snippets, docx refs, heading candidates

    index = {
      digest, fingerprint, docx summary, session summary,
      hints: top headings, styles, keywords
    }

    cache.putHistory(index)
    return index
```

## 4. 模板模型

模板 JSON 主要字段：

- `page`：纸张、方向、页边距、页眉页脚距离
- `styles`：正文、标题、表格、代码、图注/表注字体与段落
- `cover`：启用、字段、尺寸、封面信息
- `header` / `footer`：文本与页码字段
- `toc`：是否启用、最小章节数、标题
- `sections`：章节定义
- `match.keywords`：模板自动评分关键词
- `defaults` / `validation`：模板级默认校验阈值

章节定义：

```json
{
  "id": "process.task-1",
  "title": "5.1 任务1 ...",
  "level": 2,
  "kind": "mixed | paragraphs | list | task-group | table | code",
  "required": true,
  "minWords": 60,
  "hint": "写清输入、操作、产出与检查结果",
  "parentId": "process"
}
```

任务组父章节只承载标题与子节，不强制正文；子节由要求中的“任务N ...”生成。

模板加载顺序：

1. 内置 `templates/*.json`
2. `templateDir` 扩展模板
3. `templateOverlayDir` 覆盖同 id 模板，做浅合并
4. registry/schema 校验并生成 template digest

## 5. 内容模型

章节内容统一规范化为 block 数组：

```text
ParagraphBlock { type: 'paragraph', text }
NoteBlock      { type: 'note', text }
BulletsBlock   { type: 'bullets', items }
NumberedBlock  { type: 'numbered', items }
TableBlock     { type: 'table', caption, headers, rows }
ImageBlock     { type: 'image', path, caption, width }
CodeBlock      { type: 'code', caption, text }
```

去重策略：

- 段落/提示：规范化后精确哈希去重
- 长文本：5-gram Jaccard 相似度 >= `dedupe.nearThreshold`
- 表格：行签名去重
- 跨节去重默认关闭，避免“目的”和“总结”中的合理复述被误删

## 6. 缓存与去重

缓存目录：

```text
.dsh-report-cache/
  plans/<planId>.json
  projects/<projectKey>.json
  builds/<buildHash>.json
  history/index.json
  templates/index.json
```

失效策略：

| 缓存 | key | 失效条件 |
| --- | --- | --- |
| plan | 要求 digest + 模板 digest + 封面 + 任务 + 选项 | 要求或模板变化 |
| project | course + title | 显示 `reuse=false` 或 requirements digest 变化时手动控制 |
| build | rendererVersion + planId + templateDigest + sectionHashes + outputPath + dedupe | 任一章节内容、模板或输出路径变化 |
| history | scope + workspace DOCX fingerprint | DOCX mtime/size 变化或超过 24 小时 |
| templates | 模板文件摘要 | 模板文件变化 |

增量生成不会因为只改一节而重新渲染全部逻辑内容；但 DOCX 文件本身仍会重新生成，保证输出文件与最新章节一致。

## 7. 历史提取

历史来源：

1. 工作区 DOCX：标题、字数、段落数、表格数、图片数、章节标题、样式、页面尺寸
2. DSH session 日志：`session.v4.jsonl.zstd` 等，按 zstd 帧解压
3. 用户消息与工具调用中的 docx 路径引用
4. 与报告相关的关键词片段

只提取结构化摘要，不保存全文。插件自己的测试输出与缓存目录会被排除。历史索引用于：

- 新报告选择章节标题风格
- 提示历史报告中出现过的标题、样式、关键词
- 记录曾经引用过的 DOCX 路径

## 8. 校验规则

`validateBuild` 检查：

- 必填封面字段
- 必备章节标题是否存在
- 占位符与禁用文本
- 总字数与章节字数
- 重复率
- 超长段落
- 重复标题
- 图片数量约束
- 表格/图片/段落结构指标

评分按错误与警告扣分；`ok` 只在没有 error 时为 true。

## 9. 安全与质量边界

- 输出路径默认必须在 session workspace 内
- 图片路径默认必须在 workspace 内
- 缺失封面字段返回 `missingCover`，不用默认值猜测姓名、学号、班级、日期
- 必填章节缺失时渲染可见占位符，并由校验报错
- Python 渲染器只读写请求/结果文件与目标 DOCX，不访问网络
- 工具结果默认最多 `maxOutputChars`，完整结构留在磁盘缓存

## 10. 已知限制

- 未进行页面级视觉渲染：本机没有 LibreOffice Kit sidecar
- 原生 Config schema 在本地链接包中可能不可用；此时以 `config.schema.json` 和运行时校验为准
- 会话日志增量索引采用 24 小时 TTL，避免当前会话日志频繁触发全量扫描
- Word 与 LibreOffice 的排版细节可能不同；模板控制的是 Word 可识别的页面、字体、表格与字段

## 11. 扩展点

- 新增模板：`templates/` 或 `templateDir`
- 默认模板覆盖：`templateOverlayDir`
- 新增校验规则：`src/validate.js`
- 新增内容 block：`src/content.js` + `renderer/report_tool.py`
- 新增历史源：`src/history.js`
- 调整缓存策略：`src/cache.js` + `src/engine.js`
