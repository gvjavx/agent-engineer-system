# mas-ade

Terminal client for a **Mas ADE** agent — an AI dev team you normally drive over
WhatsApp. This lets you drive the same agent from a shell instead.

It is a thin client: it talks HTTP to a **running Mas ADE orchestrator**. It does
nothing on its own.

## Requirements

- Node.js >= 20
- A Mas ADE orchestrator you can reach, started with `CLI_ENABLED=true`
- Its `INTERNAL_SHARED_SECRET`

## Install

```bash
npm i -g mas-ade
# or run without installing:
npx mas-ade "status"
```

## Configure

Set these in the environment, or in a `.env` file in the directory you run from:

| Variable | Default | What |
|---|---|---|
| `ORCHESTRATOR_URL` | `http://localhost:4000` | Base URL of the orchestrator |
| `INTERNAL_SHARED_SECRET` | *(required)* | Must match the orchestrator's |

If the orchestrator is on another machine, tunnel to it — do **not** expose its
port publicly:

```bash
ssh -N -L 4000:localhost:4000 user@your-server
```

## Use

```bash
mas-ade                              # REPL — type instructions line by line, Ctrl+C to quit
mas-ade "tambahin endpoint /health"  # one-shot: send, print replies until it goes quiet, exit
mas-ade --wait=30 "review PR 12"     # wait 30s of silence before deciding it's done
```

Every command that works over WhatsApp works here (`status`, `pakai <project>`,
`daftar model`, `tanya: ...`, `kerjain issue 5`, ...). Tappable options are shown
as `[id] label` lines — type the `id`. Images/documents/voice come through only
as `[file: ...]` notes; a terminal can't render them.

The CLI uses one fixed conversation identity (`CLI_SENDER_ID` on the
orchestrator, default `cli`), separate from any WhatsApp number, so its active
project and memory persist across runs.

## Security

Whoever has `INTERNAL_SHARED_SECRET` and can reach the orchestrator has **full
autonomous control** of the agent — it commits and pushes to the repositories it
manages. Treat the secret accordingly. There is no per-user permission or audit
split yet.

## License

MIT
