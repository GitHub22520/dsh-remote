/**
 * dsh-remote — host half.
 *
 * One plugin, two roles, chosen by config:
 *  - `remotes: [...]`  → **host** role: mount other dsh instances under
 *    `<basePath>/<id>/` and serve the sidebar panel (this machine is the one
 *    you browse);
 *  - `agent: {...}`    → **agent** role: keep an `ssh -R` tunnel towards the
 *    host and publish this process's launch token there (this machine is the
 *    one being reached). No extra script, no file copying.
 *
 * Publishes one or more *other* DSH web instances (typically a PC dialing in
 * through a reverse tunnel) under this host's own HTTP path
 * `<basePath>/<id>/…`, so the local web GUI can embed them in a panel.
 *
 * Everything this file does is intentionally plain node:http:
 *  - the remote is mounted behind a prefix that this proxy strips, exactly like
 *    the prefix-stripping proxy deployment DSH already supports;
 *  - the incoming browser request must carry this host's own browser session
 *    (`ctx.connection.requestRejection`), so the mount is never public;
 *  - the upstream `Host`/`Origin` are rewritten to a loopback authority, which
 *    keeps the remote's signed cookie name distinct from this host's cookie and
 *    keeps its request-trust fence satisfied;
 *  - the remote's `Set-Cookie` never reaches the browser: the proxy keeps its
 *    own small cookie jar per remote, so the two DSH instances can share one
 *    origin without fighting over cookies;
 *  - the remote launch token (published by the PC agent into a token file) is
 *    exchanged server-side, so no token ever appears in a URL the user sees;
 *  - the remote index HTML gets a tiny inline script that namespaces
 *    localStorage/sessionStorage for this remote (both instances share one
 *    browser origin, so their UI snapshots would otherwise overwrite each
 *    other).
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';

const DEFAULT_BASE_PATH = '/remotes';
const DEFAULT_UPGRADE_PATHS = ['/api/remote.mux'];
const HTML_LIMIT_BYTES = 8 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 1500;
const HTTP_TIMEOUT_MS = 120_000;
const MAX_COOKIES = 32;
const MAX_COOKIE_VALUE = 4096;

export const name = 'dsh-remote';
export const inject = ['webServer', 'connection'];

export function apply(ctx, config = {}) {
  const basePath = normalizeBasePath(config.basePath ?? DEFAULT_BASE_PATH);
  const agent = normalizeAgent(config.agent, ctx);
  if (agent !== undefined) runAgent(ctx, agent);

  const remotes = normalizeRemotes(config, ctx);
  const byId = new Map(remotes.map((remote) => [remote.id, remote]));
  const profile = readProfile(ctx);

  // Always registered: the panel uses it both to list remotes and to explain
  // what is still missing when nothing is configured yet.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${basePath}/_api/list`,
        handler: (req, res) => handleList(ctx, req, res, remotes, agent, profile),
      }),
    `dsh-remote: ${basePath}/_api/list`,
  );

  if (remotes.length === 0) {
    ctx.logger?.info?.(
      agent === undefined
        ? 'dsh-remote: no `remotes` and no `agent` configured yet'
        : `dsh-remote: agent role only (→ ${agent.ssh}); no "remotes" to mount on this host`,
    );
    return;
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: basePath,
        handler: (req, res) => handlePrefix(ctx, req, res, basePath, byId),
      }),
    `dsh-remote: ${basePath}/*`,
  );

  for (const remote of remotes) {
    for (const upgradePath of remote.upgradePaths) {
      ctx.effect(
        () =>
          ctx.webServer.registerUpgrade({
            path: `${basePath}/${remote.id}${upgradePath}`,
            handler: (req, socket, head) => {
              handleUpgrade(ctx, req, socket, head, basePath, remote).catch(() => socket.destroy())
            },
          }),
        `dsh-remote: ${basePath}/${remote.id}${upgradePath} (upgrade)`,
      );
    }
  }

  ctx.logger?.info?.(
    `dsh-remote: mounted ${remotes.map((remote) => `${remote.id} → ${remote.targetOrigin}`).join(', ')} under ${basePath}/`,
  );
}

/* -------------------------------------------------------------------------- */
/* configuration                                                              */
/* -------------------------------------------------------------------------- */

function normalizeBasePath(value) {
  const text = String(value);
  const withSlash = text.startsWith('/') ? text : `/${text}`;
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

function normalizeAgent(raw, ctx) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const ssh = typeof raw.ssh === 'string' ? raw.ssh.trim() : '';
  if (ssh === '') {
    ctx.logger?.warn?.('dsh-remote: `agent.ssh` is required (user@host of the host machine); agent disabled');
    return undefined;
  }
  const rawId = String(raw.id ?? 'pc');
  const id = /^[A-Za-z0-9_-]+$/.test(rawId) ? rawId : 'pc';
  return {
    id,
    ssh,
    sshBin: typeof raw.sshBin === 'string' && raw.sshBin.length > 0 ? raw.sshBin : 'ssh',
    remotePort: Number.isInteger(raw.remotePort) ? raw.remotePort : 18081,
    tokenPath:
      typeof raw.tokenPath === 'string' && raw.tokenPath.length > 0
        ? raw.tokenPath
        : `~/.dsh/remotes/${id}.token`,
    extraArgs: Array.isArray(raw.extraArgs) ? raw.extraArgs.map(String) : [],
  };
}

function normalizeRemotes(config, ctx) {
  const list = Array.isArray(config.remotes) ? config.remotes : [];
  const tokenDir = typeof config.tokenDir === 'string' ? config.tokenDir : undefined;
  const out = [];
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue;
    const id = String(raw.id ?? '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      ctx.logger?.warn?.(`dsh-remote: ignoring remote with invalid id ${JSON.stringify(raw.id)}`);
      continue;
    }
    const targetText = String(raw.target ?? '');
    let target;
    try {
      target = new URL(targetText);
    } catch {
      ctx.logger?.warn?.(`dsh-remote: ignoring remote "${id}": target must be an absolute http URL`);
      continue;
    }
    if (target.protocol !== 'http:') {
      ctx.logger?.warn?.(`dsh-remote: ignoring remote "${id}": target must be http://`);
      continue;
    }
    // Default to the path the agent role publishes to: `~/.dsh/remotes/<id>.token`
    // in the host user's home. Code that runs the host as a different user than
    // the ssh login user must set tokenFile explicitly.
    const tokenFile =
      typeof raw.tokenFile === 'string' && raw.tokenFile.length > 0
        ? raw.tokenFile
        : `${(tokenDir ?? `${homedir()}/.dsh/remotes`).replace(/\/$/, '')}/${id}.token`;
    const upgradePaths = Array.isArray(raw.upgradePaths)
      ? raw.upgradePaths.map((value) => String(value)).filter((value) => value.startsWith('/'))
      : DEFAULT_UPGRADE_PATHS;
    out.push({
      id,
      label: typeof raw.label === 'string' && raw.label.length > 0 ? raw.label : id,
      target,
      targetAuthority: target.host,
      targetOrigin: target.origin,
      tokenFile,
      token: typeof raw.token === 'string' && raw.token.length > 0 ? raw.token : undefined,
      upgradePaths,
      /** @type {Map<string, string>} upstream cookies, keyed by name */
      cookies: new Map(),
      lastError: undefined,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* list API (for the client panel)                                            */
/* -------------------------------------------------------------------------- */

async function handleList(ctx, req, res, remotes, agent, profile) {
  if (reject(ctx, req, res)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  const entries = await Promise.all(
    remotes.map(async (remote) => ({
      id: remote.id,
      label: remote.label,
      online: await probe(remote),
    })),
  );
  sendJson(res, 200, {
    remotes: entries,
    agent:
      agent === undefined
        ? null
        : { id: agent.id, ssh: agent.ssh, remotePort: agent.remotePort, tokenPath: agent.tokenPath },
    profile,
  });
}

/** Facts the setup panel shows: which profile patch to edit on this machine. */
function readProfile(ctx) {
  const profile = ctx.get?.('profileContext');
  if (profile === undefined || profile === null) return { name: undefined, patchPath: undefined, home: undefined };
  return { name: profile.name, patchPath: profile.patchPath, home: profile.home };
}

function probe(remote) {
  return new Promise((resolve) => {
    const request = http.request(
      {
        host: remote.target.hostname,
        port: remote.target.port,
        path: '/',
        method: 'HEAD',
        timeout: PROBE_TIMEOUT_MS,
        headers: { host: remote.targetAuthority },
      },
      (response) => {
        response.resume();
        resolve(true);
      },
    );
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
    request.end();
  });
}

/* -------------------------------------------------------------------------- */
/* HTTP proxy                                                                 */
/* -------------------------------------------------------------------------- */

async function handlePrefix(ctx, req, res, basePath, byId) {
  if (reject(ctx, req, res)) return;

  const rawUrl = String(req.url ?? '/');
  const queryAt = rawUrl.indexOf('?');
  const pathname = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
  const search = queryAt === -1 ? '' : rawUrl.slice(queryAt);
  if (pathname.includes('\0') || pathname.split('/').includes('..')) {
    sendText(res, 400, 'invalid path');
    return;
  }
  const rest = pathname.slice(basePath.length + 1);
  const slashAt = rest.indexOf('/');
  const id = slashAt === -1 ? rest : rest.slice(0, slashAt);
  const remote = byId.get(id);
  if (remote === undefined) {
    sendText(res, 404, `unknown remote: ${id}`);
    return;
  }

  const suffix = pathname.slice(basePath.length + 1 + id.length);
  if (suffix === '') {
    // `/…/remotes/pc` → `/…/remotes/pc/` without knowing the external prefix:
    // a relative redirect resolves against the browser's own URL.
    res.writeHead(302, { location: `./${id}/`, 'cache-control': 'no-store' });
    res.end();
    return;
  }

  await proxyHttp(ctx, remote, req, res, suffix, search, 0);
}

async function proxyHttp(ctx, remote, req, res, suffix, search, attempt) {
  const isIndex = suffix === '/';
  let upstreamPath = `${suffix}${search}`;
  let minted = false;

  if (isIndex && remote.cookies.size === 0) {
    const token = await readToken(remote);
    if (token === undefined) {
      sendHtml(
        res,
        503,
        `<h1>远端 DSH 尚未就绪</h1><p>没有找到 ${escapeHtml(remote.id)} 的启动令牌${
          remote.tokenFile === undefined ? '' : `（<code>${escapeHtml(remote.tokenFile)}</code>）`
        }。请在 PC 上启动 <code>dsh-remote-agent</code>。</p>`,
      );
      return;
    }
    upstreamPath = `/?token=${encodeURIComponent(token)}`;
    minted = true;
  }

  const headers = filterRequestHeaders(req.headers);
  headers.host = remote.targetAuthority;
  if (headers.origin !== undefined) headers.origin = remote.targetOrigin;
  const cookie = cookieHeader(remote);
  if (cookie === undefined) delete headers.cookie;
  else headers.cookie = cookie;

  const upstream = http.request(
    {
      host: remote.target.hostname,
      port: remote.target.port,
      path: upstreamPath,
      method: req.method,
      headers,
      timeout: HTTP_TIMEOUT_MS,
    },
    (upstreamRes) => {
      const setCookie = upstreamRes.headers['set-cookie'];
      if (Array.isArray(setCookie)) captureCookies(remote, setCookie, ctx);
      const status = upstreamRes.statusCode ?? 502;

      // A stale jar (the remote restarted and rotated its signing secret):
      // drop it once, then let the next index load mint a fresh cookie.
      if (status === 401 && remote.cookies.size > 0 && attempt === 0) {
        upstreamRes.resume();
        remote.cookies.clear();
        if (isIndex) {
          proxyHttp(ctx, remote, req, res, suffix, search, 1).catch(() => sendText(res, 502, 'proxy error'));
        } else if (String(req.headers.accept ?? '').includes('text/html')) {
          res.writeHead(302, { location: './', 'cache-control': 'no-store' });
          res.end();
        } else {
          sendText(res, 401, 'remote session expired; reload the panel');
        }
        return;
      }

      if (minted && status === 401) {
        upstreamRes.resume();
        sendHtml(
          res,
          502,
          `<h1>远端令牌无效</h1><p>PC 上的 dsh 可能已重启。请重新启动 <code>dsh-remote-agent</code>，它会重新发布令牌。</p>`,
        );
        return;
      }

      writeUpstreamResponse(remote, req, res, upstreamRes, status);
    },
  );

  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', (error) => {
    remote.lastError = error;
    if (!res.headersSent) {
      sendHtml(
        res,
        502,
        `<h1>连不上远端 DSH</h1><p>${escapeHtml(remote.id)} → ${escapeHtml(remote.targetOrigin)}</p><pre>${escapeHtml(
          String(error?.message ?? error),
        )}</pre><p>检查 PC 上的隧道（ssh -R）是否还在。</p>`,
      );
    } else {
      res.destroy();
    }
  });

  if (req.method === 'GET' || req.method === 'HEAD' || req.readableEnded === true) upstream.end();
  else req.pipe(upstream);
}

function writeUpstreamResponse(remote, req, res, upstreamRes, status) {
  const headers = { ...upstreamRes.headers };
  delete headers['set-cookie'];
  delete headers['transfer-encoding'];
  delete headers.connection;
  delete headers['keep-alive'];
  headers['cache-control'] = headers['cache-control'] ?? 'no-store';
  headers['x-content-type-options'] = 'nosniff';
  headers['referrer-policy'] = headers['referrer-policy'] ?? 'no-referrer';

  const contentType = String(headers['content-type'] ?? '');
  const rewritable =
    req.method !== 'HEAD' &&
    headers['content-encoding'] === undefined &&
    contentType.includes('text/html') &&
    (headers['content-length'] === undefined || Number(headers['content-length']) <= HTML_LIMIT_BYTES);

  if (!rewritable) {
    res.writeHead(status, headers);
    upstreamRes.pipe(res);
    return;
  }

  const chunks = [];
  let size = 0;
  upstreamRes.on('data', (chunk) => {
    size += chunk.length;
    if (size > HTML_LIMIT_BYTES) {
      // Give up on rewriting: flush what we have as-is.
      res.writeHead(status, headers);
      for (const buffered of chunks) res.write(buffered);
      chunks.length = 0;
      upstreamRes.pipe(res);
      return;
    }
    chunks.push(chunk);
  });
  upstreamRes.on('end', () => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const html = Buffer.concat(chunks).toString('utf8');
    const injected = injectIndex(html, remote.id);
    const body = Buffer.from(injected, 'utf8');
    headers['content-length'] = String(body.length);
    res.writeHead(status, headers);
    res.end(body);
  });
  upstreamRes.on('error', () => res.destroy());
}

/* -------------------------------------------------------------------------- */
/* WebSocket / upgrade proxy                                                  */
/* -------------------------------------------------------------------------- */

async function handleUpgrade(ctx, req, socket, head, basePath, remote) {
  const rejection = ctx.connection.requestRejection(req);
  if (rejection !== undefined) {
    socket.end(`HTTP/1.1 ${rejection} Rejected\r\nconnection: close\r\n\r\n`);
    return;
  }

  const rawUrl = String(req.url ?? '/');
  const queryAt = rawUrl.indexOf('?');
  const pathname = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
  const search = queryAt === -1 ? '' : rawUrl.slice(queryAt);
  const suffix = pathname.slice(`${basePath}/${remote.id}`.length);

  // A cold jar happens after this host restarts while the browser still holds
  // the remote page (the client reconnects its socket without reloading the
  // document), so mint the remote cookie here instead of trusting the caller.
  if (remote.cookies.size === 0) {
    const minted = await mintCookie(remote, ctx);
    if (!minted) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\nno remote launch token');
      return;
    }
  }

  const headers = filterRequestHeaders(req.headers);
  headers.host = remote.targetAuthority;
  if (headers.origin !== undefined) headers.origin = remote.targetOrigin;
  const cookie = cookieHeader(remote);
  if (cookie === undefined) delete headers.cookie;
  else headers.cookie = cookie;
  headers.connection = 'Upgrade';
  headers.upgrade = 'websocket';

  const upstream = http.request({
    host: remote.target.hostname,
    port: remote.target.port,
    path: `${suffix}${search}`,
    method: 'GET',
    headers,
  });

  const fail = (message) => {
    if (!socket.destroyed) {
      socket.end(`HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-type: text/plain\r\n\r\n${message}`);
    }
  };

  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    if (socket.destroyed) {
      upstreamSocket.destroy();
      return;
    }
    const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage ?? 'Switching Protocols'}`];
    for (let index = 0; index < upstreamRes.rawHeaders.length; index += 2) {
      lines.push(`${upstreamRes.rawHeaders[index]}: ${upstreamRes.rawHeaders[index + 1]}`);
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    socket.setTimeout(0);
    upstreamSocket.setTimeout(0);
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
    const destroyBoth = () => {
      socket.destroy();
      upstreamSocket.destroy();
    };
    socket.on('error', destroyBoth);
    upstreamSocket.on('error', destroyBoth);
    socket.on('close', destroyBoth);
    upstreamSocket.on('close', destroyBoth);
  });

  upstream.on('response', (upstreamRes) => {
    ctx.logger?.warn?.(`dsh-remote: ${remote.id} refused the upgrade ${suffix} (${upstreamRes.statusCode ?? 'no status'})`)
    upstreamRes.resume();
    fail(`upstream refused the WebSocket upgrade (${upstreamRes.statusCode ?? 'no status'})`);
  });
  upstream.on('error', (error) => fail(String(error?.message ?? error)));
  upstream.end();
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function reject(ctx, req, res) {
  const rejection = ctx.connection.requestRejection(req);
  if (rejection === undefined) return false;
  res.writeHead(rejection, { 'cache-control': 'no-store' });
  res.end();
  return true;
}

/** Headers that belong to one hop, or that would let the caller spoof the hop. */
const DROPPED_REQUEST_HEADERS = new Set([
  'accept-encoding',
  'connection',
  'cookie',
  'forwarded',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'sec-websocket-extensions',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
]);

function filterRequestHeaders(incoming) {
  const headers = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    // Identity bodies only: the HTML index is rewritten here, and a compressed
    // payload would both defeat the rewrite and corrupt it.
    if (DROPPED_REQUEST_HEADERS.has(key)) continue;
    headers[key] = value;
  }
  return headers;
}

function cookieHeader(remote) {
  if (remote.cookies.size === 0) return undefined;
  return [...remote.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

function captureCookies(remote, setCookieHeaders, ctx) {
  for (const header of setCookieHeaders) {
    const first = String(header).split(';', 1)[0] ?? '';
    const equals = first.indexOf('=');
    if (equals <= 0) continue;
    const name = first.slice(0, equals).trim();
    const value = first.slice(equals + 1).trim();
    const attributes = String(header)
      .split(';')
      .slice(1)
      .map((attribute) => attribute.trim().toLowerCase());
    if (value === '' || attributes.includes('max-age=0')) {
      remote.cookies.delete(name);
      continue;
    }
    if (value.length > MAX_COOKIE_VALUE || (!remote.cookies.has(name) && remote.cookies.size >= MAX_COOKIES)) {
      ctx.logger?.warn?.(`dsh-remote: dropping oversized or excessive cookie from ${remote.id}`);
      continue;
    }
    remote.cookies.set(name, value);
  }
}

/**
 * Exchange the remote launch token for its browser cookie without a browser:
 * one `GET /?token=…` whose `Set-Cookie` is captured into the jar.
 * @returns whether the jar now holds a cookie.
 */
async function mintCookie(remote, ctx) {
  const token = await readToken(remote);
  if (token === undefined) return false;
  return new Promise((resolve) => {
    const request = http.request(
      {
        host: remote.target.hostname,
        port: remote.target.port,
        path: `/?token=${encodeURIComponent(token)}`,
        method: 'GET',
        timeout: HTTP_TIMEOUT_MS,
        headers: { host: remote.targetAuthority },
      },
      (response) => {
        response.resume();
        const setCookie = response.headers['set-cookie'];
        if (Array.isArray(setCookie)) captureCookies(remote, setCookie, ctx);
        resolve(remote.cookies.size > 0);
      },
    );
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
    request.end();
  });
}

async function readToken(remote) {
  if (remote.token !== undefined) return remote.token;
  if (remote.tokenFile === undefined) return undefined;
  try {
    const text = (await readFile(remote.tokenFile, 'utf8')).trim();
    if (text.length === 0) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

function injectIndex(html, id) {
  const script =
    `<script>(function(){try{` +
    `var p=${JSON.stringify(`dsh-remote:${id}:`)};` +
    `var proto=Storage.prototype,g=proto.getItem,s=proto.setItem,r=proto.removeItem;` +
    `proto.getItem=function(k){return g.call(this,p+String(k))};` +
    `proto.setItem=function(k,v){return s.call(this,p+String(k),v)};` +
    `proto.removeItem=function(k){return r.call(this,p+String(k))};` +
    `globalThis.__DSH_REMOTE_ID__=${JSON.stringify(id)};` +
    `}catch(e){}})()</script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head === null) return html;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${script}${html.slice(at)}`;
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text) {
  const body = Buffer.from(`${text}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  const body = Buffer.from(
    `<!doctype html><html lang="zh"><meta charset="utf-8"><title>dsh-remote</title>` +
      `<body style="font:14px/1.6 system-ui;max-width:46rem;margin:10vh auto;padding:0 1.2rem;color:#222">${html}</body></html>`,
    'utf8',
  );
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character,
  );
}

/* -------------------------------------------------------------------------- */
/* agent role: the machine being reached                                      */
/* -------------------------------------------------------------------------- */

const AGENT_RETRY_MS = 5_000;
const AGENT_PUBLISH_DELAY_MS = 1_500;
const AGENT_PUBLISH_RETRY_MS = 8_000;
const AGENT_PORT_POLL_MS = 200;

/**
 * Keep `ssh -R 127.0.0.1:<remotePort>:127.0.0.1:<localPort>` alive towards the
 * host machine and publish this process's launch token there, so the host can
 * mint browser cookies for us without any token ever reaching a browser.
 */
function runAgent(ctx, agent) {
  let tunnel;
  let retryTimer;
  let publishTimer;
  let stopped = false;

  const log = (level, message) => ctx.logger?.[level]?.(`dsh-remote(agent): ${message}`);

  const scheduleRetry = (connect) => {
    if (stopped || retryTimer !== undefined) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, AGENT_RETRY_MS);
  };

  const publishToken = () => {
    if (stopped) return;
    let token;
    try {
      token = new URL(ctx.connection.authenticatedUrl('http://127.0.0.1/')).searchParams.get('token');
    } catch {
      token = undefined;
    }
    if (token === null || token === undefined || token === '') {
      log('warn', 'could not read the launch token; the host will keep showing the remote as not ready');
      return;
    }
    const target = expandHome(agent.tokenPath);
    const directory = expandHome(remoteDir(agent.tokenPath));
    const command = `umask 077; mkdir -p "${directory}" && cat > "${target}"`;
    const child = spawn(agent.sshBin, ['-o', 'BatchMode=yes', agent.ssh, command], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => log('warn', `cannot publish the token: ${error?.message ?? error}`));
    child.on('exit', (code) => {
      if (code === 0) {
        log('info', `launch token published to ${agent.ssh}:${agent.tokenPath}`);
        return;
      }
      log('warn', `publishing the token failed (exit ${code}): ${stderr.trim()}`);
      if (stopped) return;
      setTimeout(() => publishToken(), AGENT_PUBLISH_RETRY_MS);
    });
    child.stdin.end(token);
  };

  const connect = () => {
    if (stopped) return;
    const localPort = ctx.webServer.port;
    if (localPort === undefined) {
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        connect();
      }, AGENT_PORT_POLL_MS);
      return;
    }
    const args = [
      '-N',
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=20',
      '-o',
      'ServerAliveCountMax=3',
      ...agent.extraArgs,
      '-R',
      `127.0.0.1:${agent.remotePort}:127.0.0.1:${localPort}`,
      agent.ssh,
    ];
    log('info', `tunnel up: ${agent.sshBin} ${args.join(' ')}`);
    tunnel = spawn(agent.sshBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    tunnel.stdout.setEncoding('utf8');
    tunnel.stdout.on('data', (chunk) => log('info', String(chunk).trim()));
    tunnel.stderr.setEncoding('utf8');
    tunnel.stderr.on('data', (chunk) => log('warn', String(chunk).trim()));
    tunnel.on('error', (error) => {
      log('warn', `cannot start ${agent.sshBin}: ${error?.message ?? error}`);
      scheduleRetry(connect);
    });
    tunnel.on('exit', (code) => {
      if (stopped) return;
      log('warn', `tunnel exited (${code}); retrying in ${AGENT_RETRY_MS / 1000}s`);
      tunnel = undefined;
      scheduleRetry(connect);
    });
    publishTimer = setTimeout(() => {
      publishTimer = undefined;
      publishToken();
    }, AGENT_PUBLISH_DELAY_MS);
  };

  ctx.effect(() => {
    log('info', `id "${agent.id}" → ${agent.ssh} (remote port ${agent.remotePort})`);
    connect();
    return () => {
      stopped = true;
      for (const timer of [retryTimer, publishTimer]) if (timer !== undefined) clearTimeout(timer);
      try {
        tunnel?.kill();
      } catch {
        /* already gone */
      }
    };
  }, 'dsh-remote: agent tunnel');
}

/** Let the remote shell expand a leading `~`; everything else is passed through. */
function expandHome(path) {
  return path.startsWith('~/') ? `$HOME/${path.slice(2)}` : path;
}

function remoteDir(path) {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '.' : path.slice(0, index);
}
