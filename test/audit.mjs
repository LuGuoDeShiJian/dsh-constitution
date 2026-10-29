/**
 * 审计回归：把审计中确认的每个缺陷钉成一条可复跑的断言。
 *
 * 与 smoke.mjs / http.mjs 的区别：那两个测「设计是否工作」，
 * 这个测「边界是否成立」。全部跑在**真宿主模块**上，不用替身。
 *
 * 用法：node test/audit.mjs
 *   期望：全部 [OK]，退出码 0。
 */

import { createServer, Agent, request as httpRequest } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const HOST = 'file:///E:/Tools/DSH/resources/app/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js'
const { renderPrompt } = await import(HOST)
const {
  prepareForPrompt, stripMeta, analyzeMeta, normalizeNewlines, splitFences, MAX_BYTES,
} = await import('../lib/constitution.js')

let bugs = 0
const line = (tag, label, detail = '') => {
  if (tag === 'BUG') bugs += 1
  console.log(`  [${tag}] ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

// ── A. 段落带 interpolate:false 后，任意花括号都能过宿主装配 ──────────────
console.log('\nA. 花括号：插件产出的段落能否过宿主装配')
{
  // 复刻 lib/index.js 里 section() 的注册形状
  const asSection = (raw) => ({
    name: 'deploy:constitution',
    interpolate: false,
    text: prepareForPrompt(raw).text,
  })
  const cases = [
    '{{x}}', '{{{x}}}', '{{{{x}}}}', '{{a{{b}}}}', '{{ x }}', '{{_x}}',
    '规则 {{{ raw }}} 输出原始 HTML', '格式 {{a{{b}}}} 表示嵌套',
    '返回 {"k": "{{v}}"}', '不配对 {{ 没有收尾', '{{'.repeat(500),
  ]
  let allOk = true
  for (const raw of cases) {
    try {
      const rendered = renderPrompt({ sections: [asSection(raw)], variables: {} })
      if (!rendered.includes('{{')) allOk = false
    } catch (error) {
      allOk = false
      line('BUG', JSON.stringify(raw).slice(0, 40), String(error.message).slice(0, 80))
    }
  }
  line(allOk ? 'OK' : 'BUG', `${cases.length} 种花括号写法全部原样通过`, allOk ? '含三花/四花/嵌套/未配对' : '见上')
}

// ── B. 对照组：不带 interpolate:false 会炸（证明这个开关是必需的） ────────
console.log('\nB. 对照：去掉 interpolate:false 后确实会炸')
{
  let threw = false
  try {
    renderPrompt({
      sections: [{ name: 's', text: prepareForPrompt('规则 {{{v}}}').text }],
      variables: {},
    })
  } catch {
    threw = true
  }
  line(threw ? 'OK' : 'BUG', '不带开关时三花括号仍抛错', threw ? '符合预期，说明开关必要' : '居然通过了，测试无效')
}

// ── C. 复杂度：不再有正则回溯 ────────────────────────────────────────────
console.log('\nC. 处理耗时（每 step 都跑）')
{
  const bomb = '{{'.repeat(256 * 1024 / 2)
  const t0 = performance.now()
  for (let i = 0; i < 20; i += 1) prepareForPrompt(bomb)
  const ms = (performance.now() - t0) / 20
  line(ms < 50 ? 'OK' : 'BUG', `${(bomb.length / 1024).toFixed(0)} KiB 的 "{{" 单次`, `${ms.toFixed(2)} ms`)

  const full = '{{'.repeat(MAX_BYTES / 2)
  const t1 = performance.now()
  prepareForPrompt(full)
  const msFull = performance.now() - t1
  line(msFull < 100 ? 'OK' : 'BUG', `512 KiB 上限全量`, `${msFull.toFixed(1)} ms`)
}

// ── D. 引用块：只剥文档开头那一段 ────────────────────────────────────────
console.log('\nD. stripMeta 引用块范围')
{
  const one = stripMeta('# 规则\n\n正文甲。\n\n> 中间引用\n\n正文乙。\n')
  line(one.includes('中间引用') ? 'OK' : 'BUG', '只有中间引用块', one.includes('中间引用') ? '保留' : '被剥掉')

  const two = stripMeta('# 规则\n\n> 头注释\n\n正文甲。\n\n> 中间引用\n\n正文乙。\n')
  line(two.includes('中间引用') ? 'OK' : 'BUG', '头+中间各一个', two.includes('中间引用') ? '中间保留' : '被剥掉')
  line(!two.includes('头注释') ? 'OK' : 'BUG', '头+中间各一个', !two.includes('头注释') ? '头被剥' : '头未剥')

  const rules = analyzeMeta('# 规则\n\n> 必须遵守甲。\n\n> 必须遵守乙。\n')
  // 文档开头的引用块被剥是**既定行为**；不可接受的是「剥了不告诉人」。
  line(rules.stripped.length > 0 ? 'OK' : 'BUG', '两条引用式规则：剥离可被感知',
    rules.stripped.length > 0 ? `已上报 ${rules.stripped.length} 段被剥内容` : '静默删除，用户无从察觉')
  line(rules.stripped.some((s) => s.includes('必须遵守甲')) ? 'OK' : 'BUG', '被剥内容里能看到原文',
    rules.stripped.some((s) => s.includes('必须遵守甲')) ? '可核对' : '内容丢了')

  const noTitle = stripMeta('> 甲\n> 乙\n\n正文。\n')
  line(!noTitle.includes('甲') ? 'OK' : 'BUG', '无标题文件的头部引用', noTitle.includes('甲') ? '未剥' : '已剥')
}

// ── E. 代码块里的 HTML 注释要保留 ────────────────────────────────────────
console.log('\nE. stripMeta 与围栏代码块')
{
  const code = '# 规则\n\n```html\n<!-- 要展示的示例 -->\n```\n'
  const out = stripMeta(code)
  line(out.includes('要展示的示例') ? 'OK' : 'BUG', '围栏里的 HTML 注释', out.includes('要展示的示例') ? '保留' : '被剥掉')

  const outside = stripMeta('# 规则\n\n<!-- 真注释 -->\n\n正文。\n')
  line(!outside.includes('真注释') ? 'OK' : 'BUG', '代码块外的 HTML 注释', !outside.includes('真注释') ? '已剥' : '未剥')

  const tilde = stripMeta('# 规则\n\n~~~\n<!-- 保留我 -->\n~~~\n')
  line(tilde.includes('保留我') ? 'OK' : 'BUG', '~~~ 围栏', tilde.includes('保留我') ? '保留' : '被剥掉')

  const skip = stripMeta('# 规则\n\n<!-- RENDER-ONLY:SKIP -->\n隐藏\n<!-- RENDER-ONLY:END -->\n\n正文。\n')
  line(!skip.includes('隐藏') ? 'OK' : 'BUG', '显式 SKIP 区块（代码块外）', !skip.includes('隐藏') ? '已剥' : '未剥')

  const skipInFence = stripMeta('# 规则\n\n```\n<!-- RENDER-ONLY:SKIP -->\n隐藏\n<!-- RENDER-ONLY:END -->\n```\n')
  line(!skipInFence.includes('隐藏') ? 'OK' : 'BUG', '显式 SKIP 区块（代码块内也生效）', !skipInFence.includes('隐藏') ? '已剥' : '未剥')
}

// ── F. CRLF ──────────────────────────────────────────────────────────────
console.log('\nF. CRLF 输入')
{
  const crlf = stripMeta('# 规则\r\n\r\n正文甲。\r\n\r\n\r\n\r\n正文乙。\r\n')
  line(!crlf.includes('\r') ? 'OK' : 'BUG', '残留 \\r', crlf.includes('\r') ? '仍有' : '已归一')
  line(!crlf.includes('\n\n\n') ? 'OK' : 'BUG', '连续空行折叠', crlf.includes('\n\n\n') ? '未折叠' : '已折叠')

  const mixed = normalizeNewlines('a\r\nb\rc\nd')
  line(mixed === 'a\nb\nc\nd' ? 'OK' : 'BUG', 'CRLF/CR/LF 混合', JSON.stringify(mixed))
}

// ── G/H/I. HTTP 层 ───────────────────────────────────────────────────────
const home = mkdtempSync(join(tmpdir(), 'dshcn-audit-'))
process.env.DSH_HOME = home
const { apply } = await import('../lib/index.js')

const routes = []
apply({
  get(name) {
    if (name === 'systemPrompt') return { section: () => () => {}, getSectionOrder: () => 10200, assemble: async () => ({ sections: [] }) }
    if (name === 'webServer') return { register(r) { routes.push(r); return () => {} }, getOrigin: () => 'http://127.0.0.1:56647' }
    return undefined
  },
  effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
}, {})

const route = routes[0]
const server = createServer((req, res) => {
  if (new URL(req.url, 'http://x').pathname.startsWith(route.path)) return void route.handler(req, res)
  res.writeHead(404); res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}/plugins/dsh-constitution`

console.log('\nG. HTTP 写入上限')
{
  const text = '\n'.repeat(MAX_BYTES - 100)
  const body = JSON.stringify({ text })
  const r = await fetch(`${base}/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  const json = await r.json()
  line(r.status === 200 && json.ok ? 'OK' : 'BUG', `${(Buffer.byteLength(text) / 1024).toFixed(0)} KiB 正文（上限 512 KiB）`,
    r.status === 200 ? `保存成功，${json.bytes} 字节` : `HTTP ${r.status}`)
}
{
  // 超过正文上限的必须仍然被拒（由 writeAtomic 判）
  const text = 'x'.repeat(MAX_BYTES + 1024)
  const r = await fetch(`${base}/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
  line(r.status === 400 ? 'OK' : 'BUG', '超上限正文仍被拒', `HTTP ${r.status}`)
}

console.log('\nH. 413 之后的同一条 keep-alive 连接')
{
  const huge = JSON.stringify({ text: 'x'.repeat(MAX_BYTES * 3) })
  const result = await new Promise((resolve) => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    const out = []
    const send = (spec, done) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: spec.path, method: spec.method, headers: spec.headers, agent }, (res) => {
        res.resume()
        res.on('end', () => { out.push(res.statusCode); done() })
      })
      req.on('error', (e) => { out.push(e.code); done() })
      req.end(spec.body)
    }
    send({ path: '/plugins/dsh-constitution/save', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(huge) }, body: huge }, () => {
      send({ path: '/plugins/dsh-constitution/state', method: 'GET', headers: {} }, () => resolve(out))
    })
  })
  line(result[0] === 413 ? 'OK' : 'BUG', '第一个请求', `HTTP ${result[0]}`)
  line(result[1] === 200 ? 'OK' : 'BUG', '第二个请求（同连接）', result[1] === 200 ? '正常，连接未被污染' : String(result[1]))
}

console.log('\nI. 同源判断')
{
  const cases = [
    ['http://127.0.0.1:56647', 200, '基准自身'],
    ['http://localhost:56647', 200, 'localhost 别名'],
    ['http://evil.example', 403, '真跨源'],
    ['http://127.0.0.1:9999', 403, '端口不同'],
    ['https://127.0.0.1:56647', 403, '协议不同'],
  ]
  for (const [origin, expect, label] of cases) {
    const r = await fetch(`${base}/state`, { headers: { origin, connection: 'close' } })
    line(r.status === expect ? 'OK' : 'BUG', `${label} ${origin}`, `HTTP ${r.status}（期望 ${expect}）`)
  }
}

await new Promise((r) => server.close(r))
rmSync(home, { recursive: true, force: true })

// ── J. 真实文件体检 ──────────────────────────────────────────────────────
console.log('\nJ. 本机真实 constitution.md')
{
  try {
    const raw = readFileSync(join(homedir(), '.dsh', 'constitution.md'), 'utf8')
    const p = prepareForPrompt(raw)
    line('OK', '体积', `${raw.length} → ${p.chars} 字符，花括号组 ${p.braceGroups}`)
    line(p.text.includes('行为宪法') ? 'OK' : 'BUG', '标题保留', p.text.includes('行为宪法') ? '在' : '丢了')
  } catch {
    console.log('  (跳过：没有 ~/.dsh/constitution.md)')
  }
}

console.log(`\n${bugs} 条缺陷残留`)
process.exit(bugs > 0 ? 1 : 0)
