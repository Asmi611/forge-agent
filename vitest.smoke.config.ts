import { defineConfig } from 'vitest/config';

// The smoke test imports the extension source (`src/extension.ts`),
// which imports `vscode` (stubbed via `vi.mock('vscode')`), so it runs
// without a VS Code host. `allowImportingTsExtensions` is enabled in the
// project `tsconfig.json`, so the source import with a `.ts` extension is
// accepted.
export default defineConfig({
  test: {
    include: ['test/smoke/runTest.test.ts'],
  },
});
