# dsh-report-docx

把“实验要求文本”变成结构化 DOCX 实验报告的 DeepSeek Harness 插件。

目标不是替你写实验数据，而是把**历史报告结构、排版规格、章节模板、字段规则、校验规则**全部模板化与配置化，让模型只写每节内容，并复用已验证内容，避免重复提取和重复检查。

## 能力

- `report_docx` Host 工具：`status | plan | build | validate | ingest`
- 配置驱动模板：A4 页面、页眉页脚、封面字段、一级/二级章节、任务组、表格/图片/代码块、目录字段
- 历史会话与历史 DOCX 提取：章节标题、样式、关键词、相关片段、docx 引用路径
- 计划缓存、项目章节缓存、构建缓存、历史索引缓存
- 增量生成：只传变化的章节，其他章节自动复用
- 内容去重：段落到表格行级精确去重，可选跨节近似去重
- 输出校验：封面字段、必备标题、占位符、禁用文本、字数、重复率、超长段落、图片数量
- 安全边界：输出与图片默认限制在当前工作区内；缺失封面字段会报告，不猜测个人数据
- Markdown 模板：支持 Markdown 中间格式，Token 消耗更少

## 安装

**依赖要求**：需要在系统安装 Node.js 和 npm。

在当前 DSH profile 中安装：

```bash
plugin_manager action=install_bundle target=D:\deepseek-harness\default-workspace\dsh-report-plugin
```

安装后 Host 工具名为 `report_docx`。插件使用纯 JavaScript 渲染，无需 Python 依赖。

## 配置

插件配置写在 profile patch 中；完整字段见 [config.schema.json](config.schema.json)。

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
| `pythonPath` | 自动检测 | Python 可执行文件 |
| `maxOutputChars` | `12000` | 返回给模型的文本上限；完整数据留在磁盘 |
| `allowOutsideWorkspace` | `false` | 是否允许输出或图片走出工作区 |
| `autoIngest` | `true` | 首次 plan/status 时按需刷新历史索引 |
| `history.enabled` | `true` | 是否启用历史提取 |
| `dedupe.acrossSections` | `false` | 是否跨节去掉近似重复段落 |
| `validation.*` | 见 schema | 校验阈值与禁用文本 |

> 说明：本地链接包无法解析到 DSH 内部 `schemastery` 副本时，`src/schema.js` 会安全回退为不导出原生 Config；此时 `config.schema.json` 与 `src/config.js` 的运行时校验仍然生效。

## 使用流程

### 1. 查看状态

```jsonc
report_docx action=status
```

返回模板清单、Python 状态、缓存目录、历史索引摘要与当前配置。

### 2. 生成计划

```jsonc
report_docx action=plan requirements="<完整实验要求>"
```

`plan` 会做这些事：

1. 规范化要求文本；
2. 按关键词给模板打分并选择模板；
3. 提取封面字段、实验题目、任务行；
4. 生成章节计划、字数预算、缺失封面字段；
5. 按需刷新历史结构索引；
6. 写入计划缓存并返回 `planId`。

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

`sections` 是“章节 id -> 内容”映射。内容支持字符串数组与结构化对象：

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
  "process.task-2": { "paragraphs": ["实现核心功能。"], "image": { "path": "images/01_top_level_dfd.png", "caption": "示意图", "width": 4.5 } },
  "summary": ["总结完成情况、收获与不足。"]
}
```

支持的 block：

- 字符串数组：普通段落
- `paragraphs`：普通段落
- `bullets` / `numbered`：列表
- `table`：`caption` + `headers` + `rows`
- `image`：`path` + `caption` + 可选 `width`
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

`scope` 可选 `all | workspace | sessions`。历史索引缓存有效期为 24 小时；工作区 DOCX 的时间戳或大小变化会触发重新扫描，会话日志变化不触发频繁全量扫描。

## 模板

内置模板：

| id | 适用场景 |
| --- | --- |
| `lab-report` | 通用课程实验报告 |
| `lab-report-compact` | 2—4 页短报告 |
| `requirements-analysis` | 需求分析/建模实验报告 |

自定义模板放在 `templateDir`，文件名即模板 id，schema 见 [templates/template.schema.json](templates/template.schema.json)。覆盖目录中与内置模板同 id 的 JSON 会与内置模板做浅合并，适合“默认模板 + 少量章节覆盖”。

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

## 验收标准

执行：

```bash
"C:/Users/71985/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" \
  dsh-report-plugin/tests/acceptance.mjs
```

当前验收结果：

- [x] 模板清单与 Python 可用
- [x] plan 能提取封面、任务并选择 `lab-report`
- [x] build 能渲染段落、列表、表格、代码、图片，并通过校验
- [x] 增量 build 复用 6 个章节，只重传 summary
- [x] 相同输入命中构建缓存
- [x] 未知 section id 产生警告
- [x] 输出路径越界被拒绝
- [x] 需求分析要求选择 `requirements-analysis`
- [x] 跨节重复段落被去除，重复率为 0
- [x] 历史索引扫描后第二次命中缓存

已验证限制：本机缺少 LibreOffice Kit sidecar，因此未做 DOCX 页面级视觉渲染；内容与结构校验已通过。

## 目录结构

```text
dsh-report-plugin/
  package.json
  cordis.patch.yml
  config.schema.json
  index.js
  icon.svg
  locale/en.json
  locale/zh.json
  renderer/report_tool.py
  src/
    plugin.js     # DSH apply/tool/system prompt
    engine.js     # status/plan/build/validate/ingest
    config.js     # 配置默认值、规范化、Python 探测
    templates.js  # 内置/扩展/覆盖模板加载与校验
    plan.js       # 要求解析、模板评分、章节计划
    content.js    # 章节规范化、去重、占位符、渲染负载
    render.js     # Node/Python 进程契约
    validate.js   # 输出校验
    history.js    # 历史 DOCX 与 session 提取
    cache.js      # 磁盘缓存布局
    util.js
  templates/
    registry.json
    template.schema.json
    lab-report.json
    lab-report-compact.json
    requirements-analysis.json
  tests/
    acceptance.mjs
    smoke.mjs
    fixtures/requirements.md
```

详细设计见 [DESIGN.md](DESIGN.md)。
