/**
 * Matches changed file paths against glob patterns, for the `changes` gate
 * in php-plugin.yml and js.yml. Node built-ins only.
 *
 * Pattern rules (a small, predictable subset of gitignore-style globs):
 *   - Paths and patterns are relative to the repository root, with "/".
 *   - A pattern with no "/" matches at any depth: "composer.json" matches
 *     "composer.json" and "test/fixtures/x/composer.json".
 *   - "*" matches within one path segment, "?" one character, "**" any
 *     number of segments ("**​/*.php", "src/**").
 *   - "{a,b}" matches either alternative ("*.{js,ts}").
 *   - A leading "!" excludes: a path matching any "!" pattern never counts.
 */

'use strict';

/**
 * Converts one glob to an anchored regular expression.
 *
 * @param {string} glob The pattern, without a leading "!".
 * @return {RegExp} The compiled matcher.
 */
function globToRegExp( glob ) {
	let source = '';
	let depth = 0;
	for ( let i = 0; i < glob.length; i++ ) {
		const char = glob[ i ];
		if ( char === '*' ) {
			if ( glob[ i + 1 ] === '*' ) {
				// "**/" may match nothing at all; a bare "**" matches anything.
				if ( glob[ i + 2 ] === '/' ) {
					source += '(?:.*/)?';
					i += 2;
				} else {
					source += '.*';
					i += 1;
				}
			} else {
				source += '[^/]*';
			}
		} else if ( char === '?' ) {
			source += '[^/]';
		} else if ( char === '{' ) {
			depth++;
			source += '(?:';
		} else if ( char === '}' && depth ) {
			depth--;
			source += ')';
		} else if ( char === ',' && depth ) {
			source += '|';
		} else {
			source += char.replace( /[.+^$()|[\]\\]/g, '\\$&' );
		}
	}
	if ( depth ) {
		throw new Error( `paths: unbalanced "{" in "${ glob }"` );
	}
	const anywhere = ! glob.includes( '/' );
	return new RegExp( `^${ anywhere ? '(?:.*/)?' : '' }${ source }$` );
}

/**
 * Splits a patterns input (newline- and/or space-separated) into a list.
 *
 * @param {string} input The raw input.
 * @return {string[]} Patterns, with comments ("# …") and blanks removed.
 */
function parsePatterns( input ) {
	return String( input )
		.split( /\r?\n/ )
		.map( ( line ) => line.replace( /(^|\s)#.*$/, '' ) )
		.flatMap( ( line ) => line.split( /\s+/ ) )
		.filter( Boolean );
}

/**
 * Whether any changed file matches the patterns.
 *
 * @param {string[]} files    Changed paths, relative to the repo root.
 * @param {string[]} patterns Patterns from parsePatterns().
 * @return {{matched: boolean, files: string[]}} Whether anything matched, and what.
 */
function matchChanges( files, patterns ) {
	const include = patterns.filter( ( p ) => ! p.startsWith( '!' ) ).map( globToRegExp );
	const exclude = patterns.filter( ( p ) => p.startsWith( '!' ) ).map( ( p ) => globToRegExp( p.slice( 1 ) ) );

	const hits = files
		.map( ( f ) => f.replace( /^\.\//, '' ) )
		.filter( Boolean )
		.filter( ( f ) => include.some( ( re ) => re.test( f ) ) && ! exclude.some( ( re ) => re.test( f ) ) );

	return { matched: hits.length > 0, files: hits };
}

module.exports = { globToRegExp, parsePatterns, matchChanges };
