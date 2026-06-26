#!/bin/bash
# Installs the Emacs + Doom Emacs prerequisites for org-GUI on macOS.
# Streams progress to stdout — the app captures each line and shows it in
# the Setup modal.
set -euo pipefail
log() { printf '%s\n' "$*"; }

# Make sure brew is on PATH for the rest of this script even if it was
# just installed and the user's shell hasn't been reloaded yet.
add_brew_path() {
  if [ -d /opt/homebrew/bin ]; then export PATH="/opt/homebrew/bin:$PATH"; fi
  if [ -d /usr/local/bin ]; then export PATH="/usr/local/bin:$PATH"; fi
}
add_brew_path

# --- sudo handling -----------------------------------------------------------
# On a fresh Mac, Homebrew needs root (Command Line Tools + creating the
# /opt/homebrew prefix). We're launched from the GUI with NO terminal, so
# Homebrew's NONINTERACTIVE mode can't prompt for a password and aborts with
# "Need sudo access on macOS". We bridge that by asking for the password once
# via the native macOS dialog and handing it to Homebrew through SUDO_ASKPASS:
# Homebrew's installer prefers `sudo -A <askpass>` when SUDO_ASKPASS is set
# (it takes precedence over its own `-n`), the helper is invoked fresh for each
# sudo call, so there's no terminal, no cached-timestamp/tty_tickets fragility,
# and no keep-alive process to leak.
ASKPASS_DIR=""
cleanup_askpass() {
  if [ -n "$ASKPASS_DIR" ] && [ -d "$ASKPASS_DIR" ]; then rm -rf "$ASKPASS_DIR" 2>/dev/null || true; fi
}
trap cleanup_askpass EXIT

ensure_sudo() {
  # Passwordless sudo already configured? Homebrew's own `sudo -n` will work;
  # nothing for us to set up.
  if sudo -n true 2>/dev/null; then return 0; fi

  log "Homebrew needs administrator rights (Command Line Tools + /opt/homebrew)."
  log "A macOS password prompt will appear — enter your login (Mac) password."

  local pw
  pw=$(/usr/bin/osascript \
        -e 'try' \
        -e 'display dialog "org-GUI Setup needs your macOS login password to install Homebrew (Command Line Tools and /opt/homebrew).\n\nIt is used only on this Mac to grant administrator rights, and is discarded the moment setup finishes." with title "org-GUI — Install prerequisites" default answer "" with hidden answer with icon caution' \
        -e 'text returned of result' \
        -e 'on error number -128' \
        -e 'return "__ORGGUI_CANCEL__"' \
        -e 'end try' 2>/dev/null) || pw="__ORGGUI_CANCEL__"

  if [ "$pw" = "__ORGGUI_CANCEL__" ] || [ -z "$pw" ]; then
    log "❌ Administrator password was not provided — can't install Homebrew."
    log "You can finish setup yourself: open Terminal and run"
    log '    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    log "then click 'Install prerequisites' again to add Emacs + Doom."
    return 1
  fi

  # Stash the password in a private, user-only askpass helper. mktemp -d gives a
  # 0700 dir; the password lives in a 0600 file that the helper cats on demand,
  # and the whole dir is removed on exit (the EXIT trap above). Using a file (vs
  # embedding in the script) avoids any quoting issues with the password text.
  ASKPASS_DIR=$(mktemp -d "${TMPDIR:-/tmp}/orggui-askpass.XXXXXX") || {
    log "❌ Could not create a temporary file for the password helper."
    return 1
  }
  local pw_file="$ASKPASS_DIR/pw" helper="$ASKPASS_DIR/askpass.sh"
  ( umask 177; printf '%s\n' "$pw" >"$pw_file" )
  unset pw
  printf '%s\n' '#!/bin/bash' 'cat "$(dirname "$0")/pw"' >"$helper"
  chmod 700 "$helper"
  export SUDO_ASKPASS="$helper"

  # Validate the password (and prime sudo) via the helper. -A uses the askpass;
  # a wrong password fails fast (the helper just returns the same wrong value).
  if ! sudo -A -v 2>/dev/null; then
    log "❌ That password didn't grant administrator access."
    log "Your macOS account must be an Administrator to install Homebrew."
    return 1
  fi
  return 0
}

# --- 1/3 Homebrew ------------------------------------------------------------
if ! command -v brew >/dev/null 2>&1; then
  log "[1/3] Homebrew not found — installing it first."
  if ! ensure_sudo; then exit 1; fi
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  add_brew_path
  if ! command -v brew >/dev/null 2>&1; then
    log "❌ Homebrew install did not complete — see the messages above."
    exit 1
  fi
  log "Homebrew installed."
else
  log "[1/3] Homebrew: OK ($(brew --version | head -1))"
fi

# Homebrew installs the Command Line Tools itself, but its headless path can
# occasionally no-op (Apple not surfacing the CLT update label). Without CLT the
# Emacs/git steps below would fail with a cryptic error, so flag it clearly.
if ! /usr/bin/xcode-select -p >/dev/null 2>&1; then
  log "⚠ Xcode Command Line Tools not detected — the next steps may fail."
  log "  If so, run 'xcode-select --install' in Terminal, then click 'Install prerequisites' again."
fi

# --- 2/3 Emacs ---------------------------------------------------------------
if ! command -v emacs >/dev/null 2>&1; then
  log "[2/3] Installing Emacs via Homebrew (~30s for the cask)…"
  brew install --cask emacs || brew install emacs
  log "Emacs installed."
else
  log "[2/3] Emacs: OK ($(emacs --version | head -1))"
fi

# --- 3/3 Doom Emacs ----------------------------------------------------------
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
