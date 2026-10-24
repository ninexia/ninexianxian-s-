import { join } from 'node:path'
import { ensureDir, readJson, writeJsonAtomic } from './util.js'

export class Cache {
  constructor(root) {
    this.root = root
  }

  path(...parts) {
    return join(this.root, ...parts)
  }

  async get(relativePath, fallback = undefined) {
    return readJson(this.path(relativePath), fallback)
  }

  async put(relativePath, value) {
    await ensureDir(this.root)
    await writeJsonAtomic(this.path(relativePath), value)
    return value
  }

  async putPlan(plan) {
    return this.put(join('plans', `${plan.planId}.json`), plan)
  }

  async getPlan(planId) {
    return this.get(join('plans', `${planId}.json`), null)
  }

  projectPath(projectKey) {
    return join('projects', projectKey)
  }

  async getProject(projectKey) {
    return this.get(join(this.projectPath(projectKey), 'state.json'), null)
  }

  async putProject(projectKey, state) {
    return this.put(join(this.projectPath(projectKey), 'state.json'), state)
  }

  async getBuild(buildId) {
    return this.get(join('builds', `${buildId}.json`), null)
  }

  async putBuild(buildId, manifest) {
    return this.put(join('builds', `${buildId}.json`), manifest)
  }

  async getHistory() {
    return this.get(join('history', 'index.json'), null)
  }

  async putHistory(index) {
    return this.put(join('history', 'index.json'), index)
  }

  async getTemplateIndex() {
    return this.get(join('templates', 'index.json'), null)
  }

  async putTemplateIndex(index) {
    return this.put(join('templates', 'index.json'), index)
  }
}
