import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Cache } from './cache.js'
import { resolveConfig } from './config.js'
import { buildPlan, scoreTemplates } from './plan.js'
import { loadTemplates, publicTemplate } from './templates.js'
import { buildRenderPayload, buildRenderSections, normalizeSectionsInput } from './content.js'
import { inspectDocx, markdownToDocx } from './markdown2docx.js'  // 使用纯 JS 的 inspect
import { validateBuild } from './validate.js'
import { ingestHistory } from './history.js'
import {
  dateStamp,
  deepMerge,
  ensureDir,
  fileExists,
  isInside,
  normalizeText,
  safeFilePart,
  sha256,
  shortHash,
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

function compactPlan(plan, template, scores) {
  return {
    planId: plan.planId,
    template: { id: template.id, name: template.name, version: plan.templateVersion },
    title: plan.title,
    cover: plan.cover,
    coverSources: plan.coverSources,
    missingCover: plan.missingCover,
    includeToc: plan.includeToc,
    stats: plan.stats,
    warnings: plan.warnings,
    sections: plan.sections.map((section) => ({
      id: section.id,
      title: section.title,
      level: section.level,
      kind: section.kind,
      required: section.required,
      minWords: section.minWords,
      hint: section.hint,
      parentId: section.parentId,
    })),
    candidates: scores?.slice(0, 4).map((item) => ({ id: item.id, score: item.score, hits: item.hits })),
  }
}

function compactBuild(plan, result) {
  return {
    ok: result.validation.ok,
    action: 'build',
    planId: plan.planId,
    path: result.path,
    bytes: result.bytes,
    template: plan.templateId,
    title: plan.title,
    sections: {
      planned: plan.sections.length,
      rendered: result.renderedSections,
      reused: result.reused.length,
      missing: result.missingSections.length,
      placeholders: result.placeholders,
    },
    validation: result.validation,
    warnings: (result.warnings ?? []).slice(0, 8),
    cache: {
      hit: result.cacheHit === true,
      reusedSections: result.reused,
      dedupedBlocks: result.dedupedBlocks,
    },
    elapsedMs: result.elapsedMs,
    next: result.validation.ok
      ? 'Review the DOCX visually if layout matters; otherwise deliver this path.'
      : `Fix validation errors, then call action=build with planId=${plan.planId} and only changed sections.`,
  }
}

function blockToMarkdown(block) {
  const type = block?.type ?? 'paragraph'
  if (type === 'bullets') return (block.items ?? []).map((item) => `- ${item}`).join('\n')
  if (type === 'numbered') return (block.items ?? []).map((item, index) => `${index + 1}. ${item}`).join('\n')
  if (type === 'table') {
    const headers = block.headers ?? []
    if (!headers.length) return ''
    const head = `| ${headers.join(' | ')} |`
    const sep = `| ${headers.map(() => '---').join(' | ')} |`
    const rows = (block.rows ?? []).map((row) => `| ${row.join(' | ')} |`).join('\n')
    return rows ? `${head}\n${sep}\n${rows}` : `${head}\n${sep}`
  }
  if (type === 'code') return ['```', block.text ?? '', '```'].join('\n')
  if (type === 'note') return `> ${block.text ?? ''}`
  if (type === 'image') return block.caption ? `（图：${block.caption}）` : ''
  return block.text ?? ''
}

function buildMarkdownFromSections(sections, plan, template) {
  let markdown = `# ${plan.title}\n\n`

  // 封面信息
  if (plan.cover) {
    const cover = plan.cover
    markdown += '## 封面\n\n'
    markdown += `> **课程名称**：${cover.course || ''}\n\n`
    markdown += `> **学生姓名**：${cover.name || ''}\n\n`
    markdown += `> **学号**：${cover.studentId || ''}\n\n`
    markdown += `> **班级**：${cover.className || cover.class || ''}\n\n`
    markdown += `> **提交日期**：${cover.date || cover.submitDate || ''}\n\n`
  }

  markdown += `---\n\n`

  // 遍历章节
  for (const section of sections) {
    markdown += `## ${section.title}\n\n`
    for (const block of section.blocks) {
      const text = blockToMarkdown(block)
      if (text) markdown += `${text}\n\n`
    }
  }

  return markdown
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
    // v0.2.0: documents are rendered in-process by src/markdown2docx.js.
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
    const renderer = this.renderer()
    return {
      ok: true,
      action: 'status',
      version: '0.2.0',
      workspace: this.workspace,
      defaultTemplate: this.loaded.defaultId,
      templates: [...this.loaded.templates.values()].map(publicTemplate),
      templateWarnings: this.loaded.warnings,
      renderer,
      cache: {
        dir: this.config.cacheDir,
        templateDigest: this.loaded.index.digest,
        history: history?.ok
          ? { docs: history.docx.unique, sessions: history.sessions.relevant, cacheHit: history.cacheHit, age: history.generatedAt }
          : { error: history?.error ?? 'disabled' },
      },
      config: {
        outputDir: this.config.outputDir,
        maxOutputChars: this.config.maxOutputChars,
        autoIngest: this.config.autoIngest,
        dedupe: this.config.dedupe,
      },
      next: 'Call action=plan with the full experiment requirements. Then call action=build with a sections map keyed by section id.',
    }
  }

  async plan({ requirements, templateId, cover = {}, options = {} } = {}) {
    const text = normalizeText(requirements)
    if (!text) throw new ReportError('REQUIREMENTS_REQUIRED', 'requirements is required for action=plan')
    const scores = scoreTemplates(this.loaded.templates, text)
    const requested = templateId || this.loaded.defaultId
    let template
    if (templateId) {
      template = this.template(templateId)
    } else {
      const best = scores[0]
      template = this.loaded.templates.get(best?.score > 0 ? best.id : requested) ?? this.template(requested)
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
    const result = compactPlan(plan, template, scores)
    result.cache = {
      templateDigest: this.loaded.index.digest,
      historyDocs: history?.docx?.unique ?? 0,
      historySessions: history?.sessions?.relevant ?? 0,
      historyHit: history?.cacheHit === true,
      priorSections: Object.keys(previous?.sections ?? {}).length,
    }
    result.next = plan.missingCover.length
      ? `Provide cover fields: ${plan.missingCover.map((field) => field.key).join(', ')}; then write sections and call action=build.`
      : 'Write only the sections you can support from evidence, then call action=build with planId and a sections map. Missing required sections become visible placeholders.'
    return result
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
      rendererVersion: '0.2.0',
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

    // 生成 Markdown 内容（从 sections 构建）
    const markdown = buildMarkdownFromSections(built.sections, plan, template)
    
    // 直接调用纯 JS 渲染器生成 docx
    let rendered
    try {
      rendered = await markdownToDocx(markdown, outputPath)
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
      template: planId ? (await this.loadPlan(planId)).templateId : undefined,
      validation,
      structure: {
        paragraphs: inspect.paragraphs,
        tables: inspect.tables,
        images: inspect.images,
        headings: inspect.headings.length,
        words: inspect.words,
        duplicateRatio: inspect.duplicateRatio,
      },
      next: validation.ok ? 'Validation passed; deliver the DOCX.' : 'Fix errors and rebuild only the affected sections.',
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
