/**
 * Formats the archived label shown beside a post title.
 *
 * @param {string}  title    Post title.
 * @param {boolean} archived Whether the post is archived.
 * @param {string}  text     Label text.
 * @return {string} The title, labelled when archived.
 */
export function labelTitle( title, archived, text = 'Archived' ) {
	if ( ! archived ) {
		return title;
	}
	return `${ text }: ${ title }`;
}

/**
 * Picks a badge colour for a post status.
 *
 * @param {string} status Post status.
 * @return {string} A colour name.
 */
export function badgeColour( status ) {
	switch ( status ) {
		case 'archive':
			return 'grey';
		case 'draft':
			return 'yellow';
		default:
			return 'green';
	}
}
