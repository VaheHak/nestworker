/**
 * ESLint configuration for nestworker.
 *
 * Style matches AGENTS.md / CONTRIBUTING.md:
 *   - 2-space indent, single quotes, ES2022 target.
 *   - `experimentalDecorators` + `emitDecoratorMetadata` enabled (Nest deco-
 *     rators on classes/params are valid even when params look "unused").
 *   - Hot-path code uses `unknown[]` + structural narrowing; `any` is
 *     deliberately allowed in a handful of bridge sites and downgraded to
 *     a warning rather than an error.
 *
 * Prettier owns formatting — its rules are loaded last via
 * `plugin:prettier/recommended` so they win every conflict.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: ['./tsconfig.eslint.json'],
    tsconfigRootDir: __dirname,
    sourceType: 'module',
    ecmaVersion: 2022,
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  env: {
    node: true,
    es2022: true,
    jest: true,
  },
  ignorePatterns: [
    'dist/**',
    'node_modules/**',
    'coverage/**',
    '.eslintrc.js',
    'jest.config.js',
  ],
  rules: {
    // ── Project style ───────────────────────────────────────────────────
    'prettier/prettier': [
      'warn',
      {
        singleQuote: true,
        trailingComma: 'all',
        tabWidth: 2,
        useTabs: false,
        printWidth: 100,
        endOfLine: 'auto',
      },
    ],
    quotes: [
      'warn',
      'single',
      { avoidEscape: true, allowTemplateLiterals: true },
    ],
    indent: 'off', // prettier owns this
    'no-trailing-spaces': 'warn',
    'eol-last': ['warn', 'always'],
    semi: ['warn', 'always'],

    // ── Decorator / Nest ergonomics ────────────────────────────────────
    // Allow unused constructor params — Nest DI relies on emitDecoratorMetadata
    // to inject services declared but not referenced by name.
    '@typescript-eslint/no-unused-vars': [
      'warn',
      {
        args: 'none',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      },
    ],
    'no-unused-vars': 'off',

    // ── Hot-path / boundary code ───────────────────────────────────────
    // The worker boundary uses `unknown` + structural casts heavily; the
    // few remaining `any` sites are intentional bridges. Warn, don't fail.
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',

    // ── Safety nets ────────────────────────────────────────────────────
    'no-console': 'off',
    'no-empty': ['warn', { allowEmptyCatch: true }],
    'prefer-const': 'warn',
    eqeqeq: ['warn', 'smart'],

    // `require()` is intentionally used in `di-serializer.ts` (scanning
    // `require.cache`) and `worker.service.ts` (lazy OTEL lookup).
    '@typescript-eslint/no-var-requires': 'off',
    '@typescript-eslint/no-require-imports': 'off',

    // The typed-EventEmitter pattern (`export declare interface Foo {...}`
    // + `export class Foo extends EventEmitter`) is the canonical way to
    // strongly-type `.on/.emit` overloads. It is intentional in
    // `core/worker.pool.ts`.
    '@typescript-eslint/no-unsafe-declaration-merging': 'off',
  },
  overrides: [
    {
      // Tests can be looser — fake services use `any` casts, decorators on
      // local test classes, and `fail()`-style assertions.
      files: ['test/**/*.ts', '**/*.spec.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unused-vars': 'off',
        '@typescript-eslint/no-empty-function': 'off',
        // Tests may build per-suite Nest @Module classes / helpers inside
        // describe-blocks for isolation. That's intentional.
        'no-inner-declarations': 'off',
      },
    },
    {
      // The example app prints to console and shows a couple of `any`
      // patterns for demo brevity — relax those there too.
      files: ['src/example/**/*.ts'],
      rules: {
        'no-console': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
};
