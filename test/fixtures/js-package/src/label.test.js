import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelTitle, badgeColour } from './label.js';

test( 'labels archived titles', () => {
	assert.equal( labelTitle( 'Hello', true ), 'Archived: Hello' );
	assert.equal( labelTitle( 'Hello', false ), 'Hello' );
} );

test( 'picks a badge colour per status', () => {
	assert.equal( badgeColour( 'archive' ), 'grey' );
	assert.equal( badgeColour( 'draft' ), 'yellow' );
	assert.equal( badgeColour( 'publish' ), 'green' );
} );
