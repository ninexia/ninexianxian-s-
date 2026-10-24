import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType } from 'docx';
import { readFile, writeFile } from 'node:fs/promises';

// 默认字体配置
const DEFAULT_FONT = {
  latin: 'Times New Roman',
  eastAsia: '宋体',
  size: 10.5
};

// Markdown 解析器（简化版）
function parseMarkdown(markdown) {
  const blocks = [];
  const lines = markdown.split('\n');
  let currentParagraph = [];
  let currentHeading = null;
  let currentList = { items: [], ordered: false };
  let currentTable = null;
  let inCodeBlock = false;
  let codeBlockText = '';

  const addParagraph = (text) => {
    if (text.trim()) {
      blocks.push({ type: 'paragraph', text: text.trim() });
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    
    if (!trimmed) {
      if (currentHeading) {
        blocks.push(currentHeading);
        currentHeading = null;
      }
      if (currentList.items.length) {
        blocks.push({ type: currentList.ordered ? 'numbered' : 'bullets', items: currentList.items });
        currentList = { items: [], ordered: false };
      }
      if (inCodeBlock) {
        blocks.push({ type: 'code', text: codeBlockText.trim() });
        inCodeBlock = false;
        codeBlockText = '';
      }
      if (currentTable) {
        blocks.push(currentTable);
        currentTable = null;
      }
      continue;
    }

    // 标题
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      if (currentHeading) blocks.push(currentHeading);
      currentHeading = { type: 'heading', level: headingMatch[1].length, text: headingMatch[2] };
      continue;
    }

    // 表格
    if (trimmed.startsWith('|') || currentTable) {
      if (!currentTable) {
        currentTable = { type: 'table', headers: trimmed.split('|').filter(c => c.trim()).map(c => c.trim()), rows: [] };
      } else if (trimmed.includes('|')) {
        const cells = trimmed.split('|').filter(c => c.trim()).map(c => c.trim());
        if (cells.length > 0 && (/^[:=|-]+$/.test(cells.join('')))) {
          continue;
        }
        currentTable.rows.push(cells);
      }
      continue;
    }

    // 列表
    const listMatch = trimmed.match(/^[-*+]\s+(.+)$|^\d+\.\s+(.+)$/);
    if (listMatch) {
      const ordered = /^\d+\. /i.test(trimmed);
      if (!currentList.items.length || ordered !== currentList.ordered) {
        if (currentList.items.length) blocks.push({ type: currentList.ordered ? 'numbered' : 'bullets', items: currentList.items });
        currentList = { items: [], ordered };
      }
      currentList.items.push(trimmed.substring(listMatch[0].length).trim());
      continue;
    }

    // 代码块
    if (trimmed.startsWith('```') || inCodeBlock) {
      if (inCodeBlock && trimmed === '```') {
        blocks.push({ type: 'code', text: codeBlockText.trim() });
        inCodeBlock = false;
        codeBlockText = '';
      } else if (inCodeBlock) {
        codeBlockText += trimmed + '\n';
      } else {
        inCodeBlock = true;
        codeBlockText = trimmed + '\n';
      }
      continue;
    }

    // 普通段落
    if (currentHeading) {
      currentHeading.text += ' ' + trimmed;
    } else {
      currentParagraph.push(trimmed);
    }
  }

  // 刷新剩余内容
  if (currentParagraph.length) blocks.push({ type: 'paragraph', text: currentParagraph.join(' ') });
  if (currentHeading) blocks.push(currentHeading);
  if (currentList.items.length) blocks.push({ type: currentList.ordered ? 'numbered' : 'bullets', items: currentList.items });
  if (inCodeBlock) blocks.push({ type: 'code', text: codeBlockText.trim() });
  if (currentTable) blocks.push(currentTable);

  return blocks;
}

// 构建 Docx
async function buildDocxFromBlocks(blocks, styles = {}) {
  const doc = new Document({
    sections: [{
      properties: {
        page: { size: 'A4', orientation: 'portrait', margins: { top: 1, bottom: 1, left: 1.1, right: 1.1 } }
      },
      children: []
    }]
  });

  for (const block of blocks) {
    let child;

    switch (block.type) {
      case 'heading':
        child = new Paragraph({
          heading: block.level === 1 ? HeadingLevel.HEADING_1 : block.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
          children: [new TextRun(block.text)],
          spacing: { after: 120 }
        });
        break;

      case 'paragraph':
        child = new Paragraph({
          children: [new TextRun(block.text)],
          spacing: { after: 60 }
        });
        break;

      case 'bullets':
        child = new Paragraph({
          numbering: { reference: 'bullet-list', level: 0 },
          children: [new TextRun(block.items[0])],
          textIndent: 360,
          firstLineIndent: -180,
          spacing: { after: 60 }
        });
        break;

      case 'numbered':
        child = new Paragraph({
          number: { reference: 'number-list', level: 0 },
          children: [new TextRun(block.items[0])],
          textIndent: 360,
          firstLineIndent: -180,
          spacing: { after: 60 }
        });
        break;

      case 'table':
        const tableRows = [new TableRow({
          cells: block.headers.map(h => new TableCell({
            children: [new Paragraph({ children: [new TextRun(h)])]),
            shading: { fill: 'E8E8E8' }
          }))
        })];
        
        for (const row of block.rows || []) {
          tableRows.push(new TableRow({
            cells: row.map(cell => new TableCell({
              children: [new Paragraph({ children: [new TextRun(cell)])])
            }))
          }));
        }

        child = new Table({
          rows: tableRows,
          width: { size: 100, type: WidthType.PERCENTAGE }
        });
        break;

      case 'code':
        child = new Paragraph({
          children: [new TextRun(block.text)],
          spacing: { after: 60 },
          shading: { fill: 'F4F4F5' }
        });
        break;

      default:
        child = new Paragraph({ children: [new TextRun(block.text || '')], spacing: { after: 60 } });
    }

    if (child) doc.sections[0].children.push(child);
  }

  return doc;
}

// 输出 Docx 文件
export async function markdownToDocx(markdown, outputPath) {
  try {
    const blocks = parseMarkdown(markdown);
    const doc = await buildDocxFromBlocks(blocks);
    const buffer = await Packer.toBuffer(doc);
    await writeFile(outputPath, buffer);
    return { ok: true, bytes: buffer.length };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// 检查 Docx 文件
export async function inspectDocx(path) {
  try {
    const fs = await import('node:fs/promises');
    const { Document } = await import('docx');
    
    const stats = await fs.readFile(path);
    const fileDoc = await Document.fromBuffer(stats);
    
    // 简单参数提取
    const paragraphs = fileDoc.sections.map(s => s.children).flat().filter(c => c[0]?.segmentType === 'paragraph');
    const text = paragraphs.map(p => p.text || '').join('\n');
    
    // 检测占位符
    const placeholderRegex = /【待补充|TODO|\{\{|lorem ipsum/;
    const placeholders = [];
    const phMatch = text.match(placeholderRegex);
    if (phMatch) placeholders.push(phMatch[0]);
    
    return {
      ok: true,
      bytes: stats.length,
      paragraphs: paragraphs.length,
      headings: paragraphs.filter(p => p[0]?.heading).length,
      tables: fileDoc.tables.length,
      images: fileDoc.imageReferences.length,
      words: text.split(/\s+/).filter(Boolean).length,
      text,
      sections: [{ id: 0, title: 'Document', paragraphs: paragraphs.length }],
      placeholders
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
