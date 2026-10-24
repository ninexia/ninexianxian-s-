# dsh-report-docx

把“实验要求文本 + 章节内容”变成结构化 DOCX 实验报告的 **DeepSeek Harness 插件**。

Markdown 模板驱动，纯 JavaScript 渲染，不需要 Python，也不依赖 Pandoc。

## 能力

- `report_docx` Host 工具：`status | plan | build | validate | ingest`
- Markdown 模板：章节内容与排版分离，Token 消耗更低
- 模板驱动排版：A4 页面、页眉页脚、封面字段、多级章节、任务组、表格/图片/代码块
- 增量生成：只传变化的章节，其余自动复用缓存
- 内容去重：段落到表格行级精确去重，可选跨节近似去重
- 输出校验：封面字段、必备标题、占位符、禁用文本、字数、重复率、超长段落
- 安全边界：输出与图片默认限制在当前工作区内，缺失封面字段只报告不猜测

## 安装

```bash
plugin_manager action=install_bundle target=D:\deepseek-harness\default-workspace\dsh-report-plugin
```

运行环境需要 Node.js 与 npm；安装后 Host 工具名为 `report_docx`。

## 快速使用

```jsonc
// 1. 查看状态
report_docx action=status

// 2. 生成计划
report_docx action=plan requirements="<完整实验要求>"

// 3. 写章节并构建
report_docx action=build planId="rpt_xxx" outPath="reports/example.docx" sections={
  "purpose": { "bullets": ["掌握核心流程。", "完成模块联调。"] },
  "summary": ["总结完成情况与不足。"]
}

// 4. 校验
report_docx action=validate path="reports/example.docx" planId="rpt_xxx"
```

## 文档

- 完整使用说明：[dsh-report-plugin/README.md](dsh-report-plugin/README.md)
- 设计文档：[dsh-report-plugin/DESIGN.md](dsh-report-plugin/DESIGN.md)
- 配置字段：[dsh-report-plugin/config.schema.json](dsh-report-plugin/config.schema.json)
- 模板格式：[dsh-report-plugin/templates/template.schema.json](dsh-report-plugin/templates/template.schema.json)

## 版本

当前版本 `0.2.0`：引入 Markdown 模板与纯 JS Docx 渲染，移除 Python 依赖。
