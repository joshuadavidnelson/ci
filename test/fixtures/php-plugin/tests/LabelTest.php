<?php

declare(strict_types=1);

namespace CiFixture\Tests;

use CiFixture\Label;
use PHPUnit\Framework\TestCase;

final class LabelTest extends TestCase
{
    public function testPrefixesArchivedTitles(): void
    {
        self::assertSame('Archived: Hello', (new Label())->forTitle('Hello', true));
    }

    public function testLeavesOtherTitlesAlone(): void
    {
        self::assertSame('Hello', (new Label())->forTitle('Hello', false));
    }
}
