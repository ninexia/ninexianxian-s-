import { wordCount } from './util.js'

const CHINESE_HEADING = /^(?:[一二三四五六七八九十]+[、.．]|第[一二三四五六七八九十0-9]+[章节部分]|附录)\s*\S/
const NUMBER_HEADING = /^\d{1,2}(?:\.\d{1,2}){0,2}\s+\S/
const MAX_SNIPPET = 240

// 学生报告常常不用 Word 标题样式，没有样式时按“一、/第X章”猜一层标题
export function analyzeBlocks(inspect) {
  const blocks = (inspect.blocks ?? []).filter((block) => block && typeof block.text === 'string' && block.text.trim())
  const styled = blocks.filter((block) => Number(block.level) > 0).length
  if (styled >= 3) return blocks
  return blocks.map((block) => {
    if (Number(block.level) > 0) return block
    const text = block.text.trim()
    if (text.length > 40) return block
    if (CHINESE_HEADING.test(text) || (NUMBER_HEADING.test(text) && text.length <= 30)) {
      return { ...block, level: 1 }
    }
    return block
  })
}

export function outlineOf(inspect) {
  const blocks = analyzeBlocks(inspect)
  const items = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (!Number(block.level)) continue
    let words = 0
    for (let cursor = index + 1; cursor < blocks.length && !Number(blocks[cursor].level); cursor += 1) {
      words += wordCount(blocks[cursor].text)
    }
    items.push({
      level: Math.min(Number(block.level) || 1, 3),
      para: index,
      title: block.text.trim().slice(0, 80),
      words,
    })
  }
  return items
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0
  let count = 0
  let index = 0
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1
    index += needle.length
  }
  return count
}

// 多个词用空格分隔，全部命中才算一条（AND 语义），每个段落只出一条命中
export function searchText(inspect, query, { limit = 6, offset = 0, context = 60 } = {}) {
  const blocks = analyzeBlocks(inspect)
  const terms = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) throw new Error('query is empty')
  const stack = []
  const hits = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const level = Number(block.level) || 0
    if (level > 0) {
      stack.length = Math.min(stack.length, level - 1)
      stack[level - 1] = block.text.trim()
      continue
    }
    const text = block.text
    const lower = text.toLowerCase()
    if (!terms.every((term) => lower.includes(term))) continue
    const position = Math.max(0, lower.indexOf(terms[0]))
    const start = Math.max(0, position - context)
    const end = Math.min(text.length, position + terms[0].length + context)
    const snippet = `${start > 0 ? '…' : ''}${text.slice(start, Math.min(end, start + MAX_SNIPPET))}${end < text.length ? '…' : ''}`
    const section = stack.filter(Boolean).join(' > ')
    const matches = terms.reduce((total, term) => total + countOccurrences(lower, term), 0)
    hits.push(section ? { para: index, section, snippet, matches } : { para: index, snippet, matches })
  }
  const total = hits.length
  const start = Math.max(0, Math.min(offset, total))
  return { total, offset: start, hits: hits.slice(start, start + limit), hasMore: start + limit < total }
}

// 按标题模糊命中某一节，返回该节全文（有上限），用来“只读这一节”
export function readSection(inspect, query, { maxChars = 2000 } = {}) {
  const blocks = analyzeBlocks(inspect)
  const needle = String(query ?? '').trim().toLowerCase()
  if (!needle) throw new Error('query is empty')
  let startIndex = -1
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (!Number(block.level)) continue
    const title = block.text.trim().toLowerCase()
    if (title.includes(needle) || needle.includes(title)) {
      startIndex = index
      break
    }
  }
  if (startIndex === -1) return null
  const heading = blocks[startIndex]
  const level = Number(heading.level) || 1
  const body = []
  for (let cursor = startIndex + 1; cursor < blocks.length; cursor += 1) {
    const block = blocks[cursor]
    if (Number(block.level) > 0 && Number(block.level) <= level) break
    body.push(block.text.trim())
  }
  const text = body.join('\n')
  const truncated = text.length > maxChars
  return {
    title: heading.text.trim(),
    level,
    para: startIndex,
    words: wordCount(text),
    paragraphs: body.length,
    truncated,
    text: truncated ? `${text.slice(0, maxChars)}…` : text,
  }
}

