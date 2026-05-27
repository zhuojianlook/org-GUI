;;; org-gui-bridge.el --- Bridge between org-GUI desktop app and Emacs org-mode -*- lexical-binding: t; -*-

;; This file is loaded into the user's running Emacs server by the org-GUI
;; Tauri app via `emacsclient --eval'. Every public function returns a JSON
;; STRING (built with the native `json-serialize') so the Rust/JS side can
;; parse it directly. All names are namespaced `org-gui-' to avoid clobbering
;; anything in the user's interactive session.

(require 'org)
(require 'org-element)
(require 'org-id)
(require 'subr-x)

(defconst org-gui-bridge-version "0.1.0")

;;;; ---- JSON helpers -------------------------------------------------------
;; json-serialize is strict: t=true, :false=false, :null=null, and JSON
;; arrays must be vectors (a bare list is ambiguous vs an alist/object).

(defun org-gui--s (v)
  "Normalize V to a JSON-serializable scalar: nil/empty -> :null."
  (if (and v (or (not (stringp v)) (> (length v) 0))) v :null))

(defun org-gui--b (v)
  "Normalize V to a JSON boolean."
  (if v t :false))

(defun org-gui--ts-iso (raw)
  "Convert an org timestamp string RAW to an ISO string, or :null.
Keeps date-only vs date+time distinction based on RAW."
  (if (and raw (stringp raw) (> (length raw) 0))
      (let* ((time (org-time-string-to-time raw))
             (has-time (string-match-p "[0-9]\\{1,2\\}:[0-9]\\{2\\}" raw)))
        (format-time-string (if has-time "%Y-%m-%dT%H:%M" "%Y-%m-%d") time))
    :null))

;;;; ---- Reading ------------------------------------------------------------

(defun org-gui--entry-body ()
  "Return the body text of the entry at point, excluding child headings,
planning lines and property drawers."
  (save-excursion
    (org-back-to-heading t)
    (let ((next (save-excursion (if (outline-next-heading) (point) (point-max)))))
      (org-end-of-meta-data t)
      (let ((start (min (point) next)))
        (string-trim (buffer-substring-no-properties start next))))))

(defun org-gui--node-at-point (parent-id)
  "Build an alist describing the org entry at point, with PARENT-ID."
  (let* ((components (org-heading-components)) ; (level rlevel todo prio headline tags)
         (level (nth 0 components))
         (priority (nth 3 components))
         (begin (save-excursion (org-back-to-heading t) (point)))
         (id (format "n%d" begin)) ; stable within one parse; positions re-emitted each parse
         (org-id (org-entry-get nil "ID"))
         (todo (org-get-todo-state))
         (done (org-gui--b (org-entry-is-done-p)))
         (title (org-get-heading t t t t))
         (tags-local (org-get-tags nil t))
         (tags-all (org-get-tags))
         (raw-sched (org-entry-get nil "SCHEDULED"))
         (raw-dead (org-entry-get nil "DEADLINE"))
         (raw-closed (org-entry-get nil "CLOSED"))
         (raw-ts (org-entry-get nil "TIMESTAMP"))
         (scheduled (org-gui--ts-iso raw-sched))
         (deadline (org-gui--ts-iso raw-dead))
         (closed (org-gui--ts-iso raw-closed))
         (timestamp (org-gui--ts-iso raw-ts))
         (raw (save-excursion
                (org-back-to-heading t)
                (buffer-substring-no-properties
                 (line-beginning-position) (line-end-position))))
         (category (org-get-category))
         (deps-raw (org-entry-get nil "DEPENDS_ON"))
         (deadline-color (org-entry-get nil "DEADLINE_COLOR"))
         (body (org-gui--entry-body)))
    (list
     (cons 'id id)
     (cons 'begin begin)
     (cons 'level level)
     (cons 'parent (org-gui--s parent-id))
     (cons 'title (org-gui--s title))
     (cons 'todo (org-gui--s todo))
     (cons 'done done)
     (cons 'priority (if priority (char-to-string priority) :null))
     (cons 'tags (vconcat tags-local))
     (cons 'tagsAll (vconcat tags-all))
     (cons 'scheduled scheduled)
     (cons 'deadline deadline)
     (cons 'closed closed)
     (cons 'timestamp timestamp)
     (cons 'rawScheduled (org-gui--s raw-sched))
     (cons 'rawDeadline (org-gui--s raw-dead))
     (cons 'rawClosed (org-gui--s raw-closed))
     (cons 'raw (org-gui--s raw))
     (cons 'category (org-gui--s category))
     (cons 'orgId (org-gui--s org-id))
     (cons 'dependsOn (vconcat (and deps-raw (split-string deps-raw "[ ]+" t))))
     (cons 'deadlineColor (org-gui--s deadline-color))
     (cons 'body (org-gui--s body)))))

(defun org-gui--collect-nodes ()
  "Walk all headings in the current buffer in document order, returning a
list of node alists with parent links resolved via a level stack."
  (let ((nodes '())
        (stack '())) ; list of (level . id), nearest ancestor first
    (org-with-wide-buffer
     (goto-char (point-min))
     (while (re-search-forward org-heading-regexp nil t)
       (org-back-to-heading t)
       (let ((level (org-current-level)))
         ;; Pop ancestors that are not shallower than this heading.
         (while (and stack (>= (caar stack) level))
           (setq stack (cdr stack)))
         (let* ((parent-id (cdar stack))
                (node (org-gui--node-at-point parent-id))
                (id (cdr (assoc 'id node))))
           (push node nodes)
           (push (cons level id) stack)))
       (end-of-line)))
    (nreverse nodes)))

(defun org-gui-ping ()
  "Health check. Returns JSON with bridge + org versions."
  (json-serialize
   (list (cons 'ok t)
         (cons 'bridge org-gui-bridge-version)
         (cons 'org (org-version))
         (cons 'emacs emacs-version))))

(defun org-gui--doc-json (file)
  "Return JSON {file, title, nodes:[...]} for the current org buffer."
  (let* ((nodes (org-gui--collect-nodes))
         (title (or (cadar (org-collect-keywords '("TITLE"))) :null)))
    (json-serialize
     (list (cons 'file file)
           (cons 'title (org-gui--s (if (stringp title) title nil)))
           (cons 'todoKeywords (vconcat (delq nil (append org-todo-keywords-1 nil))))
           (cons 'doneKeywords (vconcat (delq nil (append org-done-keywords nil))))
           (cons 'nodes (vconcat nodes))))))

(defun org-gui-parse (file)
  "Parse FILE and return JSON {file, title, nodes:[...]}.
Opens (or reuses) the file buffer in this Emacs so edits round-trip."
  (with-current-buffer (find-file-noselect file)
    (org-gui--doc-json file)))

;;;; ---- Editing ------------------------------------------------------------
;; Mutators operate by buffer position (BEGIN, as returned in node.begin).
;; They edit the live buffer, SAVE it (so changes round-trip to disk and to
;; the user's Doom session), then return the freshly re-parsed document so
;; the caller gets up-to-date positions in a single round-trip.

(defun org-gui--num (v)
  "Coerce V to an integer. Args arrive from the app as strings."
  (cond ((numberp v) v)
        ((stringp v) (string-to-number v))
        (t 0)))

(defun org-gui--has-cookie-p (headline)
  "Non-nil when HEADLINE text contains a statistics cookie: [/] [%] [n/m] [n%]."
  (and (stringp headline)
       (string-match-p "\\[[0-9]*\\(?:%\\|/[0-9]*\\)\\]" headline)))

(defun org-gui--refresh-cookies ()
  "Recompute every [/]/[%] statistics cookie in the current buffer.
Handles both TODO-children cookies and checkbox cookies. Org only updates
progress cookies on certain interactive actions; when we mutate the tree
programmatically (add/remove a child, change a child's TODO state, refile, …)
or the user just types new entries/checkboxes, the cookie would otherwise go
stale. Widens internally so a narrowed (e.g. indirect) buffer is fully
covered. Wrapped in `ignore-errors' so a malformed tree never blocks a save."
  (ignore-errors
    (org-with-wide-buffer
     (org-update-statistics-cookies 'all))))

(defvar-local org-gui--managed nil
  "Non-nil in buffers org-GUI opened for editing (enables live cookie refresh).")

(defvar-local org-gui--cookie-tick nil
  "`buffer-chars-modified-tick' at the last cookie refresh, to skip redundant work.")

(defvar org-gui--idle-timer nil
  "Global idle timer that live-refreshes cookies in org-GUI-managed buffers.")

(defun org-gui--idle-refresh ()
  "When idle in a managed org buffer that changed since the last refresh,
recompute its statistics cookies so [/]/[%] track edits live."
  (when (and org-gui--managed (derived-mode-p 'org-mode))
    (let ((tick (buffer-chars-modified-tick)))
      (unless (eql tick org-gui--cookie-tick)
        (org-gui--refresh-cookies)
        (setq org-gui--cookie-tick (buffer-chars-modified-tick))))))

(defun org-gui--manage-buffer (buf)
  "Mark BUF as org-GUI-managed: refresh cookies on save and (live) when idle.
The idle baseline is seeded to the current tick so a freshly opened, unedited
buffer is never touched (so we don't spuriously mark it modified)."
  (when (buffer-live-p buf)
    (with-current-buffer buf
      (setq-local org-gui--managed t)
      (setq-local org-gui--cookie-tick (buffer-chars-modified-tick))
      (add-hook 'before-save-hook #'org-gui--refresh-cookies nil t))
    (unless org-gui--idle-timer
      (setq org-gui--idle-timer
            (run-with-idle-timer 0.6 t #'org-gui--idle-refresh)))))

(defun org-gui--with-heading (file begin body-fn)
  "In FILE's buffer, move to the heading at BEGIN, run BODY-FN, save, reparse."
  (let ((begin (org-gui--num begin)))
    (with-current-buffer (find-file-noselect file)
      (org-with-wide-buffer
       (goto-char (min begin (point-max)))
       (org-back-to-heading t)
       (funcall body-fn)
       (org-gui--refresh-cookies))
      (save-buffer)
      (org-gui--doc-json file))))

(defun org-gui-set-todo (file begin keyword)
  "Set (or clear, when KEYWORD is empty) the TODO state of the heading."
  (org-gui--with-heading
   file begin
   (lambda ()
     (if (string-empty-p keyword)
         (org-todo 'none)
       (org-todo keyword)))))

(defun org-gui-set-title (file begin title)
  "Replace just the headline text, preserving TODO/priority/tags."
  (org-gui--with-heading
   file begin (lambda () (org-edit-headline title))))

(defun org-gui-set-scheduled (file begin date)
  "Set SCHEDULED to DATE (e.g. \"2026-06-01\" or \"2026-06-01 14:00\"),
or remove it when DATE is empty."
  (org-gui--with-heading
   file begin
   (lambda ()
     (if (string-empty-p date)
         (org-schedule '(4))
       (org-schedule nil date)))))

(defun org-gui-set-deadline (file begin date)
  "Set DEADLINE to DATE, or remove it when DATE is empty."
  (org-gui--with-heading
   file begin
   (lambda ()
     (if (string-empty-p date)
         (org-deadline '(4))
       (org-deadline nil date)))))

(defun org-gui-set-priority (file begin prio)
  "Set priority to PRIO (\"A\"/\"B\"/...), or remove it when PRIO is empty."
  (org-gui--with-heading
   file begin
   (lambda ()
     (if (string-empty-p prio)
         (org-priority 'remove)
       (org-priority (string-to-char prio))))))

(defun org-gui-set-deadline-color (file begin color)
  "Set the :DEADLINE_COLOR: property on the heading at BEGIN, or clear it when
COLOR is empty. The GUI uses this CSS color to tint the deadline badge and the
matching tick on the milestone timeline."
  (org-gui--with-heading
   file begin
   (lambda ()
     (if (string-empty-p color)
         (org-entry-delete nil "DEADLINE_COLOR")
       (org-entry-put nil "DEADLINE_COLOR" color)))))

(defun org-gui-archive (file begin)
  "Archive the subtree at BEGIN by moving it to FILE_archive (org's default
archive location), then return the parsed (remaining) document."
  (let ((begin (org-gui--num begin))
        (archive-file (concat file "_archive")))
    (with-current-buffer (find-file-noselect file)
      (org-with-wide-buffer
       (goto-char (min begin (point-max)))
       (org-back-to-heading t)
       (let* ((start (point))
              (end (save-excursion (org-end-of-subtree t t) (point)))
              (text (buffer-substring-no-properties start end)))
         (delete-region start end)
         (org-gui--refresh-cookies) ; recount the (now smaller) parent's cookie
         (let ((coding-system-for-write 'utf-8))
           (with-current-buffer (find-file-noselect archive-file)
             (goto-char (point-max))
             (unless (bolp) (insert "\n"))
             (insert (string-trim-right text) "\n")
             (save-buffer)))))
      (save-buffer)
      (org-gui--doc-json file))))

(defun org-gui-start (file begin)
  "Start the task at BEGIN: set it to STRT and schedule it for today."
  (org-gui--with-heading
   file begin
   (lambda ()
     (org-todo "STRT")
     (org-schedule nil (format-time-string "%Y-%m-%d")))))

(defun org-gui-set-tags (file begin tags)
  "Set tags from TAGS (space- or colon-separated), or clear when empty."
  (org-gui--with-heading
   file begin
   (lambda ()
     (let ((lst (split-string tags "[ :]+" t)))
       (org-set-tags lst)))))

(defun org-gui-set-raw (file begin line)
  "Replace the entire heading LINE of the entry at BEGIN with new raw org text.
Lets the user type `TODO [#A] Title :tag:' directly; org re-parses it on save.
If LINE has no leading stars, the original level's stars are prepended so the
heading isn't accidentally demoted into body text."
  (let ((begin (org-gui--num begin)))
    (with-current-buffer (find-file-noselect file)
      (org-with-wide-buffer
       (goto-char (min begin (point-max)))
       (org-back-to-heading t)
       (let* ((lvl (or (org-current-level) 1))
              (text (string-trim-right line))
              (text (if (string-match-p "\\`\\*+[ \t]" text)
                        text
                      (concat (make-string lvl ?*) " "
                              (string-trim-left text "[* \t]+")))))
         (delete-region (line-beginning-position) (line-end-position))
         (goto-char (line-beginning-position))
         (insert text))
       (org-gui--refresh-cookies)) ; raw edit may add/remove a TODO or cookie
      (save-buffer)
      (org-gui--doc-json file))))

(defun org-gui-move-up (file begin)
  "Move the subtree at BEGIN up among its siblings (org M-up)."
  (org-gui--with-heading file begin (lambda () (ignore-errors (org-move-subtree-up)))))

(defun org-gui-move-down (file begin)
  "Move the subtree at BEGIN down among its siblings (org M-down)."
  (org-gui--with-heading file begin (lambda () (ignore-errors (org-move-subtree-down)))))

(defun org-gui-refile (file begin target-begin)
  "Move the subtree at BEGIN to become a child of the heading at TARGET-BEGIN.
Uses org-refile so levels are adjusted automatically. Returns the doc."
  (let ((begin (org-gui--num begin))
        (target-begin (org-gui--num target-begin)))
    (with-current-buffer (find-file-noselect file)
      (org-with-wide-buffer
       (goto-char (min target-begin (point-max)))
       (org-back-to-heading t)
       (let ((tpos (point))
             (theading (org-get-heading t t t t)))
         (goto-char (min begin (point-max)))
         (org-back-to-heading t)
         (org-refile nil nil (list theading file nil tpos)))
       (org-gui--refresh-cookies)) ; both old and new parents recount
      (save-buffer)
      (org-gui--doc-json file))))

(defun org-gui-reorder (file begin delta)
  "Move the subtree at BEGIN by DELTA positions among its siblings.
Positive DELTA moves down, negative up. Returns the parsed document."
  (let ((begin (org-gui--num begin))
        (delta (org-gui--num delta)))
    (with-current-buffer (find-file-noselect file)
      (org-with-wide-buffer
       (goto-char (min begin (point-max)))
       (org-back-to-heading t)
       (dotimes (_ (abs delta))
         (ignore-errors
           (if (> delta 0) (org-move-subtree-down) (org-move-subtree-up)))))
      (save-buffer)
      (org-gui--doc-json file))))

(defun org-gui-promote (file begin)
  "Promote the subtree at BEGIN one level (org M-S-left)."
  (org-gui--with-heading file begin (lambda () (ignore-errors (org-promote-subtree)))))

(defun org-gui-demote (file begin)
  "Demote the subtree at BEGIN one level (org M-S-right)."
  (org-gui--with-heading file begin (lambda () (ignore-errors (org-demote-subtree)))))

(defun org-gui-get-file (file)
  "Return JSON {text} with the entire buffer text of FILE."
  (with-current-buffer (find-file-noselect file)
    (json-serialize
     (list (cons 'text (buffer-substring-no-properties (point-min) (point-max)))))))

(defun org-gui-set-file (file text)
  "Replace the entire buffer of FILE with TEXT, save, and return the doc."
  (with-current-buffer (find-file-noselect file)
    (erase-buffer)
    (insert text)
    (unless (bolp) (insert "\n"))
    (org-gui--refresh-cookies)
    (save-buffer)
    (org-gui--doc-json file)))

(defvar-local org-gui--base-buffer nil
  "Base buffer backing an org-GUI indirect node buffer.")

(defvar org-gui--pending nil
  "Pending (FILE . BEGIN) for the next emacsclient frame to narrow to.")

;;;; ---- Terminal cursor sync (evil block/bar) ----------------------------
;; In a `-t' emacsclient frame, evil-mode doesn't change the visible cursor
;; shape the way it does in a GUI frame (the GUI uses frame parameters; the
;; terminal needs DECSCUSR `CSI Ps SP q' sequences). Hook the state
;; transitions and write the appropriate escape directly to the terminal so
;; xterm.js renders the right shape: block in normal/visual, bar in insert,
;; underline in replace.

(defun org-gui--decscusr (code)
  "Write a DECSCUSR escape with CODE to the controlling terminal."
  (ignore-errors (send-string-to-terminal (format "\e[%d q" code))))

(defun org-gui--evil-cursor-update (&rest _args)
  "Sync terminal cursor shape to the current evil state."
  (when (boundp 'evil-state)
    (cond
     ((eq evil-state 'insert)   (org-gui--decscusr 6))   ; steady bar
     ((eq evil-state 'replace)  (org-gui--decscusr 4))   ; steady underline
     (t                         (org-gui--decscusr 2))))) ; steady block

(defvar org-gui--cursor-hooks-installed nil
  "Non-nil once evil state-change hooks have been wired.")

(defun org-gui--install-cursor-hooks ()
  "Hook evil state changes so the terminal cursor follows the mode.
Idempotent: subsequent calls are no-ops."
  (unless org-gui--cursor-hooks-installed
    (when (require 'evil nil t)
      (add-hook 'evil-insert-state-entry-hook  #'org-gui--evil-cursor-update)
      (add-hook 'evil-insert-state-exit-hook   #'org-gui--evil-cursor-update)
      (add-hook 'evil-normal-state-entry-hook  #'org-gui--evil-cursor-update)
      (add-hook 'evil-visual-state-entry-hook  #'org-gui--evil-cursor-update)
      (add-hook 'evil-replace-state-entry-hook #'org-gui--evil-cursor-update)
      (add-hook 'evil-emacs-state-entry-hook   #'org-gui--evil-cursor-update)
      (setq org-gui--cursor-hooks-installed t))))

(defun org-gui--frame-setup ()
  "Run once on the next new server frame: show the pending node/file.
The frame is opened by `emacsclient -t' with NO file argument, so this hook
is solely responsible for choosing the buffer the frame displays. When BEGIN
> 0 we narrow (via an indirect buffer) to that subtree; when BEGIN is 0 we
just show the whole file. Using a plain `-t' frame (not `-t -e') keeps the
frame fully interactive (evil etc.)."
  (when org-gui--pending
    (let ((file (car org-gui--pending))
          (begin (cdr org-gui--pending)))
      (setq org-gui--pending nil)
      (remove-hook 'server-after-make-frame-hook #'org-gui--frame-setup)
      ;; In a terminal frame the evil cursor shape doesn't follow state on its
      ;; own. Install the DECSCUSR-emitting hooks the first time we open such
      ;; a frame, and seed the initial shape from the current state.
      (org-gui--install-cursor-hooks)
      (run-at-time 0.1 nil #'org-gui--evil-cursor-update)
      (when file
        (if (> begin 0)
            (ignore-errors (org-gui-edit-node file begin))
          (ignore-errors
            (let ((buf (find-file-noselect file)))
              (with-current-buffer buf (widen))
              (org-gui--manage-buffer buf) ; live + on-save cookie refresh
              (switch-to-buffer buf))))))))

(defun org-gui-arm-edit (file begin)
  "Arm narrowing for the next new frame (see `org-gui--frame-setup')."
  (setq org-gui--pending (cons file (org-gui--num begin)))
  (add-hook 'server-after-make-frame-hook #'org-gui--frame-setup))

(defun org-gui-edit-node (file begin)
  "Show ONLY the subtree at BEGIN in this frame, in an INDIRECT buffer narrowed
to it. Because it's a real (indirect) buffer, full org editing of the subtree
works and the user's own view of the file isn't disturbed. `C-x C-s' saves the
underlying file (indirect buffers have no file of their own)."
  (let* ((begin (org-gui--num begin))
         (base (find-file-noselect file))
         (name "*org-node*"))
    (with-current-buffer base (widen)) ; undo any prior narrowing of the base
    (when (get-buffer name) (kill-buffer name))
    (let ((ind (make-indirect-buffer base name t))) ; t = clone (org-mode, etc.)
      (switch-to-buffer ind)
      (with-current-buffer ind
        (widen)
        (goto-char (min begin (point-max)))
        (org-back-to-heading t)
        (org-narrow-to-subtree)
        (goto-char (point-min))
        ;; Ensure evil starts in normal state (cloned indirect buffers can land
        ;; without an initialized state).
        (when (and (bound-and-true-p evil-mode) (fboundp 'evil-normal-state))
          (evil-normal-state))
        (setq-local org-gui--base-buffer base)
        ;; Live (idle) cookie refresh while editing the indirect buffer, and
        ;; on-save refresh of the underlying file buffer.
        (org-gui--manage-buffer (current-buffer))
        (org-gui--manage-buffer base)
        ;; Buffer-local C-x C-s → save the underlying file.
        (use-local-map
         (make-composed-keymap
          (let ((m (make-sparse-keymap)))
            (define-key m (kbd "C-x C-s")
              (lambda ()
                (interactive)
                (with-current-buffer org-gui--base-buffer
                  ;; Refresh [/]/[%] cookies for any children added/edited in
                  ;; this frame before persisting to disk.
                  (org-with-wide-buffer (org-gui--refresh-cookies))
                  (save-buffer))
                (message "org-GUI: saved %s" (buffer-file-name org-gui--base-buffer))))
            m)
          (current-local-map)))))))

;;;; ---- Dependencies (DEPENDS_ON property of org IDs) ----------------------

(defun org-gui-add-dependency (file from-begin to-begin)
  "Record that the entry at TO-BEGIN depends on the entry at FROM-BEGIN.
FROM is the prerequisite, TO is the dependent (arrow points FROM -> TO). Stores
FROM's org ID in TO's DEPENDS_ON property (space-separated, deduped); both
entries are given an :ID: if they lack one. Returns the parsed document.

Uses markers so that creating FROM's :ID: drawer (which shifts buffer
positions) doesn't invalidate TO's location."
  (let ((from-begin (org-gui--num from-begin))
        (to-begin (org-gui--num to-begin)))
    (with-current-buffer (find-file-noselect file)
      (org-with-wide-buffer
       (let ((from-m (copy-marker (min from-begin (point-max))))
             (to-m (copy-marker (min to-begin (point-max)))))
         (goto-char from-m)
         (org-back-to-heading t)
         (let ((from-id (org-id-get-create)))
           (goto-char to-m)
           (org-back-to-heading t)
           (let ((to-id (org-id-get-create)))
             (unless (string= from-id to-id) ; no self-dependency
               (let* ((cur (org-entry-get nil "DEPENDS_ON"))
                      (ids (and cur (split-string cur "[ ]+" t))))
                 (unless (member from-id ids)
                   (org-entry-put nil "DEPENDS_ON"
                                  (string-join (append ids (list from-id)) " ")))))))
         (set-marker from-m nil)
         (set-marker to-m nil)))
      (save-buffer)
      (org-gui--doc-json file))))

(defun org-gui-remove-dependency (file from-begin to-begin)
  "Remove the dependency edge FROM -> TO: drop FROM's id from TO's DEPENDS_ON.
When the list becomes empty the property is deleted. Returns the document."
  (let ((from-begin (org-gui--num from-begin))
        (to-begin (org-gui--num to-begin)))
    (with-current-buffer (find-file-noselect file)
      (org-with-wide-buffer
       (goto-char (min from-begin (point-max)))
       (org-back-to-heading t)
       (let ((from-id (org-id-get)))
         (when from-id
           (goto-char (min to-begin (point-max)))
           (org-back-to-heading t)
           (let* ((cur (org-entry-get nil "DEPENDS_ON"))
                  (ids (and cur (split-string cur "[ ]+" t))))
             (when (member from-id ids)
               (setq ids (delete from-id ids))
               (if ids
                   (org-entry-put nil "DEPENDS_ON" (string-join ids " "))
                 (org-entry-delete nil "DEPENDS_ON")))))))
      (save-buffer)
      (org-gui--doc-json file))))

(defun org-gui-toggle-checkbox (file begin index)
  "Toggle the INDEX-th checkbox (0-based, document order) in the BODY of the
entry at BEGIN — i.e. the region between the heading's metadata and the next
heading, matching what the GUI shows on the node. Refreshes cookies, saves,
and returns the parsed document."
  (let ((begin (org-gui--num begin))
        (index (org-gui--num index)))
    (with-current-buffer (find-file-noselect file)
      (org-with-wide-buffer
       (goto-char (min begin (point-max)))
       (org-back-to-heading t)
       (let ((next (save-excursion (if (outline-next-heading) (point) (point-max))))
             (i 0) (done nil))
         (org-end-of-meta-data t)
         (while (and (not done)
                     (re-search-forward "^[ \t]*[-+*][ \t]+\\[\\([ xX-]\\)\\]" next t))
           (if (= i index)
               (progn (beginning-of-line) (org-toggle-checkbox) (setq done t))
             (setq i (1+ i)))))
       (org-gui--refresh-cookies))
      (save-buffer)
      (org-gui--doc-json file))))

(defun org-gui-get-subtree (file begin)
  "Return JSON {text} with the exact org text of the subtree at BEGIN."
  (let ((begin (org-gui--num begin)))
    (with-current-buffer (find-file-noselect file)
      (org-with-wide-buffer
       (goto-char (min begin (point-max)))
       (org-back-to-heading t)
       (let ((b (point))
             (e (save-excursion (org-end-of-subtree t t) (point))))
         (json-serialize
          (list (cons 'text (buffer-substring-no-properties b e)))))))))

(defun org-gui-set-subtree (file begin text)
  "Replace the whole subtree at BEGIN with TEXT, save, and return the doc.
A trailing newline is ensured so following content isn't merged in."
  (let ((begin (org-gui--num begin)))
    (with-current-buffer (find-file-noselect file)
      (org-with-wide-buffer
       (goto-char (min begin (point-max)))
       (org-back-to-heading t)
       (let ((b (point))
             (e (save-excursion (org-end-of-subtree t t) (point))))
         (delete-region b e)
         (goto-char b)
         (insert (string-trim-right text))
         (unless (bolp) (insert "\n")))
       (org-gui--refresh-cookies))
      (save-buffer)
      (org-gui--doc-json file))))

;;;; ---- Structure: create / add / delete -----------------------------------

(defun org-gui-create (file title)
  "Create FILE (if it doesn't exist / is empty) with an optional #+TITLE,
save it, and return the parsed (empty) document."
  (with-current-buffer (find-file-noselect file)
    (when (= (buffer-size) 0)
      (insert "#+TITLE: " (if (string-empty-p title) "Untitled" title) "\n\n"))
    (save-buffer)
    (org-gui--doc-json file)))

(defun org-gui-add-heading (file parent-begin title)
  "Add a heading titled TITLE. When PARENT-BEGIN > 0, insert it as the last
child of the heading at that position; otherwise append a top-level heading.
Returns the freshly parsed document."
  (let ((parent-begin (org-gui--num parent-begin))
        (title (if (string-empty-p title) "New heading" title)))
    (with-current-buffer (find-file-noselect file)
      (org-with-wide-buffer
       (if (> parent-begin 0)
           (let (lvl parent-line)
             (goto-char (min parent-begin (point-max)))
             (org-back-to-heading t)
             (setq lvl (org-current-level))
             (setq parent-line (buffer-substring-no-properties
                                (line-beginning-position) (line-end-position)))
             (org-end-of-subtree t t)
             (unless (bolp) (insert "\n"))
             ;; If the parent tracks progress with a [/]/[%] cookie, make the new
             ;; child a TODO — org only counts children that carry a todo keyword,
             ;; so a plain heading would never move the cookie.
             (insert (make-string (1+ lvl) ?*) " "
                     (if (org-gui--has-cookie-p parent-line) "TODO " "")
                     title "\n"))
         (progn
           (goto-char (point-max))
           (unless (bolp) (insert "\n"))
           (insert "* " title "\n")))
       (org-gui--refresh-cookies)) ; new child → parent's cookie gains a slot
      (save-buffer)
      (org-gui--doc-json file))))

(defun org-gui-delete (file begin)
  "Delete the subtree of the heading at BEGIN. Returns the parsed document."
  (let ((begin (org-gui--num begin)))
    (with-current-buffer (find-file-noselect file)
      (org-with-wide-buffer
       (goto-char (min begin (point-max)))
       (org-back-to-heading t)
       (org-cut-subtree)
       (org-gui--refresh-cookies)) ; parent loses a slot
      (save-buffer)
      (org-gui--doc-json file))))

(defun org-gui-set-body (file begin body)
  "Replace the body of the entry at BEGIN with BODY, leaving the heading,
planning lines, and property drawer intact. Used by the inline table editor
to round-trip cell edits back to the org file without disturbing children."
  (let ((begin (org-gui--num begin)))
    (with-current-buffer (find-file-noselect file)
      (org-with-wide-buffer
       (goto-char (min begin (point-max)))
       (org-back-to-heading t)
       (let ((next (save-excursion (if (outline-next-heading) (point) (point-max)))))
         (org-end-of-meta-data t)
         (let ((start (min (point) next)))
           (delete-region start next)
           (goto-char start)
           (let ((trimmed (string-trim-right (or body ""))))
             (when (> (length trimmed) 0)
               (insert trimmed)
               (unless (bolp) (insert "\n"))))))
       (org-gui--refresh-cookies))
      (save-buffer)
      (org-gui--doc-json file))))

(defun org-gui-add-table-child (file parent-begin)
  "Add a child heading 'Table' under PARENT-BEGIN containing a small starter
org-mode table. When PARENT-BEGIN is 0, the heading goes at top level. The
table syntax is minimally valid; Emacs aligns it on first TAB inside it."
  (let ((parent-begin (org-gui--num parent-begin))
        (table "| Col 1 | Col 2 | Col 3 |\n|-------+-------+-------|\n|       |       |       |\n|       |       |       |\n"))
    (with-current-buffer (find-file-noselect file)
      (org-with-wide-buffer
       (if (> parent-begin 0)
           (let (lvl parent-line)
             (goto-char (min parent-begin (point-max)))
             (org-back-to-heading t)
             (setq lvl (org-current-level))
             (setq parent-line (buffer-substring-no-properties
                                (line-beginning-position) (line-end-position)))
             (org-end-of-subtree t t)
             (unless (bolp) (insert "\n"))
             ;; Match org-gui-add-heading: if the parent tracks progress with a
             ;; cookie, make the new child a TODO so it's actually counted.
             (insert (make-string (1+ lvl) ?*) " "
                     (if (org-gui--has-cookie-p parent-line) "TODO " "")
                     "Table\n" table))
         (progn
           (goto-char (point-max))
           (unless (bolp) (insert "\n"))
           (insert "* Table\n" table)))
       (org-gui--refresh-cookies))
      (save-buffer)
      (org-gui--doc-json file))))

;;;; ---- Dispatch -----------------------------------------------------------
;; The app calls everything through `org-gui-call', which writes the result
;; JSON to OUTFILE (UTF-8) and returns t. This sidesteps emacsclient's
;; prin1 string-escaping entirely and is immune to the user's print-*
;; settings. Errors are captured and written as {\"error\": ...} JSON.

(defun org-gui-call (outfile fn &rest args)
  "Apply FN to ARGS (FN must return a JSON string), write result to OUTFILE."
  (let ((json
         (condition-case err
             (apply fn args)
           (error (json-serialize
                   (list (cons 'error (error-message-string err))))))))
    (let ((coding-system-for-write 'utf-8))
      (with-temp-file outfile
        (insert json)))
    t))

(provide 'org-gui-bridge)
;;; org-gui-bridge.el ends here
