'use strict';

const { globToRegExp, parsePatterns, matchChanges } = require( './paths' );

const PHP_DEFAULTS = parsePatterns( `
	**/*.php
	composer.json composer.lock
	phpcs.xml* .phpcs.xml* phpstan.neon* phpunit.xml* phpmd*.xml
	quality-thresholds.json
` );

describe( 'globToRegExp', () => {
	it.each( [
		[ '**/*.php', 'src/A.php', true ],
		[ '**/*.php', 'A.php', true ],
		[ '**/*.php', 'src/deep/er/A.php', true ],
		[ '**/*.php', 'src/A.phps', false ],
		[ 'src/*.js', 'src/a.js', true ],
		[ 'src/*.js', 'src/x/a.js', false ],
		[ 'src/**', 'src/x/a.js', true ],
		[ '**/*.{js,jsx,ts,tsx,mjs,cjs}', 'assets/js/a.tsx', true ],
		[ '**/*.{js,jsx,ts,tsx,mjs,cjs}', 'assets/js/a.json', false ],
		[ 'composer.json', 'composer.json', true ],
		[ 'composer.json', 'test/fixtures/p/composer.json', true ],
		[ 'composer.json', 'composer.json.bak', false ],
		[ 'phpunit.xml*', 'phpunit.xml.dist', true ],
		[ 'eslint.config.*', 'eslint.config.mjs', true ],
		[ 'tsconfig*.json', 'tsconfig.build.json', true ],
		[ 'a?c', 'abc', true ],
		[ 'a?c', 'a/c', false ],
		[ 'file.txt', 'fileXtxt', false ],
	] )( '%s against %s → %s', ( glob, file, expected ) => {
		expect( globToRegExp( glob ).test( file ) ).toBe( expected );
	} );

	it( 'rejects an unbalanced brace', () => {
		expect( () => globToRegExp( '*.{js' ) ).toThrow( /unbalanced/ );
	} );
} );

describe( 'parsePatterns', () => {
	it( 'splits on newlines and spaces, dropping blanks and comments', () => {
		expect( parsePatterns( '  a b\n# note\n\nc # trailing\n' ) ).toEqual( [ 'a', 'b', 'c' ] );
	} );
} );

describe( 'matchChanges', () => {
	it( 'matches a PHP change', () => {
		expect( matchChanges( [ 'readme.txt', 'src/Plugin.php' ], PHP_DEFAULTS ) ).toEqual( { matched: true, files: [ 'src/Plugin.php' ] } );
	} );

	it( 'does not match a readme-only change', () => {
		expect( matchChanges( [ 'readme.txt', '.wordpress-org/banner.png' ], PHP_DEFAULTS ).matched ).toBe( false );
	} );

	it( 'matches config files at any depth', () => {
		expect( matchChanges( [ 'test/fixtures/p/.phpcs.xml.dist' ], PHP_DEFAULTS ).matched ).toBe( true );
	} );

	it( 'honours exclusions', () => {
		const patterns = [ ...PHP_DEFAULTS, '!vendor/**' ];

		expect( matchChanges( [ 'vendor/x/A.php' ], patterns ).matched ).toBe( false );
	} );

	it( 'matches nothing for an empty change list', () => {
		expect( matchChanges( [], PHP_DEFAULTS ).matched ).toBe( false );
	} );
} );
