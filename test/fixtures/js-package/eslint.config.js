// The fixture's own ESLint config, shaped like archived-post-status's: the
// complexity ceilings come from quality-thresholds.json, so `npm run
// lint:complexity` fails locally on the same numbers CI gates on. js.yml
// runs this script with the thresholds overridden to 0 to read every score.
import { readFileSync } from 'node:fs';
import sonarjs from 'eslint-plugin-sonarjs';

const { js } = JSON.parse( readFileSync( new URL( './quality-thresholds.json', import.meta.url ), 'utf8' ) );

export default [
	{
		files: [ 'src/**/*.js' ],
		plugins: { sonarjs },
		rules: {
			complexity: [ 'error', js.complexity.cyclomatic ],
			'sonarjs/cognitive-complexity': [ 'error', js.complexity.cognitive ],
		},
	},
];
