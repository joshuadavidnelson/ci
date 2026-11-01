/**
 * Fails the build when PHP or JS coverage drops below the floors in
 * quality-thresholds.json.
 *
 * The reusable workflows enforce floors from the report sections instead
 * (see index.js `enforce`); this stays as a standalone check for repos that
 * want it in their own workflows: `node check-coverage.js` with SUITES=php,
 * SUITES=js or both (the default). Kept out of any workflow so it can be unit
 * tested — see coverage.test.js.
 */

'use strict';

const fs = require( 'fs' );

const { parseClover, parseJestSummary, checkFloors } = require( './coverage' );

/**
 * Formats one checkFloors() result as a single readable output line.
 *
 * @param {string} suite  Suite label, e.g. 'PHP'.
 * @param {Object} result One entry from checkFloors().
 * @return {string} The line to print.
 */
function formatResult( suite, result ) {
	const { metric, pct, floor, ok } = result;
	if ( pct === null ) {
		return `${ suite } ${ metric }: n/a — not measured`;
	}
	return `${ suite } ${ metric }: ${ pct.toFixed( 2 ) }% (floor ${ floor }%) ${ ok ? 'OK' : 'FAIL' }`;
}

/**
 * Reads, parses and floor-checks one suite's coverage file, printing a line
 * per metric and a GitHub Actions error annotation per failure.
 *
 * @param {Object}   opts          Suite options.
 * @param {string}   opts.suite    Suite label, e.g. 'PHP'.
 * @param {string}   opts.filePath Path to the suite's coverage file.
 * @param {Object}   opts.fs       fs module (or a stand-in) to read with.
 * @param {Function} opts.parse    Parses the file's raw contents into actual coverage.
 * @param {Object}   opts.floors   Floors for this suite, from quality-thresholds.json.
 * @return {boolean} Whether every floor in this suite passed.
 */
function runSuite( { suite, filePath, fs: fsModule, parse, floors } ) {
	// A missing coverage file means the test step never ran, or ran and
	// silently failed to write its report. Skipping the suite in that case
	// would let a broken pipeline report green — exactly the false
	// assurance this check exists to prevent — so it is a hard failure.
	if ( ! fsModule.existsSync( filePath ) ) {
		console.error( `::error::${ suite } coverage file not found: ${ filePath }` );
		return false;
	}

	const actual = parse( fsModule.readFileSync( filePath, 'utf8' ) );
	const results = checkFloors( actual, floors );

	let ok = true;
	for ( const result of results ) {
		console.log( formatResult( suite, result ) );
		if ( ! result.ok ) {
			ok = false;
			console.error(
				`::error::${ suite } ${ result.metric } is ${ result.pct }% ` +
					`(floor ${ result.floor }%)`
			);
		}
	}

	return ok;
}

/**
 * Runs the selected suites' floor checks.
 *
 * @param {Object} opts          Run options.
 * @param {Object} opts.env      Environment variables to read config from.
 * @param {Object} opts.fs       fs module (or a stand-in) to read with.
 * @return {boolean} Whether every floor in the selected suites passed.
 */
function main( { env = process.env, fs: fsModule = fs } = {} ) {
	const {
		PHP_CLOVER = 'coverage/php-clover.xml',
		JS_SUMMARY = 'coverage/coverage-summary.json',
		THRESHOLDS = 'quality-thresholds.json',
		SUITES = 'php,js',
	} = env;

	const wanted = SUITES.split( /[\s,]+/ ).filter( Boolean );
	const unknown = wanted.filter( ( suite ) => ! [ 'php', 'js' ].includes( suite ) );
	if ( unknown.length || ! wanted.length ) {
		throw new Error( `check-coverage: SUITES must list php and/or js, got "${ SUITES }"` );
	}

	const thresholds = JSON.parse( fsModule.readFileSync( THRESHOLDS, 'utf8' ) );
	const coverage = thresholds.coverage || {};

	let ok = true;

	if ( wanted.includes( 'php' ) ) {
		ok = runSuite( {
			suite: 'PHP',
			filePath: PHP_CLOVER,
			fs: fsModule,
			parse: parseClover,
			floors: coverage.php || {},
		} ) && ok;
	}

	if ( wanted.includes( 'js' ) ) {
		ok = runSuite( {
			suite: 'JS',
			filePath: JS_SUMMARY,
			fs: fsModule,
			parse: ( contents ) => parseJestSummary( JSON.parse( contents ) ),
			floors: coverage.js || {},
		} ) && ok;
	}

	return ok;
}

module.exports = { main };

/* istanbul ignore next -- CLI wiring, exercised by the integration test. */
if ( require.main === module ) {
	process.exit( main( {} ) ? 0 : 1 );
}
