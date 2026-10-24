import { normalizeKey, normalizeText } from './util.js'

function sectionWords(inspect, section) {
  const key = normalizeKey(section.title)
  const found = (inspect.sections ?? []).find((item) => normalizeKey(item.title) === key || normalizeKey(item.title).includes(key) || key.includes(normalizeKey(item.title)))
  return found?.words ?? 0
}

export function validateBuild({ plan, template, result, inspect, config, build }) {
  const errors = []
  const warnings = []
  const checks = []
  const add = (level, message) => {
    if (level === 'error') errors.push(message)
    else warnings.push(message)
  }

  if (!result?.ok) add('error', result?.error ?? 'renderer failed')
  if (!inspect?.ok) add('error', inspect?.error ?? 'DOCX inspect failed')
  if (result?.bytes && result.bytes < 1000) add('error', `output too small: ${result.bytes} bytes`)

  const missingCover = (template.cover?.fields ?? [])
    .filter((field) => field.required && !normalizeText(plan.cover[field.key]))
    .map((field) => field.label)
  if (missingCover.length) add('error', `missing cover fields: ${missingCover.join('、')}`)
  checks.push({ name: 'cover', ok: missingCover.length === 0, detail: missingCover.join('、') || 'ok' })

  const headings = new Set((inspect?.headings ?? []).map((heading) => normalizeKey(heading.text)))
  const missingSections = plan.sections
    .filter((section) => section.required)
    .filter((section) => !headings.has(normalizeKey(section.title)))
    .map((section) => section.title)
  if (missingSections.length) add('error', `missing required sections: ${missingSections.join('、')}`)
  checks.push({ name: 'sections', ok: missingSections.length === 0, detail: missingSections.join('、') || 'ok' })

  if (build?.placeholders > 0) add('error', `${build.placeholders} section(s) still contain placeholders`)
  const text = inspect?.text ?? ''
  for (const token of config.validation.forbidden ?? []) {
    if (text.toLowerCase().includes(String(token).toLowerCase())) add('error', `forbidden placeholder text: ${token}`)
  }

  const words = Number(inspect?.words ?? 0)
  if (words < config.validation.minWords) add('warning', `total length ${words} words is below target ${config.validation.minWords}`)

  const shortSections = []
  for (const section of plan.sections.filter((item) => item.required && item.kind !== 'task-group')) {
    const count = sectionWords(inspect, section)
    if (count < Math.min(section.minWords, config.validation.minSectionWords)) shortSections.push(`${section.title}(${count})`)
  }
  if (shortSections.length) add('warning', `short required sections: ${shortSections.join('、')}`)

  const duplicateRatio = Number(inspect?.duplicateRatio ?? 0)
  if (duplicateRatio > config.validation.maxDuplicateRatio) {
    add('warning', `duplicate paragraph ratio ${(duplicateRatio * 100).toFixed(1)}% exceeds ${(config.validation.maxDuplicateRatio * 100).toFixed(0)}%`)
  }

  for (const paragraph of inspect?.longParagraphs ?? []) {
    if (paragraph.chars > config.validation.maxParagraphChars) {
      add('warning', `paragraph ${paragraph.index + 1} is ${paragraph.chars} chars; consider splitting`)
    }
  }

  const duplicateHeadings = (inspect?.headings ?? [])
    .map((heading) => normalizeKey(heading.text))
    .filter((key, index, list) => key && list.indexOf(key) !== index)
  if (duplicateHeadings.length) add('warning', `duplicate headings: ${[...new Set(duplicateHeadings)].length}`)

  const missingImages = (result?.warnings ?? []).filter((warning) => /image|missing/i.test(warning))
  if (missingImages.length) add('warning', missingImages.slice(0, 4).join('; '))

  const score = Math.max(0, Math.min(100, 100 - errors.length * 15 - warnings.length * 3))
  checks.push({ name: 'words', ok: words >= config.validation.minWords, detail: String(words) })
  checks.push({ name: 'duplicates', ok: duplicateRatio <= config.validation.maxDuplicateRatio, detail: `${(duplicateRatio * 100).toFixed(1)}%` })
  checks.push({ name: 'structure', ok: (inspect?.paragraphs ?? 0) > 10 && (inspect?.tables ?? 0) >= 0, detail: `${inspect?.paragraphs ?? 0} paras / ${inspect?.tables ?? 0} tables / ${inspect?.images ?? 0} images` })

  return {
    ok: errors.length === 0,
    score,
    errors: [...new Set(errors)].slice(0, 12),
    warnings: [...new Set(warnings)].slice(0, 12),
    checks,
    metrics: {
      bytes: result?.bytes ?? inspect?.bytes ?? 0,
      paragraphs: inspect?.paragraphs ?? 0,
      tables: inspect?.tables ?? 0,
      images: inspect?.images ?? 0,
      words,
      duplicateRatio: Number(duplicateRatio.toFixed(3)),
    },
  }
}
