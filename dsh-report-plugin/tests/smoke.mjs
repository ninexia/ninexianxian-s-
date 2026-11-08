import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createEngine } from '../src/engine.js'

const workspace = resolve(process.cwd())
const packageDir = resolve(import.meta.dirname, '..')
const requirements = await readFile(resolve(import.meta.dirname, 'fixtures', 'requirements.md'), 'utf8')

const engine = await createEngine({
  config: {
    autoIngest: false,
    outputDir: join(packageDir, 'tests', 'out'),
    cacheDir: join(packageDir, 'tests', '.cache'),
    templateOverlayDir: join(packageDir, 'tests', '.overlay'),
  },
  workspace,
  packageDir,
})

const status = await engine.status()
console.log('status:', status.templates.map((template) => template.id).join(','))

const plan = await engine.plan({ requirements })
console.log('plan:', plan.planId, plan.template, plan.sections.length, 'sections', plan.via)

const sections = {
  purpose: ['掌握 Spring MVC 请求处理流程。', '完成登录模块的 Controller、Service 与视图联调。', '能够定位映射与参数绑定错误。'],
  environment: { table: { headers: ['组件', '版本'], rows: [['Spring', '6.1'], ['Tomcat', '10']] } },
}
const build = await engine.build({ planId: plan.planId, sections })
console.log('build:', build.ok, build.path, 'missing', build.missing.length, 'warnings', build.warnings.length)

const validate = await engine.validate({ path: build.path, planId: plan.planId })
console.log('validate:', validate.ok, JSON.stringify(validate.structure))
