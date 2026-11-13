// ESLint flat config for the forge-agent extension.
// Required by S-01: `npm run check` runs `eslint src --ext ts`.
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    ignores: ['out/', 'node_modules/', '.vscode-test/', 'fixtures/', 'docs/'],
  },
];
