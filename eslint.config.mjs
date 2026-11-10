import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ ignores: ['dist/**', 'node_modules/**', 'data/**'] },
	{ ...js.configs.recommended, files: ['**/*.mjs', 'tests/**/*.cjs'] },
	{
		files: ['tests/**/*.cjs'],
		languageOptions: {
			globals: { require: 'readonly', console: 'readonly', process: 'readonly', setTimeout: 'readonly' }
		}
	},
	{
		files: ['src/**/*.ts'],
		extends: [tseslint.configs.recommended],
		languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
		rules: {
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-misused-promises': 'error',
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
		}
	}
);
