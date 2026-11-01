#!/usr/bin/env node
/**
 * dsh-remote-agent — run this on the PC.
 *
 * It keeps three things alive:
 *   1. a local `dsh web` instance (bound to 127.0.0.1),
 *   2. an outbound SSH reverse tunnel that publishes that port on the server's
 *      loopback (`ssh -R 127.0.0.1:<remote-port>:127.0.0.1:<local-port>`),
 *   3. the launch token of that dsh instance, written to the server through the
 *      same SSH connection so the server-side dsh-remote plugin can mint a
 *      browser cookie for you without ever putting the token in a URL.
 *
 * Usage (`--ssh` is required; everything else has a default):
 *   node dsh-remote-agent.mjs \
 *     --ssh you@your-server \
 *     --id pc \
 *     --local-port 3081 \
 *     --remote-port 18081 \
 *     --token-path '~/.dsh/remotes/pc.token'
 *
 * Windows: `node dsh-remote-agent.mjs` works from PowerShell too; make sure
 * `ssh` (OpenSSH Client) and `dsh` are on PATH.
 *
 * This script is optional: the plugin itself can play the same role on the
 * machine being reached (config `agent:`), in which case nothing has to be
 * copied or cloned here.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'

const options = parseArgs(process.argv.slice(2))
const isWindows = process.platform === 'win32'

let dshChild = null
let sshChild = null
let shuttingDown = false
let currentToken = null
let restartTimer = null

main().catch((error) => {
  console.error(`[agent] fatal: ${error?.stack ?? error}`)
  process.exit(1)
})

async function main() {
  console.log('[agent] starting')
  console.log(`[agent]   dsh      : 127.0.0.1:${options.localPort} (DSH_HOME=${options.dshHome ?? 'default'})`)
  console.log(`[agent]   tunnel   : ${options.ssh}  -R 127.0.0.1:${options.remotePort} -> 127.0.0.1:${options.localPort}`)
  console.log(`[agent]   token    : ${options.ssh}:${options.tokenPath}`)
  console.log(`[agent]   public   : ${options.publicUrl ?? '(unset)'}`)
  startDsh()
  startTunnel()
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function startDsh() {
  if (shuttingDown) return
  const args = [
    'web',
    '--host',
    '127.0.0.1',
    '--port',
    String(options.localPort),
    '--no-open',
  ]
  if (options.publicUrl) args.push('--public-url', options.publicUrl)
  if (options.trustedHost) args.push('--trusted-host', options.trustedHost)

  console.log(`[agent] dsh ${args.join(' ')}`)
  dshChild = spawn(options.dshBin, args, {
    cwd: options.workdir,
    env: { ...process.env, ...(options.dshHome ? { DSH_HOME: options.dshHome } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWindows && options.dshBin === 'dsh',
  })

  let buffer = ''
  dshChild.stdout.setEncoding('utf8')
  dshChild.stdout.on('data', (chunk) => {
    process.stdout.write(`[dsh] ${chunk}`)
    buffer += stripAnsi(chunk)
    const match = /token=([A-Za-z0-9_-]+)/.exec(buffer)
    if (match !== null) {
      buffer = ''
      if (match[1] !== currentToken) {
        currentToken = match[1]
        console.log('[agent] captured launch token')
        void publishToken(currentToken)
      }
    }
    if (buffer.length > 8192) buffer = buffer.slice(-4096)
  })
  dshChild.stderr.setEncoding('utf8')
  dshChild.stderr.on('data', (chunk) => process.stderr.write(`[dsh] ${chunk}`))

  dshChild.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.error(`[agent] dsh exited (code=${code} signal=${signal}); restarting in ${options.restartDelayMs}ms`)
    dshChild = null
    currentToken = null
    scheduleRestart(startDsh)
  })
  dshChild.on('error', (error) => {
    console.error(`[agent] cannot start dsh: ${error?.message ?? error}`)
  })
}

function startTunnel() {
  if (shuttingDown) return
  const args = [
    '-N',
    '-T',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=20',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'StreamLocalBindUnlink=yes',
    '-R',
    `127.0.0.1:${options.remotePort}:127.0.0.1:${options.localPort}`,
    options.ssh,
  ]
  console.log(`[agent] ssh ${args.join(' ')}`)
  sshChild = spawn(options.sshBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  sshChild.stdout.setEncoding('utf8')
  sshChild.stdout.on('data', (chunk) => process.stdout.write(`[ssh] ${chunk}`))
  sshChild.stderr.setEncoding('utf8')
  sshChild.stderr.on('data', (chunk) => process.stderr.write(`[ssh] ${chunk}`))
  sshChild.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.error(`[agent] tunnel exited (code=${code} signal=${signal}); restarting in ${options.restartDelayMs}ms`)
    sshChild = null
    scheduleRestart(startTunnel)
  })
  sshChild.on('error', (error) => {
    console.error(`[agent] cannot start ssh: ${error?.message ?? error}`)
  })
}

function scheduleRestart(fn) {
  if (shuttingDown) return
  if (restartTimer !== null) return
  restartTimer = setTimeout(() => {
    restartTimer = null
    fn()
  }, options.restartDelayMs)
}

/** Push the launch token to the server through a short-lived ssh command. */
function publishToken(token) {
  return new Promise((resolve) => {
    // `~` must be expanded by the remote shell, so turn it into $HOME before quoting.
    const target = remotePath(options.tokenPath)
    const directory = remotePath(remoteDir(options.tokenPath))
    const command = `umask 077; mkdir -p "${directory}" && cat > "${target}"`
    const child = spawn(options.sshBin, [...sshBaseArgs(), options.ssh, command], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      console.error(`[agent] token publish failed: ${error?.message ?? error}`)
      resolve(false)
    })
    child.on('exit', (code) => {
      if (code === 0) {
        console.log('[agent] launch token published to the server')
        resolve(true)
      } else {
        console.error(`[agent] token publish failed (code=${code}): ${stderr.trim()}`)
        resolve(false)
      }
    })
    child.stdin.end(token)
  })
}

function sshBaseArgs() {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
}

/** Let the remote shell expand a leading `~`; everything else is used verbatim. */
function remotePath(path) {
  return path.startsWith('~/') ? `$HOME/${path.slice(2)}` : path
}

function remoteDir(path) {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '.' : path.slice(0, index)
}

function shutdown() {
  shuttingDown = true
  if (restartTimer !== null) clearTimeout(restartTimer)
  console.log('[agent] shutting down')
  for (const child of [sshChild, dshChild]) {
    try {
      child?.kill(isWindows ? undefined : 'SIGTERM')
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(0), 300)
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

function parseArgs(argv) {
  const parsed = {
    id: 'pc',
    ssh: '',
    sshBin: 'ssh',
    dshBin: 'dsh',
    localPort: 3081,
    remotePort: 18081,
    tokenPath: '~/.dsh/remotes/pc.token',
    publicUrl: undefined,
    trustedHost: undefined,
    dshHome: undefined,
    workdir: process.cwd(),
    restartDelayMs: 5000,
  }
  const flags = {
    '--id': 'id',
    '--ssh': 'ssh',
    '--ssh-bin': 'sshBin',
    '--dsh-bin': 'dshBin',
    '--local-port': 'localPort',
    '--remote-port': 'remotePort',
    '--token-path': 'tokenPath',
    '--public-url': 'publicUrl',
    '--trusted-host': 'trustedHost',
    '--dsh-home': 'dshHome',
    '--workdir': 'workdir',
    '--restart-delay': 'restartDelayMs',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--help' || flag === '-h') {
      console.log('see the header of this file for flags')
      process.exit(0)
    }
    const key = flags[flag]
    if (key === undefined) {
      console.error(`[agent] unknown flag: ${flag}`)
      process.exit(2)
    }
    const value = argv[index + 1]
    if (value === undefined) {
      console.error(`[agent] ${flag} needs a value`)
      process.exit(2)
    }
    index += 1
    parsed[key] = key === 'localPort' || key === 'remotePort' || key === 'restartDelayMs' ? Number(value) : value
  }
  if (!Number.isInteger(parsed.localPort) || !Number.isInteger(parsed.remotePort)) {
    console.error('[agent] ports must be integers')
    process.exit(2)
  }
  if (parsed.ssh === '') {
    console.error('[agent] --ssh <user@your-server> is required (that is the machine running the dsh-remote host)')
    process.exit(2)
  }
  if (parsed.tokenPath.includes('<id>')) parsed.tokenPath = parsed.tokenPath.replaceAll('<id>', parsed.id)
  return parsed
}
