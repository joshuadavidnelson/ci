<?php

declare(strict_types=1);

namespace CiFixture;

/**
 * A tiny archive of post IDs, enough to give every tool something to measure.
 */
final class Archive
{
    /**
     * @var array<int, true>
     */
    private array $ids = [];

    public function add(int $postId): void
    {
        if ($postId <= 0) {
            throw new \InvalidArgumentException('Post IDs are positive.');
        }

        $this->ids[$postId] = true;
    }

    public function remove(int $postId): void
    {
        unset($this->ids[$postId]);
    }

    public function has(int $postId): bool
    {
        return isset($this->ids[$postId]);
    }

    public function count(): int
    {
        return count($this->ids);
    }
}
