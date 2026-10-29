/**
 * 验证浏览器半能在**真模块加载器契约**下加载，并检查注册形状与字典完整性。
 *
 * 本机没有独立的 react 包（宿主把它打进了 client bundle），所以这里用最小
 * React 替身：只实现 createElement / useState / useCallback / useEffect /
 * useMemo 这几个 client.js 真正用到的钩子。目的是验证**契约与数据**，
 * 不是验证渲染结果——渲染效果用浏览器实测。
 *
 * 用法：node test/client.mjs
 */

import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

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
function checkTruthy(label, actual) {
  if (!actual) {
    failures += 1
    console.error(`✗ ${label} (got ${JSON.stringify(actual)})`)
  } else {
    console.log(`✓ ${label}`)
  }
}

// ── 最小 React 替身 ──────────────────────────────────────────────────────
const hookState = []
let hookIndex = 0
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => {
    const index = hookIndex++
    if (!(index in hookState)) hookState[index] = typeof initial === 'function' ? initial() : initial
    return [hookState[index], (next) => { hookState[index] = typeof next === 'function' ? next(hookState[index]) : next }]
  },
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
}

// ── DOM / 加载器替身 ─────────────────────────────────────────────────────
const headChildren = []
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild: (node) => headChildren.push(node) },
}
let loaded
globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }

const moduleTable = { react: ReactStub }
const fn = new Function('window', 'document', 'location', source)
fn(globalThis.window, globalThis.document, { protocol: 'http:', origin: 'http://127.0.0.1:56647' })

check('bundle id 与包名一致', loaded.id, 'dsh-constitution')
check('factory 是函数', typeof loaded.factory, 'function')

const exportsObj = loaded.factory((name) => {
  if (!(name in moduleTable)) throw new Error(`未预期的 require("${name}")`)
  return moduleTable[name]
})

check('导出 apply', typeof exportsObj.apply, 'function')
check('导出 inject', JSON.stringify(exportsObj.inject), JSON.stringify(['slots', 'locale']))

// ── 跑 apply，检查注册形状 ───────────────────────────────────────────────
const registrations = []
const localeCalls = []
const dictsRef = {}
const ctx = {
  effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} },
  locale: {
    register: (ns, dicts) => { localeCalls.push({ ns, dicts }); return () => {} },
    bind: (ns) => (key) => (dictsRef[ns]?.[key] ?? key),
  },
  slots: {
    inject: (name, cb) => { cb() },
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  },
}

exportsObj.apply(ctx)

check('注册了一个 locale 命名空间', localeCalls.length, 1)
check('locale ns', localeCalls[0].ns, 'constitution')
checkTruthy('zh 字典存在', localeCalls[0].dicts.zh !== undefined)
checkTruthy('en 字典存在', localeCalls[0].dicts.en !== undefined)
Object.assign(dictsRef, { constitution: localeCalls[0].dicts.zh })

check('注入了一个样式标签', headChildren.length, 1)
checkTruthy('样式含剥离提示类', headChildren[0].textContent.includes('dshcn-warn'))
checkTruthy('样式含片段类', headChildren[0].textContent.includes('dshcn-frag'))

check('注册了一个 settings.section', registrations.length, 1)
const reg = registrations[0]
check('槽位名', reg.options.name, 'settings.section')
check('槽位 id', reg.options.id, 'dsh-constitution')
check('槽位 order', reg.options.order, 65)
check('槽位 locale', reg.options.locale, 'constitution')
checkTruthy('label 是函数', typeof reg.options.label, 'function')
check('label 输出中文', reg.options.label(), '常驻规则')

// ── 字典键一致性：zh / en 必须同键 ──────────────────────────────────────
const zhKeys = Object.keys(localeCalls[0].dicts.zh).sort()
const enKeys = Object.keys(localeCalls[0].dicts.en).sort()
check('zh 与 en 键完全一致', zhKeys, enKeys)
checkTruthy('字典含 braceGroups', zhKeys.includes('braceGroups'))
checkTruthy('字典含 braceHint', zhKeys.includes('braceHint'))
checkTruthy('字典含 strippedHint', zhKeys.includes('strippedHint'))
check('已移除 escaped 键', zhKeys.includes('escaped'), false)

// ── 源码级：不残留旧字段 ────────────────────────────────────────────────
check('源码不再用 state.escaped', source.includes('state.escaped'), false)
check("源码不再用 t('escaped')", source.includes("t('escaped')"), false)
checkTruthy('源码渲染剥离提示', source.includes('strippedPreview'))
checkTruthy('源码渲染花括号计数', source.includes('braceGroups'))

// ── 组件在「state 为 null」时能跑完（不崩） ─────────────────────────────
const Section = reg.component
hookIndex = 0
hookState.length = 0
let threw = null
try {
  Section({ t: (key) => dictsRef.constitution[key] ?? key })
} catch (error) {
  threw = error
}
check('初始渲染不抛错', threw === null ? null : String(threw.message), null)

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n浏览器半全部通过')
