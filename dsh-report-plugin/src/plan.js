import { normalizeKey, normalizeText, shortHash, wordCount } from './util.js'

const FIELD_PATTERNS = {
  name: [/(?:学生)?姓名\s*[:：]\s*([^\s，,；;、|]{1,20})/],
  studentId: [/(?:学生)?学号\s*[:：]\s*([A-Za-z0-9_-]{4,30})/],
  className: [/(?:学生)?班级\s*[:：]\s*([^\s，,；;、|]{1,30})/],
  major: [/(?:专业)\s*[:：]\s*([^\s，,；;、|]{1,30})/],
  course: [/(?:课程名称|课程)\s*[:：]\s*([^\n，,；;]{1,60})/],
  teacher: [/(?:任课教师|指导教师|指导老师|教师)\s*[:：]\s*([^\n，,；;]{1,40})/],
  date: [/(?:提交日期|实验日期|日期)\s*[:：]\s*([0-9]{4}[年./-][0-9]{1,2}[月./-][0-9]{1,2}日?)/],
  college: [/(?:学院|学校)\s*[:：]\s*([^\n，,；;]{1,40})/],
  semester: [/(?:学期|学年)\s*[:：]\s*([^\n，,；;]{1,30})/],
  experiment: [/(?:实验名称|实验题目|实验项目)\s*[:：]\s*([^\n，,；;]{1,100})/],
}

function findProvided(provided, field) {
  if (!provided || typeof provided !== 'object') return undefined
  const candidates = [field.key, field.label, ...(field.aliases ?? [])]
  for (const key of candidates) {
    const value = provided[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function titleFromRequirements(requirements) {
  const lines = normalizeText(requirements).split('\n').map((line) => line.trim()).filter(Boolean)
  const patterns = [
    /^《([^》]{2,80})》\s*实验报告/,
    /^实验\s*[一二三四五六七八九十0-9]+\s*[:：\-—]?\s*(.{2,100})$/,
    /^(?:实验名称|实验题目|实验项目)\s*[:：]\s*(.{2,100})$/,
    /^(.{2,80})\s*实验报告$/,
  ]
  for (const line of lines.slice(0, 30)) {
    for (const pattern of patterns) {
      const match = line.match(pattern)
      if (match?.[1]) {
        return match[1]
          .replace(/\s*[（(]?实验报告[）)]?\s*$/g, '')
          .replace(/^\s*[：:]\s*/, '')
          .trim()
      }
    }
  }
  const first = lines.find((line) => line.length >= 4 && line.length <= 100 && !/^[\d.\s]+$/.test(line))
  return first?.replace(/^#+\s*/, '').slice(0, 100) || '实验报告'
}

function extractCover(template, requirements, provided) {
  const fields = template.cover?.fields ?? []
  const values = {}
  const sources = {}
  const missing = []
  for (const field of fields) {
    let value = findProvided(provided, field)
    let source = value ? 'input' : undefined
    if (!value) {
      for (const pattern of FIELD_PATTERNS[field.key] ?? []) {
        const match = normalizeText(requirements).match(pattern)
        if (match?.[1]) {
          value = match[1].trim()
          source = 'requirements'
          break
        }
      }
    }
    if (!value && field.default) {
      value = field.default
      source = 'default'
    }
    if (value) {
      values[field.key] = value
      sources[field.key] = source
    } else if (field.required) {
      missing.push({ key: field.key, label: field.label })
    }
  }
  if (!values.experiment) {
    values.experiment = titleFromRequirements(requirements)
    sources.experiment = 'requirements'
  }
  if (!values.date) {
    const now = new Date()
    values.date = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`
    sources.date = 'today'
  }
  return { values, sources, missing }
}

function countKeyword(text, keyword) {
  if (!keyword) return 0
  const haystack = text.toLowerCase()
  const needle = String(keyword).toLowerCase()
  let count = 0
  let index = 0
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1
    index += needle.length
  }
  return count
}

export function scoreTemplates(templates, requirements) {
  const text = normalizeText(requirements)
  const rows = []
  for (const template of templates.values()) {
    let score = Number(template.priority ?? 0) / 100
    const hits = []
    for (const [keyword, weight] of Object.entries(template.match?.keywords ?? {})) {
      const count = countKeyword(text, keyword)
      if (count > 0) {
        score += Number(weight) * Math.min(count, 3)
        hits.push(keyword)
      }
    }
    rows.push({ id: template.id, name: template.name, score: Number(score.toFixed(3)), hits })
  }
  return rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}

function taskLines(requirements, patterns) {
  const lines = normalizeText(requirements).split('\n').map((line) => line.trim()).filter(Boolean)
  const matchers = patterns.map((pattern) => new RegExp(pattern, 'i'))
  const tasks = []
  const seen = new Set()
  for (const line of lines) {
    if (!matchers.some((matcher) => matcher.test(line))) continue
    const cleaned = line.replace(/^[#>*\-\s]+/, '').replace(/[：:]\s*$/, '').trim()
    if (cleaned.length < 3 || cleaned.length > 120) continue
    const key = normalizeKey(cleaned)
    if (seen.has(key)) continue
    seen.add(key)
    tasks.push(cleaned)
    if (tasks.length >= 12) break
  }
  return tasks
}

function triggered(section, requirements) {
  const text = normalizeText(requirements)
  const haystack = text.toLowerCase()
  return (section.triggers ?? []).some((trigger) => trigger && haystack.includes(String(trigger).toLowerCase()))
}

function ordinalOf(template, sectionId) {
  const levelOne = template.sections.filter((section) => Number(section.level) === 1)
  const index = levelOne.findIndex((section) => section.id === sectionId)
  return index === -1 ? 1 : index + 1
}

export function buildPlan({ template, requirements, providedCover = {}, options = {}, templateDigest = '' }) {
  const text = normalizeText(requirements)
  const cover = extractCover(template, text, providedCover)
  const includeSections = new Set(Array.isArray(options.includeSections) ? options.includeSections : [])
  const excludeSections = new Set(Array.isArray(options.excludeSections) ? options.excludeSections : [])
  const fullTemplate = options.fullTemplate === true
  const planned = []
  const warnings = []

  for (const section of template.sections) {
    const isRequired = section.required === true
    const isTriggered = triggered(section, text)
    let include = fullTemplate || isRequired || isTriggered || includeSections.has(section.id)
    if (excludeSections.has(section.id)) include = false
    if (!include) continue

    const item = {
      id: section.id,
      title: section.title,
      level: Number(section.level) || 1,
      kind: section.kind,
      required: isRequired,
      hint: section.hint ?? '',
      minWords: Number(section.minWords ?? 0),
      maxWords: Number(section.maxWords ?? 10000),
      status: 'missing',
      parentId: null,
    }
    planned.push(item)

    if (section.kind === 'task-group' && !excludeSections.has(section.id)) {
      const tasks = taskLines(text, section.taskPatterns ?? [])
      const base = ordinalOf(template, section.id)
      tasks.forEach((task, index) => {
        const number = `${base}.${index + 1}`
        planned.push({
          id: `${section.id}.task-${index + 1}`,
          title: `${number} ${task}`,
          level: 2,
          kind: 'mixed',
          required: index < 2,
          hint: '写清本任务的输入、操作/方法、产出与检查结果。',
          minWords: Math.max(20, Math.floor(Number(section.minWords ?? 80) / Math.max(tasks.length, 1))),
          maxWords: Math.max(400, Math.floor(Number(section.maxWords ?? 4000) / 2)),
          status: 'missing',
          parentId: section.id,
        })
      })
      if (!tasks.length) {
        warnings.push(`未识别到任务分节；${section.title} 将作为单节生成。可在 requirements 中用“任务1 …”分条。`)
      }
    }
  }

  const missingSections = planned.filter((section) => section.required).map((section) => section.id)
  const includeToc = options.includeToc ?? (
    template.toc?.enabled === true && planned.filter((section) => section.level === 1).length >= Number(template.toc?.minSections ?? 8)
  )

  const planBase = {
    templateId: template.id,
    templateVersion: template.version ?? 1,
    templateDigest,
    requirementsDigest: shortHash(text, 16),
    cover: cover.values,
    coverSources: cover.sources,
    title: cover.values.experiment,
    includeToc,
    sectionIds: planned.map((section) => section.id),
  }
  const planId = `rpt_${shortHash(planBase, 18)}`
  const sectionWordBudget = planned.reduce((total, section) => total + Number(section.minWords ?? 0), 0)
  return {
    planId,
    createdAt: new Date().toISOString(),
    templateId: template.id,
    templateName: template.name,
    templateVersion: template.version ?? 1,
    templateDigest,
    requirementsDigest: planBase.requirementsDigest,
    title: cover.values.experiment,
    cover: cover.values,
    coverSources: cover.sources,
    missingCover: cover.missing,
    includeToc,
    sections: planned,
    missingSections,
    warnings,
    stats: {
      plannedSections: planned.length,
      requiredSections: planned.filter((section) => section.required).length,
      taskSections: planned.filter((section) => section.parentId).length,
      sectionWordBudget,
      requirementsWords: wordCount(text),
    },
    cache: {
      templateDigest,
      requirementsDigest: planBase.requirementsDigest,
    },
  }
}
