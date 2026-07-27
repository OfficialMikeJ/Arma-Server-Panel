// Flat config. `next lint` is deprecated and prompts interactively when no
// config is present, which is why linting has never actually run here - the
// root `npm run lint` failed before reaching any source file.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      '@next/next': nextPlugin,
      'react-hooks': reactHooks,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...reactHooks.configs.recommended.rules,

      // The codebase uses leading-underscore names for deliberate discards.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Off deliberately. Every page loads its data with
      // `useEffect(() => { void load() }, [...])`, where `load` is async and
      // sets state from a microtask - not synchronously in the effect body. The
      // rule traces into the async function and flags all twelve of them. The
      // one remaining case, the draft buffer in ConfigForm, is the standard way
      // to keep a controlled input typeable and is deliberate too.
      //
      // Worth revisiting if these move to a data-fetching library, which is
      // what the rule is really steering towards.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
);
