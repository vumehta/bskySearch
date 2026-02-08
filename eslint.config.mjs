import js from '@eslint/js';
import globals from 'globals';

export default [
  // ── Global ignores ──────────────────────────────────────────────
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.min.js',
      '**/*.min.css',
      '**/*.map',
    ],
  },

  // ── Shared settings ─────────────────────────────────────────────
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },

  // ── Base: @eslint/js recommended (58 core correctness rules) ───
  js.configs.recommended,

  // ── Project-wide rule overrides ─────────────────────────────────
  {
    rules: {
      // Convention enforcement
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': ['error', 'always'],
      'prefer-template': 'error',

      // Bug prevention
      'no-shadow': 'error',
      'no-unneeded-ternary': 'error',
      'default-case-last': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',
      'no-use-before-define': ['error', { functions: false }],
      'no-lonely-if': 'error',
      'no-useless-concat': 'error',
      'no-useless-rename': 'error',
      'no-useless-return': 'error',

      // Security (XSS/CSP guardrails)
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',

      // Production hygiene
      'no-console': 'error',
      'no-debugger': 'error',
      'no-alert': 'error',
      'no-implicit-coercion': 'error',

      // Async/Promise safety
      'no-await-in-loop': 'warn',
      'no-promise-executor-return': 'error',
      'require-atomic-updates': 'off',
    },
  },

  // ── Frontend source (src/**/*.mjs) ──────────────────────────────
  {
    files: ['src/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
  },

  // ── Backend (api/**/*.js) ───────────────────────────────────────
  {
    files: ['api/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
  },

  // ── Scripts (CommonJS) ──────────────────────────────────────────
  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // ── Scripts (ESM) ───────────────────────────────────────────────
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // ── Tests & vitest config ───────────────────────────────────────
  {
    files: ['tests/**/*.test.js', 'vitest.config.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
    },
    rules: {
      'no-console': 'off',
      'no-shadow': 'off',
      'no-unneeded-ternary': 'off',
      'no-use-before-define': 'off',
    },
  },
];
