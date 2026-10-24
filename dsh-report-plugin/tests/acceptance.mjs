/**
 * Offline acceptance checks for the report-docx plugin.
 *
 * Run with the bundled Node runtime:
 *   "C:/Users/71985/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" \
 *     dsh-report-plugin/tests/acceptance.mjs
 */
import { rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { createEngine } from '../src/engine.js'

const workspace = resolve(process.cwd())
const packageDir = resolve(import.meta.dirname, '..')
const root = mkdtempSync(join(workspace, '.dsh-report-acceptance-'))
const image = resolve(workspace, 'images', '01_top_level_dfd.png')

function engineConfig(overrides = {}) {
  return {
    autoIngest: false,
    cacheDir: join(root, 'cache'),
    outputDir: join(root, 'out'),
    templateOverlayDir: join(root, 'no-overlay'),
    ...overrides,
  }
}

async function withEngine(config, test) {
  const engine = await createEngine({ config, workspace, packageDir })
  return test(engine)
}

try {
  await withEngine(engineConfig(), async (engine) => {
    const status = await engine.status({ historyScope: 'workspace' })
    assert.equal(status.ok, true)
    assert.equal(status.python.ok, true)
    assert.ok(status.templates.some((template) => template.id === 'lab-report'))
    assert.ok(status.templates.some((template) => template.id === 'requirements-analysis'))

    const requirements = [
      '实验名称：验收测试报告',
      '课程名称：软件工程',
      '学期：2026/2027(1)',
      '姓名：示例',
      '学号：2026000001',
      '班级：软工2402',
      '任课教师：示例教师',
      '提交日期：2026.10.24',
      '任务1 建立工程结构',
      '任务2 实现核心功能并测试',
      '一、实验目的：掌握模板驱动报告生成。',
      '二、实验环境：Windows、JDK、Tomcat。',
      '四、实验原理：前端控制器接收请求并委派给控制器方法。',
    ].join('\n')
    const plan = await engine.plan({ requirements })
    assert.equal(plan.template.id, 'lab-report')
    assert.equal(plan.missingCover.length, 0)
    assert.ok(plan.sections.some((section) => section.id === 'process.task-1'))
    assert.ok(plan.sections.some((section) => section.id === 'process.task-2'))
    console.log('plan ok:', plan.planId, plan.template.id, plan.sections.length, 'sections')

    const sections = {
      purpose: ['掌握模板驱动报告生成。', '验证增量生成与缓存复用。'],
      environment: {
        table: {
          caption: '环境清单',
          headers: ['类别', '名称', '版本'],
          rows: [['操作系统', 'Windows', '11'], ['容器', 'Tomcat', '10.1']],
        },
      },
      content: ['实现一个示例模块，并补充参数绑定示例。'],
      principle: {
        paragraphs: ['前端控制器接收请求并委派给控制器方法。'],
        code: { caption: '控制器示例', text: '@PostMapping("/login")\npublic String login(@RequestParam String username) {}' },
      },
      'process.task-1': ['建立工程结构并配置依赖。'],
      'process.task-2': { paragraphs: ['实现核心功能。'], image: { path: image, caption: '示意图', width: 4.5 } },
      summary: ['验收测试通过，缓存与增量生成符合预期。'],
    }
    const build = await engine.build({ planId: plan.planId, sections, options: { reuse: false } })
    assert.equal(build.ok, true)
    assert.equal(build.sections.missing, 0)
    assert.equal(build.sections.placeholders, 0)
    assert.equal(build.validation.metrics.tables, 1)
    assert.equal(build.validation.metrics.images, 1)
    console.log('build ok:', build.path, build.validation.score, build.validation.metrics)

    const incremental = await engine.build({
      planId: plan.planId,
      sections: { summary: ['更新后的总结：复用已验证章节，仅重写总结。'] },
      options: { reuse: true },
    })
    assert.equal(incremental.ok, true)
    assert.deepEqual(incremental.cache.reusedSections, ['purpose', 'environment', 'content', 'principle', 'process.task-1', 'process.task-2'])
    assert.ok(!incremental.cache.reusedSections.includes('summary'))
    console.log('incremental ok:', incremental.cache.reusedSections.length, 'reused sections')

    const cached = await engine.build({
      planId: plan.planId,
      sections: { summary: ['更新后的总结：复用已验证章节，仅重写总结。'] },
      options: { reuse: true },
    })
    assert.equal(cached.cache.hit, true)
    assert.equal(cached.bytes, incremental.bytes)
    console.log('cache hit ok:', cached.bytes, 'bytes')

    const unknown = await engine.build({
      planId: plan.planId,
      sections: { 'not-a-section': 'ignored' },
      outPath: join(root, 'out', 'unknown.docx'),
      options: { reuse: false },
    })
    assert.ok(unknown.warnings.some((warning) => warning.includes('unknown section')))
    console.log('unknown section warning ok')

    assert.throws(
      () => engine.resolveOutputPath(join(workspace, '..', 'outside.docx'), plan),
      (error) => error?.code === 'OUTPUT_OUTSIDE_WORKSPACE',
    )
    console.log('workspace confinement ok')

    const requirementsPlan = await engine.plan({
      requirements: '需求分析实验：需求提取、用例建模、数据流图、可追溯矩阵、一致性检查。',
    })
    assert.equal(requirementsPlan.template.id, 'requirements-analysis')
    console.log('template selection ok:', requirementsPlan.template.id)
  })

  await withEngine(engineConfig({ cacheDir: join(root, 'dedupe-cache'), dedupe: { acrossSections: true } }), async (engine) => {
    const plan = await engine.plan({ requirements: '实验名称：去重验收\n任务1 测试。' })
    const repeated = '这是用于验收的重复段落，长度足以进入近似去重区间，应当只保留一次。'
    const build = await engine.build({
      planId: plan.planId,
      sections: { content: [repeated], summary: [repeated, '最终总结。'] },
      options: { reuse: false },
    })
    assert.ok(build.cache.dedupedBlocks >= 1)
    assert.equal(build.validation.metrics.duplicateRatio, 0)
    console.log('dedupe ok:', build.cache.dedupedBlocks)
  })

  await withEngine(engineConfig({ cacheDir: join(root, 'history-cache'), autoIngest: true }), async (engine) => {
    const first = await engine.history({ scope: 'workspace', force: true })
    assert.equal(first.ok, true)
    assert.ok(first.docx.unique > 0)
    const second = await engine.history({ scope: 'workspace', force: false })
    assert.equal(second.cacheHit, true)
    console.log('history ok:', first.docx.unique, 'docs,', first.sessions.relevant, 'sessions, digest', first.digest)
  })

  console.log('acceptance: all checks passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
