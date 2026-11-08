import { join, relative } from 'node:path'
import { inspectDocx } from './markdown2docx.js'
import { FIELD_PATTERNS } from './plan.js'
import {
  normalizeKey,
  normalizeText,
  readJson,
  sha256,
  wordCount,
} from './util.js'

const HEADING_1 = /^([一二三四五六七八九十]+)[、.．]\s*(.+)$/
const HEADING_1_ALT = /^第([一二三四五六七八九十0-9]+)[章节部分]\s*[、.．:：]?\s*(.+)$/
const HEADING_2 = /^(\d{1,2}(?:\.\d{1,2})+)\s*[、.．]?\s*(.+)$/
const LIST_LINE = /^(?:[-*+•·]|\d{1,2}[、.)]|[（(]\d{1,2}[）)]|第[一二三四五六七八九十0-9]+[，,、])\s*/
const OPTIONAL_TITLES = /^(?:参考文献|参考资料|附录|致谢|附件|后记|声明)/

// 常见课程的中文名 → 模板 id，认不出来时退回哈希
const COURSE_IDS = {
  人机交互: 'hci',
  人机交互和界面设计: 'hci',
  界面设计: 'hci',
  软件工程: 'se',
  软件工程导论: 'se',
  操作系统: 'os',
  操作系统原理: 'os',
  人工智能: 'ai',
  人工智能导论: 'ai',
  机器学习: 'ml',
  数据库: 'db',
  数据库原理: 'db',
  计算机网络: 'network',
  数据结构: 'ds',
  编译原理: 'compiler',
  计算机组成原理: 'coa',
  javaee: 'javaee',
  'java ee': 'javaee',
  'java web': 'javaweb',
  需求分析: 'requirements',
}

function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export function courseIdFor(course, name, templateId) {
  if (templateId) return slugify(templateId) || templateId
  const key = normalizeKey(course ?? '')
  if (COURSE_IDS[key]) return COURSE_IDS[key]
  for (const [label, id] of Object.entries(COURSE_IDS)) {
    if (key && key.includes(normalizeKey(label))) return id
  }
  const ascii = slugify(course)
  if (ascii.length >= 2) return ascii
  return `course-${sha256(`${course ?? ''}|${name ?? ''}`).slice(0, 6)}`
}

function headingOf(block) {
  const text = String(block?.text ?? '').replace(/\s+/g, ' ').trim()
  if (!text || text.length > 60) return null
  let match = text.match(HEADING_1) || text.match(HEADING_1_ALT)
  if (match) return { title: text, level: 1, rest: match[2] ?? '' }
  match = text.match(HEADING_2)
  if (match) return { title: text, level: 1, rest: match[2] ?? '' }
  return null
}

function sectionKind(body) {
  if (!body.length) return 'paragraphs'
  const listLines = body.filter((line) => LIST_LINE.test(line)).length
  return listLines >= Math.max(2, body.length * 0.5) ? 'list' : 'paragraphs'
}

function bodyWords(body) {
  return body.reduce((total, line) => total + wordCount(line), 0)
}

// 从旧报告的 DOCX 里抽章节骨架与封面字段，绝不把学生姓名/学号写成默认值
export async function learnTemplate({ docxPath, workspace, overlayDir, course, name, templateId }) {
  const inspect = await inspectDocx(docxPath)
  if (!inspect.ok) throw new Error(inspect.error ?? 'inspect failed')
  const blocks = (inspect.blocks ?? []).filter((block) => block.text && block.text.length <= 400)
  if (!blocks.length) throw new Error('no readable paragraphs in this DOCX')

  // 优先用 Word 标题样式；学生报告常常只有“一、”这种文本标题，退回正则
  const styled = blocks
    .map((block, index) => ({ index, level: Number(block.level) || 0 }))
    .filter((item) => item.level > 0)
  let headings = []
  if (styled.length >= 3) {
    headings = styled
      .filter((item) => item.level <= 2)
      .map((item) => ({ index: item.index, level: Math.min(item.level, 2), title: blocks[item.index].text.trim() }))
  } else {
    blocks.forEach((block, index) => {
      const found = headingOf(block)
      if (found) headings.push({ index, level: found.level, title: found.title })
    })
  }
  if (headings.length < 2) {
    throw new Error('no usable headings found; the DOCX needs at least two section titles (一、实验目的 …)')
  }

  const firstHeading = headings[0].index
  const coverLines = blocks.slice(0, firstHeading).map((block) => block.text.trim()).filter(Boolean)
  const coverValues = {}
  for (const [key, patterns] of Object.entries(FIELD_PATTERNS)) {
    for (const pattern of patterns) {
      const hit = coverLines.map((line) => line.match(pattern)).find(Boolean)
      if (hit?.[1]) {
        coverValues[key] = hit[1].trim()
        break
      }
    }
  }

  const sections = []
  headings.forEach((heading, index) => {
    const next = headings[index + 1]
    const stop = next ? next.index : blocks.length
    const body = blocks.slice(heading.index + 1, stop).map((block) => block.text.trim()).filter(Boolean)
    const words = bodyWords(body)
    const title = heading.title.replace(/\s+/g, ' ').trim()
    const optional = OPTIONAL_TITLES.test(title)
    sections.push({
      id: `s${index + 1}`,
      title,
      level: heading.level,
      kind: sectionKind(body),
      required: !optional,
      minWords: Math.min(400, Math.max(40, Math.round(words * 0.8))),
      maxWords: Math.max(400, Math.round(words * 2)),
    })
  })

  const derivedCourse = String(course ?? coverValues.course ?? '').trim()
  const id = courseIdFor(derivedCourse, name ?? docxPath, templateId)
  const displayName = String(name ?? '').trim() || (derivedCourse ? `${derivedCourse}实验报告` : '实验报告')
  const prior = await readJson(join(overlayDir ?? join(workspace, '.dsh-report-templates'), `${id}.json`), null)

  const aliases = new Set([derivedCourse, ...(prior?.course?.aliases ?? [])].filter(Boolean))
  if (coverValues.course) aliases.add(coverValues.course)
  for (const match of String(name ?? '').matchAll(/([一-龥]{2,12}?)(?:实验|课程)/g)) aliases.add(match[1])

  const keywords = {}
  const keyName = normalizeKey(derivedCourse)
  if (keyName) keywords[derivedCourse] = 3
  for (const alias of aliases) {
    if (alias && alias !== derivedCourse && normalizeKey(alias).length >= 2) keywords[alias] = 2
  }
  for (const section of sections.slice(0, 8)) {
    const word = normalizeKey(section.title).replace(/^[一二三四五六七八九十0-9]+/, '')
    if (word.length >= 2 && word.length <= 8) keywords[section.title.replace(/^[一二三四五六七八九十0-9、.．\s]+/, '')] = 1
  }

  const coverFields = [
    { key: 'course', label: '课程名称', required: Boolean(coverValues.course), default: derivedCourse || undefined },
    { key: 'semester', label: '学期', required: Boolean(coverValues.semester) },
    { key: 'experiment', label: '实验名称', required: true },
    { key: 'name', label: '学生姓名', required: Boolean(coverValues.name) },
    { key: 'studentId', label: '学号', required: Boolean(coverValues.studentId) },
    { key: 'className', label: '班级', required: Boolean(coverValues.className) },
    { key: 'major', label: '专业', required: Boolean(coverValues.major) },
    { key: 'college', label: '学院', required: Boolean(coverValues.college) },
    { key: 'teacher', label: '指导教师', required: Boolean(coverValues.teacher) },
    { key: 'date', label: '提交日期', required: false },
  ].map((field) => Object.fromEntries(Object.entries(field).filter(([, value]) => value !== undefined)))

  return {
    id,
    name: displayName,
    description: `从 ${relative(workspace, docxPath).replace(/\\/g, '/')} 学到的课程模板：${sections.length} 个章节。`,
    version: (prior?.version ?? 0) + 1,
    priority: 40,
    course: {
      name: derivedCourse || displayName,
      aliases: [...aliases].filter(Boolean),
    },
    match: { keywords },
    page: prior?.page ?? {
      size: 'A4',
      orientation: 'portrait',
      margins: { top: 1, bottom: 1, left: 1.1, right: 1.1 },
    },
    styles: prior?.styles ?? {},
    cover: {
      enabled: true,
      layout: prior?.cover?.layout ?? 'center',
      courseSize: prior?.cover?.courseSize ?? 24,
      semesterSize: prior?.cover?.semesterSize ?? 16,
      titleSize: prior?.cover?.titleSize ?? 20,
      infoSize: prior?.cover?.infoSize ?? 14,
      spacerLines: prior?.cover?.spacerLines ?? 3,
      fields: coverFields,
    },
    toc: { enabled: sections.filter((section) => section.level === 1).length >= 6, minSections: 6, title: '目　　录' },
    sections,
    source: {
      docx: relative(workspace, docxPath).replace(/\\/g, '/'),
      digest: sha256(inspect.text ?? '').slice(0, 16),
      learnedAt: new Date().toISOString(),
      words: inspect.words,
    },
  }
}
