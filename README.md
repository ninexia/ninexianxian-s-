# dsh-report-docx

把“实验要求文本 + 章节内容”变成结构化 DOCX 实验报告的 **DeepSeek Harness 插件**。

目标不是替你写实验数据，而是把**历史报告结构、排版规格、章节模板、字段规则、校验规则**全部模板化与配置化：模型只写每节内容，已验证内容按节复用，避免重复提取和重复检查。

---

## 版本与更新

当前版本：**v0.4.1**（课程模板 + 结构直渲染 + 目录页/页眉页脚 + 文档检索）

> 版本号约定：日常改动按 patch 递增（v0.4.1、v0.4.2…），只有接口或结构明显变化时才升 minor。

最近两版：

- **v0.4.0**：新增 `action=search`，读旧报告只取命中的大纲 / 片段 / 单节；同一份 15,059 字的报告从 12,886 tok 降到 147–606 tok。
- **v0.3.0**：按课程学模板（`action=template`）；正文改为结构直渲染——图片真嵌入、封面独立成页、页眉页脚页码、可选目录域；`plan → build → validate` 返回体积降 68%。

完整历史与逐版修复清单见 [CHANGELOG.md](CHANGELOG.md)。

> 修改插件源码后需禁用再启用插件（或重启 DSH），宿主才会加载新代码。

---

## 能力

- `report_docx` Host 工具：`status | plan | build | validate | template | search`
- 文档检索：大纲 / 关键词片段 / 单节全文三档，读旧报告不必整份灌进上下文
- 课程模板：把旧报告 DOCX 学成模板，同一门课下次直接用它的章节与封面
- 结构直渲染：封面独立成页、图片真嵌入、页眉页脚页码、可选目录域
- 模板驱动排版：A4 页面、页眉页脚、目录、封面字段、一级/二级章节、任务组、表格/图片/代码块
- 历史会话与历史 DOCX 提取：章节标题、样式、关键词、相关片段、docx 引用路径
- 计划缓存、项目章节缓存、构建缓存、历史索引缓存
- 增量生成：只传变化的章节，其他章节自动复用
- 内容去重：段落到表格行级精确去重，可选跨节近似去重
- 输出校验：封面字段、必备标题、占位符、禁用文本、字数、重复率、超长段落、图片数量
- 安全边界：输出与图片默认限制在当前工作区内；缺失封面字段会报告，不猜测个人数据

## 安装

在当前 DSH profile 中安装：

```bash
plugin_manager action=install_bundle target=D:\deepseek-harness\default-workspace\dsh-report-plugin
```

安装后 Host 工具名为 `report_docx`。

**运行时要求**：Node.js 与 npm；插件目录内执行 `npm install`（依赖 `docx@^8.5.0`）。渲染在进程内完成，不需要 Python。

## 配置

插件配置写在 profile patch 中；完整字段见 [config.schema.json](dsh-report-plugin/config.schema.json)。

```yaml
- insert:
    - id: report-docx
      name: '@local/dsh-report-docx'
      config:
        defaultTemplate: lab-report
        autoIngest: true
        outputDir: reports
        cacheDir: .dsh-report-cache
        dedupe:
          enabled: true
          acrossSections: false
        validation:
          enabled: true
```

常用配置：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `defaultTemplate` | `lab-report` | 未指定模板且要求文本无强匹配时使用 |
| `templateDir` | `null` | 额外模板目录；相对路径按工作区解析 |
| `templateOverlayDir` | `.dsh-report-templates` | 项目级模板覆盖目录 |
| `outputDir` | `reports` | 默认输出目录 |
| `cacheDir` | `.dsh-report-cache` | 计划、项目、构建与历史缓存 |
| `pythonPath` | 自动检测 | **v0.2.0 已不使用**，仅为兼容保留 |
| `maxOutputChars` | `12000` | 返回给模型的文本上限；完整数据留在磁盘 |
| `allowOutsideWorkspace` | `false` | 是否允许输出或图片走出工作区 |
| `autoIngest` | `true` | 首次 plan/status 时按需刷新历史索引 |
| `history.enabled` | `true` | 是否启用历史提取 |
| `dedupe.acrossSections` | `false` | 是否跨节去掉近似重复段落 |
| `validation.*` | 见 schema | 校验阈值与禁用文本 |

## 使用流程

### 1. 查看状态

```jsonc
report_docx action=status
```

返回默认模板、模板清单（含已学课程模板的 `course` 与来源 `from`）、历史索引摘要，以及下一步提示。`force: true` 会强制重扫历史索引。

### 2. 生成计划

```jsonc
report_docx action=plan requirements="<完整实验要求>"
```

`plan` 会：规范化要求文本 → 按关键词给模板打分选模板 → 提取封面字段/实验题目/任务行 → 生成章节计划与字数预算 → 按需刷新历史索引 → 写入计划缓存并返回 `planId`。

示例要求文本（片段）：

```text
实验名称：基于 Spring MVC 的用户登录模块
课程名称：Java EE 程序设计
学期：2026/2027(1)
姓名：示例
学号：2026000001
班级：软工2402
任课教师：示例教师
提交日期：2026.10.24
任务1 搭建工程与依赖
任务2 编写登录控制器与业务层
一、实验目的：……
二、实验环境：……
```

### 3. 写章节并构建

`sections` 是“章节 id → 内容”映射，内容支持字符串数组与结构化对象：

```jsonc
report_docx action=build planId="rpt_xxx" outPath="reports/example.docx" sections={
  "purpose": { "bullets": ["掌握 Spring MVC 请求处理流程。", "完成登录模块联调。"] },
  "environment": {
    "table": {
      "caption": "实验环境与工具清单",
      "headers": ["类别", "工具", "版本"],
      "rows": [["操作系统", "Windows", "11"], ["容器", "Tomcat", "10.1"]]
    }
  },
  "content": ["实现用户登录模块，并补充参数绑定示例。"],
  "principle": {
    "paragraphs": ["DispatcherServlet 接收请求并委派给控制器。"],
    "code": { "caption": "控制器示例", "text": "@PostMapping(\"/login\")\npublic String login(@RequestParam String username) {}" }
  },
  "process.task-1": ["建立工程结构并配置依赖。"],
  "summary": ["总结完成情况、收获与不足。"]
}
```

支持的 block：

- 字符串数组 / `paragraphs`：普通段落
- `bullets` / `numbered`：列表
- `table`：`caption` + `headers` + `rows`
- `image`：`path` + `caption` + 可选 `width`（厘米，按原图比例缩放）
- `code`：`caption` + `text`
- `note`：提示性段落
- `blocks`：上述 block 的显式数组

篇幅够长时是否插目录由模板的 `toc.enabled` + `toc.minSections` 决定；单次强制开关用 `options={ "includeToc": true }`（或 `false`）。

### 4. 增量生成

同一 `planId` 再次 build 时，只传变化的章节：

```jsonc
report_docx action=build planId="rpt_xxx" sections={ "summary": ["更新后的总结。"] } options={ "reuse": true }
```

- `reuse: true`：沿用同一 requirements digest 或同一 plan 的已有章节
- `reuse: false`：丢弃旧章节，只使用本次传入章节
- 未传且未缓存的必备章节会显示成 `【待补充：...】`，校验报错

### 5. 校验

```jsonc
report_docx action=validate path="reports/example.docx" planId="rpt_xxx"
```

带 `planId` 时按计划校验；不带时做通用结构校验。

### 6. 学习课程模板

```jsonc
report_docx action=template path="过去的某门课实验报告.docx" course="人机交互"
```

从旧报告抽章节骨架与封面字段，写到 `.dsh-report-templates/<id>.json`；`id` 由课程名决定（常见课程有固定缩写：`hci`/`se`/`os`/`ai`/`javaee`…），也可用 `templateId` 指定。同一课程再学一次会递增 `version`。

之后 `plan` 只要带 `course`（或不带也行——要求文本里的“课程名称：”会被识别），就会命中该课程模板，返回 `via: "course"`。优先级：显式 `templateId` > 课程名匹配 > 关键词打分 > 默认模板。

历史索引仍会自动扫描旧 DOCX 用于章节/关键词统计（缓存 24 小时）；`ingest` 动作已并入 `status`/`plan` 的按需刷新，`force: true` 可强制重扫。

### 7. 检索文档内容

读一份旧报告不需要把整份正文搬进上下文，按需取三档：

```jsonc
// 只看结构：章节、层级、每节字数
report_docx action=search path="实验报告.docx" mode="outline"

// 找关键词：返回命中段落 + 所在章节 + 前后 60 字片段
report_docx action=search path="实验报告.docx" query="并发 锁"          // 空格=AND
report_docx action=search path="实验报告.docx" query="并发" limit=3 offset=6

// 只读某一节：按标题模糊命中，返回该节正文（默认上限 2000 字）
report_docx action=search path="实验报告.docx" mode="section" query="实验总结"
```

实测（15,059 字的《人机交互和界面设计》实验报告）：

| 方式 | 进入上下文的量 |
| --- | --- |
| 整份正文 | 18,963 字符 ≈ 12,886 tok |
| `mode=outline` | 408 字符 ≈ **147 tok**（5 节 + 每节字数） |
| `mode=text`（"AI"，11 命中取 6） | 686 字符 ≈ **292 tok** |
| `mode=section`（实验总结） | 988 字符 ≈ 606 tok |

- 文件仍在本地整体解析（不花 token），只有命中的片段返回；文档没有 Word 标题样式时按 `一、`/`第X章` 推断层级。
- 命中为空会返回 `hint`；`next: "offset=N"` 表示还有下一页。

## 模板

内置模板：

| id | 适用场景 |
| --- | --- |
| `lab-report` | 通用课程实验报告 |
| `lab-report-compact` | 2—4 页短报告 |
| `requirements-analysis` | 需求分析/建模实验报告 |

自定义模板放在 `templateDir`，文件名即模板 id，schema 见 [templates/template.schema.json](dsh-report-plugin/templates/template.schema.json)。覆盖目录中与内置模板同 id 的 JSON 会与内置模板做浅合并，适合“默认模板 + 少量章节覆盖”。

`action=template` 学到的课程模板同样落在 `.dsh-report-templates/`，格式与手写模板完全一致，可以手动改；这些是工作区级数据，已加入 `.gitignore`，不会随仓库提交。

最小模板示例：

```json
{
  "id": "short-report",
  "name": "短报告",
  "priority": 20,
  "match": { "keywords": { "实验": 2 } },
  "page": { "size": "A4", "orientation": "portrait", "margins": { "top": 1, "bottom": 1, "left": 1.1, "right": 1.1 } },
  "styles": { "body": { "eastAsia": "宋体", "latin": "Times New Roman", "size": 10.5 } },
  "cover": { "enabled": false },
  "sections": [
    { "id": "purpose", "title": "一、目的", "level": 1, "kind": "list", "required": true, "minWords": 30 },
    { "id": "summary", "title": "二、总结", "level": 1, "kind": "paragraphs", "required": true, "minWords": 50 }
  ]
}
```

## 验收

离线跑一遍（不联网）：`node dsh-report-plugin/tests/acceptance.mjs`，当前覆盖：

- `status` 列出内置模板与默认模板
- `plan` 提取封面、任务分节、选择模板
- `build` 渲染段落 / 列表 / 表格 / 代码 / 图片，并通过校验
- 增量 build 复用章节，相同输入命中构建缓存
- 未知 section id 告警、输出路径越界被拒绝
- 跨节重复段落被去除
- 历史索引扫描后第二次命中缓存
- 学模板 → 同课程命中（`via=course`）→ 出报告
- `search` 的 outline / 关键词命中 / 无命中提示 / 单节读取

## 目录结构

```text
# 仓库根
README.md                 # 本文件（GitHub 首页）
.gitignore
dsh-report-plugin/        # 插件本体
  package.json
  cordis.patch.yml
  config.schema.json
  index.js
  icon.svg
  locale/en.json
  locale/zh.json
  DESIGN.md               # 设计文档
  templates/
    report.md             # Markdown 模板（v0.2.0 遗留，现走结构直渲染）
    registry.json
    template.schema.json
    lab-report.json
    lab-report-compact.json
    requirements-analysis.json
  src/
    plugin.js             # DSH apply / tool / system prompt
    engine.js             # status/plan/build/validate/template/search
    learn.js              # 课程 DOCX -> 模板 JSON
    search.js             # DOCX 大纲 / 片段检索 / 单节读取
    markdown2docx.js      # blocks -> DOCX 渲染 + 纯 JS DOCX 检查
    config.js             # 配置默认值、规范化
    templates.js          # 内置/扩展/覆盖模板加载与校验
    plan.js               # 要求解析、模板评分、章节计划
    content.js            # 章节规范化、去重、占位符
    validate.js           # 输出校验
    history.js            # 历史 DOCX 与 session 提取
    cache.js              # 磁盘缓存布局
    util.js
    render.js             # v0.1.0 遗留（v0.2.0 起不再调用）
  renderer/
    report_tool.py        # v0.1.0 遗留（v0.2.0 起不再调用）
  tests/
    acceptance.mjs
    smoke.mjs
    test_md2docx.mjs      # v0.2.0 新增
    fixtures/requirements.md
```

## 文档

- 更新日志：[CHANGELOG.md](CHANGELOG.md)
- 设计文档：[dsh-report-plugin/DESIGN.md](dsh-report-plugin/DESIGN.md)
- 配置字段：[dsh-report-plugin/config.schema.json](dsh-report-plugin/config.schema.json)
- 模板格式：[dsh-report-plugin/templates/template.schema.json](dsh-report-plugin/templates/template.schema.json)
