import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, AlignmentType, LevelFormat
} from 'docx';
import { readFile, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

// 默认字体配置
const DEFAULT_FONT = {
  latin: 'Times New Roman',
  eastAsia: '宋体',
  size: 21 // half-points => 10.5pt
};

function cleanInline(text) {
  return String(text ?? '')
    .replace(/^\s*>\s?/, '')   // 去掉引用前缀
    .replace(/\*\*/g, '')      // 去掉加粗标记
    .trim();
}

// Markdown 解析器（简化版，面向报告生成）
function parseMarkdown(markdown) {
  const blocks = [];
  const lines = String(markdown ?? '').split('\n');
  let paraLines = [];
  let list = { items: [], ordered: false };
  let table = null;
  let inCode = false;
  let codeLines = [];

  const flushParagraph = () => {
    const text = paraLines.map(cleanInline).filter(Boolean).join(' ').trim();
    if (text) blocks.push({ type: 'paragraph', text });
    paraLines = [];
  };
  const flushList = () => {
    if (list.items.length) {
      blocks.push({ type: list.ordered ? 'numbered' : 'bullets', items: list.items.slice() });
    }
    list = { items: [], ordered: false };
  };
  const flushTable = () => {
    if (table) blocks.push(table);
    table = null;
  };
  const flushCode = () => {
    if (inCode) blocks.push({ type: 'code', text: codeLines.join('\n').trim() });
    codeLines = [];
    inCode = false;
  };

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (inCode) {
      if (trimmed === '```') flushCode();
      else codeLines.push(raw);
      continue;
    }
    if (trimmed === '```') {
      flushParagraph(); flushList(); flushTable();
      inCode = true; codeLines = [];
      continue;
    }
    if (!trimmed) {
      flushParagraph(); flushList(); flushTable();
      continue;
    }
    if (/^-{3,}$/.test(trimmed)) {
      flushParagraph(); flushList(); flushTable();
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph(); flushList(); flushTable();
      blocks.push({ type: 'heading', level: Math.min(heading[1].length, 3), text: heading[2].trim() });
      continue;
    }

    if (trimmed.startsWith('|')) {
      flushParagraph(); flushList();
      const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim());
      if (!table) {
        table = { type: 'table', headers: cells, rows: [] };
      } else if (cells.length && cells.every((c) => /^:?-{2,}:?$/.test(c))) {
        // 表头分隔行，跳过
      } else if (cells.some(Boolean)) {
        table.rows.push(cells);
      }
      continue;
    }
    if (table) flushTable();

    const bullet = trimmed.match(/^[-*+]\s+(.+)$/);
    const numbered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (list.items.length && ordered !== list.ordered) flushList();
      list.ordered = ordered;
      list.items.push((bullet ? bullet[1] : numbered[1]).trim());
      continue;
    }
    if (list.items.length) flushList();
    paraLines.push(trimmed);
  }

  flushParagraph(); flushList(); flushTable(); flushCode();
  return blocks;
}

// 构建 Docx（docx v8：children 必须在构造时一次性传入）
async function buildDocxFromBlocks(blocks) {
  const children = [];

  const listItems = (items, reference) => (items ?? []).map((item) =>
    new Paragraph({
      numbering: { reference, level: 0 },
      children: [new TextRun(String(item ?? ''))],
      spacing: { after: 60 }
    })
  );

  for (const block of blocks) {
    let child;
    switch (block.type) {
      case 'heading': {
        const level = block.level >= 3 ? HeadingLevel.HEADING_3
          : block.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1;
        child = new Paragraph({
          heading: level,
          children: [new TextRun(block.text)],
          spacing: { before: 200, after: 120 }
        });
        break;
      }
      case 'paragraph':
        child = new Paragraph({
          children: [new TextRun(block.text)],
          spacing: { after: 80 },
          alignment: AlignmentType.JUSTIFIED
        });
        break;

      case 'bullets':
        for (const p of listItems(block.items, 'bullet-list')) children.push(p);
        continue;

      case 'numbered':
        for (const p of listItems(block.items, 'number-list')) children.push(p);
        continue;

      case 'table': {
        const headers = block.headers ?? [];
        if (!headers.length) continue;
        const rows = [new TableRow({
          tableHeader: true,
          children: headers.map((h) => new TableCell({
            children: [new Paragraph({ children: [new TextRun(String(h))] })],
            shading: { fill: 'E8E8E8' }
          }))
        })];
        for (const row of block.rows ?? []) {
          rows.push(new TableRow({
            children: row.map((cell) => new TableCell({
              children: [new Paragraph({ children: [new TextRun(String(cell ?? ''))] })]
            }))
          }));
        }
        child = new Table({
          rows,
          width: { size: 100, type: WidthType.PERCENTAGE }
        });
        break;
      }

      case 'code':
        child = new Paragraph({
          children: [new TextRun({ text: block.text, font: 'Consolas', size: 18 })],
          spacing: { after: 80 },
          shading: { fill: 'F4F4F5' }
        });
        break;

      default:
        child = new Paragraph({
          children: [new TextRun(String(block.text ?? ''))],
          spacing: { after: 80 }
        });
    }
    if (child) children.push(child);
  }

  return new Document({
    numbering: {
      config: [
        {
          reference: 'bullet-list',
          levels: [{
            level: 0,
            format: LevelFormat.BULLET,
            text: '•',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } }
          }]
        },
        {
          reference: 'number-list',
          levels: [{
            level: 0,
            format: LevelFormat.DECIMAL,
            text: '%1.',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } }
          }]
        }
      ]
    },
    styles: {
      default: {
        document: {
          run: {
            font: {
              ascii: DEFAULT_FONT.latin,
              hAnsi: DEFAULT_FONT.latin,
              eastAsia: DEFAULT_FONT.eastAsia
            },
            size: DEFAULT_FONT.size
          },
          paragraph: { spacing: { line: 360, after: 60 } }
        },
        heading1: {
          run: { font: { ascii: '黑体', hAnsi: '黑体', eastAsia: '黑体' }, size: 32, bold: true },
          paragraph: { spacing: { before: 240, after: 120 } }
        },
        heading2: {
          run: { font: { ascii: '黑体', hAnsi: '黑体', eastAsia: '黑体' }, size: 28, bold: true },
          paragraph: { spacing: { before: 200, after: 100 } }
        }
      }
    },
    sections: [{
      properties: {
        page: {
          size: 'A4',
          orientation: 'portrait',
          margins: { top: 1, bottom: 1, left: 1.1, right: 1.1 }
        }
      },
      children
    }]
  });
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
    return { ok: false, error: (error && error.stack) || (error && error.message) || String(error) };
  }
}

/* ---------------- DOCX 解析（纯 JS，无外部依赖） ---------------- */

function readZipEntry(buffer, entryName) {
  const SIG_EOCD = 0x06054b50;
  const SIG_CEN = 0x02014b50;
  let eocd = -1;
  const minPos = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= minPos; i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found: not a zip/docx file');

  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  let pos = cdOffset;

  for (let n = 0; n < count; n++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== SIG_CEN) break;
    const method = buffer.readUInt16LE(pos + 10);
    const compSize = buffer.readUInt32LE(pos + 20);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLen);

    if (name === entryName) {
      const lhNameLen = buffer.readUInt16LE(localOffset + 26);
      const lhExtraLen = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
      const data = buffer.subarray(dataStart, dataStart + compSize);
      const raw = method === 0 ? data : inflateRawSync(data);
      return raw.toString('utf8');
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip entry not found: ${entryName}`);
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function countWords(text) {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = (text.match(/[A-Za-z0-9]+/g) || []).length;
  return cjk + latin;
}

function parseDocumentXml(xml) {
  const paragraphs = [];
  const paraRe = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  let m;
  while ((m = paraRe.exec(xml)) !== null) {
    const pXml = m[0];
    const styleMatch = pXml.match(/<w:pStyle\s+w:val="([^"]+)"/);
    const style = styleMatch ? styleMatch[1] : '';
    let level = 0;
    const h = style.match(/^Heading\s*(\d+)$/i) || style.match(/^(\d)$/);
    if (h) level = Number(h[1]);
    else if (/^Title$/i.test(style)) level = 1;

    let text = '';
    const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let t;
    while ((t = tRe.exec(pXml)) !== null) text += t[1];
    text = decodeXml(text).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    paragraphs.push({ text, level });
  }
  return paragraphs;
}

// 检查 Docx 文件
export async function inspectDocx(path) {
  try {
    const buffer = await readFile(path);
    if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
      throw new Error('not a docx/zip file');
    }
    const xml = readZipEntry(buffer, 'word/document.xml');
    const paragraphs = parseDocumentXml(xml);

    const headings = paragraphs
      .filter((p) => p.level > 0)
      .map((p) => ({ text: p.text, level: p.level }));
    const text = paragraphs.map((p) => p.text).join('\n');

    const sections = [];
    let current = { id: sections.length, title: '正文', words: 0, paragraphs: 0 };
    for (const p of paragraphs) {
      if (p.level > 0) {
        if (current.paragraphs > 0) sections.push(current);
        current = { id: sections.length, title: p.text, words: 0, paragraphs: 0 };
      } else {
        current.words += countWords(p.text);
        current.paragraphs += 1;
      }
    }
    if (current.paragraphs > 0) sections.push(current);

    const tables = (xml.match(/<w:tbl\b/g) || []).length;
    const images = (xml.match(/<w:drawing\b|<w:pict\b/g) || []).length;

    const bodyTexts = paragraphs.filter((p) => p.level === 0 && p.text.length > 10).map((p) => p.text);
    const unique = new Set(bodyTexts);
    const duplicateRatio = bodyTexts.length ? 1 - unique.size / bodyTexts.length : 0;

    const longParagraphs = paragraphs
      .map((p, index) => ({ index, chars: p.text.length }))
      .filter((p) => p.chars > 500);

    return {
      ok: true,
      bytes: buffer.length,
      paragraphs: paragraphs.length,
      headings,
      tables,
      images,
      words: countWords(text),
      text,
      sections,
      duplicateRatio,
      longParagraphs,
      placeholders: []
    };
  } catch (error) {
    return { ok: false, error: (error && error.stack) || (error && error.message) || String(error) };
  }
}
