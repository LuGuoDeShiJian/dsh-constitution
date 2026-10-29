/**
 * 纯逻辑层：路径解析 / 正文净化 / 原子写盘 / 状态探测。
 *
 * 这一层**只依赖 node 内置模块**，不认识 Cordis、不认识 DSH。
 * 之所以这样切，是为了可移植：宿主侧渲染、HTTP 路由、命令行脚本、单元测试
 * 都能直接 import 同一套行为，不需要先把宿主跑起来。
 *
 * 关于花括号（v2.1 重写）
 * ─────────────────────
 * 早期版本自己实现 `escapeBraceGroups`，往 `{{` 里插零宽空格来躲开宿主的
 * 提示词变量解析。两个问题：
 *   1. 只认两层 `{{...}}`，三花括号 `{{{x}}}`、四花括号、嵌套 `{{a{{b}}}}`
 *      转义后**仍然残留 `{{`**，宿主 `renderPrompt()` 照样抛错，
 *      整个 turn 一个请求都发不出去。
 *   2. 正则 `/\{\{[\s\S]*?\}\}/g` 在无收尾的 `{{` 上退化成 O(n²)：
 *      512 KiB 要 32 秒，而这段代码**每个 step 都跑一次**。
 *
 * 宿主本来就提供了正解：`systemPrompt.section({ interpolate: false })`
 * 让该段落跳过变量插值，原文照发。所以本文件不再做任何花括号改写，
 * 只统计出现次数供界面提示用。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** 正文文件名（放在 DSH 主目录下）。 */
export const FILE_NAME = 'constitution.md'

/** 段落名：出现在宿主诊断与 `/context` 面板里，保持稳定便于识别。 */
export const SECTION_NAME = 'deploy:constitution'

/**
 * 宿主最后一段（DEPLOYMENT_PERSONA_SUFFIX = 10200）之后 300。
 *
 * 取 +300 与社区实践一致；比宿主基准更小会导致「插到第一方指导前面」，不是本意。
 */
export const ORDER_OFFSET = 300

/** 兜底顺序：拿不到宿主基准时用。 */
export const FALLBACK_ORDER = 10200 + ORDER_OFFSET

/** 单次保存的上限。正文是给人读的规则，超过这个量说明放错了文件。 */
export const MAX_BYTES = 512 * 1024

/**
 * 围栏代码块的起始/结束标记。
 *
 * 只认行首（允许缩进）的 ``` 或 ~~~，且至少三个；结束标记必须同类且不短于起始。
 * 不追求完整 CommonMark，只求「代码块里的 HTML 注释不被当成注释剥掉」。
 */
const FENCE_OPEN = /^(\s{0,3})(`{3,}|~{3,})(.*)$/

/**
 * DSH 主目录。`DSH_HOME` 优先，否则 `~/.dsh`。
 * 显式支持环境变量，是为了让同一份包能在不同部署（多实例 / 容器 / 换机器）下正确落盘。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function dshHome(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured.length > 0 ? resolve(configured) : join(homedir(), '.dsh')
}

/**
 * 把 `~` / `~/x` 展开为家目录；其余原样返回。
 * @param {string} path
 * @returns {string}
 */
export function expandHome(path) {
  const text = String(path ?? '').trim()
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

/**
 * 解析正文路径。配置优先，否则 `<DSH_HOME>/constitution.md`。
 * @param {{ textFile?: string }} [config]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} 绝对路径
 */
export function resolveFile(config = {}, env = process.env) {
  const configured = typeof config?.textFile === 'string' ? expandHome(config.textFile) : ''
  if (configured.length > 0) return isAbsolute(configured) ? configured : resolve(configured)
  return join(dshHome(env), FILE_NAME)
}

/**
 * 统一换行：CRLF / 单独 CR 一律转 LF。
 *
 * Windows 记事本、部分编辑器保存出来是 CRLF。不归一的话：
 *   · `\n{3,}` 折叠规则匹配不到 `\r\n\r\n\r\n`，空行压缩失效；
 *   · 行级正则（围栏、引用块）末尾会带一个 `\r`。
 * @param {string} text
 * @returns {string}
 */
export function normalizeNewlines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n')
}

/**
 * 把文本切成「围栏代码块内」与「外」两类片段。
 *
 * 剥离规则只作用于**代码块外**：用户完全可能在正文里贴一段
 * ```html
 * <!-- 这是要给模型看的示例 -->
 * ```
 * 早期实现无视围栏，把示例直接吃掉。
 * @param {string} text 已归一换行的文本
 * @returns {{ text: string, fenced: boolean }[]}
 */
export function splitFences(text) {
  const lines = text.split('\n')
  const parts = []
  let buffer = []
  let fence = null // { marker: '`' | '~', length: number }

  const flush = () => {
    if (buffer.length === 0) return
    parts.push({ text: buffer.join('\n'), fenced: fence !== null })
    buffer = []
  }

  for (const line of lines) {
    const match = FENCE_OPEN.exec(line)
    if (fence === null) {
      if (match !== null && !(match[2][0] === '`' && match[3].includes('`'))) {
        // 开围栏：先把之前累积的正文冲出去，围栏行本身算代码块内容。
        flush()
        fence = { marker: match[2][0], length: match[2].length }
        buffer.push(line)
        continue
      }
      buffer.push(line)
      continue
    }
    // 已在围栏内：只看是否遇到同类、不短于起始的结束标记。
    buffer.push(line)
    if (match !== null && match[2][0] === fence.marker && match[2].length >= fence.length && match[3].trim() === '') {
      flush()
      fence = null
    }
  }
  flush()
  return parts
}

/**
 * 剥掉给「人」看的元信息，只留给「模型」看的行为条文。
 *
 * 正文文件里有一部分是维护说明——正文放哪、别写 `{{}}` 之类。
 * 这些话对维护者有用，但对模型每一轮都是白花的 token，而且模型看到
 * 「这份文件不会失效」这种话容易开始解释自己如何被配置。
 *
 * 与模型无关的内容按三种特征剥除：
 *   1. **文档开头**的 `>` 引用块（文件头总说明）。只剥开头那一段，
 *      正文中间用引用块写的规则原样保留。
 *   2. `<!-- RENDER-ONLY:SKIP -->` … `<!-- RENDER-ONLY:END -->` 夹住的部分
 *      （显式标记，优先于一切，代码块里也生效）。
 *   3. HTML 注释 `<!-- ... -->`（可写多行）——**代码块内不剥**。
 *
 * 想保留在提示词里的内容，就不要套进这三种形式。
 *
 * ⚠️ 剥离必须是**可告知的**：早期版本静默删掉文档开头的引用块，用户用引用
 * 写规则时第一条会无声消失。所以真正做事的是 {@link analyzeMeta}，
 * 它把被剥掉的内容一并交出来，界面据此提示。
 * @param {string} text
 * @returns {string}
 */
export function stripMeta(text) {
  return analyzeMeta(text).text
}

/**
 * 同 {@link stripMeta}，但额外回报被剥掉的内容。
 *
 * `stripped` 里每一项是一段被删除的原文，按出现顺序。调用方可以据此
 * 在界面上提示「这部分不会进系统提示词」，而不是让内容静默消失。
 * @param {string} text
 * @returns {{ text: string, stripped: string[] }}
 */
export function analyzeMeta(text) {
  const stripped = []
  const record = (value) => {
    const trimmed = String(value ?? '').trim()
    if (trimmed.length > 0) stripped.push(trimmed)
  }

  let out = normalizeNewlines(text)

  // 1. 显式区块：跨代码块也剥（这是维护者的显式意图）。
  out = out.replace(/<!--\s*RENDER-ONLY:SKIP\s*-->[\s\S]*?<!--\s*RENDER-ONLY:END\s*-->/g, (match) => {
    record(match)
    return ''
  })

  // 2. HTML 注释：只剥代码块外的。
  out = splitFences(out)
    .map((part) => {
      if (part.fenced) return part.text
      return part.text.replace(/<!--[\s\S]*?-->/g, (match) => {
        record(match)
        return ''
      })
    })
    .join('\n')

  // 3. 文档开头的引用块（可选先有一个标题行）。
  //    必须锚在**字符串起点**：早期版本用了 /m，`^` 会在每一行行首都匹配，
  //    于是正文中间第一个引用块也被当成「文件头」剥掉，用户的规则无声消失。
  out = out.replace(/^(#[^\n]*\n+)?((?:>[^\n]*\n?)+)/, (match, title, quote) => {
    record(quote)
    return title ? `${title}\n` : ''
  })

  // 4. 折叠因剥离产生的连续空行。
  out = out.replace(/\n{3,}/g, '\n\n')

  return { text: out.trim(), stripped }
}

/**
 * 统计 `{{` 出现次数。
 *
 * 只做提示，不改写正文——真正的安全由 `interpolate: false` 保证。
 * @param {string} text
 * @returns {number}
 */
export function countBraceGroups(text) {
  return (String(text ?? '').match(/\{\{/g) ?? []).length
}

/**
 * 正文 → 真正写进系统提示词的文本。
 *
 * **不做任何花括号转义**：注册段落时带 `interpolate: false`，
 * 宿主不会扫描这段文本里的 `{{...}}`，所以原文照发即可。
 * @param {string} raw
 * @returns {{ text: string, chars: number, braceGroups: number, stripped: string[] }}
 */
export function prepareForPrompt(raw) {
  const { text, stripped } = analyzeMeta(raw)
  return { text, chars: text.length, braceGroups: countBraceGroups(text), stripped }
}

/**
 * 粗略估算 token 数（CJK 按字、其余按 4 字符）。
 * 只用于界面上给个量级，不参与任何判定。
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const body = String(text ?? '')
  if (body.length === 0) return 0
  const cjk = (body.match(/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/g) ?? []).length
  const rest = body.length - cjk
  return cjk + Math.ceil(rest / 4)
}

/**
 * 探测文件状态。不抛错——读不到就是「未就绪」。
 * @param {string} file
 * @returns {{ path: string, exists: boolean, mtimeMs: number, size: number, readable: boolean, error?: string }}
 */
export function probe(file) {
  try {
    const stat = statSync(file)
    return {
      path: file,
      exists: true,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      readable: stat.isFile(),
      // Windows 上 ino 可能为 0，此时缓存键退化回 mtime:size，行为与旧版一致。
      ino: typeof stat.ino === 'number' ? stat.ino : undefined,
    }
  } catch (error) {
    const missing = error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
    return {
      path: file,
      exists: false,
      mtimeMs: 0,
      size: 0,
      readable: false,
      ...(missing ? {} : { error: String(error?.message ?? error) }),
    }
  }
}

/**
 * 读正文。读不到返回 undefined（不抛错）；存在但读不动时把错误带出来。
 * @param {string} file
 * @returns {{ text?: string, error?: string }}
 */
export function read(file) {
  try {
    return { text: readFileSync(file, 'utf8') }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return {}
    return { error: String(error?.message ?? error) }
  }
}

/**
 * 原子写：先写同目录临时文件再 rename，避免半截内容被装配读到。
 * @param {string} file
 * @param {string} text
 * @returns {{ ok: true, bytes: number } | { ok: false, error: string }}
 */
export function writeAtomic(file, text) {
  const body = String(text ?? '')
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > MAX_BYTES) {
    return { ok: false, error: `正文 ${bytes} 字节，超过上限 ${MAX_BYTES} 字节` }
  }
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, body, 'utf8')
    try {
      renameSync(tmp, file)
    } catch (error) {
      // Windows 上极少数情况（目标被占用）rename 会失败：退化成删除后重命名。
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error
      rmSync(file, { force: true })
      renameSync(tmp, file)
    }
    return { ok: true, bytes }
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 临时文件清理失败不影响结论 */
    }
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * 读取随包模板（首次创建正文的骨架）。
 * @param {string} templateFile
 * @returns {string | undefined}
 */
export function readTemplate(templateFile) {
  try {
    const text = readFileSync(templateFile, 'utf8')
    return text.trim().length > 0 ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * mtime+size+ino 三键缓存：同一个文件没变就不重复解析。
 *
 * 系统提示词**每个 step 都会重新装配**，所以 section 的 text 是一个函数；
 * 这里保证「没改文件时读到的仍是同一个字符串」（前缀不变 → KV cache 不白烧）。
 *
 * 加 `ino` 是为了堵住「同尺寸、同 mtime（粗精度文件系统）、不同内容」的碰撞窗口。
 * @param {string} file
 */
export function createReader(file) {
  let cache
  return function readCached() {
    const state = probe(file)
    if (!state.exists) {
      cache = undefined
      return { ...state, text: undefined }
    }
    const key = `${state.mtimeMs}:${state.size}:${state.ino ?? ''}`
    if (cache?.key === key) return { ...state, text: cache.text, cached: true }
    const result = read(file)
    if (result.error !== undefined) return { ...state, text: undefined, error: result.error }
    cache = { key, text: result.text }
    return { ...state, text: result.text, cached: false }
  }
}
