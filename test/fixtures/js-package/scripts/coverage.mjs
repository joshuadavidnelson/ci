// Writes coverage/coverage-summary.json in the istanbul json-summary shape
// that Jest and Vitest produce, from Node's built-in lcov reporter, so this
// fixture exercises the contract without installing a test framework.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

mkdirSync( 'coverage', { recursive: true } );
execFileSync( process.execPath, [
	'--test',
	'--experimental-test-coverage',
	// Explicit include/exclude: Node 24's defaults drop src/label.js from the
	// report when its test sits beside it in src/, leaving an empty summary.
	'--test-coverage-include=src/**',
	'--test-coverage-exclude=src/**/*.test.js',
	'--test-reporter=lcov',
	'--test-reporter-destination=coverage/lcov.info',
	'--test-reporter=spec',
	'--test-reporter-destination=stdout',
	'src/*.test.js',
], { stdio: 'inherit' } );

const totals = { lines: [ 0, 0 ], functions: [ 0, 0 ], branches: [ 0, 0 ] };
let inSource = false;
for ( const line of readFileSync( 'coverage/lcov.info', 'utf8' ).split( '\n' ) ) {
	if ( line.startsWith( 'SF:' ) ) {
		inSource = /(^|\/)src\//.test( line.slice( 3 ) ) && ! line.endsWith( '.test.js' );
	}
	if ( ! inSource ) {
		continue;
	}
	const [ key, value ] = line.split( ':' );
	const map = { LF: [ 'lines', 1 ], LH: [ 'lines', 0 ], FNF: [ 'functions', 1 ], FNH: [ 'functions', 0 ], BRF: [ 'branches', 1 ], BRH: [ 'branches', 0 ] };
	if ( map[ key ] ) {
		totals[ map[ key ][ 0 ] ][ map[ key ][ 1 ] ] += Number( value );
	}
}

const metric = ( [ covered, total ] ) => ( { total, covered, skipped: 0, pct: total ? Math.round( ( covered / total ) * 10000 ) / 100 : 100 } );
const total = {
	lines: metric( totals.lines ),
	statements: metric( totals.lines ),
	functions: metric( totals.functions ),
	branches: metric( totals.branches ),
};
writeFileSync( 'coverage/coverage-summary.json', JSON.stringify( { total }, null, 2 ) );
console.log( JSON.stringify( total ) );
