import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, expect, test, type BrowserContext, type Worker } from '@playwright/test';

import type { CaptureManifest } from '../../packages/capture/src/types.js';
import { toNativeCapture } from '../../apps/extension/src/capture-to-native.js';
import type { ExtensionJobRecord, JobStartResponse } from '../../apps/extension/src/job-types.js';

const extensionPath = resolve('apps/extension/dist');
const packagedHelperDirectory = resolve('packaging/windows/dist');
const packagedHelper = join(packagedHelperDirectory, 'webmirror-helper.exe');

interface NativeHostRegistrations {
  Chrome: string | null;
  Edge: string | null;
}

function runPowerShell(script: string, args: readonly string[]): void {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(script), ...args],
    {
      cwd: resolve('.'),
      encoding: 'utf8',
      windowsHide: true,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `${script} failed with ${String(result.status)}\n${result.stdout}\n${result.stderr}`,
    );
  }
}

function runPowerShellCommand(command: string): string {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    cwd: resolve('.'),
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error(
      `PowerShell command failed with ${String(result.status)}\n${result.stdout}\n${result.stderr}`,
    );
  }

  return result.stdout.trim();
}

function nativeHostRegistrations(): NativeHostRegistrations {
  const commonScript = powerShellLiteral(resolve('scripts/windows/common.ps1'));
  const command = [
    `. '${commonScript}'`,
    '$result = [ordered]@{}',
    "foreach ($browser in @('Chrome', 'Edge')) {",
    '  $values = @()',
    '  foreach ($view in @(Get-WebMirrorRegistryViews)) {',
    '    $value = Get-WebMirrorNativeHostRegistration -Browser $browser -View $view',
    '    if (-not [string]::IsNullOrWhiteSpace([string] $value)) {',
    '      $values += [string] $value',
    '    }',
    '  }',
    '  $uniqueValues = @($values | Sort-Object -Unique)',
    '  if ($uniqueValues.Count -gt 1) {',
    '    throw "Native Host registry views disagree for $browser."',
    '  }',
    '  $result[$browser] = if ($uniqueValues.Count -eq 1) { $uniqueValues[0] } else { $null }',
    '}',
    '$result | ConvertTo-Json -Compress',
  ].join('\n');
  const parsed = JSON.parse(runPowerShellCommand(command)) as Partial<NativeHostRegistrations>;

  return {
    Chrome: typeof parsed.Chrome === 'string' ? parsed.Chrome : null,
    Edge: typeof parsed.Edge === 'string' ? parsed.Edge : null,
  };
}

function sameRegistration(left: string | null, right: string | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function restoreNativeHostRegistrations(snapshot: NativeHostRegistrations): void {
  const commonScript = powerShellLiteral(resolve('scripts/windows/common.ps1'));

  for (const browser of ['Chrome', 'Edge'] as const) {
    const manifestPath = snapshot[browser];

    if (!manifestPath) {
      continue;
    }

    const command = [
      `. '${commonScript}'`,
      `Set-WebMirrorNativeHostRegistration -Browser '${browser}' -ManifestPath '${powerShellLiteral(manifestPath)}' | Out-Null`,
    ].join('\n');
    runPowerShellCommand(command);
  }

  const restored = nativeHostRegistrations();

  for (const browser of ['Chrome', 'Edge'] as const) {
    if (!sameRegistration(snapshot[browser], restored[browser])) {
      throw new Error(`The ${browser} Native Host registration was not restored after E2E.`);
    }
  }
}

function installedHelperProcessCount(executablePath: string): number {
  const commonScript = resolve('scripts/windows/common.ps1').replaceAll("'", "''");
  const target = executablePath.replaceAll("'", "''");
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `. '${commonScript}'; @(Get-WebMirrorRunningHostProcesses -ExecutablePath '${target}').Count`,
    ],
    {
      cwd: resolve('.'),
      encoding: 'utf8',
      windowsHide: true,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `Helper process check failed with ${String(result.status)}\n${result.stdout}\n${result.stderr}`,
    );
  }

  const count = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Helper process check returned an invalid count: ${result.stdout}`);
  }

  return count;
}

function powerShellLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function visibleExplorerWindowCount(directoryPath: string): number {
  const target = powerShellLiteral(resolve(directoryPath));
  const command = [
    `$target = '${target}'`,
    '$shell = New-Object -ComObject Shell.Application',
    '$count = 0',
    'foreach ($window in @($shell.Windows())) {',
    '  try {',
    '    $path = [string] $window.Document.Folder.Self.Path',
    '    if ($window.Visible -and $path.Equals($target, [System.StringComparison]::OrdinalIgnoreCase)) {',
    '      $count += 1',
    '    }',
    '  } catch {}',
    '}',
    'Write-Output $count',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    cwd: resolve('.'),
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error(
      `Explorer window check failed with ${String(result.status)}\n${result.stdout}\n${result.stderr}`,
    );
  }

  const count = Number.parseInt(result.stdout.trim(), 10);

  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Explorer window check returned an invalid count: ${result.stdout}`);
  }

  return count;
}

function closeExplorerWindows(directoryPath: string): void {
  const target = powerShellLiteral(resolve(directoryPath));
  const command = [
    `$target = '${target}'`,
    '$shell = New-Object -ComObject Shell.Application',
    'foreach ($window in @($shell.Windows())) {',
    '  try {',
    '    $path = [string] $window.Document.Folder.Self.Path',
    '    if ($path.Equals($target, [System.StringComparison]::OrdinalIgnoreCase)) {',
    '      $window.Quit()',
    '    }',
    '  } catch {}',
    '}',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    cwd: resolve('.'),
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error(
      `Explorer window cleanup failed with ${String(result.status)}\n${result.stdout}\n${result.stderr}`,
    );
  }
}

async function extensionWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? context.waitForEvent('serviceworker');
}

async function launchExtensionContext(
  outputRoot: string,
): Promise<{ context: BrowserContext; worker: Worker; extensionId: string }> {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: '0',
      WEBMIRROR_ALLOW_PRIVATE_NETWORK_FOR_TESTS: '1',
      WEBMIRROR_OUTPUT_ROOT: outputRoot,
      WEBMIRROR_CACHE_ROOT: join(outputRoot, '.cache-v1'),
    },
  });
  const worker = await extensionWorker(context);
  return {
    context,
    worker,
    extensionId: new URL(worker.url()).host,
  };
}

test('runs the installed Native Host from the extension through a complete mirror job', async ({
  browserName,
  request,
}, testInfo) => {
  test.skip(process.platform !== 'win32', 'The MVP Native Host installer targets Windows.');
  test.skip(browserName !== 'chromium', 'The extension test requires Chromium.');
  expect(
    existsSync(packagedHelper),
    'The Windows Native Host package must be rebuilt before this release E2E.',
  ).toBe(true);

  const outputRoot = await mkdtemp(join(tmpdir(), 'webmirror-extension-output-'));
  const installDirectory = await mkdtemp(join(tmpdir(), 'webmirror-native-install-'));
  let discoveryContext: BrowserContext | undefined;
  let context: BrowserContext | undefined;
  let installed = false;
  let openedOutputDirectory: string | undefined;
  let registrationSnapshot: NativeHostRegistrations | undefined;

  try {
    registrationSnapshot = nativeHostRegistrations();
    const discovery = await launchExtensionContext(outputRoot);
    discoveryContext = discovery.context;
    const extensionId = discovery.extensionId;
    await discoveryContext.close();
    discoveryContext = undefined;

    runPowerShell('scripts/windows/install-native-host.ps1', [
      '-ChromeExtensionId',
      extensionId,
      '-EdgeExtensionId',
      extensionId,
      '-SourceDirectory',
      packagedHelperDirectory,
      '-InstallDirectory',
      installDirectory,
    ]);
    installed = true;
    const installedHelper = join(installDirectory, 'webmirror-helper.exe');

    const launched = await launchExtensionContext(outputRoot);
    context = launched.context;
    const worker = launched.worker;
    const targetPage = await context.newPage();
    const protectedFixtureId = randomUUID();
    await targetPage.goto(
      `http://127.0.0.1:4178/protected/?id=${encodeURIComponent(protectedFixtureId)}`,
    );
    await expect(targetPage).toHaveTitle('WebMirror Protected Fixture');
    await targetPage.bringToFront();

    const targetTabId = await worker.evaluate(async (): Promise<number> => {
      await chrome.storage.local.clear();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab?.id) {
        throw new Error('The active fixture tab does not expose an id.');
      }

      return tab.id;
    });
    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${launched.extensionId}/popup.html`);
    await targetPage.bringToFront();
    const start = await extensionPage.evaluate(
      async (tabId): Promise<JobStartResponse> =>
        chrome.runtime.sendMessage({
          type: 'webmirror.job.start',
          tabId,
        }),
      targetTabId,
    );

    expect(start.ok, start.error ?? 'The extension rejected the mirror job.').toBe(true);
    expect(start.jobId).toEqual(expect.any(String));
    const jobId = start.jobId;

    if (!jobId) {
      throw new Error('The extension did not return a job id.');
    }

    await expect
      .poll(
        () =>
          worker.evaluate(async (id): Promise<ExtensionJobRecord | undefined> => {
            const stored = await chrome.storage.local.get(`job:${id}`);
            return stored[`job:${id}`] as ExtensionJobRecord | undefined;
          }, jobId),
        {
          timeout: 90_000,
          message: 'waiting for the installed Native Host mirror result',
        },
      )
      .toMatchObject({
        state: 'complete',
        result: {
          status: 'complete',
          downloadedResources: 2,
          failedResources: 0,
          completenessScore: 100,
          entryUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\//),
        },
      });

    const job = await worker.evaluate(async (id): Promise<ExtensionJobRecord> => {
      const stored = await chrome.storage.local.get(`job:${id}`);
      return stored[`job:${id}`] as ExtensionJobRecord;
    }, jobId);
    const storedCapture = await worker.evaluate(async (id): Promise<unknown> => {
      const stored = await chrome.storage.local.get(`capture:${id}`);
      return stored[`capture:${id}`];
    }, jobId);
    expect(JSON.stringify(storedCapture)).not.toContain('webmirror_fixture');
    expect(JSON.stringify(job)).not.toContain('webmirror_fixture');
    const mirrorManifestText = await readFile(job.result?.manifestPath ?? '', 'utf8');
    expect(mirrorManifestText).not.toContain('webmirror_fixture');
    const mirrorManifest = JSON.parse(mirrorManifestText) as {
      resources: Array<{
        sourceUrl: string;
        bodySource?: string;
      }>;
    };
    expect(
      mirrorManifest.resources.find((resource) =>
        resource.sourceUrl.includes('/protected/private.js'),
      ),
    ).toMatchObject({
      bodySource: 'browser',
    });
    const localPage = await context.newPage();
    await localPage.goto(job.result?.entryUrl ?? '');
    await expect(localPage).toHaveTitle('WebMirror Protected Fixture');
    await expect(localPage.locator('#message')).toHaveText(
      'Protected JavaScript executed from the captured browser response.',
    );
    const protectedStats = await request
      .get(`http://127.0.0.1:4178/protected/stats?id=${encodeURIComponent(protectedFixtureId)}`)
      .then((response) => response.json());
    expect(protectedStats).toMatchObject({
      unauthorized: 0,
    });
    expect(Number(protectedStats.authorized)).toBeGreaterThanOrEqual(2);

    await extensionPage.reload();
    await expect(extensionPage.locator('#result-title')).toHaveText('Mirror complete');
    await expect(extensionPage.locator('#score-value')).toHaveText('100');
    const outputDirectory = job.result?.outputDirectory;

    if (!outputDirectory) {
      throw new Error('The completed job does not expose an output directory.');
    }

    const launchScript = await readFile(join(outputDirectory, 'launch.cmd'), 'utf8');
    expect(launchScript).toContain(`"${installedHelper}" --serve "%~dp0" --open`);
    openedOutputDirectory = outputDirectory;
    expect(visibleExplorerWindowCount(outputDirectory)).toBe(0);
    await extensionPage.locator('#open-folder-button').click();
    await expect
      .poll(() => visibleExplorerWindowCount(outputDirectory), {
        timeout: 10_000,
        message: 'waiting for Open folder to show a visible Explorer window',
      })
      .toBeGreaterThan(0);
    closeExplorerWindows(outputDirectory);
    openedOutputDirectory = undefined;
    await extensionPage.locator('#revalidate-button').click();
    await expect(extensionPage.locator('#notice')).toHaveText('Validation completed.');
    await expect(extensionPage.locator('#result-title')).toHaveText('Mirror complete');
    await extensionPage.screenshot({
      path: testInfo.outputPath('webmirror-extension-result.png'),
    });
    await context.close();
    context = undefined;
    await expect
      .poll(() => installedHelperProcessCount(installedHelper), {
        timeout: 15_000,
        message: 'waiting for the browser-launched Native Host to exit',
      })
      .toBe(0);
    await writeFile(
      join(
        installDirectory,
        'browsers',
        'chromium-headless-shell',
        'chrome-headless-shell-win64',
        'debug.log',
      ),
      'Chromium Headless Shell runtime log created after installation.\n',
      'utf8',
    );
    runPowerShell('scripts/windows/diagnose-native-host.ps1', [
      '-InstallDirectory',
      installDirectory,
    ]);
    await expect
      .poll(() => installedHelperProcessCount(installedHelper), {
        timeout: 15_000,
        message: 'waiting for diagnostic Native Host processes to exit',
      })
      .toBe(0);
  } finally {
    if (openedOutputDirectory) {
      closeExplorerWindows(openedOutputDirectory);
    }

    await discoveryContext?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);

    try {
      if (installed) {
        runPowerShell('scripts/windows/uninstall-native-host.ps1', [
          '-InstallDirectory',
          installDirectory,
        ]);
      }
    } finally {
      try {
        if (registrationSnapshot) {
          restoreNativeHostRegistrations(registrationSnapshot);
        }
      } finally {
        await rm(outputRoot, { recursive: true, force: true });
        await rm(installDirectory, { recursive: true, force: true });
      }
    }
  }
});

test('captures runtime-composed module Workers through the installed extension', async ({
  browserName,
}) => {
  test.setTimeout(150_000);
  test.skip(process.platform !== 'win32', 'The MVP Native Host installer targets Windows.');
  test.skip(browserName !== 'chromium', 'The extension test requires Chromium.');
  expect(
    existsSync(packagedHelper),
    'The Windows Native Host package must be rebuilt before this release E2E.',
  ).toBe(true);

  const outputRoot = await mkdtemp(join(tmpdir(), 'webmirror-extension-runtime-output-'));
  const installDirectory = await mkdtemp(join(tmpdir(), 'webmirror-native-runtime-install-'));
  let discoveryContext: BrowserContext | undefined;
  let context: BrowserContext | undefined;
  let installed = false;
  let registrationSnapshot: NativeHostRegistrations | undefined;

  try {
    registrationSnapshot = nativeHostRegistrations();
    const discovery = await launchExtensionContext(outputRoot);
    discoveryContext = discovery.context;
    const extensionId = discovery.extensionId;
    await discoveryContext.close();
    discoveryContext = undefined;

    runPowerShell('scripts/windows/install-native-host.ps1', [
      '-ChromeExtensionId',
      extensionId,
      '-EdgeExtensionId',
      extensionId,
      '-SourceDirectory',
      packagedHelperDirectory,
      '-InstallDirectory',
      installDirectory,
    ]);
    installed = true;
    const installedHelper = join(installDirectory, 'webmirror-helper.exe');

    const launched = await launchExtensionContext(outputRoot);
    context = launched.context;
    const worker = launched.worker;
    const targetPage = await context.newPage();
    await targetPage.goto('http://127.0.0.1:4178/runtime-composed/');
    await expect(targetPage.locator('#status')).toHaveText('runtime composed complete');
    await targetPage.bringToFront();

    const targetTabId = await worker.evaluate(async (): Promise<number> => {
      await chrome.storage.local.clear();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab?.id) {
        throw new Error('The active fixture tab does not expose an id.');
      }

      return tab.id;
    });
    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${launched.extensionId}/popup.html`);
    await targetPage.bringToFront();
    const start = await extensionPage.evaluate(
      async (tabId): Promise<JobStartResponse> =>
        chrome.runtime.sendMessage({
          type: 'webmirror.job.start',
          tabId,
        }),
      targetTabId,
    );

    expect(start.ok, start.error ?? 'The extension rejected the mirror job.').toBe(true);

    if (!start.jobId) {
      throw new Error('The extension did not return a job id.');
    }

    await expect
      .poll(
        () =>
          worker.evaluate(async (jobId): Promise<ExtensionJobRecord | undefined> => {
            const stored = await chrome.storage.local.get(`job:${jobId}`);
            return stored[`job:${jobId}`] as ExtensionJobRecord | undefined;
          }, start.jobId),
        {
          timeout: 90_000,
          message: 'waiting for the runtime-composed mirror terminal state',
        },
      )
      .toMatchObject({
        state: expect.stringMatching(/^(complete|partial|failed|cancelled)$/),
      });

    const [job, capture] = await Promise.all([
      worker.evaluate(async (jobId): Promise<ExtensionJobRecord> => {
        const stored = await chrome.storage.local.get(`job:${jobId}`);
        return stored[`job:${jobId}`] as ExtensionJobRecord;
      }, start.jobId),
      worker.evaluate(async (jobId): Promise<unknown> => {
        const stored = await chrome.storage.local.get(`capture:${jobId}`);
        return stored[`capture:${jobId}`];
      }, start.jobId),
    ]);
    const capturedResources = (
      capture as {
        resources?: Array<{
          request?: {
            url?: string;
            workerContext?: boolean;
          };
        }>;
      }
    ).resources;
    const nativeCapturedResources = toNativeCapture(capture as CaptureManifest).resources;

    if (!job.result?.validationPath) {
      throw new Error(
        `The runtime-composed mirror reached ${job.state} without validation output: ${job.error ?? job.message}`,
      );
    }

    const validation = JSON.parse(await readFile(job.result.validationPath, 'utf8')) as {
      status: string;
      score: number;
      errors: string[];
      warnings: string[];
      checks: {
        runtime: {
          pageErrors: Array<{ message: string; stack?: string }>;
          blockingConsoleErrors: Array<{ text: string; url?: string }>;
        };
        remoteDependencies: {
          dependencies: Array<{ url: string; reason: string; resourceType: string }>;
        };
      };
    };
    const manifestForDiagnostics = JSON.parse(await readFile(job.result.manifestPath, 'utf8')) as {
      resources: Array<{
        sourceUrl: string;
        localPath?: string;
        status: string;
        workerContext?: boolean;
        rewritten?: boolean;
      }>;
    };

    const runtimeComposedDiagnostics = {
      state: job.state,
      result: job.result,
      capturedResources: capturedResources?.map((resource) => ({
        url: resource.request?.url,
        workerContext: resource.request?.workerContext === true,
      })),
      nativeCapturedResources: nativeCapturedResources.map((resource) => ({
        sourceUrl: resource.sourceUrl,
        workerContext: resource.workerContext === true,
      })),
      mirroredResources: manifestForDiagnostics.resources.map((resource) => ({
        sourceUrl: resource.sourceUrl,
        localPath: resource.localPath,
        status: resource.status,
        workerContext: resource.workerContext === true,
        rewritten: resource.rewritten === true,
      })),
      validation: {
        status: validation.status,
        score: validation.score,
        errors: validation.errors,
        warnings: validation.warnings,
        pageErrors: validation.checks.runtime.pageErrors,
        blockingConsoleErrors: validation.checks.runtime.blockingConsoleErrors,
        remoteDependencies: validation.checks.remoteDependencies.dependencies,
      },
    };

    const runtimeComposedComplete =
      job.state === 'complete' &&
      job.result.status === 'complete' &&
      job.result.failedResources === 0 &&
      job.result.completenessScore === 100 &&
      /^http:\/\/127\.0\.0\.1:\d+\//.test(job.result.entryUrl ?? '');

    if (!runtimeComposedComplete) {
      const debugPage = await context.newPage();
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      const requestedUrls: string[] = [];
      debugPage.on('pageerror', (error) => pageErrors.push(error.message));
      debugPage.on('console', (message) => {
        if (message.type() === 'error') {
          consoleErrors.push(message.text());
        }
      });
      debugPage.on('request', (request) => requestedUrls.push(request.url()));

      let directReplay: {
        status: string | null;
        pageErrors: string[];
        consoleErrors: string[];
        requestedUrls: string[];
      };

      try {
        await debugPage.goto(job.result.entryUrl ?? '', { waitUntil: 'load' });
        await debugPage.waitForTimeout(1_000);
        directReplay = {
          status: await debugPage.locator('#status').textContent(),
          pageErrors,
          consoleErrors,
          requestedUrls,
        };
      } finally {
        await debugPage.close();
      }

      await test.info().attach('runtime-composed-diagnostics.json', {
        body: JSON.stringify({ ...runtimeComposedDiagnostics, directReplay }, null, 2),
        contentType: 'application/json',
      });
      throw new Error(
        `The installed-extension runtime-composed mirror must complete without replay errors.\n${JSON.stringify(
          { ...runtimeComposedDiagnostics, directReplay },
          null,
          2,
        )}`,
      );
    }

    for (const filename of ['module-worker.js', 'worker-module.js', 'nested-worker.js']) {
      expect(
        capturedResources?.some(
          (resource) =>
            resource.request?.url?.endsWith(`/runtime-composed/${filename}`) &&
            resource.request.workerContext === true,
        ),
      ).toBe(true);
    }

    const mirrorManifest = JSON.parse(await readFile(job.result?.manifestPath ?? '', 'utf8')) as {
      resources: Array<{
        sourceUrl: string;
        status: string;
        workerContext?: boolean;
      }>;
    };

    for (const filename of ['module-worker.js', 'worker-module.js', 'nested-worker.js']) {
      expect(
        mirrorManifest.resources.find((resource) =>
          resource.sourceUrl.endsWith(`/runtime-composed/${filename}`),
        ),
      ).toMatchObject({
        status: 'downloaded',
        workerContext: true,
      });
    }

    const entryUrl = job.result?.entryUrl;

    if (!entryUrl) {
      throw new Error('The runtime-composed job does not expose a preview entry URL.');
    }

    const previewPage = await context.newPage();
    const previewOrigin = new URL(entryUrl).origin;
    const unexpectedRequests: string[] = [];
    await previewPage.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin !== previewOrigin) {
        unexpectedRequests.push(route.request().url());
        await route.abort();
        return;
      }

      await route.continue();
    });
    await previewPage.goto(entryUrl);
    await expect(previewPage.locator('#status')).toHaveText('runtime composed complete');
    expect(unexpectedRequests).toEqual([]);
    await previewPage.close();

    await context.close();
    context = undefined;
    await expect
      .poll(() => installedHelperProcessCount(installedHelper), {
        timeout: 15_000,
        message: 'waiting for the browser-launched Native Host to exit',
      })
      .toBe(0);
  } finally {
    await discoveryContext?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);

    try {
      if (installed) {
        runPowerShell('scripts/windows/uninstall-native-host.ps1', [
          '-InstallDirectory',
          installDirectory,
        ]);
      }
    } finally {
      try {
        if (registrationSnapshot) {
          restoreNativeHostRegistrations(registrationSnapshot);
        }
      } finally {
        await rm(outputRoot, { recursive: true, force: true });
        await rm(installDirectory, { recursive: true, force: true });
      }
    }
  }
});
