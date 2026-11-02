#!/usr/bin/env node
/**
 * Entry point for the render-report action and for direct `node` calls.
 *
 *   node index.js <command> --option value …
 *
 * As a GitHub Action, the command and options come from the action inputs
 * instead (INPUT_COMMAND, INPUT_HEAD, …). A flag wins over an input.
 *
 * Commands:
 *   php-coverage   clover XML        → section JSON
 *   js-coverage    json-summary      → section JSON
 *   php-metrics    PHPMetrics JSON   → section JSON
 *   js-complexity  ESLint JSON       → section JSON
 *   checks         "Label=outcome"   → section JSON
 *   enforce        section JSON(s)   → exit 1 when any has status "fail"
 *   read-meta      artifact dir      → pr-number output
 *   merge          artifact dir      → comment markdown
 *   changes        changed-file list → run output (path gate)
 *
 * Node built-ins only, so there is nothing to install or bundle.
 */

'use strict';

const fs = require( 'fs' );
const path = require( 'path' );

const { parseClover, parseJestSummary } = require( './src/coverage' );
const { buildCoverageSection, buildMetricsSection } = require( './src/render-pr-report' );
const { buildComplexitySection } = require( './src/complexity' );
const { parseSection, renderReport, reportable, worthPosting, parseMeta, LIMITS } = require( './src/sections' );
const { parsePatterns, matchChanges } = require( './src/paths' );

/**
 * Reads options from `--key value` flags, falling back to INPUT_* env vars.
 *
 * @param {string[]} argv Arguments after the command.
 * @param {Object}   env  Environment.
 * @return {Function} get( key, fallback ) → string.
 */
function options( argv, env ) {
	const flags = {};
	for ( let i = 0; i < argv.length; i++ ) {
		const match = /^--([a-z0-9-]+)(?:=(.*))?$/.exec( argv[ i ] );
		if ( ! match ) {
			throw new Error( `unexpected argument "${ argv[ i ] }"` );
		}
		if ( match[ 2 ] !== undefined ) {
			flags[ match[ 1 ] ] = match[ 2 ];
		} else {
			flags[ match[ 1 ] ] = argv[ i + 1 ] ?? '';
			i++;
		}
	}
	return ( key, fallback = '' ) => {
		if ( flags[ key ] !== undefined ) {
			return flags[ key ];
		}
		const fromEnv = env[ `INPUT_${ key.toUpperCase() }` ];
		return fromEnv !== undefined && fromEnv !== '' ? fromEnv : fallback;
	};
}

/**
 * Appends `name=value` to the step's outputs, when running in Actions.
 *
 * @param {Object} env   Environment.
 * @param {string} name  Output name.
 * @param {string} value Output value (single line).
 */
function setOutput( env, name, value ) {
	if ( env.GITHUB_OUTPUT ) {
		fs.appendFileSync( env.GITHUB_OUTPUT, `${ name }=${ String( value ).replace( /[\r\n]/g, ' ' ) }\n` );
	}
}

/**
 * Reads a file when it exists and parses it, degrading to null with a
 * warning when it cannot be read: an absent or broken base report should
 * drop the comparison, not crash the job.
 *
 * @param {string}   file  Path, or ''.
 * @param {Function} parse Parser for the contents.
 * @param {string}   label What the file is, for the warning.
 * @param {Object}   log   Logger.
 * @return {*} Parsed contents, or null.
 */
function readOptional( file, parse, label, log ) {
	if ( ! file || ! fs.existsSync( file ) ) {
		return null;
	}
	try {
		return parse( fs.readFileSync( file, 'utf8' ) );
	} catch ( error ) {
		log.warn( `::warning::Ignoring unreadable ${ label } (${ file }): ${ error.message }` );
		return null;
	}
}

/**
 * Reads quality-thresholds.json, or {} with a warning when absent.
 *
 * @param {string} file Path.
 * @param {Object} log  Logger.
 * @return {Object} Parsed thresholds.
 */
function readThresholds( file, log ) {
	if ( ! file || ! fs.existsSync( file ) ) {
		log.warn( `::warning::No thresholds file at "${ file }": nothing will be gated.` );
		return {};
	}
	return JSON.parse( fs.readFileSync( file, 'utf8' ) );
}

/**
 * Writes a section fragment and reports its status.
 *
 * @param {Object}   section The fragment.
 * @param {Function} get     Option getter.
 * @param {Object}   env     Environment.
 * @param {Object}   log     Logger.
 * @return {Object} The section.
 */
function writeSection( section, get, env, log ) {
	// Validate our own output with the same parser the report job uses, so
	// a fragment that would be rejected there fails here, at its source.
	parseSection( JSON.stringify( section ), section.id );

	const output = get( 'output' ) || `${ section.id }.json`;
	fs.mkdirSync( path.dirname( path.resolve( output ) ), { recursive: true } );
	fs.writeFileSync( output, JSON.stringify( section, null, 2 ) );
	setOutput( env, 'status', section.status );
	setOutput( env, 'path', output );
	log.info( `${ section.id }: ${ section.status } → ${ output }` );
	for ( const failure of section.failures || [] ) {
		log.info( `  - ${ failure }` );
	}
	return section;
}

/**
 * Lists the JSON files one level inside each artifact directory.
 *
 * @param {string} dir The download directory (one subdirectory per artifact).
 * @return {Array<{artifact: string, file: string}>} Found files.
 */
function artifactFiles( dir ) {
	if ( ! dir || ! fs.existsSync( dir ) ) {
		return [];
	}
	const found = [];
	for ( const artifact of fs.readdirSync( dir ).sort() ) {
		const artifactDir = path.join( dir, artifact );
		if ( ! fs.lstatSync( artifactDir ).isDirectory() ) {
			continue;
		}
		for ( const name of fs.readdirSync( artifactDir ).sort() ) {
			const file = path.join( artifactDir, name );
			// lstat, so a symlink planted in an artifact is never followed.
			if ( name.endsWith( '.json' ) && fs.lstatSync( file ).isFile() ) {
				found.push( { artifact, file } );
			}
		}
	}
	return found;
}

const COMMANDS = {
	'php-coverage'( get, env, log ) {
		const read = ( contents ) => ( { php: parseClover( contents ) } );
		const thresholds = readThresholds( get( 'thresholds', 'quality-thresholds.json' ), log );
		return writeSection(
			buildCoverageSection( {
				id: get( 'id', 'php-coverage' ),
				title: get( 'title', 'PHP coverage' ),
				head: readOptional( get( 'head', 'coverage/php-clover.xml' ), read, 'PR coverage report', log ),
				base: readOptional( get( 'base' ), read, 'base coverage report', log ),
				floors: { php: ( thresholds.coverage && thresholds.coverage.php ) || {} },
			} ),
			get,
			env,
			log
		);
	},

	'js-coverage'( get, env, log ) {
		const read = ( contents ) => ( { js: parseJestSummary( JSON.parse( contents ) ) } );
		const thresholds = readThresholds( get( 'thresholds', 'quality-thresholds.json' ), log );
		return writeSection(
			buildCoverageSection( {
				id: get( 'id', 'js-coverage' ),
				title: get( 'title', 'JS coverage' ),
				head: readOptional( get( 'head', 'coverage/coverage-summary.json' ), read, 'PR coverage summary', log ),
				base: readOptional( get( 'base' ), read, 'base coverage summary', log ),
				floors: { js: ( thresholds.coverage && thresholds.coverage.js ) || {} },
			} ),
			get,
			env,
			log
		);
	},

	'php-metrics'( get, env, log ) {
		const thresholds = readThresholds( get( 'thresholds', 'quality-thresholds.json' ), log );
		const metrics = thresholds.metrics || {};
		return writeSection(
			buildMetricsSection( {
				id: get( 'id', 'php-metrics' ),
				title: get( 'title', 'PHP code metrics' ),
				head: readOptional( get( 'head', 'reports/metrics-summary.json' ), JSON.parse, 'PR metrics summary', log ),
				base: readOptional( get( 'base' ), JSON.parse, 'base metrics summary', log ),
				max: metrics.max || {},
				gate: metrics.gate || [],
			} ),
			get,
			env,
			log
		);
	},

	'js-complexity'( get, env, log ) {
		const thresholds = readThresholds( get( 'thresholds', 'quality-thresholds.json' ), log );
		return writeSection(
			buildComplexitySection( {
				id: get( 'id', 'js-complexity' ),
				title: get( 'title', 'JS complexity' ),
				head: readOptional( get( 'head', 'reports/eslint-complexity.json' ), JSON.parse, 'PR ESLint output', log ),
				base: readOptional( get( 'base' ), JSON.parse, 'base ESLint output', log ),
				root: path.resolve( get( 'root', '.' ) ),
				baseRoot: path.resolve( get( 'base-root', '.' ) ),
				thresholds,
				mode: get( 'mode' ),
			} ),
			get,
			env,
			log
		);
	},

	checks( get, env, log ) {
		const results = { success: '✅ passed', failure: '❌ failed', cancelled: '⚪ cancelled', skipped: '⚪ skipped' };
		const rows = [];
		const failures = [];
		for ( const line of get( 'checks' ).split( /\r?\n/ ) ) {
			const match = /^\s*(.+?)\s*=\s*([a-z]*)\s*$/.exec( line );
			if ( ! match ) {
				continue;
			}
			const [ , label, outcome ] = match;
			rows.push( [ label, results[ outcome ] || '⚪ not run' ] );
			if ( outcome === 'failure' ) {
				failures.push( `${ label } failed` );
			}
		}
		return writeSection(
			{
				id: get( 'id', 'checks' ),
				title: get( 'title', 'Checks' ),
				status: failures.length ? 'fail' : 'pass',
				rows: { columns: [ 'Check', 'Result' ], rows },
				failures,
			},
			get,
			env,
			log
		);
	},

	enforce( get, env, log ) {
		let ok = true;
		for ( const file of get( 'section' ).split( /\r?\n/ ).map( ( f ) => f.trim() ).filter( Boolean ) ) {
			if ( ! fs.existsSync( file ) ) {
				log.error( `::error::Report section not found: ${ file }` );
				ok = false;
				continue;
			}
			const section = parseSection( fs.readFileSync( file, 'utf8' ), file );
			if ( section.status === 'fail' ) {
				ok = false;
				const failures = section.failures && section.failures.length ? section.failures : [ `${ section.title } failed` ];
				for ( const failure of failures ) {
					log.error( `::error::${ failure }` );
				}
			}
		}
		if ( ! ok ) {
			log.error( 'Enforcement failed. To report without failing, set `enforce: false` on the caller.' );
		}
		return ok;
	},

	changes( get, env, log ) {
		// NUL-separated (`git diff -z`) so names are never quoted or split;
		// newlines are accepted too, for hand-written lists.
		const files = fs.readFileSync( get( 'files' ), 'utf8' ).split( /\0|\r?\n/ ).filter( Boolean );
		// The caller's own workflow file and the thresholds file always
		// count, whatever `!` exclusions `paths` has: changing how CI runs
		// must run CI.
		const pathHits = matchChanges( files, parsePatterns( get( 'paths' ) ) ).files;
		const alwaysHits = matchChanges( files, parsePatterns( get( 'always' ) ) ).files;
		const hits = [ ...new Set( [ ...pathHits, ...alwaysHits ] ) ];
		const matched = hits.length > 0;
		log.info( `${ files.length } changed file(s); ${ hits.length } match the paths.` );
		for ( const hit of hits.slice( 0, 20 ) ) {
			log.info( `  ${ hit }` );
		}
		if ( ! matched ) {
			log.info( '::notice::No changes match this workflow\'s paths, so its jobs are skipped.' );
		}
		setOutput( env, 'run', matched ? 'true' : 'false' );
		return true;
	},

	'read-meta'( get, env ) {
		const raws = artifactFiles( get( 'dir' ) )
			.filter( ( { artifact } ) => /^report-meta(-[a-z0-9-]+)?$/.test( artifact ) )
			.map( ( { file } ) => fs.readFileSync( file, 'utf8' ) );
		const pr = parseMeta( raws );
		setOutput( env, 'pr-number', pr );
		return pr;
	},

	merge( get, env, log ) {
		const sections = [];
		const rejected = [];
		const seen = new Set();

		const files = artifactFiles( get( 'dir' ) ).filter( ( { artifact } ) => /^report-section-[a-z0-9-]+$/.test( artifact ) );
		for ( const { artifact, file } of files.slice( 0, LIMITS.sections ) ) {
			try {
				const section = parseSection( fs.readFileSync( file, 'utf8' ), artifact );
				if ( `report-section-${ section.id }` !== artifact ) {
					throw new Error( `${ artifact }: id "${ section.id }" does not match the artifact name` );
				}
				if ( seen.has( section.id ) ) {
					throw new Error( `${ artifact }: duplicate section id` );
				}
				seen.add( section.id );
				sections.push( section );
			} catch ( error ) {
				log.warn( `::warning::${ error.message }` );
				rejected.push( error.message );
			}
		}
		if ( files.length > LIMITS.sections ) {
			rejected.push( `${ files.length - LIMITS.sections } section(s) over the limit of ${ LIMITS.sections } were ignored` );
		}

		const headSha = get( 'head-sha' );
		const runUrl = get( 'run-url' );
		if ( ! /^[0-9a-f]{40}$/.test( headSha ) ) {
			throw new Error( 'merge: head-sha must be a full commit SHA' );
		}
		if ( ! /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+(\/attempts\/\d+)?$/.test( runUrl ) ) {
			throw new Error( 'merge: run-url must be a GitHub Actions run URL' );
		}

		// Nothing to show: no comment at all. The caller deletes a stale one.
		if ( ! worthPosting( sections ) && ! rejected.length ) {
			setOutput( env, 'post', 'false' );
			setOutput( env, 'sections', 0 );
			log.info( 'No non-empty sections: nothing to post.' );
			return true;
		}

		const markdown = renderReport( {
			sections,
			rejected,
			headSha,
			baseSha: /^[0-9a-f]{40}$/.test( get( 'base-sha' ) ) ? get( 'base-sha' ) : '',
			runUrl,
			runName: get( 'run-name', 'CI' ),
			conclusion: get( 'conclusion' ),
		} );

		const output = get( 'output', 'pr-report.md' );
		fs.writeFileSync( output, markdown );
		setOutput( env, 'path', output );
		setOutput( env, 'post', 'true' );
		setOutput( env, 'sections', reportable( sections ).length );
		log.info( `Merged ${ sections.length } section(s) into ${ output }` );
		return markdown;
	},
};

/**
 * Runs a command.
 *
 * @param {Object}   opts      Run options.
 * @param {string[]} opts.argv Arguments (command first, unless INPUT_COMMAND is set).
 * @param {Object}   opts.env  Environment.
 * @param {Object}   opts.log  Logger with info/warn/error.
 * @return {boolean} Whether the command succeeded.
 */
function main( { argv = process.argv.slice( 2 ), env = process.env, log = { info: console.log, warn: console.warn, error: console.error } } = {} ) {
	let args = argv;
	let command = env.INPUT_COMMAND;
	if ( args.length && ! args[ 0 ].startsWith( '--' ) ) {
		command = args[ 0 ];
		args = args.slice( 1 );
	}
	if ( ! COMMANDS[ command ] ) {
		log.error( `::error::Unknown command "${ command }". Expected one of: ${ Object.keys( COMMANDS ).join( ', ' ) }` );
		return false;
	}

	try {
		const result = COMMANDS[ command ]( options( args, env ), env, log );
		return result !== false;
	} catch ( error ) {
		log.error( `::error::${ command }: ${ error.message }` );
		return false;
	}
}

module.exports = { main, options, artifactFiles };

if ( require.main === module ) {
	process.exitCode = main() ? 0 : 1;
}
