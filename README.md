# dsh-report-docx

把“实验要求文本 + 章节内容”变成结构化 DOCX 实验报告的 **DeepSeek Harness 插件**。

目标不是替你写实验数据，而是把**历史报告结构、排版规格、章节模板、字段规则、校验规则**全部模板化与配置化：模型只写每节内容，已验证内容按节复用，避免重复提取和重复检查。

---

## 版本与更新

当前版本：**v0.2.0**（Markdown 模板 + 纯 JS 渲染）

### v0.1.0 → v0.2.0 对比

| 维度 | v0.1.0（初代） | v0.2.0（当前） |
| --- | --- | --- |
| 渲染方式 | Python 子进程 + `python-docx` | 进程内纯 JS，`docx` npm 包 |
| 内容中间形态 | 结构化 sections 直接进渲染器 | 先序列化为 Markdown，再渲染 DOCX |
| 新增文件 | — | `src/markdown2docx.js`、`templates/report.md` |
| 运行时依赖 | Python 环境（DSH 自带即可） | Node.js + `npm install docx` |
| 安装后 `status` | 报告 Python 探测结果 | 报告 `renderer: markdown2docx` |
| 构建缓存键 | `rendererVersion: 0.1.0` | `rendererVersion: 0.2.0`（旧缓存自动失效） |
| npm `files` | 含 `renderer/*.py` | 含 `templates/*.md`，不含 Python 渲染器 |

### v0.2.0 变更清单

- 新增 Markdown 模板 `templates/report.md`，章节内容与排版分离。
- 新增 `src/markdown2docx.js`：Markdown → DOCX 的纯 JS 渲染器（标题、段落、列表、表格、代码块）。
- `build` 流程改为：`sections → Markdown → DOCX`，不再启动 Python 子进程。
- `status` 增加 `renderer` 字段，版本号同步为 `0.2.0`。
- 章节 block 序列化支持：`paragraphs / bullets / numbered / table / code / note / image(仅标题占位)`。

### 保持不变

`report_docx` 的五个动作（`status | plan | build | validate | ingest`）、模板 registry 与覆盖机制、计划/项目/构建/历史四级缓存、段落级去重、输出校验规则、工作区安全边界。

### v0.2.0 已知限制

- **图片不内嵌**：Markdown 路径目前不会把图片写入 DOCX，仅在有 `caption` 时输出“（图：…）”占位文字；需要真实嵌图请暂用 v0.1.0 或等后续版本。
- `src/render.js`、`renderer/report_tool.py` 是 v0.1.0 遗留代码，v0.2.0 不再调用（保留以便回退）。
- `config.pythonPath` 仍可配置，但 v0.2.0 不生效。
- `tests/acceptance.mjs` 按 v0.1.0 行为编写，v0.2.0 需重跑并按需调整断言。

### v0.2.0 修复公告（2026-10-25）

v0.2.0 发布之初，`markdown2docx` 渲染链路存在多处缺陷，插件可安装但 `plan → build` 无法跑通。现已修复以下 7 个问题：

| 序号 | 问题现象 | 位置 | 修复方式 |
| --- | --- | --- | --- |
| 1 | 插件导入即报 `SyntaxError: Unexpected token ')'` | `src/markdown2docx.js` | 删除两处多余右括号 |
| 2 | `ERR_MODULE_NOT_FOUND: Cannot find package 'docx'` | `package.json` | 安装 `docx@8.5.0` |
| 3 | 调用 `markdownToDocx` 时报 `is not defined` | `src/engine.js` | import 补充 `markdownToDocx` |
| 4 | 渲染报 `Cannot read properties of undefined (reading '0')` | `src/markdown2docx.js` | docx v8 的 `Document` 不暴露 `.sections`，改为构造时一次性传入 `children` |
| 5 | 列表只渲染第一项；列表无编号定义 | `src/markdown2docx.js` | 每项独立成段，并配置 `bullet-list` / `number-list` 编号 |
| 6 | 校验必报 `DOCX inspect failed`（`Document.fromBuffer` 不存在） | `src/markdown2docx.js` | 重写 `inspectDocx` 为纯 JS：`node:zlib` 解 ZIP + 解析 `word/document.xml`，零新增依赖 |
| 7 | 封面字段为空、五行挤成一行 | `src/engine.js` | 键名改为 `className`/`date`，每字段独立成段 |

修复后验证：`report_docx action=status` 返回 `ok: true`；实际生成 13 节实验报告（约 2066 字），校验 85 分（唯一缺项为用户未提供的学号/班级）；单次 `build` 渲染 15–22 ms。

> 注意：修改插件源码后需禁用再启用插件（或重启 DSH），宿主才会加载新代码。

---

## 能力

- `report_docx` Host 工具：`status | plan | build | validate | ingest`
- Markdown 模板：章节内容以 Markdown 组织，Token 消耗更低、便于版本控制
- 模板驱动排版：A4 页面、页眉页脚、封面字段、一级/二级章节、任务组、表格/图片/代码块、目录字段
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

**运行时要求**：Node.js 与 npm；插件目录内执行 `npm install`（安装 `docx` 依赖）。v0.2.0 不再使用 Python。

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

返回模板清单、渲染器信息、缓存目录、历史索引摘要与当前配置。

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
- `image`：`path` + `caption` + 可选 `width`（v0.2.0 仅输出标题占位，见已知限制）
- `code`：`caption` + `text`
- `note`：提示性段落
- `blocks`：上述 block 的显式数组

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

### 6. 历史提取

```jsonc
report_docx action=ingest scope="all" force=true
```

`scope` 可选 `all | workspace | sessions`。历史索引缓存有效期 24 小时；工作区 DOCX 的时间戳或大小变化会触发重新扫描。

## 模板

内置模板：

| id | 适用场景 |
| --- | --- |
| `lab-report` | 通用课程实验报告 |
| `lab-report-compact` | 2—4 页短报告 |
| `requirements-analysis` | 需求分析/建模实验报告 |

自定义模板放在 `templateDir`，文件名即模板 id，schema 见 [templates/template.schema.json](dsh-report-plugin/templates/template.schema.json)。覆盖目录中与内置模板同 id 的 JSON 会与内置模板做浅合并，适合“默认模板 + 少量章节覆盖”。

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

## 验收清单

v0.1.0 已验证项（v0.2.0 需重跑）：

- [x] 模板清单可用
- [x] `plan` 能提取封面、任务并选择 `lab-report`
- [x] `build` 能渲染段落、列表、表格、代码、图片，并通过校验
- [x] 增量 build 复用章节，只重传变化章节
- [x] 相同输入命中构建缓存
- [x] 未知 section id 产生警告
- [x] 输出路径越界被拒绝
- [x] 需求分析要求选择 `requirements-analysis`
- [x] 跨节重复段落被去除
- [x] 历史索引扫描后第二次命中缓存

v0.2.0 待验证：`status` 渲染器字段、Markdown 序列化（列表/表格/代码块）、`docx` 依赖安装、构建缓存失效。

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
  README.md               # 详细使用说明
  DESIGN.md               # 设计文档
  templates/
    report.md             # v0.2.0 新增 Markdown 模板
    registry.json
    template.schema.json
    lab-report.json
    lab-report-compact.json
    requirements-analysis.json
  src/
    plugin.js             # DSH apply / tool / system prompt
    engine.js             # status/plan/build/validate/ingest
    markdown2docx.js      # v0.2.0 新增：Markdown → DOCX
    config.js             # 配置默认值、规范化
    templates.js          # 内置/扩展/覆盖模板加载与校验
    plan.js               # 要求解析、模板评分、章节计划
    content.js            # 章节规范化、去重、占位符
    validate.js           # 输出校验
    history.js            # 历史 DOCX 与 session 提取
    cache.js              # 磁盘缓存布局
    util.js
    schema.js
    render.js             # v0.1.0 遗留（v0.2.0 不再调用）
  renderer/
    report_tool.py        # v0.1.0 遗留（v0.2.0 不再调用）
  tests/
    acceptance.mjs
    smoke.mjs
    test_md2docx.mjs      # v0.2.0 新增
    fixtures/requirements.md
```

## 文档

- 详细使用说明：[dsh-report-plugin/README.md](dsh-report-plugin/README.md)
- 设计文档：[dsh-report-plugin/DESIGN.md](dsh-report-plugin/DESIGN.md)
- 配置字段：[dsh-report-plugin/config.schema.json](dsh-report-plugin/config.schema.json)
- 模板格式：[dsh-report-plugin/templates/template.schema.json](dsh-report-plugin/templates/template.schema.json)
