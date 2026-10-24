import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureDir } from './util.js'

/**
 * The Windows sandbox blocks piped child stdio. Python therefore writes its
 * result to a file, and the child is spawned with ignored stdio. This keeps the
 * tool usable under workspace-write/read-only and avoids buffering output.
 */
function run(config, args, { cwd, resultPath, timeoutMs = 120000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    let child
    try {
      child = spawn(config.pythonPath, args, {
        cwd,
        windowsHide: true,
        // Python needs inherited stderr to initialize reliably on Windows; its
        // result is still written to a file, so stdout stays unused.
        stdio: ['ignore', 'ignore', 'inherit'],
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
        },
      })
    } catch (error) {
      reject(new Error(`failed to start python (${config.pythonPath}): ${error.message}`))
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch {}
      reject(new Error(`python timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`failed to start python (${config.pythonPath}): ${error.message}`))
    })
    child.on('close', async (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let text = ''
      try {
        text = await readFile(resultPath, 'utf8')
      } catch {
        reject(new Error(`python exited ${code} without a result file`))
        return
      }
      try {
        const value = JSON.parse(text)
        if (code !== 0 && value?.ok !== false) {
          reject(new Error(`python exited ${code}: ${JSON.stringify(value).slice(0, 2000)}`))
          return
        }
        resolvePromise(value)
      } catch {
        reject(new Error(`python returned invalid JSON: ${text.slice(0, 2000)}`))
      }
    })
  })
}

async function invoke(config, command, payload, cwd, timeoutMs) {
  const dir = join(config.cacheDir, 'tmp')
  await ensureDir(dir)
  const token = `${process.pid}-${randomUUID()}`
  const requestPath = join(dir, `${command}-${token}.json`)
  const resultPath = join(dir, `${command}-${token}.result.json`)
  await writeFile(requestPath, JSON.stringify(payload, null, 2), 'utf8')
  try {
    return await run(config, [config.rendererPath, command, requestPath, resultPath], { cwd, resultPath, timeoutMs })
  } finally {
    await rm(requestPath, { force: true }).catch(() => {})
    await rm(resultPath, { force: true }).catch(() => {})
  }
}

export async function renderDocx(config, payload, { cwd } = {}) {
  return invoke(config, 'render', payload, cwd ?? config.workspace, 180000)
}

export async function inspectDocx(config, path, { cwd } = {}) {
  return invoke(config, 'inspect', { path }, cwd ?? config.workspace, 60000)
}

export async function scanDocx(config, paths, { cwd } = {}) {
  return invoke(config, 'scan', { paths }, cwd ?? config.workspace, 180000)
}

export async function pythonInfo(config, { cwd } = {}) {
  return invoke(config, 'info', {}, cwd ?? config.workspace, 30000)
}

export async function readDocxText(path, maxBytes = 20 * 1024 * 1024) {
  const stat = await readFile(path)
  return stat.length > maxBytes ? stat.subarray(0, maxBytes) : stat
}
