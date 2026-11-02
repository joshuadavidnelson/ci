/**
 * Turns ESLint JSON output into a JS/TS complexity report section.
 *
 * The js.yml workflow runs ESLint with only two rules enabled, both at a
 * threshold of 0 so every function is reported with its score:
 *
 *   complexity                      "… has a complexity of 7. Maximum allowed is 0."
 *   sonarjs/cognitive-complexity    "Refactor this function to reduce its Cognitive Complexity from 9 to the 0 allowed."
 *
 * The score is read back out of the message text. Functions with a
 * cognitive complexity of 0 are not reported by sonarjs at all, so the
 * cognitive figures cover the functions that have any. Node built-ins only.
 */

'use strict';

const path = require( 'path' );
const { format, shownChange } = require( './render-pr-report' );

const DEFAULT_MAX = { cyclomatic: 10, cognitive: 15 };

const METRICS = {
	cyclomatic: { rule: 'complexity', pattern: /complexity of (\d+)/i, label: 'cyclomatic' },
	cognitive: { rule: 'sonarjs/cognitive-complexity', pattern: /from (\d+) to the \d+ allowed/i, label: 'cognitive' },
};

/**
 * Reads the function name ESLint's complexity message starts with.
 *
 * @param {string} message The ESLint message.
 * @return {string} e.g. "Function 'foo'", or "function" when unnamed.
 */
function functionName( message ) {
	const match = /^(.*?) has a complexity of/i.exec( message );
	return match ? match[ 1 ] : 'function';
}

/**
 * Parses ESLint's JSON formatter output.
 *
 * @param {Array}  results ESLint results (the parsed JSON array).
 * @param {string} root    Directory to show file paths relative to.
 * @return {{functions: Object[], parseErrors: number}} One entry per scored function.
 */
function parseEslint( results, root = '' ) {
	if ( ! Array.isArray( results ) ) {
		throw new Error( 'complexity: ESLint output must be a JSON array' );
	}

	const functions = [];
	let parseErrors = 0;

	for ( const result of results ) {
		const file = root ? path.relative( root, String( result.filePath ) ) : String( result.filePath );
		for ( const message of result.messages || [] ) {
			if ( message.fatal ) {
				parseErrors++;
				continue;
			}
			for ( const [ key, { rule, pattern } ] of Object.entries( METRICS ) ) {
				if ( message.ruleId !== rule ) {
					continue;
				}
				const match = pattern.exec( String( message.message ) );
				if ( match ) {
					functions.push( {
						metric: key,
						score: Number( match[ 1 ] ),
						file,
						line: message.line,
						name: key === 'cyclomatic' ? functionName( String( message.message ) ) : 'function',
					} );
				}
			}
		}
	}

	return { functions, parseErrors };
}

/**
 * Summarises parsed functions.
 *
 * @param {Object[]} functions From parseEslint().
 * @param {Object}   max       Ceilings keyed by metric.
 * @return {Object} `{ functions, maxCyclomatic, avgCyclomatic, overCyclomatic, maxCognitive, overCognitive }`.
 */
function summarise( functions, max ) {
	const scores = ( metric ) => functions.filter( ( f ) => f.metric === metric ).map( ( f ) => f.score );
	const cyclomatic = scores( 'cyclomatic' );
	const cognitive = scores( 'cognitive' );
	const avg = ( list ) => ( list.length ? Math.round( ( list.reduce( ( a, b ) => a + b, 0 ) / list.length ) * 100 ) / 100 : null );
	const top = ( list ) => ( list.length ? Math.max( ...list ) : null );

	return {
		functions: cyclomatic.length,
		maxCyclomatic: top( cyclomatic ),
		avgCyclomatic: avg( cyclomatic ),
		overCyclomatic: cyclomatic.filter( ( s ) => s > max.cyclomatic ).length,
		maxCognitive: top( cognitive ) ?? ( cyclomatic.length ? 0 : null ),
		overCognitive: cognitive.filter( ( s ) => s > max.cognitive ).length,
	};
}

/**
 * Reads and checks quality-thresholds.json's optional js.complexity block.
 *
 * Two shapes are accepted:
 *
 *   { "cyclomatic": 10, "cognitive": 15 }
 *       Flat ceilings. Every key given is gated, like a coverage floor:
 *       this is the shape a repo's own eslint.config.js reads its rule
 *       thresholds from.
 *
 *   { "max": { "cyclomatic": 10, "cognitive": 15 }, "gate": [ "cognitive" ] }
 *       Ceilings plus an explicit gate list, mirroring metrics.max/gate,
 *       for a ceiling that should be reported but not fail CI.
 *
 * With no block at all, the defaults are reported and nothing is gated.
 *
 * @param {Object} thresholds The parsed thresholds file.
 * @return {{max: Object, gate: string[]}} Ceilings and gated metric keys.
 */
function complexityConfig( thresholds ) {
	const block = ( thresholds && thresholds.js && thresholds.js.complexity ) || {};
	const structured = 'max' in block || 'gate' in block;

	let max;
	let gate;
	if ( structured ) {
		max = { ...DEFAULT_MAX, ...( block.max || {} ) };
		gate = block.gate || [];
	} else {
		const flat = Object.fromEntries( Object.entries( block ).filter( ( [ key ] ) => ! key.startsWith( '_' ) ) );
		max = { ...DEFAULT_MAX, ...flat };
		gate = Object.keys( flat );
	}

	for ( const key of [ ...Object.keys( max ), ...gate ] ) {
		if ( ! METRICS[ key ] ) {
			throw new Error( `complexity: "${ key }" in js.complexity is not a metric (expected ${ Object.keys( METRICS ).join( ', ' ) }).` );
		}
	}
	for ( const [ key, ceiling ] of Object.entries( max ) ) {
		if ( typeof ceiling !== 'number' ) {
			throw new Error( `complexity: js.complexity "${ key }" must be a number.` );
		}
	}
	return { max, gate };
}

/**
 * Builds the JS complexity report section.
 *
 * Rows that compare a function maximum against its ceiling get a ❌/✅;
 * a gated metric whose maximum exceeds its ceiling fails the section.
 *
 * @param {Object}      input            Render input.
 * @param {Array|null}  input.head       ESLint JSON for the PR, or null when ESLint produced none.
 * @param {Array|null}  input.base       ESLint JSON for the base, or null.
 * @param {Object}      input.thresholds Parsed quality-thresholds.json.
 * @param {string}      input.root       Directory file paths are shown relative to.
 * @param {string}      input.baseRoot   The same for the base checkout.
 * @param {string}      input.id         Section id.
 * @param {string}      input.title      Section title.
 * @param {string}      input.mode       Which ESLint config measured the PR: "repo", "builtin" or ''.
 * @return {Object} A section fragment.
 */
function buildComplexitySection( { head, base, thresholds, root = '', baseRoot = '', id = 'js-complexity', title = 'JS complexity', mode = '' } ) {
	const { max, gate } = complexityConfig( thresholds );

	if ( ! head ) {
		return {
			id,
			title,
			status: 'fail',
			empty: true,
			markdown: 'ESLint produced no output for this branch, so complexity could not be measured. See the run log.',
			failures: [ 'ESLint produced no complexity output for the PR branch' ],
		};
	}

	const parsedHead = parseEslint( head, root );
	const now = summarise( parsedHead.functions, max );
	const parsedBase = base ? parseEslint( base, baseRoot ) : null;
	const before = parsedBase && parsedBase.functions.length ? summarise( parsedBase.functions, max ) : null;
	const comparable = before !== null;

	const rowsSpec = [
		[ 'functions', 'Functions analysed', null, false ],
		[ 'avgCyclomatic', 'Avg cyclomatic complexity / function', null, true ],
		[ 'maxCyclomatic', 'Max cyclomatic complexity', 'cyclomatic', true ],
		[ 'overCyclomatic', `Functions over cyclomatic max (${ max.cyclomatic })`, null, true ],
		[ 'maxCognitive', 'Max cognitive complexity', 'cognitive', true ],
		[ 'overCognitive', `Functions over cognitive max (${ max.cognitive })`, null, true ],
	];

	const failures = [];
	let breaches = 0;
	let regressions = 0;
	const rows = [];

	for ( const [ key, label, ceilingKey, higherIsWorse ] of rowsSpec ) {
		const after = now[ key ];
		const prior = before ? before[ key ] : null;

		let maxCell = '—';
		if ( ceilingKey ) {
			const ceiling = max[ ceilingKey ];
			const breached = after !== null && after > ceiling;
			maxCell = `${ format( ceiling ) } ${ breached ? '❌' : '✅' }`;
			if ( breached ) {
				breaches++;
				if ( gate.includes( ceilingKey ) ) {
					failures.push( `Max ${ ceilingKey } complexity is ${ after } (max ${ ceiling })` );
				}
			}
		}

		if ( ! comparable ) {
			rows.push( [ label, format( after ), maxCell ] );
			continue;
		}

		let delta = '—';
		if ( prior !== null && after !== null ) {
			const change = shownChange( prior, after );
			if ( change !== 0 ) {
				const worse = higherIsWorse && change > 0;
				if ( worse ) {
					regressions++;
				}
				delta = `${ worse ? '⚠️ ' : '' }${ change > 0 ? '+' : '-' }${ format( Math.abs( change ) ) }`;
			}
		}
		rows.push( [ label, format( prior ), format( after ), delta, maxCell ] );
	}

	const offenders = parsedHead.functions
		.filter( ( f ) => f.score > max[ f.metric ] )
		.sort( ( a, b ) => b.score - a.score )
		.slice( 0, 10 );

	const summaryParts = [];
	if ( mode === 'repo' ) {
		summaryParts.push( "Measured with the repo's own ESLint config." );
	} else if ( mode === 'builtin' ) {
		summaryParts.push( 'Measured with the built-in complexity config.' );
	}
	if ( ! comparable ) {
		summaryParts.push( 'ℹ️ No base-branch measurement, so showing this branch on its own.' );
	}
	if ( parsedHead.parseErrors ) {
		summaryParts.push( `${ parsedHead.parseErrors } file${ parsedHead.parseErrors === 1 ? '' : 's' } could not be parsed and ${ parsedHead.parseErrors === 1 ? 'is' : 'are' } not counted.` );
	}
	if ( offenders.length ) {
		summaryParts.push(
			`Over the max: ${ offenders.map( ( f ) => `${ f.file }:${ f.line } (${ METRICS[ f.metric ].label } ${ f.score })` ).join( ', ' ) }.`
		);
	}

	let status = 'pass';
	if ( failures.length ) {
		status = 'fail';
	} else if ( breaches || regressions || parsedHead.parseErrors ) {
		status = 'warn';
	}

	return {
		id,
		title,
		status,
		baseline: comparable,
		// No function was scored and nothing failed to parse: nothing to show.
		...( now.functions === 0 && ! parsedHead.parseErrors ? { empty: true } : {} ),
		...( summaryParts.length ? { summary: summaryParts.join( ' ' ) } : {} ),
		rows: comparable
			? { columns: [ 'Metric', 'Base', 'PR', 'Δ', 'Max' ], align: [ 'left', 'right', 'right', 'right', 'right' ], rows }
			: { columns: [ 'Metric', 'PR', 'Max' ], align: [ 'left', 'right', 'right' ], rows },
		failures,
	};
}

module.exports = { DEFAULT_MAX, parseEslint, summarise, complexityConfig, buildComplexitySection };
