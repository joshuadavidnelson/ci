'use strict';

const { parseEslint, summarise, complexityConfig, buildComplexitySection, DEFAULT_MAX } = require( './complexity' );

const cyclo = ( score, line = 1, name = "Function 'f'" ) => ( {
	ruleId: 'complexity',
	line,
	message: `${ name } has a complexity of ${ score }. Maximum allowed is 0.`,
} );
const cog = ( score, line = 1 ) => ( {
	ruleId: 'sonarjs/cognitive-complexity',
	line,
	message: `Refactor this function to reduce its Cognitive Complexity from ${ score } to the 0 allowed.`,
} );
const result = ( filePath, messages ) => ( { filePath, messages } );

describe( 'parseEslint', () => {
	it( 'reads cyclomatic and cognitive scores out of the messages', () => {
		const { functions, parseErrors } = parseEslint( [ result( '/repo/src/a.js', [ cyclo( 3, 2, "Arrow function" ), cog( 5, 2 ) ] ) ], '/repo' );

		expect( parseErrors ).toBe( 0 );
		expect( functions ).toEqual( [
			{ metric: 'cyclomatic', score: 3, file: 'src/a.js', line: 2, name: 'Arrow function' },
			{ metric: 'cognitive', score: 5, file: 'src/a.js', line: 2, name: 'function' },
		] );
	} );

	it( 'counts fatal parse errors separately and ignores other rules', () => {
		const { functions, parseErrors } = parseEslint( [
			result( 'a.js', [ { fatal: true, ruleId: null, message: 'Parsing error' }, { ruleId: 'no-undef', message: 'x' } ] ),
		] );

		expect( functions ).toEqual( [] );
		expect( parseErrors ).toBe( 1 );
	} );

	it( 'rejects output that is not an array', () => {
		expect( () => parseEslint( {} ) ).toThrow( /JSON array/ );
	} );
} );

describe( 'summarise', () => {
	it( 'computes counts, maxima and averages', () => {
		const { functions } = parseEslint( [ result( 'a.js', [ cyclo( 1 ), cyclo( 4 ), cyclo( 12 ), cog( 20 ), cog( 3 ) ] ) ] );

		expect( summarise( functions, DEFAULT_MAX ) ).toEqual( {
			functions: 3,
			maxCyclomatic: 12,
			avgCyclomatic: 5.67,
			overCyclomatic: 1,
			maxCognitive: 20,
			overCognitive: 1,
		} );
	} );

	it( 'reports a cognitive max of 0 when functions exist but none scored', () => {
		const { functions } = parseEslint( [ result( 'a.js', [ cyclo( 1 ) ] ) ] );

		expect( summarise( functions, DEFAULT_MAX ).maxCognitive ).toBe( 0 );
	} );

	it( 'reports nulls when there are no functions', () => {
		expect( summarise( [], DEFAULT_MAX ) ).toMatchObject( { functions: 0, maxCyclomatic: null, avgCyclomatic: null, maxCognitive: null } );
	} );
} );

describe( 'complexityConfig', () => {
	it( 'defaults when the block is absent', () => {
		expect( complexityConfig( {} ) ).toEqual( { max: DEFAULT_MAX, gate: [] } );
	} );

	it( 'merges configured ceilings over the defaults', () => {
		expect( complexityConfig( { js: { complexity: { max: { cognitive: 8 }, gate: [ 'cognitive' ] } } } ) ).toEqual( {
			max: { cyclomatic: 10, cognitive: 8 },
			gate: [ 'cognitive' ],
		} );
	} );

	it( 'treats flat ceilings as gated, the shape a repo eslint.config.js reads', () => {
		expect( complexityConfig( { js: { complexity: { _comment: 'x', cyclomatic: 12, cognitive: 20 } } } ) ).toEqual( {
			max: { cyclomatic: 12, cognitive: 20 },
			gate: [ 'cyclomatic', 'cognitive' ],
		} );
	} );

	it( 'gates only the flat keys given, defaulting the other', () => {
		expect( complexityConfig( { js: { complexity: { cognitive: 20 } } } ) ).toEqual( {
			max: { cyclomatic: 10, cognitive: 20 },
			gate: [ 'cognitive' ],
		} );
	} );

	it( 'rejects a non-numeric ceiling', () => {
		expect( () => complexityConfig( { js: { complexity: { cyclomatic: 'ten' } } } ) ).toThrow( /must be a number/ );
	} );

	it( 'rejects an unknown flat key', () => {
		expect( () => complexityConfig( { js: { complexity: { halstead: 3 } } } ) ).toThrow( /halstead/ );
	} );

	it( 'rejects an unknown metric key', () => {
		expect( () => complexityConfig( { js: { complexity: { gate: [ 'halstead' ] } } } ) ).toThrow( /halstead/ );
	} );
} );

describe( 'buildComplexitySection', () => {
	const head = [ result( '/r/src/a.js', [ cyclo( 2 ), cyclo( 4, 9 ), cog( 3 ) ] ) ];
	const thresholds = { js: { complexity: { max: { cyclomatic: 5, cognitive: 5 }, gate: [ 'cyclomatic' ] } } };

	it( 'passes within the ceilings and shows the PR alone without a base', () => {
		const section = buildComplexitySection( { head, base: null, thresholds, root: '/r' } );

		expect( section ).toMatchObject( { id: 'js-complexity', status: 'pass', baseline: false } );
		expect( section.rows.columns ).toEqual( [ 'Metric', 'PR', 'Max' ] );
		expect( section.rows.rows ).toContainEqual( [ 'Max cyclomatic complexity', '4', '5 ✅' ] );
		expect( section.summary ).toMatch( /No base-branch measurement/ );
	} );

	it( 'compares against the base and warns on a regression', () => {
		const base = [ result( '/b/src/a.js', [ cyclo( 2 ), cyclo( 3 ), cog( 3 ) ] ) ];
		const section = buildComplexitySection( { head, base, thresholds, root: '/r', baseRoot: '/b' } );

		expect( section.status ).toBe( 'warn' );
		expect( section.baseline ).toBe( true );
		expect( section.rows.rows ).toContainEqual( [ 'Max cyclomatic complexity', '3', '4', '⚠️ +1', '5 ✅' ] );
	} );

	it( 'does not flag "functions analysed" growing as a regression', () => {
		const base = [ result( '/b/a.js', [ cyclo( 2 ), cyclo( 4 ), cog( 3 ) ] ) ];
		const more = [ result( '/r/a.js', [ cyclo( 2 ), cyclo( 4 ), cyclo( 3 ), cog( 3 ) ] ) ];
		const section = buildComplexitySection( { head: more, base, thresholds } );

		expect( section.rows.rows[ 0 ] ).toEqual( [ 'Functions analysed', '2', '3', '+1', '—' ] );
		expect( section.status ).toBe( 'pass' );
	} );

	it( 'fails when a gated maximum is exceeded and names the offender', () => {
		const section = buildComplexitySection( { head: [ result( '/r/src/b.js', [ cyclo( 9, 14 ) ] ) ], thresholds, root: '/r' } );

		expect( section.status ).toBe( 'fail' );
		expect( section.failures ).toEqual( [ 'Max cyclomatic complexity is 9 (max 5)' ] );
		expect( section.summary ).toContain( 'src/b.js:14 (cyclomatic 9)' );
	} );

	it( 'warns, not fails, when an ungated maximum is exceeded', () => {
		const section = buildComplexitySection( { head: [ result( 'a.js', [ cyclo( 1 ), cog( 9 ) ] ) ], thresholds } );

		expect( section.status ).toBe( 'warn' );
		expect( section.failures ).toEqual( [] );
	} );

	it( 'warns about files that could not be parsed', () => {
		const section = buildComplexitySection( { head: [ result( 'a.js', [ { fatal: true, message: 'x' } ] ) ], thresholds } );

		expect( section.status ).toBe( 'warn' );
		expect( section.summary ).toMatch( /1 file could not be parsed/ );
	} );

	it( 'says which ESLint config measured the PR', () => {
		expect( buildComplexitySection( { head, thresholds, mode: 'repo' } ).summary ).toMatch( /^Measured with the repo's own ESLint config\./ );
		expect( buildComplexitySection( { head, thresholds, mode: 'builtin' } ).summary ).toMatch( /^Measured with the built-in complexity config\./ );
		expect( buildComplexitySection( { head, thresholds } ).summary ).not.toMatch( /Measured with/ );
	} );

	it( 'fails when ESLint produced nothing', () => {
		expect( buildComplexitySection( { head: null, thresholds } ).status ).toBe( 'fail' );
	} );
} );
