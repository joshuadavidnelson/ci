/**
 * Renders the PHPMetrics and coverage tables that become report sections.
 *
 * Each render* function returns the markdown body of one section (no
 * heading: sections.js adds that when it merges them into the comment), and
 * each build* function wraps it into a section fragment with a status. Node
 * built-ins only: the workflows run these scripts without an npm install.
 */

'use strict';

// quality-thresholds.json only stores numbers (metrics.max); this catalogue
// is the schema knowledge of where each thresholded metric lives in a
// PHPMetrics summary and what to call it in the table. A key present in
// metrics.max but missing here is treated as a config error, not silently
// dropped — see the lookup in renderMetricsSection().
const CATALOGUE = {
	critical: { section: 'Violations', label: 'Violations: critical' },
	error: { section: 'Violations', label: 'Violations: error' },
	avgCyclomaticComplexityByClass: { section: 'Complexity', label: 'Avg cyclomatic complexity / class' },
	logicalLinesByMethod: { section: 'LOC', label: 'Logical lines per method' },
	lackCohesionOfMethods: { section: 'OOP', label: 'Lack of cohesion of methods' },
	avgEfferentCoupling: { section: 'Coupling', label: 'Avg efferent coupling' },
};

// Every field a suite can report. A field neither side measured is left out
// of the table entirely rather than shown as `n/a` — PHP branch coverage is
// permanently unmeasured (Xdebug does not populate clover's conditionals),
// and a row that can only ever say "no data" is noise.
const COVERAGE_SUITES = [
	[ 'php', 'PHP', [ [ 'lines', 'Lines' ], [ 'methods', 'Methods' ], [ 'branches', 'Branches' ] ] ],
	[ 'js', 'JS', [ [ 'statements', 'Statements' ], [ 'branches', 'Branches' ], [ 'functions', 'Functions' ], [ 'lines', 'Lines' ] ] ],
];

/**
 * Reads one metric, treating anything non-numeric as absent.
 *
 * @param {Object} report  A PHPMetrics summary.
 * @param {string} section Top-level group, e.g. 'Complexity'.
 * @param {string} key     Metric name within the group.
 * @return {number|null} The value, or null when the report omits it.
 */
function value( report, section, key ) {
	const found = ( ( report && report[ section ] ) || {} )[ key ];
	return typeof found === 'number' ? found : null;
}

/**
 * Formats a number for the table: integers bare, everything else to 2dp.
 *
 * @param {number|null} n The value.
 * @return {string} The rendered cell.
 */
function format( n ) {
	if ( n === null || n === undefined ) {
		return 'n/a';
	}
	return Number.isInteger( n ) ? String( n ) : n.toFixed( 2 );
}

/**
 * The change between two values, measured on what the table actually shows.
 *
 * Rounding the raw values and rounding the difference are not the same
 * operation, so computing the delta from the inputs lets it contradict the
 * cells beside it — 6.004 and 6.006 render as 6.00 and 6.01 while their raw
 * difference rounds to zero. Diffing the displayed numbers keeps the three
 * columns telling one story.
 *
 * @param {number} before Base value.
 * @param {number} after  PR value.
 * @return {number} The change, to the same precision as the cells.
 */
function shownChange( before, after ) {
	return Number( ( Number( format( after ) ) - Number( format( before ) ) ).toFixed( 2 ) );
}

/**
 * Formats a coverage Metric as a percentage cell.
 *
 * `null` means the suite doesn't measure this (e.g. Xdebug never populates
 * PHP branch coverage) — that's a normal, expected state, not a zero.
 *
 * @param {{pct: number}|null} metric The coverage metric, or null if unmeasured.
 * @return {string} The rendered cell.
 */
function pct( metric ) {
	return metric === null || metric === undefined ? 'n/a' : `${ format( metric.pct ) }%`;
}

/**
 * Whether the base summary can be diffed against, for the no-baseline guard.
 *
 * @param {Object} base A PHPMetrics summary for the base branch.
 * @return {boolean} True when the base declares classes to measure.
 */
function hasMetricsBaseline( base ) {
	// Every metric PHPMetrics summarises derives from classes, so a base with
	// none reports 0 across the board. Diffing against that would render the
	// whole table as a regression from zero.
	return value( base, 'OOP', 'classes' ) > 0;
}

/**
 * Whether a coverage report has any real data, used for the no-baseline guard.
 *
 * @param {Object} report A `{ php, js }` coverage report.
 * @return {boolean} True when at least one suite metric was measured.
 */
function hasCoverage( report ) {
	if ( ! report ) {
		return false;
	}
	const values = [ ...Object.values( report.php || {} ), ...Object.values( report.js || {} ) ];
	return values.some( ( m ) => m !== null && m !== undefined );
}

/**
 * Compares PHPMetrics values against their configured ceilings and the base.
 *
 * Shared by renderMetricsSection (the table) and buildMetricsSection (the
 * status), so the two can never disagree about what breached.
 *
 * @param {Object}   input      Render input.
 * @param {Object}   input.head PHPMetrics summary for the PR branch.
 * @param {Object}   input.base PHPMetrics summary for the base branch.
 * @param {Object}   input.max  quality-thresholds.json's `metrics.max`.
 * @param {string[]} input.gate quality-thresholds.json's `metrics.gate`.
 * @return {Object} `{ comparable, rows, regressions, breaches, failures }`.
 */
function analyseMetrics( { head, base, max, gate = [] } ) {
	// Every metric PHPMetrics summarises is derived from classes, so a base
	// with none reports 0 across the board — even neutral counts. Diffing
	// against that would render the whole table as a regression from zero,
	// so fall back to reporting this branch on its own.
	const comparable = hasMetricsBaseline( base );

	for ( const key of gate ) {
		if ( ! ( key in ( max || {} ) ) ) {
			throw new Error(
				`render-pr-report: "${ key }" is in quality-thresholds.json's metrics.gate but has no ceiling in metrics.max.`
			);
		}
	}

	const rows = [];
	const failures = [];
	let regressions = 0;
	let breaches = 0;

	for ( const key of Object.keys( max || {} ) ) {
		const entry = CATALOGUE[ key ];
		if ( ! entry ) {
			throw new Error(
				`render-pr-report: "${ key }" is in quality-thresholds.json's metrics.max but has no entry in CATALOGUE (render-pr-report.js) — add one.`
			);
		}
		const { section, label } = entry;
		const ceiling = max[ key ];

		const before = value( base, section, key );
		const after = value( head, section, key );
		if ( before === null && after === null ) {
			continue;
		}

		// Distinct from the Δ column below: a metric can regress against the
		// base while still sitting under its ceiling, and both need to show.
		const breached = after !== null && after > ceiling;
		if ( breached ) {
			breaches++;
			if ( gate.includes( key ) ) {
				failures.push( `${ label } is ${ format( after ) } (max ${ format( ceiling ) })` );
			}
		}
		const maxCell = after === null ? format( ceiling ) : `${ format( ceiling ) } ${ breached ? '❌' : '✅' }`;

		if ( ! comparable ) {
			rows.push( `| ${ label } | ${ format( after ) } | ${ maxCell } |` );
			continue;
		}

		let delta = '—';
		if ( before !== null && after !== null ) {
			const change = shownChange( before, after );
			if ( change !== 0 ) {
				// Every thresholded metric is a ceiling now, so worse always
				// means it went up — there's no lowerIsBetter flag to check.
				const worse = change > 0;
				if ( worse ) {
					regressions++;
				}
				delta = `${ worse ? '⚠️ ' : '' }${ change > 0 ? '+' : '-' }${ format( Math.abs( change ) ) }`;
			}
		}
		rows.push( `| ${ label } | ${ format( before ) } | ${ format( after ) } | ${ delta } | ${ maxCell } |` );
	}

	return { comparable, rows, regressions, breaches, failures };
}

/**
 * Builds the Code Metrics section body: PHPMetrics values against their
 * configured ceilings.
 *
 * @param {Object} input Render input, as for analyseMetrics().
 * @return {string} Markdown for the section body, starting with its headline.
 */
function renderMetricsSection( input ) {
	const { comparable, rows, regressions, breaches } = analyseMetrics( input );

	const icon = breaches > 0 ? '❌' : comparable ? ( regressions > 0 ? '⚠️' : '✅' ) : 'ℹ️';
	const baselineSentence = comparable
		? regressions === 0
			? 'No metric moved in the wrong direction.'
			: `${ regressions } metric${ regressions === 1 ? '' : 's' } moved in the wrong direction.`
		: 'Base declares no classes, so there is no class-based baseline to diff against. Showing this branch on its own.';
	const thresholdSentence =
		breaches === 0 ? 'All within threshold.' : `${ breaches } metric${ breaches === 1 ? '' : 's' } breached threshold.`;

	return [
		`${ icon } ${ baselineSentence } ${ thresholdSentence }`,
		'',
		...( comparable
			? [ '| Metric | Base | PR | Δ | Max |', '| --- | ---: | ---: | ---: | ---: |' ]
			: [ '| Metric | PR | Max |', '| --- | ---: | ---: |' ] ),
		...rows,
	].join( '\n' );
}

/**
 * Builds the PHP metrics report section.
 *
 * Status: fail when a gated metric breaches its ceiling, warn when an
 * ungated one does or anything regressed against the base, pass otherwise.
 *
 * @param {Object}      input       Render input.
 * @param {Object|null} input.head  PHPMetrics summary for the PR, or null when none was produced.
 * @param {Object|null} input.base  PHPMetrics summary for the base, or null.
 * @param {Object}      input.max   quality-thresholds.json's `metrics.max`.
 * @param {string[]}    input.gate  quality-thresholds.json's `metrics.gate`.
 * @param {string}      input.id    Section id.
 * @param {string}      input.title Section title.
 * @return {Object} A section fragment.
 */
function buildMetricsSection( { head, base, max, gate = [], id = 'php-metrics', title = 'PHP code metrics' } ) {
	if ( ! head ) {
		return {
			id,
			title,
			status: 'fail',
			markdown: 'PHPMetrics produced no summary for this branch, so there is nothing to report. See the run log.',
			failures: [ 'PHPMetrics produced no summary for the PR branch' ],
		};
	}

	const input = { head, base: base || {}, max: max || {}, gate };
	const analysis = analyseMetrics( input );

	let status = 'pass';
	if ( analysis.failures.length ) {
		status = 'fail';
	} else if ( analysis.breaches > 0 || analysis.regressions > 0 ) {
		status = 'warn';
	}

	return {
		id,
		title,
		status,
		baseline: analysis.comparable,
		markdown: renderMetricsSection( input ),
		failures: analysis.failures,
	};
}

/**
 * Rejects a floor this renderer would not apply to anything.
 *
 * An unrecognised suite or metric key renders as "no floor configured",
 * which is indistinguishable from a deliberate decision not to gate it. A
 * typo in quality-thresholds.json would then quietly stop reporting a floor
 * on a metric that has one, so it fails loudly instead.
 *
 * @param {Object} floors quality-thresholds.json's `coverage`.
 * @throws {Error} When a suite or metric key is not one this renderer knows.
 */
function assertKnownFloors( floors ) {
	for ( const [ suiteKey, suiteFloors ] of Object.entries( floors || {} ) ) {
		const suite = COVERAGE_SUITES.find( ( [ key ] ) => key === suiteKey );
		if ( ! suite ) {
			throw new Error(
				`render-pr-report: "${ suiteKey }" is not a coverage suite (expected ${ COVERAGE_SUITES.map( ( [ key ] ) => key ).join( ', ' ) }).`
			);
		}

		const known = suite[ 2 ].map( ( [ key ] ) => key );
		for ( const metricKey of Object.keys( suiteFloors || {} ) ) {
			if ( ! known.includes( metricKey ) ) {
				throw new Error(
					`render-pr-report: "${ suiteKey }.${ metricKey }" is not a metric this suite reports (expected ${ known.join( ', ' ) }).`
				);
			}
		}
	}
}

/**
 * Builds the Coverage section: per-suite coverage against its configured floor.
 *
 * @param {Object} input        Render input.
 * @param {Object} input.head   `{ php, js }` coverage for the PR branch.
 * @param {Object} input.base   `{ php, js }` coverage for the base branch.
 * @param {Object} input.floors quality-thresholds.json's `coverage`.
 * @return {string} Markdown for the section.
 */
function renderCoverageSection( { head, base, floors } ) {
	assertKnownFloors( floors );

	// Mirrors the metrics no-baseline guard: a base with no coverage data at
	// all (the workflow skipped it, or this is the first run) would
	// otherwise render every row as a drop to 0%.
	const comparable = hasCoverage( base );

	const rows = [];
	for ( const [ suiteKey, suiteLabel, fields ] of COVERAGE_SUITES ) {
		const suiteFloors = ( floors && floors[ suiteKey ] ) || {};

		for ( const [ metricKey, metricLabel ] of fields ) {
			const before = ( ( base && base[ suiteKey ] ) || {} )[ metricKey ] ?? null;
			const after = ( ( head && head[ suiteKey ] ) || {} )[ metricKey ] ?? null;
			const floor = suiteFloors[ metricKey ];

			// Neither side measured it, so there is nothing to report. Matches
			// how the metrics table drops a metric absent from both summaries.
			if ( before === null && after === null ) {
				continue;
			}

			// An unmeasured metric (null) has nothing to gate on, and a
			// metric with no configured floor isn't gated either — both
			// render as "—", never a false ❌.
			let floorCell = '—';
			if ( after !== null && typeof floor === 'number' ) {
				floorCell = `${ format( floor ) }% ${ after.pct >= floor ? '✅' : '❌' }`;
			}

			if ( ! comparable ) {
				rows.push( `| ${ suiteLabel } | ${ metricLabel } | ${ pct( after ) } | ${ floorCell } |` );
				continue;
			}

			let delta = '—';
			if ( before !== null && after !== null ) {
				const change = shownChange( before.pct, after.pct );
				if ( change !== 0 ) {
					delta = `${ change > 0 ? '+' : '-' }${ format( Math.abs( change ) ) }%`;
				}
			}
			rows.push( `| ${ suiteLabel } | ${ metricLabel } | ${ pct( before ) } | ${ pct( after ) } | ${ delta } | ${ floorCell } |` );
		}
	}

	// Dropping unmeasured rows can empty the table completely, which would
	// leave a heading over nothing but column names.
	if ( ! rows.length ) {
		return '';
	}

	return [
		...( comparable
			? []
			: [ "ℹ️ No coverage data for the base branch. Showing the PR's numbers alone.", '' ] ),
		...( comparable
			? [ '| Suite | Metric | Base | PR | Δ | Floor |', '| --- | --- | ---: | ---: | ---: | ---: |' ]
			: [ '| Suite | Metric | PR | Floor |', '| --- | --- | ---: | ---: |' ] ),
		...rows,
	].join( '\n' );
}

/**
 * Builds a coverage report section for one or more suites.
 *
 * Status: fail when a measured metric is under its floor, warn when one
 * dropped against a comparable base, pass otherwise. A missing head report
 * fails: the test step never wrote one, and a silent pass there is exactly
 * the false assurance the floors exist to prevent.
 *
 * @param {Object}      input        Render input.
 * @param {Object|null} input.head   `{ php?, js? }` coverage for the PR, or null when no report was produced.
 * @param {Object|null} input.base   `{ php?, js? }` coverage for the base, or null.
 * @param {Object}      input.floors Floors keyed by suite, a subset of quality-thresholds.json's `coverage`.
 * @param {string}      input.id     Section id.
 * @param {string}      input.title  Section title.
 * @return {Object} A section fragment.
 */
function buildCoverageSection( { head, base, floors, id, title } ) {
	if ( ! head ) {
		return {
			id,
			title,
			status: 'fail',
			markdown: 'No coverage report was produced for this branch, so the tests probably failed before writing one. See the run log.',
			failures: [ `${ title }: no coverage report was produced` ],
		};
	}

	const markdown = renderCoverageSection( { head, base, floors } );
	const comparable = hasCoverage( base );

	const failures = [];
	let dropped = false;
	for ( const [ suiteKey, suiteLabel, fields ] of COVERAGE_SUITES ) {
		const suiteFloors = ( floors && floors[ suiteKey ] ) || {};
		const suiteHead = ( head && head[ suiteKey ] ) || {};
		const suiteBase = ( base && base[ suiteKey ] ) || {};

		for ( const [ metricKey, metricLabel ] of fields ) {
			const after = suiteHead[ metricKey ] ?? null;
			const before = suiteBase[ metricKey ] ?? null;
			const floor = suiteFloors[ metricKey ];

			if ( after !== null && typeof floor === 'number' && after.pct < floor ) {
				failures.push( `${ suiteLabel } ${ metricLabel.toLowerCase() } coverage is ${ format( after.pct ) }% (floor ${ format( floor ) }%)` );
			}
			if ( comparable && after !== null && before !== null && shownChange( before.pct, after.pct ) < 0 ) {
				dropped = true;
			}
		}
	}

	let status = 'pass';
	if ( failures.length ) {
		status = 'fail';
	} else if ( dropped ) {
		status = 'warn';
	}

	return {
		id,
		title,
		status,
		baseline: comparable,
		markdown: markdown || 'The coverage report contained no measured metrics.',
		failures,
	};
}

module.exports = {
	CATALOGUE,
	format,
	shownChange,
	analyseMetrics,
	renderMetricsSection,
	buildMetricsSection,
	renderCoverageSection,
	buildCoverageSection,
};
