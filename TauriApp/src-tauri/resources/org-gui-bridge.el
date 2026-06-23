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

;; Diagnostics only — surfaced in the parse payload so the UI can show which
;; bridge the daemon has. NO LONGER the reload gate (see
;; `org-gui-bridge--loaded-token'); editing this value does not affect reloads.
(defconst org-gui-bridge-version "0.2.125")

;; The app (Rust `org_call') writes this to a content-token of the bridge file
;; right after `load-file', then gates reloads on it: it reloads only when the
;; token differs. Keep this a plain `defvar' with value nil — `defvar' is a
;; no-op on an already-bound symbol, so a reload never clobbers the live token,
;; and a fresh daemon starts at nil so the first call always loads. Do NOT turn
;; this into a `defconst'/`setq' to a constant, or the reload-storm returns.
(defvar org-gui-bridge--loaded-token nil
  "Content token of the bridge file the app last loaded into this daemon.")

;;;; ---- Safe file visiting --------------------------------------------------
;; All reading/editing goes through one entry point so we can (a) refuse to run
;; a file's `Local Variables: eval:' block or auto-evaluate babel — closing a
;; code-execution channel via crafted .org content (e.g. a malicious calendar
;; event org-gcal writes verbatim into the file the daemon re-parses), and (b)
;; refresh the buffer when the file changed on disk underneath us (the user's
;; own Emacs, org-gcal in another process, git, or Dropbox sync) so a stale
;; buffer never silently clobbers external edits on the next save.

(defun org-gui--visit (file)
  "Return FILE's buffer for reading/editing, defensively.
Visits with `enable-local-variables' = :safe (apply only safe-listed locals,
never an `eval:' block), dir-locals off, and babel auto-eval disabled. If the
file changed on disk and our buffer has no unsaved edits, reload it first so we
do not overwrite the external change."
  (let ((enable-local-variables :safe)
        (enable-dir-local-variables nil)
        (org-confirm-babel-evaluate t))
    (let ((buf (find-file-noselect file)))
      (with-current-buffer buf
        (when (and (buffer-file-name)
                   (file-exists-p (buffer-file-name))
                   (not (buffer-modified-p))
                   (not (verify-visited-file-modtime buf)))
          (let ((inhibit-message t))
            (revert-buffer t t t))))
      buf)))

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

(defun org-gui--ts-end-iso (raw)
  "When org timestamp RAW carries a duration/range, return its END as an
ISO string; otherwise :null. Handles both same-day time ranges
\(\"<2026-06-06 Sat 10:00-11:30>\" → end 11:30 on the same day) and
multi-day date ranges (\"<2026-06-06>--<2026-06-08>\" → end 2026-06-08).
A plain single timestamp has no duration and yields :null."
  (if (and raw (stringp raw) (> (length raw) 0))
      (or (ignore-errors
            (with-temp-buffer
              (insert raw)
              (goto-char (point-min))
              (let ((ts (org-element-timestamp-parser)))
                (when (and ts (memq (org-element-property :type ts)
                                    '(active-range inactive-range)))
                  (let* ((ye (org-element-property :year-end ts))
                         (me (org-element-property :month-end ts))
                         (de (org-element-property :day-end ts))
                         (he (org-element-property :hour-end ts))
                         (mine (org-element-property :minute-end ts))
                         (has-time (and he mine)))
                    (when (and ye me de)
                      (format-time-string
                       (if has-time "%Y-%m-%dT%H:%M" "%Y-%m-%d")
                       (encode-time 0 (or mine 0) (or he 0) de me ye))))))))
          :null)
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
         ;; org-gcal events carry no :ID:; their stable id is the org-gcal
         ;; `entry-id' property. Fall back to it so calendar events get a stable
         ;; orgId (the timeline keys move-ghosts on this — without it, moving a
         ;; gcal event records no ghost and shows no Sync button).
         ;; Use org-gcal's configured entry-id property name (defaults to
         ;; "entry-id") so this matches what push/unsync/switch look up — keeping
         ;; orgId/entryId correct even for a customised `org-gcal-entry-id-property'.
         (org-gui--eid-prop (or (bound-and-true-p org-gcal-entry-id-property) "entry-id"))
         (org-id (or (org-entry-get nil "ID") (org-entry-get nil org-gui--eid-prop)))
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
         ;; End of a duration/range, when the timestamp carries one. Drives
         ;; the timeline's duration bars (a meeting 10:00-11:30, or a
         ;; multi-day <a>--<b> event).
         (scheduled-end (org-gui--ts-end-iso raw-sched))
         (deadline-end (org-gui--ts-end-iso raw-dead))
         (timestamp-end (org-gui--ts-end-iso raw-ts))
         (raw (save-excursion
                (org-back-to-heading t)
                (buffer-substring-no-properties
                 (line-beginning-position) (line-end-position))))
         (category (org-get-category))
         (deps-raw (org-entry-get nil "DEPENDS_ON"))
         (deadline-color (org-entry-get nil "DEADLINE_COLOR"))
         ;; Google Calendar id (org-gcal stamps this on imported events) —
         ;; drives the per-calendar colour tag on the timeline.
         (calendar-id (org-entry-get nil "calendar-id"))
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
     (cons 'scheduledEnd scheduled-end)
     (cons 'deadlineEnd deadline-end)
     (cons 'timestampEnd timestamp-end)
     (cons 'rawScheduled (org-gui--s raw-sched))
     (cons 'rawDeadline (org-gui--s raw-dead))
     (cons 'rawClosed (org-gui--s raw-closed))
     (cons 'raw (org-gui--s raw))
     (cons 'category (org-gui--s category))
     (cons 'orgId (org-gui--s org-id))
     ;; The org-gcal :entry-id: — a STABLE identity for a calendar event used to
     ;; relocate it for delete/unsync even if the buffer position drifted (the
     ;; file is shared via Dropbox / the user's own org-gcal).
     (cons 'entryId (org-gui--s (org-entry-get nil org-gui--eid-prop)))
     (cons 'dependsOn (vconcat (and deps-raw (split-string deps-raw "[ ]+" t))))
     (cons 'deadlineColor (org-gui--s deadline-color))
     (cons 'calendarId (org-gui--s calendar-id))
     (cons 'body (org-gui--s body)))))

(defun org-gui--collect-nodes ()
  "Walk all headings in the current buffer in document order, returning a
list of node alists with parent links resolved via a level stack.

Iterates with `outline-next-heading', which always advances point to the
NEXT heading and so guarantees forward progress. The previous
implementation used a manual `re-search-forward' + `org-back-to-heading'
+ `end-of-line' dance that could INFINITE-LOOP on malformed or empty
headings — e.g. a bare \"*\" or \"**\" line with no title text, which
`org-back-to-heading' resolves backward so the same match is found over
and over. Files with such lines (common in quick-jotted planners) would
hang every parse. Each heading's processing is wrapped in
`ignore-errors' so one weird heading can't abort the whole document."
  (let ((nodes '())
        (stack '())) ; list of (level . id), nearest ancestor first
    (org-with-wide-buffer
     (let ((process
            (lambda ()
              (ignore-errors
                (let ((level (org-current-level)))
                  (when level
                    ;; Pop ancestors that are not shallower than this heading.
                    (while (and stack (>= (caar stack) level))
                      (setq stack (cdr stack)))
                    (let* ((parent-id (cdar stack))
                           (node (org-gui--node-at-point parent-id))
                           (id (cdr (assoc 'id node))))
                      (push node nodes)
                      (push (cons level id) stack))))))))
       (goto-char (point-min))
       ;; `outline-next-heading' moves to the NEXT heading after point, so if
       ;; the buffer starts DIRECTLY with a heading (no #+TITLE/preamble) it
       ;; would skip that first one. Handle the at-point heading explicitly,
       ;; then iterate the rest.
       (when (org-at-heading-p) (funcall process))
       (while (outline-next-heading) (funcall process))))
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
  (with-current-buffer (org-gui--visit file)
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
    (with-current-buffer (org-gui--visit file)
      (org-with-wide-buffer
       (goto-char (min begin (point-max)))
       (org-back-to-heading t)
       (funcall body-fn)
       (org-gui--refresh-cookies))
      (save-buffer)
      (org-gui--doc-json file))))

(defun org-gui-set-todo (file begin keyword)
  "Set (or clear, when KEYWORD is empty) the TODO state of the heading.
After the (org-todo …) call, verifies that the heading's state actually
changed to the requested KEYWORD. Org's built-in blockers
(`org-enforce-todo-dependencies', `org-blocker-hook',
`org-enforce-todo-checkbox-dependencies') can refuse DONE transitions
when sub-tasks or DEPENDS_ON prerequisites are unfinished — and they do
so silently, leaving the state unchanged. From the GUI that looks like
the click did nothing. Signal a diagnostic error instead so the frontend
can surface a toast explaining what's blocking the change."
  (let ((begin (org-gui--num begin)))
    (with-current-buffer (org-gui--visit file)
      (org-with-wide-buffer
       (goto-char (min begin (point-max)))
       (org-back-to-heading t)
       (if (string-empty-p keyword)
           (org-todo 'none)
         (org-todo keyword))
       (let ((after (org-get-todo-state)))
         (when (and (not (string-empty-p keyword))
                    (not (and after (string= after keyword))))
           (error
            "Org refused to change state to %s — current state remains %s. \
Likely cause: org-enforce-todo-dependencies or DEPENDS_ON \
prerequisites are blocking the transition (e.g. unfinished sub-tasks)."
            keyword (or after "none"))))
       (org-gui--refresh-cookies))
      (save-buffer)
      (org-gui--doc-json file))))

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

(defun org-gui--fmt-inner-ts (s)
  "Format a date string S (e.g. \"2026-06-10\" or \"2026-06-10 09:00\")
into a canonical org INNER timestamp body \"2026-06-10 Wed\" /
\"2026-06-10 Wed 09:00\". Returns nil for empty S."
  (when (and s (stringp s) (> (length (string-trim s)) 0))
    (let* ((s (string-trim s))
           (time (org-time-string-to-time s))
           (has-time (string-match-p "[0-9]\\{1,2\\}:[0-9]\\{2\\}" s)))
      (format-time-string (if has-time "%Y-%m-%d %a %H:%M" "%Y-%m-%d %a") time))))

(defconst org-gui--ts-token-re
  "<[0-9]\\{4\\}-[0-9]\\{2\\}-[0-9]\\{2\\}[^>\n]*>\\(?:--<[0-9]\\{4\\}-[0-9]\\{2\\}-[0-9]\\{2\\}[^>\n]*>\\)?"
  "Matches an active timestamp token, or active timestamp RANGE token, anywhere
on a line — e.g. \"<2026-06-10 Wed 14:00-15:30>\" or \"<a>--<b>\". Used to find
THE event/span timestamp surgically (org-gcal stores it inside the :org-gcal:
drawer; app duration nodes store it as a standalone body line).")

(defun org-gui--write-body-timestamp (ts)
  "Replace the FIRST active timestamp (or range) anywhere in the current entry
— its body OR a drawer such as :org-gcal:, where org-gcal stores the event time
— with TS (a fully-formed \"<...>\" / \"<...>--<...>\" string), preserving the
REST of the entry (the description text, other dates, drawers). If the entry
has no timestamp, insert TS right after the property drawer. When TS is
nil/empty, delete the first timestamp's enclosing line.

This is surgical — exactly ONE timestamp token is touched — so it can never
destroy the user's notes (the data-loss bug) AND it correctly rewrites the
event time even when org-gcal keeps it inside the :org-gcal: drawer (the
in-drawer case the previous strip-based version missed, which reintroduced
duplicate events on a calendar drag)."
  (org-back-to-heading t)
  (let* ((hp (point))
         (end (save-excursion (goto-char hp)
                              (if (outline-next-heading) (point) (point-max))))
         ;; Start AFTER planning + the property drawer, but BEFORE any content
         ;; drawer — so the search reaches a timestamp inside :org-gcal:.
         (start (save-excursion (org-end-of-meta-data) (point)))
         (have (and ts (> (length ts) 0))))
    (save-excursion
      (goto-char start)
      (cond
       ((re-search-forward org-gui--ts-token-re end t)
        (if have
            (replace-match ts t t)
          ;; Clearing: drop the timestamp; if its line is now blank, remove it.
          (replace-match "" t t)
          (when (looking-at "[ \t]*$")
            (delete-region (line-beginning-position)
                           (min (1+ (line-end-position)) (point-max))))))
       (have
        (goto-char start)
        (insert ts "\n"))))))

(defun org-gui-set-timestamp-range (file begin start end)
  "Set the entry at BEGIN to carry a plain active timestamp spanning START
to END (a date range / duration), as the first line of the entry body.
  - START + END  → \"<start>--<end>\" (multi-day, or a same-day timed block)
  - START only   → \"<start>\" (single active timestamp)
  - both empty   → removes the entry's existing active timestamp
Only standalone active-timestamp lines are replaced; planning lines, drawers
and the user's prose are left untouched. The app builds START/END from the
start/end pickers."
  (org-gui--with-heading
   file begin
   (lambda ()
     (let ((sfmt (org-gui--fmt-inner-ts start))
           (efmt (org-gui--fmt-inner-ts end)))
       (org-gui--write-body-timestamp
        (and sfmt (if efmt (format "<%s>--<%s>" sfmt efmt) (format "<%s>" sfmt))))))))

(defun org-gui--set-body-timestamp (start end)
  "At the current heading, replace the entry-body active timestamp with
\"<START>--<END>\" (or \"<START>\"); empty START removes it. START/END are
canonical inner-timestamp bodies as produced by `org-gui--fmt-inner-ts'.
Drawers and prose are preserved."
  (org-gui--write-body-timestamp
   (and start (> (length start) 0)
        (if (and end (> (length end) 0))
            (format "<%s>--<%s>" start end)
          (format "<%s>" start)))))

(defun org-gui-set-span (file begin start end)
  "Set a node's SPAN (duration) from START to END. START/END are
\"YYYY-MM-DD\" or \"YYYY-MM-DD HH:MM\" (END may be empty). The org
representation is chosen to match the user's mental model and org's own
limits, and the OTHER representation is cleared so the node carries
exactly one span:
  - empty START          → clear SCHEDULED time-range AND any body span
  - same calendar day    → SCHEDULED (a <date hh:mm-hh:mm> time-range when
                           both ends carry a time, else a single date/time),
                           because a same-day duration is naturally the
                           scheduled task's own block; clears the body span
  - different days        → a plain active <start>--<end> body timestamp
                           (org's SCHEDULED can't hold a multi-day range);
                           clears SCHEDULED so there's no duplicate point
Returns the freshly parsed doc."
  (org-gui--with-heading
   file begin
   (lambda ()
     (let* ((s (string-trim (or start "")))
            (e (string-trim (or end ""))))
       (cond
        ((string-empty-p s)
         (ignore-errors (org-schedule '(4)))
         (org-gui--set-body-timestamp nil nil))
        (t
         (let* ((s-date (substring s 0 (min 10 (length s))))
                (e-date (when (>= (length e) 10) (substring e 0 10)))
                (multi (and e-date (not (string= s-date e-date))))
                (s-time (when (string-match "\\([0-9]\\{1,2\\}:[0-9]\\{2\\}\\)" s)
                          (match-string 1 s)))
                (e-time (when (and (> (length e) 0)
                                   (string-match "\\([0-9]\\{1,2\\}:[0-9]\\{2\\}\\)" e))
                          (match-string 1 e))))
           (if multi
               (progn
                 ;; multi-day → body timestamp range; drop the SCHEDULED point.
                 (ignore-errors (org-schedule '(4)))
                 (org-gui--set-body-timestamp (org-gui--fmt-inner-ts s)
                                              (org-gui--fmt-inner-ts e)))
             ;; same day (or no end) → SCHEDULED; clear any body span.
             (org-gui--set-body-timestamp nil nil)
             (let ((sched (cond
                           ((and s-time e-time) (format "%s %s-%s" s-date s-time e-time))
                           (s-time (format "%s %s" s-date s-time))
                           (t s-date))))
               (org-schedule nil sched))))))))))

(defun org-gui-gcal-move (file begin start end)
  "Move a Google-calendar event at BEGIN to START..END by rewriting its BODY
active timestamp IN PLACE, in org-gcal's own native shape so the next two-way
sync can push the change (and so there is exactly ONE timeline entry — never a
SCHEDULED line beside the untouched gcal timestamp, which is what produced the
duplicate). START/END are \"YYYY-MM-DD\" or \"YYYY-MM-DD HH:MM\":
  - same calendar day, both timed → <DATE DOW HH:MM-HH:MM> (org-gcal's form)
  - different days                → <START>--<END>
  - START only / all-day          → <START>
Existing body timestamp line(s) are replaced; the :PROPERTIES: and :org-gcal:
description drawers and any SCHEDULED/DEADLINE planning are left intact."
  (org-gui--with-heading
   file begin
   (lambda ()
     (org-back-to-heading t)
     (let* ((s (string-trim (or start "")))
            (e (string-trim (or end "")))
            (s-date (when (>= (length s) 10) (substring s 0 10)))
            (e-date (when (>= (length e) 10) (substring e 0 10)))
            (s-time (when (string-match "\\([0-9]\\{1,2\\}:[0-9]\\{2\\}\\)" s)
                      (match-string 1 s)))
            (e-time (when (and (> (length e) 0)
                               (string-match "\\([0-9]\\{1,2\\}:[0-9]\\{2\\}\\)" e))
                      (match-string 1 e)))
            (multi (and e-date (not (string= s-date e-date))))
            (same-day (and s-date e-date (string= s-date e-date)))
            (ts (cond
                 ((string-empty-p s) nil)
                 ((and same-day s-time e-time)
                  ;; date-only inner (no start time) + the HH:MM-HH:MM range
                  (format "<%s %s-%s>" (org-gui--fmt-inner-ts s-date) s-time e-time))
                 ((and e-date (not same-day))
                  (format "<%s>--<%s>"
                          (org-gui--fmt-inner-ts s) (org-gui--fmt-inner-ts e)))
                 (t (format "<%s>" (org-gui--fmt-inner-ts s)))))
            ;; The org-schedule INNER form (no brackets) for the SCHEDULED case.
            (sched (cond
                    ((string-empty-p s) nil)
                    ((and s-time e-time) (format "%s %s-%s" s-date s-time e-time))
                    (s-time (format "%s %s" s-date s-time))
                    (t s-date))))
       ;; Update the time WHERE org-gcal reads it (org-gcal--get-time-and-desc
       ;; prefers SCHEDULED). Events org-gui created from a scheduled task keep
       ;; their time in SCHEDULED with an empty :org-gcal: drawer; fetched
       ;; events keep it in the drawer. A multi-day move can't live in SCHEDULED
       ;; (org limitation), so it always uses the drawer.
       (if (and (org-entry-get nil "SCHEDULED") (not multi))
           (if sched (org-schedule nil sched) (ignore-errors (org-schedule '(4))))
         (when multi (ignore-errors (org-schedule '(4))))
         ;; Rewrite only the event timestamp (body OR :org-gcal: drawer); the
         ;; description and the user's notes are left intact.
         (org-gui--write-body-timestamp ts))))))

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
archive location), then return the parsed (remaining) document.
The archive copy is written and saved to disk FIRST; the source subtree is
deleted only after that succeeds — so if the archive write fails (unwritable
path, permission denied, disk full) the subtree is never lost. Belt-and-braces,
the deletion is wrapped so any later error re-inserts the text."
  (let ((begin (org-gui--num begin))
        (archive-file (concat file "_archive")))
    (with-current-buffer (org-gui--visit file)
      (org-with-wide-buffer
       (goto-char (min begin (point-max)))
       (org-back-to-heading t)
       (let* ((start (point))
              (end (save-excursion (org-end-of-subtree t t) (point)))
              (text (buffer-substring-no-properties start end)))
         ;; 1. Persist the archive copy and confirm it landed before touching
         ;;    the source.
         (let ((coding-system-for-write 'utf-8))
           (with-current-buffer (find-file-noselect archive-file)
             (goto-char (point-max))
             (unless (bolp) (insert "\n"))
             (insert (string-trim-right text) "\n")
             (save-buffer)))
         ;; 2. Now remove the source subtree; restore it if anything throws
         ;;    before we leave a consistent buffer.
         (let ((done nil))
           (unwind-protect
               (progn
                 (delete-region start end)
                 (org-gui--refresh-cookies) ; recount the parent's cookie
                 (setq done t))
             (unless done
               (goto-char start)
               (insert text))))))
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
  "Set tags from TAGS (space- or colon-separated), or clear when empty.
Duplicates are removed (case-sensitively, order preserved) so a free-text
\"add tag\" can never write `:work:work:'."
  (org-gui--with-heading
   file begin
   (lambda ()
     (let ((lst (delete-dups (split-string tags "[ :]+" t))))
       (org-set-tags lst)))))

(defun org-gui-add-tag-many (file begins tag)
  "Add TAG to every heading whose buffer position is in BEGINS.
BEGINS is a comma-separated list of integers. Existing tags are preserved;
the tag is deduped per node. One bridge round-trip handles N nodes so a
multi-select 'apply tag' action doesn't blow up the wire for big selections."
  (let ((begin-list (mapcar #'string-to-number (split-string begins "[ ,]+" t)))
        (tag (string-trim tag)))
    (when (string-empty-p tag)
      (error "Tag must not be empty"))
    (with-current-buffer (org-gui--visit file)
      (org-with-wide-buffer
       (dolist (b begin-list)
         (ignore-errors
           (goto-char (min b (point-max)))
           (org-back-to-heading t)
           (let ((existing (org-get-tags nil t)))
             (unless (member tag existing)
               (org-set-tags (append existing (list tag)))))))
       (org-gui--refresh-cookies))
      (save-buffer)
      (org-gui--doc-json file))))

(defun org-gui-set-raw (file begin line)
  "Replace the entire heading LINE of the entry at BEGIN with new raw org text.
Lets the user type `TODO [#A] Title :tag:' directly; org re-parses it on save.
If LINE has no leading stars, the original level's stars are prepended so the
heading isn't accidentally demoted into body text."
  (let ((begin (org-gui--num begin)))
    (with-current-buffer (org-gui--visit file)
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

(defun org-gui--resolve-heading (begin expected-title)
  "Resolve the position of the heading the GUI INTENDS to act on.
Trust BEGIN when the heading there still matches EXPECTED-TITLE (or no title was
supplied). Otherwise the file shifted on disk since the GUI parsed it — org-gcal,
Dropbox or another Emacs edited it — so a raw buffer position now points at the
WRONG heading (e.g. a neighbouring calendar event). Relocate to the UNIQUE
heading titled EXPECTED-TITLE, or signal an error so the caller ABORTS rather
than silently mutating the wrong subtree. Leaves point on the resolved heading."
  (let ((expected (and (stringp expected-title)
                       (not (string-empty-p expected-title))
                       expected-title)))
    (goto-char (min (max 1 begin) (point-max)))
    (let ((at (and (ignore-errors (org-back-to-heading t) t)
                   (org-get-heading t t t t))))
      (cond
       ((and at (or (null expected) (string= at expected)))
        (point))
       ((null expected)
        (error "Couldn't locate the heading — refresh the file and try again"))
       (t
        (let (matches)
          (goto-char (point-min))
          (while (re-search-forward "^\\*+[ \t]" nil t)
            (when (string= (org-get-heading t t t t) expected)
              (push (line-beginning-position) matches)))
          (cond
           ((= (length matches) 1)
            (goto-char (car matches))
            (point))
           ((> (length matches) 1)
            (error "\"%s\" appears more than once and the file moved — refresh and try again" expected))
           (t
            (error "\"%s\" not found — the file changed on disk; refresh and try again" expected)))))))))

(defun org-gui-refile (file begin target-begin &optional src-title tgt-title)
  "Move the subtree at BEGIN to become a child of the heading at TARGET-BEGIN.
SRC-TITLE / TGT-TITLE are the titles the GUI saw; when supplied they guard
against a stale BEGIN landing on the wrong heading after an external edit (a
mismatch aborts instead of corrupting the file). Uses org-refile so levels
adjust automatically. Returns the doc."
  (let ((begin (org-gui--num begin))
        (target-begin (org-gui--num target-begin)))
    (with-current-buffer (org-gui--visit file)
      (org-with-wide-buffer
       (let* ((spos (org-gui--resolve-heading begin src-title))
              ;; A MARKER, not an int: if the source is BEFORE the target,
              ;; cutting it would otherwise shift the target's position out from
              ;; under us. The marker tracks the target heading across the cut.
              (tpos (copy-marker (org-gui--resolve-heading target-begin tgt-title))))
         (goto-char tpos)
         (let ((theading (org-get-heading t t t t)))
           (goto-char spos)
           (org-refile nil nil (list theading file nil tpos)))
         (set-marker tpos nil))
       (org-gui--refresh-cookies)) ; both old and new parents recount
      (save-buffer)
      (org-gui--doc-json file))))

(defun org-gui-reorder (file begin delta)
  "Move the subtree at BEGIN by DELTA positions among its siblings.
Positive DELTA moves down, negative up. Returns the parsed document."
  (let ((begin (org-gui--num begin))
        (delta (org-gui--num delta)))
    (with-current-buffer (org-gui--visit file)
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
  (with-current-buffer (org-gui--visit file)
    (json-serialize
     (list (cons 'text (buffer-substring-no-properties (point-min) (point-max)))))))

(defun org-gui-set-file (file text)
  "Replace the entire buffer of FILE with TEXT, save, and return the doc."
  (with-current-buffer (org-gui--visit file)
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

(defun org-gui--evil-cursor-tick ()
  "Re-apply the DECSCUSR escape after each command in a terminal frame.
Emacs's display engine and some packages re-emit cursor escapes on redraw,
which clobbered our state-driven shape (cursor reverted to block whenever
the user moved a line in insert mode, for example). Repeating it post-
command keeps the shape sticky for the cost of one short escape per
keystroke, which is invisible."
  (when (and (boundp 'evil-state) (not (display-graphic-p)))
    (org-gui--evil-cursor-update)))

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
      ;; Re-apply on every command so the shape sticks across redraws that
      ;; would otherwise reset it back to the terminal default.
      (add-hook 'post-command-hook             #'org-gui--evil-cursor-tick)
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
        ;; Try to narrow to the subtree; if BEGIN is 0 OR the narrowing fails
        ;; for any reason (stale position, weird heading, …) FALL BACK to the
        ;; whole file widened. The frame must NEVER be left on *scratch* or a
        ;; broken buffer — it should always be something the user can edit.
        (let ((shown (and (> begin 0)
                          (ignore-errors (org-gui-edit-node file begin) t))))
          (unless shown
            (ignore-errors
              (let ((buf (org-gui--visit file)))
                (with-current-buffer buf (widen))
                (org-gui--manage-buffer buf) ; live + on-save cookie refresh
                (switch-to-buffer buf)))))))))

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
         (base (org-gui--visit file))
         (name "*org-node*"))
    (with-current-buffer base (widen)) ; undo any prior narrowing of the base
    ;; Drop any leftover indirect buffer from a prior edit WITHOUT prompting.
    ;; A modified buffer, or one of the user's `kill-buffer-query-functions',
    ;; would otherwise pop a yes/no in the NEW frame's minibuffer — the frame
    ;; then looks frozen (keystrokes go to the prompt, not the node) and only a
    ;; daemon restart clears it. Bind the query functions away and clear the
    ;; modified flag so the kill is always silent.
    (when (get-buffer name)
      (let ((kill-buffer-query-functions nil))
        (ignore-errors (with-current-buffer name (set-buffer-modified-p nil)))
        (ignore-errors (kill-buffer name))))
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
    (with-current-buffer (org-gui--visit file)
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
    (with-current-buffer (org-gui--visit file)
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
    (with-current-buffer (org-gui--visit file)
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
    (with-current-buffer (org-gui--visit file)
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
    (with-current-buffer (org-gui--visit file)
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
  (with-current-buffer (org-gui--visit file)
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
    (with-current-buffer (org-gui--visit file)
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
       ;; Point now sits just past the inserted heading line — step back onto it
       ;; and stamp a unique :ID:. Without this, every heading the GUI creates is
       ;; titled "New heading" and (lacking an id) shares ONE title-based stable
       ;; key, so they all pile onto a single canvas position and drag together.
       ;; An id also lets a heading keep its position when you rename it.
       (forward-line -1)
       (org-back-to-heading t)
       (unless (org-entry-get nil "ID")
         (org-entry-put nil "ID" (org-id-new)))
       (org-gui--refresh-cookies)) ; new child → parent's cookie gains a slot
      (save-buffer)
      (org-gui--doc-json file))))

(defun org-gui-delete (file begin &optional title)
  "Delete the subtree of the heading at BEGIN. TITLE (optional) is the heading
the GUI meant to delete; when supplied it guards against a stale BEGIN landing
on the wrong heading after an external edit (relocating to the unique heading
with that title, or aborting). Returns the parsed document."
  (let ((begin (org-gui--num begin)))
    (with-current-buffer (org-gui--visit file)
      (org-with-wide-buffer
       (goto-char (org-gui--resolve-heading begin title))
       (org-cut-subtree)
       (org-gui--refresh-cookies)) ; parent loses a slot
      (save-buffer)
      (org-gui--doc-json file))))

(defun org-gui-set-body (file begin body)
  "Replace the body of the entry at BEGIN with BODY, leaving the heading,
planning lines, and property drawer intact. Used by the inline table editor
to round-trip cell edits back to the org file without disturbing children."
  (let ((begin (org-gui--num begin)))
    (with-current-buffer (org-gui--visit file)
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
    (with-current-buffer (org-gui--visit file)
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

;;;; ---- Google Calendar (org-gcal) -----------------------------------------
;; org-gcal is installed self-contained into ~/.org-gui/elpa (independent of
;; the user's Doom/straight setup) by the app's `gcal_install' Rust command,
;; and loaded from there on demand. OAuth tokens persist in a dedicated
;; plstore so the user authorises once.

(defconst org-gui--gcal-dir (expand-file-name "~/.org-gui/elpa")
  "Self-contained package dir for org-gcal and its dependencies.")

(defun org-gui--scrub-secrets (s)
  "Mask OAuth token/secret values inside string S so an error message can be
shown (or screenshotted) without exposing credentials. Truncates long output."
  (let ((s (or s "")))
    (dolist (re '("\\(\"\\(?:access\\|refresh\\|id\\)_token\"[ \t]*:[ \t]*\"\\)[^\"]*"
                  "\\(\"client_secret\"[ \t]*:[ \t]*\"\\)[^\"]*"
                  "\\(client_secret=\\)[^&\"' \t\n]*"
                  "\\(\\(?:access\\|refresh\\)_token=\\)[^&\"' \t\n]*"))
      (setq s (replace-regexp-in-string re "\\1<redacted>" s t)))
    (truncate-string-to-width s 300 nil nil "…")))

(defun org-gui--gcal-curl-post (url data)
  "POST form-encoded DATA to URL with curl, returning parsed JSON (alist).
This replaces oauth2-auto's `url-retrieve-synchronously' for the OAuth
token exchange. That call DEADLOCKS in our headless daemon because it runs
inside the aio continuation resumed from the loopback server's process
callback, where a nested Emacs-network synchronous wait never completes.
`call-process' (a real curl subprocess) blocks cleanly in ANY context —
it doesn't touch Emacs's network event loop — so it just works."
  (with-temp-buffer
    (let ((status (call-process "curl" nil t nil
                                "-sS" "--max-time" "30"
                                "-X" "POST"
                                "-H" "Content-Type: application/x-www-form-urlencoded"
                                "--data" data
                                url)))
      (goto-char (point-min))
      (let ((parsed (condition-case _
                        ;; Native parser (Emacs 27+), symbol keys.
                        (json-parse-buffer :object-type 'alist :array-type 'list
                                           :null-object nil :false-object nil)
                      (error nil))))
        (or parsed
            (error "OAuth token request failed (curl status %s): %s"
                   status (org-gui--scrub-secrets (buffer-string))))))))

(defun org-gui--install-oauth2-curl-request ()
  "Redefine `oauth2-auto--request' to POST via curl (see
`org-gui--gcal-curl-post'). Kept as an `aio-defun' so its `aio-await'
callers are unchanged; the body just runs synchronous curl instead of the
deadlocking `url-retrieve-synchronously'. Idempotent; no-op without curl."
  (when (and (fboundp 'oauth2-auto--request)
             (fboundp 'aio-defun)
             (executable-find "curl"))
    (eval
     '(aio-defun oauth2-auto--request (provider url-key data-keys extra-alist)
        (let* ((provider-info (oauth2-auto--provider-info provider))
               (url (cdr (assoc url-key provider-info)))
               (data-alist (oauth2-auto--craft-request-alist
                            provider-info data-keys extra-alist))
               (data (oauth2-auto--urlify-request data-alist))
               (response (org-gui--gcal-curl-post url data)))
          (cond
           ((assoc 'error response)
            ;; Surface ONLY Google's error/error_description — never the
            ;; request alist (client_secret) or the response (refresh_token),
            ;; which would otherwise be painted onto the GUI error toast and
            ;; any screenshot of it.
            (error "Google OAuth error: %s"
                   (or (cdr (assoc 'error_description response))
                       (cdr (assoc 'error response))
                       "the token request was rejected")))
           (t response))))
     t)
    t))

(defconst org-gui--gcal-token-file (expand-file-name "~/.org-gui/gcal-tokens.el")
  "Plaintext (chmod 600) store for OAuth tokens, replacing oauth2-auto's
encrypted plstore — whose GPG encryption HANGS in our headless daemon
\(no pinentry to answer the passphrase prompt). On the user's own machine,
app-private + owner-only, this is an acceptable tradeoff for a working sync.")

(defun org-gui--gcal-token-db ()
  "Read the token DB (alist of id→plist) from `org-gui--gcal-token-file'."
  (when (file-exists-p org-gui--gcal-token-file)
    (ignore-errors
      (with-temp-buffer
        (insert-file-contents org-gui--gcal-token-file)
        (goto-char (point-min))
        (read (current-buffer))))))

(defun org-gui--save-token-db (db)
  "Persist token DB to `org-gui--gcal-token-file', CREATED owner-only (0600)
from the start. `with-file-modes' sets the creation mask so there is no
world-readable window between create and chmod (the previous TOCTOU)."
  (with-file-modes #o600
    (with-temp-file org-gui--gcal-token-file
      (let ((print-level nil) (print-length nil))
        (prin1 db (current-buffer)))))
  (ignore-errors (set-file-modes org-gui--gcal-token-file #o600)))

(defun org-gui--install-token-store-override ()
  "Replace oauth2-auto's plstore read/write with a plaintext Lisp file so the
token actually PERSISTS (the encrypted plstore write deadlocks the daemon on
a GPG prompt). Idempotent."
  (when (and (fboundp 'oauth2-auto--compute-id)
             (not (get 'oauth2-auto--plstore-write 'org-gui-plain-override)))
    (defalias 'oauth2-auto--plstore-write
      (lambda (username provider plist)
        (let* ((id (oauth2-auto--compute-id username provider))
               (db (seq-remove (lambda (e) (equal (car e) id))
                               (org-gui--gcal-token-db))))
          (push (cons id plist) db)
          (org-gui--save-token-db db)
          plist)))
    (defalias 'oauth2-auto--plstore-read
      (lambda (username provider)
        (cdr (assoc (oauth2-auto--compute-id username provider)
                    (org-gui--gcal-token-db)))))
    (put 'oauth2-auto--plstore-write 'org-gui-plain-override t)
    t))

(defun org-gui--gcal-load ()
  "Load org-gcal from the app-private package dir. Returns t when org-gcal
is available (installed + required), nil otherwise. Points org-gcal's
OAuth token store at an app-scoped plstore so authorisation persists and
never collides with the user's own org-gcal setup."
  (ignore-errors
    (let ((package-user-dir org-gui--gcal-dir))
      (require 'package)
      (package-initialize)
      (when (require 'org-gcal nil t)
        (require 'oauth2-auto nil t)
        (require 'deferred nil t)
        (require 'aio nil t)
        (require 'request nil t)
        (when (boundp 'oauth2-auto-plstore)
          (setq oauth2-auto-plstore (expand-file-name "~/.org-gui/oauth2.plist")))
        ;; Use the automatic browser+loopback OAuth flow: open Google's
        ;; consent page in the system browser and capture the redirect on a
        ;; localhost port — NOT the copy-paste-the-code fallback. This is the
        ;; "click → log in → done" login portal.
        (when (boundp 'oauth2-auto-manually-auth)
          (setq oauth2-auto-manually-auth nil))
        ;; Route ALL of org-gcal's HTTP through curl subprocesses so nothing
        ;; deadlocks in the headless daemon: the OAuth token exchange via the
        ;; curl override, and the event fetch via the `request' library's curl
        ;; backend (both are real subprocesses, immune to the Emacs-network
        ;; event-loop re-entrancy that hangs url-retrieve in a callback).
        (when (executable-find "curl")
          (org-gui--install-oauth2-curl-request)
          (when (boundp 'request-backend)
            (setq request-backend 'curl)))
        ;; Store tokens in a plaintext app-private file, NOT the encrypted
        ;; plstore (whose GPG write hangs the headless daemon → token never
        ;; persists → endless re-auth loop).
        (org-gui--install-token-store-override)
        t))))

(defun org-gui-gcal-status ()
  "Report org-gcal availability/config as JSON {available, configured,
authorized}."
  (let* ((available (org-gui--gcal-load))
         (configured (and available
                          (boundp 'org-gcal-client-id)
                          (stringp (bound-and-true-p org-gcal-client-id))
                          (> (length org-gcal-client-id) 0)
                          (boundp 'org-gcal-client-secret)
                          (stringp (bound-and-true-p org-gcal-client-secret))
                          (> (length org-gcal-client-secret) 0)))
         (authorized (and available
                          (or (file-exists-p org-gui--gcal-token-file)
                              (file-exists-p (expand-file-name "~/.org-gui/oauth2.plist"))))))
    (json-serialize
     (list (cons 'available (org-gui--b available))
           (cons 'configured (org-gui--b configured))
           (cons 'authorized (org-gui--b authorized))))))

(defun org-gui--gcal-apply-config (client-id client-secret calendar-id file)
  "Set org-gcal variables: CLIENT-ID/SECRET and a single CALENDAR-ID→FILE map,
then register the credentials with oauth2-auto. org-gcal does NOT wire its
client id/secret into oauth2-auto automatically when you just `setq' them —
the OAuth provider entry is only (re)built by `org-gcal-reload-client-id-secret'.
Without this the login flow runs against an empty/old client and fails."
  (unless (org-gui--gcal-load)
    (error "org-gcal is not installed yet — install it from the Google Calendar panel"))
  (setq org-gcal-client-id client-id
        org-gcal-client-secret client-secret
        org-gcal-fetch-file-alist (list (cons calendar-id (expand-file-name file))))
  ;; `org-gcal-reload-client-id-secret' uses `add-to-list', which won't update
  ;; an existing entry — drop any stale one first so credential changes take.
  (when (boundp 'oauth2-auto-additional-providers-alist)
    (setq oauth2-auto-additional-providers-alist
          (assq-delete-all 'org-gcal oauth2-auto-additional-providers-alist)))
  (when (fboundp 'org-gcal-reload-client-id-secret)
    (org-gcal-reload-client-id-secret)))

(defun org-gui--gcal-apply-config-multi (client-id client-secret calendar-ids file)
  "Like `org-gui--gcal-apply-config' but maps EVERY id in CALENDAR-IDS (a list)
to FILE, so org-gcal fetches all selected calendars into the one file."
  (unless (org-gui--gcal-load)
    (error "org-gcal is not installed yet — install it from the Google Calendar panel"))
  (let ((f (expand-file-name file)))
    (setq org-gcal-client-id client-id
          org-gcal-client-secret client-secret
          org-gcal-fetch-file-alist (mapcar (lambda (cid) (cons cid f)) calendar-ids)))
  (when (boundp 'oauth2-auto-additional-providers-alist)
    (setq oauth2-auto-additional-providers-alist
          (assq-delete-all 'org-gcal oauth2-auto-additional-providers-alist)))
  (when (fboundp 'org-gcal-reload-client-id-secret)
    (org-gcal-reload-client-id-secret)))

(defun org-gui--gcal-share-token (account calendar-ids)
  "org-gcal keys OAuth tokens by calendar-id (it calls
`oauth2-auto-access-token' with the calendar id as the username), so a token
obtained once under ACCOUNT wouldn't be found for the OTHER calendars and
each would re-trigger a browser auth. Copy ACCOUNT's token plist to each id
in CALENDAR-IDS so every selected calendar reuses the single sign-in."
  (when (fboundp 'oauth2-auto--compute-id)
    (let* ((db (org-gui--gcal-token-db))
           (acct (cdr (assoc (oauth2-auto--compute-id account 'org-gcal) db))))
      (when acct
        (dolist (cid calendar-ids)
          (let ((id (oauth2-auto--compute-id cid 'org-gcal)))
            (setq db (cons (cons id acct)
                           (seq-remove (lambda (e) (equal (car e) id)) db)))))
        (org-gui--save-token-db db)))))

(defun org-gui--gcal-browse-with-chooser (orig-fn url &rest args)
  "Append `prompt=select_account' to Google OAuth authorize URLs so the
account chooser ALWAYS appears. Without it, when the default browser is
signed into multiple Google accounts the consent flow silently uses the
wrong (non-test-user) account and dies with Google's generic \"Something
went wrong\". `consent' is added too so an offline refresh token is issued.
Non-Google URLs pass through untouched. Installed as :around advice on
`browse-url' only for the duration of a sync."
  (when (and (stringp url)
             (string-match-p "accounts\\.google\\.com/o/oauth2" url)
             (not (string-match-p "[?&]prompt=" url)))
    (setq url (concat url
                      (if (string-match-p "\\?" url) "&" "?")
                      "prompt=select_account%20consent")))
  (apply orig-fn url args))

(defun org-gui--gcal-wait-deferred (d &optional timeout)
  "Block until deferred.el object D settles, polling with `sleep-for'.
Why not `deferred:sync!': it drives the wait with sit-for +
accept-process-output, under which a NESTED `url-retrieve-synchronously'
\(org-gcal/oauth2-auto use one for the OAuth token exchange and the event
fetch) DEADLOCKS in our headless daemon, hanging at \"Contacting host:
oauth2.googleapis.com\". Polling with `sleep-for' lets the nested
synchronous request complete (verified). Resignals errors like
`deferred:sync!'.

Gives up after TIMEOUT seconds (default 240) and signals an error, so an
abandoned browser consent flow or a never-settling request can't pin the
daemon's main loop indefinitely (the Rust side only reaps the emacsclient
child, not the elisp running inside the daemon)."
  (let ((result 'org-gui--pending) (uncaught nil)
        (deadline (+ (float-time) (or timeout 240))))
    (deferred:try
      (deferred:nextc d (lambda (x) (setq result x)))
      :catch (lambda (e) (setq uncaught e)))
    (while (and (eq result 'org-gui--pending) (null uncaught)
                (< (float-time) deadline))
      (sleep-for 0.2))
    (when uncaught (deferred:resignal uncaught))
    (when (eq result 'org-gui--pending)
      (error "Google Calendar sync timed out after %ds — if a sign-in page is open, finish it and sync again"
             (round (or timeout 240))))
    result))

(defun org-gui-gcal-sync (client-id client-secret account calendar-ids file two-way)
  "Sync the selected Google calendars into FILE and return the reparsed doc.
ACCOUNT is the Google email signed in (the token's oauth2-auto username).
CALENDAR-IDS is a comma-separated list of calendar ids to sync. When TWO-WAY
is non-nil (\"t\"/\"1\"), use `org-gcal-sync' which ALSO pushes Emacs edits
back to Google (and creates events for org entries assigned to a calendar);
otherwise a one-way `org-gcal-fetch' (Google → org). First call triggers the
browser consent; later calls reuse the stored token."
  (let* ((ids (split-string (or calendar-ids "") "," t "[ \t]*"))
         (ids (or ids (and account (list account))))
         (twp (member two-way '("t" "1" "true" t)))
         (f (expand-file-name file)))
    (org-gui--gcal-apply-config-multi client-id client-secret ids file)
    (unless (file-exists-p f)
      (with-temp-file f (insert "#+TITLE: Google Calendar\n")))
    ;; Clear a stale sync lock + leaked loopback listeners from prior aborts.
    (when (boundp 'org-gcal--sync-lock) (setq org-gcal--sync-lock nil))
    (dolist (p (process-list))
      (when (string-prefix-p "oauth2-auto--httpd" (process-name p))
        (ignore-errors (delete-process p))))
    ;; STEP 1 — sign in ONCE for the account (sleep-for-polled; the curl token
    ;; override makes the exchange complete instead of deadlocking), then SHARE
    ;; that token to every selected calendar id so none of them re-prompts.
    (when (and account (fboundp 'oauth2-auto-access-token-sync))
      (oauth2-auto-access-token-sync account 'org-gcal))
    (org-gui--gcal-share-token account ids)
    ;; STEP 2 — fetch (one-way) or full sync (two-way: pull + push edits +
    ;; create assigned + cancel), driving the deferred with the sleep-for poll.
    ;;
    ;; org-gcal decides whether to PUSH an existing edited event inside an
    ;; async deferred callback (org-gcal--sync-update-entries -> post-at-point),
    ;; which runs OFF the event loop — i.e. OUTSIDE any `let' dynamic scope we
    ;; establish here. A `let'-binding of
    ;; `org-gcal-managed-post-at-point-update-existing' therefore never reaches
    ;; the callback, which then reads the global default `prompt' -> resolves to
    ;; `never-push' -> the user's calendar move is silently NOT pushed to Google
    ;; (the "edits don't show on Google" bug). Set it (and the cancel guard)
    ;; GLOBALLY in this dedicated daemon so the async push sees them. Prompts
    ;; are forced off so the headless daemon can't hang on a y/n.
    (setq org-gcal-managed-post-at-point-update-existing 'always-push
          org-gcal-remove-api-cancelled-events nil)
    ;; Fetch a generous time window so events aren't silently missed. org-gcal's
    ;; default window (~30 days each way) can exclude events the user expects to
    ;; see and makes a sync look like it "did nothing".
    (setq org-gcal-up-days 365
          org-gcal-down-days 180)
    ;; Force a FULL fetch into the (current-tab) target file. org-gcal caches a
    ;; per-CALENDAR sync token (NOT per-file), persisted to disk. Once a calendar
    ;; has been fetched into ANY file, a later fetch into a DIFFERENT file is
    ;; INCREMENTAL — Google returns only events changed since that token, which
    ;; is usually nothing — so the existing events NEVER land in the newly
    ;; targeted file. That's the "sync says OK but the tab stays empty" bug.
    ;; Drop the tokens for the calendars we're about to sync so org-gcal pulls
    ;; each calendar's whole window into the current tab every time.
    (when (boundp 'org-gcal--sync-tokens)
      (setq org-gcal--sync-tokens
            (seq-remove (lambda (e) (member (car e) ids)) org-gcal--sync-tokens))
      (when (fboundp 'persist-save)
        (ignore-errors (persist-save 'org-gcal--sync-tokens))))
    (let ((res (cond
                ((and twp (fboundp 'org-gcal-sync)) (org-gcal-sync))
                ((fboundp 'org-gcal-fetch) (org-gcal-fetch))
                (t (error "org-gcal is unavailable")))))
      (cond
       ((and (fboundp 'deferred-p) (deferred-p res))
        (org-gui--gcal-wait-deferred res))
       ((and (fboundp 'aio-promise-p) (aio-promise-p res) (fboundp 'oauth2-auto-poll-promise))
        (oauth2-auto-poll-promise res))
       (t res)))
    (org-gui--doc-json f)))

(defun org-gui--gcal-time-field (iso)
  "Build a Google event time object alist for ISO: `dateTime' for a timed value
\(contains \"T\"), else `date' for an all-day value."
  (if (string-match-p "T" iso)
      (list (cons 'dateTime iso))
    (list (cons 'date iso))))

(defun org-gui--gcal-patch-event (token cal-id event-id start end)
  "Move a Google event by PATCHing its start/end via curl. Returns the parsed
JSON response alist (with an `error' key on failure)."
  (let ((url (format "https://www.googleapis.com/calendar/v3/calendars/%s/events/%s"
                     (url-hexify-string cal-id) (url-hexify-string event-id)))
        (body (json-serialize
               (list (cons 'start (org-gui--gcal-time-field start))
                     (cons 'end (org-gui--gcal-time-field end))))))
    (with-temp-buffer
      (call-process "curl" nil t nil "-sS" "--max-time" "30"
                    "-X" "PATCH"
                    "-H" (concat "Authorization: Bearer " token)
                    "-H" "Content-Type: application/json"
                    "--data" body url)
      (goto-char (point-min))
      (condition-case _
          (json-parse-buffer :object-type 'alist :null-object nil :false-object nil)
        (error nil)))))

(defun org-gui-gcal-push (file client-id client-secret account entry-ids)
  "PUSH moved events to Google via a DIRECT Google Calendar events.patch call
per event. ENTRY-IDS is a comma-separated list of org-gcal `entry-id' property
values (the timeline's move-ghost ids).

Why a direct PATCH rather than `org-gcal-sync'/`org-gcal-post-at-point':
  1. `org-gcal-sync's export only pushes entries managed \"org\" (it calls
     `org-gcal-sync-buffer' with `filter-managed'); events fetched from Google
     are managed \"gcal\", so a calendar move is never uploaded.
  2. `org-gcal-post-at-point' bumps the ETag but does NOT move a single
     occurrence of a RECURRING event (verified live against the API).
A direct events.patch with the new start/end moves BOTH ordinary events and
single recurring occurrences (Google auto-creates the instance exception —
verified live). Returns the reparsed doc; signals an error listing failures
only when NOTHING pushed."
  (unless (org-gui--gcal-load)
    (error "org-gcal is not installed yet — install it from the Google Calendar panel"))
  (let* ((ids (split-string (or entry-ids "") "," t "[ \t]*"))
         (f (expand-file-name file))
         (pushed 0) (errs '()))
    (setq org-gcal-client-id client-id org-gcal-client-secret client-secret)
    (setq oauth2-auto-additional-providers-alist
          (assq-delete-all 'org-gcal oauth2-auto-additional-providers-alist))
    (when (fboundp 'org-gcal-reload-client-id-secret)
      (org-gcal-reload-client-id-secret))
    (let ((token (and account (fboundp 'oauth2-auto-access-token-sync)
                      (oauth2-auto-access-token-sync account 'org-gcal))))
      (unless (and token (stringp token))
        (error "Not signed in to Google — open the calendar panel and sign in first"))
      (with-current-buffer (org-gui--visit f)
        (org-with-wide-buffer
         (dolist (eid ids)
           (condition-case e
               (progn
                 (goto-char (point-min))
                 (if (not (re-search-forward
                           (concat "^[ \t]*:"
                                   (regexp-quote
                                    (or (bound-and-true-p org-gcal-entry-id-property)
                                        "entry-id"))
                                   ":[ \t]*" (regexp-quote eid) "[ \t]*$")
                           nil t))
                     (push (format "%s: not found in file" eid) errs)
                   (org-back-to-heading t)
                   (let* ((cal (or (org-entry-get nil "calendar-id")
                                   (cadr (split-string eid "/"))))
                          ;; Google event id = the entry-id up to the "/calendar".
                          (event-id (car (split-string eid "/")))
                          (td (org-gcal--get-time-and-desc))
                          (start (plist-get td :start))
                          (end (plist-get td :end)))
                     (if (not (and cal event-id start))
                         (push (format "%s: missing time or calendar" eid) errs)
                       (let ((resp (org-gui--gcal-patch-event
                                    token cal event-id start (or end start))))
                         (if (alist-get 'error resp)
                             (push (format "%s: %s" eid
                                           (or (alist-get 'message (alist-get 'error resp))
                                               "Google API error"))
                                   errs)
                           (setq pushed (1+ pushed))))))))
             (error (push (format "%s: %s" eid (error-message-string e)) errs)))))))
    (when (and (= pushed 0) errs)
      (error "Calendar push failed — %s" (mapconcat #'identity (nreverse errs) "; ")))
    (org-gui--doc-json f)))

(defun org-gui--insert-gcal-drawer (ts-string)
  "Insert an :org-gcal: drawer holding TS-STRING (a full <...> timestamp) right
after the property drawer of the current entry — org-gcal's native layout."
  (org-back-to-heading t)
  (goto-char (save-excursion (org-end-of-meta-data) (point)))
  (insert (format ":%s:\n%s\n:END:\n"
                  (or (bound-and-true-p org-gcal-drawer-name) "org-gcal")
                  ts-string)))

(defun org-gui-gcal-create (file begin client-id client-secret account calendar-id)
  "Add the task at BEGIN to Google Calendar CALENDAR-ID as a NEW event.

Captures the task's time (SCHEDULED, else an active TIMESTAMP, else DEADLINE),
rewrites the entry into org-gcal's managed shape (:calendar-id: property + an
:org-gcal: drawer holding the time, no planning line — so future timeline moves
stay consistent), then `org-gcal-post-at-point' inserts the event on Google and
stamps :entry-id:/:ETag:. The task becomes a calendar event you can then move
and sync like any other. Returns the reparsed doc."
  (unless (org-gui--gcal-load)
    (error "org-gcal is not installed yet — install it from the Google Calendar panel"))
  (setq org-gcal-client-id client-id org-gcal-client-secret client-secret
        org-gcal-managed-create-from-entry-mode "org")
  (setq oauth2-auto-additional-providers-alist
        (assq-delete-all 'org-gcal oauth2-auto-additional-providers-alist))
  (when (fboundp 'org-gcal-reload-client-id-secret)
    (org-gcal-reload-client-id-secret))
  (let ((token (and account (fboundp 'oauth2-auto-access-token-sync)
                    (oauth2-auto-access-token-sync account 'org-gcal))))
    (unless (and token (stringp token))
      (error "Not signed in to Google — open the calendar panel and sign in first"))
    (org-gui--gcal-share-token account (list calendar-id))
    (let ((b (org-gui--num begin)) (f (expand-file-name file)))
      (with-current-buffer (org-gui--visit f)
        (org-with-wide-buffer
         (goto-char (min b (point-max)))
         (org-back-to-heading t)
         (when (org-entry-get nil "entry-id")
           (error "This entry is already linked to a Google Calendar event"))
         (let ((raw (or (org-entry-get nil "SCHEDULED")
                        (org-entry-get nil "TIMESTAMP")
                        (org-entry-get nil "DEADLINE"))))
           (unless raw
             (error "Give the task a scheduled date/time first, then add it to the calendar"))
           ;; Move the time into the :org-gcal: drawer: clear planning lines and
           ;; any body timestamp, then write the drawer copy.
           (ignore-errors (org-schedule '(4)))
           (ignore-errors (org-deadline '(4)))
           (org-gui--write-body-timestamp nil)
           (org-entry-put nil (or (bound-and-true-p org-gcal-calendar-id-property)
                                  "calendar-id")
                          calendar-id)
           (org-gui--insert-gcal-drawer raw)
           (let ((res (org-gcal-post-at-point nil nil 'always-push)))
             (when (and (fboundp 'deferred-p) (deferred-p res))
               (org-gui--gcal-wait-deferred res 120))))
         (save-buffer))
        ;; Parse INSIDE the file's buffer — org-gui--doc-json reads the CURRENT
        ;; buffer, so calling it outside `with-current-buffer' returned an empty
        ;; node list and blanked the canvas.
        (org-gui--doc-json f)))))

(defun org-gui--gcal-api (method url token &optional data)
  "Call the Google Calendar API: METHOD (\"GET\"/\"POST\"/\"DELETE\"/\"PATCH\")
on URL with bearer TOKEN and optional JSON DATA. Returns (HTTP-CODE . JSON-alist)
\(JSON nil when the response has no body, e.g. a 204 DELETE)."
  (with-temp-buffer
    (apply #'call-process "curl" nil t nil
           (append (list "-sS" "--max-time" "30" "-X" method
                         "-H" (concat "Authorization: Bearer " token))
                   (when data (list "-H" "Content-Type: application/json" "--data" data))
                   (list "-w" "\n%{http_code}" url)))
    (goto-char (point-max))
    (let ((code (string-trim (buffer-substring (line-beginning-position) (point-max)))))
      (goto-char (point-min))
      (cons code
            (condition-case _
                (json-parse-buffer :object-type 'alist :null-object nil :false-object nil)
              (error nil))))))

(defun org-gui-gcal-unsync (file begin client-id client-secret account &optional title)
  "Remove the calendar event at BEGIN from Google Calendar and DETACH the org
entry. Deletes the event on Google (so it won't re-import on the next fetch),
then strips ONLY the org-gcal linking properties (:calendar-id:, :entry-id:,
:ETag:, :org-gcal-managed:) — the heading, its time, tags and any description
drawer are left intact, so the task stays on the timeline as a plain org entry
(no longer a managed calendar event). Returns the reparsed doc."
  (let ((f (expand-file-name file)) (b (org-gui--num begin)))
    (with-current-buffer (org-gui--visit f)
      (org-with-wide-buffer
       ;; TITLE (optional) guards a stale BEGIN from detaching the wrong heading.
       (goto-char (org-gui--resolve-heading b title))
       (let* ((eid (org-entry-get nil "entry-id"))
              (cal (or (org-entry-get nil "calendar-id")
                       (and eid (cadr (split-string eid "/")))))
              (event-id (and eid (car (split-string eid "/")))))
         ;; Nothing calendar-related here at all → genuinely not a calendar entry.
         (unless (or eid cal)
           (error "This entry has no Google Calendar link to remove"))
         ;; Only a REAL event (has entry-id + calendar + event-id) needs deleting
         ;; on Google, else it re-imports. A glitch-tagged entry — a stray
         ;; :calendar-id: with no :entry-id: from the earlier drag bug — has no
         ;; Google event, so we just strip the local properties below.
         (when (and eid cal event-id)
           (unless (org-gui--gcal-load)
             (error "org-gcal is not installed yet — install it from the Google Calendar panel"))
           (setq org-gcal-client-id client-id org-gcal-client-secret client-secret)
           (let ((token (and account (fboundp 'oauth2-auto-access-token-sync)
                             (ignore-errors (oauth2-auto-access-token-sync account 'org-gcal)))))
             (unless (and token (stringp token))
               (error "Not signed in to Google — open the calendar panel and sign in first"))
             (let* ((url (format "https://www.googleapis.com/calendar/v3/calendars/%s/events/%s"
                                 (url-hexify-string cal) (url-hexify-string event-id)))
                    (code (car (org-gui--gcal-api "DELETE" url token))))
               ;; 404/410 = already gone on Google; treat as success.
               (unless (member code '("200" "204" "404" "410"))
                 (error "Google refused to delete the event (HTTP %s)" code)))))
         ;; Always strip the local linking properties — this is what removes the
         ;; 📅 calendar tag/aura from the node.
         (dolist (p '("calendar-id" "entry-id" "ETag" "org-gcal-managed"))
           (ignore-errors (org-entry-delete nil p))))
       (org-gui--refresh-cookies))
      (save-buffer)
      (org-gui--doc-json f))))

(defun org-gui-gcal-delete (file entry-id client-id client-secret account delete-on-google)
  "Delete the org subtree whose :entry-id: equals ENTRY-ID. The entry is located
BY ENTRY-ID (not buffer position), so a stale position — e.g. after the shared
file changed on disk via Dropbox or the user's own org-gcal — can't make the
delete hit a NEIGHBOURING calendar event. When DELETE-ON-GOOGLE is truthy, the
Google Calendar event is deleted first so it won't re-import. Returns the doc."
  (let ((f (expand-file-name file))
        (del (and delete-on-google (member delete-on-google '("t" "1" "true" t)))))
    (with-current-buffer (org-gui--visit f)
      (org-with-wide-buffer
       (let ((pos (org-find-property "entry-id" entry-id)))
         (unless pos
           (error "Calendar event not found (entry-id %s) — it may already be gone" entry-id))
         (goto-char pos)
         (org-back-to-heading t)
         (when del
           (unless (org-gui--gcal-load)
             (error "org-gcal is not installed yet"))
           (setq org-gcal-client-id client-id org-gcal-client-secret client-secret)
           (let* ((token (and account (fboundp 'oauth2-auto-access-token-sync)
                              (oauth2-auto-access-token-sync account 'org-gcal)))
                  (eid (org-entry-get nil "entry-id"))
                  (cal (or (org-entry-get nil "calendar-id")
                           (and eid (cadr (split-string eid "/")))))
                  (event-id (and eid (car (split-string eid "/")))))
             (unless (and token (stringp token))
               (error "Not signed in to Google — open the calendar panel and sign in first"))
             (when (and cal event-id)
               (let* ((url (format "https://www.googleapis.com/calendar/v3/calendars/%s/events/%s"
                                   (url-hexify-string cal) (url-hexify-string event-id)))
                      (code (car (org-gui--gcal-api "DELETE" url token))))
                 ;; 404/410 = already gone on Google; treat as success.
                 (unless (member code '("200" "204" "404" "410"))
                   (error "Google refused to delete the event (HTTP %s)" code))))))
         (org-cut-subtree)
         (org-gui--refresh-cookies)))
      (save-buffer)
      (org-gui--doc-json f))))

(defun org-gui-gcal-switch (file begin client-id client-secret account new-cal-id)
  "Move the calendar event at BEGIN to a DIFFERENT Google calendar NEW-CAL-ID
\(events.move API). An event belongs to exactly one calendar, so this changes
it rather than adding a second. Updates the local :calendar-id:/:entry-id:/:ETag:
to match. Returns the reparsed doc."
  (unless (org-gui--gcal-load)
    (error "org-gcal is not installed yet — install it from the Google Calendar panel"))
  (setq org-gcal-client-id client-id org-gcal-client-secret client-secret)
  (let ((token (and account (fboundp 'oauth2-auto-access-token-sync)
                    (oauth2-auto-access-token-sync account 'org-gcal)))
        (f (expand-file-name file)) (b (org-gui--num begin)))
    (unless (and token (stringp token))
      (error "Not signed in to Google — open the calendar panel and sign in first"))
    (with-current-buffer (org-gui--visit f)
      (org-with-wide-buffer
       (goto-char (min b (point-max)))
       (org-back-to-heading t)
       (let* ((eid (org-entry-get nil "entry-id"))
              (cal (or (org-entry-get nil "calendar-id")
                       (and eid (cadr (split-string eid "/")))))
              (event-id (and eid (car (split-string eid "/")))))
         (unless (and eid cal event-id) (error "This entry is not a Google Calendar event"))
         (when (string= cal new-cal-id) (error "Already on that calendar"))
         (org-gui--gcal-share-token account (list cal new-cal-id))
         (let* ((url (format "https://www.googleapis.com/calendar/v3/calendars/%s/events/%s/move?destination=%s"
                             (url-hexify-string cal) (url-hexify-string event-id)
                             (url-hexify-string new-cal-id)))
                (res (org-gui--gcal-api "POST" url token))
                (code (car res)) (json (cdr res)))
           (unless (member code '("200"))
             (error "Google refused to move the event (HTTP %s%s)" code
                    (let ((m (alist-get 'message (alist-get 'error json))))
                      (if m (format ": %s" m) ""))))
           ;; The event id is preserved across calendars; relink locally.
           (org-entry-put nil (or (bound-and-true-p org-gcal-calendar-id-property) "calendar-id")
                          new-cal-id)
           (org-entry-put nil (or (bound-and-true-p org-gcal-entry-id-property) "entry-id")
                          (concat event-id "/" new-cal-id))
           (let ((etag (alist-get 'etag json)))
             (when (stringp etag) (org-entry-put nil "ETag" etag)))))
       (org-gui--refresh-cookies))
      (save-buffer)
      (org-gui--doc-json f))))

(defun org-gui--gcal-valid-token (account)
  "Return a currently-valid access token for ACCOUNT (the Google email the
token is stored under). oauth2-auto refreshes via the stored refresh token (or
opens the browser consent flow when there is no token yet) and returns a fresh
token.

If the refresh THROWS, the stored refresh token is dead/revoked — most often
because a Google app in \"Testing\" publishing status expires refresh tokens
after 7 days. We DELIBERATELY do not fall back to the cached access token here
(the old behaviour): that token is also stale, so every Google call 401s
SILENTLY and the user just sees \"nothing synced\". Instead we raise an
actionable error tagged with the GCAL_AUTH_EXPIRED marker, which the app
detects to flip the Calendar panel into a one-click Reconnect state.

Background callers (org-gui-gcal-peek) already swallow this — the error
propagates out as a {error:…} JSON the badge check ignores — so surfacing it
here does not break the silent background path."
  (unless (fboundp 'oauth2-auto-access-token-sync)
    (error "Google Calendar support isn't loaded — install it from the Calendar panel."))
  (or (condition-case _err
          (oauth2-auto-access-token-sync account 'org-gcal)
        (error
         (error "GCAL_AUTH_EXPIRED: Google sign-in expired or was revoked — open the Calendar panel, click Reconnect, then Sign in with Google again.")))
      (error "Not signed in to Google yet — open the Calendar panel and click Sign in with Google.")))

(defun org-gui-gcal-forget-token (&rest _)
  "Forget the stored Google OAuth token so the next Calendar action triggers a
fresh browser sign-in. Deletes the app-private token file(s) AND drops any
in-memory token oauth2-auto cached this daemon session (otherwise it could hand
back the just-deleted, possibly-expired token). Idempotent; returns {ok:t}.
Drives the Calendar panel's Reconnect button."
  (ignore-errors (delete-file org-gui--gcal-token-file))
  (ignore-errors (delete-file (expand-file-name "~/.org-gui/oauth2.plist")))
  ;; Our plstore-read/write override (`org-gui--install-token-store-override')
  ;; reads the token from the file fresh every call, so deleting the file above
  ;; already forces re-auth — there is no in-memory copy in this app. Still,
  ;; defensively clear oauth2-auto's own plstore cache (`oauth2-auto--plstore-cache',
  ;; the real upstream var) in case the override is ever removed; the other
  ;; names are version-tolerant fallbacks, only touched when bound.
  (dolist (sym '(oauth2-auto--plstore-cache
                 oauth2-auto--tokens oauth2-auto--cache oauth2-auto--token-cache))
    (when (boundp sym)
      (let ((v (symbol-value sym)))
        (if (hash-table-p v) (ignore-errors (clrhash v)) (set sym nil)))))
  (json-serialize (list (cons 'ok t))))

(defun org-gui-gcal-calendars (client-id client-secret account)
  "Return JSON array of the signed-in ACCOUNT's Google calendars:
[{id, summary, primary, color, accessRole}]. ACCOUNT is the Google email
used at sign-in (the oauth2-auto username the token is keyed under). Used to
populate the multi-calendar picker."
  (unless (org-gui--gcal-load)
    (error "org-gcal is not installed yet — install it from the Google Calendar panel"))
  (setq org-gcal-client-id client-id org-gcal-client-secret client-secret)
  (when (boundp 'oauth2-auto-additional-providers-alist)
    (setq oauth2-auto-additional-providers-alist
          (assq-delete-all 'org-gcal oauth2-auto-additional-providers-alist)))
  (when (fboundp 'org-gcal-reload-client-id-secret)
    (org-gcal-reload-client-id-secret))
  (let ((tok (org-gui--gcal-valid-token account)))
    (with-temp-buffer
      (call-process "curl" nil t nil "-sS" "--max-time" "25"
                    "-H" (concat "Authorization: Bearer " tok)
                    (concat "https://www.googleapis.com/calendar/v3/users/me/calendarList"
                            "?fields=items(id,summary,summaryOverride,primary,backgroundColor,accessRole)"))
      (goto-char (point-min))
      (let* ((j (json-parse-buffer :object-type 'alist :array-type 'list
                                   :null-object nil :false-object nil))
             (err (alist-get 'error j))
             (items (alist-get 'items j)))
        (when err
          (error "Calendar list failed: %s" (or (alist-get 'message err) err)))
        (json-serialize
         (vconcat
          (mapcar (lambda (c)
                    (list (cons 'id (org-gui--s (alist-get 'id c)))
                          (cons 'summary (org-gui--s (or (alist-get 'summaryOverride c)
                                                         (alist-get 'summary c)
                                                         (alist-get 'id c))))
                          (cons 'primary (org-gui--b (alist-get 'primary c)))
                          (cons 'color (org-gui--s (alist-get 'backgroundColor c)))
                          (cons 'accessRole (org-gui--s (alist-get 'accessRole c)))))
                  items)))))))

(defun org-gui-gcal-peek (client-id client-secret account calendar-ids)
  "READ-ONLY peek at Google Calendar — never writes any org file or token.
For each calendar in CALENDAR-IDS (comma/space separated) list the events in
the same window org-gcal would sync (down `org-gcal-down-days', up
`org-gcal-up-days'). Returns JSON {events:[{id,summary}]} where each `id' is
\"<eventId>/<calId>\" to match org-gcal's entry-id property, so the app can
diff against what's already imported and badge only the genuinely-new ones.
Uses the existing OAuth token (refresh only, no browser popup); errors if not
signed in. Safe to call on a background timer."
  (unless (org-gui--gcal-load)
    (error "org-gcal is not installed yet"))
  (setq org-gcal-client-id client-id org-gcal-client-secret client-secret)
  (when (fboundp 'org-gcal-reload-client-id-secret)
    (org-gcal-reload-client-id-secret))
  (let* ((tok (org-gui--gcal-valid-token account))
         (ids (split-string (or calendar-ids "") "[ ,]+" t))
         (up (if (boundp 'org-gcal-up-days) org-gcal-up-days 365))
         (down (if (boundp 'org-gcal-down-days) org-gcal-down-days 180))
         (now (current-time))
         (tmin (format-time-string "%Y-%m-%dT%H:%M:%SZ" (time-subtract now (* down 86400)) t))
         (tmax (format-time-string "%Y-%m-%dT%H:%M:%SZ" (time-add now (* up 86400)) t))
         (out '()))
    (dolist (cid ids)
      (with-temp-buffer
        (ignore-errors
          ;; Short ceiling: this runs on a background timer against the same
          ;; single-threaded daemon the embedded editor types through, once PER
          ;; calendar. A long hang here would freeze keystrokes, so cap each
          ;; fetch low — a missed peek just defers the "new events" badge.
          (call-process "curl" nil t nil "-sS" "--max-time" "10"
                        "-H" (concat "Authorization: Bearer " tok)
                        (concat "https://www.googleapis.com/calendar/v3/calendars/"
                                (url-hexify-string cid) "/events"
                                "?singleEvents=true&maxResults=2500"
                                "&timeMin=" (url-hexify-string tmin)
                                "&timeMax=" (url-hexify-string tmax)
                                "&fields=items(id,summary,status)")))
        (goto-char (point-min))
        (let* ((j (ignore-errors
                    (json-parse-buffer :object-type 'alist :array-type 'list
                                       :null-object nil :false-object nil)))
               (items (and j (alist-get 'items j))))
          (dolist (it items)
            (let ((eid (alist-get 'id it))
                  (status (alist-get 'status it)))
              (when (and (stringp eid) (not (equal status "cancelled")))
                (push (list (cons 'id (org-gui--s (concat eid "/" cid)))
                            (cons 'summary (org-gui--s (or (alist-get 'summary it) ""))))
                      out)))))))
    (json-serialize (list (cons 'events (vconcat (nreverse out)))))))

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
