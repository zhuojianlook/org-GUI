import type { OrgDoc } from "./org";
import demoJson from "./demoData.json";

// Snapshot of TauriApp/samples/demo.org parsed by the Emacs bridge. Used only
// in browser demo mode (no Tauri / no Emacs) so the preview is interactive.
// Regenerate with: emacsclient --eval "(org-gui-call \"src/api/demoData.json\"
// 'org-gui-parse \"samples/demo.org\")".
export const DEMO_DOC: OrgDoc = {
  ...(demoJson as unknown as OrgDoc),
  file: "demo.org",
  title: "org-GUI Demo (browser preview)",
};
