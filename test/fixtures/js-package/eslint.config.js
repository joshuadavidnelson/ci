// The fixture's own ESLint config, shaped like archived-post-status's: the
// complexity ceilings come from quality-thresholds.json, so `npm run
// lint:complexity` fails locally on the same numbers CI gates on. js.yml
// runs this script with the thresholds overridden to 0 to read every score.
//
// The co-located test files are ignored at the TOP level, not inside the
// sonarjs block: js.yml adds a sonarjs/cognitive-complexity override to
// every file ESLint lints, so any linted file without the sonarjs plugin
// would abort the run ("sonarjs plugin is not defined"). src/label.test.js
// is here to keep that true.
import { readFileSync } from 'node:fs';
import sonarjs from 'eslint-plugin-sonarjs';

const { js } = JSON.parse( readFileSync( new URL( './quality-thresholds.json', import.meta.url ), 'utf8' ) );

export default [
	{
		ignores: [ '**/*.test.js' ],
	},
	{
		files: [ 'src/**/*.js' ],
		plugins: { sonarjs },
		rules: {
			complexity: [ 'error', js.complexity.cyclomatic ],
			'sonarjs/cognitive-complexity': [ 'error', js.complexity.cognitive ],
		},
	},
];
