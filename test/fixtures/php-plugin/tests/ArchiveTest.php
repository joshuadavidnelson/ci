<?php

declare(strict_types=1);

namespace CiFixture\Tests;

use CiFixture\Archive;
use PHPUnit\Framework\TestCase;

final class ArchiveTest extends TestCase
{
    public function testAddsAndRemovesPosts(): void
    {
        $archive = new Archive();
        $archive->add(3);

        self::assertTrue($archive->has(3));
        self::assertSame(1, $archive->count());

        $archive->remove(3);

        self::assertFalse($archive->has(3));
    }

    public function testRejectsNonPositiveIds(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        (new Archive())->add(0);
    }
}
