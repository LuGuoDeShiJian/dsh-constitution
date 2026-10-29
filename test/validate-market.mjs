/**
 * 用 **DSH 自己的校验器** 验证随附的市场索引，而不是靠人眼。
 *
 * 校验器是 `@deepseek-ai/dsh-plugin-market-index` 的 parseMarketIndex：
 * 宿主读任何索引都会过这一关，所以这里过了就代表「服务器 accepted」。
 *
 * 用法：
 *   node test/validate-market.mjs
 *   DSH_MARKET_INDEX_MODULE=file:///…/lib/index.js node test/validate-market.mjs
 */

import { readFileSync } from 'node:fs'

const moduleUrl =
  process.env.DSH_MARKET_INDEX_MODULE ??
  'file:///E:/Tools/DSH/resources/app/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js'

let parseMarketIndex
try {
  ;({ parseMarketIndex } = await import(moduleUrl))
} catch (error) {
  console.error(`读不到 DSH 的校验器：${moduleUrl}\n${error?.message ?? error}`)
  console.error('用 DSH_MARKET_INDEX_MODULE 指向本机安装里的 lib/index.js，或者跳过这一步。')
  process.exit(2)
}

const document = JSON.parse(readFileSync(new URL('../market/index.json', import.meta.url), 'utf8'))
const indexUrl = 'https://example.com/dsh-market/index.json'

try {
  const parsed = parseMarketIndex(document, indexUrl)
  console.log(`索引通过格式 1 校验：${parsed.plugins.length} 个插件`)
  for (const entry of parsed.plugins) {
    const versions = entry.versions.map((version) => version.version).join(', ')
    console.log(`  ${entry.name} — ${versions}`)
  }
} catch (error) {
  console.error(`索引不合法：${error?.name ?? 'Error'}`)
  console.error(`  path: ${error?.path}`)
  console.error(`  reason: ${error?.reason ?? error?.message}`)
  process.exit(1)
}