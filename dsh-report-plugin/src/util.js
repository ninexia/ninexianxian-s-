import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
}

export function shortHash(value, length = 12) {
  return sha256(value).slice(0, length)
}

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\u00a0]+/g, ' ')
    .replace(/[ \u3000]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。；：、,.!?！？;:'"“”‘’（）()\[\]【】<>《》—\-_/\\]/g, '')
}

export function wordCount(value) {
  const text = String(value ?? '')
  const chinese = (text.match(/[\u3400-\u9fff]/g) ?? []).length
  const latin = (text.match(/[A-Za-z0-9][A-Za-z0-9_.+#/-]*/g) ?? []).length
  return chinese + latin
}

export function truncate(value, max) {
  const text = String(value ?? '')
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

export function splitParagraphs(value) {
  const text = normalizeText(value)
  if (!text) return []
  if (text.includes('\n\n')) return text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length > 1 && lines.every((line) => line.length < 180)) return lines
  return [text]
}

export function deepMerge(base, overlay) {
  if (!isRecord(base) || !isRecord(overlay)) return overlay === undefined ? base : overlay
  const next = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    next[key] = isRecord(value) && isRecord(base[key]) ? deepMerge(base[key], value) : value
  }
  return next
}

export function expandHome(value) {
  if (typeof value !== 'string' || !value) return value
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

export function resolveFrom(base, value) {
  if (!value) return value
  const expanded = expandHome(String(value))
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded)
}

export function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!!rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export function safeFilePart(value, fallback = 'report') {
  const text = normalizeText(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80)
  return text || fallback
}

export function dateStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

export async function ensureDir(path) {
  await mkdir(path, { recursive: true })
}

export async function readJson(path, fallback = undefined) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

export async function writeJsonAtomic(path, value) {
  await ensureDir(dirname(path))
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

export function fileExists(path) {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

export function stripMarkdown(value) {
  return String(value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
}

export function countBy(items, keyOf) {
  const counts = Object.create(null)
  for (const item of items) {
    const key = keyOf(item)
    if (!key) continue
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

export function topEntries(counts, limit = 20) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .slice(0, limit)
}
