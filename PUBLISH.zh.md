# 发布 dsh-constitution

DSH 装插件有两条独立的路：**直接装包**（`dsh plugin add`）和**插件市场**（一个 JSON 索引）。
市场不托管包，只是「哪里能装」的清单 —— 所以发布 = 把包放出去 + 写一份索引。

---

## 一、先决定分发形态

| 形态 | 适合 | 安装参数（DSH 实际执行） |
|---|---|---|
| **npm registry** | 想让人 `dsh plugin add dsh-constitution` 就装上；想要版本号语义 | `dsh-constitution@2.1.0` |
| **Git 仓库** | 不想发 npm，或要固定到某个提交 | `git+https://github.com/<user>/<repo>.git#<40位commit>[&path:/<子目录>]` |
| **本地 tarball** | 内部分发、自己几台机器 | `file:/path/to/dsh-constitution-2.1.0.tgz` |

三条都**不需要**市场索引也能装 —— 索引只影响「发现」体验。

## 二、发到 npm

```bash
cd plugins/dsh-constitution

# 包名：npm 上要唯一。改成带 scope 的更稳：
#   "name": "@your-scope/dsh-constitution"
# 同时改 lib/client.js 里的 id（必须与包名一致）：
#   window.__ModuleLoader__.load({ id: '@your-scope/dsh-constitution', ... })
node -e "const p=require('./package.json');console.log(p.name,p.version,'private=',p.private)"

npm pack --dry-run        # 看会发哪些文件（当前 10 个 / ~19 kB）
npm publish --access public
```

发布前的硬检查：

- `private` 必须是 `false` 或不存在（本包已去掉）。
- `files` 白名单里要有 `lib/*.js`、`assets/*.md`、`locale/*.json`、`cordis.patch.yml`。
- `package.json` 里 `dsh.bundle.patch` 指向包内 `cordis.patch.yml` —— 没有它，装上了也不会出现在插件列表里。
- `dsh.client` 存在时，宿主会把 `exports["./client"]` 当作浏览器 bundle 提供；bundle 里的
  `id` 必须等于**包名**，否则启动图对不上。

## 三、发到 Git

```bash
git add -A && git commit -m "dsh-constitution 2.1.0"
git push
git rev-parse HEAD          # 记下这个 40 位 SHA，索引里要填它
```

索引里的 `source` 用 `git` 时必须给**精确 commit**（不接受分支、tag、短 SHA）。
子目录放置时用 `path`（例如 `plugins/dsh-constitution`）。

## 四、写市场索引

格式 1，一个 JSON 文件。本包附带一份可直接改的样例：
[`market/index.json`](market/index.json)。

最小可用形状：

```json
{
  "format": 1,
  "title": { "en": "My plugins", "zh": "我的插件" },
  "plugins": [
    {
      "name": "dsh-constitution",
      "title": { "en": "Standing Rules", "zh": "常驻规则" },
      "description": { "en": "…", "zh": "…" },
      "metadata": {
        "category": "prompt",
        "keywords": ["system-prompt", "persona"]
      },
      "versions": [
        {
          "version": "2.1.0",
          "publishTimestamp": 1793280000,
          "source": { "type": "npm" },
          "engines": { "dsh": ">=0.2.0" }
        }
      ]
    }
  ],
  "metadata": {
    "categories": { "prompt": { "title": { "en": "Prompt", "zh": "提示词" } } }
  }
}
```

容易被校验器拒的几条：

- `format` 必须是数字 `1`。
- `versions` 不能空；`version` 是精确 SemVer；同一个插件里不能重复。
- `publishTimestamp` 是 **Unix 秒**（不是毫秒），范围 `[0, 10^11)`。
- `metadata.category` 必须在本文件 `metadata.categories` 里声明过；`labels` / `sortKeys` 同理。
- 文本既可以是字符串，也可以是 `{ "en": "…", "zh": "…" }`；**用对象时必须含 `en`**。
- `icon` 要么是 `data:` 开头的 base64（解码后 ≤ 32 KiB），要么解析到 https 或索引同源。
- `source.type` 只有 `npm` / `git` 两种；`npm` 可带 `registry`。
- 不许出现查询串、片段、凭据写进 URL。

**用 DSH 自己的校验器验一遍**（它也是宿主读索引时跑的那段代码）：

```bash
node test/validate-market.mjs
# 或指定别的安装位置
DSH_MARKET_INDEX_MODULE=file:///path/to/@deepseek-ai/dsh-plugin-market-index/lib/index.js \
  node test/validate-market.mjs
```

## 五、托管索引

任何静态 https 都行：GitHub Pages、仓库里的 raw 文件、对象存储、内网 nginx。

```bash
# 例：放进仓库的 gh-pages 或 /docs
mkdir -p docs/dsh-market && cp market/index.json docs/dsh-market/index.json
git add docs && git commit -m "market index" && git push
# 地址就是 https://<user>.github.io/<repo>/dsh-market/index.json
```

注意：`icon` 用相对路径时会按索引 URL 解析，所以图标放同目录最省心。

## 六、让 DSH 用上这份索引

DSH 默认**没有任何索引源**（`indexes: []`），必须先加：

- 界面：设置 → 插件 → 发现 → 添加索引，填上面的 URL。
- 或 profile 层：`- id: plugin-market` 的 `config.indexes: [<url>]`。

索引 URL 会被规范化校验：http(s)、无凭据、无片段。加完之后：
发现页能看到条目 → 点安装 → `pluginManager.installBundle` 用索引给的精确 spec 装。

## 七、安装之后必须知道的一件事

`dsh.client` 声明是**按 Loader 条目缓存到宿主重启**的。所以：

- 用户第一次装上（或从旧版升上来）→ **重启一次 DSH**，浏览器启动图里才会有这一页。
- 之后改 `lib/client.js` 的内容 → HMR 就能换，不用重启。
- 改 `lib/index.js`（host 半）→ 需要重载插件（设置里关掉再打开，或重启宿主）。

## 八、2.1.0 相对 2.0.0 改了什么

发布说明里值得写清楚的四条（都是 2.0.0 的真实缺陷）：

1. **花括号不再自己转义，改用宿主原生 `interpolate: false`。**
   2.0.0 往 `{{` 里插零宽空格去躲变量解析，但三花括号 `{{{x}}}`、嵌套 `{{a{{b}}}}`
   转义后仍残留 `{{`，宿主 `renderPrompt()` 照样抛错——那个 turn 一个请求都发不出去。
   现在整段关闭变量插值，任意写法都原样通过。
2. **同一处正则的 O(n²) 消失。** 旧实现在无收尾的 `{{` 上退化，512 KiB 要 32 秒，
   而这段代码每个 step 都跑一次。现在 512 KiB 约 2 ms。
3. **剥离规则修正。** 引用块只剥**文档开头**那一段（旧版用了 `/m`，剥的是全文第一个，
   正文中间的规则会被无声删掉）；HTML 注释不再吃掉围栏代码块里的示例；CRLF 归一。
   被剥掉的内容现在会列在设置页上。
4. **HTTP 层两处。** 请求体上限按 JSON 编码后计（旧版合法大小的正文会被 413 挡掉）；
   413 会先读完请求体再返回（旧版污染 keep-alive 连接，下一个请求 ECONNRESET）；
   同源判断把 `localhost` / `127.x` / `::1` 视为同一台机器。

回归脚本：`node test/audit.mjs`（跑在真宿主模块上，把上面每条钉成断言）。

## 九、给使用者的三行说明

```text
1) 设置 → 插件 → 发现 → 添加索引 <你的 index.json URL> → 安装
2) 重启一次 DSH（新增 dsh.client 声明需要重扫）
3) 设置 → 常驻规则 → 写正文 → 保存（下一个 step 生效）
```
