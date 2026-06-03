// Built-in ("first-party") Google OAuth client for the bundled "Sign in with
// Google" flow. These come from Vite env vars at BUILD time:
//   - CI: GitHub Actions injects them from repo secrets
//     (VITE_GOOGLE_CLIENT_ID / VITE_GOOGLE_CLIENT_SECRET).
//   - Local: put them in TauriApp/.env.local (gitignored).
//
// This is a Google "Desktop app" OAuth client; Google explicitly does NOT
// treat that kind of client secret as confidential (it ships inside every
// installed copy), so baking it into the bundle is the intended model. Each
// user still authorizes their OWN Google account via the browser, and their
// token is stored locally in ~/.org-gui/oauth2.plist — the shared client only
// identifies the app to Google, it grants no access to anyone's calendar.
//
// When these are empty (e.g. a community build without the secret), the panel
// falls back to asking the user for their own client id/secret.
export const DEFAULT_GOOGLE_CLIENT_ID = (
  import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ""
).trim();

export const DEFAULT_GOOGLE_CLIENT_SECRET = (
  import.meta.env.VITE_GOOGLE_CLIENT_SECRET ?? ""
).trim();

/** True when this build ships a usable first-party Google client, so the UI
 *  can offer one-click "Sign in with Google" instead of a credentials form. */
export const HAS_DEFAULT_GOOGLE_CLIENT =
  DEFAULT_GOOGLE_CLIENT_ID.length > 0 && DEFAULT_GOOGLE_CLIENT_SECRET.length > 0;
