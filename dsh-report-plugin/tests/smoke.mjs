import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createEngine } from '../src/engine.js'

const workspace = resolve(process.cwd())
const packageDir = resolve(import.meta.dirname, '..')
const requirements = await readFile(resolve(import.meta.dirname, 'fixtures', 'requirements.md'), 'utf8')

const engine = await createEngine({ config: { autoIngest: false, outputDir: 'dsh-report-plugin/tests/out' }, workspace, packageDir })
const status = await engine.status()
console.log('status:', status.templates.map((template) => template.id).join(','), status.python.ok)

const plan = await engine.plan({ requirements })
console.log('plan:', plan.planId, plan.template.id, plan.sections.length, 'sections', plan.missingCover.length, 'missing cover')

const sections = {
  purpose: ['掌握 Spring MVC 请求处理流程。', '完成登录模块的 Controller、Service 与视图联调。', '能够定位映射与参数绑定错误。'],
  environment: ['Windows 11、JDK 17、Tomcat 10、Spring Framework 6、Eclipse IDE。'],
  content: { paragraphs: ['实现用户登录模块，包含登录页、控制器、业务校验、成功页与失败提示。', '补充一个参数绑定示例。'] },
  principle: ['DispatcherServlet 接收请求，HandlerMapping 定位 Controller，Controller 返回 ModelAndView，ViewResolver 解析视图。'],
  'process.task-1': { bullets: ['创建 Maven Web 工程。', '配置 Spring MVC 依赖与 web.xml。'] },
  'process.task-2': { paragraphs: ['实现 LoginController 与 UserService，完成参数接收、校验和视图跳转。'] },
  'process.task-3': { paragraphs: ['部署到 Tomcat，验证成功与失败路径；记录端口占用和视图路径错误两个问题及解决过程。'] },
  summary: ['通过本实验理解了 Spring MVC 的分层协作方式，掌握了注解 Controller 的基本用法，后续需要补充异常处理和单元测试。'],
}

const build = await engine.build({
  planId: plan.planId,
  sections,
  outPath: 'dsh-report-plugin/tests/out/smoke-report.docx',
  options: { reuse: false },
})
console.log('build:', JSON.stringify(build, null, 2))

const validation = await engine.validate({ path: build.path, planId: plan.planId })
console.log('validate:', JSON.stringify(validation.validation, null, 2))
