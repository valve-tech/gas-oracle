// Flat config (ESLint 9+). Pulls in the typescript-eslint recommended
// preset and pins our project's specific bans.
//
// The big one is `no-explicit-any` — `tsconfig.strict: true` only
// catches IMPLICIT any. Without this rule, an explicit `any` annotation
// compiles cleanly. We treat that as a quality regression to be flagged.

import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '.yarn/**', '**/examples/tsconfig.json'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // No `any`. Use `unknown` at boundaries and narrow.
      '@typescript-eslint/no-explicit-any': 'error',
      // Allow intentionally-unused parameters prefixed with `_`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Empty interfaces with one base type are useful for nominal
      // typing and re-exporting; leaving as 'warn' surfaces drift
      // without breaking the build.
      '@typescript-eslint/no-empty-object-type': 'warn',
    },
  },
)
