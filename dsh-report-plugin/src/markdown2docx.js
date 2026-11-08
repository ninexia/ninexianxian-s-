import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, AlignmentType, LevelFormat, PageBreak, ImageRun, TableOfContents,
  Header, Footer, PageNumber, BorderStyle, convertInchesToTwip
} from 'docx';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
function fontOf(style, fallback = DEFAULT_FONT) {
  return {
    ascii: style?.latin ?? fallback.latin,
    hAnsi: style?.latin ?? fallback.latin,
    eastAsia: style?.eastAsia ?? fallback.eastAsia
  };
}

function documentStyles(styles = {}) {
  const body = styles.body ?? {};
  const heading = (style, fallbackSize) => ({
    run: {
      font: fontOf(style, { latin: 'Times New Roman', eastAsia: '黑体' }),
      size: Math.round(Number(style?.size ?? fallbackSize) * 2),
      bold: style?.bold !== false
    },
    paragraph: {
      spacing: {
        before: Math.round(Number(style?.spaceBefore ?? 0) * 20),
        after: Math.round(Number(style?.spaceAfter ?? 0) * 20)
      }
    }
  });
  return {
    default: {
      document: {
        run: { font: fontOf(body), size: Math.round(Number(body.size ?? 10.5) * 2) },
        paragraph: {
          spacing: {
            line: Math.round(Number(body.lineSpacing ?? 1.2) * 240),
            after: Math.round(Number(body.spaceAfter ?? 4) * 20)
          }
        }
      },
      heading1: heading(styles.h1, 15),
      heading2: heading(styles.h2, 13),
      heading3: heading(styles.h3, 12)
    }
  };
}

const COVER_ORDER = ['course', 'semester', 'experiment', 'name', 'studentId', 'className', 'major', 'college', 'teacher', 'date'];

// 封面页：模板只负责字段与字号，排版由这里统一
function coverParagraphs(cover = {}) {
  const paragraphs = [];
  const spacerLines = Math.max(0, Math.min(8, Number(cover.spacerLines ?? 2)));
  for (let index = 0; index < spacerLines; index += 1) paragraphs.push(new Paragraph({ children: [] }));

  const fields = Array.isArray(cover.fields) ? cover.fields : [];
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const extraKeys = [...byKey.keys()].filter((key) => !COVER_ORDER.includes(key));
  for (const key of [...COVER_ORDER.filter((item) => byKey.has(item)), ...extraKeys]) {
    const field = byKey.get(key);
    const value = String(field?.value ?? '').trim();
    if (!value) continue;
    const isHeadline = key === 'course' || key === 'experiment';
    const size = key === 'course' ? Number(cover.courseSize ?? 26)
      : key === 'experiment' ? Number(cover.titleSize ?? 22)
        : key === 'semester' ? Number(cover.semesterSize ?? 18)
          : Number(cover.infoSize ?? 14);
    paragraphs.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: isHeadline ? 120 : 40, after: isHeadline ? 240 : 90 },
      children: [new TextRun({
        text: isHeadline ? value : `${field.label ?? key}：${value}`,
        bold: isHeadline,
        size: Math.round(size * 2),
        font: { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: '黑体' }
      })]
    }));
  }
  paragraphs.push(new Paragraph({ children: [new PageBreak()] }));
  return paragraphs;
}

// 页眉/页脚/目录：文本里的 {{key}} 用封面字段替换
function fillPlaceholders(text, values) {
  return String(text ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key) => String(values?.[key] ?? '')).replace(/\s{2,}/g, ' ').trim();
}

function coverValues(cover = {}, title = '') {
  const values = { title };
  for (const field of cover.fields ?? []) {
    const value = String(field.value ?? '').trim();
    if (value) values[field.key] = value;
  }
  values.experiment = values.experiment || title;
  return values;
}

function headerChildren(header, values, bodyStyle) {
  if (header?.enabled === false) return [];
  const text = fillPlaceholders(header?.text ?? '', values);
  if (!text) return [];
  return [new Paragraph({
    alignment: AlignmentType.RIGHT,
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BFBFBF', space: 4 } },
    children: [new TextRun({
      text,
      size: Math.round(Number(header?.size ?? 9) * 2),
      color: '595959',
      font: fontOf(bodyStyle)
    })]
  })];
}

function footerChildren(footer, bodyStyle) {
  if (footer?.enabled === false || footer?.pageNumber === false) return [];
  const size = Math.round(Number(footer?.size ?? 9) * 2);
  const font = fontOf(bodyStyle);
  return [new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      new TextRun({ text: '第 ', size, color: '595959', font }),
      new TextRun({ children: [PageNumber.CURRENT], size, color: '595959', font }),
      new TextRun({ text: ' 页 / 共 ', size, color: '595959', font }),
      new TextRun({ children: [PageNumber.TOTAL_PAGES], size, color: '595959', font }),
      new TextRun({ text: ' 页', size, color: '595959', font })
    ]
  })];
}

function tocChildren(toc) {
  return [
    new TableOfContents(toc?.title ?? '目　　录', {
      hyperlink: true,
      headingStyleRange: '1-3',
      pageNumbersEntryLevelsRange: '1-3'
    }),
    new Paragraph({ children: [new PageBreak()] })
  ];
}

async function buildDocxFromBlocks(blocks, options = {}) {
  const children = [];
  const styles = options.styles ?? {};
  const pageConfig = options.page ?? {};
  const margins = pageConfig.margins ?? {};
  const landscape = pageConfig.orientation === 'landscape';
  const bodyStyle = styles.body ?? {};
  const bodyFirstLine = Math.round(Number(bodyStyle.firstLineIndent ?? 0) * Number(bodyStyle.size ?? 10.5) * 20);
  const bodyAlign = bodyStyle.align === 'justify' ? AlignmentType.JUSTIFIED : undefined;
  const headerValues = coverValues(options.cover ?? {}, options.title ?? '');
  const header = headerChildren(options.header, headerValues, bodyStyle);
  const footer = footerChildren(options.footer, bodyStyle);

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
          alignment: bodyAlign ?? AlignmentType.JUSTIFIED,
          indent: bodyFirstLine > 0 ? { firstLine: bodyFirstLine } : undefined
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

      case 'note':
        child = new Paragraph({
          children: [new TextRun({ text: String(block.text ?? ''), italics: true })],
          spacing: { after: 80 }
        });
        break;

      case 'pagebreak':
        child = new Paragraph({ children: [new PageBreak()] });
        break;

      case 'image': {
        if (!block.path || block.missing === true) continue;
        let buffer;
        try {
          buffer = await readFile(block.path);
        } catch {
          continue;
        }
        const meta = imageFormat(buffer) ?? { width: 800, height: 600 };
        const widthPx = Math.max(16, Math.round(Number(block.width ?? 5.6) * 37.795));
        const heightPx = Math.max(16, Math.round((meta.height / meta.width) * widthPx));
        const run = new ImageRun({ data: buffer, transformation: { width: widthPx, height: heightPx } });
        if (meta.ext && meta.ext !== 'png') {
          try {
            run.imageData.fileName = `${String(run.key).replace(/\.png$/, '')}.${meta.ext}`;
          } catch {
            // 保留默认 .png 命名，Word 仍能按内容识别
          }
        }
        children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 40 }, children: [run] }));
        if (block.caption) {
          children.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 160 },
            children: [new TextRun({ text: `图 ${block.caption}`, size: 20, font: fontOf(styles.body) })]
          }));
        }
        continue;
      }

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
    styles: documentStyles(styles),
    features: { updateFields: true },
    sections: [{
      ...(header.length ? { headers: { default: new Header({ children: header }), first: new Header({ children: [] }) } } : {}),
      ...(footer.length ? { footers: { default: new Footer({ children: footer }), first: new Footer({ children: [] }) } } : {}),
      properties: {
        titlePage: header.length > 0 || footer.length > 0,
        page: {
          size: landscape ? { width: 16838, height: 11906 } : { width: 11906, height: 16838 },
          orientation: landscape ? 'landscape' : 'portrait',
          margin: {
            top: convertInchesToTwip(Number(margins.top ?? 1)),
            bottom: convertInchesToTwip(Number(margins.bottom ?? 1)),
            left: convertInchesToTwip(Number(margins.left ?? 1.1)),
            right: convertInchesToTwip(Number(margins.right ?? 1.1)),
            header: convertInchesToTwip(Number(pageConfig.headerDistance ?? 0.45)),
            footer: convertInchesToTwip(Number(pageConfig.footerDistance ?? 0.45))
          }
        }
      },
      children: [
        ...(options.cover?.enabled === false
          || !(options.cover?.fields ?? []).some((field) => String(field.value ?? '').trim())
          ? []
          : coverParagraphs(options.cover)),
        ...(options.toc?.enabled ? tocChildren(options.toc) : []),
        ...children
      ]
    }]
  });
}

// 输出 Docx 文件
async function writeDocxFile(blocks, outputPath, options = {}) {
  try {
    const doc = await buildDocxFromBlocks(blocks, options);
    const buffer = await Packer.toBuffer(doc);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, buffer);
    return { ok: true, bytes: buffer.length };
  } catch (error) {
    return { ok: false, error: (error && error.stack) || (error && error.message) || String(error) };
  }
}

export async function markdownToDocx(markdown, outputPath, options = {}) {
  return writeDocxFile(parseMarkdown(markdown), outputPath, options);
}

// 结构化正文直接成文，避开 Markdown 往返：图片、分页、表格都不丢信息
export async function sectionsToDocx(sections, outputPath, options = {}) {
  const blocks = [];
  for (const section of sections ?? []) {
    if (section.title) {
      blocks.push({ type: 'heading', level: Math.max(1, Math.min(3, Number(section.level) || 1)), text: section.title });
    }
    for (const block of section.blocks ?? []) blocks.push(block);
  }
  return writeDocxFile(blocks, outputPath, options);
}

// PNG / JPEG / GIF / BMP 头解析，只为算宽高比
function imageFormat(buffer) {
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { ext: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { ext: 'jpg', height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
    return { ext: 'jpg', width: 800, height: 600 };
  }
  if (buffer.length > 10 && buffer.toString('utf8', 0, 3) === 'GIF') {
    return { ext: 'gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length > 26 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { ext: 'bmp', width: buffer.readInt32LE(18), height: buffer.readInt32LE(22) };
  }
  return null;
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
      blocks: paragraphs,
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
