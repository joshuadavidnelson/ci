/**
 * Report section fragments: validation, sanitising and merging.
 *
 * A section fragment is the JSON each CI job uploads as a
 * `report-section-<id>` artifact:
 *
 *   {
 *     "id": "php-coverage",            // ^[a-z0-9][a-z0-9-]{0,62}$
 *     "title": "PHP coverage",         // one line, ≤ 120 chars
 *     "status": "pass" | "warn" | "fail",
 *     "markdown": "…",                 // either a markdown body …
 *     "rows": { "columns": [ … ], "rows": [ [ … ] ], "align": [ "left" | "right" ] },  // … or a table
 *     "summary": "…",                  // optional line above a rows table
 *     "baseline": true,                // optional: compared against the base branch
 *     "empty": true,                   // optional: no data; enforced, never rendered
 *     "failures": [ "…" ]              // optional: enforcement messages, never rendered
 *   }
 *
 * The comment is posted by a workflow_run job with a write token, and the
 * fragments come from a pull_request run whose workflow file a fork can
 * edit. So everything read here is untrusted: sizes are capped, the shape is
 * validated, and every string is escaped so a fragment cannot inject HTML,
 * images or @-mentions into a comment the bot posts. Node built-ins only.
 */

'use strict';

const STATUSES = [ 'pass', 'warn', 'fail' ];
const ICONS = { pass: '✅', warn: '⚠️', fail: '❌' };
const RANK = { pass: 0, warn: 1, fail: 2 };

// Sections a known workflow emits, in the order the comment shows them.
// Anything else sorts after these, alphabetically by id.
const ORDER = [ 'php-quality', 'php-coverage', 'js-coverage', 'php-metrics', 'js-complexity' ];

const LIMITS = {
	fileBytes: 64 * 1024,
	sections: 20,
	title: 120,
	summary: 1000,
	markdown: 16 * 1024,
	columns: 10,
	rows: 200,
	cell: 300,
	comment: 60000,
	failures: 50,
	failure: 300,
};

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Removes control characters other than tab and newline.
 *
 * @param {string} text Raw text.
 * @return {string} Text without control characters.
 */
function stripControl( text ) {
	// eslint-disable-next-line no-control-regex
	return text.replace( /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, '' );
}

/**
 * Neutralises the markdown that could make a bot comment do more than
 * display text: raw HTML (escaped), images (no remote fetches), @-mentions
 * (no notifications) and line breaks in single-line contexts.
 *
 * @param {string} text Untrusted text.
 * @return {string} Text safe to embed in the comment.
 */
function neutralise( text ) {
	return stripControl( String( text ) )
		.replace( /&/g, '&amp;' )
		.replace( /</g, '&lt;' )
		.replace( />/g, '&gt;' )
		.replace( /!\[/g, '!\\[' )
		// A zero-width joiner after @ keeps the text readable but stops
		// GitHub resolving it as a user or team mention.
		.replace( /@(?=[A-Za-z0-9_-])/g, '@‍' );
}

/**
 * Escapes markdown block quotes, which neutralise() turned into "&gt;".
 * They are harmless, so restore a leading ">" for quote lines.
 *
 * @param {string} text Neutralised markdown.
 * @return {string} Markdown with block quotes working again.
 */
function restoreQuotes( text ) {
	return text.replace( /^((?:&gt;\s?)+)/gm, ( match ) => match.replace( /&gt;/g, '>' ) );
}

/**
 * Truncates a string to a length, marking that it was cut.
 *
 * @param {string} text  The text.
 * @param {number} limit Maximum length.
 * @return {string} The text, at most `limit` characters long.
 */
function cap( text, limit ) {
	return text.length > limit ? `${ text.slice( 0, limit - 1 ) }…` : text;
}

/**
 * Makes untrusted text safe for a single line: a title, a summary or a cell.
 *
 * @param {string} text  Untrusted text.
 * @param {number} limit Maximum length.
 * @return {string} One escaped line.
 */
function inline( text, limit ) {
	return cap( neutralise( text ).replace( /\s*[\r\n]+\s*/g, ' ' ).replace( /\|/g, '\\|' ).trim(), limit );
}

/**
 * Makes an untrusted markdown body safe to embed.
 *
 * @param {string} text Untrusted markdown.
 * @return {string} Escaped markdown, capped in size.
 */
function block( text ) {
	const safe = restoreQuotes( neutralise( text ).replace( /\r\n?/g, '\n' ) ).trim();
	// Headings at level 1–3 would compete with the comment's own structure.
	const demoted = safe.replace( /^#{1,3}(?=\s)/gm, '####' );
	return demoted.length > LIMITS.markdown
		? `${ demoted.slice( 0, LIMITS.markdown ) }\n\n_…section truncated._`
		: demoted;
}

/**
 * Parses and validates one section fragment.
 *
 * @param {string} raw    File contents.
 * @param {string} source Where it came from, for error messages.
 * @return {Object} The validated (not yet escaped) section.
 * @throws {Error} When the fragment is oversized, not JSON, or malformed.
 */
function parseSection( raw, source = 'section' ) {
	if ( Buffer.byteLength( raw, 'utf8' ) > LIMITS.fileBytes ) {
		throw new Error( `${ source }: larger than ${ LIMITS.fileBytes } bytes` );
	}

	let data;
	try {
		data = JSON.parse( raw );
	} catch ( error ) {
		throw new Error( `${ source }: not valid JSON (${ error.message })` );
	}

	if ( ! data || typeof data !== 'object' || Array.isArray( data ) ) {
		throw new Error( `${ source }: must be a JSON object` );
	}
	if ( typeof data.id !== 'string' || ! ID_PATTERN.test( data.id ) ) {
		throw new Error( `${ source }: "id" must match ${ ID_PATTERN }` );
	}
	if ( typeof data.title !== 'string' || ! data.title.trim() ) {
		throw new Error( `${ source }: "title" must be a non-empty string` );
	}
	if ( ! STATUSES.includes( data.status ) ) {
		throw new Error( `${ source }: "status" must be one of ${ STATUSES.join( ', ' ) }` );
	}

	const hasMarkdown = typeof data.markdown === 'string';
	const hasRows = data.rows !== undefined;
	if ( hasMarkdown === hasRows ) {
		throw new Error( `${ source }: needs exactly one of "markdown" or "rows"` );
	}

	const section = { id: data.id, title: data.title, status: data.status, baseline: data.baseline === true };
	if ( data.empty === true ) {
		section.empty = true;
	}

	if ( hasMarkdown ) {
		section.markdown = data.markdown;
	} else {
		const table = data.rows;
		if ( ! table || ! Array.isArray( table.columns ) || ! Array.isArray( table.rows ) ) {
			throw new Error( `${ source }: "rows" must be { columns: [], rows: [[]] }` );
		}
		if ( ! table.columns.length || table.columns.length > LIMITS.columns ) {
			throw new Error( `${ source }: "rows.columns" must have 1–${ LIMITS.columns } entries` );
		}
		if ( table.rows.length > LIMITS.rows ) {
			throw new Error( `${ source }: "rows.rows" has more than ${ LIMITS.rows } rows` );
		}
		const scalar = ( cell ) => [ 'string', 'number', 'boolean' ].includes( typeof cell ) || cell === null;
		for ( const tableRow of table.rows ) {
			if ( ! Array.isArray( tableRow ) || tableRow.length !== table.columns.length || ! tableRow.every( scalar ) ) {
				throw new Error( `${ source }: every row must be an array of ${ table.columns.length } scalar cells` );
			}
		}
		if ( ! table.columns.every( scalar ) ) {
			throw new Error( `${ source }: column headings must be scalars` );
		}
		section.rows = {
			columns: table.columns,
			rows: table.rows,
			align: Array.isArray( table.align ) ? table.align : [],
		};
	}

	if ( data.summary !== undefined ) {
		if ( typeof data.summary !== 'string' ) {
			throw new Error( `${ source }: "summary" must be a string` );
		}
		section.summary = data.summary;
	}

	if ( data.failures !== undefined ) {
		if ( ! Array.isArray( data.failures ) || ! data.failures.every( ( f ) => typeof f === 'string' ) ) {
			throw new Error( `${ source }: "failures" must be an array of strings` );
		}
		section.failures = data.failures.slice( 0, LIMITS.failures ).map( ( f ) => cap( f, LIMITS.failure ) );
	}

	return section;
}

/**
 * Renders one validated section's body as safe markdown.
 *
 * @param {Object} section A section from parseSection().
 * @return {string} Markdown, without the heading.
 */
function renderSectionBody( section ) {
	const parts = [];
	if ( section.summary ) {
		parts.push( inline( section.summary, LIMITS.summary ), '' );
	}

	if ( section.markdown !== undefined ) {
		parts.push( block( section.markdown ) );
	} else {
		const { columns, rows, align } = section.rows;
		const cell = ( value ) => ( value === null ? '—' : inline( value, LIMITS.cell ) );
		parts.push(
			`| ${ columns.map( cell ).join( ' | ' ) } |`,
			`| ${ columns.map( ( _, i ) => ( align[ i ] === 'right' ? '---:' : '---' ) ).join( ' | ' ) } |`,
			...rows.map( ( tableRow ) => `| ${ tableRow.map( cell ).join( ' | ' ) } |` )
		);
		if ( ! rows.length ) {
			parts.push( '', '_No rows._' );
		}
	}

	return parts.join( '\n' );
}

/**
 * Sorts sections into the comment's display order.
 *
 * @param {Object[]} sections Validated sections.
 * @return {Object[]} A sorted copy.
 */
function sortSections( sections ) {
	// A prefixed id (e.g. "fixture-php-coverage") sorts with its base id.
	const position = ( id ) => {
		const index = ORDER.findIndex( ( known ) => id === known || id.endsWith( `-${ known }` ) );
		return index === -1 ? ORDER.length : index;
	};
	return [ ...sections ].sort( ( a, b ) => position( a.id ) - position( b.id ) || a.id.localeCompare( b.id ) );
}

/**
 * The worst status across sections.
 *
 * @param {Object[]} sections Validated sections.
 * @return {string|null} pass, warn or fail; null when there are none.
 */
function overallStatus( sections ) {
	if ( ! sections.length ) {
		return null;
	}
	return sections.reduce( ( worst, s ) => ( RANK[ s.status ] > RANK[ worst ] ? s.status : worst ), 'pass' );
}

/**
 * The sections worth showing: those that carry data.
 *
 * An empty section (its tool produced nothing, or measured nothing) still
 * counts for enforcement, but a table of "n/a" in the comment helps nobody.
 *
 * @param {Object[]} sections Validated sections.
 * @return {Object[]} The non-empty ones.
 */
function reportable( sections ) {
	return sections.filter( ( s ) => ! s.empty );
}

/**
 * Whether a comment is worth posting: some section has data, or some
 * empty section failed (which must not be hidden by posting nothing).
 *
 * @param {Object[]} sections Validated sections.
 * @return {boolean} True when a comment should be posted.
 */
function worthPosting( sections ) {
	return sections.some( ( s ) => ! s.empty || s.status === 'fail' );
}

/**
 * Merges an arbitrary set of sections into the one PR comment.
 *
 * @param {Object}   input             Render input.
 * @param {Object[]} input.sections    Sections from parseSection().
 * @param {string[]} input.rejected    Messages for fragments that failed validation.
 * @param {string}   input.headSha     Full SHA of the PR head (from the API, not the artifact).
 * @param {string}   input.baseSha     Full SHA of the base, or '' when unknown.
 * @param {string}   input.runUrl      Link to the run that produced the sections.
 * @param {string}   input.runName     Name of that workflow.
 * @param {string}   input.conclusion  That run's conclusion.
 * @return {string} Markdown body.
 */
function renderReport( { sections, rejected = [], headSha, baseSha = '', runUrl, runName = 'CI', conclusion = '' } ) {
	const sorted = sortSections( reportable( sections ) );
	// Empty sections have no table worth showing, but a failing one must
	// still count: the headline is the worst of ALL sections, and failing
	// empty ones are named in one line.
	const hiddenFailures = sortSections( sections.filter( ( s ) => s.empty && s.status === 'fail' ) );
	const shortHead = String( headSha ).slice( 0, 7 );
	const shortBase = String( baseSha ).slice( 0, 7 );

	// Only claim a comparison some section can back up: when every section
	// fell back to showing the PR alone, "base → PR" would contradict them.
	const comparable = shortBase && sorted.some( ( s ) => s.baseline );

	const status = overallStatus( sections );
	const headline = {
		pass: '✅ All checks in this report passed.',
		warn: '⚠️ Nothing failed, but some numbers moved the wrong way.',
		fail: '❌ At least one section failed.',
	}[ status ] || 'ℹ️ This run uploaded no report sections.';

	const notes = [];
	if ( conclusion && conclusion !== 'success' ) {
		notes.push( `> [!WARNING]\n> The ${ inline( runName, 80 ) } run concluded \`${ inline( conclusion, 40 ) }\`. Sections from jobs that did not finish are missing.` );
	}
	if ( hiddenFailures.length ) {
		notes.push( `❌ No data to show, and failed: ${ hiddenFailures.map( ( s ) => inline( s.title, LIMITS.title ) ).join( ', ' ) }. See the run log.` );
	}
	if ( rejected.length ) {
		notes.push(
			`> [!CAUTION]\n> ${ rejected.length } report fragment${ rejected.length === 1 ? ' was' : 's were' } rejected as malformed:\n` +
				rejected.slice( 0, 10 ).map( ( message ) => `> - ${ inline( message, 200 ) }` ).join( '\n' )
		);
	}

	const header = [
		'## 📊 PR Report',
		'',
		comparable ? `\`${ shortBase }\` (base) → \`${ shortHead }\` (PR)` : `\`${ shortHead }\` (PR)`,
		'',
		headline,
		'',
		...notes.flatMap( ( note ) => [ note, '' ] ),
	].join( '\n' ) + '\n';

	const footer = `<sub>Posted by [joshuadavidnelson/ci](https://github.com/joshuadavidnelson/ci) from [the ${ inline( runName, 80 ) } run](${ runUrl }). Full reports are attached to that run.</sub>`;

	let body = header;
	let omitted = 0;
	for ( const section of sorted ) {
		const chunk = `### ${ ICONS[ section.status ] } ${ inline( section.title, LIMITS.title ) }\n\n${ renderSectionBody( section ) }\n\n`;
		if ( body.length + chunk.length + footer.length + 200 > LIMITS.comment ) {
			omitted++;
			continue;
		}
		body += chunk;
	}
	if ( omitted ) {
		body += `_${ omitted } section${ omitted === 1 ? '' : 's' } omitted to keep the comment under GitHub's size limit._\n\n`;
	}

	return body + footer;
}

/**
 * Validates the meta fragment(s) and returns the PR number they agree on.
 *
 * The number is only a pointer: the caller must still confirm against the
 * API that this PR's head is the run's head before trusting it.
 *
 * @param {string[]} raws Contents of each meta file found.
 * @return {number} The PR number.
 * @throws {Error} When there is none, one is malformed, or they disagree.
 */
function parseMeta( raws ) {
	if ( ! raws.length ) {
		throw new Error( 'no report-meta artifact found' );
	}
	const numbers = new Set();
	for ( const raw of raws ) {
		if ( Buffer.byteLength( raw, 'utf8' ) > 4096 ) {
			throw new Error( 'report-meta: larger than 4096 bytes' );
		}
		const data = JSON.parse( raw );
		const pr = data && data.pr_number;
		if ( ! Number.isSafeInteger( pr ) || pr < 1 ) {
			throw new Error( 'report-meta: "pr_number" must be a positive integer' );
		}
		numbers.add( pr );
	}
	if ( numbers.size !== 1 ) {
		throw new Error( `report-meta: fragments disagree on the PR number (${ [ ...numbers ].join( ', ' ) })` );
	}
	return [ ...numbers ][ 0 ];
}

module.exports = {
	LIMITS,
	ORDER,
	neutralise,
	inline,
	block,
	parseSection,
	renderSectionBody,
	sortSections,
	overallStatus,
	renderReport,
	reportable,
	worthPosting,
	parseMeta,
};
