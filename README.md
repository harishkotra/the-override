# The Override

**Write your org's agent policy in English. Get a working `agents-cli` extension, judged by the real CLI.**

Google's [`agents-cli`](https://google.github.io/agents-cli/) ships an Extension System (v1.5.0, experimental): one YAML file that overrides a built-in command without forking the tool. That is the whole point of [the announcement](https://developers.googleblog.com/powering-the-agent-development-lifecycle-with-any-framework-from-adk-to-langchain-and-beyond/). Enterprise platform teams get to enforce a compliance scan, an SSO gate, or a model-risk hop on every project, and framework teams get to swap ADK for LangChain without losing deploy, eval and observability.

The catch: you still have to author the thing. Strict schema, six top-level keys, argv vectors with no shell, reserved commands you cannot touch, lockfile pinning. Most teams never get past the first typo.

This tool closes that gap in one screen. You describe the policy. The model writes the extension. **The real CLI decides whether it is legal.**

## What actually happens

1. **Compile.** Your policy plus the live command surface of the installed binary go to an OpenAI-compatible endpoint (Particle.ai by default). The model returns the extension name, the commands it contributes, and the wrapper scripts. The YAML is rendered by the server, so structure is always legal.
2. **Install for real.** The files land in a throwaway project. `agents-cli extension add local@... --yes` runs. Not a simulation.
3. **Read the CLI's answer.** `extension list`, `--help`, and `<command> --help` are captured verbatim. A rejected manifest shows the CLI's own error text, including its did-you-mean hints.
4. **Run it.** One button invokes the overridden command for real. Another runs it with `AGENTS_CLI_DISABLE_OVERRIDES=1` to show the bypass every override ships with.

Every line of the verdict panel is stdout or stderr from `agents-cli` on this machine.

## A real run

Policy: *"Refuse deploys when the projected monthly agent spend in budget.json exceeds the declared monthly_budget."*

```
$ agents-cli extension add local@./spend-gate --yes
Added extension 'spend-gate' (project scope) from .../ext.
Extensions are experimental; the manifest format may still change.

$ agents-cli deploy --help
Usage: agents-cli deploy [OPTIONS] [EXTRA_ARGS]...

  Overrides `deploy` via extension 'spend-gate' (project scope).

  Runs: bash scripts/deploy-gate.sh

  To bypass extension overrides and run the built-in:
  AGENTS_CLI_DISABLE_OVERRIDES=1 agents-cli deploy

$ agents-cli deploy
running 'deploy' via extension 'spend-gate' (project scope)
spend-gate: projected monthly spend: 612.5 / budget: 500
spend-gate: REFUSING deploy: projected spend 612.5 exceeds monthly_budget 500
```

Exit 1. Nothing deployed. No fork, no wrapper layer, no CI change.

## Why this shape

- **The enforcement point is an override, not a new command.** If the policy says "before deploy", it has to be `deploy`, because that is where a human's fingers already are. An added command (`budget-report`) is for reporting only.
- **`run:` is an argv vector**, executed with no shell, so chaining lives inside the wrapper script. The generated manifests respect that.
- **Overrides run with `AGENTS_CLI_DISABLE_OVERRIDES=1`**, so the wrapper's hand-off to `agents-cli deploy` hits the built-in instead of recursing.
- **Reserved commands stay reserved**: `install`, `extension`, `info`, `login`, `setup`, `update`. The CLI refuses to hand them over, and this tool shows you that refusal rather than hiding it.
- **Thresholds live in data, not in code.** A budget ceiling is a `budget.json` in the project. Ops raises it by editing a number, not by forking a CLI.

## Run it

Fastest path, from a fresh unzip:

```bash
./setup.sh          # checks node+python, builds ./.venv with agents-cli 1.11.0, npm ci, builds the UI
# put PARTICLE_API_KEY in .env
npm start           # http://127.0.0.1:8791
```

By hand, if you prefer:

```bash
python3 -m venv .venv && .venv/bin/pip install google-agents-cli==1.11.0
npm install
cp .env.example .env      # set PARTICLE_API_KEY (any OpenAI-compatible endpoint works)
npm run dev               # vite on :5273, api on :8791
```

Requirements: Node 18+, Python 3.11+ (agents-cli imports modern typing), and a macOS or Linux shell.

Single-port build:

```bash
npm run build && npm start   # everything on http://127.0.0.1:8791
```

Reach it from another device on the same wifi:

```bash
HOST=0.0.0.0 PORT=8791 npm start    # then http://<machine-ip>:8791
```

Smoke test the whole flow headlessly:

```bash
node scripts/ui-smoke.mjs    # compiles, installs, runs, prints the transcripts
```

### Config

| var | default | meaning |
|---|---|---|
| `PARTICLE_BASE_URL` | `https://api.particle.ai/v1` | any OpenAI-compatible base URL |
| `PARTICLE_API_KEY` | none | your key |
| `PARTICLE_MODEL` | `glm5.3flash` | model that writes the extension |
| `AGENTS_CLI_BIN` | `./.venv/bin/agents-cli` | the binary that judges it |
| `OVERRIDE_SCRATCH` | `~/.hermes/cache/scratch/the-override` | where sandbox projects live |

## Safety

The model writes bash and the app runs it, by design. It runs in a scratch project under `OVERRIDE_SCRATCH`, with telemetry off and `agents-cli` first on `PATH`. Nothing listens on anything but `127.0.0.1`. Read a generated script before you take it to a real repo, exactly as you would read any extension you `extension add`.

## Built on

- [`google/agents-cli`](https://github.com/google/agents-cli) v1.11.0, Extension System (experimental)
- Particle.ai, OpenAI-compatible chat completions

---

Built By Harish Kotra, [harishkotra.me](https://harishkotra.me)

Checkout my other builds, [dailybuild.xyz](https://dailybuild.xyz)
