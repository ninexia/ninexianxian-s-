import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * Load the Host's schemastery copy without adding an npm dependency.
 *
 * A locally linked bundle is not inside the DSH package tree, so a bare
 * `@deepseek-ai/schemastery` import is not guaranteed to resolve. The Host
 * already ships the library inside the desktop app; use it when available and
 * fall back to no native schema in a plain Node/CLI install. Runtime validation
 * in config.js and config.schema.json remain authoritative either way.
 */
async function loadSchemastery() {
  try {
    const module = await import('@deepseek-ai/schemastery')
    if (module?.default) return module.default
  } catch {
    // Bare resolution is expected to fail for a linked local bundle.
  }
  const manifests = []
  if (process.resourcesPath) manifests.push(join(process.resourcesPath, 'app.asar', 'dsh', 'package.json'))
  if (process.execPath) manifests.push(join(process.execPath, '..', 'resources', 'app.asar', 'dsh', 'package.json'))
  for (const manifest of manifests) {
    if (!existsSync(manifest)) continue
    try {
      return createRequire(manifest)('@deepseek-ai/schemastery').default
    } catch {
      // Try the next known Host layout.
    }
  }
  return null
}

const z = await loadSchemastery()

export const Config = z ? z.object({
  defaultTemplate: z.string().default('lab-report').description('Template id used when requirements do not select one.'),
  templateDir: z.string().description('Extra template directory, absolute or workspace-relative.'),
  templateOverlayDir: z.string().default('.dsh-report-templates').description('Project-local template overlay directory.'),
  outputDir: z.string().default('reports').description('Default output directory, absolute or workspace-relative.'),
  cacheDir: z.string().default('.dsh-report-cache').description('Plan, build, project and history cache directory.'),
  pythonPath: z.string().description('Python executable; auto-detected when empty.'),
  rendererPath: z.string().description('report_tool.py path; resolved from the package when empty.'),
  maxOutputChars: z.number().min(1000).max(60000).default(12000).description('Maximum characters returned by the tool.'),
  allowOutsideWorkspace: z.boolean().default(false).description('Allow DOCX and image paths outside the session workspace.'),
  autoIngest: z.boolean().default(true).description('Refresh the historical structure index lazily before planning.'),
  history: z.object({
    enabled: z.boolean().default(true),
    includeDocx: z.boolean().default(true),
    includeSessions: z.boolean().default(true),
    sessionDirs: z.array(z.string()).default([]).description('Session log directories; DSH defaults are added when empty.'),
    maxDocx: z.number().min(1).max(500).default(80),
    maxSessions: z.number().min(1).max(1000).default(120),
    maxSessionBytes: z.number().min(1048576).default(33554432),
    snippetChars: z.number().min(80).max(1000).default(280),
    keywords: z.array(z.string()).default(['实验报告', '实验', 'docx', '报告', '需求分析', '实验目的', '实验环境', '实验总结']),
  }).default({}),
  dedupe: z.object({
    enabled: z.boolean().default(true),
    nearThreshold: z.number().min(0.5).max(1).default(0.9),
    minChars: z.number().min(10).max(500).default(40),
    acrossSections: z.boolean().default(false).description('Also drop near-duplicates across different sections.'),
  }).default({}),
  validation: z.object({
    enabled: z.boolean().default(true),
    minWords: z.number().min(0).default(300),
    minSectionWords: z.number().min(0).default(20),
    maxDuplicateRatio: z.number().min(0).max(1).default(0.12),
    maxParagraphChars: z.number().min(100).default(1200),
    forbidden: z.array(z.string()).default(['【待补充', 'TODO', '{{', 'lorem ipsum']),
  }).default({}),
  templateOverrides: z.dict(z.any()).default({}).description('Inline template patch applied after loading the selected template.'),
}).description('Template-driven DOCX experiment report generation.') : undefined
