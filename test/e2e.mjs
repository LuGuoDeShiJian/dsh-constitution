/**
 * 端到端定级：拿**真宿主** dsh-system-prompt 验证修复后的关键性质。
 *
 * 这个文件模拟的是 agent-loop 每步真正做的事：
 *   section 注册 → assemble() → renderPrompt()
 * 2.0.0 在这里会抛错（三花括号），修复后必须全部通过。
 *
 * 用法：node test/e2e.mjs
 */

const HOST = 'file:///E:/Tools/DSH/resources/app/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js'
const { renderPrompt } = await import(HOST)
const { prepareForPrompt } = await import('../lib/constitution.js')

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) {
    failures += 1
    console.error(`✗ ${label}${detail ? `  — ${detail}` : ''}`)
  } else {
    console.log(`✓ ${label}${detail ? `  — ${detail}` : ''}`)
  }
}

/**
 * 复刻 agent-loop 的装配路径：
 * 段落声明 interpolate:false，text 是每步求值的函数。
 */
function assembleWith(raw) {
  const section = {
    name: 'deploy:constitution',
    order: 10500,
    interpolate: false,
    text: () => prepareForPrompt(raw).text,
  }
  const assembly = {
    sections: [
      { name: 'harness:identity', text: 'identity' },
      { name: section.name, text: section.text(), interpolate: section.interpolate },
      { name: 'deployment:persona-suffix', text: 'persona' },
    ],
    variables: {},
  }
  return renderPrompt(assembly)
}

console.log('=== 1. 用户可能写出的各种正文，都必须能装配 ===')
const inputs = {
  '普通规则': '# 规则\n\n不猜着答。\n',
  '模板占位符': '# 规则\n\n调用时把 {{name}} 换掉。\n',
  'Vue 三花括号': '# 规则\n\n前端用 {{{ raw }}} 输出原始 HTML。\n',
  '四花括号': '# 规则\n\n转义写法 {{{{x}}}}。\n',
  '嵌套花括号': '# 规则\n\n格式 {{a{{b}}}} 表示嵌套。\n',
  'JSON 示例': '# 规则\n\n返回 {"k": "{{v}}"} 这种。\n',
  '未配对': '# 规则\n\n写了 {{ 但没写完。\n',
  '大量花括号': `# 规则\n\n${'{{'.repeat(2000)}\n`,
  'Jinja 模板': '# 规则\n\n{% if x %}{{ y }}{% endif %}\n',
  'Handlebars 块': '# 规则\n\n{{#each items}}{{this}}{{/each}}\n',
}

for (const [label, raw] of Object.entries(inputs)) {
  let rendered
  let error = null
  try {
    rendered = assembleWith(raw)
  } catch (cause) {
    error = cause
  }
  const preserved = error === null && rendered.includes(prepareForPrompt(raw).text.trim().slice(-20))
  check(label, error === null, error === null ? `装配通过，输出 ${rendered.length} 字符` : String(error.message).slice(0, 90))
}

console.log('\n=== 2. 花括号内容原样进入提示词（没有被改写）===')
{
  const raw = '# 规则\n\n三花 {{{v}}} 与两层 {{x}}。\n'
  const rendered = assembleWith(raw)
  check('三花括号原样保留', rendered.includes('{{{v}}}'))
  check('两层花括号原样保留', rendered.includes('{{x}}'))
  check('没有零宽空格注入', !rendered.includes('\u200b'))
}

console.log('\n=== 3. 剥离规则仍然生效（且只剥该剥的）===')
{
  const raw = '# 规则\n\n> 头注释\n\n正文甲。\n\n> 中间的引用保留\n\n正文乙。\n'
  const rendered = assembleWith(raw)
  check('头注释被剥', !rendered.includes('头注释'))
  check('中间引用保留', rendered.includes('中间的引用保留'))
  check('正文都在', rendered.includes('正文甲') && rendered.includes('正文乙'))
}

console.log('\n=== 4. 代码块里的 HTML 注释保留 ===')
{
  const raw = '# 规则\n\n```html\n<!-- 示例 -->\n```\n\n正文。\n'
  const rendered = assembleWith(raw)
  check('围栏内注释保留', rendered.includes('示例'))
}

console.log('\n=== 5. 性能：每个 step 都跑，不能有可感知开销 ===')
{
  const big = `# 规则\n\n${'{{'.repeat(100000)}\n`
  const t0 = performance.now()
  for (let i = 0; i < 10; i += 1) assembleWith(big)
  const ms = (performance.now() - t0) / 10
  check('200 KiB 花括号正文单次装配', ms < 50, `${ms.toFixed(2)} ms`)
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures > 0 ? 1 : 0)
