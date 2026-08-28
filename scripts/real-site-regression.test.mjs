import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  collectRegressionDiagnostics,
  navigateSourcePage,
  persistRegressionResult,
  waitForTerminalJob,
} from './real-site-regression.mjs';

describe('real-site regression diagnostics', () => {
  const directories = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function createDirectory() {
    const directory = await mkdtemp(join(tmpdir(), 'webmirror-real-site-regression-'));
    directories.push(directory);
    return directory;
  }

  it('discovers failed Helper artifacts when the extension job has no result', async () => {
    const directory = await createDirectory();
    const outputRoot = join(directory, 'mirror-output');
    const outputDirectory = join(outputRoot, 'example.test-20260805T010203Z-job');
    const manifestPath = join(outputDirectory, 'mirror.json');
    const validationPath = join(outputDirectory, 'validation.json');
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      manifestPath,
      `${JSON.stringify({ status: 'failed', warnings: ['Invalid preview route'] })}\n`,
      'utf8',
    );
    await writeFile(
      validationPath,
      `${JSON.stringify({ status: 'failed', errors: ['Entry script could not load'] })}\n`,
      'utf8',
    );

    const diagnostics = await collectRegressionDiagnostics(
      {
        state: 'failed',
        message: 'The mirror job failed.',
        error: 'Invalid preview route',
      },
      outputRoot,
    );

    expect(diagnostics).toMatchObject({
      artifacts: {
        outputDirectory,
        manifestPath,
        validationPath,
      },
      mirrorManifest: {
        status: 'failed',
      },
      validation: {
        status: 'failed',
      },
      errors: [],
    });
  });

  it('always writes result.json with the actual job failure and recovered paths', async () => {
    const directory = await createDirectory();
    const outputRoot = join(directory, 'mirror-output');
    const outputDirectory = join(outputRoot, 'example.test-20260805T010203Z-job');
    const manifestPath = join(outputDirectory, 'mirror.json');
    const summaryPath = join(directory, 'result.json');
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      manifestPath,
      `${JSON.stringify({ status: 'failed', warnings: ['Invalid preview route'] })}\n`,
      'utf8',
    );
    const summary = {
      targetUrl: 'https://example.test/',
      job: {
        state: 'failed',
        message: 'The mirror job failed.',
        error: 'Invalid preview route',
      },
    };

    const persisted = await persistRegressionResult({
      summary,
      summaryPath,
      outputRoot,
      runnerError: new Error('The mirror job completed without a local preview entry URL.'),
      now: () => new Date('2026-08-05T01:02:03.000Z'),
    });
    const saved = JSON.parse(await readFile(summaryPath, 'utf8'));

    expect(persisted).toMatchObject({
      error: 'Invalid preview route',
      regressionPassed: false,
      finishedAt: '2026-08-05T01:02:03.000Z',
      artifacts: {
        outputDirectory,
        manifestPath,
      },
      failure: {
        primaryError: 'Invalid preview route',
        jobError: 'Invalid preview route',
        manifestStatus: 'failed',
      },
    });
    expect(persisted.failure.runnerError).toContain(
      'The mirror job completed without a local preview entry URL.',
    );
    expect(saved).toEqual(persisted);
  });

  it('still persists a runner failure when no Helper output exists', async () => {
    const directory = await createDirectory();
    const outputRoot = join(directory, 'mirror-output');
    const summaryPath = join(directory, 'result.json');
    await mkdir(outputRoot, { recursive: true });

    const persisted = await persistRegressionResult({
      summary: { targetUrl: 'https://example.test/' },
      summaryPath,
      outputRoot,
      runnerError: new Error('Native Host handshake failed: unavailable'),
      now: () => new Date('2026-08-05T02:03:04.000Z'),
    });

    expect(persisted).toMatchObject({
      error: 'Native Host handshake failed: unavailable',
      regressionPassed: false,
      failure: {
        primaryError: 'Native Host handshake failed: unavailable',
      },
    });
    await expect(readFile(summaryPath, 'utf8')).resolves.toContain(
      'Native Host handshake failed: unavailable',
    );
  });

  it('retries bounded transient source navigation failures', async () => {
    const calls = [];
    let targetAttempts = 0;
    const page = {
      goto: async (url, options) => {
        calls.push({ url, options });

        if (url === 'https://example.test/' && targetAttempts++ === 0) {
          throw new Error('page.goto: net::ERR_CONNECTION_CLOSED');
        }
      },
    };
    const waits = [];

    await navigateSourcePage(page, 'https://example.test/', {
      attempts: 3,
      retryDelayMs: 25,
      sleep: async (milliseconds) => waits.push(milliseconds),
    });

    expect(calls.map((call) => call.url)).toEqual([
      'https://example.test/',
      'about:blank',
      'https://example.test/',
    ]);
    expect(waits).toEqual([25]);
  });

  it('does not retry non-transient source navigation failures', async () => {
    const page = {
      goto: async () => {
        throw new Error('page.goto: net::ERR_CERT_AUTHORITY_INVALID');
      },
    };

    await expect(
      navigateSourcePage(page, 'https://example.test/', {
        attempts: 3,
        retryDelayMs: 25,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow('ERR_CERT_AUTHORITY_INVALID');
  });

  it('performs a final authoritative query after the wall-clock deadline', async () => {
    let now = 0;
    const worker = {
      evaluate: async () => ({ state: 'fast_validating' }),
    };
    const extensionPage = {
      evaluate: async () => ({ ok: true, job: { state: 'partial', result: { entryUrl: 'x' } } }),
    };

    const job = await waitForTerminalJob(worker, extensionPage, 'job-1', 10_000, {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });

    expect(job).toMatchObject({ state: 'partial' });
  });

  it('grants a bounded finalization window when validation is already running', async () => {
    let now = 0;
    let authoritativeReads = 0;
    const worker = {
      evaluate: async () => ({ state: 'fast_validating' }),
    };
    const extensionPage = {
      evaluate: async () => {
        authoritativeReads += 1;
        return {
          ok: true,
          job:
            authoritativeReads < 3
              ? { state: 'fast_validating' }
              : { state: 'complete', result: { entryUrl: 'x' } },
        };
      },
    };

    const job = await waitForTerminalJob(worker, extensionPage, 'job-2', 10_000, {
      now: () => now,
      graceMs: 2_000,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });

    expect(job).toMatchObject({ state: 'complete' });
    expect(now).toBeGreaterThanOrEqual(10_500);
  });
});
