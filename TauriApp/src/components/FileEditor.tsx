import { useEffect, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { getFile } from "../api/org";
import BlockEditor from "./BlockEditor";

/**
 * Full-screen editor for the entire .org file as one org-mode buffer
 * (CodeMirror + Vim). Saves the whole file back through Emacs.
 */
export default function FileEditor() {
  const file = useOrgStore((s) => s.file);
  const saveFile = useOrgStore((s) => s.saveFile);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (file) {
      getFile(file)
        .then((r) => alive && setText(r.text))
        .catch(() => alive && setText(""));
    }
    return () => {
      alive = false;
    };
  }, [file]);

  if (text === null) {
    return (
      <div style={{ height: "100%", display: "grid", placeItems: "center", color: "var(--c-text-dim)" }}>
        Loading file…
      </div>
    );
  }

  return (
    <div style={{ height: "100%", width: "100%" }}>
      <BlockEditor fill initialText={text} accent="var(--c-accent)" onSave={(t) => saveFile(t)} />
    </div>
  );
}
