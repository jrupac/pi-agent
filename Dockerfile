FROM node:20-bookworm-slim

# ── Common tools ────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    ripgrep \
    git \
    curl \
    jq \
    fd-find \
    bat \
    ca-certificates \
    unzip \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

# ── Go (latest stable, fetched at build time) ──────────────────────────────
# Intentional: pulls the latest stable Go release on every image rebuild.
# This only happens on explicit user action (docker compose up --build).
RUN set -e; \
    GOARCH="amd64"; \
    GO_VERSION=$(curl -s https://go.dev/VERSION?m=text | head -n 1); \
    echo "Installing ${GO_VERSION} for linux/${GOARCH}..." ; \
    curl -sL "https://go.dev/dl/${GO_VERSION}.linux-${GOARCH}.tar.gz" | tar -C /usr/local -xz

# ── Bun ─────────────────────────────────────────────────────────────────────
RUN npm install -g bun

# ── Pi Agent ────────────────────────────────────────────────────────────────
RUN npm install -g @mariozechner/pi-coding-agent

# Redirect npm global installs to ~/.pi/npm-global so they land in the bind-mounted
# settings dir and persist across container rebuilds. prefer-offline means subsequent
# `npm install -g <pkg>` calls (from pi at startup) resolve from the local cache
# without hitting the registry.
ENV NPM_CONFIG_PREFIX=/root/.pi/npm-global
ENV NPM_CONFIG_CACHE=/root/.pi/npm-cache
ENV NPM_CONFIG_PREFER_OFFLINE=true
ENV PATH=/usr/local/go/bin:/root/.pi/npm-global/bin:$PATH
ENV GOPATH=/root/go

# node:bookworm-slim sets USER node; override to root so bind-mounted files
# (owned by host UID 1000 = container root in rootless Docker) are accessible.
USER root
WORKDIR /workspace
ENTRYPOINT ["pi"]
