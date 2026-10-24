import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { isInside, isRecord, normalizeText, sha256, splitParagraphs, wordCount } from './util.js'

const MAX_BLOCKS = 400
const MAX_ROWS = 250
const MAX_COLUMNS = 14

function cleanLines(items) {
  return (Array.isArray(items) ? items : [items])
    .flatMap((item) => normalizeText(item).split('\n'))
    .map((item) => item.replace(/^\s*[-*+•]\s+/, '').trim())
    .filter(Boolean)
}

function normalizeTable(value, warnings, id) {
  if (!isRecord(value)) return null
  let headers = Array.isArray(value.headers) ? value.headers.map((item) => normalizeText(item)) : []
  let rows = Array.isArray(value.rows) ? value.rows : []
  if (!headers.length && rows.length && isRecord(rows[0])) headers = Object.keys(rows[0])
  if (!rows.length) {
    warnings.push(`${id}: table without rows was skipped`)
    return null
  }
  rows = rows.slice(0, MAX_ROWS).map((row) => {
    if (Array.isArray(row)) return row.slice(0, MAX_COLUMNS).map((cell) => normalizeText(cell))
    if (isRecord(row)) return headers.map((header) => normalizeText(row[header]))
    return [normalizeText(row)]
  })
  if (!headers.length) headers = rows[0].map((_, index) => `列${index + 1}`)
  const width = Math.max(headers.length, ...rows.map((row) => row.length))
  headers = Array.from({ length: width }, (_, index) => headers[index] ?? `列${index + 1}`)
  rows = rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ''))
  return {
    type: 'table',
    caption: normalizeText(value.caption ?? ''),
    headers,
    rows,
    widths: Array.isArray(value.widths) ? value.widths.map(Number).filter((number) => Number.isFinite(number) && number > 0) : undefined,
    fontSize: Number(value.fontSize) || undefined,
    headerFill: typeof value.headerFill === 'string' ? value.headerFill : undefined,
  }
}

function normalizeBlock(value, warnings, id, workspace, allowOutside) {
  const blocks = []
  if (typeof value === 'string') {
    const text = normalizeText(value)
    if (!text) return blocks
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
    if (lines.length > 1 && lines.every((line) => /^[-*+•]\s+/.test(line))) {
      blocks.push({ type: 'bullets', items: cleanLines(lines) })
    } else {
      for (const paragraph of splitParagraphs(text)) blocks.push({ type: 'paragraph', text: paragraph })
    }
    return blocks
  }
  if (Array.isArray(value)) {
    for (const item of value) blocks.push(...normalizeBlock(item, warnings, id, workspace, allowOutside))
    return blocks
  }
  if (!isRecord(value)) return blocks

  if (Array.isArray(value.blocks)) {
    for (const item of value.blocks) blocks.push(...normalizeBlock(item, warnings, id, workspace, allowOutside))
  }
  if (value.text) blocks.push({ type: 'paragraph', text: normalizeText(value.text) })
  if (Array.isArray(value.paragraphs)) {
    for (const paragraph of value.paragraphs) {
      if (typeof paragraph === 'string') blocks.push({ type: 'paragraph', text: normalizeText(paragraph) })
    }
  }
  if (Array.isArray(value.bullets) && value.bullets.length) blocks.push({ type: 'bullets', items: cleanLines(value.bullets) })
  if (Array.isArray(value.numbered) && value.numbered.length) blocks.push({ type: 'numbered', items: cleanLines(value.numbered) })
  if (value.table) {
    const table = normalizeTable(value.table, warnings, id)
    if (table) blocks.push(table)
  }
  if (Array.isArray(value.tables)) {
    for (const item of value.tables) {
      const table = normalizeTable(item, warnings, id)
      if (table) blocks.push(table)
    }
  }
  if (value.image) {
    const image = isRecord(value.image) ? value.image : { path: value.image }
    if (image.path) {
      const rawPath = String(image.path)
      const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workspace, rawPath)
      const allowed = allowOutside || isInside(workspace, absolute)
      blocks.push({
        type: 'image',
        path: absolute,
        caption: normalizeText(image.caption ?? ''),
        width: Number(image.width) > 0 ? Number(image.width) : 5.6,
        missing: !allowed || !existsSync(absolute),
        outsideWorkspace: !allowed,
      })
      if (!allowed) warnings.push(`${id}: image outside workspace was blocked: ${rawPath}`)
    }
  }
  if (Array.isArray(value.images)) {
    for (const image of value.images) blocks.push(...normalizeBlock({ image }, warnings, id, workspace, allowOutside))
  }
  if (value.code !== undefined) {
    const code = isRecord(value.code) ? value.code : { text: value.code, caption: value.caption, language: value.language }
    if (code.text !== undefined) {
      blocks.push({
        type: 'code',
        text: String(code.text).replace(/\r\n?/g, '\n').replace(/\s+$/g, ''),
        caption: normalizeText(code.caption ?? ''),
        language: normalizeText(code.language ?? ''),
      })
    }
  }
  if (Array.isArray(value.codeBlocks)) {
    for (const code of value.codeBlocks) blocks.push(...normalizeBlock({ code }, warnings, id, workspace, allowOutside))
  }
  if (value.note) blocks.push({ type: 'note', text: normalizeText(value.note) })
  if (value.pageBreak === true) blocks.push({ type: 'pagebreak' })
  return blocks.slice(0, MAX_BLOCKS)
}

export function normalizeSectionsInput(input, { plan, workspace, allowOutside = false }) {
  const warnings = []
  const known = new Set(plan.sections.map((section) => section.id))
  const normalized = {}
  if (!isRecord(input)) return { sections: normalized, warnings }
  for (const [id, value] of Object.entries(input)) {
    if (!known.has(id)) {
      warnings.push(`unknown section id ignored: ${id}`)
      continue
    }
    const blocks = normalizeBlock(value, warnings, id, workspace, allowOutside)
    if (blocks.length) normalized[id] = blocks
  }
  return { sections: normalized, warnings }
}

function shingles(text, size = 5) {
  const normalized = normalizeText(text).toLowerCase().replace(/[\s\p{P}]/gu, '')
  if (normalized.length <= size) return new Set([normalized])
  const result = new Set()
  for (let index = 0; index <= normalized.length - size; index += 1) result.add(normalized.slice(index, index + size))
  return result
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let intersection = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const item of small) if (large.has(item)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

function textEntries(block) {
  if (!isRecord(block)) return []
  if (block.type === 'paragraph' || block.type === 'note') return [block.text ?? '']
  if (block.type === 'bullets' || block.type === 'numbered') return block.items ?? []
  return []
}

export function dedupeBlocks(blocks, options = {}) {
  const enabled = options.enabled !== false
  if (!enabled) return { blocks, removed: 0, exact: 0, near: 0 }
  const threshold = Number(options.nearThreshold ?? 0.9)
  const minChars = Number(options.minChars ?? 40)
  const seenExact = new Set()
  const seenShingles = []
  let exact = 0
  let near = 0

  const keepText = (text) => {
    const normalized = normalizeText(text)
    if (!normalized) return false
    if (normalized.startsWith('【待补充')) return true
    const exactKey = sha256(normalized)
    if (seenExact.has(exactKey)) {
      exact += 1
      return false
    }
    seenExact.add(exactKey)
    if (normalized.length >= minChars) {
      const shape = shingles(normalized)
      for (const previous of seenShingles) {
        if (jaccard(shape, previous) >= threshold) {
          near += 1
          return false
        }
      }
      seenShingles.push(shape)
    }
    return true
  }

  const next = []
  for (const block of blocks) {
    if (block.type === 'bullets' || block.type === 'numbered') {
      const items = (block.items ?? []).filter((item) => keepText(item))
      if (items.length) next.push({ ...block, items })
      continue
    }
    if (block.type === 'paragraph' || block.type === 'note') {
      if (keepText(block.text)) next.push(block)
      continue
    }
    if (block.type === 'table') {
      const seenRows = new Set()
      const rows = (block.rows ?? []).filter((row) => {
        const key = sha256(row.map((cell) => normalizeText(cell).toLowerCase()).join('\u0001'))
        if (seenRows.has(key)) {
          exact += 1
          return false
        }
        seenRows.add(key)
        return true
      })
      if (rows.length) next.push({ ...block, rows })
      continue
    }
    next.push(block)
  }
  return { blocks: next, removed: exact + near, exact, near }
}

function blocksWordCount(blocks) {
  return blocks.reduce((total, block) => {
    if (block.type === 'paragraph' || block.type === 'note') return total + wordCount(block.text)
    if (block.type === 'bullets' || block.type === 'numbered') return total + (block.items ?? []).reduce((sum, item) => sum + wordCount(item), 0)
    if (block.type === 'table') return total + (block.rows ?? []).reduce((sum, row) => sum + row.reduce((cellSum, cell) => cellSum + wordCount(cell), 0), 0)
    if (block.type === 'code') return total + wordCount(block.text)
    return total
  }, 0)
}

function dedupeAcrossSections(sections, config) {
  if (!config.dedupe?.enabled || !config.dedupe?.acrossSections) return { sections, removed: 0 }
  const threshold = Number(config.dedupe.nearThreshold ?? 0.9)
  const minChars = Number(config.dedupe.minChars ?? 40)
  const seenExact = new Set()
  const seenShingles = []
  let removed = 0

  const keep = (text) => {
    const normalized = normalizeText(text)
    if (!normalized) return false
    if (normalized.startsWith('【待补充')) return true
    const key = sha256(normalized)
    if (seenExact.has(key)) {
      removed += 1
      return false
    }
    seenExact.add(key)
    if (normalized.length >= minChars) {
      const shape = shingles(normalized)
      for (const previous of seenShingles) {
        if (jaccard(shape, previous) >= threshold) {
          removed += 1
          return false
        }
      }
      seenShingles.push(shape)
    }
    return true
  }

  const next = sections.map((section) => {
    const blocks = []
    for (const block of section.blocks) {
      if (block.type === 'paragraph' || block.type === 'note') {
        if (keep(block.text)) blocks.push(block)
      } else if (block.type === 'bullets' || block.type === 'numbered') {
        const items = (block.items ?? []).filter((item) => keep(item))
        if (items.length) blocks.push({ ...block, items })
      } else {
        blocks.push(block)
      }
    }
    return { ...section, blocks, words: blocksWordCount(blocks) }
  })
  return { sections: next, removed }
}

export function buildRenderSections({ plan, sectionStore, config, options = {} }) {
  const previous = sectionStore?.sections ?? {}
  const reuse = options.reuse !== false
  const freshIds = options.freshIds ?? new Set()
  const staleReuse = Boolean(sectionStore?.requirementsDigest && sectionStore.requirementsDigest !== plan.requirementsDigest)
  const warnings = []
  let rendered = []
  const statuses = {}
  const reused = []
  let placeholders = 0
  let dedupedBlocks = 0

  for (const section of plan.sections) {
    const stored = previous[section.id]
    let blocks = stored?.blocks ?? []
    let status = 'missing'
    if (blocks.length) {
      status = freshIds.has(section.id) ? 'ready' : 'reused'
      if (!freshIds.has(section.id)) reused.push(section.id)
    }
    if (!blocks.length) {
      if (section.kind === 'task-group') {
        status = 'structural'
        statuses[section.id] = status
        rendered.push({ ...section, blocks: [], words: 0, status })
        continue
      }
      status = 'missing'
      if (section.required) {
        blocks = [{ type: 'paragraph', text: `【待补充：${section.title.replace(/^[一二三四五六七八九十0-9.、\s]+/, '')}。请根据实验要求补充本节内容。】` }]
        placeholders += 1
      } else {
        statuses[section.id] = 'optional-missing'
        continue
      }
    }
    const deduped = dedupeBlocks(blocks, config.dedupe)
    dedupedBlocks += deduped.removed
    if (deduped.removed) warnings.push(`${section.id}: removed ${deduped.removed} duplicate block(s)`)
    const words = blocksWordCount(deduped.blocks)
    if (section.required && words < section.minWords) {
      warnings.push(`${section.id}: ${words} words, below budget ${section.minWords}`)
    }
    statuses[section.id] = status
    rendered.push({
      ...section,
      blocks: deduped.blocks,
      words,
      status,
      deduped: deduped.removed,
    })
  }

  const globalDedupe = dedupeAcrossSections(rendered, config)
  if (globalDedupe.removed) {
    rendered = globalDedupe.sections
    dedupedBlocks += globalDedupe.removed
    warnings.push(`removed ${globalDedupe.removed} cross-section duplicate block(s)`)
  }
  if (staleReuse && reuse) warnings.push('reused section content from a different requirements digest; pass options.reuse=false to regenerate')
  return {
    sections: rendered,
    statuses,
    reused,
    placeholders,
    warnings,
    staleReuse,
    dedupedBlocks,
    words: rendered.reduce((total, section) => total + section.words, 0),
  }
}

export function buildRenderPayload({ plan, template, sections, config, options = {}, outputPath }) {
  const payload = {
    output: outputPath,
    template: {
      id: template.id,
      name: template.name,
      page: template.page,
      styles: template.styles,
      cover: template.cover,
      header: template.header,
      footer: template.footer,
      toc: template.toc,
    },
    meta: {
      title: plan.title,
      course: plan.cover.course ?? '',
      experiment: plan.cover.experiment ?? plan.title,
      templateId: template.id,
      planId: plan.planId,
    },
    cover: {
      enabled: template.cover?.enabled !== false,
      layout: template.cover?.layout ?? 'center',
      fields: (template.cover?.fields ?? []).map((field) => ({
        key: field.key,
        label: field.label,
        required: field.required === true,
        value: plan.cover[field.key] ?? '',
      })),
    },
    toc: {
      enabled: plan.includeToc === true,
      title: template.toc?.title ?? '目　　录',
    },
    sections: sections.map((section) => ({
      id: section.id,
      title: section.title,
      level: section.level,
      blocks: section.blocks,
    })),
    assets: {
      workspace: config.workspace,
      allowOutside: config.allowOutsideWorkspace === true,
    },
    options: {
      addPageNumbers: template.footer?.pageNumber !== false,
      addHeader: template.header?.enabled !== false,
      headerText: template.header?.text ?? '',
      keepSectionTogether: options.keepSectionTogether === true,
    },
  }
  return payload
}
