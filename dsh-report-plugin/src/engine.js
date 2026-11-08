import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { Cache } from './cache.js'
import { resolveConfig } from './config.js'
import { buildPlan, FIELD_PATTERNS, scoreTemplates } from './plan.js'
import { loadTemplates } from './templates.js'
import { learnTemplate } from './learn.js'
import { buildRenderSections, normalizeSectionsInput } from './content.js'
import { inspectDocx, sectionsToDocx } from './markdown2docx.js'  // 使用纯 JS 的 inspect + 结构直渲染
import { validateBuild } from './validate.js'
import { ingestHistory } from './history.js'
import {
  dateStamp,
  deepMerge,
  ensureDir,
  fileExists,
  isInside,
  normalizeKey,
  normalizeText,
  safeFilePart,
  sha256,
  shortHash,
  writeJsonAtomic,
} from './util.js'

export class ReportError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ReportError'
    this.code = code
  }
}

function projectKeyFor(plan) {
  return `${safeFilePart(plan.title, 'report')}-${shortHash(`${plan.cover.course ?? ''}|${plan.title}`, 8)}`
}

function courseFromText(text) {
  for (const pattern of FIELD_PATTERNS.course ?? []) {
    const match = normalizeText(text).match(pattern)
    if (match?.[1]) return match[1].trim()
  }
  return ''
}

// 课程名优先于关键词打分：学过这门课就按那门课的模板走
function templateForCourse(templates, label) {
  const key = normalizeKey(label)
  if (!key || key.length < 2) return null
  let loose = null
  for (const template of templates.values()) {
    const aliases = [template.course?.name, ...(template.course?.aliases ?? [])]
      .filter(Boolean)
      .map((item) => normalizeKey(item))
    if (aliases.some((alias) => alias && alias === key)) return template
    if (!loose && aliases.some((alias) => alias.length >= 2 && (key.includes(alias) || alias.includes(key)))) loose = template
  }
  return loose
}

function coverPayload(template, plan) {
  const cover = template.cover ?? {}
  if (cover.enabled === false) return { enabled: false }
  return {
    enabled: true,
    layout: cover.layout ?? 'center',
    courseSize: cover.courseSize,
    semesterSize: cover.semesterSize,
    titleSize: cover.titleSize,
    infoSize: cover.infoSize,
    spacerLines: cover.spacerLines,
    fields: (cover.fields ?? []).map((field) => ({
      key: field.key,
      label: field.label,
      value: plan.cover[field.key] ?? '',
    })),
  }
}

// 复用信息只给写正文需要的：id/标题/字数预算/一句话提示
function compactPlan(plan, template, detail = {}) {
  const payload = {
    ok: true,
    action: 'plan',
    planId: plan.planId,
    template: template.id,
    title: plan.title,
    cover: plan.cover,
    sections: plan.sections.map((section) => {
      const row = { id: section.id, title: section.title, level: section.level, minWords: section.minWords }
      if (section.hint) row.hint = section.hint
      if (!section.required) row.optional = true
      return row
    }),
  }
  if (plan.missingCover.length) payload.missingCover = plan.missingCover.map((field) => field.key)
  if (plan.warnings.length) payload.warnings = plan.warnings
  if (detail.via) payload.via = detail.via
  if (detail.altTemplate) payload.altTemplate = detail.altTemplate
  payload.next = plan.missingCover.length
    ? `Fill cover fields: ${plan.missingCover.map((field) => field.key).join(', ')}; then call action=build with planId and a sections map.`
    : 'Write only the sections you can support from evidence, then call action=build with planId and a sections map keyed by these ids.'
  return payload
}

function compactBuild(plan, result) {
  const validation = result.validation ?? {}
  const all = [...new Set([...(result.warnings ?? []), ...(validation.warnings ?? [])])]
  // 字数不足是最常见也最不紧急的提示，排到后面，免得挤掉输入错误
  const ordered = [...all.filter((warning) => !/below budget|低于/.test(warning)), ...all.filter((warning) => /below budget|低于/.test(warning))]
  const warnings = ordered.slice(0, 6)
  const errors = [...new Set(validation.errors ?? [])].slice(0, 4)
  return {
    ok: validation.ok === true,
    action: 'build',
    path: result.path,
    planId: plan.planId,
    bytes: result.bytes,
    sections: {
      planned: plan.sections.length,
      rendered: result.renderedSections,
      reused: result.reused.length,
      placeholders: result.placeholders,
    },
    missing: result.missingSections,
    errors,
    warnings,
    cacheHit: result.cacheHit === true,
    next: validation.ok
      ? 'Deliver this path. Rebuild with the same planId and only the sections you changed if anything looks off.'
      : `Fix errors and call action=build again with planId=${plan.planId} and only the changed sections.`,
  }
}


export async function createEngine({ config: rawConfig, workspace, packageDir }) {
  const { config, problems } = resolveConfig(rawConfig, { workspace, packageDir })
  if (problems.length) throw new ReportError('CONFIG_INVALID', problems.join('; '))
  const cache = new Cache(config.cacheDir)
  const loaded = await loadTemplates(config, cache)
  if (loaded.errors.length) throw new ReportError('TEMPLATE_INVALID', loaded.errors.join('; '))
  return new Engine({ config, cache, loaded, workspace: config.workspace })
}

export class Engine {
  constructor({ config, cache, loaded, workspace }) {
    this.config = config
    this.cache = cache
    this.loaded = loaded
    this.workspace = workspace
  }

  renderer() {
    // v0.3.0: documents are rendered in-process by src/markdown2docx.js.
    return { ok: true, engine: 'markdown2docx', dependency: 'docx' }
  }

  template(id) {
    const template = this.loaded.templates.get(id)
    if (!template) throw new ReportError('TEMPLATE_NOT_FOUND', `unknown template: ${id}`)
    return template
  }

  async history({ scope = 'all', force = false } = {}) {
    return ingestHistory({ config: this.config, workspace: this.workspace, cache: this.cache, scope, force })
  }

  async ensureHistory() {
    if (!this.config.autoIngest || !this.config.history.enabled) return null
    try {
      return await this.history({ scope: 'all', force: false })
    } catch {
      return null
    }
  }

  async status({ refreshHistory = false, historyScope = 'all' } = {}) {
    const history = this.config.history.enabled
      ? await this.history({ scope: historyScope, force: refreshHistory }).catch((error) => ({ ok: false, error: error.message }))
      : null
    const payload = {
      ok: true,
      action: 'status',
      defaultTemplate: this.loaded.defaultId,
      templates: [...this.loaded.templates.values()].map((template) => {
        const row = { id: template.id, name: template.name, sections: template.sections.length }
        if (template.course?.name) row.course = template.course.name
        if (template.source?.docx) row.from = template.source.docx
        return row
      }),
      cache: {
        history: history?.ok
          ? { docs: history.docx.unique, sessions: history.sessions.relevant }
          : { error: history?.error ?? 'disabled' },
      },
      next: 'Call action=plan with the requirements. Pass course to force a course template, or action=template with a DOCX path to learn one.',
    }
    if (this.loaded.warnings.length) payload.templateWarnings = this.loaded.warnings.slice(0, 4)
    return payload
  }

  async plan({ requirements, templateId, course, cover = {}, options = {} } = {}) {
    const text = normalizeText(requirements)
    if (!text) throw new ReportError('REQUIREMENTS_REQUIRED', 'requirements is required for action=plan')
    const scores = scoreTemplates(this.loaded.templates, text)
    const courseLabel = String(course ?? '').trim() || courseFromText(text)
    let template
    let via = 'default'
    if (templateId) {
      template = this.template(templateId)
      via = 'templateId'
    } else {
      const matched = templateForCourse(this.loaded.templates, courseLabel)
      if (matched) {
        template = matched
        via = 'course'
      } else {
        const best = scores[0]
        template = this.loaded.templates.get(best?.score > 0 ? best.id : this.loaded.defaultId) ?? this.template(this.loaded.defaultId)
        via = best?.score > 0 ? 'keywords' : 'default'
      }
    }
    if (options.templateOverrides) {
      template = deepMerge(template, options.templateOverrides)
    }
    const plan = buildPlan({
      template,
      requirements: text,
      providedCover: cover,
      options,
      templateDigest: this.loaded.index.digest,
    })
    plan.projectKey = projectKeyFor(plan)
    plan.options = {
      includeToc: plan.includeToc,
      includeSections: options.includeSections ?? [],
      excludeSections: options.excludeSections ?? [],
    }
    await this.cache.putPlan(plan)
    const history = await this.ensureHistory()
    const previous = await this.cache.getProject(plan.projectKey)
    if (!previous) {
      await this.cache.putProject(plan.projectKey, {
        projectKey: plan.projectKey,
        title: plan.title,
        course: plan.cover.course ?? '',
        requirementsDigest: plan.requirementsDigest,
        lastPlanId: plan.planId,
        sections: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }
    const runnerUp = scores.find((item) => item.id !== template.id && item.score > 0)
    const altTemplate = via !== 'course' && runnerUp && scores[0]?.score > 0 && runnerUp.score >= scores[0].score * 0.85
      ? runnerUp.id
      : undefined
    return compactPlan(plan, template, { via, altTemplate })
  }

  async loadPlan(planId) {
    const plan = planId ? await this.cache.getPlan(planId) : null
    if (!plan) throw new ReportError('PLAN_NOT_FOUND', `plan cache not found: ${planId}. Call action=plan again.`)
    return plan
  }

  async build({ planId, requirements, templateId, cover = {}, sections = {}, outPath, options = {} } = {}) {
    const started = Date.now()
    let plan = planId ? await this.loadPlan(planId) : null
    if (!plan) {
      const planned = await this.plan({ requirements, templateId, cover, options })
      plan = await this.loadPlan(planned.planId)
    }
    const template = this.template(plan.templateId)
    const projectKey = plan.projectKey ?? projectKeyFor(plan)
    const previous = await this.cache.getProject(projectKey) ?? {
      projectKey,
      title: plan.title,
      course: plan.cover.course ?? '',
      sections: {},
      createdAt: new Date().toISOString(),
    }

    const normalized = normalizeSectionsInput(sections, {
      plan,
      workspace: this.workspace,
      allowOutside: this.config.allowOutsideWorkspace,
    })
    const incoming = Object.keys(normalized.sections).length
    const sameRequirements = previous.requirementsDigest === plan.requirementsDigest
    const allowReuse = options.reuse === true || (options.reuse !== false && (sameRequirements || previous.lastPlanId === plan.planId))
    const store = {
      ...previous,
      requirementsDigest: plan.requirementsDigest,
      lastPlanId: plan.planId,
      sections: { ...(allowReuse ? previous.sections ?? {} : {}) },
      updatedAt: new Date().toISOString(),
    }
    for (const [id, blocks] of Object.entries(normalized.sections)) {
      store.sections[id] = {
        blocks,
        hash: sha256(blocks).slice(0, 16),
        words: blocks.reduce((total, block) => total + (block.text?.length ?? 0), 0),
        planId: plan.planId,
        updatedAt: new Date().toISOString(),
      }
    }

    const built = buildRenderSections({
      plan,
      sectionStore: store,
      config: this.config,
      options: { reuse: allowReuse, freshIds: new Set(Object.keys(normalized.sections)) },
    })
    const missingSections = plan.sections
      .filter((section) => section.required && !built.sections.some((item) => item.id === section.id))
      .map((section) => section.id)
    const outputPath = this.resolveOutputPath(outPath, plan)
    const buildHash = sha256({
      rendererVersion: '0.3.0',
      planId: plan.planId,
      templateDigest: plan.templateDigest,
      sectionHashes: Object.fromEntries(built.sections.map((section) => [section.id, sha256(section.blocks).slice(0, 16)])),
      outputPath,
      dedupe: this.config.dedupe,
    }).slice(0, 20)
    const cachedBuild = await this.cache.getBuild(buildHash)
    if (!options.force && cachedBuild?.path === outputPath && fileExists(outputPath)) {
      return compactBuild(plan, {
        ...cachedBuild,
        cacheHit: true,
        elapsedMs: Date.now() - started,
      })
    }

    // 结构化正文直接渲染，封面/字体/表格/图片都走模板
    let rendered
    try {
      rendered = await sectionsToDocx(built.sections, outputPath, {
        cover: coverPayload(template, plan),
        styles: template.styles ?? {},
        page: template.page ?? {},
        header: template.header ?? {},
        footer: template.footer ?? {},
        toc: { enabled: plan.includeToc === true, title: template.toc?.title ?? '目　　录' },
        title: plan.title,
      })
    } catch (error) {
      throw new ReportError('RENDER_FAILED', error.message)
    }
    if (!rendered.ok) throw new ReportError('RENDER_FAILED', rendered.error ?? 'renderer failed')
    const inspect = await inspectDocx(outputPath)
    const validation = this.config.validation.enabled
      ? validateBuild({ plan, template, result: rendered, inspect, config: this.config, build: built })
      : { ok: true, score: 100, errors: [], warnings: [], checks: [], metrics: inspect }

    const result = {
      ok: validation.ok,
      path: outputPath,
      bytes: rendered.bytes,
      planId: plan.planId,
      buildHash,
      template: plan.templateId,
      title: plan.title,
      renderedSections: built.sections.length,
      reused: built.reused,
      missingSections,
      placeholders: built.placeholders,
      dedupedBlocks: built.dedupedBlocks ?? 0,
      warnings: [...built.warnings, ...normalized.warnings, ...(rendered.warnings ?? [])],
      validation,
      cacheHit: false,
      elapsedMs: Date.now() - started,
      inspectedAt: new Date().toISOString(),
    }
    const manifest = {
      ...result,
      sectionHashes: Object.fromEntries(built.sections.map((section) => [section.id, sha256(section.blocks).slice(0, 16)])),
      builtAt: new Date().toISOString(),
    }
    store.lastBuild = { path: outputPath, buildHash, at: manifest.builtAt, ok: validation.ok }
    store.requirementsDigest = plan.requirementsDigest
    await this.cache.putBuild(buildHash, manifest)
    await this.cache.putProject(projectKey, store)
    return compactBuild(plan, result)
  }

  resolveOutputPath(outPath, plan) {
    let target
    if (outPath) {
      target = isAbsolute(outPath) ? resolve(outPath) : resolve(this.workspace, outPath)
    } else {
      const name = `${safeFilePart(plan.title, '实验报告')}_${dateStamp()}.docx`
      target = resolve(this.config.outputDir, name)
    }
    if (!this.config.allowOutsideWorkspace && !isInside(this.workspace, target)) {
      throw new ReportError('OUTPUT_OUTSIDE_WORKSPACE', `output path must stay inside ${this.workspace}`)
    }
    if (!target.toLowerCase().endsWith('.docx')) throw new ReportError('OUTPUT_NOT_DOCX', 'outPath must end with .docx')
    return target
  }

  async validate({ path, planId } = {}) {
    if (!path) throw new ReportError('PATH_REQUIRED', 'path is required for action=validate')
    const target = isAbsolute(path) ? resolve(path) : resolve(this.workspace, path)
    if (!fileExists(target)) throw new ReportError('FILE_NOT_FOUND', `DOCX not found: ${target}`)
    const inspect = await inspectDocx(target)
    if (!inspect.ok) throw new ReportError('INSPECT_FAILED', inspect.error ?? 'inspect failed')
    let validation = {
      ok: (inspect.placeholders ?? []).length === 0,
      score: 100,
      errors: [],
      warnings: [],
      checks: [],
      metrics: inspect,
    }
    if (planId) {
      const plan = await this.loadPlan(planId)
      const template = this.template(plan.templateId)
      validation = validateBuild({
        plan,
        template,
        result: { ok: true, bytes: inspect.bytes, warnings: [] },
        inspect,
        config: this.config,
        build: { placeholders: (inspect.placeholders ?? []).length },
      })
    } else {
      const placeholders = inspect.placeholders ?? []
      validation.warnings.push(...placeholders.map((token) => `placeholder remains: ${token}`))
      validation.ok = placeholders.length === 0
      validation.score = Math.max(0, 100 - validation.warnings.length * 5)
    }
    return {
      ok: validation.ok,
      action: 'validate',
      path: target,
      errors: (validation.errors ?? []).slice(0, 6),
      warnings: (validation.warnings ?? []).slice(0, 6),
      structure: {
        paragraphs: inspect.paragraphs,
        tables: inspect.tables,
        images: inspect.images,
        words: inspect.words,
        duplicateRatio: Number((inspect.duplicateRatio ?? 0).toFixed(3)),
      },
      next: validation.ok ? 'Validation passed; deliver the DOCX.' : 'Fix errors and rebuild only the affected sections.',
    }
  }

  // 把一门课以前的 DOCX 学成模板，之后同课程的报告直接复用它的章节与封面
  async learn({ path, course, name, templateId, force = false } = {}) {
    if (!path) throw new ReportError('PATH_REQUIRED', 'path is required for action=template')
    const target = isAbsolute(path) ? resolve(path) : resolve(this.workspace, path)
    if (!fileExists(target)) throw new ReportError('FILE_NOT_FOUND', `DOCX not found: ${target}`)
    const learned = await learnTemplate({
      docxPath: target,
      workspace: this.workspace,
      overlayDir: this.config.templateOverlayDir,
      course,
      name,
      templateId,
      force,
    })
    const saved = join(this.config.templateOverlayDir, `${safeFilePart(learned.id)}.json`)
    await writeJsonAtomic(saved, learned)
    return {
      ok: true,
      action: 'template',
      templateId: learned.id,
      course: learned.course?.name ?? null,
      sections: learned.sections.length,
      coverFields: learned.cover.fields.map((field) => field.key),
      saved: relative(this.workspace, saved).replace(/\\/g, '/'),
      next: `Template ${learned.id} is ready. Call action=plan with the requirements (course="${learned.course?.name ?? ''}") to use it.`,
    }
  }

  async ingest({ scope = 'all', force = true } = {}) {
    const index = await this.history({ scope, force })
    return {
      ok: index.ok,
      action: 'ingest',
      scope,
      cacheHit: index.cacheHit === true,
      digest: index.digest,
      generatedAt: index.generatedAt,
      docx: { scanned: index.docx.scanned, unique: index.docx.unique, errors: index.docx.errors.length },
      sessions: { scanned: index.sessions.scanned, relevant: index.sessions.relevant, errors: index.sessions.errors.length },
      hints: {
        headings: index.hints.headings.slice(0, 12),
        styles: index.hints.styles.slice(0, 6),
        keywords: index.hints.keywords.slice(0, 10),
      },
      elapsedMs: index.elapsedMs,
      next: 'Historical structure is cached. Plans now reuse it without rescanning; pass force=true only when old reports changed.',
    }
  }
}

export async function engineFromWorkspace({ config, workspace, packageDir }) {
  return createEngine({ config, workspace, packageDir })
}
