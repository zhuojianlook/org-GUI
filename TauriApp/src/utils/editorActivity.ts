// Shared, render-free signal for "the user is actively typing in the embedded
// Emacs editor". EmacsTerminal stamps it on every keystroke; background callers
// that hit the single-threaded Emacs daemon (e.g. the Google Calendar peek,
// which runs `curl` per calendar) read it so they don't fire an
// `emacsclient --eval` mid-keystroke — that would block the daemon's command
// loop and freeze the terminal frame until the call returns.
//
// Deliberately a plain module variable, not React/Zustand state: it updates on
// every keystroke and must NOT trigger re-renders, and it lives outside the
// code-split EmacsTerminal bundle so non-editor callers can read it cheaply.

// How long after the last editor keystroke (or editor focus-return) background
// daemon callers treat the editor as "actively in use" and hold off. Shared so
// the App scheduler and the peek's own last-moment guard agree.
export const EDITOR_TYPING_QUIET_MS = 3500;

let lastEmacsKeystrokeAt = 0;

/** Record a keystroke into the embedded Emacs editor (called by EmacsTerminal). */
export function markEmacsKeystroke(): void {
  lastEmacsKeystrokeAt = Date.now();
}

/** True if a keystroke landed in the embedded editor within the last `ms`. */
export function emacsTypingWithin(ms: number): boolean {
  return Date.now() - lastEmacsKeystrokeAt < ms;
}
