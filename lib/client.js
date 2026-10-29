/**
 * dsh-constitution 的浏览器半 —— 设置页里的「常驻规则 / Standing Rules」编辑器。
 *
 * 为什么手写 bundle 而不是上构建链：
 * 这个包要能直接放进 `plugins/` 目录就用（或从一个 tarball 装上），
 * 不该要求使用者装 pnpm / tsdown。bundle 格式就是 dsh-client-modules 认的
 * `window.__ModuleLoader__.load({ id, factory })`；factory 里只拿到 `require`
 * （平台共享模块表），React 等共享模块经它解析。
 *
 * 通道选择：host 半注册了 `<mount>/…` 的 HTTP 路由，这里用同源 fetch 调用。
 * 不走 `host.call` —— 那需要 Typert 生成产物；对「一个编辑器 + 几个动作」
 * 来说不值得引入代码生成。
 */

window.__ModuleLoader__.load({
  id: 'dsh-constitution',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const NS = 'constitution'
    /** 与 host 半的默认挂载点一致（config.webRoute 改动时这里也要跟着改）。 */
    const MOUNT = '/plugins/dsh-constitution'
    /** file:// 载体拿不到同源 HTTP；提前短路，别让界面一直转圈。 */
    const NO_ORIGIN = typeof location !== 'undefined' && location.protocol === 'file:'

    const zh = {
      nav: '常驻规则',
      title: '常驻规则',
      lede: '这份文本会被渲染成系统提示词的一段，长对话压缩也不会丢。保存后下一个 step 就生效，不需要重启。',
      pathLabel: '正文文件',
      templateLabel: '随包模板',
      loadFailed: '读不到宿主状态',
      modeEdit: '编辑',
      modePreview: '预览注入结果',
      save: '保存',
      reload: '重新载入',
      reset: '恢复模板',
      resetConfirm: '将用随包模板覆盖当前正文。继续？',
      saving: '保存中…',
      saved: '已保存',
      created: '已写入模板',
      empty: '正文为空',
      badgeInjected: '已注入',
      badgeMissing: '未创建',
      badgeEmpty: '空段落（不注入）',
      badgeConfig: '被 config.text 覆盖',
      badgeUnreadable: '读取失败',
      chars: '字符',
      tokens: '约 token',
      braceGroups: '花括号组',
      braceHint: '这些 {{...}} 会原样进入系统提示词（本段落已关闭变量插值），不会被当成提示词变量。',
      stripped: '有内容不会注入',
      strippedHint: '下面这些片段已被剥离，不会进入系统提示词：',
      orderLabel: 'order',
      orderHint: '这一段在系统提示词里的排序号：数字越小越靠前，宿主按它升序拼接所有段落。想排到最后就在 profile 配置里给 dsh-constitution 加 order（如 200000）；不填则跟随宿主 persona 之后。',
      nextStep: '保存即生效：宿主在每个 step 装配前重新读这个文件。',
      desktopHint: '当前载体不是 HTTP 页面（file://），界面无法直连宿主；请直接编辑上面那个路径的文件。',
      emptyHint: '还没有正文。点「恢复模板」拿一份骨架，再改成你自己的。',
      dirty: '未保存',
      previewHint: '下面是模型真正会看到的文本（已剥掉文件头说明与 HTML 注释）。',
      confirmTitle: '确认',
    }

    const en = {
      nav: 'Standing Rules',
      title: 'Standing Rules',
      lede: 'This text is rendered as a section of the system prompt, so it survives compaction. Saving takes effect on the next step — no restart.',
      pathLabel: 'File',
      templateLabel: 'Bundled template',
      loadFailed: 'Could not read host state',
      modeEdit: 'Edit',
      modePreview: 'Preview injected text',
      save: 'Save',
      reload: 'Reload',
      reset: 'Use template',
      resetConfirm: 'Overwrite the current text with the bundled template?',
      saving: 'Saving…',
      saved: 'Saved',
      created: 'Template written',
      empty: 'Empty',
      badgeInjected: 'Injected',
      badgeMissing: 'Not created',
      badgeEmpty: 'Empty section (not injected)',
      badgeConfig: 'Overridden by config.text',
      badgeUnreadable: 'Unreadable',
      chars: 'chars',
      tokens: '≈ tokens',
      braceGroups: 'brace groups',
      braceHint: 'These {{...}} reach the system prompt verbatim (this section disables variable interpolation), so they are never treated as prompt variables.',
      stripped: 'Some content is not injected',
      strippedHint: 'These fragments were stripped and do not reach the system prompt:',
      orderLabel: 'order',
      orderHint: 'Sort key of this section in the system prompt: lower numbers come first; the host concatenates every section in ascending order. Set `order` on dsh-constitution in your profile config (e.g. 200000) to push it last; leave it unset to follow the host persona.',
      nextStep: 'Saving is enough: the host re-reads this file before every step.',
      desktopHint: 'This carrier is not an HTTP page (file://), so the UI cannot reach the host. Edit the file path above directly.',
      emptyHint: 'No text yet. Use "Use template" to get a skeleton, then make it yours.',
      dirty: 'Unsaved',
      previewHint: 'This is what the model actually receives (header notes and HTML comments are stripped).',
      confirmTitle: 'Confirm',
    }

    const inject = ['slots', 'locale']

    const CSS = `
.dshcn-root{display:flex;flex-direction:column;gap:14px;min-height:0;height:100%;font:inherit}
.dshcn-head{display:flex;flex-direction:column;gap:6px}
.dshcn-titleRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dshcn-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}
.dshcn-badge{font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;border:1px solid transparent;
  color:var(--dsw-alias-label-secondary,#555);background:var(--dsw-alias-bg-layer-3,#f1f2f4)}
.dshcn-badge.ok{color:#0a7b47;background:rgba(10,123,71,.10);border-color:rgba(10,123,71,.22)}
.dshcn-badge.warn{color:#9a5b00;background:rgba(154,91,0,.10);border-color:rgba(154,91,0,.22)}
.dshcn-badge.bad{color:#a1263b;background:rgba(161,38,59,.10);border-color:rgba(161,38,59,.22)}
.dshcn-lede{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary,#666)}
.dshcn-meta{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#888);
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dshcn-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshcn-btn{font:inherit;font-size:12px;line-height:20px;padding:3px 10px;border-radius:6px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-1,#d9dbe0);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#111)}
.dshcn-btn:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,#f3f4f6)}
.dshcn-btn[disabled]{opacity:.5;cursor:default}
.dshcn-btn.primary{border-color:transparent;background:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#2b6cf6);color:#fff}
.dshcn-btn.primary:hover:not([disabled]){filter:brightness(1.06);background:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#2b6cf6)}
.dshcn-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-1,#d9dbe0);border-radius:6px;overflow:hidden}
.dshcn-seg > button{font:inherit;font-size:12px;line-height:20px;padding:3px 10px;border:none;cursor:pointer;
  background:transparent;color:var(--dsw-alias-label-secondary,#666)}
.dshcn-seg > button.on{background:var(--dsw-alias-bg-layer-3,#f1f2f4);color:var(--dsw-alias-label-primary,#111)}
.dshcn-spacer{flex:1}
.dshcn-pane{flex:1;min-height:320px;display:flex;flex-direction:column}
.dshcn-editor{flex:1;width:100%;min-height:320px;resize:vertical;box-sizing:border-box;padding:12px 14px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-1,#d9dbe0);background:var(--dsw-alias-bg-layer-2,#fff);
  color:var(--dsw-alias-label-primary,#111);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:12.5px;line-height:1.62;tab-size:2}
.dshcn-editor:focus{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color,#2b6cf6) 45%,transparent);outline-offset:-1px}
.dshcn-pre{flex:1;min-height:320px;overflow:auto;padding:12px 14px;border-radius:8px;margin:0;
  border:1px dashed var(--dsw-alias-border-1,#d9dbe0);background:var(--dsw-alias-bg-layer-1,#fafbfc);
  color:var(--dsw-alias-label-primary,#111);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.dshcn-foot{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#888)}
.dshcn-err{font-size:12px;line-height:18px;padding:6px 10px;border-radius:6px;color:#a1263b;
  background:rgba(161,38,59,.08);border:1px solid rgba(161,38,59,.2)}
.dshcn-ok{font-size:12px;line-height:18px;padding:6px 10px;border-radius:6px;color:#0a7b47;
  background:rgba(10,123,71,.08);border:1px solid rgba(10,123,71,.2)}
.dshcn-warn{font-size:12px;line-height:18px;padding:8px 10px;border-radius:6px;color:#9a5b00;
  background:rgba(154,91,0,.08);border:1px solid rgba(154,91,0,.2);display:flex;flex-direction:column;gap:6px}
.dshcn-frag{margin:0;padding:6px 8px;border-radius:4px;max-height:96px;overflow:auto;
  background:rgba(154,91,0,.06);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
`

    /** 同源调用 host 半的路由。 */
    async function api(path, body) {
      const options = body === undefined
        ? { method: 'GET', headers: { accept: 'application/json' } }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          }
      const response = await fetch(MOUNT + path, options)
      let data
      try {
        data = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok || data?.ok === false) throw new Error(data?.error ?? `HTTP ${response.status}`)
      return data
    }

    function Badge(props) {
      return h('span', { className: `dshcn-badge${props.tone ? ` ${props.tone}` : ''}` }, props.children)
    }

    function Button(props) {
      return h(
        'button',
        {
          type: 'button',
          className: `dshcn-btn${props.primary ? ' primary' : ''}`,
          disabled: props.disabled === true,
          onClick: props.onClick,
          title: props.title,
        },
        props.children,
      )
    }

    function ConstitutionSection(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const [state, setState] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [baseline, setBaseline] = React.useState('')
      const [mode, setMode] = React.useState('edit')
      const [preview, setPreview] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)

      const dirty = draft !== baseline

      const load = React.useCallback(async () => {
        if (NO_ORIGIN) return
        setBusy(true)
        setError(null)
        try {
          const read = await api('/read', {})
          setState(read.state)
          setDraft(read.text)
          setBaseline(read.text)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      const save = React.useCallback(async () => {
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const result = await api('/save', { text: draft })
          setState(result.state)
          setBaseline(draft)
          setNotice(result.bytes > 0 ? t('saved') : t('empty'))
          if (mode === 'preview') setPreview((await api('/preview', { text: draft })).text)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }, [draft, mode, t])

      const reset = React.useCallback(async () => {
        if (typeof globalThis.confirm === 'function' && globalThis.confirm(t('resetConfirm')) !== true) return
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const result = await api('/reset', {})
          setState(result.state)
          const read = await api('/read', {})
          setDraft(read.text)
          setBaseline(read.text)
          setNotice(t('created'))
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }, [t])

      const reload = React.useCallback(async () => {
        setNotice(null)
        await load()
      }, [load])

      const showPreview = React.useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
          setPreview((await api('/preview', { text: draft })).text)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }, [draft])

      const onMode = React.useCallback(
        (next) => {
          setMode(next)
          if (next === 'preview') void showPreview()
        },
        [showPreview],
      )

      const onKeyDown = React.useCallback(
        (event) => {
          if ((event.metaKey || event.ctrlKey) && (event.key === 's' || event.key === 'S')) {
            event.preventDefault()
            if (!busy && !NO_ORIGIN) void save()
          }
        },
        [busy, save],
      )

      const badge = (() => {
        if (NO_ORIGIN) return h(Badge, { tone: 'bad' }, t('loadFailed'))
        if (state === null) return h(Badge, null, busy ? '…' : t('loadFailed'))
        if (state.source === 'config') return h(Badge, { tone: 'warn' }, t('badgeConfig'))
        if (state.readError !== undefined) return h(Badge, { tone: 'bad' }, t('badgeUnreadable'))
        if (!state.exists) return h(Badge, { tone: 'warn' }, t('badgeMissing'))
        if (!state.injected) return h(Badge, { tone: 'warn' }, t('badgeEmpty'))
        return h(Badge, { tone: 'ok' }, t('badgeInjected'))
      })()

      return h(
        'div',
        { className: 'dshcn-root' },
        h(
          'div',
          { className: 'dshcn-head' },
          h(
            'div',
            { className: 'dshcn-titleRow' },
            h('span', { className: 'dshcn-title' }, t('title')),
            badge,
            dirty ? h(Badge, { tone: 'warn' }, t('dirty')) : null,
          ),
          h('div', { className: 'dshcn-lede' }, t('lede')),
          state !== null
            ? h(
                'div',
                { className: 'dshcn-meta' },
                h('span', null, `${t('pathLabel')}: ${state.path}`),
                h('span', null, `${t('chars')} ${state.chars}`),
                h('span', null, `${t('tokens')} ${state.tokens}`),
                state.braceGroups > 0
                  ? h('span', { title: t('braceHint') }, `${t('braceGroups')} ${state.braceGroups}`)
                  : null,
                h('span', { title: t('orderHint') }, `${t('orderLabel')} ${state.order}`),
              )
            : null,
        ),
        NO_ORIGIN ? h('div', { className: 'dshcn-err' }, t('desktopHint')) : null,
        error !== null ? h('div', { className: 'dshcn-err' }, error) : null,
        notice !== null && error === null ? h('div', { className: 'dshcn-ok' }, notice) : null,
        // 有内容被剥离时必须让人看见，否则用户以为写进去的规则生效了，其实没有。
        state !== null && state.strippedCount > 0
          ? h(
              'div',
              { className: 'dshcn-warn' },
              h('div', null, `${t('strippedHint')}（${state.strippedCount}）`),
              ...(state.strippedPreview ?? []).map((fragment, index) =>
                h('pre', { className: 'dshcn-frag', key: `frag-${index}` }, fragment),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dshcn-bar' },
          h(
            'div',
            { className: 'dshcn-seg' },
            h('button', { type: 'button', className: mode === 'edit' ? 'on' : '', onClick: () => onMode('edit') }, t('modeEdit')),
            h('button', { type: 'button', className: mode === 'preview' ? 'on' : '', onClick: () => onMode('preview') }, t('modePreview')),
          ),
          h('span', { className: 'dshcn-spacer' }),
          h(Button, { onClick: () => void reload(), disabled: busy || NO_ORIGIN }, t('reload')),
          h(Button, { onClick: () => void reset(), disabled: busy || NO_ORIGIN }, t('reset')),
          h(Button, { primary: true, onClick: () => void save(), disabled: busy || NO_ORIGIN }, busy ? t('saving') : t('save')),
        ),
        h(
          'div',
          { className: 'dshcn-pane' },
          mode === 'edit'
            ? h('textarea', {
                className: 'dshcn-editor',
                value: draft,
                spellCheck: false,
                placeholder: NO_ORIGIN ? '' : t('emptyHint'),
                onChange: (event) => {
                  setDraft(event.target.value)
                  setNotice(null)
                },
                onKeyDown,
              })
            : h('pre', { className: 'dshcn-preview dshcn-pre' }, preview.length > 0 ? preview : t('emptyHint')),
        ),
        h(
          'div',
          { className: 'dshcn-foot' },
          mode === 'preview' ? t('previewHint') : t('nextStep'),
          state !== null ? ` · ${t('templateLabel')}: ${state.templatePath}` : '',
        ),
      )
    }

    /** 自己插样式：常规 bundle 的 factory 只拿到 require，没有 styles builtin。 */
    function mountStyles() {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-constitution'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        try {
          tag.remove()
        } catch {
          /* 页面已经走了，不用管 */
        }
      }
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-constitution: dictionaries')
      ctx.effect(() => mountStyles(), 'dsh-constitution: styles')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-constitution',
            order: 65,
            label: () => t('nav'),
            locale: NS,
          },
          ConstitutionSection,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
