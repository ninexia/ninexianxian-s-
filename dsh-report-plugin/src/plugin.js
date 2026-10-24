import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createEngine, ReportError } from './engine.js'
import { truncate } from './util.js'

export const name = 'report-docx'
export const inject = ['tools']

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const ACTION_VALUES = ['status', 'plan', 'build', 'validate', 'ingest']

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ACTION_VALUES,
      description: 'status=capabilities/cache; plan=parse requirements; build=render DOCX; validate=inspect DOCX; ingest=reindex history.',
    },
    requirements: {
      type: 'string',
      description: 'Full current experiment requirements. Required for plan; optional for build only when planId is supplied.',
    },
    templateId: {
      type: 'string',
      description: 'Template id from status. Omit to auto-match the requirements.',
    },
    planId: {
      type: 'string',
      description: 'Plan id returned by action=plan. Reuse it for incremental builds.',
    },
    sections: {
      type: 'object',
      additionalProperties: true,
      description: 'Map section id -> content. Content may be a string, array, or object with paragraphs/bullets/numbered/tables/images/code/blocks.',
    },
    cover: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Cover field overrides keyed by field key or label (course, experiment, name, studentId, className, teacher, date, college, major, semester).',
    },
    outPath: {
      type: 'string',
      description: 'Output .docx path relative to the workspace. Defaults to reports/<experiment>_<yyyymmdd>.docx.',
    },
    options: {
      type: 'object',
      additionalProperties: false,
      properties: {
        includeToc: { type: 'boolean' },
        includeSections: { type: 'array', items: { type: 'string' } },
        excludeSections: { type: 'array', items: { type: 'string' } },
        fullTemplate: { type: 'boolean', description: 'Include optional sections even without trigger keywords.' },
        reuse: { type: 'boolean', description: 'Reuse prior section content even when the requirements digest changed.' },
        force: { type: 'boolean', description: 'Re-render even when the build cache is valid.' },
        keepSectionTogether: { type: 'boolean' },
        templateOverrides: { type: 'object', additionalProperties: true },
      },
    },
    scope: {
      type: 'string',
      enum: ['all', 'workspace', 'sessions'],
      description: 'History scan scope for ingest/status.',
    },
    force: {
      type: 'boolean',
      description: 'Force a history reindex (ingest) or a rebuild (build).',
    },
    path: {
      type: 'string',
      description: 'Path to the DOCX file to validate. Required for action=validate.',
    },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    planId: { type: 'string' },
    path: { type: 'string' },
    next: { type: 'string' },
  },
}

const PROMPT = `## Report DOCX
When the user asks for an experiment/report DOCX, call report_docx action=plan with the full requirements. Do not paste or restate the template. Then write only the sections supported by evidence and call action=build with planId plus a sections map keyed by section id; reuse returned section ids for later edits. Never invent screenshots, measurements, logs, or experimental results. If required cover fields are missing, ask once or leave them for the user; do not guess personal data. Deliver the returned .docx path and mention validation warnings only when they affect the deliverable.`

function textContent(value, maxChars) {
  const text = JSON.stringify(value, null, 2)
  return [{ type: 'text', text: truncate(text, maxChars) }]
}

function workspaceFor(exec, workingDirectory) {
  const agent = exec.agent
  try {
    if (workingDirectory && agent?.session) return workingDirectory.get(agent.session)
  } catch {
    // fall through
  }
  return agent?.session?.header?.cwd ?? process.cwd()
}

async function dispatch(engine, args) {
  switch (args.action) {
    case 'status':
      return engine.status({ refreshHistory: args.force === true, historyScope: args.scope ?? 'all' })
    case 'plan':
      return engine.plan({
        requirements: args.requirements,
        templateId: args.templateId,
        cover: args.cover,
        options: args.options,
      })
    case 'build':
      return engine.build({
        planId: args.planId,
        requirements: args.requirements,
        templateId: args.templateId,
        cover: args.cover,
        sections: args.sections,
        outPath: args.outPath,
        options: { ...(args.options ?? {}), force: args.options?.force === true || args.force === true },
      })
    case 'validate':
      if (!args.path) {
        throw new ReportError('PATH_REQUIRED', 'path is required for action=validate')
      }
      return engine.validate({ path: args.path, planId: args.planId })
    case 'ingest':
      return engine.ingest({ scope: args.scope ?? 'all', force: args.force !== false })
    default:
      throw new ReportError('UNKNOWN_ACTION', `unknown action: ${args.action}`)
  }
}

export function apply(ctx, config = {}) {
  const tools = ctx.get('tools')
  if (!tools) return
  const workingDirectory = ctx.get('workingDirectory')

  ctx.effect(() => tools.register({
    name: 'report_docx',
    description: 'Generate, incrementally update, or validate a DOCX experiment report. Use action=plan first with the full requirements, then action=build with a sections map keyed by plan section ids. Reuses historical templates, cached section content, dedupe, and validation. Does not invent experimental evidence.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => textContent(value, config.maxOutputChars ?? 12000),
    },
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const workspace = workspaceFor(exec, workingDirectory)
      try {
        if (!args || typeof args !== 'object' || !ACTION_VALUES.includes(args.action)) {
          throw new ReportError('INVALID_ARGUMENT', `action must be one of: ${ACTION_VALUES.join(', ')}`)
        }
        const engine = await createEngine({ config, workspace, packageDir: PACKAGE_DIR })
        return await dispatch(engine, args)
      } catch (error) {
        if (error instanceof ReportError) {
          return { ok: false, action: args.action, error: { code: error.code, message: error.message }, next: 'Fix the request and retry; cached data is unchanged.' }
        }
        ctx.logger?.warn?.(`report-docx: ${error.stack ?? error.message}`)
        return { ok: false, action: args.action, error: { code: 'INTERNAL', message: error.message }, next: 'Inspect the plugin log; if this persists, run action=status to check Python and cache health.' }
      }
    },
  }))

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    ctx.effect(() => systemPrompt.section({
      name: 'report-docx',
      order: 80,
      text: PROMPT,
    }))
  }
}
