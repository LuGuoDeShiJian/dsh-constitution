/**
 * dsh-constitution —— 把一份用户自己的 markdown 渲染成系统提示词的一段，
 * 并在设置页里直接编辑它（界面上的名字是「常驻规则 / Standing Rules」）。
 * 段落位置由 `order` 配置决定，不写死。
 *
 * 为什么存在这个插件（而不是直接用 AGENTS.md）
 * ──────────────────────────────────────────
 * AGENTS.md 的注入是 source.kind === 'agent-instructions' 的 **user 消息**，
 * 官方文档原话："Baseline and refresh messages are ordinary sourced `user/message`
 * events, so they replay, compact, and resume exactly like other history." ——
 * 也就是说它会随 compaction 一起被摘要，长对话后细节失真。
 *
 * 系统提示词则在 surface node 0：官方架构笔记写明只有首个 system node 受保护。
 * 而且 user message 的信封本身还写着 "They do not override system, developer, or
 * direct user instructions" —— 写在 AGENTS.md 里的「以本文件为准」是自赋优先级，
 * 会被信封当场否掉。要让部署方自己的规则真正落到高优先级，只能进系统提示词层。
 *
 * 为什么正文放独立文件
 * ──────────────────
 * 规则是要经常改的，改了不该动配置、不该碰代码。文件是唯一真源，
 * 界面只是它的一个编辑器。
 *
 * 关于「改完要不要重启」（v2 起已不需要）
 * ────────────────────────────────────
 * `systemPrompt.section()` 的 `text` 可以是**函数**，宿主在**每个 step 装配前**
 * 调用它（dsh-agent-loop `preStep` → `assemble()`；见 dsh-system-prompt
 * `lib/index.js:388`）。所以这里注册的是函数 + mtime 缓存：文件一改，下一个 step
 * 就是新内容，既不重启、也不开新会话。缓存保证「文件没变时读到同一个字符串」，
 * 免得每一轮都换前缀、白烧 KV cache。
 *
 * 可移植性
 * ───────
 * 路径来自 `DSH_HOME` / `~/.dsh`，不写死任何一台机器的 profile 绝对路径；
 * 正文缺失时插件照常活着（不注册空段落、只告警一次），界面负责创建它。
 */

import { fileURLToPath } from 'node:url'

import {
  MAX_BYTES,
  SECTION_NAME,
  createReader,
  estimateTokens,
  prepareForPrompt,
  probe,
  read,
  readTemplate,
  resolveFile,
  writeAtomic,
} from './constitution.js'

/** Cordis 插件名（loader 诊断里显示这个）。 */
export const name = 'dsh-constitution'

/** 默认 HTTP 挂载点。设置页的界面用同一个前缀找宿主。 */
const DEFAULT_ROUTE = '/plugins/dsh-constitution'

/**
 * 请求体上限。
 *
 * 比的是**JSON 编码后**的字节数，所以不能直接用 `MAX_BYTES`：
 * `JSON.stringify` 会把 `\n` 写成 `\\n`、`"` 写成 `\"`、非 ASCII 写进 `\uXXXX`，
 * 最坏情况下体积翻 6 倍（全 CJK 会被转义成 6 字节）。只留 16 KiB 余量的话，
 * 一份**合法大小**的正文会被 413 挡在门外。
 *
 * 取 2 倍 + 4 KiB：覆盖「全是换行/引号」（2 倍）这一最常见的实际情形，
 * 同时把真正的超大请求挡在外面。真正的 512 KiB 判定由 `writeAtomic` 负责，
 * 那里的错误信息是准确的字节数。
 */
const MAX_BODY = MAX_BYTES * 2 + 4 * 1024

/** 随包模板：首次创建正文时的骨架。 */
const TEMPLATE_FILE = fileURLToPath(new URL('../assets/constitution.template.md', import.meta.url))

/**
 * 判断两个 URL 的 origin 是否指向同一台本机服务。
 *
 * 直接比 `URL.origin` 会漏掉最常见的一类「同源」：
 * `http://localhost:PORT` 与 `http://127.0.0.1:PORT` 是同一个监听器，
 * 但字符串不同。本机 GUI 有时从 `localhost` 打开，那样设置页会 403。
 *
 * 规则：协议 + 端口必须相同；主机名相同即通过；主机名不同时，
 * 双方都是 loopback 别名（localhost / 127.x / ::1）也算通过。
 * @param {string} from
 * @param {string} self
 * @returns {boolean}
 */
function sameOriginPair(from, self) {
  let a
  let b
  try {
    a = new URL(from)
    b = new URL(self)
  } catch {
    return false
  }
  if (a.protocol !== b.protocol) return false
  if (a.port !== b.port) return false
  if (a.hostname === b.hostname) return true

  const loopback = (hostname) => {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return host === 'localhost' || host === '::1' || /^127\./.test(host)
  }
  return loopback(a.hostname) && loopback(b.hostname)
}


/**
 * 系统提示词服务是可选的：缺了就不注册段落，插件其余部分照常工作。
 * `webServer` 同样按需取用（桌面壳从 file:// 载入时没有 HTTP 载体）。
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const file = resolveFile(config)
  const sectionName = typeof config.sectionName === 'string' && config.sectionName.length > 0
    ? config.sectionName
    : SECTION_NAME

  const readCached = createReader(file)
  let warnedMissing = false

  /** 宿主基准 + 偏移；拿不到基准就用硬编码兜底，避免整插件不工作。 */
  function resolveOrder(systemPrompt) {
    if (typeof config.order === 'number' && Number.isFinite(config.order)) return config.order
    const base = typeof systemPrompt?.getSectionOrder === 'function'
      ? systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')
      : undefined
    return (typeof base === 'number' ? base : 10200) + 300
  }

  /**
   * 当前生效的原始正文（可能是 config.text 覆盖）。
   * @returns {{ raw?: string, source: 'config' | 'file' | 'none', state: ReturnType<typeof probe>, error?: string }}
   */
  function currentText() {
    const state = readCached()
    if (typeof config.text === 'string' && config.text.trim().length > 0) {
      return { raw: config.text, source: 'config', state }
    }
    if (state.text !== undefined) return { raw: state.text, source: 'file', state }
    return { raw: undefined, source: 'none', state, ...(state.error ? { error: state.error } : {}) }
  }

  /** 界面/诊断用的完整状态快照。 */
  function snapshot(systemPrompt) {
    const current = currentText()
    const prepared = current.raw === undefined ? undefined : prepareForPrompt(current.raw)
    return {
      ok: true,
      path: file,
      exists: current.state.exists,
      readable: current.state.readable,
      ...(current.error === undefined ? {} : { error: current.error }),
      ...(current.state.error === undefined ? {} : { readError: current.state.error }),
      mtimeMs: current.state.mtimeMs,
      size: current.state.size,
      source: current.source,
      injected: prepared !== undefined && prepared.text.length > 0,
      sectionName,
      order: resolveOrder(systemPrompt),
      chars: prepared?.chars ?? 0,
      tokens: estimateTokens(prepared?.text ?? ''),
      braceGroups: prepared?.braceGroups ?? 0,
      // 被剥掉的片段：界面据此提示「这些不会进系统提示词」，避免静默丢内容。
      strippedCount: prepared?.stripped.length ?? 0,
      strippedPreview: (prepared?.stripped ?? []).slice(0, 3).map((item) => item.slice(0, 120)),
      interpolate: false,
      maxBytes: MAX_BYTES,
      maxBodyBytes: MAX_BODY,
      templatePath: TEMPLATE_FILE,
      fileEncoding: 'utf8',
    }
  }

  // ── 0. 可选服务等待 ─────────────────────────────────────────────────────
  //
  // ⚠️ 这一层是踩过坑才有的：**apply() 阶段 `ctx.get('systemPrompt')` 可能是
  //    undefined**（服务还没被提供），插件于是静默降级、一个段落都不注册。
  //    Cordis 的 `inject` 只有「必需」语义（数组里缺一个就永远 pending），
  //    所以可选依赖走 `internal/service` 事件：服务先到就立刻用，后到就等它。
  let systemPrompt

  function whenService(serviceName, callback) {
    let dispose
    let off
    let done = false
    const attach = (implementation) => {
      if (done || implementation === undefined || implementation === null) return false
      done = true
      const result = callback(implementation)
      if (typeof result === 'function') dispose = result
      return true
    }
    if (attach(typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined) === false) {
      if (typeof ctx.on === 'function') {
        off = ctx.on('internal/service', (name, implementation) => {
          if (name !== serviceName) return
          if (!attach(implementation)) return
          // 服务到了：撤掉监听。`off` 由 ctx.on 内部走 fiber.effect 管理，
          // 这里主动调一次是为了不让它留到插件销毁。
          if (typeof off === 'function') off()
        })
      }
    }
    return () => {
      try {
        off?.()
      } catch {
        /* 宿主已经拆掉了，忽略 */
      }
      try {
        dispose?.()
      } catch {
        /* 宿主已经拆掉了，忽略 */
      }
    }
  }

  // ── 1. 系统提示词段落 ───────────────────────────────────────────────────
  ctx.effect(
    () =>
      whenService('systemPrompt', (service) => {
        systemPrompt = service
        if (typeof service.section !== 'function') {
          console.warn('[dsh-constitution] systemPrompt 没有 section()，跳过提示词段落')
          return undefined
        }
        return service.section({
          name: sectionName,
          order: resolveOrder(service),
          // 关键：让宿主**跳过**这段的提示词变量插值。
          //
          // 宿主 `renderPrompt()` 对 `{{name}}` 是严格解析：未注册的变量直接抛错，
          // 而错误发生在 `dsh-agent-loop` 的 step 里，整个 turn 一个请求都发不出去。
          // 正文是用户自由编辑的 markdown，写三花括号 `{{{x}}}`、嵌套 `{{a{{b}}}}`、
          // 模板示例都极常见，自己插零宽空格去躲只会漏（早期版本就漏了）。
          // 用宿主自己的开关，原文照发，零风险、零成本。
          interpolate: false,
          // 函数形式：每个 step 装配前重新求值 → 改文件即时生效。
          text: () => {
            const current = currentText()
            if (current.raw === undefined) {
              if (!warnedMissing) {
                warnedMissing = true
                console.warn(
                  `[dsh-constitution] 还没有正文：${file}。` +
                    '到「设置 → 常驻规则」里写一份并保存即可生效（不用重启）。',
                )
              }
              return ''
            }
            warnedMissing = false
            return prepareForPrompt(current.raw).text
          },
        })
      }),
    'dsh-constitution prompt section',
  )

  // ── 2. 设置页背后的 HTTP 通道 ───────────────────────────────────────────
  // client 半（浏览器）与 host 半之间最省事、最可移植的通道就是一条自带路由：
  // 不需要 Typert 生成产物，也不依赖任何构建链。
  if (config.webRoute === false) return

  const mount = typeof config.webRoute === 'string' && config.webRoute.startsWith('/')
    ? config.webRoute.replace(/\/+$/, '')
    : DEFAULT_ROUTE

  ctx.effect(
    () =>
      whenService('webServer', (webServer) => {
        if (typeof webServer.register !== 'function') return undefined

        /** 只接受同源请求，挡掉别的网页对本机端口发起的跨站写入。 */
        function sameOrigin(request) {
          const from = request.headers.origin
          if (from === undefined || from === '') return true // 同源 GET / 非浏览器客户端
          let self
          try {
            self = typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : undefined
          } catch {
            // getOrigin() 在端口绑定前会抛；此时无法建立基准，按「不做比较」处理。
            return true
          }
          // 拿不到宿主基准（未绑定 / 非 HTTP 载体）时不做比较：同源判断需要基准才有意义。
          if (self === undefined || self === null || self === '') return true
          return sameOriginPair(from, self)
        }

        function send(response, status, payload) {
          const body = JSON.stringify(payload)
          response.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(body),
          })
          response.end(body)
        }

        /**
         * 读完请求体并解析 JSON。
         *
         * 超限时**必须把剩余字节读完**再抛：直接 return 会让未读的请求体留在
         * socket 上，同一条 keep-alive 连接上的下一个请求收到 ECONNRESET。
         * 这里先 `resume()` 排空，再抛 413。
         */
        async function readJson(request) {
          const chunks = []
          let total = 0
          let tooLarge = false
          for await (const chunk of request) {
            total += chunk.length
            if (total > MAX_BODY) {
              tooLarge = true
              // 已经太长了：不再累积，但继续把流读完，保持连接可用。
              continue
            }
            chunks.push(chunk)
          }
          if (tooLarge) {
            throw Object.assign(new Error(`请求体过大（上限 ${MAX_BODY} 字节）`), { statusCode: 413 })
          }
          if (total === 0) return {}
          try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            throw Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 })
          }
        }

        // 回到 whenService 的契约：返回值就是这一支的 disposer。
        return webServer.register({
          kind: 'prefix',
          path: mount,
          handler: async (request, response) => {
          try {
            if (!sameOrigin(request)) return send(response, 403, { ok: false, error: '跨源请求被拒绝' })
            const url = new URL(request.url ?? '/', 'http://localhost')
            const action = url.pathname.slice(mount.length).replace(/^\/+/, '')
            const method = (request.method ?? 'GET').toUpperCase()

            if (action === 'state' && method === 'GET') {
              return send(response, 200, snapshot(systemPrompt))
            }

            if (action === 'read' && method === 'POST') {
              const current = currentText()
              return send(response, 200, {
                ok: true,
                text: current.raw ?? '',
                source: current.source,
                state: snapshot(systemPrompt),
              })
            }

            if (action === 'template' && method === 'GET') {
              const text = readTemplate(TEMPLATE_FILE)
              return send(response, text === undefined ? 404 : 200, text === undefined
                ? { ok: false, error: '随包模板缺失' }
                : { ok: true, text })
            }

            if (action === 'preview' && method === 'POST') {
              const body = await readJson(request)
              const prepared = prepareForPrompt(typeof body.text === 'string' ? body.text : '')
              return send(response, 200, {
                ok: true,
                text: prepared.text,
                chars: prepared.chars,
                tokens: estimateTokens(prepared.text),
                braceGroups: prepared.braceGroups,
                strippedCount: prepared.stripped.length,
                strippedPreview: prepared.stripped.slice(0, 3).map((item) => item.slice(0, 120)),
                interpolate: false,
              })
            }

            // 诊断：让宿主**真跑一次装配**，把这一段在最终提示词里的实际内容与位置
            // 交出来。用来回答「改了文件到底有没有进系统提示词」——不需要模型、
            // 不需要重启，只看这一个进程自己算出来的结果。
            if (action === 'assemble' && method === 'GET') {
              if (typeof systemPrompt?.assemble !== 'function') {
                return send(response, 501, { ok: false, error: '这个宿主没有 systemPrompt.assemble()' })
              }
              const assembly = await systemPrompt.assemble({})
              const sections = (assembly.sections ?? []).map((entry, index) => ({
                index,
                name: entry.name,
                chars: String(entry.text ?? '').length,
              }))
              const mine = (assembly.sections ?? []).find((entry) => entry.name === sectionName)
              return send(response, 200, {
                ok: true,
                pid: process.pid,
                uptimeMs: Math.round(process.uptime() * 1000),
                sectionCount: sections.length,
                sections,
                present: mine !== undefined,
                index: mine === undefined ? -1 : sections.findIndex((entry) => entry.name === sectionName),
                chars: String(mine?.text ?? '').length,
                text: String(mine?.text ?? ''),
              })
            }

            // 诊断：这个包的浏览器半到底进没进启动图。
            // `clientModules.clientPath(id)` 是 client-modules 自己的判断，
            // 返回 undefined 就是「宿主还没扫到这个包的 dsh.client 声明」——
            // 通常是装完还没重启。界面不出现时先看这里，不用猜。
            if (action === 'bundle' && method === 'GET') {
              const clientModules = typeof ctx.get === 'function' ? ctx.get('clientModules') : undefined
              if (clientModules === undefined || clientModules === null) {
                return send(response, 200, { ok: true, available: false, reason: '没有 clientModules 服务（非 web 载体？）' })
              }
              const id = typeof config.packageName === 'string' && config.packageName.length > 0
                ? config.packageName
                : 'dsh-constitution'
              const path = typeof clientModules.clientPath === 'function' ? clientModules.clientPath(id) : undefined
              return send(response, 200, {
                ok: true,
                available: true,
                packageName: id,
                bundled: path !== undefined && path !== null,
                path: path ?? null,
                hint: path === undefined || path === null
                  ? '启动图里没有这个包：装完要重启一次宿主（包元数据按 Loader 条目缓存到重启）'
                  : '已进入启动图；刷新页面就能看到设置页',
              })
            }

            if (action === 'save' && method === 'POST') {
              const body = await readJson(request)
              if (typeof body.text !== 'string') {
                return send(response, 400, { ok: false, error: 'text 必须是字符串' })
              }
              const written = writeAtomic(file, body.text)
              if (written.ok !== true) return send(response, 400, { ok: false, error: written.error })
              return send(response, 200, { ok: true, bytes: written.bytes, state: snapshot(systemPrompt) })
            }

            if (action === 'reset' && method === 'POST') {
              const template = readTemplate(TEMPLATE_FILE)
              if (template === undefined) return send(response, 404, { ok: false, error: '随包模板缺失' })
              const written = writeAtomic(file, template)
              if (written.ok !== true) return send(response, 400, { ok: false, error: written.error })
              return send(response, 200, { ok: true, bytes: written.bytes, state: snapshot(systemPrompt) })
            }

            return send(response, 404, { ok: false, error: `未知操作：${method} ${action || '/'}` })
          } catch (error) {
            const status = typeof error?.statusCode === 'number' ? error.statusCode : 500
            return send(response, status, { ok: false, error: String(error?.message ?? error) })
          }
          },
        })
      }),
    'dsh-constitution http route',
  )
}
