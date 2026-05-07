# pi-agent Docker setup

Runs [pi-agent](https://github.com/badlogic/pi-mono) in an isolated Docker container backed by a local llama.cpp LLM. Each agent session mounts a single Git repo as its workspace. The container has no general internet access — it can only reach the llama.cpp server and the web-skill proxy.

## Architecture

```
Host LAN
    │ :9090 (llama.cpp web UI + API)
    ▼
┌──────────────────────────────────────────────────────┐
│  HOST                                                │
│                                                      │
│  ┌─────────────┐  llama-bridge (internal)            │
│  │ llama-server│◄──────────────────────┐             │
│  │ :8080       │                       │             │
│  └─────────────┘              ┌────────┴──────────┐  │
│                               │  pi-agent         │  │
│  ┌─────────────┐  web-internal│  (node:bookworm)  │  │
│  │  web-skill  │◄─────────────┤  /workspace bind  │  │
│  │  :3000      │  (internal)  └───────────────────┘  │
│  │      │      │                                     │
│  │  web-egress (normal bridge → internet)            │
│  └─────────────┘                                     │
└──────────────────────────────────────────────────────┘
```

- `llama-bridge` and `web-internal` are both `internal: true` — pi-agent has no default gateway and cannot initiate connections to the internet.
- `web-skill` is the only container with internet egress, acting as a controlled proxy for search and page fetch.
- llama-server publishes port 9090 to all host interfaces for LAN access. Its egress is limited by the DNS-override hack in its own compose file (`dns: 127.0.0.1`).

## Files

```
pi-agent/
├── docker-compose.yml          # infrastructure networks + web-skill + agent service definition
├── Dockerfile                  # node:bookworm-slim + pi + Go + Bun + dev tools
├── pi-run                      # launch script: pi-run <path-to-repo>
├── web-skill/
│   ├── Dockerfile              # node:alpine
│   ├── package.json
│   └── server.js               # GET /search?q= and GET /fetch?url= endpoints (DDG lite scraper)
└── settings/                   # bind-mounted to ~/.pi inside the agent container
    └── agent/
        ├── APPEND_SYSTEM.md    # appended to the system prompt every session (workspace + web skill instructions)
        ├── settings.json       # defaultProvider + defaultModel
        └── models.json         # local llama.cpp provider definition
```

## Available languages & tools

The agent container ships with the following runtimes and CLI tools pre-installed:

| Category | Tools |
|---|---|
| **Runtimes** | Node.js 20, Go 1.24.x, Bun 1.2.x |
| **CLI** | ripgrep, fd, bat, jq, git, curl |

Go binaries are on `PATH` (`/usr/local/go/bin`), Bun is at `/usr/local/bin/bun`. Both are available for the agent to run type-checking, linting, compilation, and tests inside the container.

## Prerequisites

- Docker with Compose plugin
- The llama.cpp compose stack (separate repo/directory) already configured with `llama-bridge` network — see [llama.cpp network setup](#llamacpp-network-setup) below.
- Your user must be in the `docker` group (`sudo usermod -aG docker $USER`, then log out and back in).

## Bootstrap (first time only)

### 1. Add pi-run to your PATH

Add this to your `~/.bashrc` or `~/.zshrc`:

```bash
export PATH="/path/to/pi-agent:$PATH"
```

Then reload your shell:

```bash
source ~/.bashrc   # or source ~/.zshrc
```

### 2. Build the images (first time)

```bash
cd /path/to/pi-agent
docker compose build
```

`pi-run` automatically starts the infrastructure (web-skill, networks) on each invocation via `docker compose up -d --no-recreate`, so there is no separate "start infrastructure" step. The first `pi-run` will start web-skill if it isn't already running.

> **Note:** `llama-bridge` must already exist (created by the llama.cpp compose stack) before running `pi-run`. If you get `network llama-bridge not found`, start the llama.cpp stack first.

### llama.cpp network setup

Your llama.cpp `docker-compose.yml` must include the `llama-bridge` network so the agent container can reach it. Add the following to that file:

```yaml
services:
  llama-server:
    # ... existing config unchanged ...
    networks:
      - private-net
      - llama-bridge   # add this

networks:
  private-net:
    driver: bridge
    # keep existing dns: 127.0.0.1 on the service for egress blocking

  llama-bridge:
    driver: bridge
    internal: true
    name: llama-bridge   # explicit name — pi-agent references this
```

After editing, recreate the llama-server container:

```bash
cd /path/to/llama-compose
docker compose up -d
```

## Daily usage

```bash
pi-run /path/to/your/repo
```

This launches an ephemeral pi-agent container with `/path/to/your/repo` mounted as `/workspace`. The container is removed when you exit the agent (`Ctrl-D` or `/quit`).

Settings in `/path/to/pi-agent/settings/` persist across sessions — model selection, conversation history, and any other pi-agent config.

### Switching models

Inside pi-agent, use the `/model` command to switch between your two configured models:

| Alias | Use for |
|---|---|
| `local-fast` | Default — interactive use, quick edits |
| `local-planning` | Longer-horizon planning and reasoning tasks |

`models.json` reloads without a container restart when you run `/model`.

## Configuration

### LLM endpoint

Defined in `settings/agent/models.json`. The agent reaches llama.cpp at `http://llama-server:8080/v1` (Docker DNS resolves `llama-server` via the shared `llama-bridge` network). To change the model aliases, edit the `id` fields to match your llama.cpp `models.config.toml`.

### Agent settings

`settings/agent/settings.json` controls the active provider and default model. Edit directly or use `/settings` inside pi-agent.

### System prompt additions

`settings/agent/APPEND_SYSTEM.md` is appended to the system prompt on every session. This is the reliable way to give the agent persistent global instructions — it currently contains the workspace path rule (`/workspace` is the repo root, no subdirectory navigation) and the web skill usage instructions (`curl http://web-skill:3000/search?q=...` and `curl http://web-skill:3000/fetch?url=...`).

Edit this file to adjust global agent behaviour without rebuilding the container.

### Per-project context

Add an `AGENTS.md` to the root of any repo for project-specific instructions. Pi-agent loads it from the working directory at session start.

## User ID mapping (rootless Docker)

This setup runs on rootless Docker. The `node:bookworm-slim` base image declares `USER node`, which we explicitly override with `USER root` in our Dockerfile. This is intentional:

- Rootless Docker maps container UID 0 (root) to your host user (ajay, UID 1000)
- Container UID 1000 (node) would map to a high unmapped subUID — it doesn't own your files
- Running as container root means the agent owns its bind-mounted settings and workspace files on the host

There is no privilege escalation: container root is still just you on the host.

## Installing extensions

The agent container normally has no internet access, so `pi install` must be done via a helper script that temporarily opens egress for a single install run:

```bash
pi-install npm:some-extension          # install
pi-install uninstall npm:some-extension # uninstall
```

Replace `npm:some-extension` with any source `pi install` accepts (`git:`, `https://`, `ssh://`). The installed package lands in `settings/` (the bind-mounted settings dir) and persists across container rebuilds and restarts. Uninstalling only modifies local settings and requires no internet access.

If the extension is just a single `.ts` file with no npm dependencies, you can drop it directly into `settings/agent/extensions/` instead.

## Updating pi-agent

The `pi-coding-agent` package is installed from npm during the Docker build. To update to a newer release:

```bash
cd /path/to/pi-agent
docker compose build --no-cache agent
```

## Troubleshooting

**`network llama-bridge not found` on `docker compose up`**
The llama.cpp compose stack must be started first. That stack owns and creates the `llama-bridge` network.

**`/model` shows no providers or wrong endpoint**
Check that `settings/agent/models.json` is present and that `llama-server` is reachable: from inside an agent session, run `bash curl -s http://llama-server:8080/health`.

**Web search returns empty results**
DDG lite occasionally changes its HTML structure. Check the web-skill logs (`docker compose logs web-skill`) and test the endpoint manually from inside the agent container with `curl -s http://web-skill:3000/search?q=test`.
