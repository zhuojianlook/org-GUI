import { useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { vim, Vim } from "@replit/codemirror-vim";
import { oneDark } from "@codemirror/theme-one-dark";
import { orgMotionKeymap, orgLanguage } from "../utils/orgEditing";

/**
 * A CodeMirror editor for a whole org subtree, with Vim (evil-style) modal
 * editing and org subtree motions. Saves on blur, on `:w`, and on Mod-Enter.
 */
export default function BlockEditor({
  initialText,
  accent,
  onSave,
  fill = false,
}: {
  initialText: string;
  accent: string;
  onSave: (text: string) => void;
  fill?: boolean;
}) {
  const [value, setValue] = useState(initialText);
  const textRef = useRef(initialText);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  // `:w` / `:wq` write the subtree back (Doom muscle memory).
  useEffect(() => {
    try {
      Vim.defineEx("write", "w", () => saveRef.current(textRef.current));
      Vim.defineEx("wq", "wq", () => saveRef.current(textRef.current));
    } catch {
      /* defineEx throws if already defined elsewhere — fine */
    }
  }, []);

  const blurSave = EditorView.domEventHandlers({
    blur: () => {
      saveRef.current(textRef.current);
      return false;
    },
  });

  const saveKeymap = Prec.highest(
    keymap.of([
      {
        key: "Mod-Enter",
        run: () => {
          saveRef.current(textRef.current);
          return true;
        },
      },
    ]),
  );

  return (
    <div
      className="nodrag nowheel"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      style={
        fill
          ? { width: "100%", height: "100%" }
          : { minWidth: 380, maxWidth: 760, border: `1px solid ${accent}`, borderRadius: 6 }
      }
    >
      <CodeMirror
        value={value}
        autoFocus
        theme={oneDark}
        height={fill ? "100%" : undefined}
        extensions={[orgMotionKeymap, Prec.highest(vim()), orgLanguage, blurSave, saveKeymap]}
        basicSetup={{
          lineNumbers: fill,
          foldGutter: false,
          highlightActiveLine: true,
          highlightActiveLineGutter: false,
          autocompletion: false,
          searchKeymap: false,
          bracketMatching: false,
          closeBrackets: false,
        }}
        onChange={(v) => {
          setValue(v);
          textRef.current = v;
        }}
        style={{ fontSize: 13, height: fill ? "100%" : undefined }}
      />
    </div>
  );
}
