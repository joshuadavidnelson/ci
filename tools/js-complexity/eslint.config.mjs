// Complexity-only ESLint config used by js.yml. It replaces the measured
// repo's own config entirely (--config + this file), so every repo is scored
// the same way whatever lint rules it chooses.
//
// Both rules run at a threshold of 0 so every function is reported with its
// score; render-report reads the numbers back out of the messages and
// applies the real ceilings from quality-thresholds.json.
import tsParser from '@typescript-eslint/parser';
import sonarjs from 'eslint-plugin-sonarjs';

export default [
	{
		ignores: [
			'**/node_modules/**',
			'**/vendor/**',
			'**/dist/**',
			'**/build/**',
			'**/coverage/**',
			'**/*.min.js',
			// Tests are not product code: their describe/it nesting would
			// dominate the scores.
			'**/*.test.*',
			'**/*.spec.*',
			'**/__tests__/**',
		],
	},
	{
		files: [ '**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}' ],
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 'latest',
			sourceType: 'module',
			parserOptions: { ecmaFeatures: { jsx: true } },
		},
		linterOptions: {
			// An eslint-disable comment in the measured code must not hide
			// a function from the complexity report.
			noInlineConfig: true,
			reportUnusedDisableDirectives: 'off',
		},
		plugins: { sonarjs },
		rules: {
			complexity: [ 'warn', 0 ],
			'sonarjs/cognitive-complexity': [ 'warn', 0 ],
		},
	},
];
