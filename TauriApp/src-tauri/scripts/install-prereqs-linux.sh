#!/bin/bash
# Installs the Emacs + Doom Emacs prerequisites for org-GUI on Linux.
# Uses the system's package manager for Emacs (apt/dnf/pacman/zypper), so the
# user will see a sudo prompt the first time.
set -euo pipefail
log() { printf '%s\n' "$*"; }

if ! command -v emacs >/dev/null 2>&1; then
  log "[1/2] Installing Emacs via your package manager (you may be prompted for sudo)…"
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y emacs git
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y emacs git
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --noconfirm emacs git
  elif command -v zypper >/dev/null 2>&1; then
    sudo zypper install -y emacs git
  else
    log "Could not detect a supported package manager."
    log "Please install Emacs and git manually, then click 'Install prerequisites' again."
    exit 1
  fi
  log "Emacs installed."
else
  log "[1/2] Emacs: OK ($(emacs --version | head -1))"
fi

DOOM_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/emacs"
if [ ! -f "$DOOM_DIR/bin/doom" ]; then
  log "[2/2] Installing Doom Emacs to $DOOM_DIR …"
  if [ ! -d "$DOOM_DIR/.git" ]; then
    rm -rf "$DOOM_DIR"
    git clone --depth=1 https://github.com/doomemacs/doomemacs "$DOOM_DIR"
  fi
  log "Running 'doom install' — downloads packages, byte-compiles. ~5–10 min."
  "$DOOM_DIR/bin/doom" install --no-fonts --no-hooks --yes
  log "Doom installed."
else
  log "[2/2] Doom: OK ($DOOM_DIR)"
fi

log "All prerequisites are ready."
