// The Override — compiles a plain-English org policy into a real agents-cli
// extension, then installs and runs it with the actual `agents-cli` binary.
// Nothing here is simulated: every "verdict" line is stdout/stderr from the CLI.

import http from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const PORT = Number(process.env.PORT || 8791)
const HOST = process.env.HOST || '127.0.0.1'
const ROOT = path.dirname(new URL(import.meta.url).pathname)
const SCRATCH = process.env.OVERRIDE_SCRATCH || path.join(os.homedir(), '.hermes', 'cache', 'scratch', 'the-override')

// ---------------------------------------------------------------- env / config
function loadEnv() {
  const f = path.join(ROOT, '.env')
  if (!fs.existsSync(f)) return
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
loadEnv()

const BASE_URL = process.env.PARTICLE_BASE_URL || 'https://api.particle.ai/v1'
const API_KEY = process.env.PARTICLE_API_KEY || ''
const DEFAULT_MODEL = process.env.PARTICLE_MODEL || 'glm5.3flash'
const CLI_BIN = process.env.AGENTS_CLI_BIN || path.join(ROOT, '.venv', 'bin', 'agents-cli')

// ---------------------------------------------------------------- process exec
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        // the CLI dir first: wrapper scripts call `agents-cli` by name
        PATH: `${path.dirname(CLI_BIN)}:${process.env.PATH}`,
        AGENTS_CLI_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
        NO_COLOR: '1',
        COLUMNS: '200',
        ...(opts.env || {}),
      },
      timeout: opts.timeout || 30000,
    })
    let out = ''
    let err = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, opts.timeout || 30000)
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, out, err: String(e), ms: Date.now() - started })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, out: stripAnsi(out), err: stripAnsi(err), ms: Date.now() - started, killed })
    })
  })
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\u001b/g, '')

async function cli(args, cwd, env, timeout) {
  return run(CLI_BIN, args, { cwd, env, timeout })
}

// ---------------------------------------------------------------- CLI surface
// Read the real command surface off the installed binary once, so the prompt and
// the UI describe the CLI that is actually on this machine.
let SURFACE = null
async function surface() {
  if (SURFACE) return SURFACE
  const version = (await cli(['--version'], ROOT)).out.trim().replace(/^.*?version\s+/i, '')
  const help = (await cli(['--help'], ROOT)).out
  const top = []
  for (const line of help.split('\n')) {
    const m = line.match(/^ {2}([a-z][a-z0-9-]+) {2,}/)
    if (m && !['Options', 'Commands', 'Source'].includes(m[1])) top.push(m[1])
  }
  const dotted = {}
  const probes = await Promise.all(
    ['eval', 'scaffold', 'publish', 'create', 'infra'].map(async (t) => [t, (await cli([t, '--help'], ROOT)).out]),
  )
  for (const [t, h] of probes) {
    const subs = []
    for (const line of h.split('\n')) {
      const m = line.match(/^ {2}([a-z][a-z0-9-]+) {2,}/)
      if (m && m[1] !== 'Options') subs.push(`${t}.${m[1]}`)
    }
    if (subs.length) dotted[t] = subs
  }
  SURFACE = { version, top, dotted }
  return SURFACE
}

// Mirrors RECOVERY_COMMANDS in extension/_loader.py — commands the CLI refuses
// to hand to an extension, because they are how you inspect or repair the CLI.
const RESERVED = ['install', 'extension', 'extension.add', 'extension.list', 'extension.remove',
  'extension.update', 'info', 'login', 'setup', 'update']

// ---------------------------------------------------------------- LLM compile
const SYSTEM = `You are an extension author for Google's agents-cli (Agent Development Lifecycle CLI).
You write agents-cli-extension extensions (schema agents-cli-extension/v1alpha1) that encode an
organisation's engineering policy as command overrides and additions.

Hard rules you must never break:
- If the policy says "before <command>", the enforcement MUST be an override of that exact existing
  command, because that is the only place the user's own fingers will hit it. An added command
  (<policy>-check) is only for reporting or for a manual re-run, never the enforcement.
- "run" is a command VECTOR (array of argv strings), executed with NO shell. Chaining goes inside a
  wrapper script, never in the vector (no "&&", "|", "$(" anywhere in the vector).
- Never override the reserved commands: ${RESERVED.join(', ')}.
- You may override a subcommand (e.g. "eval.generate") but never a command group ("eval").
- An override runs with AGENTS_CLI_DISABLE_OVERRIDES=1, so calling agents-cli inside a wrapper hits
  the built-in. The wrapper should call the built-in at the end when the policy allows it.
- Scripts must be POSIX bash, exit non-zero to block, and print one short line per decision to stderr
  with the extension name as a prefix. No network calls, no secrets, no writes outside the cwd.
  Never depend on a tool being installed: detect it, and if it is missing say so and either continue
  with a warning or exit non-zero, per the policy's own wording.
- Scripts read their state from the PROJECT cwd (budget.json, owners.json, ...), never from the
  extension directory. If the state file is missing, create it with conservative defaults and print
  that you did, then proceed.
- Keep it small: at most 2 overrides and 1 added command, one script file each (they may share a
  helpers file only if truly needed). Always include a state file the reviewer can edit (e.g.
  budget.json, owners.json) if the policy has a threshold or an allow-list, so the ceiling moves by
  editing data rather than forking the CLI.

Reply with ONE JSON object, no prose, no markdown fences:
{
  "name": "kebab-case-extension-name",
  "description": "one sentence",
  "rationale": "2-3 sentences: which lifecycle stage this wraps and why an override (not a fork)",
  "commands": {
    "override": { "<command or group.sub>": { "run": ["bash","scripts/x.sh"], "description": "..." } },
    "add":      { "<new-command>": { "run": ["bash","scripts/y.sh"], "description": "..." } }
  },
  "files": [ { "path": "scripts/x.sh", "content": "#!/usr/bin/env bash\\n..." } ],
  "demo": { "command": "<the agents-cli command a user now runs>", "argv": [] }
}

If the policy has a threshold or an allow-list, ship the state file too (e.g. budget.json) with
realistic, non-trivial values — a projected spend slightly over the ceiling is a good default,
because the first run then shows the gate actually deciding instead of passing trivially.`

async function compile(policy, model, extra, maxTokens = 8000) {
  const s = await surface()
  const user = `The installed CLI is agents-cli ${s.version}.
Top-level commands: ${s.top.join(', ')}.
Dotted subcommands available to override: ${Object.entries(s.dotted).map(([k, v]) => v.join(', ')).join(' | ')}.

Organisation policy to encode:
"""${policy}"""
${extra ? `\nExtra context: ${extra}` : ''}

Write the extension. Prefer overriding the single command closest to where the policy must be enforced.
The demo.command must be one of the commands your extension contributes, and demo.argv stays empty
unless the policy itself names a flag.`

  const body = {
    model: model || DEFAULT_MODEL,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
    // reasoning tokens bill against the same budget on some providers
    max_tokens: maxTokens,
  }
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`model ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  const choice = data.choices?.[0]
  let text = choice?.message?.content || ''
  if (!text.trim())
    throw new Error(
      `model returned no content (finish_reason=${choice?.finish_reason}, completion_tokens=${data.usage?.completion_tokens}, reasoning=${data.usage?.completion_tokens_details?.reasoning_tokens})`,
    )
  text = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first < 0 || last < 0) throw new Error(`model did not return JSON: ${text.slice(0, 200)}`)
  const spec = JSON.parse(text.slice(first, last + 1))
  spec.manifest = renderManifest(spec)
  return { spec, usage: data.usage || null, model: body.model }
}

// Manifest YAML is rendered here, not by the model, so structure is always legal.
function q(s) {
  return JSON.stringify(String(s ?? ''))
}
function renderManifest(spec) {
  const name = String(spec.name || '').trim()
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`bad extension name ${q(name)}`)
  const lines = [
    '# yaml-language-server: $schema=https://raw.githubusercontent.com/google/agents-cli/main/schemas/agents-cli-extension-v1alpha1.schema.json',
    'schema: agents-cli-extension/v1alpha1',
    `name: ${q(name)}`,
    `description: ${q(spec.description || '')}`,
    'requires:',
    '  agents_cli: ">=1.5,<2"',
    '  on_incompatible: warn',
    'commands:',
  ]
  const blocks = spec.commands || {}
  for (const kind of ['override', 'add']) {
    const entries = Object.entries(blocks[kind] || {})
    if (!entries.length) continue
    lines.push(`  ${kind}:`)
    for (const [cmd, entry] of entries) {
      lines.push(`    ${q(cmd)}:`)
      lines.push(`      run: [${(entry.run || []).map(q).join(', ')}]`)
      if (entry.description) lines.push(`      description: ${q(entry.description)}`)
    }
  }
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------- verify (real CLI)
const sessions = new Map()

async function verify(spec, emit) {
  const id = crypto.randomBytes(5).toString('hex')
  const dir = path.join(SCRATCH, id)
  const extDir = path.join(dir, 'ext')
  const projDir = path.join(dir, 'proj')
  fs.mkdirSync(extDir, { recursive: true })
  fs.mkdirSync(projDir, { recursive: true })

  fs.writeFileSync(path.join(extDir, 'agents-cli-extension.yaml'), spec.manifest)
  for (const f of spec.files || []) {
    const p = path.join(extDir, f.path)
    if (!p.startsWith(extDir)) throw new Error(`file escapes the extension: ${f.path}`)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, f.content)
    if (f.path.endsWith('.sh')) fs.chmodSync(p, 0o755)
  }
  // A stub project: extensions install at project scope, so one must exist.
  fs.writeFileSync(path.join(projDir, 'agents-cli-manifest.yaml'), 'name: policy-sandbox\n')
  // State files the extension ships (budget.json, owners.json) are project data, so
  // seed them where the wrapper looks for them before the gate ever runs.
  const seeded = []
  for (const f of spec.files || []) {
    if (!/\.(json|ya?ml|csv|txt)$/i.test(f.path)) continue
    const base = path.basename(f.path)
    fs.writeFileSync(path.join(projDir, base), f.content)
    seeded.push(base)
  }

  const steps = []
  const record = (s) => {
    steps.push(s)
    emit?.(s)
  }
  const add = await cli(['extension', 'add', `local@${extDir}`, '--yes'], projDir)
  record({
    label: 'agents-cli extension add',
    cmd: `agents-cli extension add local@./${spec.name} --yes`,
    code: add.code,
    out: (add.out + add.err).trim(),
    ms: add.ms,
  })
  const installed = add.code === 0
  if (installed) {
    const primary = Object.keys(spec.commands?.override || {})[0] || Object.keys(spec.commands?.add || {})[0]
    // Three reads, three cold Python startups: run them together. `extension list`
    // walks two scopes and can lose the process on a cold start, so it gets a retry.
    const [list, info, h] = await Promise.all([
      cli(['extension', 'list'], projDir).then((r) =>
        r.code !== 0 && !r.out.trim() && !r.err.trim() ? cli(['extension', 'list'], projDir) : r,
      ),
      cli(['info'], projDir),
      primary ? cli([...primary.split('.'), '--help'], projDir) : Promise.resolve(null),
    ])
    record({ label: 'extension list', cmd: 'agents-cli extension list', code: list.code, out: (list.out + list.err).trim() || '(no output)', ms: list.ms })

    // `info` prints the exact command vector behind each override; `--help` wraps
    // the [↑ name] tag at its own 80 columns and looks truncated in a wide panel.
    const infoLines = info.out.split('\n')
    const start = infoLines.findIndex((l) => /^Extensions/.test(l.trim()))
    const infoOut = (start >= 0 ? infoLines.slice(start) : infoLines).join('\n').trim()
    record({
      label: 'what the CLI bound',
      cmd: 'agents-cli info',
      code: info.code,
      out: infoOut || '(no extensions section)',
      ms: info.ms,
    })

    if (h)
      record({
        label: 'intercepted help',
        cmd: `agents-cli ${primary} --help`,
        code: h.code,
        out: (h.out + h.err).trim(),
        ms: h.ms,
      })
    if (seeded.length)
      record({
        label: 'seed project state',
        cmd: `cp ${seeded.join(' ')} .`,
        code: 0,
        out: `state files the extension ships are project data, so they land in the sandbox project root:\n  ${seeded.join('\n  ')}`,
        ms: 0,
      })
  }
  sessions.set(id, { extDir, projDir, spec, installed })

  return {
    id,
    installed,
    verdict: installed ? 'ACCEPTED' : 'REJECTED',
    steps,
    contributed: {
      override: Object.keys(spec.commands?.override || {}),
      add: Object.keys(spec.commands?.add || {}),
    },
    dir: dir.replace(os.homedir(), '~'),
  }
}

async function execSession(id, kind) {
  const s = sessions.get(id)
  if (!s) throw new Error('unknown session — verify first')
  const overrides = Object.keys(s.spec.commands?.override || {})
  const demo = s.spec.demo || {}
  const cmd = demo.command || overrides[0] || Object.keys(s.spec.commands?.add || {})[0]
  if (!cmd) throw new Error('this extension contributes no commands')
  const argv = Array.isArray(demo.argv) ? demo.argv.map(String) : []
  // Only pass flags the real command accepts — the sandbox should fail for policy
  // reasons, never because the model invented an option.
  let accepted = argv
  if (argv.some((a) => a.startsWith('-'))) {
    const h = await cli([...cmd.split('.'), '--help'], s.projDir)
    accepted = argv.filter((a) => !a.startsWith('-') || h.out.includes(a))
  }
  const parts = cmd.split('.').concat(accepted)

  if (kind === 'bypass') {
    const r = await cli(parts, s.projDir, { AGENTS_CLI_DISABLE_OVERRIDES: '1' }, 60000)
    return {
      label: 'built-in, overrides disabled',
      cmd: `AGENTS_CLI_DISABLE_OVERRIDES=1 agents-cli ${parts.join(' ')}`,
      code: r.code,
      out: (r.out + r.err).trim() || '(no output)',
      ms: r.ms,
      note: 'Same binary, same command, policy skipped. Note the built-in still stops at its own checks — the sandbox has no cloud project.',
    }
  }
  const r = await cli(parts, s.projDir, {}, 60000)
  const blocked = r.code !== 0
  return {
    label: 'overridden command, for real',
    cmd: `agents-cli ${parts.join(' ')}`,
    code: r.code,
    out: (r.out + r.err).trim() || '(no output)',
    ms: r.ms,
    note: r.killed
      ? 'Killed at 60s: the gate let it through and the built-in deploy then waited on cloud credentials this sandbox does not have.'
      : blocked
        ? 'Non-zero exit: the extension blocked the command.'
        : 'Zero exit: the policy passed and the command continued to the built-in.',
  }
}

// ---------------------------------------------------------------- http
function json(res, code, body) {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''
    req.on('data', (c) => {
      b += c
      if (b.length > 2e6) reject(new Error('body too large'))
    })
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {})
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  try {
    if (url.pathname === '/api/health') {
      const s = await surface()
      let models = []
      try {
        const r = await fetch(`${BASE_URL}/models`, { headers: { authorization: `Bearer ${API_KEY}` } })
        models = ((await r.json()).data || []).map((m) => m.id)
      } catch {}
      return json(res, 200, {
        agentsCliVersion: s.version,
        commands: s.top.length,
        dotted: s.dotted,
        models,
        defaultModel: DEFAULT_MODEL,
        baseUrl: BASE_URL,
        cliBin: CLI_BIN.replace(os.homedir(), '~'),
        hasKey: Boolean(API_KEY),
      })
    }

    if (url.pathname === '/api/compile' && req.method === 'POST') {
      const { policy, model, extra } = await readBody(req)
      if (!policy || String(policy).trim().length < 12)
        return json(res, 400, { error: 'Describe the policy in a sentence or two first.' })
      const started = Date.now()
      let result
      let lastErr
      // Reasoning models bill thinking against max_tokens, so a hard policy can eat
      // the whole budget and return nothing. Retry once with double the headroom.
      for (const budget of [8000, 16000]) {
        try {
          result = await compile(String(policy), model, extra, budget)
          break
        } catch (e) {
          lastErr = e
        }
      }
      if (!result) throw lastErr
      const { spec, usage } = result
      return json(res, 200, { spec, usage, ms: Date.now() - started })
    }

    if (url.pathname === '/api/verify' && req.method === 'POST') {
      const { spec } = await readBody(req)
      if (!spec?.manifest) return json(res, 400, { error: 'nothing to verify' })
      // Stream each step as the CLI finishes it, so the panel fills in live
      // instead of going blank for the ~40s four cold Python starts take.
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' })
      const send = (o) => res.write(JSON.stringify(o) + '\n')
      try {
        const result = await verify(spec, (step) => send({ type: 'step', step }))
        send({ type: 'done', ...result })
      } catch (e) {
        send({ type: 'error', error: String(e.message || e) })
      }
      return res.end()
    }

    if (url.pathname === '/api/exec' && req.method === 'POST') {
      const { id, kind } = await readBody(req)
      return json(res, 200, await execSession(id, kind === 'bypass' ? 'bypass' : 'run'))
    }

    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'no such endpoint' })

    // Serve the built SPA when it exists, so `npm start` is a single-port demo.
    const dist = path.join(ROOT, 'dist')
    if (fs.existsSync(dist)) {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
      const file = path.join(dist, rel)
      if (file.startsWith(dist) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file)
        const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream'
        res.writeHead(200, { 'content-type': type })
        return res.end(fs.readFileSync(file))
      }
    }
    res.writeHead(404).end('not found')
  } catch (e) {
    json(res, 500, { error: String(e.message || e) })
  }
})

server.listen(PORT, HOST, async () => {
  const s = await surface().catch(() => ({ version: 'missing', top: [], dotted: {} }))
  console.log(`the-override api on http://${HOST}:${PORT} — agents-cli ${s.version} (${CLI_BIN})`)
})
