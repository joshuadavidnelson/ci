<?php

declare(strict_types=1);

namespace CiFixture;

/**
 * Formats the archived label shown beside a post title.
 *
 * Kept to PHP 7.4 syntax: the self-test lints this fixture on 7.4.
 */
final class Label
{
    private string $text;

    public function __construct(string $text = 'Archived')
    {
        $this->text = $text;
    }

    public function forTitle(string $title, bool $archived): string
    {
        if (!$archived) {
            return $title;
        }

        return sprintf('%s: %s', $this->text, $title);
    }
}
