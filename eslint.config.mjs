// ESLint flat config for the DRIP extension.
//
// Two environments coexist in this repo:
//  - Extension host code (Node.js, CommonJS, .js) — lints against Node globals.
//  - Webview client code (browser, .ts in src/graph/tags and .js under */webview/*)
//    — lints against browser globals.
//
// Legacy JSDoc-typed code is not yet fully clean, so noisy rules (unused vars,
// no-undef on mixed legacy scripts) are relaxed rather than failing the build.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
	{
		ignores: [
			'node_modules/**',
			'dist/**',
			'out/**',
			'benchmarks/results/**',
			'.cache/**'
		]
	},

	js.configs.recommended,

	// typescript-eslint recommended, scoped to TypeScript files only so it does
	// not flag the legacy CommonJS `require()` calls in the host `.js` files.
	...tseslint.configs.recommended.map((c) => ({
		...c,
		files: ['**/*.ts', '**/*.tsx']
	})),

	// Browser webview assets (the converted client scripts: tag graph + settings).
	// These are legacy vanilla-JS files migrated to .ts for bundling; stylistic rules
	// that clash with the existing `var`/loose style are relaxed here only.
	{
		files: ['src/**/*.ts'],
		languageOptions: {
			globals: globals.browser
		},
		rules: {
			'no-undef': 'off',
			'no-var': 'off',
			'prefer-const': 'off',
			'no-empty': 'off',
			'no-constant-condition': 'off',
			'no-extra-boolean-cast': 'off',
			'no-unused-vars': 'off',
			'@typescript-eslint/no-unused-vars': 'off',
			'@typescript-eslint/no-explicit-any': 'off'
		}
	},

	// Browser webview scripts that are still plain .js (project view, retriever, canvas).
	{
		files: ['src/**/webview/**/*.js'],
		languageOptions: {
			globals: globals.browser
		},
		rules: {
			'no-undef': 'off',
			'no-unused-vars': 'off'
		}
	},

	// Everything else: extension host (Node.js, CommonJS).
	// Stylistic rules that clash with the legacy codebase style are relaxed here so
	// `npm run lint` stays a useful signal (real `no-undef` findings still surface).
	{
		files: ['**/*.js'],
		languageOptions: {
			globals: {
				...globals.node,
				...globals.commonjs
			}
		},
		rules: {
			'no-unused-vars': 'off',
			'no-useless-assignment': 'off',
			'no-useless-escape': 'off',
			'no-empty': 'off',
			'no-control-regex': 'off'
		}
	}
];
