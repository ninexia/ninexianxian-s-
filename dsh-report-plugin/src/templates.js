import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileExists, isRecord, readJson, sha256 } from './util.js'

function mergeSections(base, overlay) {
  const map = new Map()
  for (const section of base ?? []) {
    if (!section?.id) continue
    map.set(section.id, { ...section })
  }
  for (const section of overlay ?? []) {
    if (!section?.id) continue
    map.set(section.id, map.has(section.id)
      ? { ...map.get(section.id), ...section }
      : { ...section })
  }
  return [...map.values()]
}

function mergeTemplate(base, overlay) {
  const next = { ...base, ...overlay }
  next.sections = mergeSections(base.sections, overlay.sections)
  next.styles = { ...(base.styles ?? {}), ...(overlay.styles ?? {}) }
  next.cover = { ...(base.cover ?? {}), ...(overlay.cover ?? {}) }
  next.match = { ...(base.match ?? {}), ...(overlay.match ?? {}) }
  next.match.keywords = { ...(base.match?.keywords ?? {}), ...(overlay.match?.keywords ?? {}) }
  next._sources = [...(base._sources ?? []), ...(overlay._sources ?? [])]
  return next
}

function validateTemplate(template, source) {
  const errors = []
  if (!template || !isRecord(template)) return [`${source}: not a JSON object`]
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(String(template.id ?? ''))) errors.push(`${source}: invalid id`)
  if (!template.name) errors.push(`${source}: missing name`)
  if (!Array.isArray(template.sections) || template.sections.length === 0) errors.push(`${source}: missing sections`)
  for (const [index, section] of (template.sections ?? []).entries()) {
    if (!section?.id) errors.push(`${source}: section ${index} missing id`)
    if (!section?.title) errors.push(`${source}: section ${section?.id ?? index} missing title`)
    if (![1, 2, 3].includes(Number(section?.level))) errors.push(`${source}: section ${section?.id ?? index} level must be 1..3`)
    if (!['paragraphs', 'list', 'table', 'task-group', 'mixed'].includes(section?.kind)) {
      errors.push(`${source}: section ${section?.id ?? index} invalid kind`)
    }
  }
  return errors
}

async function readTemplateDir(dir) {
  if (!dir || !fileExists(dir)) return []
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const results = []
  for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
    if (name === 'registry.json' || name === 'template.schema.json') continue
    const path = join(dir, name)
    const value = await readJson(path, null)
    if (value) results.push({ path, value })
  }
  return results
}

export async function loadTemplates(config, cache) {
  const registryPath = join(config.packageDir, 'templates', 'registry.json')
  const registry = await readJson(registryPath, { default: config.defaultTemplate, templates: [] })
  const warnings = []
  const errors = []
  const templates = new Map()

  const sources = []
  for (const file of registry.templates ?? []) {
    const path = join(config.packageDir, 'templates', file)
    const value = await readJson(path, null)
    if (!value) {
      warnings.push(`template missing or unreadable: ${path}`)
      continue
    }
    sources.push({ path, value })
  }
  for (const entry of await readTemplateDir(config.templateDir)) sources.push(entry)
  for (const entry of await readTemplateDir(config.templateOverlayDir)) sources.push(entry)

  const hashes = []
  for (const source of sources) {
    const invalid = validateTemplate(source.value, source.path)
    if (invalid.length) {
      warnings.push(...invalid)
      continue
    }
    const template = { ...source.value, _sources: [source.path] }
    hashes.push(`${source.path}:${sha256(source.value).slice(0, 16)}`)
    if (templates.has(template.id)) {
      templates.set(template.id, mergeTemplate(templates.get(template.id), template))
    } else {
      templates.set(template.id, template)
    }
  }

  const defaultId = templates.has(config.defaultTemplate)
    ? config.defaultTemplate
    : (templates.has(registry.default) ? registry.default : templates.keys().next().value)
  if (!defaultId) errors.push('no usable report templates found')

  const index = {
    cachedAt: new Date().toISOString(),
    digest: sha256(hashes.join('\n')).slice(0, 24),
    defaultId,
    templates: [...templates.values()].map((template) => ({
      id: template.id,
      name: template.name,
      version: template.version ?? 1,
      priority: template.priority ?? 0,
      sections: template.sections.length,
      sources: template._sources,
      keywords: Object.keys(template.match?.keywords ?? {}),
    })),
    warnings,
  }
  await cache.putTemplateIndex(index)
  return { templates, registry, defaultId, index, warnings, errors }
}

export function publicTemplate(template) {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    version: template.version ?? 1,
    sections: template.sections.length,
    toc: Boolean(template.toc?.enabled),
    coverFields: (template.cover?.fields ?? []).length,
  }
}
