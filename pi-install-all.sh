#!/usr/bin/env bash
# pi-install-all.sh — Declarative extension installation.
#
# Reads pi-extensions.txt (one npm:package per line) and ensures the
# agent's installed extensions match the manifest. Spins up a single
# container to do both installs and uninstalls, then exits.
#
# Usage: pi-install-all.sh [--dry-run]
#
# Run this after editing pi-extensions.txt to sync your environment.

set -euo pipefail

# ── Parse flags ────────────────────────────────────────────────────────────
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$SCRIPT_DIR/pi-extensions.txt"
SETTINGS="$SCRIPT_DIR/settings/agent/settings.json"
COMPOSE="$SCRIPT_DIR/docker-compose.yml"
OVERRIDE="$SCRIPT_DIR/pi-install-override.yml"

# ── Read manifest ──────────────────────────────────────────────────────────
if [[ ! -f "$MANIFEST" ]]; then
  echo "Error: $MANIFEST not found." >&2
  exit 1
fi

declare -a desired=()
while IFS= read -r line; do
  # Strip inline comments and leading/trailing whitespace
  line="${line%%#*}"
  line="$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [[ -z "$line" ]] && continue
  desired+=("$line")
done < "$MANIFEST"

# ── Read currently installed ───────────────────────────────────────────────
if [[ ! -f "$SETTINGS" ]]; then
  echo "Error: $SETTINGS not found." >&2
  exit 1
fi

declare -A installed_map=()
while IFS= read -r pkg; do
  pkg="$(echo "$pkg" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [[ -z "$pkg" ]] && continue
  installed_map["$pkg"]=1
done < <(jq -r '.packages // [] | .[]' "$SETTINGS")

# ── Guard: empty manifest with installed packages would uninstall everything ─
if [[ ${#desired[@]} -eq 0 && ${#installed_map[@]} -gt 0 ]]; then
  echo "Error: manifest is empty but ${#installed_map[@]} package(s) are installed. All would be uninstalled." >&2
  echo "        Add desired packages to $MANIFEST or remove the guard if this is intentional." >&2
  exit 1
fi

# ── Compute diffs ──────────────────────────────────────────────────────────
# Note: comparison is exact string match on full npm: prefixed names.
# Packages installed from git: or https:// sources will not match npm: entries
# in the manifest and will be flagged for uninstall if not present verbatim.
declare -A desired_map=()
for pkg in "${desired[@]}"; do
  desired_map["$pkg"]=1
done

declare -a to_install=()
declare -a to_uninstall=()

for pkg in "${desired[@]}"; do
  if [[ -z "${installed_map[$pkg]+_}" ]]; then
    to_install+=("$pkg")
  fi
done

for pkg in "${!installed_map[@]}"; do
  if [[ -z "${desired_map[$pkg]+_}" ]]; then
    to_uninstall+=("$pkg")
  fi
done

# ── No-op if already in sync ───────────────────────────────────────────────
if [[ ${#to_install[@]} -eq 0 && ${#to_uninstall[@]} -eq 0 ]]; then
  echo "Extensions already in sync with manifest."
  exit 0
fi

echo "Installing:   ${to_install[*]+"${to_install[@]}"}"
echo "Uninstalling: ${to_uninstall[*]+"${to_uninstall[@]}"}"

# ── Dry-run: show diff and exit ────────────────────────────────────────────
if [[ $DRY_RUN -eq 1 ]]; then
  echo ""
  echo "Dry-run: no changes will be made."
  if [[ ${#to_install[@]} -gt 0 ]]; then
    echo "Would install:"
    printf '  +%s\n' "${to_install[@]}"
  fi
  if [[ ${#to_uninstall[@]} -gt 0 ]]; then
    echo "Would uninstall:"
    printf '  -%s\n' "${to_uninstall[@]}"
  fi
  exit 0
fi

# ── Ensure infrastructure is up ────────────────────────────────────────────
docker compose -f "$COMPOSE" up -d --no-recreate

# ── Build temp files for passing data into the container ───────────────────
TMPDIR_WORK=$(mktemp -d)
trap 'rm -rf "$TMPDIR_WORK"' EXIT

printf '%s\n' "${to_install[@]+"${to_install[@]}"}" > "$TMPDIR_WORK/to_install.txt"
printf '%s\n' "${to_uninstall[@]+"${to_uninstall[@]}"}" > "$TMPDIR_WORK/to_uninstall.txt"

# ── Run install + uninstall in a single container ──────────────────────────
# The override makes npm-global writable and adds web-egress for npm access.
docker compose -f "$COMPOSE" -f "$OVERRIDE" run --rm \
  -v "$TMPDIR_WORK:/tmp/pi-sync:ro" \
  agent bash -c '
  while IFS= read -r pkg; do
    [[ -z "$pkg" ]] && continue
    echo "  Installing: $pkg"
    pi install "$pkg"
  done < /tmp/pi-sync/to_install.txt

  while IFS= read -r pkg; do
    [[ -z "$pkg" ]] && continue
    echo "  Uninstalling: $pkg"
    pi uninstall "$pkg"
  done < /tmp/pi-sync/to_uninstall.txt
  '

echo "Done."
