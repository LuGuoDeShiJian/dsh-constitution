/**
 * 端到端：真的起一个 node:http 服务，把插件注册的 prefix 路由挂上去，
 * 用真实 IncomingMessage / ServerResponse 走一遍。
 *
 * smoke.mjs 用的是替身对象，这个文件补上「真实请求」那一层：
 * 流式读 body、writeHead 头、Content-Length、跨源、404 分发。
 *
 * 用法：node test/http.mjs
 */

import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dshcn-http-'))
process.env.DSH_HOME = home

const { apply } = await import('../lib/index.js')

const routes = []
const sections = []
const ctx = {
  get(name) {
    if (name === 'systemPrompt') {
      return {
        section(section) {
          sections.push(section)
          return () => {}
        },
        getSectionOrder: () => 10200,
      }
    }
    if (name === 'webServer') {
      return {
        register(route) {
          routes.push(route)
          return () => {}
        },
        getOrigin: () => null, // 未提供基准时退化为「不做 origin 比较」
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

apply(ctx, {})

const route = routes[0]
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://x').pathname
  if (pathname === route.path || pathname.startsWith(`${route.path}/`)) {
    void route.handler(request, response)
    return
  }
  response.writeHead(404, { 'content-type': 'text/plain' })
  response.end('not ours')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures += 1
    console.error(`✗ ${label}  expected ${JSON.stringify(expected)}  actual ${JSON.stringify(actual)}`)
  } else {
    console.log(`✓ ${label}`)
  }
}

const state = await (await fetch(`${origin}/plugins/dsh-constitution/state`)).json()
check('HTTP state.exists', state.exists, false)

const saved = await (
  await fetch(`${origin}/plugins/dsh-constitution/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '# 宪法\n\n规则一。\n' }),
  })
).json()
check('HTTP save ok', saved.ok, true)
check('写入后 exists', saved.state.exists, true)
check('文件内容', readFileSync(join(home, 'constitution.md'), 'utf8'), '# 宪法\n\n规则一。\n')
check('段落文本已更新', sections[0].text().includes('规则一。'), true)

// v2.1：不再做零宽空格转义——段落带 interpolate:false，宿主跳过变量解析，
// 所以正文里的 {{...}} 原样保留才是正确行为。
const preview = await (
  await fetch(`${origin}/plugins/dsh-constitution/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '甲 {{x}} 乙' }),
  })
).json()
check('HTTP preview 花括号计数', preview.braceGroups, 1)
check('HTTP preview 原文保留', preview.text.includes('{{x}}'), true)
check('HTTP preview 声明 interpolate:false', preview.interpolate, false)

const crossed = await fetch(`${origin}/plugins/dsh-constitution/state`, {
  headers: { origin: 'http://evil.example' },
})
check('未设 webServer 基准时不拦截跨源（退化为放行）', crossed.status, 200)

const unknown = await fetch(`${origin}/plugins/dsh-constitution/nope`)
check('未知动作', unknown.status, 404)

const other = await fetch(`${origin}/somewhere-else`)
check('不属于本插件的路径留给后面的路由', other.status, 404)

const badJson = await fetch(`${origin}/plugins/dsh-constitution/save`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{oops',
})
check('非法 JSON → 400', badJson.status, 400)

const typeError = await fetch(`${origin}/plugins/dsh-constitution/save`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 42 }),
})
check('text 非字符串 → 400', typeError.status, 400)

await new Promise((resolve) => server.close(resolve))
rmSync(home, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\nHTTP 端到端全部通过')
