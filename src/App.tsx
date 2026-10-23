import { useEffect, useMemo, useRef, useState } from 'react'

type Cmd = { run: string[]; description?: string }
type Spec = {
  name: string
  description: string
  rationale: string
  commands: { override: Record<string, Cmd>; add: Record<string, Cmd> }
  files: { path: string; content: string }[]
  manifest: string
  demo?: { command: string; argv?: string[] }
}
type Step = { label: string; cmd: string; code: number; out: string; ms: number; note?: string }
type Health = {
  agentsCliVersion: string
  commands: number
  models: string[]
  defaultModel: string
  baseUrl: string
  hasKey: boolean
}

const EXAMPLES: { label: string; text: string }[] = [
  {
    label: 'Cost ceiling on deploy',
    text: 'Refuse deploys when the projected monthly agent spend in budget.json exceeds the declared monthly_budget. Print spend vs budget on every attempt, and let ops raise the ceiling by editing budget.json, not by forking the CLI.',
  },
  {
    label: 'SBOM gate before deploy',
    text: 'Before any deploy, scan the project SBOM with syft if it exists and refuse to ship if a CRITICAL vulnerability is found. Allow --force to bypass with a loud warning. If the scan is clean, continue with the native deploy.',
  },
  {
    label: 'Model-risk hop on evals',
    text: 'Every eval generate run must pass a model-risk check: the agent must have a MODEL_CARD.md with an owner and an approval date under 180 days, and the dataset must have at least 20 rows. Refuse otherwise with the reason.',
  },
  {
    label: 'No prod without a runbook',
    text: 'Deploys to prod are only allowed if docs/RUNBOOK.md exists and mentions a rollback step. Otherwise block and say exactly which file is missing.',
  },
]

const STAGES = ['create', 'run', 'eval', 'deploy', 'publish']

function lifecycle(cmd: string) {
  return STAGES.find((s) => cmd === s || cmd.startsWith(s + '.'))
}

function Terminal({ step, big }: { step: Step; big?: boolean }) {
  const ok = step.code === 0
  return (
    <div className={`term ${big ? 'term-big' : ''}`}>
      <div className="term-head">
        <span className="dot" />
        <span className={`exit ${ok ? 'ok' : 'bad'}`}>exit {step.code}</span>
        <span className="ms">{step.ms}ms</span>
        <code className="cmd">$ {step.cmd}</code>
      </div>
      <pre>{highlight(step.out)}</pre>
      {step.note && <p className="term-note">{step.note}</p>}
    </div>
  )
}

function highlight(s: string) {
  const lines = s.split('\n')
  return lines.map((line, i) => {
    const m = line.match(/\[↑ ([a-z0-9._-]+)\]/)
    const risk = /refus|block|denied|error|❌|fail|CRITICAL/i.test(line)
    const good = /✓|clean|passed|Added extension/i.test(line)
    return (
      <span key={i} className={m ? 'tag' : risk ? 'bad' : good ? 'ok' : undefined}>
        {line}
        {'\n'}
      </span>
    )
  })
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [model, setModel] = useState('')
  const [policy, setPolicy] = useState(EXAMPLES[0].text)
  const [busy, setBusy] = useState<'' | 'compile' | 'verify' | 'run' | 'bypass'>('')
  const [spec, setSpec] = useState<Spec | null>(null)
  const [verify, setVerify] = useState<{ id: string; installed: boolean; verdict: string; steps: Step[]; contributed: { override: string[]; add: string[] }; dir: string } | null>(null)
  const [extra, setExtra] = useState<Step | null>(null)
  const [tab, setTab] = useState<'manifest' | 'script' | 'why'>('manifest')
  const [fileIdx, setFileIdx] = useState(0)
  const [err, setErr] = useState('')
  const [usage, setUsage] = useState<{ prompt_tokens?: number; completion_tokens?: number } | null>(null)
  const verifyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((h: Health) => {
        setHealth(h)
        setModel(h.defaultModel)
      })
      .catch(() => setErr('api not running — start it with `npm run dev`'))
  }, [])

  const contributed = useMemo(() => {
    if (!spec) return []
    return [...Object.keys(spec.commands?.override || {}), ...Object.keys(spec.commands?.add || {})]
  }, [spec])

  const stage = useMemo(() => {
    const hit = contributed.map(lifecycle).find(Boolean)
    return hit || null
  }, [contributed])

  async function post(url: string, body: object) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json()
    if (!r.ok) throw new Error(j.error || r.statusText)
    return j
  }

  async function onCompile() {
    setBusy('compile')
    setErr('')
    setVerify(null)
    setExtra(null)
    setSpec(null)
    try {
      const j = await post('/api/compile', { policy, model })
      setSpec(j.spec)
      setUsage(j.usage)
      setTab('manifest')
      setFileIdx(0)
      setBusy('verify')
      const v = await post('/api/verify', { spec: j.spec })
      setVerify(v)
      setTimeout(() => verifyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120)
    } catch (e: any) {
      setErr(String(e.message || e))
    } finally {
      setBusy('')
    }
  }

  async function onExec(kind: 'run' | 'bypass') {
    if (!verify) return
    setBusy(kind)
    setErr('')
    try {
      const j = await post('/api/exec', { id: verify.id, kind })
      setExtra(j)
    } catch (e: any) {
      setErr(String(e.message || e))
    } finally {
      setBusy('')
    }
  }

  const installCmd = spec ? (verify?.installed ? `agents-cli extension add ${'<org>'}/${spec.name}` : `agents-cli extension add local@./${spec.name}`) : ''

  return (
    <div className="app">
      <header className="bar">
        <div className="brand">
          <span className="mark">↑</span>
          <div>
            <h1>THE OVERRIDE</h1>
            <p>Write your org's policy in English. Get a working agents-cli extension, judged by the real CLI.</p>
          </div>
        </div>
        <div className="meta">
          <span className="chip" title="read off the installed binary at request time">
            agents-cli <b>{health?.agentsCliVersion || '…'}</b>
          </span>
          <span className="chip">{health?.commands ?? '…'} commands</span>
          <label className="pick">
            <span>model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {(health?.models?.length ? health.models : [health?.defaultModel || '']).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <section className="rail">
        {STAGES.map((s) => (
          <div key={s} className={`stage ${stage === s ? 'on' : ''}`}>
            <span>{s}</span>
          </div>
        ))}
        <p className="rail-note">
          {stage ? (
            <>
              policy lands on <b>{stage}</b>. the other stages keep their built-in behaviour, unmodified.
            </>
          ) : (
            <>one override, not a fork. the rest of the lifecycle keeps working.</>
          )}
        </p>
      </section>

      <main className="grid">
        <section className="panel">
          <h2>1 · the policy</h2>
          <div className="chips">
            {EXAMPLES.map((e) => (
              <button key={e.label} className={`chip-btn ${policy === e.text ? 'sel' : ''}`} onClick={() => setPolicy(e.text)}>
                {e.label}
              </button>
            ))}
          </div>
          <textarea value={policy} onChange={(e) => setPolicy(e.target.value)} spellCheck={false} rows={8} />
          <div className="row">
            <button className="go" onClick={onCompile} disabled={!!busy || !health?.hasKey}>
              {!health
                ? 'reading the installed CLI…'
                : busy === 'compile'
                  ? 'compiling…'
                  : busy === 'verify'
                    ? 'installing + verifying with the CLI…'
                    : 'Compile extension →'}
            </button>
            <span className="hint">{health?.baseUrl?.replace('https://', '')}</span>
          </div>
          {busy === 'verify' && (
            <p className="hint" style={{ marginTop: 10, whiteSpace: 'normal' }}>
              installing the extension into a throwaway project and reading the CLI's own answer. Each `agents-cli`
              invocation is a cold Python start, so this takes ~30s. That delay is the price of not faking it.
            </p>
          )}
          {!health?.hasKey && <p className="warn">No PARTICLE_API_KEY in .env — the model call will fail.</p>}
          {err && <p className="warn">{err}</p>}
          {spec && (
            <div className="rationale">
              <h3>{spec.description}</h3>
              <p>{spec.rationale}</p>
              <p className="dim">
                {contributed.map((c) => (
                  <code key={c} className="mono-pill">
                    {c}
                  </code>
                ))}
                {usage?.completion_tokens ? <span className="dim"> · {usage.completion_tokens} tokens out</span> : null}
              </p>
            </div>
          )}
        </section>

        <section className="panel">
          <h2>2 · what it wrote</h2>
          {!spec ? (
            <div className="empty">
              <p>Nothing compiled yet.</p>
              <p className="dim">
                An extension is one YAML file plus the scripts it runs. `run:` is an argv vector, executed with no shell, so
                chaining has to live inside a wrapper.
              </p>
            </div>
          ) : (
            <>
              <div className="tabs">
                <button className={tab === 'manifest' ? 'on' : ''} onClick={() => setTab('manifest')}>
                  agents-cli-extension.yaml
                </button>
                {spec.files.map((f, i) => (
                  <button key={f.path} className={tab === 'script' && fileIdx === i ? 'on' : ''} onClick={() => { setTab('script'); setFileIdx(i) }}>
                    {f.path}
                  </button>
                ))}
                <button className={tab === 'why' ? 'on' : ''} onClick={() => setTab('why')}>
                  why this shape
                </button>
              </div>
              {tab === 'manifest' && <pre className="code">{spec.manifest}</pre>}
              {tab === 'script' && <pre className="code">{spec.files[fileIdx]?.content}</pre>}
              {tab === 'why' && (
                <div className="why">
                  <p>
                    <b>{contributed.length}</b> command{contributed.length === 1 ? '' : 's'} contributed.{' '}
                    {Object.keys(spec.commands?.override || {}).length} override, {Object.keys(spec.commands?.add || {}).length} added.
                  </p>
                  <ul>
                    <li>
                      Overrides receive the user's argv verbatim and run with <code>AGENTS_CLI_DISABLE_OVERRIDES=1</code>, so
                      calling <code>agents-cli</code> inside the wrapper hits the built-in instead of recursing.
                    </li>
                    <li>
                      The manifest is strict: six top-level keys, and a typo like <code>reqires:</code> fails the install with a
                      did-you-mean instead of silently doing nothing.
                    </li>
                    <li>
                      Reserved commands cannot be claimed: {['install', 'extension', 'info', 'login', 'setup', 'update'].map((c) => <code key={c}>{c}</code>)}.
                    </li>
                    <li>
                      Installed extensions pin to a commit SHA in <code>agents-cli-extensions.yaml</code>, so CI runs the reviewed
                      code, not whatever <code>main</code> is today.
                    </li>
                  </ul>
                </div>
              )}
            </>
          )}
        </section>
      </main>

      <section className="panel wide" ref={verifyRef}>
        <h2>3 · verdict, from the binary</h2>
        {!verify ? (
          <p className="dim">Compile a policy and this fills with real stdout from `agents-cli` on this machine.</p>
        ) : (
          <>
            <div className={`verdict ${verify.installed ? 'pass' : 'fail'}`}>
              <span className="big">{verify.verdict}</span>
              <span className="dim">
                {verify.installed
                  ? `installed into a throwaway project at ${verify.dir} · ${verify.contributed.override.length} override, ${verify.contributed.add.length} added`
                  : 'the CLI refused this manifest — the exact reason is below'}
              </span>
            </div>
            {verify.steps.map((s, i) => (
              <Terminal key={i} step={s} />
            ))}
            {verify.installed && (
              <div className="row">
                <button className="go" onClick={() => onExec('run')} disabled={!!busy}>
                  {busy === 'run' ? 'running…' : 'Run the command for real'}
                </button>
                <button className="ghost" onClick={() => onExec('bypass')} disabled={!!busy}>
                  {busy === 'bypass' ? 'running…' : 'Show the bypass'}
                </button>
                <button className="ghost" onClick={() => navigator.clipboard.writeText(installCmd)}>
                  Copy install line
                </button>
                <span className="hint">{installCmd}</span>
              </div>
            )}
            {extra && <Terminal step={extra} big />}
          </>
        )}
      </section>

      <footer>
        <p>
          Every line above is stdout or stderr from <code>agents-cli {health?.agentsCliVersion}</code>, installed from PyPI as{' '}
          <code>google-agents-cli</code>. The model only writes the manifest and the scripts; the CLI decides whether they are legal.
        </p>
        <p className="dim">
          Built By Harish Kotra · harishkotra.me &nbsp;·&nbsp; Checkout my other builds · dailybuild.xyz
        </p>
      </footer>
    </div>
  )
}
