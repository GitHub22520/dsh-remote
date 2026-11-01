/**
 * dsh-remote — browser half.
 *
 * Adds a "远程 DSH" entry to the sidebar panel list and a matching main panel.
 * The panel lists the remotes this host exposes under `<basePath>/<id>/`,
 * probes their reachability, and embeds the chosen one in a full-height iframe
 * (same origin, so the host's own session cookie authorizes it; the host half
 * keeps the two DSH instances' cookies and storages apart).
 *
 * When nothing is configured yet the same panel renders the setup instructions
 * instead of disappearing, so installing the plugin always produces feedback.
 */

window.__ModuleLoader__.load({
  id: 'dsh-remote',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'dsh-remote'
    const LOG_PREFIX = '[dsh-remote]'

    /** Base URL of this page's host mount, captured before any navigation. */
    const BASE = (() => {
      try {
        return new URL('./', document.baseURI).href
      } catch {
        return '/'
      }
    })()

    const REMOTES_SNIPPET = [
      '- id: dsh-remote',
      '  config:',
      '    remotes:',
      '      - id: pc',
      '        label: 我的 PC',
      '        target: http://127.0.0.1:18081',
    ].join('\n')

    const AGENT_SNIPPET = [
      '- id: dsh-remote',
      '  config:',
      '    agent:',
      '      ssh: you@your-server',
      '      remotePort: 18081',
    ].join('\n')

    const styles = {
      panel: {
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 14px',
        borderBottom: '1px solid var(--dsh-border-color, rgba(127,127,127,.22))',
        flex: 'none',
      },
      title: { fontSize: '13px', fontWeight: 600, margin: 0 },
      spacer: { flex: 1 },
      button: {
        font: 'inherit',
        fontSize: '12px',
        padding: '4px 10px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-border-color, rgba(127,127,127,.35))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      body: { flex: 1, minHeight: 0, overflow: 'auto', padding: '14px', lineHeight: 1.7 },
      grid: { display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '12px 14px',
        borderRadius: '10px',
        border: '1px solid var(--dsh-border-color, rgba(127,127,127,.3))',
        background: 'var(--dsh-surface-color, rgba(127,127,127,.06))',
      },
      setupCard: {
        minWidth: 0,
        marginTop: '10px',
        padding: '12px 14px',
        borderRadius: '10px',
        border: '1px solid var(--dsh-border-color, rgba(127,127,127,.3))',
        background: 'var(--dsh-surface-color, rgba(127,127,127,.06))',
      },
      row: { display: 'flex', alignItems: 'center', gap: '8px' },
      name: { fontSize: '13px', fontWeight: 600 },
      meta: { fontSize: '11px', opacity: 0.62, wordBreak: 'break-all' },
      dot: (online) => ({
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        background: online === null ? '#b9a227' : online ? '#2fa84f' : '#c9463d',
        flex: 'none',
      }),
      hint: { fontSize: '12px', opacity: 0.7, lineHeight: 1.7 },
      code: {
        fontSize: '11.5px',
        lineHeight: 1.6,
        margin: '6px 0 0',
        padding: '10px 12px',
        borderRadius: '8px',
        background: 'rgba(127,127,127,.12)',
        maxWidth: '100%',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      iframe: { flex: 1, width: '100%', border: '0', background: 'transparent', minHeight: 0 },
      error: { fontSize: '12px', color: '#c9463d', whiteSpace: 'pre-wrap' },
    }

    function remoteUrl(id) {
      return `${BASE}remotes/${encodeURIComponent(id)}/`
    }

    async function fetchInfo(signal) {
      const response = await fetch(`${BASE}remotes/_api/list`, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
      })
      if (!response.ok) throw new Error(`读取插件状态失败：HTTP ${response.status}`)
      const payload = await response.json()
      return {
        remotes: Array.isArray(payload?.remotes) ? payload.remotes : [],
        agent: payload?.agent ?? null,
        profile: payload?.profile ?? null,
      }
    }

    function RemoteIcon({ size = 16, active = false }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: { opacity: active ? 1 : 0.85 },
          'aria-hidden': true,
        },
        h('rect', { x: 2.5, y: 4, width: 19, height: 12.5, rx: 2 }),
        h('path', { d: 'M8.5 20.5h7' }),
        h('path', { d: 'M12 16.5v4' }),
        h('circle', { cx: 18.2, cy: 7.6, r: 1.6, fill: 'currentColor', stroke: 'none' }),
      )
    }

    function Code({ children }) {
      return h('pre', { style: styles.code }, h('code', null, children))
    }

    const AGENT_PHASES = {
      starting: '启动中',
      connecting: '正在连接宿主机',
      ready: '已就绪（令牌已发布）',
      error: '出错',
    }

    function AgentState({ agent }) {
      const state = agent?.state
      if (state === null || state === undefined) return null
      const failed = state.phase === 'error'
      return h(
        'div',
        {
          style: {
            marginTop: '6px',
            fontSize: '12px',
            lineHeight: 1.6,
            color: failed ? '#c9463d' : 'inherit',
            opacity: failed ? 1 : 0.75,
            wordBreak: 'break-word',
          },
        },
        `本机 agent：${AGENT_PHASES[state.phase] ?? state.phase}`,
        state.detail ? ` — ${state.detail}` : '',
      )
    }

    function SetupView({ info }) {
      const patchPath = info.profile?.patchPath
      const agentConfigured = info.agent !== null && info.agent !== undefined
      return h(
        'div',
        null,
        h('h3', { style: { ...styles.title, fontSize: '14px' } }, '还没有可以挂载的远端'),
        h(
          'p',
          { style: styles.hint },
          '插件已经装上并启用了，但还没告诉它要连哪台机器 —— 安装只是把代码放进 profile，配置要单独写一条。',
          '按这台机器的角色选一种，写进下面这个文件的顶层数组末尾；如果文件里只有一行 []，把它整行替换成下面的内容。改完重启这台机器上的 dsh。',
        ),
        h(
          'p',
          { style: { ...styles.meta, margin: '6px 0 0' } },
          '配置文件：',
          h('code', null, patchPath ?? '~/.dsh/profiles/<profile>/cordis.patch.yml'),
        ),
        h(
          'div',
          { style: styles.setupCard },
          h('div', { style: styles.name }, '角色 A · 宿主机（你通过浏览器访问的这台）'),
          h('div', { style: styles.hint }, '把别的机器挂进侧边栏。'),
          h(Code, null, REMOTES_SNIPPET),
        ),
        h(
          'div',
          { style: styles.setupCard },
          h('div', { style: styles.name }, '角色 B · 被远程的机器（比如你的 PC）'),
          h(
            'div',
            { style: styles.hint },
            agentConfigured
              ? `本机已经配好了 agent → ${info.agent.ssh}（remotePort ${info.agent.remotePort}）。宿主机上还需要那条 remotes 配置。`
              : '把隧道连出去，并把本机的启动令牌发到宿主机。ssh 目标要写成 user@host，并且需要免密登录。',
          ),
          agentConfigured && info.agent.warning
            ? h('div', { style: { marginTop: '6px', fontSize: '12px', color: '#c9463d', wordBreak: 'break-word' } }, info.agent.warning)
            : null,
          agentConfigured ? h(AgentState, { agent: info.agent }) : null,
          h(Code, null, AGENT_SNIPPET),
        ),
        h(
          'p',
          { style: { ...styles.hint, marginTop: '12px' } },
          '两端都配好后，这里会出现远端卡片，点「打开」就进入对方的 dsh。',
        ),
      )
    }

    async function postConfigure(payload) {
      const response = await fetch(`${BASE}remotes/_api/configure`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const text = await response.text()
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = { error: text }
      }
      if (!response.ok) throw new Error(parsed?.error ?? `HTTP ${response.status}`)
      return parsed
    }

    const fieldStyle = {
      font: 'inherit',
      fontSize: '12.5px',
      padding: '6px 9px',
      borderRadius: '6px',
      border: '1px solid var(--dsh-border-color, rgba(127,127,127,.35))',
      background: 'transparent',
      color: 'inherit',
      width: '100%',
      boxSizing: 'border-box',
    }

    function Field({ label, hint, children }) {
      return h(
        'label',
        { style: { display: 'block', marginTop: '10px' } },
        h('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '4px' } }, label),
        children,
        hint ? h('div', { style: { ...styles.meta, marginTop: '4px' } }, hint) : null,
      )
    }

    /** One form: pick this machine's role, type the server, save. */
    function SetupForm({ info }) {
      const agent = info?.agent ?? null
      const [role, setRole] = React.useState(agent !== null ? 'agent' : 'host')
      const [ssh, setSsh] = React.useState(agent?.ssh ?? '')
      const [remotePort, setRemotePort] = React.useState(String(agent?.remotePort ?? 18081))
      const [target, setTarget] = React.useState(info?.remotes?.[0]?.target ?? 'http://127.0.0.1:18081')
      const [label, setLabel] = React.useState(info?.remotes?.[0]?.label ?? '我的 PC')
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(null)
      const [failed, setFailed] = React.useState(false)

      const save = React.useCallback(() => {
        setBusy(true)
        setFailed(false)
        setMessage('正在写入配置…')
        const payload =
          role === 'agent'
            ? { agent: { ssh: ssh.trim(), remotePort: Number(remotePort) || 18081 } }
            : { remotes: [{ id: 'pc', label: label.trim() || 'pc', target: target.trim() }] }
        postConfigure(payload)
          .then(() => {
            setMessage('已保存，插件正在重载，页面将在 3 秒后刷新')
            setTimeout(() => {
              try {
                location.reload()
              } catch {
                /* ignore */
              }
            }, 3000)
          })
          .catch((cause) => {
            setFailed(true)
            setMessage(String(cause?.message ?? cause))
            setBusy(false)
          })
      }, [role, ssh, remotePort, target, label])

      const radio = (value, text, hint) =>
        h(
          'label',
          {
            style: {
              display: 'flex',
              gap: '8px',
              alignItems: 'flex-start',
              padding: '8px 10px',
              marginTop: '6px',
              borderRadius: '8px',
              border: `1px solid ${role === value ? 'var(--dsh-accent-color, #4c7dff)' : 'var(--dsh-border-color, rgba(127,127,127,.3))'}`,
              cursor: 'pointer',
            },
          },
          h('input', {
            type: 'radio',
            name: 'dsh-remote-role',
            checked: role === value,
            onChange: () => setRole(value),
            style: { marginTop: '3px' },
          }),
          h(
            'span',
            null,
            h('div', { style: { fontSize: '12.5px', fontWeight: 600 } }, text),
            h('div', { style: { ...styles.meta, marginTop: '2px' } }, hint),
          ),
        )

      return h(
        'div',
        null,
        h('h3', { style: { ...styles.title, fontSize: '14px', margin: 0 } }, 'dsh-remote 配置'),
        h(
          'p',
          { style: { ...styles.hint, marginTop: '6px' } },
          '填一次就行：保存后插件会把配置写进当前 profile 并自动重载，不需要手动改文件或开终端。',
        ),
        radio('agent', '这台机器是被远程的一方', '例如你的 PC：插件会主动连到宿主机，把本机发布过去'),
        radio('host', '这台机器是宿主机', '你通过浏览器访问的那台：把别的机器挂进侧边栏'),
        role === 'agent'
          ? h(
              React.Fragment,
              null,
              h(
                Field,
                { label: '服务器地址', hint: '宿主机上能免密 SSH 登录的账号，形如 user@your-server' },
                h('input', {
                  style: fieldStyle,
                  value: ssh,
                  placeholder: 'ubuntu@your-server',
                  onChange: (event) => setSsh(event.target.value),
                  spellCheck: false,
                }),
              ),
              h(
                Field,
                { label: '远端端口', hint: '宿主机回环上发布的端口，和那里 remotes[].target 的端口一致' },
                h('input', {
                  style: fieldStyle,
                  value: remotePort,
                  inputMode: 'numeric',
                  onChange: (event) => setRemotePort(event.target.value),
                }),
              ),
            )
          : h(
              React.Fragment,
              null,
              h(
                Field,
                { label: '远端地址', hint: '宿主机回环上那条隧道的地址' },
                h('input', {
                  style: fieldStyle,
                  value: target,
                  placeholder: 'http://127.0.0.1:18081',
                  onChange: (event) => setTarget(event.target.value),
                  spellCheck: false,
                }),
              ),
              h(
                Field,
                { label: '显示名', hint: '侧边栏面板里显示的名字' },
                h('input', {
                  style: fieldStyle,
                  value: label,
                  onChange: (event) => setLabel(event.target.value),
                }),
              ),
            ),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '14px' } },
          h(
            'button',
            { type: 'button', style: styles.button, disabled: busy, onClick: save },
            busy ? '保存中…' : '保存并应用',
          ),
          message
            ? h(
                'span',
                { style: { fontSize: '12px', color: failed ? '#c9463d' : 'inherit', opacity: failed ? 1 : 0.75 } },
                message,
              )
            : null,
        ),
      )
    }

    function AgentView({ agent }) {
      return h(
        'div',
        null,
        h('h3', { style: { ...styles.title, fontSize: '14px' } }, '这台机器是「被远程」的一方'),
        h(
          'p',
          { style: styles.hint },
          '插件已经把本机的 dsh 通过 SSH 反向隧道发布到宿主机了。到宿主机（运行 dsh-remote「宿主机」角色的那台）打开 dsh，',
          '在侧边栏「远程 DSH」里点「打开」就能进入这台机器的界面。',
        ),
        h(AgentState, { agent }),
        agent.warning ? h('div', { style: { marginTop: '6px', fontSize: '12px', color: '#c9463d' } }, agent.warning) : null,
        h(
          'div',
          { style: { ...styles.setupCard, marginTop: '12px' } },
          h('div', { style: styles.name }, '本机 agent 配置'),
          h('div', { style: { ...styles.meta, marginTop: '6px' } }, `ssh: ${agent.ssh}`),
          h('div', { style: styles.meta }, `远端端口: ${agent.remotePort}`),
          h('div', { style: styles.meta }, `令牌路径: ${agent.tokenPath}`),
        ),
        h(
          'p',
          { style: { ...styles.hint, marginTop: '12px' } },
          '如果反过来也想在这台机器上挂别的 dsh，再往同一个配置文件里补一条 remotes 配置，重启后这里就会出现远端列表。',
        ),
      )
    }

    function Panel() {
      const [info, setInfo] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [selected, setSelected] = React.useState(null)

      const reload = React.useCallback(() => {
        const controller = new AbortController()
        setLoading(true)
        setError(null)
        fetchInfo(controller.signal)
          .then((payload) => {
            setInfo(payload)
            setLoading(false)
          })
          .catch((cause) => {
            if (controller.signal.aborted) return
            setLoading(false)
            setError(String(cause?.message ?? cause))
          })
        return () => controller.abort()
      }, [])

      React.useEffect(() => reload(), [reload])

      const remotes = info?.remotes ?? []
      const current = selected === null ? null : remotes.find((entry) => entry.id === selected) ?? null

      const header = h(
        'div',
        { style: styles.header },
        current === null
          ? h('h2', { style: styles.title }, '远程 DSH')
          : h(
              React.Fragment,
              null,
              h('button', { type: 'button', style: styles.button, onClick: () => setSelected(null) }, '← 列表'),
              h('span', { style: styles.name }, current.label ?? current.id),
              h('span', { style: { ...styles.meta, opacity: 0.5 } }, remoteUrl(current.id)),
            ),
        h('span', { style: styles.spacer }),
        h('button', { type: 'button', style: styles.button, onClick: reload, disabled: loading }, loading ? '检测中…' : '刷新'),
        current === null
          ? null
          : h('a', { style: styles.button, href: remoteUrl(current.id), target: '_blank', rel: 'noreferrer' }, '新标签页打开'),
      )

      if (current !== null) {
        return h(
          'div',
          { style: styles.panel },
          header,
          h('iframe', {
            style: styles.iframe,
            src: remoteUrl(current.id),
            title: `remote dsh: ${current.label ?? current.id}`,
            allow: 'clipboard-read; clipboard-write',
          }),
        )
      }

      let body
      if (error !== null) {
        body = h(
          'div',
          null,
          h('div', { style: styles.error }, error),
          h('p', { style: styles.hint }, '宿主没有回答插件状态。确认 dsh-remote 已启用，然后刷新页面。'),
        )
      } else if (info === null) {
        body = h('p', { style: styles.hint }, '正在读取状态…')
      } else if (remotes.length === 0 && info.agent !== null && info.agent !== undefined) {
        body = h(AgentView, { agent: info.agent })
      } else if (remotes.length === 0) {
        body = h(SetupView, { info })
      } else {
        body = h(
          'div',
          { style: styles.grid },
          ...remotes.map((entry) =>
            h(
              'div',
              { key: entry.id, style: styles.card },
              h(
                'div',
                { style: styles.row },
                h('span', { style: styles.dot(entry.online) }),
                h('span', { style: styles.name }, entry.label ?? entry.id),
                h('span', { style: { ...styles.meta, marginLeft: 'auto' } }, entry.online ? '在线' : '离线'),
              ),
              h('div', { style: styles.meta }, entry.id),
              h(
                'div',
                { style: { ...styles.row, marginTop: '4px' } },
                h(
                  'button',
                  {
                    type: 'button',
                    style: styles.button,
                    disabled: !entry.online,
                    onClick: () => setSelected(entry.id),
                  },
                  entry.online ? '打开' : '不可用',
                ),
                h('a', { style: styles.button, href: remoteUrl(entry.id), target: '_blank', rel: 'noreferrer' }, '新标签页'),
              ),
            ),
          ),
        )
      }

      return h(
        'div',
        { style: styles.panel },
        header,
        h('div', { style: styles.body }, body),
      )
    }

    function BundleConfigCard() {
      const [info, setInfo] = React.useState(null)
      const [error, setError] = React.useState(null)

      React.useEffect(() => {
        const controller = new AbortController()
        fetchInfo(controller.signal)
          .then(setInfo)
          .catch((cause) => {
            if (!controller.signal.aborted) setError(String(cause?.message ?? cause))
          })
        return () => controller.abort()
      }, [])

      if (error !== null) {
        return h('div', { style: styles.setupCard }, h('div', { style: styles.error }, error))
      }
      if (info === null) {
        return h('div', { style: styles.setupCard }, h('div', { style: styles.hint }, '正在读取状态…'))
      }
      return h(
        'div',
        { style: styles.setupCard },
        h(SetupForm, { info }),
        info.agent ? h(AgentState, { agent: info.agent }) : null,
        info.remotes?.length
          ? h(
              'div',
              { style: { ...styles.meta, marginTop: '10px' } },
              `当前已挂载：${info.remotes.map((entry) => `${entry.label ?? entry.id}${entry.online ? '（在线）' : '（离线）'}`).join('、')}`,
            )
          : null,
      )
    }

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: '远程 DSH' }, RemoteIcon),
      )
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel))
      // Also surface the form on this bundle's own page in the plugin manager,
      // so setup is reachable without knowing about the sidebar panel.
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-remote' }, BundleConfigCard),
      )
      console.info(`${LOG_PREFIX} panel registered`)
    }

    return { name: 'dsh-remote', inject: ['slots'], apply }
  },
})
