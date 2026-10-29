# 常驻规则 / Standing Rules

把**一份你自己的 markdown** 渲染成 DeepSeek Harness 系统提示词的一段，并在
设置页里直接编辑它。规则因此不会在长对话里被 compaction（历史压缩）摘要掉，
保存后**下一个 step 就生效** —— 不用重启、不用开新会话。

> English: one markdown file under `DSH_HOME` is injected as a system-prompt
> section, editable from the settings page, effective on the next step.

**名字的两种口径**：界面与文档里叫 **常驻规则 / Standing Rules**；包名、正文文件名、
section 名、HTTP 挂载点仍是 `constitution` 系的技术标识（`dsh-constitution`、
`constitution.md`、`deploy:constitution`、`/plugins/dsh-constitution`）—— 它们一改就会
破坏已经装好的实例和已有的正文文件，所以不跟着展示名动。

---

## 它解决什么问题

`AGENTS.md` 的注入是 `source.kind === 'agent-instructions'` 的**普通 user 消息**。官方插件
文档原话：

> Baseline and refresh messages are ordinary sourced `user/message` events, so they
> replay, compact, and resume exactly like other history.

也就是说它会随 compaction 一起进摘要，长对话后规则细节会失真。而系统提示词里那条
user message 的信封本身还写着 "They do not override system, developer, or direct user
instructions" —— 写在 `AGENTS.md` 里的「以本文件为准」属于自赋优先级，会被信封当场否掉。

系统提示词在 surface node 0，只有首个 system node 受压缩保护。所以「每轮都必须遵守」
的东西（语言规则、人设、协作协议）只能放这一层。
## 安装

三种方式，选一个：

**A. 放进 profile 的插件目录（本地开发用）**

```text
~/.dsh/profiles/<profile>/plugins/dsh-constitution/
```

然后在 profile 的 `cordis.patch.yml` 里挂载（或让它自己作为 bundle 出现）：

```yaml
- insert:
    - id: dsh-constitution
      name: dsh-constitution
```

本包自带 `cordis.patch.yml` 并在 `package.json` 里声明 `dsh.bundle.patch`，
所以注册进 profile 的 `dsh.profile.bundles` 后会自己完成挂载。

**B. 走插件市场 / npm**

```bash
dsh plugin --profile <profile> add dsh-constitution
```

**C. 只想要注入、不想要界面**

把 `lib/index.js` 当成普通 Cordis 插件加载即可；`webServer` 缺失时插件自动降级为
纯注入（只打一条提示，不报错）。

## 用起来

1. 打开 **设置 → 常驻规则**
2. 空的时候点「恢复模板」拿一份骨架
3. 改成你自己的，`Ctrl/Cmd + S` 或点「保存」

界面上的徽章是实时的：**已注入 / 未创建 / 空段落（不注入） / 被 config.text 覆盖 / 读取失败**。
「预览注入结果」显示模型真正收到的文本 —— 文件头的 `>` 说明和 HTML 注释会被剥掉，
`{{...}}` 会**原样保留**（本段落关闭了变量插值），这些都能在预览里核对。
如果正文里有内容被剥掉，界面会单独列出来提醒你。

## 文件在哪

默认 `$DSH_HOME/constitution.md`；`DSH_HOME` 未设时是 `~/.dsh/constitution.md`。
界面顶部一直显示当前真实路径，配置改了也跟着变。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `textFile` | `$DSH_HOME/constitution.md` | 正文路径；支持 `~` |
| `text` | — | 直接覆盖文件内容（调试用；设置后界面会显示「被 config.text 覆盖」） |
| `order` | 不填 = `DEPLOYMENT_PERSONA_SUFFIX + 300` | **选填。** 这一段在系统提示词里的排序号，数字越小越靠前。宿主把所有段落按这个值升序拼接，值相同的按名字排。填一个大于宿主任何段落的数（如 `200000`）就排到最后；填 `0` 就排到最前。不填时跟随宿主 persona 之后的位置。 |
| `sectionName` | `deploy:constitution` | 段落名，出现在 `/context` 与诊断里 |
| `webRoute` | `/plugins/dsh-constitution` | 设置页的 HTTP 通道；`false` 关闭 |
| `enabled` | `true` | `false` 完全不注册 |

## 机制（为什么不用重启）

`ctx.systemPrompt.section()` 的 `text` **可以是函数**，宿主在**每个 step 装配前**调用它：

- `dsh-agent-loop` 的 `preStep()` 每步都 `await systemPrompt.assemble(...)`
- `dsh-system-prompt` 的 `assemble()` 对函数式 section 求值（`lib/index.js:388`）

所以这里注册的是 `text: () => prepare(读文件())`，配 mtime+size+ino 三键缓存：
文件没变就返回**同一个字符串**（前缀不变 → KV cache 不白烧），文件一变下一个 step
就是新内容。

这也意味着：**改正文 = 改系统提示词 = 改请求前缀**。第一次改完的那一步会付一次
cache miss 的代价，属于预期。

## 哪些内容不会送给模型

插件按三种形式剥除「写给维护者看」的内容：

1. **文档开头**的 `>` 引用块（文件头总说明）——只剥开头那一段，
   正文中间用引用块写的规则**原样保留**
2. `<!-- HTML 注释 -->`（可多行）——**围栏代码块内的不剥**，
   所以你可以在正文里贴 ` ```html <!-- 示例 --> ``` ` 这种要展示给模型的片段
3. `<!-- RENDER-ONLY:SKIP -->` … `<!-- RENDER-ONLY:END -->` 夹住的区块
   （显式标记，优先于一切，代码块里也生效）

想进提示词的内容，就别套这三种形式。

**剥离是可感知的**：设置页会列出被剥掉的片段（「有内容不会注入」），
不会让规则无声消失。

## 花括号：为什么不再转义

宿主对 `{{name}}` 是**严格**解析——未注册的变量会让整个 prompt 装配抛错，
而错误发生在 agent loop 的 step 里，**那个 turn 一个请求都发不出去**。

早期版本的做法是往 `{{` 里插零宽空格躲开解析，但：
- 只认两层 `{{...}}`，三花括号 `{{{x}}}`、嵌套 `{{a{{b}}}}` 转义后仍残留 `{{`，照样炸；
- 正则 `/\{\{[\s\S]*?\}\}/g` 在无收尾的 `{{` 上退化成 O(n²)，512 KiB 要 32 秒，
  而这段代码每个 step 都跑一次。

v2.1 改用宿主自己的开关：注册段落时带 **`interpolate: false`**，
该段落跳过变量插值，原文照发。零风险、零成本、无长度限制。
所以现在正文里写 `{{anything}}` 都会原样进入提示词。

## HTTP 接口（界面就是调这几个）

挂载点默认 `/plugins/dsh-constitution`：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/state` | 路径、是否存在、可读性、字符数、token 粗估、花括号组数、被剥片段、是否注入 |
| GET | `/assemble` | **让宿主真跑一次 `systemPrompt.assemble()`**，返回本段落在最终提示词里的实际文本、位置、以及进程 pid |
| GET | `/bundle` | 这个包的浏览器半进没进启动图（`clientModules.clientPath()`）；返回 `bundled:false` 就是要重启一次 |
| POST | `/read` | 原始正文（含 meta） |
| GET | `/template` | 随包模板 |
| POST | `/preview` | `{text}` → 真正注入的文本（含被剥片段清单） |
| POST | `/save` | `{text}` → 原子写盘 |
| POST | `/reset` | 用随包模板覆盖 |

`/assemble` 是给「到底生效没有」这个问题准备的：它调用的是 agent loop 每步用的同一个方法，
不需要模型、不需要重启，看 pid 没变而文本变了，就是热生效。

```bash
curl -s http://127.0.0.1:58433/plugins/dsh-constitution/state | jq
curl -s http://127.0.0.1:58433/plugins/dsh-constitution/assemble | jq '{pid, present, index, text}'
```

**请求体上限**：`MAX_BODY = 2 × 512 KiB + 4 KiB`。比的是 JSON 编码后的字节数，
所以留了 2 倍余量（`JSON.stringify` 会把 `\n` 写成 `\\n`，体积翻倍）；
正文本身的 512 KiB 上限由写盘层精确判定，超了返回 400 并带准确字节数。
超限的请求会**先把请求体读完再回 413**，不会污染同一条 keep-alive 连接。

**同源判断**：比较协议 + 端口 + 主机名；`localhost` / `127.x` / `::1` 视为同一台机器，
所以从 `localhost:PORT` 或 `127.0.0.1:PORT` 打开设置页都能用。真跨源返回 403。

## 已知边界

- **载体**：界面走同源 `fetch`，需要 HTTP 载体（web GUI，或桌面壳以 HTTP 暴露同一批
  路由时）。`file://` 载体会显示提示、请直接编辑文件；注入不受影响。
- **client 声明需要重启一次**：宿主按 Loader 条目缓存包元数据，新增的 `dsh.client`
  声明要等宿主重启后才进浏览器启动图。之后再改 bundle 内容是 HMR。
- **一个进程一套文件**：多实例共用 `DSH_HOME` 时它们读同一个文件；要分开就设不同的
  `DSH_HOME` 或 `textFile`。
- **`webRoute` 与浏览器半是两处**：改挂载点时，`lib/client.js` 顶部的 `MOUNT` 常量要同步改
  （手写 bundle 没有构建期常量注入）。
- **段落位置由 `order` 决定**：默认值只给一个合理的起点，具体排在哪由你按需要配。
  设置页顶部一直显示当前生效的 `order` 值。
- **不要和 `AGENTS.md` 放同样的内容**：两份副本会互相冲突，改一份忘另一份是最常见的坑。

## 发布

怎么发 npm / 发 Git / 写市场索引 / 让 DSH 用上索引，见 [PUBLISH.zh.md](PUBLISH.zh.md)。
随包带了一份可直接改的索引样例 `market/index.json`，用 DSH 自己的校验器验：

```bash
node test/validate-market.mjs
```

## 测试

```bash
node test/smoke.mjs        # 逻辑 + 路由契约（mock context）
node test/http.mjs         # 真 node:http 端到端
node test/client.mjs       # 浏览器半的加载器契约与字典一致性
node test/audit.mjs        # 边界回归（跑在真宿主模块上）
node test/validate-market.mjs
```

`smoke.mjs` / `http.mjs` / `client.mjs` 不需要起宿主；`audit.mjs` 会 import
宿主安装里的 `dsh-system-prompt`，验证「插件产出的段落真的能过宿主装配」——
它把审计中确认过的每个边界都钉成断言（花括号、代码块、CRLF、请求体上限、
连接污染、同源别名）。

## License

MIT
