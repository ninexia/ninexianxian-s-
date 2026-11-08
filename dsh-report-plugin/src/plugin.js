import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createEngine, ReportError } from './engine.js'
import { truncate } from './util.js'

export const name = 'report-docx'
export const inject = ['tools']

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const ACTION_VALUES = ['status', 'plan', 'build', 'validate', 'template']

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ACTION_VALUES,
      description: 'status=list templates; plan=requirements -> section ids; build=render DOCX; validate=inspect a DOCX; template=learn a course template from a past DOCX.',
    },
    requirements: {
      type: 'string',
      description: 'Full experiment requirements, verbatim from the user. Required for plan.',
    },
    planId: {
      type: 'string',
      description: 'From action=plan. Build reuses that plan and its cached section content.',
    },
    sections: {
      type: 'object',
      additionalProperties: true,
      description: 'Map section id -> content: a string, an array, or {paragraphs, bullets, numbered, tables, images, code, blocks}.',
    },
    cover: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Cover values by field key: course, experiment, name, studentId, className, major, college, teacher, date, semester.',
    },
    course: {
      type: 'string',
      description: 'Course name, e.g. "人机交互" or "Java EE". plan prefers the learned template for that course; template records it.',
    },
    templateId: {
      type: 'string',
      description: 'Force one template instead of matching by course or keywords.',
    },
    outPath: {
      type: 'string',
      description: 'Output .docx path inside the workspace. Defaults to reports/<title>_<yyyymmdd>.docx.',
    },
    path: {
      type: 'string',
      description: 'DOCX path: the source report for action=template, the file to inspect for action=validate.',
    },
    options: {
      type: 'object',
      additionalProperties: false,
      properties: {
        includeToc: { type: 'boolean' },
        fullTemplate: { type: 'boolean', description: 'Include optional sections even when no keyword matches.' },
        reuse: { type: 'boolean', description: 'Default true: keep sections already built for this project.' },
      },
    },
    force: { type: 'boolean', description: 'Ignore caches: rescan history (status), re-render (build), relearn (template).' },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    path: { type: 'string' },
    next: { type: 'string' },
  },
}

const PROMPT = `## Report DOCX
Report work, one call per step: plan(requirements) → build(planId, sections) → validate(path). action=template learns a course template from a past DOCX so later reports of that course reuse its sections and cover; when the user mentions a course you already have a template for, pass course to plan. Content must come from evidence you actually have; never invent screenshots, measurements, logs, or results.`

function textContent(value, maxChars) {
  return [{ type: 'text', text: truncate(JSON.stringify(value), maxChars) }]
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
      return engine.status({ refreshHistory: args.force === true })
    case 'plan':
      return engine.plan({
        requirements: args.requirements,
        templateId: args.templateId,
        course: args.course,
        cover: args.cover,
        options: args.options,
      })
    case 'build':
      return engine.build({
        planId: args.planId,
        requirements: args.requirements,
        templateId: args.templateId,
        course: args.course,
        cover: args.cover,
        sections: args.sections,
        outPath: args.outPath,
        options: { ...(args.options ?? {}), force: args.force === true },
      })
    case 'validate':
      if (!args.path) throw new ReportError('PATH_REQUIRED', 'path is required for action=validate')
      return engine.validate({ path: args.path, planId: args.planId })
    case 'template':
      return engine.learn({
        path: args.path,
        course: args.course,
        templateId: args.templateId,
        force: args.force === true,
      })
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
    description: 'Generate, extend, or validate an experiment-report DOCX that follows a course template. Learns a template from a past DOCX, plans sections from the requirements, builds with per-section content, then validates. Never invents experimental evidence.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => textContent(value, config.maxOutputChars ?? 6000),
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
        return { ok: false, action: args.action, error: { code: 'INTERNAL', message: error.message }, next: 'Inspect the plugin log; if this persists, run action=status to check template and cache health.' }
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
