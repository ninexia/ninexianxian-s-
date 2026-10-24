#!/usr/bin/env node

import { markdownToDocx, inspectDocx } from '../src/markdown2docx.js';
import { writeFile, unlink } from 'node:fs/promises';

const testMarkdown = `# 实验报告

## 封面

> **课程名称**：Java EE 程序设计
> **学生姓名**：张三
> **学号**：123456
> **班级**：软工2402
> **提交日期**：2026-10-24

---

## 实验目的

掌握 Spring MVC 请求处理流程。

## 实验环境

| 工具 | 版本 | 用途 |
|------|------|------|
| Windows | 11 | 操作系统 |
| Tomcat | 10.1 | 运行环境 |

## 实现过程

1. 建立工程结构并配置依赖
2. 实现用户登录模块
3. 添加测试用例

*本报告由测试工具生成*
`;

try {
  const outputPath = './test_output.docx';
  
  console.log('开始生成 Markdown -> Docx 测试...');
  
  const result = await markdownToDocx(testMarkdown, outputPath);
  console.log('生成结果:', result);
  
  if (result.ok) {
    const inspect = await inspectDocx(outputPath);
    console.log('检查报告:', inspect);
    
    // 清理测试文件
    // await unlink(outputPath);
    // console.log('测试文件已清理');
  } else {
    console.error('生成失败:', result.error);
    process.exit(1);
  }
  
} catch (error) {
  console.error('测试出错:', error);
  process.exit(1);
}
