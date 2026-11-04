#!/usr/bin/env node
// AgentStudio local stack manager. Dependency-free Node ESM.
//
//   node dev/stack.mjs up                 start everything (idempotent)
//   node dev/stack.mjs down               stop everything
//   node dev/stack.mjs status             print the status table
//   node dev/stack.mjs reset              down + delete .local/
//   node dev/stack.mjs restart <service>  rebuild (Go) and restart one service
//   node dev/stack.mjs logs <service>     tail -f one service's log
//   node dev/stack.mjs env                print .local/env (secrets included!)
//
// Services: postgres, synapse, concierge, adapters, a2a-echo, api, demo, agents. See dev/README.md.

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL = path.join(ROOT, '.local')
const DIRS = {
  run: path.join(LOCAL, 'run'),
  logs: path.join(LOCAL, 'logs'),
  bin: path.join(LOCAL, 'bin'),
  pg: path.join(LOCAL, 'pg'),
  synapse: path.join(LOCAL, 'synapse'),
  venv: path.join(LOCAL, 'synapse-venv'),
  bridges: path.join(LOCAL, 'bridges'),
}
const ENV_FILE = path.join(LOCAL, 'env')
const CONFIG = path.join(ROOT, 'dev', 'config')
const SERVER = path.join(ROOT, 'server')

const PG_PORT = 54329
const SYNAPSE_VERSION = '1.164.1'
const SYNAPSE_PYTHON = '3.12'
const DATABASES = ['synapse', 'agentstudio', 'bridge_demo', 'bridge_agents']
// Go build tags: no E2EE in v0.1, so mautrix is built without libolm.
const GO_TAGS = 'nocrypto'

// Secrets are generated once and kept across runs (until dev:reset).
export const SECRET_KEYS = [
  'AGENTSTUDIO_TOKEN_SECRET',
  'AGENTSTUDIO_INTERNAL_SECRET',
  'SYNAPSE_JWT_SECRET',
  'SYNAPSE_REGISTRATION_SECRET',
  'SYNAPSE_MACAROON_SECRET',
  'SYNAPSE_FORM_SECRET',
  'DEMO_AS_TOKEN',
  'DEMO_HS_TOKEN',
  'AGENTS_AS_TOKEN',
  'AGENTS_HS_TOKEN',
  'DEMO_PROVISION_SECRET',
  'AGENTS_PROVISION_SECRET',
]

// Constants are rewritten on every run so template/port changes propagate.
const pgURL = (db) => `postgres://agentstudio@127.0.0.1:${PG_PORT}/${db}?sslmode=disable`
export const CONSTANTS = {
  AGENTSTUDIO_DEV: '1',
  // Local mode: the stack serves the person on this Mac; the desktop app signs in without email.
  AGENTSTUDIO_LOCAL: '1',
  AGENTSTUDIO_LOCAL_DIR: LOCAL,
  MATRIX_SERVER_NAME: 'agentstudio.local',
  PG_PORT: String(PG_PORT),
  SYNAPSE_PORT: '18008',
  SYNAPSE_URL: 'http://127.0.0.1:18008',
  AGENTSTUDIO_API_ADDR: '127.0.0.1:18090',
  AGENTSTUDIO_SERVER_URL: 'http://127.0.0.1:18090',
  DEMO_BRIDGE_URL: 'http://127.0.0.1:18101',
  AGENTS_BRIDGE_URL: 'http://127.0.0.1:18102',
  CONCIERGE_ADDR: '127.0.0.1:18201',
  AGENTSTUDIO_CONCIERGE_URL: 'http://127.0.0.1:18201',
  MOBILE_WEB_URL: 'http://127.0.0.1:18300',
  AGENTSTUDIO_DATABASE_URL: pgURL('agentstudio'),
  BRIDGE_DEMO_DATABASE_URL: pgURL('bridge_demo'),
  BRIDGE_AGENTS_DATABASE_URL: pgURL('bridge_agents'),
  ADAPTERS_ADDR: '127.0.0.1:18202',
  AGENT_ADAPTERS_URL: 'http://127.0.0.1:18202',
  A2A_ECHO_ADDR: '127.0.0.1:18203',
  A2A_ECHO_URL: 'http://127.0.0.1:18203',
  AGENTSTUDIO_ACP_WORKDIR: path.join(LOCAL, 'acp'),
  // Dev only: the ACP agents users may run. The echo agent is built with the adapters.
  AGENTSTUDIO_ACP_AGENTS: JSON.stringify([
    { id: 'acp-echo', name: 'ACP Echo', description: 'A tiny ACP test agent.', command: path.join(DIRS.bin, 'agentstudio-dev-acp-echo') },
  ]),
  SYNAPSE_DATABASE_URL: pgURL('synapse'),
}

// ---------------------------------------------------------------------------
// Service table. Start order matters (dependencies first).

const goService = (name, binary, health, port, args = [], extraBinaries = []) => ({
  name,
  kind: 'go',
  binary,
  port,
  health,
  args,
  extraBinaries,
  timeoutMs: 60_000,
})

const SERVICES = [
  { name: 'postgres', kind: 'postgres', port: PG_PORT, timeoutMs: 30_000 },
  {
    name: 'synapse',
    kind: 'synapse',
    port: 18008,
    health: 'http://127.0.0.1:18008/_matrix/client/versions',
    timeoutMs: 120_000,
  },
  goService('concierge', 'agentstudio-agent-concierge', 'http://127.0.0.1:18201/health', 18201),
  goService('adapters', 'agentstudio-agent-adapters', 'http://127.0.0.1:18202/health', 18202, [], ['agentstudio-dev-acp-echo']),
  goService('a2a-echo', 'agentstudio-dev-a2a-echo', 'http://127.0.0.1:18203/health', 18203),
  goService('api', 'agentstudio-api', 'http://127.0.0.1:18090/healthz', 18090),
  goService('demo', 'agentstudio-bridge-demo', 'http://127.0.0.1:18101/_matrix/mau/live', 18101, [
    '-n',
    '-c',
    path.join(DIRS.bridges, 'demo.yaml'),
    '-r',
    path.join(DIRS.synapse, 'registration-demo.yaml'),
  ]),
  goService('agents', 'agentstudio-bridge-agents', 'http://127.0.0.1:18102/_matrix/mau/live', 18102, [
    '-n',
    '-c',
    path.join(DIRS.bridges, 'agents.yaml'),
    '-r',
    path.join(DIRS.synapse, 'registration-agents.yaml'),
  ]),
]

const ALIASES = {
  pg: 'postgres',
  'agentstudio-api': 'api',
  'agentstudio-agent-concierge': 'concierge',
  'agentstudio-agent-adapters': 'adapters',
  'agentstudio-dev-a2a-echo': 'a2a-echo',
  'agentstudio-bridge-demo': 'demo',
  'bridge-demo': 'demo',
  'agentstudio-bridge-agents': 'agents',
  'bridge-agents': 'agents',
}

function findService(name) {
  const svc = SERVICES.find((s) => s.name === (ALIASES[name] ?? name))
  if (!svc) die(`unknown service "${name}". Known: ${SERVICES.map((s) => s.name).join(', ')}`)
  return svc
}

// ---------------------------------------------------------------------------
// Small helpers.

const isTTY = process.stdout.isTTY
const c = (code) => (s) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : String(s))
const green = c(32)
const red = c(31)
const yellow = c(33)
const dim = c(2)

function log(msg) {
  console.log(`${dim('[stack]')} ${msg}`)
}

function die(msg) {
  console.error(red(`[stack] ${msg}`))
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function ensureDirs() {
  for (const d of [LOCAL, DIRS.run, DIRS.logs, DIRS.bin, DIRS.synapse, DIRS.bridges]) {
    fs.mkdirSync(d, { recursive: true })
  }
}

// Runs a command synchronously. Throws with captured output on failure.
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', env: opts.env ?? process.env, cwd: opts.cwd ?? ROOT })
  if (res.error) throw new Error(`${cmd}: ${res.error.message}`)
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}\n${res.stdout ?? ''}${res.stderr ?? ''}`)
  }
  return res
}

function which(cmd) {
  return run('/usr/bin/which', [cmd], { allowFail: true }).status === 0
}

// ---------------------------------------------------------------------------
// .local/env

function parseEnvFile(file) {
  const out = {}
  if (!fs.existsSync(file)) return out
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

function loadEnv() {
  ensureDirs()
  const existing = parseEnvFile(ENV_FILE)
  const env = { ...CONSTANTS }
  let generated = 0
  for (const key of SECRET_KEYS) {
    if (existing[key]) {
      env[key] = existing[key]
    } else {
      env[key] = randomBytes(32).toString('hex')
      generated++
    }
  }
  const body = [
    '# Generated by dev/stack.mjs. Secrets are kept until `pnpm dev:reset`; constants are rewritten on each run.',
    '# Load into a shell with: set -a; . .local/env; set +a',
    ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
    '',
  ].join('\n')
  if (generated > 0 || !fs.existsSync(ENV_FILE) || fs.readFileSync(ENV_FILE, 'utf8') !== body) {
    fs.writeFileSync(ENV_FILE, body, { mode: 0o600 })
  }
  if (generated > 0) log(`generated ${generated} secrets in .local/env`)
  return env
}

function processEnv(env) {
  return { ...process.env, ...env }
}

// ---------------------------------------------------------------------------
// Templates. Placeholders look like ${NAME}; unknown names are an error.

export function renderText(tmpl, vars, templateName = 'template') {
  return tmpl.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    if (!(name in vars)) throw new Error(`${templateName}: unknown placeholder \${${name}}`)
    return vars[name]
  })
}

function render(templateName, outFile, vars) {
  const out = renderText(fs.readFileSync(path.join(CONFIG, templateName), 'utf8'), vars, templateName)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, out, { mode: 0o600 })
}

// All variables available to templates: .local/env plus computed paths.
export const templateVars = (env) => ({ ...env, LOCAL_DIR: LOCAL, SYNAPSE_DIR: DIRS.synapse })

function renderConfigs(env) {
  const vars = templateVars(env)
  render('homeserver.yaml.tmpl', path.join(DIRS.synapse, 'homeserver.yaml'), vars)
  render('registration-demo.yaml.tmpl', path.join(DIRS.synapse, 'registration-demo.yaml'), vars)
  render('registration-agents.yaml.tmpl', path.join(DIRS.synapse, 'registration-agents.yaml'), vars)
  render('bridge-demo.yaml.tmpl', path.join(DIRS.bridges, 'demo.yaml'), vars)
  render('bridge-agents.yaml.tmpl', path.join(DIRS.bridges, 'agents.yaml'), vars)
}

// ---------------------------------------------------------------------------
// Process bookkeeping.

const pidFile = (svc) => path.join(DIRS.run, `${svc.name}.pid`)
const logFile = (svc) => path.join(DIRS.logs, `${svc.name}.log`)

function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

function readPid(svc) {
  const file = svc.kind === 'postgres' ? path.join(DIRS.pg, 'postmaster.pid') : pidFile(svc)
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').split('\n')[0], 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

async function httpOK(url, timeoutMs = 2000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    await res.arrayBuffer()
    return res.ok
  } catch {
    return false
  }
}

async function healthy(svc) {
  if (svc.kind === 'postgres') {
    if (!fs.existsSync(path.join(DIRS.pg, 'PG_VERSION'))) return false
    return run('pg_isready', ['-q', '-h', '127.0.0.1', '-p', String(PG_PORT)], { allowFail: true }).status === 0
  }
  return httpOK(svc.health)
}

async function waitHealthy(svc, pid) {
  const deadline = Date.now() + svc.timeoutMs
  while (Date.now() < deadline) {
    if (await healthy(svc)) return true
    if (pid && !alive(pid)) return false
    await sleep(250)
  }
  return false
}

function tailLog(svc, lines = 25) {
  try {
    const all = fs.readFileSync(logFile(svc), 'utf8').trimEnd().split('\n')
    return all.slice(-lines).join('\n')
  } catch {
    return '(no log)'
  }
}

// Starts a detached process with stdout/stderr appended to its log file.
function spawnDetached(svc, cmd, args, env, cwd = ROOT) {
  const fd = fs.openSync(logFile(svc), 'a')
  fs.writeSync(fd, `\n===== [stack] ${new Date().toISOString()} starting ${svc.name}: ${path.basename(cmd)} ${args.join(' ')}\n`)
  const child = spawn(cmd, args, { cwd, env: processEnv(env), detached: true, stdio: ['ignore', fd, fd] })
  child.unref()
  fs.closeSync(fd)
  fs.writeFileSync(pidFile(svc), `${child.pid}\n`)
  return child.pid
}

async function killPid(pid, graceMs = 10_000) {
  if (!alive(pid)) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {}
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && alive(pid)) await sleep(100)
  if (alive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
    await sleep(100)
  }
}

// ---------------------------------------------------------------------------
// Postgres.

function pgSetup() {
  if (!which('initdb') || !which('pg_ctl')) die('PostgreSQL binaries not found on PATH (brew install postgresql@18)')
  if (!fs.existsSync(path.join(DIRS.pg, 'PG_VERSION'))) {
    log('initializing Postgres cluster in .local/pg')
    fs.rmSync(DIRS.pg, { recursive: true, force: true })
    run('initdb', ['-D', DIRS.pg, '-U', 'agentstudio', '--auth=trust', '-E', 'UTF8', '--locale=C'], {
      env: { ...process.env, LC_ALL: 'C' },
    })
  }
  // Our settings live in a separate file included from postgresql.conf.
  const conf = [
    `listen_addresses = '127.0.0.1'`,
    `port = ${PG_PORT}`,
    `unix_socket_directories = '${DIRS.run}'`,
    `max_connections = 200`,
    `fsync = off`, // dev only: much faster, data loss on OS crash is acceptable
    `synchronous_commit = off`,
    `full_page_writes = off`,
    '',
  ].join('\n')
  fs.writeFileSync(path.join(DIRS.pg, 'agentstudio.conf'), conf)
  const mainConf = path.join(DIRS.pg, 'postgresql.conf')
  const text = fs.readFileSync(mainConf, 'utf8')
  if (!text.includes(`include_if_exists = 'agentstudio.conf'`)) {
    fs.appendFileSync(mainConf, `\ninclude_if_exists = 'agentstudio.conf'\n`)
  }
}

async function pgStart(svc) {
  pgSetup()
  const stalePid = readPid(svc)
  if (stalePid && !alive(stalePid)) fs.rmSync(path.join(DIRS.pg, 'postmaster.pid'), { force: true })
  // macOS: postgres refuses to start ("postmaster became multithreaded") without a valid locale env.
  run('pg_ctl', ['-D', DIRS.pg, '-l', logFile(svc), '-w', '-t', '30', 'start'], { env: { ...process.env, LC_ALL: 'C' } })
}

function pgCreateDatabases() {
  const psql = (sql) =>
    run('psql', ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'agentstudio', '-d', 'postgres', '-tAc', sql]).stdout.trim()
  for (const db of DATABASES) {
    if (psql(`SELECT 1 FROM pg_database WHERE datname = '${db}'`) === '1') continue
    log(`creating database ${db}`)
    // Synapse requires C collation; the cluster is already C, template0 makes it explicit.
    psql(`CREATE DATABASE ${db} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`)
  }
}

function pgStop() {
  if (!fs.existsSync(path.join(DIRS.pg, 'PG_VERSION'))) return
  const pid = readPid({ kind: 'postgres' })
  if (!pid || !alive(pid)) return
  run('pg_ctl', ['-D', DIRS.pg, '-m', 'fast', '-w', 'stop'], { allowFail: true })
}

// ---------------------------------------------------------------------------
// Synapse.

const VENV_PY = path.join(DIRS.venv, 'bin', 'python')
const VENV_STAMP = path.join(DIRS.venv, '.agentstudio-installed')

function synapseSetup() {
  const want = `matrix-synapse[postgres,jwt]==${SYNAPSE_VERSION}`
  const stamp = fs.existsSync(VENV_STAMP) ? fs.readFileSync(VENV_STAMP, 'utf8').trim() : ''
  if (stamp !== want || !fs.existsSync(VENV_PY)) {
    if (!which('uv')) die('uv not found on PATH (brew install uv)')
    log(`installing ${want} into .local/synapse-venv (first run takes a minute)`)
    if (!fs.existsSync(VENV_PY)) run('uv', ['venv', '--python', SYNAPSE_PYTHON, DIRS.venv])
    run('uv', ['pip', 'install', '--python', VENV_PY, want])
    fs.writeFileSync(VENV_STAMP, `${want}\n`)
  }
  const key = path.join(DIRS.synapse, 'signing.key')
  if (!fs.existsSync(key)) {
    log('generating Synapse signing key')
    run(path.join(DIRS.venv, 'bin', 'generate_signing_key'), ['-o', key])
  }
  fs.mkdirSync(path.join(DIRS.synapse, 'media_store'), { recursive: true })
}

// ---------------------------------------------------------------------------
// Go services.

// Builds one Go binary. Returns true on success; on failure prints the error and
// returns false (another engineer may be mid-change), so the rest can still start.
function goBuild(svc) {
  for (const binary of [svc.binary, ...(svc.extraBinaries ?? [])]) {
    const out = path.join(DIRS.bin, binary)
    const res = run('go', ['build', '-tags', GO_TAGS, '-o', out, `./cmd/${binary}`], {
      cwd: SERVER,
      allowFail: true,
    })
    if (res.status !== 0) {
      console.error(red(`[stack] build of ${binary} failed:`))
      console.error((res.stdout ?? '') + (res.stderr ?? ''))
      return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Start / stop one service.

async function startService(svc, env, { rebuild = true } = {}) {
  switch (svc.kind) {
    case 'postgres':
      await pgStart(svc)
      break
    case 'synapse':
      synapseSetup()
      spawnDetached(svc, VENV_PY, ['-m', 'synapse.app.homeserver', '-c', path.join(DIRS.synapse, 'homeserver.yaml')], env, DIRS.synapse)
      break
    case 'go': {
      const bin = path.join(DIRS.bin, svc.binary)
      const built = rebuild ? goBuild(svc) : fs.existsSync(bin)
      if (!fs.existsSync(bin)) {
        console.error(red(`[stack] ${svc.name}: no binary, not starting`))
        return false
      }
      if (!built) console.error(yellow(`[stack] ${svc.name}: starting the previous binary`))
      spawnDetached(svc, bin, svc.args, env)
      break
    }
  }
  const ok = await waitHealthy(svc, readPid(svc))
  if (!ok) {
    console.error(red(`[stack] ${svc.name} did not become healthy. Last log lines (${path.relative(ROOT, logFile(svc))}):`))
    console.error(tailLog(svc))
    return false
  }
  if (svc.kind === 'postgres') pgCreateDatabases()
  return true
}

async function stopService(svc) {
  if (svc.kind === 'postgres') {
    pgStop()
    return
  }
  const pid = readPid(svc)
  if (pid) await killPid(pid)
  fs.rmSync(pidFile(svc), { force: true })
}

// ---------------------------------------------------------------------------
// Commands.

async function cmdUp() {
  const env = loadEnv()
  renderConfigs(env)
  let failed = 0
  for (const svc of SERVICES) {
    const pid = readPid(svc)
    if (await healthy(svc)) {
      if (svc.kind === 'postgres') pgCreateDatabases()
      if (!pid || !alive(pid)) console.error(yellow(`[stack] ${svc.name} is healthy but not managed by this stack (no live pid file)`))
      continue
    }
    if (pid && alive(pid)) {
      // Running but not (yet) healthy: give it its normal startup time before restarting.
      log(`${svc.name} is running but not healthy, waiting`)
      if (await waitHealthy(svc, pid)) continue
      log(`restarting ${svc.name}`)
      await stopService(svc)
    }
    log(`starting ${svc.name}`)
    if (!(await startService(svc, env))) failed++
  }
  await cmdStatus()
  if (failed > 0) {
    console.error(red(`[stack] ${failed} service(s) failed to start`))
    process.exitCode = 1
  }
}

async function cmdDown() {
  for (const svc of [...SERVICES].reverse()) {
    const pid = readPid(svc)
    if (pid && alive(pid)) log(`stopping ${svc.name}`)
    await stopService(svc)
  }
  log('stopped')
}

async function cmdRestart(name) {
  if (!name) die('usage: dev:restart <service>')
  const svc = findService(name)
  const env = loadEnv()
  renderConfigs(env)
  if (svc.kind === 'go' && !goBuild(svc)) die(`build failed; ${svc.name} left as it was`)
  log(`restarting ${svc.name}`)
  await stopService(svc)
  const ok = await startService(svc, env, { rebuild: false })
  await cmdStatus([svc])
  if (!ok) process.exitCode = 1
}

async function cmdStatus(list = SERVICES) {
  const rows = await Promise.all(
    list.map(async (svc) => {
      const pid = readPid(svc)
      const up = pid && alive(pid)
      const ok = await healthy(svc)
      const state = ok ? green('healthy') : up ? yellow('unhealthy') : red('stopped')
      return [svc.name, up ? String(pid) : '-', String(svc.port), state, path.relative(ROOT, logFile(svc))]
    }),
  )
  const header = ['SERVICE', 'PID', 'PORT', 'STATE', 'LOG']
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => strip(r[i]).length)))
  const fmt = (r) => r.map((cell, i) => cell + ' '.repeat(widths[i] - strip(cell).length)).join('  ')
  console.log(dim(fmt(header)))
  for (const r of rows) console.log(fmt(r))
}

async function cmdReset() {
  await cmdDown()
  fs.rmSync(LOCAL, { recursive: true, force: true })
  log('removed .local/')
}

function cmdLogs(name) {
  if (!name) die('usage: dev:logs <service>')
  const svc = findService(name)
  const child = spawn('tail', ['-n', '200', '-F', logFile(svc)], { stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code ?? 0))
}

async function main() {
  const [cmd, arg] = process.argv.slice(2)
  const commands = {
    up: cmdUp,
    down: cmdDown,
    status: () => cmdStatus(),
    reset: cmdReset,
    restart: () => cmdRestart(arg),
    logs: () => cmdLogs(arg),
    env: () => process.stdout.write(fs.readFileSync((loadEnv(), ENV_FILE), 'utf8')),
  }
  if (!commands[cmd]) die(`usage: node dev/stack.mjs <${Object.keys(commands).join('|')}> [service]`)
  try {
    await commands[cmd]()
  } catch (e) {
    die(e.stack ?? String(e))
  }
}

// Only run the CLI when executed directly (the test file imports helpers).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
