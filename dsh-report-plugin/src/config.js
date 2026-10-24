import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { deepMerge, fileExists, isRecord, resolveFrom } from './util.js'

const DEFAULTS = Object.freeze({
  defaultTemplate: 'lab-report',
  templateDir: null,
  templateOverlayDir: '.dsh-report-templates',
  outputDir: 'reports',
  cacheDir: '.dsh-report-cache',
  pythonPath: null,
  rendererPath: null,
  maxOutputChars: 12000,
  allowOutsideWorkspace: false,
  autoIngest: true,
  history: {
    enabled: true,
    includeDocx: true,
    includeSessions: true,
    sessionDirs: [],
    maxDocx: 80,
    maxSessions: 120,
    maxSessionBytes: 32 * 1024 * 1024,
    snippetChars: 280,
    keywords: ['实验报告', '实验', 'docx', '报告', '需求分析', '实验目的', '实验环境', '实验总结'],
  },
  dedupe: {
    enabled: true,
    nearThreshold: 0.9,
    minChars: 40,
    acrossSections: false,
  },
  validation: {
    enabled: true,
    minWords: 300,
    minSectionWords: 20,
    maxDuplicateRatio: 0.12,
    maxParagraphChars: 1200,
    forbidden: ['【待补充', 'TODO', '{{', 'lorem ipsum'],
  },
})

function numberIn(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function booleanIn(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function strings(value, fallback) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : fallback
}

function normalizeHistory(raw, base) {
  const history = deepMerge(DEFAULTS.history, isRecord(raw) ? raw : {})
  return {
    enabled: booleanIn(history.enabled, true),
    includeDocx: booleanIn(history.includeDocx, true),
    includeSessions: booleanIn(history.includeSessions, true),
    sessionDirs: strings(history.sessionDirs, []).map((dir) => resolveFrom(base, dir)),
    maxDocx: numberIn(history.maxDocx, 80, 1, 500),
    maxSessions: numberIn(history.maxSessions, 120, 1, 1000),
    maxSessionBytes: numberIn(history.maxSessionBytes, 32 * 1024 * 1024, 1024 * 1024, 256 * 1024 * 1024),
    snippetChars: numberIn(history.snippetChars, 280, 80, 1000),
    keywords: strings(history.keywords, DEFAULTS.history.keywords),
  }
}

function normalizeDedupe(raw) {
  const dedupe = deepMerge(DEFAULTS.dedupe, isRecord(raw) ? raw : {})
  return {
    enabled: booleanIn(dedupe.enabled, true),
    nearThreshold: numberIn(dedupe.nearThreshold, 0.9, 0.5, 1),
    minChars: numberIn(dedupe.minChars, 40, 10, 500),
    acrossSections: booleanIn(dedupe.acrossSections, false),
  }
}

function normalizeValidation(raw) {
  const validation = deepMerge(DEFAULTS.validation, isRecord(raw) ? raw : {})
  return {
    enabled: booleanIn(validation.enabled, true),
    minWords: numberIn(validation.minWords, 300, 0, 100000),
    minSectionWords: numberIn(validation.minSectionWords, 20, 0, 10000),
    maxDuplicateRatio: numberIn(validation.maxDuplicateRatio, 0.12, 0, 1),
    maxParagraphChars: numberIn(validation.maxParagraphChars, 1200, 100, 20000),
    forbidden: strings(validation.forbidden, DEFAULTS.validation.forbidden),
  }
}

function detectPython() {
  const candidates = []
  if (process.env.DSH_PYTHON) candidates.push(process.env.DSH_PYTHON)
  const home = homedir()
  candidates.push(join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'))
  candidates.push(join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'bin', 'python3'))
  candidates.push(process.platform === 'win32' ? 'python.exe' : 'python3')
  candidates.push('python')
  return candidates.find((candidate) => candidate.includes('python') && (!candidate.includes('/') && !candidate.includes('\\') || fileExists(candidate))) ?? 'python'
}

export function resolveConfig(raw, { workspace, packageDir }) {
  const input = isRecord(raw) ? raw : {}
  const base = resolve(workspace)
  const config = {
    ...DEFAULTS,
    ...input,
    history: normalizeHistory(input.history, base),
    dedupe: normalizeDedupe(input.dedupe),
    validation: normalizeValidation(input.validation),
  }
  config.workspace = base
  config.packageDir = resolve(packageDir)
  config.templateDir = input.templateDir ? resolveFrom(base, input.templateDir) : null
  config.templateOverlayDir = resolveFrom(base, input.templateOverlayDir ?? DEFAULTS.templateOverlayDir)
  config.outputDir = resolveFrom(base, input.outputDir ?? DEFAULTS.outputDir)
  config.cacheDir = resolveFrom(base, input.cacheDir ?? DEFAULTS.cacheDir)
  config.rendererPath = input.rendererPath ? resolveFrom(base, input.rendererPath) : join(config.packageDir, 'renderer', 'report_tool.py')
  config.pythonPath = input.pythonPath ? resolveFrom(base, input.pythonPath) : detectPython()
  config.maxOutputChars = numberIn(input.maxOutputChars, 12000, 1000, 60000)
  config.allowOutsideWorkspace = booleanIn(input.allowOutsideWorkspace, false)
  config.autoIngest = booleanIn(input.autoIngest, true)
  config.defaultTemplate = typeof input.defaultTemplate === 'string' && input.defaultTemplate.trim()
    ? input.defaultTemplate.trim()
    : DEFAULTS.defaultTemplate

  config.history.sessionDirs = config.history.sessionDirs.length
    ? config.history.sessionDirs
    : [join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')]

  if (!config.history.enabled) {
    config.history.includeDocx = false
    config.history.includeSessions = false
  }

  const problems = []
  if (!existsSync(config.workspace)) problems.push(`workspace does not exist: ${config.workspace}`)
  if (!existsSync(config.rendererPath)) problems.push(`renderer not found: ${config.rendererPath}`)
  if (config.pythonPath.includes('/') || config.pythonPath.includes('\\')) {
    if (!existsSync(config.pythonPath)) problems.push(`python not found: ${config.pythonPath}`)
  }
  return { config, problems }
}
