# Developer 2 — Editor prompt cards (U-01 … U-13)

You own: `src/extension.ts`, `src/ui/`, `src/review/`, `src/context/`, `media/`, `test/ui/`, `test/context/`, `test/e2e/`, `src/mocks/MockEngine.ts`, `package.json#contributes`, docs 04/05 and write-up §4, §6, video.
Never touch: `src/engine/`, `src/mcp/`, `forge/`, `scripts/` (except `scripts/eval-context.ts`, agreed with Dev 1), contract, `package.json` deps.
Footer for every card: *Plan first and wait for "go". Touch only the listed paths. Run `npm run check` and show the output. End with: what changed / how I verify by hand / what could go wrong.*
You work against `MockEngine` until Dev 1 says the real engine streams (`forge.useMocks=false`).

---
## U-01 hunkText — rebuild text from hunks (Day 1)
**May edit:** `src/review/hunkText.ts`, `test/ui/hunkText.test.ts`.
```
Create a pure, vscode-free buildText(p: FileProposal, mode: 'preview'|'final') → {text, hunkLine}. Contract rules: 1-based lines; oldStart/oldLines = original lines replaced; pure insertion has oldLines 0 and goes BEFORE oldStart; hunks sorted and non-overlapping.
preview: pending and accepted hunks applied, rejected shown as original; final: ONLY accepted hunks applied. hunkLine[hunkId] = 0-based output line where that hunk starts (for CodeLens).
Preserve line endings per line: split into lines KEEPING each original terminator and rebuild from those, so mixed CRLF/LF files round-trip byte-identically (new lines use the EOL of their neighbouring line), handle no trailing newline, empty file, first/last line hunks.
Tests: all accepted == proposedContent; all rejected == originalContent; mixed; pure insert/delete; start/end of file; CRLF; MIXED CRLF/LF (byte-identical for untouched lines); no trailing newline; plus a property test (200 random hunk sets generated from random before/after texts via the 'diff' package; for every accept/reject combination final text equals the expected manual construction).
```
**Acceptance:** tests green incl. property test. **Commit:** `feat(review): hunkText with property tests`

---
## U-02 DiffReviewer + per-hunk CodeLens (Day 2)
**May edit:** `src/review/DiffReviewer.ts`, `HunkCodeLens.ts`, `src/extension.ts`, contributes.
```
FIRST (20 minutes, before any other code; docs/01 §7.1): in a throwaway command open vscode.diff on two virtual documents and register a CodeLensProvider for the modified side's scheme; write docs/spike-codelens.md with a screenshot answering: do lenses render in the diff editor? If YES continue as written. If NO implement the fallback ladder: (1) Comments API threads at each hunk line with Accept/Reject commands, (2) the preview document in a NORMAL editor beside the diff with decorations + CodeLens, (3) per-hunk buttons in the agent panel (built in every case, see U-08/U-09).
Then implement DiffReviewer: TextDocumentContentProvider scheme 'forge-proposed' rendering buildText(p,'preview').text; open vscode.diff(original uri, proposed uri); keep an ordered list of proposals (source files, then tests, then docs by path heuristics: contains 'test' → tests; .md/.rst/.txt → docs); setHunkStatus fires onDidChange for that URI and refreshes CodeLens.
HunkCodeLens: for scheme 'forge-proposed' return two lenses per hunk at buildText(...).hunkLine: "$(check) Accept" and "$(x) Reject" (show state), commands forge.acceptHunk/forge.rejectHunk(proposalId, hunkId); also forge.acceptAllHunks/forge.rejectAllHunks for the active diff. Hunks start 'pending'.
Never write files here. Test with "Forge: Show Demo Diff (mock)" (2 hunks): rejecting hunk 2 reverts it on the right side; lens positions stay correct after every change.
```
**Acceptance:** per-hunk review works on the demo diff (A1 top anchor territory). **Commit:** `feat(review): per-hunk accept/reject with CodeLens`

---
## U-03 ApplyManager + UndoManager (Day 3) — B2 core
**Read first:** docs/01 §7, §8.
**May edit:** `src/review/ApplyManager.ts`, `UndoManager.ts`, `src/extension.ts`, `test/ui/apply*.test.ts` (logic split into vscode-free helpers).
```
ApplyManager is the ONLY writer (with UndoManager). apply(proposals): for each proposal with ≥1 accepted hunk: re-snapshot the document (open document text if open else disk); if sha256(text) != proposal.base.contentHash → mark failure {kind:'stale'} and DO NOT write that file; never merge. Compute finalText = buildText(p,'final').text. Build ONE vscode.WorkspaceEdit across files (replace whole range; createFile + insert for new files). Record before-text (null for new files) and after-hash BEFORE applying. After applyEdit returns, re-read each document and verify text === finalText; mismatch or false → restore from snapshot, re-read and VERIFY the restore, and report failure {kind:'apply_failed'} (or {kind:'restore_failed', recoveryPath} + critical notification if restoration itself fails; before applying, persist before-texts to a recovery file in globalStorageUri). Then save ONLY the documents this apply modified (for each: await document.save(), check the returned boolean, verify disk equals text). NEVER call saveAll: it would save unrelated dirty tabs. Return ApplyRecord and a ReviewResult-compatible list.
Note in code comments: WorkspaceEdit is grouped but NOT transactional; our verify+restore is the safety net.
UndoManager: stack of ApplyRecords; undoLast restores before-text or deletes created files; refuses with an explanation (and confirm option) if a file's current hash != afterHash (edited since); shows "Forge: undone N files". Commands: forge.applyAccepted, forge.undoLastApply.
Pure helpers (hashing, planning, verification) must be vscode-free with unit tests; add extension-host tests later (U-11). Pending hunks are NOT applied.
```
**Acceptance:** an unrelated dirty tab is still dirty/unsaved after Apply; injected restore failure produces restore_failed + recovery file; demo diff: accept 1, reject 2, Apply → only hunk 1 on disk; Undo restores; editing the file during review makes Apply refuse that file. **Commit:** `feat(review): safe apply with stale detection and snapshot undo`

---
## U-04 UiHost + EventRouter + StatusBar (Day 2–4)
**May edit:** `src/ui/index.ts`, `EventRouter.ts`, `StatusBar.ts`, `src/extension.ts`, `src/review/*` (wiring only).
```
Implement createUiHost(): snapshot(path) (open document text/version/isDirty/sha256, else disk), readFile(path, range) (workspace-relative, forward slashes, bounds), workspaceRoot, context (U-07), confirmCommand (non-modal notification with buttons Allow once / Allow for this run / Deny; resolves false on dismiss), runCommand(req, signal): child_process.execFile with shell:false, cwd locked to workspaceRoot (reject any other cwd), env scrubbed per docs/03 (never forward *_KEY/*_TOKEN/*_SECRET/TRUEFORGE_*), timeout, maxBuffer, kill the process TREE on abort/timeout (taskkill /T on Windows, process group on POSIX), tail-trim output to maxOutputChars, return CommandResult.
EventRouter: single place mapping EngineEvent → UI: token → output channel + panel; tool.call/result → timeline; context.report → files list; budget → meter; subagent → timeline marker; proposal.created → DiffReviewer.add; review.required → open first diff, show "N files to review" in status bar; proposal.discarded → close diff + remove; retry → "retrying k/3" status; failover → warning toast + model name refresh; run.failed → non-modal error toast with friendly message (never stack traces); run.completed → "Forge: no changes proposed" if none; run.cancelled → clear state. Always return to idle in finally. Never await a run inside a command handler (void router.consume(...)).
```
**Acceptance:** MockEngine scenarios `mock:error`, `mock:failover`, `mock:cancel` behave: toast/spinner/diffs cleared; editor stays responsive. **Commit:** `feat(ui): UiHost, event router and status bar`

---
## U-05 Ctrl+K inline edit (Day 4) — Task A
**May edit:** `src/ui/InlineEdit.ts`, `src/extension.ts`, contributes (keybinding).
```
Command forge.inlineEdit bound to ctrl+k / cmd+k only when editorHasSelection && editorTextFocus (and a second binding ctrl+alt+k always). Capture workspace-relative forward-slash path, selected text, 1-based range. Friendly messages for: no editor, empty selection, untitled file, file outside workspace. showInputBox for the instruction (Escape = nothing). Call engine.runInline(...) via router.consume without awaiting; status bar shows running + Stop.
When the run completes with no proposal: "Forge: no changes proposed". Do not freeze the editor: test typing in another tab while tokens stream (MockEngine).
```
**Acceptance:** I-1 Task A on Flask with real engine, exact wording → diff with only the target function changed. **Commit:** `feat(ui): robust Ctrl+K inline edit`

---
## U-06 Indexer + ranker + budget (Day 5) — B1 core
**Read first:** docs/04 whole.
**May edit:** `src/context/indexer.ts`, `ranker.ts`, `budget.ts`, `test/context/*`, contributes (settings `forge.context.*`).
```
Implement per docs/04: WorkspaceIndex (chunked async build yielding every ~100 files; findFiles with excludes; mtime+size cache; incremental update on save/watch; Python/TS/JS symbol regexes; md/rst headings; path words; import edges one hop via regex).
rank(prompt, index, cfg: RankerConfig) → [{path, score, reason}] using BM25F over fields (path, symbols, headings/docstring first lines, body) with weights from settings (defaults 3/3/2/1, k1 1.2, b 0.75), intent-word categories (test/doc/config/cli by CATEGORY only), test affinity, doc affinity, import neighbours, slot reservation for tests/docs when asked, MMR diversity (≤3 per directory in top 8), noise penalties. Reasons must list matched fields/terms/signals.
budget.ts: estimateTokens(chars/4) and fitToBudget.
FORBIDDEN: any project-specific word or file name in src/context. Tests use small synthetic indexes AND fixture snapshots; add tests for identifier splitting, stopwords, intent slots, diversity, penalties, determinism.
```
**Acceptance:** unit tests green; top-10 for a filename-free prompt looks sensible on Flask; build < 5 s. **Commit:** `feat(context): BM25F ranker with structure signals`

---
## U-07 ContextProviderImpl + mentions (Day 6)
**May edit:** `src/context/ContextProviderImpl.ts`, `repoMap.ts`, `mentions.ts`, tests.
```
Implement all ContextProvider methods using the index/ranker; never throw (return empty results); each <200 ms on Flask:
search({query, glob, maxResults}) line scan (case-insensitive; /regex/ if slashed), best-ranked files first, previews ≤160 chars, return omitted count; findSymbol (exact → prefix → contains, with kind); repoMap({dir, depth}) directories first, noise excluded, ≤1500 tokens with truncated flag; resolveMention('@path' | '@symbol') (file ≤400 lines else outline; symbol body ≤80 lines; null if missing; path must stay inside workspace); seed(prompt, budget) → ContextItems with range, reason, tokens, source 'auto', excluding files already mentioned; includes one tiny repo map ≤500 tokens within the budget.
parseMentions(text) pure + tests.
```
**Acceptance:** Integration moment #2: engine tools return real, fast, capped results. **Commit:** `feat(context): context provider and mentions`

---
## U-08 Agent panel webview (Day 6–7)
**May edit:** `src/ui/AgentPanel/*`, `media/panel.js|css`.
```
Build the agent side panel (WebviewViewProvider): CSP default-src 'none' with nonce, localResourceRoots=media only, plain JS, VS Code theme variables, textContent ONLY (never innerHTML).
Layout: (1) messages with incremental streaming (append to current node; autoscroll only if at bottom), (2) tool timeline rows (spinner→check/cross, short args, subagent markers, retry/failover notes), (3) "Files chosen and why" from seed + context.report with source badges (mention/auto/agent), (4) ONE budget meter: total run budget used/limit from budget events (the seed, mentions and tool results are all charged to it), with a breakdown on expand, (5) Proposed changes list (file, #hunks, rationale, Review button, status, and per-hunk Accept/Reject buttons for every hunk, always, independent of CodeLens), buttons Accept all / Reject all / Apply accepted / Undo last, (6) input with @mention autocomplete (up to 8 suggestions from the index) and chips, Send, Stop, active model name.
Keyboard accessible, readable at 150% zoom, big fonts for video. Panel must handle 500 timeline rows without lag.
```
**Acceptance:** with MockEngine the panel tells the whole Task B story; judges can understand it by looking. **Commit:** `feat(ui): agent panel with timeline, context list and budget meter`

---
## U-09 Multi-file batch review → reviewDone (Day 7)
**May edit:** `src/review/*`, `src/ui/AgentPanel/*`, `src/ui/EventRouter.ts`.
```
On review.required{batchId, proposalIds}: open the first proposal's diff only; list others in the panel; status bar "Forge: N files to review". "Apply accepted" runs ApplyManager once for the whole batch (one WorkspaceEdit, one undo record), then calls engine.reviewDone({batchId, proposals:[{proposalId, decisions, applied, failure?}], applyId}) — ALWAYS call it, even if everything was rejected (applied:false) or stale, so the agent can continue. "Reject all" also calls reviewDone. Closing diff tabs does not decide anything.
If the run is cancelled/discarded while reviewing: close diffs, clear list, do not call reviewDone.
```
**Acceptance:** I-2: 3-file batch applies in one action; one Undo reverts all; agent continues and runs tests. **Commit:** `feat(review): batch review and reviewDone handshake`

---
## U-10 Retrieval eval harness + second repo (Day 8–10) — evidence for B1
**STRETCH (cut first, docs/06 cut line 3). Minimum if behind: Flask only, 12 cases, no second repo, honest report.**
**May edit:** `scripts/eval-context.ts` (agreed with Dev 1), `fixtures/eval/*`, `docs/eval-report.md`, `docs/04` numbers.
```
Create fixtures/eval/<repo>/cases.jsonl for Flask 3.1.3 and ONE real second repo of a different shape (pin the commit in fixtures/eval/README.md): ≥12 cases each of kinds feature-in-words, bug-in-words, ambiguous, misleading-keyword, tests+docs-required, unconventional-naming, docs-only; ≥8 per repo with NO filenames or symbol names. expectedFiles are chosen by reading the repo, NOT by running our ranker.
npm run eval:context loads the real WorkspaceIndex + ranker (extract any vscode-dependent part behind an interface), prints recall@5, recall@10, MRR by kind and overall, seed tokens used vs budget, index time, and per-case misses. Split cases odd/even: tune weights only on odd; report even as the headline.
Write docs/eval-report.md: tables, weights used, 5 failure analyses, what we'd improve. Do not special-case any case.
```
**Acceptance:** targets in docs/04 met or honestly reported. **Commit:** `test(context): retrieval eval on two repos with held-out split`

---
## U-11 Extension-host e2e + cancel/failure UX (Day 9–11)
**STRETCH in part (docs/06 cut line 3). Minimum if behind: automated diff-safety + cancel unit tests, and one manual run of each matrix item that appears on camera.**
**May edit:** `test/e2e/*`, `src/ui/*`, `src/review/*`.
```
Add @vscode/test-electron tests (MockEngine + real ApplyManager/DiffReviewer on a temp workspace): diff-safety matrix in docs/05 (multi-hunk, multi-file, external edit during review → refused, unsaved base edit at proposal time → allowed, partial accept + undo, new file + undo, injected apply failure → restored, save failure, cancel while reviewing → nothing written); cancel matrix UI side; event-loop lag measurement (p95 < 50 ms while MockEngine streams 5 000 tokens); webview CSP check.
Fix every bug found. Verify typing/scrolling in another editor during streaming. Add the webview injection test from docs/05 (model/repo text such as `<img src=x onerror=alert(1)>`, `</script>` and a fake `vscode://` link must render as inert text; assert the panel DOM uses textContent only and the CSP blocks inline script).
```
**Acceptance:** all matrices pass; lag target met. **Commit:** `test(e2e): diff safety, cancel and responsiveness`

---
## U-12 Polish for the camera (Day 10–11)
**May edit:** `src/ui/*`, `src/review/*`, `media/*`.
```
Polish only what the video shows: clear notifications (no stack traces), consistent labels, big readable fonts in the panel, "Forge: Switch Model" QuickPick (profiles primary/fallback via engine.switchModel), status bar states (idle/running/retrying/reviewing N files/model), multi-file review ordering, keyboard shortcuts for accept/reject hunk, 'Undo last apply' visible after apply. No new features after G5.
```
**Commit:** `feat(ui): demo polish and model switch`

---
## U-13 Video + write-up §4 and §6 (Day 12–15)
**May edit:** `docs/writeup/04*.md`, `docs/writeup/06*.md`, `docs/rehearsal-log.md`.
```
Draft write-up §4 (layers/budgets table, ranking method, eval numbers from docs/eval-report.md, one honest failure) and §6 (scorecard table; leave timestamps as __:__ until the final video exists; only claims the video shows). Then, after recording, fill timestamps and verify each by listing the shot at that time.
```
Human work: rehearse A→B→C 3× (docs/05), record per docs/07 script, add on-screen captions (Task C: "fallback diff shown — deliberately not applied"), upload unlisted, verify the link logged-out.
**Commit:** `docs: context section and scorecard`
