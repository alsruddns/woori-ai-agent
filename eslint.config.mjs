import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {ignores:['node_modules/**','dist/**','reports/**','data/**']},
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {rules:{'@typescript-eslint/no-explicit-any':'off'}},
  {files:['**/*.ts','**/*.tsx'],languageOptions:{globals:{process:'readonly',console:'readonly',setTimeout:'readonly',URL:'readonly',AbortSignal:'readonly',fetch:'readonly'}}},
  {files:['**/*.mjs'],languageOptions:{globals:{process:'readonly',console:'readonly'}}},
);
