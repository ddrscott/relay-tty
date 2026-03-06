#!/usr/bin/env bash
# relay-tty installer — https://github.com/ddrscott/relay-tty
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ddrscott/relay-tty/main/install.sh | bash
#
# What it does:
#   1. Checks for Node.js >= 18 (offers to install via fnm if missing)
#   2. Installs relay-tty globally via npm
#   3. postinstall downloads the pre-built Rust pty-host binary
#
# Set RELAY_VERSION to install a specific version (default: latest).

set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

info()  { echo -e "${BOLD}relay-tty:${RESET} $*"; }
ok()    { echo -e "${GREEN}${BOLD}relay-tty:${RESET} $*"; }
warn()  { echo -e "${YELLOW}${BOLD}relay-tty:${RESET} $*"; }
error() { echo -e "${RED}${BOLD}relay-tty:${RESET} $*" >&2; }

REQUIRED_NODE_MAJOR=18

# ── Check OS ──────────────────────────────────────────────────────────

OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ;;
  *)
    error "Unsupported OS: $OS. relay-tty supports macOS and Linux."
    error "Windows users: install via WSL."
    exit 1
    ;;
esac

# ── Check Node.js ─────────────────────────────────────────────────────

check_node() {
  if ! command -v node &>/dev/null; then
    return 1
  fi
  local ver
  ver="$(node -v 2>/dev/null | sed 's/^v//')"
  local major="${ver%%.*}"
  if [ "$major" -lt "$REQUIRED_NODE_MAJOR" ] 2>/dev/null; then
    return 1
  fi
  return 0
}

install_node() {
  info "Installing Node.js via fnm (Fast Node Manager)..."

  if ! command -v fnm &>/dev/null; then
    info "Installing fnm..."
    curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
    # Source fnm for this session
    export PATH="$HOME/.local/share/fnm:$HOME/.fnm:$PATH"
    eval "$(fnm env --shell bash 2>/dev/null)" || true
  fi

  if ! command -v fnm &>/dev/null; then
    error "Failed to install fnm. Install Node.js >= $REQUIRED_NODE_MAJOR manually:"
    error "  https://nodejs.org/"
    exit 1
  fi

  fnm install --lts
  fnm use lts-latest
  eval "$(fnm env --shell bash 2>/dev/null)" || true

  if ! check_node; then
    error "Node.js installation succeeded but version check failed."
    error "Try opening a new terminal and running this installer again."
    exit 1
  fi

  ok "Node.js $(node -v) installed via fnm"
  echo ""
  warn "Add fnm to your shell profile for future sessions:"
  warn '  eval "$(fnm env)"'
  echo ""
}

if check_node; then
  info "Found Node.js $(node -v)"
else
  if [ -t 0 ]; then
    # Interactive — ask the user
    echo ""
    warn "Node.js >= $REQUIRED_NODE_MAJOR is required but not found."
    echo -n "Install Node.js via fnm (Fast Node Manager)? [Y/n] "
    read -r answer
    case "$answer" in
      [nN]*)
        error "Node.js is required. Install it manually: https://nodejs.org/"
        exit 1
        ;;
      *)
        install_node
        ;;
    esac
  else
    # Non-interactive (piped) — install automatically
    warn "Node.js >= $REQUIRED_NODE_MAJOR not found. Installing via fnm..."
    install_node
  fi
fi

# ── Install relay-tty ─────────────────────────────────────────────────

VERSION="${RELAY_VERSION:-latest}"

info "Installing relay-tty@${VERSION}..."

npm install -g "relay-tty@${VERSION}"

echo ""
ok "relay-tty installed successfully!"
echo ""
info "Quick start:"
info "  relay bash          # start a session"
info "  relay server        # start the web UI"
info "  relay --help        # see all commands"
