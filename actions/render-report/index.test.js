'use strict';

const { execFileSync } = require( 'child_process' );
const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );

const { main, options } = require( './index' );

const SCRIPT = path.resolve( __dirname, 'index.js' );
const HEAD_SHA = 'a'.repeat( 40 );
const BASE_SHA = 'b'.repeat( 40 );
const RUN_URL = 'https://github.com/o/r/actions/runs/1';

const THRESHOLDS = {
	coverage: { php: { lines: 90, methods: 90 }, js: { statements: 95, branches: 90, functions: 95, lines: 95 } },
	metrics: { max: { critical: 0, avgCyclomaticComplexityByClass: 8 }, gate: [ 'critical' ] },
	js: { complexity: { max: { cyclomatic: 5, cognitive: 5 }, gate: [ 'cyclomatic' ] } },
};

const clover = ( statements, covered ) =>
	`<?xml version="1.0" encoding="UTF-8"?><coverage><project timestamp="1">` +
	`<file name="a.php"><metrics statements="1" coveredstatements="1"/></file>` +
	`<metrics files="1" methods="10" coveredmethods="9" conditionals="0" coveredconditionals="0" ` +
	`statements="${ statements }" coveredstatements="${ covered }"/></project></coverage>`;

const jestSummary = ( covered ) => JSON.stringify( {
	total: {
		statements: { total: 100, covered, skipped: 0, pct: covered },
		branches: { total: 100, covered, skipped: 0, pct: covered },
		functions: { total: 100, covered, skipped: 0, pct: covered },
		lines: { total: 100, covered, skipped: 0, pct: covered },
	},
} );

let dir;
const at = ( ...parts ) => path.join( dir, ...parts );
const write = ( file, contents ) => {
	fs.mkdirSync( path.dirname( at( file ) ), { recursive: true } );
	fs.writeFileSync( at( file ), contents );
};
const readJson = ( file ) => JSON.parse( fs.readFileSync( at( file ), 'utf8' ) );
const quiet = () => ( { info: jest.fn(), warn: jest.fn(), error: jest.fn() } );

/**
 * Runs index.js as a child process, the way the workflows do.
 *
 * @param {string[]} args Command and flags.
 * @param {Object}   env  Extra environment.
 * @return {string} stdout.
 */
const cli = ( args, env = {} ) =>
	execFileSync( process.execPath, [ SCRIPT, ...args ], { cwd: dir, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GITHUB_OUTPUT: '', ...env } } );

beforeEach( () => {
	dir = fs.mkdtempSync( path.join( os.tmpdir(), 'render-report-' ) );
	write( 'quality-thresholds.json', JSON.stringify( THRESHOLDS ) );
} );

afterEach( () => {
	fs.rmSync( dir, { recursive: true, force: true } );
} );

describe( 'options', () => {
	it( 'reads --key value and --key=value flags', () => {
		const get = options( [ '--head', 'a.xml', '--base=b.xml' ], {} );

		expect( get( 'head' ) ).toBe( 'a.xml' );
		expect( get( 'base' ) ).toBe( 'b.xml' );
	} );

	it( 'falls back to INPUT_* env vars, as the action runtime sets them, then the default', () => {
		const get = options( [], { 'INPUT_BASE-ROOT': '/b', INPUT_HEAD: '' } );

		expect( get( 'base-root' ) ).toBe( '/b' );
		expect( get( 'head', 'default.xml' ) ).toBe( 'default.xml' );
	} );

	it( 'rejects a stray positional argument', () => {
		expect( () => options( [ 'oops' ], {} ) ).toThrow( /unexpected argument/ );
	} );
} );

describe( 'main', () => {
	it( 'rejects an unknown command', () => {
		const log = quiet();

		expect( main( { argv: [ 'nope' ], env: {}, log } ) ).toBe( false );
		expect( log.error ).toHaveBeenCalledWith( expect.stringContaining( 'Unknown command' ) );
	} );

	it( 'takes the command from INPUT_COMMAND when running as an action', () => {
		write( 'h.xml', clover( 100, 95 ) );
		const env = {
			INPUT_COMMAND: 'php-coverage',
			INPUT_HEAD: at( 'h.xml' ),
			INPUT_THRESHOLDS: at( 'quality-thresholds.json' ),
			INPUT_OUTPUT: at( 'out.json' ),
			GITHUB_OUTPUT: at( 'gh-output' ),
		};

		expect( main( { argv: [], env, log: quiet() } ) ).toBe( true );
		expect( readJson( 'out.json' ).status ).toBe( 'pass' );
		expect( fs.readFileSync( at( 'gh-output' ), 'utf8' ) ).toContain( 'status=pass\n' );
	} );

	it( 'reports a thrown error as a failed command, not a crash', () => {
		write( 'bad.json', '{' );
		const log = quiet();

		expect( main( { argv: [ 'php-metrics', '--thresholds', at( 'bad.json' ) ], env: {}, log } ) ).toBe( false );
		expect( log.error ).toHaveBeenCalledWith( expect.stringContaining( '::error::php-metrics:' ) );
	} );
} );

describe( 'section commands', () => {
	it( 'php-coverage compares head and base clover reports', () => {
		write( 'head.xml', clover( 1000, 940 ) );
		write( 'base.xml', clover( 1000, 950 ) );

		cli( [ 'php-coverage', '--head', 'head.xml', '--base', 'base.xml', '--output', 'out/php.json' ] );

		const section = readJson( 'out/php.json' );
		expect( section ).toMatchObject( { id: 'php-coverage', status: 'warn', baseline: true } );
		expect( section.markdown ).toContain( '| PHP | Lines | 95% | 94% | -1% | 90% ✅ |' );
		// Xdebug leaves conditionals at 0/0, so PHP branches get no row.
		expect( section.markdown ).not.toContain( 'Branches' );
	} );

	it( 'php-coverage degrades to the PR column when the base is absent or unreadable', () => {
		write( 'head.xml', clover( 1000, 940 ) );
		write( 'base.xml', 'not xml' );

		const stderr = execFileSync( process.execPath, [ SCRIPT, 'php-coverage', '--head', 'head.xml', '--base', 'base.xml', '--output', 'o.json' ], { cwd: dir, encoding: 'utf8', stdio: [ 'pipe', 'pipe', 'pipe' ] } );

		expect( stderr ).toBeDefined();
		const section = readJson( 'o.json' );
		expect( section ).toMatchObject( { status: 'pass', baseline: false } );
		expect( section.markdown ).toContain( '| Suite | Metric | PR | Floor |' );
	} );

	it( 'php-coverage fails the section when the head report is missing', () => {
		cli( [ 'php-coverage', '--head', 'missing.xml', '--output', 'o.json' ] );

		expect( readJson( 'o.json' ).status ).toBe( 'fail' );
	} );

	it( 'js-coverage reads a json-summary and applies the js floors', () => {
		write( 'head.json', jestSummary( 92 ) );

		cli( [ 'js-coverage', '--head', 'head.json', '--output', 'o.json' ] );

		const section = readJson( 'o.json' );
		expect( section.status ).toBe( 'fail' );
		expect( section.failures ).toContain( 'JS statements coverage is 92% (floor 95%)' );
	} );

	it( 'php-metrics applies the gate', () => {
		write( 'head.json', JSON.stringify( { OOP: { classes: 2 }, Violations: { critical: 1 } } ) );

		cli( [ 'php-metrics', '--head', 'head.json', '--output', 'o.json' ] );

		expect( readJson( 'o.json' ) ).toMatchObject( { status: 'fail', failures: [ 'Violations: critical is 1 (max 0)' ] } );
	} );

	it( 'js-complexity reads ESLint JSON relative to a root', () => {
		const file = at( 'src', 'a.js' );
		write( 'eslint.json', JSON.stringify( [ { filePath: file, messages: [ { ruleId: 'complexity', line: 3, message: "Function 'a' has a complexity of 2. Maximum allowed is 0." } ] } ] ) );

		cli( [ 'js-complexity', '--head', 'eslint.json', '--root', dir, '--output', 'o.json' ] );

		const section = readJson( 'o.json' );
		expect( section.status ).toBe( 'pass' );
		expect( section.rows.rows ).toContainEqual( [ 'Max cyclomatic complexity', '2', '5 ✅' ] );
	} );

	it( 'checks turns step outcomes into a rows section', () => {
		cli( [ 'checks', '--id', 'php-quality', '--title', 'PHP quality', '--output', 'o.json', '--checks', 'PHPCS=success\nPHPStan=failure\nPHPMD=skipped' ] );

		const section = readJson( 'o.json' );
		expect( section.status ).toBe( 'fail' );
		expect( section.rows.rows ).toEqual( [ [ 'PHPCS', '✅ passed' ], [ 'PHPStan', '❌ failed' ], [ 'PHPMD', '⚪ skipped' ] ] );
		expect( section.failures ).toEqual( [ 'PHPStan failed' ] );
	} );

	it( 'warns and gates nothing when the thresholds file is missing', () => {
		write( 'head.xml', clover( 100, 10 ) );
		const log = quiet();

		expect( main( { argv: [ 'php-coverage', '--head', at( 'head.xml' ), '--thresholds', at( 'none.json' ), '--output', at( 'o.json' ) ], env: {}, log } ) ).toBe( true );
		expect( readJson( 'o.json' ).status ).toBe( 'pass' );
		expect( log.warn ).toHaveBeenCalledWith( expect.stringContaining( 'No thresholds file' ) );
	} );
} );

describe( 'enforce', () => {
	it( 'passes when no section failed', () => {
		write( 'a.json', JSON.stringify( { id: 'a', title: 'A', status: 'warn', markdown: 'x' } ) );

		expect( main( { argv: [ 'enforce', '--section', at( 'a.json' ) ], env: {}, log: quiet() } ) ).toBe( true );
	} );

	it( 'fails, annotating each failure, when a section failed', () => {
		write( 'a.json', JSON.stringify( { id: 'a', title: 'A', status: 'pass', markdown: 'x' } ) );
		write( 'b.json', JSON.stringify( { id: 'b', title: 'B', status: 'fail', markdown: 'x', failures: [ 'one', 'two' ] } ) );
		const log = quiet();

		expect( main( { argv: [ 'enforce', '--section', `${ at( 'a.json' ) }\n${ at( 'b.json' ) }` ], env: {}, log } ) ).toBe( false );
		expect( log.error ).toHaveBeenCalledWith( '::error::one' );
		expect( log.error ).toHaveBeenCalledWith( '::error::two' );
	} );

	it( 'fails when a section file is missing', () => {
		expect( main( { argv: [ 'enforce', '--section', at( 'nope.json' ) ], env: {}, log: quiet() } ) ).toBe( false );
	} );

	it( 'exits non-zero from the CLI', () => {
		write( 'b.json', JSON.stringify( { id: 'b', title: 'B', status: 'fail', markdown: 'x' } ) );

		expect( () => cli( [ 'enforce', '--section', 'b.json' ] ) ).toThrow();
	} );
} );

describe( 'read-meta and merge', () => {
	const section = ( id, extra = {} ) => JSON.stringify( { id, title: id, status: 'pass', markdown: `${ id } body`, baseline: true, ...extra } );

	beforeEach( () => {
		write( 'art/report-meta/meta.json', JSON.stringify( { pr_number: 7, head_sha: HEAD_SHA } ) );
		write( 'art/report-meta-js/meta.json', JSON.stringify( { pr_number: 7 } ) );
		write( 'art/report-section-php-coverage/php-coverage.json', section( 'php-coverage' ) );
		write( 'art/report-section-js-coverage/js-coverage.json', section( 'js-coverage' ) );
	} );

	it( 'read-meta outputs the PR number the fragments agree on', () => {
		write( 'gh', '' );

		expect( main( { argv: [ 'read-meta', '--dir', at( 'art' ) ], env: { GITHUB_OUTPUT: at( 'gh' ) }, log: quiet() } ) ).toBe( true );
		expect( fs.readFileSync( at( 'gh' ), 'utf8' ) ).toBe( 'pr-number=7\n' );
	} );

	it( 'read-meta fails when the fragments disagree', () => {
		write( 'art/report-meta-js/meta.json', JSON.stringify( { pr_number: 8 } ) );

		expect( main( { argv: [ 'read-meta', '--dir', at( 'art' ) ], env: {}, log: quiet() } ) ).toBe( false );
	} );

	const merge = ( extra = [] ) => main( {
		argv: [ 'merge', '--dir', at( 'art' ), '--head-sha', HEAD_SHA, '--base-sha', BASE_SHA, '--run-url', RUN_URL, '--run-name', 'Integrate', '--conclusion', 'success', '--output', at( 'report.md' ), ...extra ],
		env: {},
		log: quiet(),
	} );

	it( 'merges every section artifact into one comment', () => {
		expect( merge() ).toBe( true );

		const body = fs.readFileSync( at( 'report.md' ), 'utf8' );
		expect( body ).toContain( '### ✅ php-coverage' );
		expect( body ).toContain( '### ✅ js-coverage' );
		expect( body ).toContain( '`bbbbbbb` (base) → `aaaaaaa` (PR)' );
	} );

	it( 'posts nothing, and says so, when every section is empty', () => {
		write( 'art/report-section-php-coverage/php-coverage.json', section( 'php-coverage', { empty: true } ) );
		write( 'art/report-section-js-coverage/js-coverage.json', section( 'js-coverage', { empty: true } ) );
		write( 'gh', '' );

		expect( main( {
			argv: [ 'merge', '--dir', at( 'art' ), '--head-sha', HEAD_SHA, '--run-url', RUN_URL, '--output', at( 'report.md' ) ],
			env: { GITHUB_OUTPUT: at( 'gh' ) },
			log: quiet(),
		} ) ).toBe( true );
		expect( fs.existsSync( at( 'report.md' ) ) ).toBe( false );
		expect( fs.readFileSync( at( 'gh' ), 'utf8' ) ).toContain( 'post=false' );
	} );

	it( 'still posts when an empty section failed', () => {
		write( 'art/report-section-php-coverage/php-coverage.json', section( 'php-coverage', { empty: true, status: 'fail' } ) );
		write( 'art/report-section-js-coverage/js-coverage.json', section( 'js-coverage', { empty: true } ) );
		write( 'gh', '' );

		main( { argv: [ 'merge', '--dir', at( 'art' ), '--head-sha', HEAD_SHA, '--run-url', RUN_URL, '--output', at( 'report.md' ) ], env: { GITHUB_OUTPUT: at( 'gh' ) }, log: quiet() } );
		expect( fs.readFileSync( at( 'gh' ), 'utf8' ) ).toContain( 'post=true' );
		expect( fs.readFileSync( at( 'report.md' ), 'utf8' ) ).toContain( 'No data to show, and failed: php-coverage' );
	} );

	it( 'posts nothing when there are no section artifacts at all', () => {
		fs.rmSync( at( 'art/report-section-php-coverage' ), { recursive: true } );
		fs.rmSync( at( 'art/report-section-js-coverage' ), { recursive: true } );
		write( 'gh', '' );

		expect( main( { argv: [ 'merge', '--dir', at( 'art' ), '--head-sha', HEAD_SHA, '--run-url', RUN_URL, '--output', at( 'report.md' ) ], env: { GITHUB_OUTPUT: at( 'gh' ) }, log: quiet() } ) ).toBe( true );
		expect( fs.readFileSync( at( 'gh' ), 'utf8' ) ).toContain( 'post=false' );
	} );

		it( 'rejects a section whose id does not match its artifact name, and says so', () => {
		write( 'art/report-section-php-metrics/x.json', section( 'php-coverage' ) );

		expect( merge() ).toBe( true );
		const body = fs.readFileSync( at( 'report.md' ), 'utf8' );
		expect( body ).toContain( 'does not match the artifact name' );
	} );

	it( 'rejects malformed JSON without failing the merge', () => {
		write( 'art/report-section-bad/bad.json', '{"id":' );

		expect( merge() ).toBe( true );
		expect( fs.readFileSync( at( 'report.md' ), 'utf8' ) ).toContain( 'rejected as malformed' );
	} );

	it( 'ignores directories that are not report artifacts, and symlinks', () => {
		write( 'art/something-else/x.json', section( 'something-else' ) );
		fs.symlinkSync( at( 'quality-thresholds.json' ), at( 'art/report-section-js-coverage/link.json' ) );

		expect( merge() ).toBe( true );
		const body = fs.readFileSync( at( 'report.md' ), 'utf8' );
		expect( body ).not.toContain( 'something-else' );
		expect( body ).not.toContain( 'rejected' );
	} );

	it( 'refuses a head SHA or run URL that is not well-formed', () => {
		expect( main( { argv: [ 'merge', '--dir', at( 'art' ), '--head-sha', 'abc', '--run-url', RUN_URL ], env: {}, log: quiet() } ) ).toBe( false );
		expect( main( { argv: [ 'merge', '--dir', at( 'art' ), '--head-sha', HEAD_SHA, '--run-url', 'javascript:alert(1)' ], env: {}, log: quiet() } ) ).toBe( false );
	} );

	it( 'drops the comparison when the base SHA is not well-formed', () => {
		expect( merge( [ '--base-sha', 'nope' ] ) ).toBe( true );
		expect( fs.readFileSync( at( 'report.md' ), 'utf8' ) ).not.toContain( '(base) →' );
	} );
} );

describe( 'changes', () => {
	const run = ( files, paths, always = '' ) => {
		write( 'files.txt', files.join( '\n' ) );
		write( 'gh', '' );
		const log = quiet();
		const ok = main( { argv: [ 'changes', '--files', at( 'files.txt' ), '--paths', paths, '--always', always ], env: { GITHUB_OUTPUT: at( 'gh' ) }, log } );
		return { ok, output: fs.readFileSync( at( 'gh' ), 'utf8' ), log };
	};

	it( 'outputs run=true when a changed file matches', () => {
		expect( run( [ 'readme.txt', 'src/A.php' ], '**/*.php\ncomposer.json' ).output ).toBe( 'run=true\n' );
	} );

	it( 'outputs run=false, with a notice, when nothing matches', () => {
		const { output, log } = run( [ 'readme.txt' ], '**/*.php' );

		expect( output ).toBe( 'run=false\n' );
		expect( log.info ).toHaveBeenCalledWith( expect.stringContaining( '::notice::' ) );
	} );

	it( 'reads NUL-separated output from git diff -z, including unquoted non-ASCII names', () => {
		write( 'files.txt', 'readme.txt\0src/café.php\0' );
		write( 'gh', '' );
		main( { argv: [ 'changes', '--files', at( 'files.txt' ), '--paths', '**/*.php' ], env: { GITHUB_OUTPUT: at( 'gh' ) }, log: quiet() } );

		expect( fs.readFileSync( at( 'gh' ), 'utf8' ) ).toBe( 'run=true\n' );
	} );

	it( 'keeps --always files even when a ! pattern in paths would exclude them', () => {
		expect( run( [ '.github/workflows/integrate.yml' ], '**/*.php !.github/**', '.github/workflows/integrate.yml' ).output ).toBe( 'run=true\n' );
	} );

	it( 'counts a custom thresholds file passed in --always', () => {
		expect( run( [ 'packages/app/ci-limits.json' ], '**/*.php', '.github/workflows/integrate.yml packages/app/ci-limits.json' ).output ).toBe( 'run=true\n' );
	} );

	it( 'always runs when the caller workflow changed', () => {
		expect( run( [ '.github/workflows/integrate.yml' ], '**/*.php', '.github/workflows/integrate.yml' ).output ).toBe( 'run=true\n' );
	} );
} );
