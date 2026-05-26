#!/bin/bash
# Installs the Emacs + Doom Emacs prerequisites for org-GUI on macOS.
# Streams progress to stdout — the app captures each line and shows it in
# the Setup modal.
set -euo pipefail
log() { printf '%s\n' "$*"; }

# Make sure brew is on PATH for the rest of this script even if it was
# just installed and the user's shell hasn't been reloaded yet.
if [ -d /opt/homebrew/bin ]; then export PATH="/opt/homebrew/bin:$PATH"; fi
if [ -d /usr/local/bin ]; then export PATH="/usr/local/bin:$PATH"; fi

if ! command -v brew >/dev/null 2>&1; then
  log "[1/3] Homebrew not found — installing it first."
  log "(It may prompt for your macOS password.)"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [ -d /opt/homebrew/bin ]; then export PATH="/opt/homebrew/bin:$PATH"; fi
  log "Homebrew installed."
else
  log "[1/3] Homebrew: OK ($(brew --version | head -1))"
fi

if ! command -v emacs >/dev/null 2>&1; then
  log "[2/3] Installing Emacs via Homebrew (~30s for the cask)…"
  brew install --cask emacs || brew install emacs
  log "Emacs installed."
else
  log "[2/3] Emacs: OK ($(emacs --version | head -1))"
fi

DOOM_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/emacs"
if [ ! -f "$DOOM_DIR/bin/doom" ]; then
  log "[3/3] Installing Doom Emacs to $DOOM_DIR …"
  if [ ! -d "$DOOM_DIR/.git" ]; then
    rm -rf "$DOOM_DIR"
    git clone --depth=1 https://github.com/doomemacs/doomemacs "$DOOM_DIR"
  fi
  log "Running 'doom install' — downloads packages, byte-compiles. ~5–10 min."
  "$DOOM_DIR/bin/doom" install --no-fonts --no-hooks --yes
  log "Doom installed."
else
  log "[3/3] Doom: OK ($DOOM_DIR)"
fi

log "All prerequisites are ready."
