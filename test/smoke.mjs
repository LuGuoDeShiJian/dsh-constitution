/**
 * 冒烟测试：不需要跑整套宿主。
 *
 * 覆盖三件事：
 *   1. 正文缺失 → section 文本为空、不抛错（装配照常）
 *   2. 落盘 → 同一个 section 的 text 函数立刻读到新内容（这就是「免重启」的机制）
 *   3. HTTP 路由的四个动作 + 跨源拒绝 + 体积上限
 *
 * 用法：node test/smoke.mjs
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dshcn-'))
process.env.DSH_HOME = home

const { apply } = await import('../lib/index.js')

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures += 1
    console.error(`✗ ${label}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`)
  } else {
    console.log(`✓ ${label}`)
  }
}
function checkTruthy(label, actual) {
  if (!actual) {
    failures += 1
    console.error(`✗ ${label} (got ${JSON.stringify(actual)})`)
  } else {
    console.log(`✓ ${label}`)
  }
}

function makeCtx(origin = 'http://127.0.0.1:58433') {
  const sections = []
  const routes = []
  return {
    sections,
    routes,
    get(name) {
      if (name === 'systemPrompt') {
        return {
          section(section) {
            sections.push(section)
            return () => {}
          },
          getSectionOrder: () => 10200,
          // 仿宿主：装配时对函数式 section 求值。
          async assemble() {
            return {
              sections: sections.map((entry) => ({
                name: entry.name,
                text: typeof entry.text === 'function' ? entry.text({}) : entry.text,
              })),
            }
          },
        }
      }
      if (name === 'webServer') {
        return {
          register(route) {
            routes.push(route)
            return () => {}
          },
          getOrigin: () => origin,
        }
      }
      return undefined
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    set() {},
  }
}

/** 最小 Request/Response 替身：够 route handler 用。 */
async function call(handler, method, path, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const request = {
    method,
    url: path,
    headers: { origin: 'http://127.0.0.1:58433', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  let status = 0
  let payload = ''
  const response = {
    writeHead(code) {
      status = code
    },
    end(text) {
      payload = text ?? ''
    },
  }
  await handler(request, response)
  return { status, json: payload ? JSON.parse(payload) : undefined }
}

const ctx = makeCtx()
apply(ctx, {})

check('注册了一个提示词段落', ctx.sections.length, 1)
check('注册了一个 HTTP 路由', ctx.routes.length, 1)

const section = ctx.sections[0]
check('段落名', section.name, 'deploy:constitution')
check('段落顺序 = 基准 + 300', section.order, 10500)
check('text 是函数（每 step 重新求值）', typeof section.text, 'function')
check('正文缺失时返回空串', section.text(), '')

const route = ctx.routes[0]
check('路由类型', route.kind, 'prefix')
check('路由挂载点', route.path, '/plugins/dsh-constitution')

const initial = await call(route.handler, 'GET', '/plugins/dsh-constitution/state')
check('初始 state.ok', initial.json.ok, true)
check('初始未创建', initial.json.exists, false)
check('初始未注入', initial.json.injected, false)

const reset = await call(route.handler, 'POST', '/plugins/dsh-constitution/reset', {})
check('reset 成功', reset.status, 200)
checkTruthy('reset 后文件存在', reset.json.state.exists)
checkTruthy('reset 后已注入', reset.json.state.injected)
checkTruthy('模板里的说明被剥掉后仍有正文', section.text().length > 100)

const file = reset.json.state.path
check('文件落在 DSH_HOME 下', file.startsWith(home), true)

const body = '# 测试\n\n> 这段说明不发给模型\n\n<!-- 注释也不发 -->\n\n规则甲。\n\n规则乙 {{persona}} 收尾。\n'
const saved = await call(route.handler, 'POST', '/plugins/dsh-constitution/save', { text: body })
check('save 成功', saved.status, 200)
check('落盘内容一致', readFileSync(file, 'utf8'), body)

// 关键断言：不用重新注册、不用重启，同一个 text 函数就读到新内容。
const injected = section.text()
checkTruthy('新内容立刻可见', injected.includes('规则甲。'))
check('引用块被剥掉', injected.includes('这段说明不发给模型'), false)
check('HTML 注释被剥掉', injected.includes('注释也不发'), false)
// v2.1：不再做零宽空格转义，改为段落级 interpolate:false 让宿主跳过变量解析。
check('花括号原文保留（不做转义）', injected.includes('{{persona}}'), true)
check('没有零宽空格注入', injected.includes('\u200b'), false)
check('段落声明了 interpolate:false', section.interpolate, false)

const state = await call(route.handler, 'GET', '/plugins/dsh-constitution/state')
check('state.braceGroups 计数', state.json.braceGroups, 1)
check('state.interpolate', state.json.interpolate, false)
checkTruthy('state.chars > 0', state.json.chars > 0)
check('state.source', state.json.source, 'file')
checkTruthy('state 报告了被剥内容', state.json.strippedCount > 0)

const preview = await call(route.handler, 'POST', '/plugins/dsh-constitution/preview', { text: body })
check('preview 成功', preview.status, 200)
check('preview 字符数与 state 一致', preview.json.chars, state.json.chars)
check('preview 花括号原样', preview.json.text.includes('{{persona}}'), true)

const crossOrigin = await call(route.handler, 'GET', '/plugins/dsh-constitution/state', undefined, {
  origin: 'http://evil.example',
})
check('跨源被拒', crossOrigin.status, 403)

// 装配级证据：宿主真跑一次 assemble，段落文本就是我们刚写的内容。
const assembled = await call(route.handler, 'GET', '/plugins/dsh-constitution/assemble')
check('assemble 成功', assembled.status, 200)
check('assemble 里能看到本段落', assembled.json.present, true)
check('assemble 的文本包含刚保存的规则', assembled.json.text.includes('规则甲。'), true)
check('assemble 报告了进程 pid', typeof assembled.json.pid, 'number')

// 换一份内容，不重新注册、不重启，再装配一次。
await call(route.handler, 'POST', '/plugins/dsh-constitution/save', { text: '# 换过\n\n规则丙替代。\n' })
const assembled2 = await call(route.handler, 'GET', '/plugins/dsh-constitution/assemble')
check('第二次装配换了内容', assembled2.json.text.includes('规则丙替代。'), true)
check('旧内容已消失', assembled2.json.text.includes('规则甲。'), false)

// v2.1：上限判定分两层——请求体层 413（MAX_BODY = 2×正文上限 + 4 KiB），
// 正文层 400（writeAtomic 按 MAX_BYTES 精确判）。600 KiB 正文 JSON 后约 600 KiB，
// 仍在请求体上限内，所以由 writeAtomic 拒，返回 400 且带准确字节数。
const oversized = await call(route.handler, 'POST', '/plugins/dsh-constitution/save', { text: 'x'.repeat(600 * 1024) })
check('超大正文被拒', oversized.status, 400)
checkTruthy('拒绝信息带字节数', String(oversized.json.error).includes('超过上限'))

// 合法大小的正文必须能存进去（旧版这里会被 JSON 包装撑爆成 413）。
const atLimit = '\n'.repeat(500 * 1024)
const atLimitSaved = await call(route.handler, 'POST', '/plugins/dsh-constitution/save', { text: atLimit })
check('上限内正文可保存', atLimitSaved.status, 200)

const unknown = await call(route.handler, 'GET', '/plugins/dsh-constitution/nope')
check('未知动作 404', unknown.status, 404)

const bundle = await call(route.handler, 'GET', '/plugins/dsh-constitution/bundle')
check('没有 clientModules 时 /bundle 仍回 200', bundle.status, 200)
check('/bundle 报告不可用而不是报错', bundle.json.available, false)

// config.text 覆盖
const ctx2 = makeCtx()
apply(ctx2, { text: 'config 覆盖正文' })
check('config.text 优先', ctx2.sections[0].text(), 'config 覆盖正文')

// 自定义路径 + 停用 HTTP
const customFile = join(home, 'nested', 'mine.md')
writeFileSync(join(home, 'seed.md'), '# 播种\n\n内容。\n')
const ctx3 = makeCtx()
apply(ctx3, { textFile: customFile, webRoute: false })
check('webRoute:false 不注册路由', ctx3.routes.length, 0)
check('自定义路径读不到时为空', ctx3.sections[0].text(), '')

rmSync(home, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
