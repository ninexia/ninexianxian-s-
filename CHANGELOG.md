# 更新日志

版本号约定：日常改动按 patch 递增（0.4.1、0.4.2…），只有接口或结构明显变化时才升 minor。

## v0.4.1（2026-11-08）

- 文档：README 合并为单一文件（删除 `dsh-report-plugin/README.md`），历史细节移入本文件
- 文档：修正 `status` 返回、`image` block、验收清单中与实现不符的描述；补回 `options.includeToc`
- 文档：DESIGN.md 重写为当前架构（结构直渲染 + 课程模板 + 文档检索）
- 修复：`config.js` 不再强制校验 `renderer/report_tool.py` 与 Python 是否存在——v0.3 起渲染在进程内完成，缺文件不应导致初始化失败
- 清理：删除未被引用的 `src/schema.js`

## v0.4.0（2026-11-08）：按需读文档

新增 `action=search`：读旧报告时不再把整份正文塞进上下文，按需取三档——`outline` 看章节结构、`text` 取关键词命中片段、`section` 只读某一节全文。

实测同一份 15,059 字的实验报告：整份正文 ≈ 12,886 tok，大纲 147 tok，关键词检索 292 tok，单节全文 606 tok。

文件仍本地整体解析（不耗 token），返回的只有命中片段；没有 Word 标题样式的文档会按 `一、`/`第X章` 推断标题层级。

## v0.3.0（2026-11-08）：课程模板 + 结构直渲染

**按课程学模板**：把以前交过的某门课报告 DOCX 喂给 `action=template`，抽出章节骨架与封面字段存成模板；之后同一门课的报告直接复用该结构。

```js
report_docx action=template path="某门课的旧实验报告.docx" course="人机交互"
report_docx action=plan requirements="..." course="人机交互"   // 自动命中 hci 模板
```

- 章节：Word 标题样式优先，否则识别 `一、`/`二、`；字数换算成每节预算（40–400）。
- 封面：只把课程名写成默认值，姓名/学号/日期一律不落进模板。
- 位置：工作区 `.dsh-report-templates/<id>.json`，也接受手写 JSON。

**渲染重构**：正文从结构化 blocks 直出 DOCX，不再走 Markdown 往返。

| 能力 | v0.2.0 | v0.3.0 |
| --- | --- | --- |
| 图片 | 仅输出「（图：…）」占位 | 真正嵌入（PNG/JPEG/GIF/BMP，按比例缩放） |
| 封面 | 五行引用块挤在正文开头 | 独立成页，字号/字段按模板 |
| 页眉 | 丢弃 | 右对齐 + 下边框，`{{course}}` 等占位替换 |
| 页脚 | 丢弃 | 「第 X 页 / 共 Y 页」（PAGE/NUMPAGES 域） |
| 目录 | 丢弃 | `toc.enabled` 达标时插入 TOC 域 + 自动分页 |
| 页面 | 边距参数名写错，模板值从未生效 | A4/横竖版/页边距/页眉页脚距按模板 |

**输出体积**：同一份要求跑 `plan → build → validate`，返回 token 从 ~2757 降到 ~881（-68%）；工具定义从 ~1180 降到 ~930。

- 结果改紧凑 JSON；`validate` 不再三份重复；`build` 返回缺失章节 **id 列表**（以前只给数量）；
- `status`/`plan` 去掉 `description`、`coverSources`、`candidates`、`stats`、`cache`；
- 参数表移除 `scope`、`ingest`、`includeSections`、`excludeSections`、`keepSectionTogether`、`templateOverrides` 与重复的 `force`。

**修复**：`build` 输出目录不存在时不再报 `RENDER_FAILED`；封面页不再重复页眉页脚（`titlePage`）；写入 `updateFields` 让 Word 打开时刷新目录域。

> 目录页码要由 Word/WPS 排版时计算，首次打开请允许「更新域」。

## v0.2.0（2026-10-25）：纯 JS 渲染

| 维度 | v0.1.0（初代） | v0.2.0 |
| --- | --- | --- |
| 渲染方式 | Python 子进程 + `python-docx` | 进程内纯 JS，`docx` npm 包 |
| 内容中间形态 | 结构化 sections 直接进渲染器 | 先序列化为 Markdown，再渲染 DOCX |
| 新增文件 | — | `src/markdown2docx.js`、`templates/report.md` |
| 运行时依赖 | Python 环境（DSH 自带即可） | Node.js + `npm install docx` |
| 安装后 `status` | 报告 Python 探测结果 | 报告 `renderer: markdown2docx` |
| 构建缓存键 | `rendererVersion: 0.1.0` | `rendererVersion: 0.2.0`（旧缓存自动失效） |

变更：

- 新增 Markdown 模板 `templates/report.md`，章节内容与排版分离。
- 新增 `src/markdown2docx.js`：Markdown → DOCX 的纯 JS 渲染器（标题、段落、列表、表格、代码块）。
- `build` 流程改为 `sections → Markdown → DOCX`，不再启动 Python 子进程。
- 章节 block 序列化支持：`paragraphs / bullets / numbered / table / code / note / image(仅标题占位)`。

v0.2.0 发布之初渲染链路存在多处缺陷（插件可安装但 `plan → build` 跑不通），同日修复：

| 序号 | 问题现象 | 位置 | 修复方式 |
| --- | --- | --- | --- |
| 1 | 插件导入即报 `SyntaxError: Unexpected token ')'` | `src/markdown2docx.js` | 删除两处多余右括号 |
| 2 | `ERR_MODULE_NOT_FOUND: Cannot find package 'docx'` | `package.json` | 安装 `docx@8.5.0` |
| 3 | 调用 `markdownToDocx` 时报 `is not defined` | `src/engine.js` | import 补充 |
| 4 | 渲染报 `Cannot read properties of undefined (reading '0')` | `src/markdown2docx.js` | docx v8 的 `Document` 不暴露 `.sections`，改为构造时一次性传入 `children` |
| 5 | 列表只渲染第一项、无编号定义 | `src/markdown2docx.js` | 每项独立成段 + 配置 `bullet-list` / `number-list` 编号 |
| 6 | 校验必报 `DOCX inspect failed` | `src/markdown2docx.js` | 重写 `inspectDocx` 为纯 JS：`node:zlib` 解 ZIP + 解析 `word/document.xml` |
| 7 | 封面字段为空、五行挤成一行 | `src/engine.js` | 键名改为 `className`/`date`，每字段独立成段 |

修复后验证：实际生成 13 节实验报告（约 2066 字），校验 85 分；单次 `build` 渲染 15–22 ms。

## v0.1.0（初版）

Python 子进程 + `python-docx` 渲染；模板 registry 与覆盖机制；`plan / build / validate / ingest` 四步流程；计划、项目、构建、历史四级缓存；段落级去重与输出校验。
