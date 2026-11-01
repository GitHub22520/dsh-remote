/**
 * dsh-remote — browser half.
 *
 * Adds a "远程 DSH" entry to the sidebar panel list and a matching main panel.
 * The panel lists the remotes the host exposes under `<basePath>/<id>/`,
 * probes their reachability through the host, and embeds the chosen one in a
 * full-height iframe (same origin, so the host's own session cookie is what
 * authorizes it; the host half keeps the two DSH instances' cookies apart).
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
      body: { flex: 1, minHeight: 0, overflow: 'auto', padding: '14px' },
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
      iframe: { flex: 1, width: '100%', border: '0', background: 'transparent', minHeight: 0 },
      error: { fontSize: '12px', color: '#c9463d', whiteSpace: 'pre-wrap' },
    }

    function remoteUrl(id) {
      return `${BASE}remotes/${encodeURIComponent(id)}/`
    }

    async function fetchRemotes(signal) {
      const response = await fetch(`${BASE}remotes/_api/list`, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
      })
      if (!response.ok) throw new Error(`列出远端失败：HTTP ${response.status}`)
      const payload = await response.json()
      return Array.isArray(payload?.remotes) ? payload.remotes : []
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

    function Panel() {
      const [remotes, setRemotes] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [selected, setSelected] = React.useState(null)

      const reload = React.useCallback(() => {
        const controller = new AbortController()
        setLoading(true)
        setError(null)
        fetchRemotes(controller.signal)
          .then((entries) => {
            setRemotes(entries)
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

      const current = selected === null ? null : (remotes ?? []).find((entry) => entry.id === selected) ?? null

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
        current === null
          ? h(
              React.Fragment,
              null,
              h('button', { type: 'button', style: styles.button, onClick: reload, disabled: loading }, loading ? '检测中…' : '刷新'),
            )
          : h(
              React.Fragment,
              null,
              h('button', { type: 'button', style: styles.button, onClick: reload, disabled: loading }, loading ? '检测中…' : '刷新'),
              h(
                'a',
                { style: styles.button, href: remoteUrl(current.id), target: '_blank', rel: 'noreferrer' },
                '新标签页打开',
              ),
            ),
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
          h('p', { style: styles.hint }, '宿主没有回答远端列表。确认 dsh-remote 插件已启用，然后刷新页面。'),
        )
      } else if (remotes === null) {
        body = h('p', { style: styles.hint }, '正在读取远端列表…')
      } else if (remotes.length === 0) {
        body = h(
          'p',
          { style: styles.hint },
          '还没有配置远端。在 profile 的 cordis.patch.yml 里给 dsh-remote 加上 remotes 条目，然后在 PC 上运行 dsh-remote-agent。',
        )
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

    function apply(ctx) {
      // The same plugin also runs on the machine being reached (agent role),
      // where there is nothing to mount: only offer the panel when the host
      // actually exposes at least one remote.
      fetch(`${BASE}remotes/_api/list`, { credentials: 'same-origin', cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => {
          const entries = Array.isArray(payload?.remotes) ? payload.remotes : []
          if (entries.length === 0) {
            console.info(`${LOG_PREFIX} no remotes configured on this host; panel skipped`)
            return
          }
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: '远程 DSH' },
              RemoteIcon,
            ),
          )
          ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel))
          console.info(`${LOG_PREFIX} panel registered (${entries.length} remote(s))`)
        })
        .catch((cause) => {
          console.info(`${LOG_PREFIX} could not read the remote list: ${cause?.message ?? cause}`)
        })
    }

    return { name: 'dsh-remote', inject: ['slots'], apply }
  },
})
