'use strict';

const { neutralise, inline, block, parseSection, renderReport, parseMeta, sortSections, overallStatus, worthPosting, LIMITS } = require( './sections' );

const HEAD_SHA = 'a'.repeat( 7 ) + '1'.repeat( 33 );
const BASE_SHA = 'b'.repeat( 7 ) + '2'.repeat( 33 );
const RUN_URL = 'https://github.com/o/r/actions/runs/1';

const section = ( overrides = {} ) => ( { id: 'php-coverage', title: 'PHP coverage', status: 'pass', markdown: 'body', ...overrides } );
const parse = ( overrides ) => parseSection( JSON.stringify( section( overrides ) ) );

describe( 'neutralise', () => {
	it( 'escapes raw HTML so a fragment cannot inject markup', () => {
		expect( neutralise( '<img src=x onerror=alert(1)>' ) ).toBe( '&lt;img src=x onerror=alert(1)&gt;' );
		expect( neutralise( '<details open>' ) ).not.toContain( '<' );
	} );

	it( 'breaks @-mentions so the bot cannot be made to ping people', () => {
		const out = neutralise( 'cc @octocat and @org/team' );

		expect( out ).not.toMatch( /@[A-Za-z]/ );
		expect( out ).toContain( '@‍octocat' );
	} );

	it( 'leaves an @ that is not a mention alone', () => {
		expect( neutralise( 'a @ b' ) ).toBe( 'a @ b' );
	} );

	it( 'disables image syntax so the comment never fetches remote content', () => {
		expect( neutralise( '![x](https://evil.example/pixel.gif)' ) ).toBe( '!\\[x](https://evil.example/pixel.gif)' );
	} );

	it( 'escapes entities so &#64; cannot smuggle a mention back in', () => {
		expect( neutralise( '&#64;octocat' ) ).toBe( '&amp;#64;octocat' );
	} );

	it( 'strips control and bidi-override characters', () => {
		expect( neutralise( 'a\u0000b‮c\u0007d' ) ).toBe( 'abcd' );
	} );
} );

describe( 'inline', () => {
	it( 'collapses newlines and escapes pipes so a cell cannot break the table', () => {
		expect( inline( 'a\n| b |\r\nc', 100 ) ).toBe( 'a \\| b \\| c' );
	} );

	it( 'caps the length', () => {
		expect( inline( 'x'.repeat( 50 ), 10 ) ).toBe( `${ 'x'.repeat( 9 ) }…` );
	} );
} );

describe( 'block', () => {
	it( 'keeps markdown tables and emoji intact', () => {
		const table = '✅ fine\n\n| A | B |\n| --- | ---: |\n| x | 1 |';

		expect( block( table ) ).toBe( table );
	} );

	it( 'keeps block quotes working', () => {
		expect( block( '> quoted\n> > nested' ) ).toBe( '> quoted\n> > nested' );
	} );

	it( 'demotes headings that would compete with the comment structure', () => {
		expect( block( '# Big\n## Bigger\n### Three\n#### Four' ) ).toBe( '#### Big\n#### Bigger\n#### Three\n#### Four' );
	} );

	it( 'truncates an oversized body with a note', () => {
		const out = block( 'x'.repeat( LIMITS.markdown + 100 ) );

		expect( out.length ).toBeLessThan( LIMITS.markdown + 100 );
		expect( out ).toMatch( /section truncated/ );
	} );
} );

describe( 'parseSection', () => {
	it( 'accepts a markdown section', () => {
		expect( parse() ).toEqual( { id: 'php-coverage', title: 'PHP coverage', status: 'pass', baseline: false, markdown: 'body' } );
	} );

	it( 'accepts a rows section', () => {
		const out = parse( { markdown: undefined, rows: { columns: [ 'A', 'B' ], rows: [ [ 'x', 1 ], [ null, true ] ] } } );

		expect( out.rows.rows ).toHaveLength( 2 );
	} );

	it.each( [
		[ 'not JSON', '{', /not valid JSON/ ],
		[ 'an array', '[]', /JSON object/ ],
		[ 'a bad id', JSON.stringify( section( { id: '../etc' } ) ), /"id"/ ],
		[ 'an uppercase id', JSON.stringify( section( { id: 'PHP' } ) ), /"id"/ ],
		[ 'an empty title', JSON.stringify( section( { title: ' ' } ) ), /"title"/ ],
		[ 'an unknown status', JSON.stringify( section( { status: 'great' } ) ), /"status"/ ],
		[ 'both bodies', JSON.stringify( section( { rows: { columns: [ 'a' ], rows: [] } } ) ), /exactly one/ ],
		[ 'neither body', JSON.stringify( section( { markdown: undefined } ) ), /exactly one/ ],
		[ 'a ragged row', JSON.stringify( section( { markdown: undefined, rows: { columns: [ 'a', 'b' ], rows: [ [ 'x' ] ] } } ) ), /every row/ ],
		[ 'an object cell', JSON.stringify( section( { markdown: undefined, rows: { columns: [ 'a' ], rows: [ [ {} ] ] } } ) ), /every row/ ],
		[ 'too many columns', JSON.stringify( section( { markdown: undefined, rows: { columns: Array( 11 ).fill( 'c' ), rows: [] } } ) ), /columns/ ],
		[ 'non-string failures', JSON.stringify( section( { failures: [ 1 ] } ) ), /failures/ ],
	] )( 'rejects %s', ( _, raw, message ) => {
		expect( () => parseSection( raw ) ).toThrow( message );
	} );

	it( 'rejects an oversized file before parsing it', () => {
		const raw = JSON.stringify( section( { markdown: 'x'.repeat( LIMITS.fileBytes ) } ) );

		expect( () => parseSection( raw ) ).toThrow( /larger than/ );
	} );

	it( 'rejects too many rows', () => {
		const rows = Array.from( { length: LIMITS.rows + 1 }, () => [ 'x' ] );

		expect( () => parse( { markdown: undefined, rows: { columns: [ 'a' ], rows } } ) ).toThrow( /more than/ );
	} );

	it( 'keeps a literal true empty flag only', () => {
		expect( parse( { empty: true } ).empty ).toBe( true );
		expect( parse( { empty: 'yes' } ).empty ).toBeUndefined();
	} );

		it( 'only treats a literal true as a baseline', () => {
		expect( parse( { baseline: 'yes' } ).baseline ).toBe( false );
		expect( parse( { baseline: true } ).baseline ).toBe( true );
	} );
} );

describe( 'sortSections and overallStatus', () => {
	it( 'puts known sections in their fixed order and others after, alphabetically', () => {
		const ids = sortSections( [ { id: 'zeta' }, { id: 'js-complexity' }, { id: 'alpha' }, { id: 'php-coverage' }, { id: 'php-quality' } ] ).map( ( s ) => s.id );

		expect( ids ).toEqual( [ 'php-quality', 'php-coverage', 'js-complexity', 'alpha', 'zeta' ] );
	} );

	it( 'reports the worst status', () => {
		expect( overallStatus( [ { status: 'pass' }, { status: 'warn' } ] ) ).toBe( 'warn' );
		expect( overallStatus( [ { status: 'fail' }, { status: 'warn' } ] ) ).toBe( 'fail' );
		expect( overallStatus( [] ) ).toBeNull();
	} );
} );

describe( 'renderReport', () => {
	const sections = [
		parse( { id: 'php-metrics', title: 'PHP code metrics', status: 'warn', markdown: 'metrics body', baseline: true } ),
		parse( { id: 'php-coverage', title: 'PHP coverage', markdown: 'coverage body', baseline: true } ),
	];
	const render = ( overrides = {} ) => renderReport( { sections, headSha: HEAD_SHA, baseSha: BASE_SHA, runUrl: RUN_URL, runName: 'Integrate', conclusion: 'success', ...overrides } );

	it( 'assembles the heading, SHA line, headline, sections in order, and the footer', () => {
		const body = render();

		expect( body ).toContain( '## 📊 PR Report' );
		expect( body ).toContain( '`bbbbbbb` (base) → `aaaaaaa` (PR)' );
		expect( body ).toContain( '⚠️ Nothing failed' );
		expect( body.indexOf( '### ✅ PHP coverage' ) ).toBeLessThan( body.indexOf( '### ⚠️ PHP code metrics' ) );
		expect( body ).toContain( `[the Integrate run](${ RUN_URL })` );
	} );

	it( 'truncates both SHAs to seven characters', () => {
		const body = render();

		expect( body ).not.toContain( HEAD_SHA );
		expect( body ).not.toContain( BASE_SHA );
	} );

	it( 'drops the base arrow when no section found a baseline', () => {
		const body = render( { sections: [ parse( { baseline: false } ) ] } );

		expect( body ).toContain( '`aaaaaaa` (PR)' );
		expect( body ).not.toContain( '(base) →' );
	} );

	it( 'keeps the base arrow when only one section lacks a baseline', () => {
		const body = render( { sections: [ ...sections, parse( { id: 'js-complexity', baseline: false } ) ] } );

		expect( body ).toContain( '(base) →' );
	} );

	it( 'drops the base arrow when the base SHA is unknown', () => {
		expect( render( { baseSha: '' } ) ).not.toContain( '(base) →' );
	} );

	it( 'says when there are no sections at all', () => {
		expect( render( { sections: [] } ) ).toContain( 'uploaded no report sections' );
	} );

	it( 'warns when the run did not succeed', () => {
		expect( render( { conclusion: 'failure' } ) ).toContain( 'concluded `failure`' );
		expect( render() ).not.toContain( 'concluded' );
	} );

	it( 'lists rejected fragments, escaped', () => {
		const body = render( { rejected: [ 'report-section-x: bad <b>id</b> @octocat' ] } );

		expect( body ).toContain( '1 report fragment was rejected' );
		expect( body ).not.toContain( '<b>' );
		expect( body ).not.toMatch( /@octocat/ );
	} );

	it( 'escapes a hostile title and body', () => {
		const body = render( { sections: [ parse( { title: 'x <script>\n### fake', markdown: '<img src=x> @everyone\n# Owned' } ) ] } );

		expect( body ).not.toContain( '<script>' );
		expect( body ).not.toContain( '<img' );
		expect( body ).not.toMatch( /@everyone/ );
		expect( body ).toContain( '#### Owned' );
		expect( body ).toContain( '### ✅ x &lt;script&gt; ### fake' );
	} );

	it( 'renders a rows section as a table with alignment', () => {
		const rows = parse( { markdown: undefined, summary: 'A note.', rows: { columns: [ 'Metric', 'PR' ], align: [ 'left', 'right' ], rows: [ [ 'Lines', '90%' ], [ 'a|b', null ] ] } } );
		const body = render( { sections: [ rows ] } );

		expect( body ).toContain( 'A note.\n\n| Metric | PR |\n| --- | ---: |\n| Lines | 90% |\n| a\\|b | — |' );
	} );

	it( 'renders an empty rows table with a note', () => {
		const body = render( { sections: [ parse( { markdown: undefined, rows: { columns: [ 'A' ], rows: [] } } ) ] } );

		expect( body ).toContain( '_No rows._' );
	} );

	it( 'leaves out an empty passing section entirely', () => {
		const body = render( { sections: [ ...sections, parse( { id: 'js-coverage', title: 'JS coverage', status: 'pass', empty: true } ) ] } );

		expect( body ).not.toContain( 'JS coverage' );
		expect( body ).toContain( '⚠️ Nothing failed' );
	} );

	it( 'counts an empty failing section in the headline and names it, without its table', () => {
		const body = render( { sections: [ ...sections, parse( { id: 'js-coverage', title: 'JS coverage', status: 'fail', empty: true, markdown: 'SHOULD NOT RENDER' } ) ] } );

		expect( body ).toContain( '❌ At least one section failed.' );
		expect( body ).toContain( '❌ No data to show, and failed: JS coverage.' );
		expect( body ).not.toContain( '### ❌ JS coverage' );
		expect( body ).not.toContain( 'SHOULD NOT RENDER' );
	} );

	it( 'sorts a prefixed id with its base id', () => {
		const ids = sortSections( [ { id: 'fixture-php-metrics' }, { id: 'zeta' }, { id: 'fixture-php-coverage' }, { id: 'js-coverage' } ] ).map( ( s ) => s.id );

		expect( ids ).toEqual( [ 'fixture-php-coverage', 'js-coverage', 'fixture-php-metrics', 'zeta' ] );
	} );

		it( 'never renders failures, which are for the enforcement step only', () => {
		expect( render( { sections: [ parse( { failures: [ 'SECRET-ish detail' ] } ) ] } ) ).not.toContain( 'SECRET-ish' );
	} );

	it( 'stays under the comment size limit by omitting sections', () => {
		const big = Array.from( { length: 8 }, ( _, i ) => parse( { id: `s${ i }`, markdown: 'y'.repeat( LIMITS.markdown ) } ) );
		const body = render( { sections: big } );

		expect( body.length ).toBeLessThanOrEqual( LIMITS.comment );
		expect( body ).toMatch( /sections? omitted/ );
	} );
} );

describe( 'parseMeta', () => {
	it( 'returns the PR number', () => {
		expect( parseMeta( [ '{"pr_number":12,"head_sha":"x"}' ] ) ).toBe( 12 );
	} );

	it( 'accepts several fragments that agree', () => {
		expect( parseMeta( [ '{"pr_number":12}', '{"pr_number":12}' ] ) ).toBe( 12 );
	} );

	it.each( [
		[ 'no fragment', [], /no report-meta/ ],
		[ 'a string number', [ '{"pr_number":"12"}' ], /positive integer/ ],
		[ 'zero', [ '{"pr_number":0}' ], /positive integer/ ],
		[ 'a fraction', [ '{"pr_number":1.5}' ], /positive integer/ ],
		[ 'disagreeing fragments', [ '{"pr_number":1}', '{"pr_number":2}' ], /disagree/ ],
		[ 'an oversized fragment', [ JSON.stringify( { pr_number: 1, pad: 'x'.repeat( 5000 ) } ) ], /larger than/ ],
	] )( 'rejects %s', ( _, raws, message ) => {
		expect( () => parseMeta( raws ) ).toThrow( message );
	} );
} );

describe( 'worthPosting', () => {
	it( 'posts when some section has data', () => {
		expect( worthPosting( [ { empty: true, status: 'pass' }, { status: 'pass' } ] ) ).toBe( true );
	} );

	it( 'posts when an empty section failed, so the failure is not hidden', () => {
		expect( worthPosting( [ { empty: true, status: 'fail' } ] ) ).toBe( true );
	} );

	it( 'does not post when every section is empty and none failed', () => {
		expect( worthPosting( [ { empty: true, status: 'pass' }, { empty: true, status: 'warn' } ] ) ).toBe( false );
		expect( worthPosting( [] ) ).toBe( false );
	} );
} );
