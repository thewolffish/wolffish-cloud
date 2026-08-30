import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      // Bundled workspace defaults are user-facing assets copied into
      // ~/.wolffish on first launch. Plugin code there is JavaScript the
      // user can edit — not part of the app's TypeScript source.
      'src/defaults/workspace/**',
      'scripts/**'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  {
    // The CLI client is plain ESM JavaScript, not TypeScript: it is read
    // straight off disk and run under ELECTRON_RUN_AS_NODE, with no build
    // step to strip annotations. Only the TypeScript-shaped rules are off —
    // everything else (unused vars, correctness, prettier) still applies.
    //
    // electron-builder hooks in build/ are the same kind of file for the same
    // reason: Node loads them directly, so there is nothing to strip
    // annotations. Exempting the rule rather than adding them to `ignores`
    // (where scripts/ sits) keeps every non-TypeScript rule on them.
    files: ['src/cli/**/*.mjs', 'build/**/*.mjs'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  eslintConfigPrettier
)
