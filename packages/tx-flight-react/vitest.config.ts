export default {
  test: {
    // `globals: true` lets `@testing-library/react` install its
    // `afterEach(cleanup)` automatically. Without it, rendered DOM
    // leaks across tests in the same file.
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    },
  },
}
