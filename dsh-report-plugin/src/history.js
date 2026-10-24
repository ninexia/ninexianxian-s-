import { readdir, stat, readFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { normalizeKey, normalizeText, topEntries, truncate, fileExists, sha256 } from './util.js'

const SKIP_DIRS = new Set(['.git', 'node_modules', '.dsh-report-cache', '__pycache__', '.venv', 'venv', 'dist', 'build'])
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const DOCX_REF = /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])[^"\n\r|<>]{1,240}?\.docx/gi
const CHINESE_HEADING = /^\s*(?:[一二三四五六七八九十]+[、.．]|第[一二三四五六七八九十0-9]+[章节部分]|附录)\s*\S/
const NUMBER_HEADING = /^\s*(?:\d+(?:\.\d+){1,3}\s+\S|\d+[、]\s*\S)/

async function walk(root, accept, { max = 500, maxDepth = 8 } = {}) {
  const results = []
  const stack = [{ dir: root, depth: 0 }]
  while (stack.length && results.length < max) {
    const { dir, depth } = stack.pop()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (results.length >= max) break
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(entry.name)) stack.push({ dir: path, depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      if (accept(path, entry.name)) results.push(path)
    }
  }
  return results
}

async function withStats(paths) {
  const rows = []
  for (const path of paths) {
    try {
      const info = await stat(path)
      rows.push({ path, mtimeMs: info.mtimeMs, bytes: info.size })
    } catch {
      // ignore racing file deletion
    }
  }
  return rows
}

export async function discoverDocx(workspace, config) {
  const paths = await walk(workspace, (path, name) => {
    if (!name.toLowerCase().endsWith('.docx')) return false
    if (name.startsWith('~$') || name.toLowerCase() === 'template.docx') return false
    const rel = relative(workspace, path).replace(/\\/g, '/')
    if (rel.startsWith('.dsh-report-cache/')) return false
    if (rel.startsWith('dsh-report-plugin/')) return false
    if (rel.includes('/提交包/')) return false
    return true
  }, { max: config.history.maxDocx })
  const rows = await withStats(paths)
  return rows.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, config.history.maxDocx)
}

export async function discoverSessions(config) {
  const paths = []
  for (const root of config.history.sessionDirs) {
    if (!fileExists(root)) continue
    const found = await walk(root, (_path, name) => name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl'), {
      max: config.history.maxSessions,
      maxDepth: 4,
    })
    paths.push(...found)
  }
  const rows = await withStats(paths)
  return rows
    .filter((row) => row.bytes <= config.history.maxSessionBytes)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, config.history.maxSessions)
}

export function decompressSession(buffer) {
  if (!buffer.subarray(0, 4).equals(ZSTD_MAGIC)) return buffer.toString('utf8')
  const chunks = []
  let position = 0
  let frames = 0
  while (position < buffer.length && frames < 20000) {
    const index = buffer.indexOf(ZSTD_MAGIC, position)
    if (index === -1) break
    try {
      const output = zstdDecompressSync(buffer.subarray(index), { maxOutputLength: 32 * 1024 * 1024 })
      chunks.push(output)
      frames += 1
      position = index + 4
    } catch {
      position = index + 4
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

function textFromContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function docxRefsFrom(value) {
  const refs = []
  const matches = String(value ?? '').match(DOCX_REF) ?? []
  for (const match of matches) {
    const clean = match.replace(/\\+"/g, '').replace(/["'）)]+$/g, '').trim()
    if (clean.length > 5 && !refs.includes(clean)) refs.push(clean)
  }
  return refs
}

export function parseSessionText(text, { snippetChars = 280, keywords = [] } = {}) {
  const header = { id: '', cwd: '', createdAt: 0 }
  const snippets = []
  const docxRefs = []
  const headings = []
  const keywordHits = Object.create(null)
  let toolCalls = 0
  let userMessages = 0

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'session') {
      header.id = event.id ?? ''
      header.cwd = event.cwd ?? ''
      header.createdAt = event.createdAt ?? 0
      continue
    }
    if (event.type === 'user/message') {
      userMessages += 1
      const content = event.data?.content ?? event.data?.message?.content
      const value = textFromContent(content)
      if (!value) continue
      for (const keyword of keywords) {
        if (value.toLowerCase().includes(keyword.toLowerCase())) keywordHits[keyword] = (keywordHits[keyword] ?? 0) + 1
      }
      for (const ref of docxRefsFrom(value)) if (!docxRefs.includes(ref)) docxRefs.push(ref)
      const hit = keywords.some((keyword) => value.toLowerCase().includes(keyword.toLowerCase()))
      if (hit && snippets.length < 6) {
        snippets.push(truncate(normalizeText(value).replace(/\s+/g, ' '), snippetChars))
      }
      continue
    }
    if (event.type === 'tool/call') {
      toolCalls += 1
      const args = event.data?.arguments ?? ''
      for (const ref of docxRefsFrom(args)) if (!docxRefs.includes(ref)) docxRefs.push(ref)
      continue
    }
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content ?? []
      const value = textFromContent(content)
      if (!value) continue
      for (const line of value.split('\n')) {
        const clean = line.trim()
        if (clean.length < 4 || clean.length > 80) continue
        if (clean.includes('`') || clean.includes('http') || clean.includes('```')) continue
        if (!CHINESE_HEADING.test(clean) && !NUMBER_HEADING.test(clean)) continue
        const key = clean.replace(/\s+/g, ' ').slice(0, 80)
        if (headings.length < 120 && !headings.includes(key)) headings.push(key)
      }
    }
  }
  return { header, snippets, docxRefs, headings, keywordHits, toolCalls, userMessages }
}

async function scanSessionFiles(rows, config) {
  const sessions = []
  const errors = []
  const headingCounts = Object.create(null)
  const keywordCounts = Object.create(null)
  for (const row of rows) {
    try {
      const buffer = await readFile(row.path)
      const text = decompressSession(buffer)
      const parsed = parseSessionText(text, config.history)
      const relevant = parsed.snippets.length > 0 || parsed.docxRefs.length > 0
      if (!relevant) continue
      for (const heading of parsed.headings) headingCounts[heading] = (headingCounts[heading] ?? 0) + 1
      for (const [key, count] of Object.entries(parsed.keywordHits)) keywordCounts[key] = (keywordCounts[key] ?? 0) + count
      sessions.push({
        id: parsed.header.id || basename(row.path).replace(/\.jsonl\.zstd$/, ''),
        path: row.path,
        cwd: parsed.header.cwd,
        mtime: new Date(row.mtimeMs).toISOString(),
        snippets: parsed.snippets,
        docxRefs: parsed.docxRefs.slice(0, 12),
        toolCalls: parsed.toolCalls,
        userMessages: parsed.userMessages,
        headingCount: parsed.headings.length,
      })
    } catch (error) {
      errors.push({ path: row.path, error: error.message })
    }
  }
  return { sessions, errors, headingCounts, keywordCounts }
}

export async function ingestHistory({ config, workspace, cache, scope = 'all', force = false }) {
  const started = Date.now()
  const wantDocx = scope !== 'sessions' && config.history.includeDocx
  const wantSessions = scope !== 'workspace' && config.history.includeSessions
  const docxRows = wantDocx ? await discoverDocx(workspace, config) : []
  // Workspace DOCX changes invalidate the cache; session logs change constantly,
  // so they stay behind the 24h TTL unless the caller passes force=true.
  const fingerprint = sha256(docxRows.map((row) => `${row.path}:${row.mtimeMs}:${row.bytes}`).join('|')).slice(0, 20)
  const cached = await cache.getHistory()
  const scopeKey = `${scope}:${config.history.includeDocx}:${config.history.includeSessions}`
  if (
    !force &&
    cached &&
    cached.scopeKey === scopeKey &&
    cached.fingerprint === fingerprint &&
    Date.now() - Date.parse(cached.generatedAt) < 24 * 60 * 60 * 1000
  ) {
    return { ...cached, cacheHit: true, elapsedMs: Date.now() - started }
  }

  const sessionRows = wantSessions ? await discoverSessions(config) : []

  let docs = []
  let docxErrors = []
  if (docxRows.length) {
    const { scanDocx } = await import('./render.js')
    const result = await scanDocx(config, docxRows.map((row) => row.path), { cwd: workspace })
    docs = result.docs ?? []
    docxErrors = result.errors ?? []
  }

  const sessionResult = sessionRows.length
    ? await scanSessionFiles(sessionRows, config)
    : { sessions: [], errors: [], headingCounts: {}, keywordCounts: {} }

  const byHash = new Map()
  for (const doc of docs) {
    if (!doc.sha256 || byHash.has(doc.sha256)) continue
    byHash.set(doc.sha256, doc)
  }
  docs = [...byHash.values()]
  docs.sort((a, b) => (b.words ?? 0) - (a.words ?? 0))

  const headingCounts = Object.create(null)
  const styleCounts = Object.create(null)
  for (const doc of docs) {
    for (const heading of doc.headings ?? []) {
      const key = normalizeKey(heading.text)
      if (!key) continue
      headingCounts[key] = (headingCounts[key] ?? 0) + 1
      const style = heading.style || 'manual'
      styleCounts[style] = (styleCounts[style] ?? 0) + 1
    }
  }
  for (const [key, count] of Object.entries(sessionResult.headingCounts)) {
    const normalized = normalizeKey(key)
    if (normalized) headingCounts[normalized] = (headingCounts[normalized] ?? 0) + count
  }

  const index = {
    ok: true,
    scope,
    scopeKey,
    fingerprint,
    generatedAt: new Date().toISOString(),
    cacheHit: false,
    elapsedMs: Date.now() - started,
    workspace,
    digest: sha256(`${docs.map((doc) => doc.sha256).join(':')}|${sessionResult.sessions.map((item) => `${item.id}:${item.mtime}`).join(':')}`).slice(0, 24),
    docx: {
      scanned: docxRows.length,
      unique: docs.length,
      errors: docxErrors.slice(0, 20),
      docs: docs.map((doc) => ({
        path: doc.path,
        title: doc.title,
        bytes: doc.bytes,
        words: doc.words,
        tables: doc.tables,
        images: doc.images,
        paragraphs: doc.paragraphs,
        headings: doc.headings?.length ?? 0,
        page: doc.page,
      })),
    },
    sessions: {
      scanned: sessionRows.length,
      relevant: sessionResult.sessions.length,
      errors: sessionResult.errors.slice(0, 20),
      items: sessionResult.sessions.slice(0, 80),
    },
    hints: {
      headings: topEntries(headingCounts, 30).map(([heading, count]) => ({ heading, count })),
      styles: topEntries(styleCounts, 10).map(([style, count]) => ({ style, count })),
      keywords: topEntries(sessionResult.keywordCounts, 20).map(([keyword, count]) => ({ keyword, count })),
    },
  }
  await cache.putHistory(index)
  return index
}
