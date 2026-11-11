# 04 — Context engine (owner: Dev 2) — worth 15 points

## Goals
Find the right code in a repo bigger than the window, **explain why**, stay inside a **visible budget**, generalise beyond Flask, and never hard-code names.

## Layers and budgets
| Layer | What | Budget |
|---|---|---|
| 1 @mentions | `@path` → file (≤400 lines else symbol outline); `@symbol` → its body (≤80 lines) | ≤400 lines each; **all mentions together ≤ 6 000 tokens** (excess → outline) |
| 2 Seed | automatic retrieval before the agent starts | **3000 tokens** (setting) incl. 1 tiny repo map (≤500) |
| 3 Agent tools | repoMap/search/findSymbol/readFile with hard caps | per tool (see 01 §3) |
| 4 Cumulative cap | engine counts seed + @mentions + all tool results per run (identical repeats deduplicated) | **30 000** default, scaled down for small models by `modelContextTokens` (80% warning) |
| 5 Transparency | `reportContext` (agent) + seed reasons → "Files chosen and why" + budget meter | always |
Token estimate = chars/4 (documented limitation). **Scaling (V2.3.4):** `effective = min(configured, fraction × modelContextTokens)` with fractions run 25 %, seed 5 %, mentions 5 % (default window 128 000; a small local model sets 8 000–16 000 in `forge/models.local.json`). The seed and mentions are charged to the same run budget as tool results, so the cap really bounds what we put into the context.

## Retrieval method (lexical, explainable, model-free)
1. **Query analysis:** lowercase; split snake_case/camelCase/kebab; drop stopwords & <3-char tokens; keep quoted strings and identifier-like tokens as high-value; detect *intent words* (test/tests/spec, doc/docs/documentation/readme, config/settings, cli/command) **by category only, not by project names**.
2. **BM25F** over fields with configurable weights (`forge.context.weights.*`): path words (default 3.0), symbol names (3.0), headings/docstring first lines (2.0), body (1.0); k1=1.2, b=0.75; IDF computed on the workspace.
3. **Structure signals:** (a) *test affinity* — files whose path words contain `test` and overlap a top source file's path words/imports; (b) *doc affinity* — doc files (`.md/.rst/.txt`) mentioning a top module/symbol; (c) *import neighbours* — Python `import/from`, TS/JS `import … from` edges one hop from top-3 files (cheap regex graph).
4. **Slot reservation:** if intent words include tests/docs, reserve ≥1 slot for the best test candidate and ≥1 for the best doc candidate even if their raw score is lower.
5. **Diversity:** MMR-style penalty so ≤3 files share a directory in the top 8.
6. **Noise penalties:** very large files ×0.7, lockfiles/changelogs/generated/minified ×0.3, vendored dirs excluded.
7. **Output:** ranked `{path, score, reason}`; reason lists matched fields/terms/signals ("path: cli; symbols: …; test of cli.py"). Snippet = best-matching symbol range or first 60 lines. `fitToBudget` fills the seed.
Weights are inputs, not constants: `RankerConfig` passed in; defaults in settings; eval can sweep them.

## Evaluation (evidence for judges and for us)
**STRETCH policy (V2.3.4):** the retrieval eval is evidence, not a scored item. Full plan below (two repos, held-out split). **Minimum if behind (docs/06 cut line 3):** Flask only, 12 cases, no second repo, honest report. B1's top anchor needs the strategy, the budget and the files-chosen-and-why panel visible in Task B, not the eval.

- `fixtures/eval/<repo>/cases.jsonl`: `{prompt, expectedFiles[], kind}`. **≥12 prompts**, ≥8 contain **no filenames or symbol names**; at least: feature-in-words, bug-in-words, ambiguous, misleading-keyword, tests+docs required, rename-heavy naming, docs-only.
- Repos: **Flask 3.1.3** + **one real second repo** of a different shape (small TypeScript project or another Python project, pinned commit; list in `fixtures/eval/README.md`).
- `npm run eval:context` prints recall@5 / recall@10 / MRR per kind and overall, tokens used, and latency. **Targets:** recall@10 ≥ 0.8 overall, ≥ 0.7 on filename-free prompts, seed within budget 100%, index build < 5 s on Flask, search < 200 ms.
- Commit `docs/eval-report.md` (table + 5 failure analyses). Tuning on the eval set is allowed **only** with a held-out half: tune on odd cases, report on even cases.
- Task B wording is *one* case; never optimise for it alone.

## Why not embeddings
No extra model/service, deterministic, explainable reasons, fast on 17k lines, zero cost, works offline. Trade-off: weaker on pure-synonym queries; mitigated by agent-driven tools. Listed as "next month" work.

## Performance rules
Index in chunks (yield every ~100 files), cache by mtime+size, update on save/watch, never block the extension host, measure and print timings in the Output channel.
