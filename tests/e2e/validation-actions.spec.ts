import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import { runValidation, type ValidationAction } from '../../packages/validation/src/index.js';

test('replays a declarative interaction and perceptually matches both checkpoints', async ({
  page,
}) => {
  const baselineDirectory = await mkdtemp(join(tmpdir(), 'webmirror-action-baseline-'));
  const comparisonDirectory = await mkdtemp(join(tmpdir(), 'webmirror-action-comparison-'));
  const actions: ValidationAction[] = [
    {
      id: 'run-interaction',
      type: 'click',
      selector: '#action-button',
      label: 'Run interaction',
    },
  ];

  try {
    const baseline = await runValidation({
      entryUrl: 'http://127.0.0.1:4178/basic/',
      outputDirectory: baselineDirectory,
      viewport: {
        width: 960,
        height: 640,
        deviceScaleFactor: 1,
      },
      settleTimeMs: 25,
      actionSettleTimeMs: 25,
      timeoutMs: 30_000,
      actions,
    });
    const [initialPath, actionPath] = baseline.artifacts.interactionScreenshots ?? [];

    expect(initialPath).toBeTruthy();
    expect(actionPath).toBeTruthy();

    if (!initialPath || !actionPath) {
      throw new Error('The baseline run did not create both interaction checkpoints.');
    }

    const comparison = await runValidation({
      entryUrl: 'http://127.0.0.1:4178/basic/',
      outputDirectory: comparisonDirectory,
      viewport: {
        width: 960,
        height: 640,
        deviceScaleFactor: 1,
      },
      settleTimeMs: 25,
      actionSettleTimeMs: 25,
      timeoutMs: 30_000,
      actions,
      visualReferences: {
        initial: await readFile(join(baselineDirectory, initialPath)),
        'run-interaction': await readFile(join(baselineDirectory, actionPath)),
      },
      perceptual: {
        threshold: 0.15,
        maxDifferenceRatio: 0.005,
        partialDifferenceRatio: 0.05,
      },
    });

    expect(comparison.status).toBe('complete');
    expect(comparison.checks.interactions).toMatchObject({
      checked: true,
      passed: true,
      attempted: 1,
      completed: 1,
    });
    expect(comparison.checks.perceptual).toMatchObject({
      checked: true,
      passed: true,
      compared: 2,
      matched: 2,
    });
    expect(comparison.checks.remoteDependencies.dependencies).toEqual([]);
    expect(comparison.checks.diagnostics).toMatchObject({
      passed: true,
      truncated: false,
      droppedEvents: 0,
    });
    expect(comparison.artifacts.perceptualDiffs).toHaveLength(2);
    await expect(
      stat(join(comparisonDirectory, comparison.artifacts.validationJson)),
    ).resolves.toBeDefined();
    const report = await readFile(
      join(comparisonDirectory, comparison.artifacts.reportHtml),
      'utf8',
    );
    expect(report).toContain('Run interaction');
    expect(report).toContain('100.00% similarity');
    await page.goto(pathToFileURL(join(comparisonDirectory, comparison.artifacts.reportHtml)).href);
    await expect(page.getByRole('heading', { name: 'WebMirror validation' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Scripted interactions' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Checkpoint evidence' })).toBeVisible();
    expect(await page.locator('.evidence-grid img').count()).toBe(6);
    const renderedReport = await page.screenshot({
      fullPage: true,
      animations: 'disabled',
    });
    expect(renderedReport.byteLength).toBeGreaterThan(10_000);
  } finally {
    await rm(baselineDirectory, { recursive: true, force: true });
    await rm(comparisonDirectory, { recursive: true, force: true });
  }
});
