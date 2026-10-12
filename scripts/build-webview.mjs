// Builds the webview client assets (TypeScript + CSS) into dist/.
// Run via `npm run build:webview`. The extension host loads these files from
// dist/ at runtime using webview.asWebviewUri, so F5 just needs this to run first.
import { build } from 'esbuild';

await build({
	entryPoints: [
		'src/graph/tags/tagsGraphRuntime.ts',
		'src/graph/tags/tagsGraphSubOnlyRuntime.ts',
		'src/graph/tags/tagsGraph.css',
		'src/graph/tags/tagsGraphSubOnly.css',
		'src/views/settings/webview/settings.ts',
		'src/views/settings/webview/settings.css',
		'src/views/editor/dripMdEditor/dripMdEditorRuntime.ts',
		'src/views/editor/dripMdEditor/dripMdEditor.css'
	],
	bundle: true,
	outdir: 'dist',
	entryNames: '[name]',
	format: 'iife',
	target: ['es2022'],
	sourcemap: false,
	minify: false,
	logLevel: 'info'
});
