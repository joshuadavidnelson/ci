<?php

declare(strict_types=1);

namespace CiFixture;

/**
 * Formats the archived label shown beside a post title.
 */
final class Label
{
    public function __construct(private string $text = 'Archived')
    {
    }

    public function forTitle(string $title, bool $archived): string
    {
        if (!$archived) {
            return $title;
        }

        return sprintf('%s: %s', $this->text, $title);
    }
}
