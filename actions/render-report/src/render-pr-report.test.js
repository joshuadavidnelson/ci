'use strict';

const {
	renderMetricsSection,
	renderCoverageSection,
	buildMetricsSection,
	buildCoverageSection,
} = require( './render-pr-report' );

// Mirrors quality-thresholds.json's metrics.max — kept local so these tests
// don't break if the real file's numbers change.
const MAX = {
	critical: 0,
	error: 0,
	avgCyclomaticComplexityByClass: 8,
	logicalLinesByMethod: 12,
	lackCohesionOfMethods: 3.5,
	avgEfferentCoupling: 4,
};

const FLOORS = {
	php: { lines: 90, methods: 90 },
	js: { statements: 95, branches: 90, functions: 95, lines: 95 },
};

/**
 * Builds renderMetricsSection input, defaulting both branches to a
 * comparable baseline.
 *
 * @param {Object} head Sections to merge into the PR summary.
 * @param {Object} base Sections to merge into the base summary.
 * @param {Object} max  Overrides for quality-thresholds.json's metrics.max.
 * @return {Object} Input for renderMetricsSection.
 */
const metricsInput = ( head = {}, base = {}, max = MAX ) => ( {
	head: { OOP: { classes: 5 }, ...head },
	base: { OOP: { classes: 5 }, ...base },
	max,
} );

/**
 * Extracts the table row for a label, so assertions do not depend on
 * where the metric happens to sit in the table.
 *
 * @param {string} body  Rendered markdown.
 * @param {string} label Row label (metric label, or "Suite | Metric").
 * @return {string|undefined} The row, if rendered.
 */
const row = ( body, label ) => body.split( '\n' ).find( ( line ) => line.startsWith( `| ${ label } |` ) );

/**
 * Builds a coverage Metric.
 *
 * @param {number} covered Covered units.
 * @param {number} total   Total units.
 * @param {number} pct     Percentage covered.
 * @return {Object} A Metric.
 */
const metric = ( covered, total, pct ) => ( { covered, total, pct } );

describe( 'renderMetricsSection', () => {
	it( 'renders a five-column diff table against a comparable base', () => {
		const body = renderMetricsSection( metricsInput() );

		expect( body ).toContain( '| Metric | Base | PR | Δ | Max |' );
	} );

	it( 'reports no regression and no breach when nothing moved', () => {
		const body = renderMetricsSection(
			metricsInput( { Complexity: { avgCyclomaticComplexityByClass: 6 } }, { Complexity: { avgCyclomaticComplexityByClass: 6 } } )
		);

		expect( body ).toContain( '✅ No metric moved in the wrong direction. All within threshold.' );
		expect( row( body, 'Avg cyclomatic complexity / class' ) ).toBe(
			'| Avg cyclomatic complexity / class | 6 | 6 | — | 8 ✅ |'
		);
	} );

	it( 'flags and counts a metric that rose, and shows it is still within its ceiling', () => {
		const body = renderMetricsSection(
			metricsInput(
				{ Complexity: { avgCyclomaticComplexityByClass: 6.49 } },
				{ Complexity: { avgCyclomaticComplexityByClass: 6.31 } }
			)
		);

		expect( body ).toContain( '⚠️ 1 metric moved in the wrong direction. All within threshold.' );
		expect( row( body, 'Avg cyclomatic complexity / class' ) ).toBe(
			'| Avg cyclomatic complexity / class | 6.31 | 6.49 | ⚠️ +0.18 | 8 ✅ |'
		);
	} );

	it( 'pluralises the regression count', () => {
		const body = renderMetricsSection(
			metricsInput(
				{ Complexity: { avgCyclomaticComplexityByClass: 6.5 }, Coupling: { avgEfferentCoupling: 3 } },
				{ Complexity: { avgCyclomaticComplexityByClass: 6 }, Coupling: { avgEfferentCoupling: 2 } }
			)
		);

		expect( body ).toContain( '⚠️ 2 metrics moved in the wrong direction. All within threshold.' );
	} );

	it( 'does not flag a metric that fell', () => {
		const body = renderMetricsSection(
			metricsInput(
				{ Complexity: { avgCyclomaticComplexityByClass: 6 } },
				{ Complexity: { avgCyclomaticComplexityByClass: 6.5 } }
			)
		);

		expect( body ).toContain( '✅ No metric moved in the wrong direction. All within threshold.' );
		expect( row( body, 'Avg cyclomatic complexity / class' ) ).toBe(
			'| Avg cyclomatic complexity / class | 6.50 | 6 | -0.50 | 8 ✅ |'
		);
	} );

	it( 'treats movement below two decimal places as no change', () => {
		const body = renderMetricsSection(
			metricsInput(
				{ Complexity: { avgCyclomaticComplexityByClass: 1.234 } },
				{ Complexity: { avgCyclomaticComplexityByClass: 1.23 } }
			)
		);

		expect( body ).toContain( '✅ No metric moved in the wrong direction. All within threshold.' );
		expect( row( body, 'Avg cyclomatic complexity / class' ) ).toBe(
			'| Avg cyclomatic complexity / class | 1.23 | 1.23 | — | 8 ✅ |'
		);
	} );

	it( 'omits a metric absent from both summaries', () => {
		const body = renderMetricsSection( metricsInput() );

		expect( row( body, 'Lack of cohesion of methods' ) ).toBeUndefined();
	} );

	it( 'renders n/a and no delta for a metric only the PR reports', () => {
		const body = renderMetricsSection( metricsInput( { OOP: { classes: 5, lackCohesionOfMethods: 2 } } ) );

		expect( row( body, 'Lack of cohesion of methods' ) ).toBe(
			'| Lack of cohesion of methods | n/a | 2 | — | 3.50 ✅ |'
		);
	} );

	it( 'ignores non-numeric values', () => {
		const body = renderMetricsSection( metricsInput( { OOP: { classes: 5, lackCohesionOfMethods: 'n/a' } } ) );

		expect( row( body, 'Lack of cohesion of methods' ) ).toBeUndefined();
	} );

	it( 'only reports the six metrics with a configured threshold', () => {
		const body = renderMetricsSection(
			metricsInput( { LOC: { linesOfCode: 900 }, Bugs: { avgBugsByClass: 0.5 } } )
		);

		expect( row( body, 'Lines of code' ) ).toBeUndefined();
		expect( row( body, 'Avg bugs / class' ) ).toBeUndefined();
	} );

	it( 'throws a clear error for an unknown key in metrics.max', () => {
		expect( () => renderMetricsSection( metricsInput( {}, {}, { notARealMetric: 5 } ) ) ).toThrow(
			/notARealMetric/
		);
	} );

	describe( 'threshold breaches', () => {
		it( 'flags a metric that breaches its ceiling with ❌', () => {
			const body = renderMetricsSection( metricsInput( { Violations: { critical: 1 } }, { Violations: { critical: 0 } } ) );

			expect( row( body, 'Violations: critical' ) ).toBe( '| Violations: critical | 0 | 1 | ⚠️ +1 | 0 ❌ |' );
		} );

		it( 'reports a breach even with no movement against the base', () => {
			const body = renderMetricsSection( metricsInput( { Violations: { critical: 1 } }, { Violations: { critical: 1 } } ) );

			expect( body ).toContain( '❌ No metric moved in the wrong direction. 1 metric breached threshold.' );
			expect( row( body, 'Violations: critical' ) ).toBe( '| Violations: critical | 1 | 1 | — | 0 ❌ |' );
		} );

		it( 'states both signals together when a metric regresses and breaches at once', () => {
			const body = renderMetricsSection( metricsInput( { Violations: { critical: 1 } }, { Violations: { critical: 0 } } ) );

			expect( body ).toContain( '❌ 1 metric moved in the wrong direction. 1 metric breached threshold.' );
		} );

		it( 'does not flag a metric within its ceiling even without a baseline value', () => {
			const body = renderMetricsSection( metricsInput( { OOP: { classes: 5, lackCohesionOfMethods: 3.5 } } ) );

			expect( row( body, 'Lack of cohesion of methods' ) ).toBe(
				'| Lack of cohesion of methods | n/a | 3.50 | — | 3.50 ✅ |'
			);
		} );
	} );

	describe( 'when the base declares no classes', () => {
		const noBaseline = ( head = { Complexity: { avgCyclomaticComplexityByClass: 6 } } ) =>
			renderMetricsSection( { ...metricsInput( head ), base: { OOP: { classes: 0 } } } );

		it( 'explains why there is no diff', () => {
			expect( noBaseline() ).toContain(
				'ℹ️ Base declares no classes, so there is no class-based baseline to diff against. Showing this branch on its own. All within threshold.'
			);
		} );

		it( 'falls back to a three-column table of the PR alone', () => {
			const body = noBaseline();

			expect( body ).toContain( '| Metric | PR | Max |' );
			expect( body ).not.toContain( '| Metric | Base | PR | Δ | Max |' );
			expect( row( body, 'Avg cyclomatic complexity / class' ) ).toBe(
				'| Avg cyclomatic complexity / class | 6 | 8 ✅ |'
			);
		} );

		it( 'still flags a threshold breach without a baseline to compare against', () => {
			const body = noBaseline( { Violations: { critical: 1 } } );

			expect( body ).toContain( '❌' );
			expect( body ).toContain( '1 metric breached threshold.' );
			expect( row( body, 'Violations: critical' ) ).toBe( '| Violations: critical | 1 | 0 ❌ |' );
		} );
	} );
} );

describe( 'renderCoverageSection', () => {
	describe( 'rejecting a floor it would never apply', () => {
		const head = { php: { lines: metric( 80, 100, 80 ), methods: null, branches: null }, js: {} };

		it( 'throws on a misspelled metric rather than reporting no floor', () => {
			// "line" would render as "no floor configured", which is
			// indistinguishable from deliberately not gating it — so 80%
			// against a 90% floor would show a bare "—" instead of ❌.
			expect( () => renderCoverageSection( {
				head,
				base: { php: {}, js: {} },
				floors: { php: { line: 90 } },
			} ) ).toThrow( /php\.line/ );
		} );

		it( 'throws on an unknown suite', () => {
			expect( () => renderCoverageSection( {
				head,
				base: { php: {}, js: {} },
				floors: { python: { lines: 90 } },
			} ) ).toThrow( /python/ );
		} );

		it( 'accepts the real quality-thresholds.json', () => {
			const { coverage } = require( '../../../examples/quality-thresholds.json' );

			expect( () => renderCoverageSection( { head, base: { php: {}, js: {} }, floors: coverage } ) ).not.toThrow();
		} );
	} );

	const phpHead = { lines: metric( 946, 1000, 94.61 ), methods: metric( 90, 100, 90 ), branches: null };
	const phpBase = { lines: metric( 946, 1000, 94.61 ), methods: metric( 90, 100, 90 ), branches: null };
	const jsHead = {
		statements: metric( 100, 100, 100 ),
		branches: metric( 90, 100, 90 ),
		functions: metric( 100, 100, 100 ),
		lines: metric( 100, 100, 100 ),
	};
	const jsBase = jsHead;

	it( 'renders a six-column diff table against a comparable base', () => {
		const body = renderCoverageSection( { head: { php: phpHead, js: jsHead }, base: { php: phpBase, js: jsBase }, floors: FLOORS } );

		expect( body ).toContain( '| Suite | Metric | Base | PR | Δ | Floor |' );
		expect( row( body, 'JS | Statements' ) ).toBe( '| JS | Statements | 100% | 100% | — | 95% ✅ |' );
	} );

	it( 'omits a metric neither side measured', () => {
		// PHP branch coverage is never populated by Xdebug, so a row for it
		// could only ever read "n/a" — it is left out rather than shown.
		const body = renderCoverageSection( { head: { php: phpHead, js: jsHead }, base: { php: phpBase, js: jsBase }, floors: FLOORS } );

		expect( row( body, 'PHP | Branches' ) ).toBeUndefined();
		expect( body ).not.toContain( 'n/a' );
	} );

	it( 'keeps a metric only one side measured, as n/a on the other, and does not mark it breached', () => {
		const body = renderCoverageSection( {
			head: { php: { ...phpHead, branches: metric( 8, 10, 80 ) }, js: jsHead },
			base: { php: phpBase, js: jsBase },
			floors: FLOORS,
		} );

		expect( row( body, 'PHP | Branches' ) ).toBe( '| PHP | Branches | n/a | 80% | — | — |' );
	} );

	it( 'omits the whole section when nothing at all was measured', () => {
		const empty = { lines: null, methods: null, branches: null };
		const body = renderCoverageSection( {
			head: { php: empty, js: {} },
			base: { php: empty, js: {} },
			floors: FLOORS,
		} );

		expect( body ).toBe( '' );
	} );

	it( 'flags a suite metric that falls below its floor with ❌', () => {
		const head = { ...jsHead, statements: metric( 80, 100, 80 ) };
		const body = renderCoverageSection( { head: { php: phpHead, js: head }, base: { php: phpBase, js: jsBase }, floors: FLOORS } );

		expect( row( body, 'JS | Statements' ) ).toBe( '| JS | Statements | 100% | 80% | -20% | 95% ❌ |' );
	} );

	it( 'renders a fractional delta to two decimal places', () => {
		const head = { ...phpHead, lines: metric( 945, 1000, 94.54 ) };
		const body = renderCoverageSection( { head: { php: head, js: jsHead }, base: { php: phpBase, js: jsBase }, floors: FLOORS } );

		expect( row( body, 'PHP | Lines' ) ).toBe( '| PHP | Lines | 94.61% | 94.54% | -0.07% | 90% ✅ |' );
	} );

	describe( 'when the base has no coverage data', () => {
		const noBaselineFloors = FLOORS;
		const empty = { php: { lines: null, methods: null, branches: null }, js: { statements: null, branches: null, functions: null, lines: null } };

		it( 'explains why there is no diff', () => {
			const body = renderCoverageSection( { head: { php: phpHead, js: jsHead }, base: empty, floors: noBaselineFloors } );

			expect( body ).toContain( "ℹ️ No coverage data for the base branch. Showing the PR's numbers alone." );
		} );

		it( 'falls back to a four-column table of the PR alone', () => {
			const body = renderCoverageSection( { head: { php: phpHead, js: jsHead }, base: empty, floors: noBaselineFloors } );

			expect( body ).toContain( '| Suite | Metric | PR | Floor |' );
			expect( body ).not.toContain( '| Suite | Metric | Base | PR | Δ | Floor |' );
			expect( row( body, 'JS | Statements' ) ).toBe( '| JS | Statements | 100% | 95% ✅ |' );
		} );

		it( 'treats a missing base object the same as one with no measured metrics', () => {
			const body = renderCoverageSection( { head: { php: phpHead, js: jsHead }, base: null, floors: noBaselineFloors } );

			expect( body ).toContain( "ℹ️ No coverage data for the base branch." );
		} );
	} );
} );

describe( 'metrics rounding', () => {
describe( 'the delta and the cells beside it', () => {
	/**
	 * Reads the Base, PR and Δ cells of a metrics row.
	 *
	 * @param {number} before Base value.
	 * @param {number} after  PR value.
	 * @return {string[]} The three cells, trimmed.
	 */
	const cells = ( before, after ) => {
		const body = renderMetricsSection( metricsInput(
			{ Complexity: { avgCyclomaticComplexityByClass: after } },
			{ Complexity: { avgCyclomaticComplexityByClass: before } }
		) );
		return row( body, 'Avg cyclomatic complexity / class' )
			.split( '|' ).slice( 2, 5 ).map( ( cell ) => cell.trim() );
	};

	it( 'reports a change the cells show', () => {
		// 6.004 and 6.006 display as 6.00 and 6.01; their raw difference
		// rounds to zero, which would print "—" beside two visibly
		// different numbers.
		expect( cells( 6.004, 6.006 ) ).toEqual( [ '6.00', '6.01', '⚠️ +0.01' ] );
	} );

	it( 'reports no change when the cells are identical', () => {
		// Both display as 0.01, so a delta of +0.01 would contradict them.
		expect( cells( 0.005, 0.015 ) ).toEqual( [ '0.01', '0.01', '—' ] );
	} );
} );

} );

describe( 'buildMetricsSection', () => {
	it( 'passes when nothing regressed or breached', () => {
		const section = buildMetricsSection( metricsInput() );

		expect( section ).toMatchObject( { id: 'php-metrics', title: 'PHP code metrics', status: 'pass', baseline: true, failures: [] } );
		expect( section.markdown ).toContain( '| Metric | Base | PR | Δ | Max |' );
	} );

	it( 'warns on a regression that stays within the ceiling', () => {
		const section = buildMetricsSection(
			metricsInput( { Complexity: { avgCyclomaticComplexityByClass: 7 } }, { Complexity: { avgCyclomaticComplexityByClass: 6 } } )
		);

		expect( section.status ).toBe( 'warn' );
	} );

	it( 'warns, not fails, on a breach of an ungated metric', () => {
		const section = buildMetricsSection( { ...metricsInput( { Coupling: { avgEfferentCoupling: 9 } } ), gate: [ 'critical' ] } );

		expect( section.status ).toBe( 'warn' );
		expect( section.failures ).toEqual( [] );
	} );

	it( 'fails on a breach of a gated metric and says which', () => {
		const section = buildMetricsSection( { ...metricsInput( { Violations: { critical: 2 } } ), gate: [ 'critical', 'error' ] } );

		expect( section.status ).toBe( 'fail' );
		expect( section.failures ).toEqual( [ 'Violations: critical is 2 (max 0)' ] );
	} );

	it( 'throws for a gate key with no ceiling', () => {
		expect( () => buildMetricsSection( { ...metricsInput(), gate: [ 'nope' ] } ) ).toThrow( /metrics\.gate/ );
	} );

	it( 'reports no baseline when the base is missing', () => {
		const section = buildMetricsSection( { head: { OOP: { classes: 3 } }, base: null, max: MAX } );

		expect( section.baseline ).toBe( false );
		expect( section.markdown ).toContain( '| Metric | PR | Max |' );
	} );

	it( 'is empty when no thresholded metric has a value on either side', () => {
		const section = buildMetricsSection( { head: { OOP: { classes: 3 } }, base: null, max: { avgEfferentCoupling: 4 } } );

		expect( section ).toMatchObject( { status: 'pass', empty: true } );
	} );

		it( 'fails when PHPMetrics produced no summary', () => {
		const section = buildMetricsSection( { head: null, base: null, max: MAX } );

		expect( section.status ).toBe( 'fail' );
		expect( section.failures[ 0 ] ).toMatch( /no summary/ );
	} );
} );

describe( 'buildCoverageSection', () => {
	const php = ( lines ) => ( { php: { lines: metric( lines, 100, lines ), methods: metric( 9, 10, 90 ), branches: null } } );
	const floors = { php: { lines: 90, methods: 90 } };
	const build = ( head, base ) => buildCoverageSection( { id: 'php-coverage', title: 'PHP coverage', head, base, floors } );

	it( 'passes above the floors', () => {
		expect( build( php( 95 ), php( 95 ) ) ).toMatchObject( { status: 'pass', baseline: true, failures: [] } );
	} );

	it( 'warns when a metric drops but stays above its floor', () => {
		expect( build( php( 94 ), php( 95 ) ).status ).toBe( 'warn' );
	} );

	it( 'fails below a floor and lists the breach', () => {
		const section = build( php( 80 ), php( 95 ) );

		expect( section.status ).toBe( 'fail' );
		expect( section.failures ).toEqual( [ 'PHP lines coverage is 80% (floor 90%)' ] );
	} );

	it( 'does not warn about a drop when there is no base to compare', () => {
		const section = build( php( 91 ), null );

		expect( section ).toMatchObject( { status: 'pass', baseline: false } );
		expect( section.markdown ).toContain( 'No coverage data for the base branch' );
	} );

	it( 'fails when no head report was produced', () => {
		const section = build( null, php( 95 ) );

		expect( section.status ).toBe( 'fail' );
		expect( section.markdown ).toMatch( /No coverage report/ );
	} );

	it( 'fails, and is empty, when floors are set but nothing was measured', () => {
		// The n/a table that used to pass every floor by default.
		const section = build( { php: { lines: null, methods: null, branches: null } }, php( 95 ) );

		expect( section ).toMatchObject( { status: 'fail', empty: true } );
		expect( section.failures[ 0 ] ).toMatch( /no measured metrics/ );
	} );

	it( 'passes, but is empty, when nothing was measured and nothing is floored', () => {
		const section = buildCoverageSection( { id: 'x', title: 'X', head: { js: { statements: null } }, base: null, floors: { js: {} } } );

		expect( section ).toMatchObject( { status: 'pass', empty: true, failures: [] } );
	} );

	it( 'is empty when no report was produced', () => {
		expect( build( null, null ).empty ).toBe( true );
	} );

	it( 'is not empty when something was measured', () => {
		expect( build( php( 95 ), null ).empty ).toBeUndefined();
	} );
} );
