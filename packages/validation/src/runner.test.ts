import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';

import { renderValidationReport } from './report.js';
import { runValidation } from './runner.js';
import type { ValidationAction, ValidationResult } from './types.js';

interface FixtureServer {
  origin: string;
  server: Server;
}

const directories: string[] = [];
const servers: Server[] = [];

async function createOutputDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'webmirror-validation-'));
  directories.push(directory);
  return directory;
}

async function startFixtureServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<FixtureServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Fixture server did not expose a TCP address');
  }

  servers.push(server);
  return {
    origin: `http://127.0.0.1:${address.port}`,
    server,
  };
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
  });
  response.end(html);
}

function solidReferencePng(): Uint8Array {
  const image = new PNG({ width: 1, height: 1 });
  image.data.set([32, 64, 96, 255]);
  return PNG.sync.write(image);
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();

  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('runValidation', () => {
  it('writes complete atomic artifacts and treats pages without canvas as valid', async () => {
    const fixture = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        '<!doctype html><html><body><h1>Local fixture</h1><script>document.body.dataset.ready = "yes";</script></body></html>',
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      sourceUrl: 'https://source.invalid/original?token=secret',
      settleTimeMs: 25,
      timeoutMs: 15_000,
    });
    const written = JSON.parse(
      await readFile(join(outputDirectory, 'validation.json'), 'utf8'),
    ) as ValidationResult;
    const report = await readFile(join(outputDirectory, 'report.html'), 'utf8');
    const screenshot = await stat(
      join(outputDirectory, 'screenshots', 'validation-first-view.png'),
    );
    const outputFiles = await readdir(outputDirectory, { recursive: true });

    expect(result.status).toBe('complete');
    expect(result.score).toBe(100);
    expect(result.checks.canvas).toMatchObject({
      checked: true,
      present: false,
      passed: true,
    });
    expect(written).toEqual(result);
    expect(written.sourceUrl).not.toContain('secret');
    expect(report).toContain('WebMirror validation');
    expect(screenshot.size).toBeGreaterThan(0);
    expect(outputFiles.some((file) => file.endsWith('.tmp'))).toBe(false);

    const legacyResult = {
      ...result,
      checks: { ...result.checks },
    };
    delete legacyResult.checks.diagnostics;
    expect(renderValidationReport(legacyResult)).toContain(
      'Diagnostic budget metadata was not recorded',
    );
  }, 20_000);

  it('replays capability-conditioned resources with the capture WebGL profile', async () => {
    let localVariantRequests = 0;
    const fixture = await startFixtureServer((request, response) => {
      if (request.url === '/s3tc.bin' || request.url === '/fallback.bin') {
        localVariantRequests += 1;
        response.writeHead(204, {
          'cache-control': 'no-store',
        });
        response.end();
        return;
      }

      const html = `<!doctype html>
        <html>
          <body>
            <p>Capability-conditioned fixture</p>
            <script>
              const gl = document.createElement('canvas').getContext('webgl');
              const variant = gl?.getExtension('WEBGL_compressed_texture_astc')
                ? 'astc'
                : gl?.getExtension('WEBGL_compressed_texture_etc')
                  ? 'etc'
                  : gl?.getExtension('WEBGL_compressed_texture_s3tc')
                    ? 's3tc'
                    : 'fallback';
              const target =
                variant === 's3tc' || variant === 'fallback'
                  ? '/' + variant + '.bin'
                  : 'https://variants.example.invalid/' + variant + '.bin';
              fetch(target)
                .then(() => {
                  document.body.dataset.variant = variant;
                })
                .catch((error) => {
                  setTimeout(() => {
                    throw error;
                  });
                });
            </script>
          </body>
        </html>`;
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'content-security-policy':
          "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'",
      });
      response.end(html);
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      runtimeCapabilities: {
        webgl: { compressedTextureFamilies: ['s3tc'] },
        webgl2: { compressedTextureFamilies: ['s3tc'] },
      },
      settleTimeMs: 100,
      timeoutMs: 15_000,
    });

    expect(localVariantRequests).toBe(1);
    expect(result.status).toBe('complete');
    expect(result.checks.http.failures).toEqual([]);
    expect(result.checks.remoteDependencies.dependencies).toEqual([]);
    expect(result.checks.runtime.pageErrors).toEqual([]);
  }, 20_000);

  it('records local 404s and requests to the source origin as partial', async () => {
    const fixture = await startFixtureServer((request, response) => {
      if (request.url === '/missing.png') {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('missing');
        return;
      }

      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <img src="/missing.png" alt="">
              <script>
                addEventListener('load', () => {
                  const remote = new Image();
                  remote.src = 'https://source.invalid/pixel.png?token=secret';
                  document.body.append(remote);
                });
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      sourceUrl: 'https://source.invalid/original',
      settleTimeMs: 250,
      timeoutMs: 15_000,
    });
    const serialized = await readFile(join(outputDirectory, 'validation.json'), 'utf8');

    expect(result.status).toBe('partial');
    expect(result.checks.http.local404s).toHaveLength(1);
    expect(result.checks.runtime.blockingConsoleErrors).toHaveLength(0);
    expect(result.checks.remoteDependencies.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'source-origin',
          blocked: true,
        }),
      ]),
    );
    expect(serialized).not.toContain('token=secret');
  }, 20_000);

  it('ignores confirmed nonessential telemetry while retaining unknown remote dependencies', async () => {
    const fixture = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <script>
                addEventListener('load', () => {
                  const tracking = document.createElement('script');
                  tracking.src = 'https://sc-static.net/scevent.min.js';
                  document.head.append(tracking);

                  const application = document.createElement('script');
                  application.src = 'https://cdn.example.invalid/app.js';
                  document.head.append(application);

                  console.error(
                    "Loading the script 'https://sc-static.net/scevent.min.js' violates the Content Security Policy."
                  );
                  console.error(
                    "Loading the script 'https://cdn.example.invalid/app.js' violates the Content Security Policy."
                  );
                });
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 250,
      timeoutMs: 15_000,
    });

    expect(result.checks.remoteDependencies.dependencies).toHaveLength(1);
    expect(result.checks.remoteDependencies.dependencies[0]).toMatchObject({
      reason: 'unexpected-remote',
      resourceType: 'script',
    });
    expect(result.checks.runtime.consoleErrors.some((error) => !error.blocking)).toBe(true);
    expect(result.checks.runtime.blockingConsoleErrors.length).toBeGreaterThan(0);
    expect(result.status).toBe('failed');
  }, 20_000);

  it('ignores repeated reserved telemetry no-op requests for network quiet', async () => {
    const fixture = await startFixtureServer((request, response) => {
      if (request.url?.startsWith('/.webmirror/noop')) {
        response.writeHead(204, {
          'cache-control': 'no-store',
        });
        response.end();
        return;
      }

      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <h1>Ready</h1>
              <script>
                setInterval(() => {
                  fetch('/.webmirror/noop?source=telemetry').catch(() => undefined);
                }, 25);
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 250,
      timeoutMs: 15_000,
    });

    expect(result.status).toBe('complete');
    expect(
      result.warnings.some((warning) => warning.includes('Network activity did not become quiet')),
    ).toBe(false);
  }, 20_000);

  it('waits for a finite local resource chain beyond the old quiet deadline', async () => {
    const fixture = await startFixtureServer((request, response) => {
      if (request.url === '/late-model.bin') {
        setTimeout(() => {
          response.writeHead(200, {
            'content-type': 'application/octet-stream',
          });
          response.end('model');
        }, 1_700);
        return;
      }

      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <h1>Deferred model</h1>
              <script>
                addEventListener('load', () => {
                  fetch('/late-model.bin').catch(() => undefined);
                });
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 500,
      timeoutMs: 15_000,
    });

    expect(result.status).toBe('complete');
    expect(result.checks.http.failures).toHaveLength(0);
    expect(
      result.warnings.some((warning) => warning.includes('Network activity did not become quiet')),
    ).toBe(false);
  }, 20_000);

  it('reports the active request count when local network activity never finishes', async () => {
    const fixture = await startFixtureServer((request, response) => {
      if (request.url === '/never') {
        // The validation context closes this response after the bounded wait fails.
        return;
      }

      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <h1>Never quiet</h1>
              <script>
                addEventListener('load', () => {
                  fetch('/never').catch(() => undefined);
                });
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 100,
      timeoutMs: 15_000,
    });

    expect(result.status).toBe('partial');
    expect(result.warnings).toEqual([
      expect.stringMatching(
        /Network activity did not become quiet for 100 ms .* with 1 request\(s\) still active/u,
      ),
    ]);
  }, 20_000);

  it('treats delayed requests to another loopback origin as source dependencies', async () => {
    const source = await startFixtureServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
    const preview = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <script>
                setTimeout(() => {
                  const image = new Image();
                  image.src = '${source.origin}/late.png?token=secret';
                  document.body.append(image);
                }, 200);
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${preview.origin}/`,
      outputDirectory,
      sourceUrl: `${source.origin}/original`,
      settleTimeMs: 500,
      timeoutMs: 15_000,
    });
    const serialized = await readFile(join(outputDirectory, 'validation.json'), 'utf8');

    expect(result.status).toBe('partial');
    expect(result.checks.remoteDependencies.dependencies).toEqual([
      expect.objectContaining({
        reason: 'source-origin',
        blocked: true,
      }),
    ]);
    expect(serialized).not.toContain('token=secret');
  }, 20_000);

  it('marks uncaught page errors and blocking console errors as failed', async () => {
    const fixture = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <script>
                setTimeout(() => {
                  console.error('password=supersecret fatal <img src=x onerror=alert(1)>');
                  console.error('{"token":"json-secret"}');
                  throw new Error('fixture boom');
                }, 10);
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 100,
      timeoutMs: 15_000,
    });
    const report = await readFile(join(outputDirectory, 'report.html'), 'utf8');
    const serialized = await readFile(join(outputDirectory, 'validation.json'), 'utf8');

    expect(result.status).toBe('failed');
    expect(result.score).toBeLessThanOrEqual(59);
    expect(result.checks.runtime.pageErrors).toHaveLength(1);
    expect(result.checks.runtime.blockingConsoleErrors.length).toBeGreaterThanOrEqual(1);
    expect(report).toContain('Console error [fingerprint:');
    expect(report).not.toContain('password=supersecret');
    expect(report).not.toContain('json-secret');
    expect(report).not.toContain('fatal <img');
    expect(report).not.toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(serialized).not.toContain('supersecret');
  }, 20_000);

  it('retains recoverable React hydration errors as partial only after strict checks pass', async () => {
    const fixture = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <button id="continue" type="button">Continue</button>
              <output id="state">initial</output>
              <script>
                document.querySelector('#continue').addEventListener('click', () => {
                  document.querySelector('#state').textContent = 'continued';
                });
                setTimeout(() => {
                  console.error(
                    'Error: Minified React error #418; visit https://reactjs.org/docs/error-decoder.html?invariant=418'
                  );
                  throw new Error(
                    'Minified React error #423; visit https://reactjs.org/docs/error-decoder.html?invariant=423'
                  );
                }, 10);
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 100,
      timeoutMs: 15_000,
      actions: [
        {
          id: 'continue',
          type: 'click',
          selector: '#continue',
        },
      ],
    });

    expect(result.status).toBe('partial');
    expect(result.score).toBe(99);
    expect(result.checks.http.failures).toEqual([]);
    expect(result.checks.remoteDependencies.dependencies).toEqual([]);
    expect(result.checks.screenshot.passed).toBe(true);
    expect(result.checks.canvas.passed).toBe(true);
    expect(result.checks.interactions.passed).toBe(true);
    expect(result.checks.runtime.passed).toBe(true);
    expect(result.checks.runtime.blockingConsoleErrors).toEqual([]);
    expect(
      result.checks.runtime.consoleErrors.some(
        (error) => error.recoverableCandidate && !error.blocking,
      ),
    ).toBe(true);
    expect(result.checks.runtime.pageErrors.some((error) => error.recoverableCandidate)).toBe(true);
    expect(result.warnings.join(' ')).toContain('recoverable client-runtime');
    expect(result.errors).toEqual([]);
  }, 30_000);

  it('retains handled external integration initialization failures as warnings after strict checks pass', async () => {
    const fixture = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <button id="continue" type="button">Continue</button>
              <output id="state">initial</output>
              <script>
                document.querySelector('#continue').addEventListener('click', () => {
                  document.querySelector('#state').textContent = 'continued';
                });
                setTimeout(() => {
                  console.error('[EXTERNAL WIDGET] Error tracker initialization: Object');
                  console.error('[EXTERNAL WIDGET] Error: Unable to initialize tracker');
                }, 10);
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 100,
      timeoutMs: 15_000,
      actions: [
        {
          id: 'continue',
          type: 'click',
          selector: '#continue',
        },
      ],
    });

    expect(result.status).toBe('partial');
    expect(result.score).toBe(99);
    expect(result.checks.http.failures).toEqual([]);
    expect(result.checks.remoteDependencies.dependencies).toEqual([]);
    expect(result.checks.interactions.passed).toBe(true);
    expect(result.checks.runtime.passed).toBe(true);
    expect(result.checks.runtime.blockingConsoleErrors).toEqual([]);
    expect(
      result.checks.runtime.consoleErrors.filter(
        (error) => error.recoverableCandidate && !error.blocking,
      ),
    ).toHaveLength(2);
    expect(result.warnings.join(' ')).toContain('recoverable client-runtime');
    expect(result.errors).toEqual([]);
  }, 30_000);

  it('retains browser media playback interruption errors as partial only after strict checks pass', async () => {
    const fixture = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <button id="continue" type="button">Continue</button>
              <output id="state">initial</output>
              <script>
                document.querySelector('#continue').addEventListener('click', () => {
                  document.querySelector('#state').textContent = 'continued';
                });
                setTimeout(() => {
                  throw new Error(
                    'The play() request was interrupted by a call to pause(). https://goo.gl/LdLk22'
                  );
                }, 10);
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 100,
      timeoutMs: 15_000,
      actions: [
        {
          id: 'continue',
          type: 'click',
          selector: '#continue',
        },
      ],
    });

    expect(result.status).toBe('partial');
    expect(result.score).toBe(99);
    expect(result.checks.http.failures).toEqual([]);
    expect(result.checks.remoteDependencies.dependencies).toEqual([]);
    expect(result.checks.interactions.passed).toBe(true);
    expect(result.checks.runtime.passed).toBe(true);
    expect(result.checks.runtime.pageErrors).toEqual([
      expect.objectContaining({ recoverableCandidate: true }),
    ]);
    expect(result.warnings.join(' ')).toContain('recoverable client-runtime');
    expect(result.errors).toEqual([]);
  }, 30_000);

  it('keeps hydration candidates blocking when a local resource fails', async () => {
    const fixture = await startFixtureServer((request, response) => {
      if (request.url === '/missing.js') {
        response.writeHead(404, { 'content-type': 'application/javascript' });
        response.end('missing');
        return;
      }

      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <script src="/missing.js"></script>
              <script>
                setTimeout(() => {
                  throw new Error(
                    'Minified React error #418; visit https://reactjs.org/docs/error-decoder.html?invariant=418'
                  );
                }, 10);
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 100,
      timeoutMs: 15_000,
    });

    expect(result.status).toBe('failed');
    expect(result.checks.http.local404s).toHaveLength(1);
    expect(result.checks.runtime.pageErrors).toEqual([
      expect.objectContaining({ recoverableCandidate: true }),
    ]);
    expect(result.errors.join(' ')).toContain('uncaught page error');
    expect(result.warnings.join(' ')).not.toContain('recoverable client-runtime');
  }, 20_000);

  it('keeps media playback interruption candidates blocking when a local resource fails', async () => {
    const fixture = await startFixtureServer((request, response) => {
      if (request.url === '/missing.js') {
        response.writeHead(404, { 'content-type': 'application/javascript' });
        response.end('missing');
        return;
      }

      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <script src="/missing.js"></script>
              <script>
                setTimeout(() => {
                  throw new Error(
                    'The play() request was interrupted by a call to pause(). https://goo.gl/LdLk22'
                  );
                }, 10);
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 100,
      timeoutMs: 15_000,
    });

    expect(result.status).toBe('failed');
    expect(result.checks.http.local404s).toHaveLength(1);
    expect(result.checks.runtime.pageErrors).toEqual([
      expect.objectContaining({ recoverableCandidate: true }),
    ]);
    expect(result.errors.join(' ')).toContain('uncaught page error');
    expect(result.warnings.join(' ')).not.toContain('recoverable client-runtime');
  }, 20_000);

  it('deduplicates repeated hydration errors before applying diagnostic limits', async () => {
    const fixture = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <p>Hydration recovery fixture</p>
              <script>
                for (let index = 0; index < 128; index += 1) {
                  console.error(
                    'Error: Minified React error #418; visit https://reactjs.org/docs/error-decoder.html?invariant=418'
                  );
                }
                setTimeout(() => {
                  throw new Error(
                    'Minified React error #423; visit https://reactjs.org/docs/error-decoder.html?invariant=423'
                  );
                }, 10);
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 100,
      timeoutMs: 15_000,
    });

    expect(result.status).toBe('partial');
    expect(result.checks.runtime.consoleErrors).toHaveLength(1);
    expect(result.checks.runtime.pageErrors).toHaveLength(1);
    expect(result.checks.diagnostics?.truncated).toBe(false);
    expect(result.checks.diagnostics?.droppedEvents).toBe(0);
  }, 20_000);

  it('ignores only local preview sensor-policy and about:blank image CSP console errors', async () => {
    const fixture = await startFixtureServer((request, response) => {
      const errors =
        request.url === '/environment'
          ? [
              'Permissions policy violation: accelerometer is not allowed in this document.',
              "The 'deviceorientation' event is blocked by Permissions Policy.",
              "Refused to load the image 'about:blank' because it violates the following Content Security Policy directive: img-src 'self' data: blob:.",
            ]
          : [
              'Permissions policy violation: camera is not allowed in this document.',
              "Refused to load the image 'https://example.invalid/blocked.png' because it violates the following Content Security Policy directive: img-src 'self'.",
              'ordinary runtime console failure',
            ];
      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <script>
                for (const message of ${JSON.stringify(errors)}) {
                  console.error(message);
                }
              </script>
            </body>
          </html>`,
      );
    });
    const environmentOutput = await createOutputDirectory();
    const blockingOutput = await createOutputDirectory();
    const environment = await runValidation({
      entryUrl: `${fixture.origin}/environment`,
      outputDirectory: environmentOutput,
      settleTimeMs: 25,
      timeoutMs: 15_000,
    });
    const blocking = await runValidation({
      entryUrl: `${fixture.origin}/blocking`,
      outputDirectory: blockingOutput,
      settleTimeMs: 25,
      timeoutMs: 15_000,
    });

    expect(environment.status).toBe('complete');
    expect(environment.checks.runtime.consoleErrors).toHaveLength(3);
    expect(environment.checks.runtime.blockingConsoleErrors).toEqual([]);
    expect(environment.checks.runtime.passed).toBe(true);
    expect(blocking.status).toBe('failed');
    expect(blocking.checks.runtime.blockingConsoleErrors).toHaveLength(3);
    expect(blocking.checks.runtime.passed).toBe(false);
  }, 30_000);

  it('fails an entry document that contains undecoded binary data', async () => {
    const fixture = await startFixtureServer((_request, response) => {
      const binaryHtml = gzipSync(
        Buffer.from('<!doctype html><title>This should have been decoded</title>', 'utf8'),
      );
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': binaryHtml.byteLength,
      });
      response.end(binaryHtml);
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 25,
      timeoutMs: 15_000,
    });

    expect(result.status).toBe('failed');
    expect(result.entry).toMatchObject({
      ok: false,
      error: 'Entry document appears to contain undecoded or binary data',
    });
  }, 20_000);

  it('samples non-empty 2D and WebGL pixels and fails a confirmed blank canvas', async () => {
    const fixture = await startFixtureServer((request, response) => {
      if (request.url === '/blank') {
        sendHtml(
          response,
          `<!doctype html>
            <html>
              <body>
                <canvas width="64" height="64"></canvas>
                <script>
                  document.querySelectorAll = () => [];
                  HTMLCanvasElement.prototype.getContext = () => ({
                    getImageData: () => ({ data: new Uint8ClampedArray([255, 255, 255, 255]) }),
                  });
                </script>
              </body>
            </html>`,
        );
        return;
      }

      if (request.url === '/sparse') {
        sendHtml(
          response,
          `<!doctype html>
            <html>
              <body>
                <canvas width="64" height="64"></canvas>
                <script>
                  const context = document.querySelector('canvas').getContext('2d');
                  context.fillStyle = '#ffffff';
                  context.fillRect(31, 0, 2, 64);
                </script>
              </body>
            </html>`,
        );
        return;
      }

      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <canvas id="two-d" width="64" height="64"></canvas>
              <canvas id="webgl" width="64" height="64"></canvas>
              <script>
                const twoD = document.querySelector('#two-d').getContext('2d');
                twoD.fillStyle = '#d73535';
                twoD.fillRect(0, 0, 64, 64);
                const gl = document.querySelector('#webgl').getContext('webgl', { preserveDrawingBuffer: true });
                gl.clearColor(0.1, 0.7, 0.2, 1);
                gl.clear(gl.COLOR_BUFFER_BIT);
              </script>
            </body>
          </html>`,
      );
    });
    const drawnOutput = await createOutputDirectory();
    const blankOutput = await createOutputDirectory();
    const sparseOutput = await createOutputDirectory();
    const drawn = await runValidation({
      entryUrl: `${fixture.origin}/drawn`,
      outputDirectory: drawnOutput,
      settleTimeMs: 25,
      timeoutMs: 15_000,
    });
    const blank = await runValidation({
      entryUrl: `${fixture.origin}/blank`,
      outputDirectory: blankOutput,
      settleTimeMs: 25,
      timeoutMs: 15_000,
    });
    const sparse = await runValidation({
      entryUrl: `${fixture.origin}/sparse`,
      outputDirectory: sparseOutput,
      settleTimeMs: 25,
      timeoutMs: 15_000,
    });

    expect(drawn.status).toBe('complete');
    expect(drawn.checks.canvas.nonEmpty).toBe(2);
    expect(drawn.checks.canvas.details.every((detail) => detail.context === 'unknown')).toBe(true);
    expect(blank.status).toBe('failed');
    expect(blank.checks.canvas).toMatchObject({
      nonEmpty: 0,
      empty: 1,
      unreadable: 0,
    });
    expect(sparse.status).toBe('complete');
    expect(sparse.checks.canvas.nonEmpty).toBe(1);
  }, 30_000);

  it('waits within a bounded window for a delayed canvas draw', async () => {
    const fixture = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <canvas width="64" height="64"></canvas>
              <script>
                setTimeout(() => {
                  const context = document.querySelector('canvas').getContext('2d');
                  context.fillStyle = '#237a4b';
                  context.fillRect(0, 0, 64, 64);
                }, 200);
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 0,
      canvasSettleTimeoutMs: 1_000,
      timeoutMs: 15_000,
    });

    expect(result.status).toBe('complete');
    expect(result.checks.canvas.nonEmpty).toBe(1);
  }, 20_000);

  it('bounds Canvas evidence and reports omitted surfaces as partial', async () => {
    const fixture = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <script>
                for (let index = 0; index < 300; index += 1) {
                  const canvas = document.createElement('canvas');
                  canvas.width = 2;
                  canvas.height = 2;
                  const context = canvas.getContext('2d');
                  context.fillStyle = '#237a4b';
                  context.fillRect(0, 0, 2, 2);
                  document.body.append(canvas);
                }
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 0,
      timeoutMs: 15_000,
    });
    const serialized = await readFile(join(outputDirectory, 'validation.json'), 'utf8');

    expect(result.status).toBe('partial');
    expect(result.checks.canvas).toMatchObject({
      checked: true,
      present: true,
      passed: true,
      truncated: true,
      inspected: 64,
      nonEmpty: 64,
      omitted: 236,
    });
    expect(result.checks.canvas.details).toHaveLength(64);
    expect(Buffer.byteLength(serialized)).toBeLessThan(150_000);
  }, 20_000);

  it('samples only first-view canvases without scrolling into lazy offscreen content', async () => {
    let lazyRequests = 0;
    const fixture = await startFixtureServer((request, response) => {
      if (request.url === '/lazy') {
        lazyRequests += 1;
        response.writeHead(204);
        response.end();
        return;
      }

      sendHtml(
        response,
        `<!doctype html>
          <html>
            <head>
              <style>
                html, body { margin: 0; }
                canvas { display: block; width: 64px; height: 64px; }
                .spacer { height: 2000px; }
              </style>
            </head>
            <body>
              <canvas id="first-view" width="64" height="64"></canvas>
              <div class="spacer"></div>
              <canvas id="offscreen" width="64" height="64"></canvas>
              <script>
                for (const canvas of document.querySelectorAll('canvas')) {
                  const context = canvas.getContext('2d');
                  context.fillStyle = '#237a4b';
                  context.fillRect(0, 0, 64, 64);
                }
                let requested = false;
                addEventListener('scroll', () => {
                  if (!requested && scrollY > 100) {
                    requested = true;
                    fetch('/lazy').catch(() => {});
                  }
                });
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 0,
      timeoutMs: 15_000,
    });

    expect(result.status).toBe('complete');
    expect(result.checks.http.failures).toEqual([]);
    expect(result.checks.canvas).toMatchObject({
      checked: true,
      present: true,
      passed: true,
      inspected: 1,
      nonEmpty: 1,
    });
    expect(result.checks.canvas.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          index: 1,
          outcome: 'skipped',
        }),
      ]),
    );
    expect(lazyRequests).toBe(0);
  }, 20_000);

  it('ignores intentional local GET cancellation while retaining real request failures', async () => {
    const fixture = await startFixtureServer((request, response) => {
      if (request.url === '/slow') {
        setTimeout(() => {
          if (!response.destroyed) {
            response.writeHead(204);
            response.end();
          }
        }, 2_000);
        return;
      }

      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <h1>Intentional cancellation</h1>
              <script>
                const controller = new AbortController();
                fetch('/slow', { signal: controller.signal }).catch(() => {});
                controller.abort();
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 100,
      timeoutMs: 15_000,
    });

    expect(result.status).toBe('complete');
    expect(result.checks.http).toMatchObject({
      passed: true,
      failures: [],
      local404s: [],
    });
  }, 20_000);

  it('replays declarative click, key, scroll, and drag actions with checkpoint evidence', async () => {
    const fixture = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        `<!doctype html>
          <html>
            <head>
              <style>
                body { margin: 0; padding: 16px; font-family: sans-serif; }
                #scroller { width: 220px; height: 60px; overflow: auto; border: 1px solid #333; }
                #scroller > div { height: 420px; background: linear-gradient(#fff, #777); }
                #drag-surface { width: 220px; height: 90px; margin-top: 12px; background: #27465a; }
              </style>
            </head>
            <body>
              <button id="click-target" type="button">Click target</button>
              <button id="key-target" type="button">Key target</button>
              <div id="scroller"><div></div></div>
              <div id="drag-surface"></div>
              <p id="status">none</p>
              <script>
                const evidence = { click: false, key: false, scroll: false, drag: false };
                const status = document.querySelector('#status');
                const update = () => {
                  status.textContent = Object.entries(evidence)
                    .filter(([, value]) => value)
                    .map(([key]) => key)
                    .join(',');
                };
                document.querySelector('#click-target').addEventListener('click', () => {
                  evidence.click = true;
                  update();
                });
                document.querySelector('#key-target').addEventListener('keydown', (event) => {
                  if (event.key === 'Enter') {
                    evidence.key = true;
                    update();
                  }
                });
                document.querySelector('#scroller').addEventListener('scroll', (event) => {
                  if (event.currentTarget.scrollTop > 0) {
                    evidence.scroll = true;
                    update();
                  }
                });
                const dragSurface = document.querySelector('#drag-surface');
                let dragging = false;
                dragSurface.addEventListener('mousedown', () => {
                  dragging = true;
                });
                document.addEventListener('mouseup', () => {
                  if (dragging) {
                    evidence.drag = true;
                    dragSurface.style.background = '#4f8d65';
                    update();
                  }
                  dragging = false;
                });
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 0,
      actionSettleTimeMs: 25,
      timeoutMs: 20_000,
      actions: [
        {
          id: 'click',
          label: 'Click <img src=x onerror=alert(1)>',
          type: 'click',
          selector: '#click-target',
        },
        { id: 'key', type: 'key', selector: '#key-target', key: 'Enter' },
        { id: 'scroll', type: 'scroll', selector: '#scroller', deltaY: 160 },
        {
          id: 'drag',
          type: 'drag',
          selector: '#drag-surface',
          from: { x: 12, y: 12 },
          to: { x: 180, y: 64 },
          steps: 8,
        },
      ],
    });
    const report = await readFile(join(outputDirectory, 'report.html'), 'utf8');

    expect(result.status).toBe('complete');
    expect(result.checks.interactions).toMatchObject({
      checked: true,
      passed: true,
      attempted: 4,
      completed: 4,
      failed: 0,
      skipped: 0,
    });
    expect(result.checks.interactions.actions.map((action) => action.type)).toEqual([
      'click',
      'key',
      'scroll',
      'drag',
    ]);
    expect(result.checks.perceptual).toMatchObject({
      checked: false,
      passed: true,
    });
    expect(result.checks.perceptual.checkpoints).toHaveLength(5);
    expect(result.artifacts.interactionScreenshots).toHaveLength(5);

    for (const screenshotPath of result.artifacts.interactionScreenshots ?? []) {
      await expect(stat(join(outputDirectory, screenshotPath))).resolves.toBeDefined();
    }

    expect(report).toContain('Scripted interactions');
    expect(report).toContain('Checkpoint evidence');
    expect(report).toContain('Click &lt;img src=x onerror=alert(1)&gt;');
    expect(report).not.toContain('Click <img');
  }, 30_000);

  it('blocks and records non-local requests triggered by an interaction', async () => {
    let sentinelRequests = 0;
    let sentinelWebSockets = 0;
    const sentinel = await startFixtureServer((_request, response) => {
      sentinelRequests += 1;
      response.writeHead(204);
      response.end();
    });
    sentinel.server.on('upgrade', (_request, socket) => {
      sentinelWebSockets += 1;
      socket.destroy();
    });
    const fixture = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <button id="remote" type="button">Remote request</button>
              <script>
                document.querySelector('#remote').addEventListener('click', () => {
                  const image = new Image();
                  image.src = '${sentinel.origin}/pixel.png?token=private';
                  document.body.append(image);
                  new WebSocket('${sentinel.origin.replace('http:', 'ws:')}/socket?token=private');
                });
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 0,
      actionSettleTimeMs: 100,
      timeoutMs: 15_000,
      actions: [{ id: 'remote', type: 'click', selector: '#remote' }],
    });

    expect(sentinelRequests).toBe(0);
    expect(sentinelWebSockets).toBe(0);
    expect(result.status).toBe('partial');
    expect(result.checks.interactions.actions[0]?.status).toBe('failed');
    expect(result.checks.interactions.actions[0]?.remoteDependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blocked: true,
        }),
        expect.objectContaining({
          resourceType: 'websocket',
          blocked: true,
        }),
      ]),
    );
    expect(result.checks.remoteDependencies.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blocked: true,
        }),
        expect.objectContaining({
          resourceType: 'websocket',
          blocked: true,
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('token=private');
  }, 20_000);

  it('preserves same-origin WebSocket upgrades through the validation proxy', async () => {
    let upgrades = 0;
    const fixture = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <p>Local WebSocket fixture</p>
              <script>
                const socket = new WebSocket(location.origin.replace('http:', 'ws:') + '/socket');
                socket.addEventListener('open', () => {
                  document.body.dataset.websocket = 'open';
                  socket.close();
                });
              </script>
            </body>
          </html>`,
      );
    });
    fixture.server.on('upgrade', (request, socket) => {
      upgrades += 1;
      const key = request.headers['sec-websocket-key'];

      if (typeof key !== 'string') {
        socket.destroy();
        return;
      }

      const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      setTimeout(() => socket.destroy(), 100);
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 250,
      timeoutMs: 15_000,
    });

    expect(upgrades).toBe(1);
    expect(result.status).toBe('complete');
    expect(result.checks.remoteDependencies.dependencies).toEqual([]);
  }, 20_000);

  it('starts the quiet window after an action and catches delayed remote requests', async () => {
    let sentinelRequests = 0;
    const sentinel = await startFixtureServer((_request, response) => {
      sentinelRequests += 1;
      response.writeHead(204);
      response.end();
    });
    const fixture = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <button id="delayed" type="button">Delayed request</button>
              <script>
                document.querySelector('#delayed').addEventListener('click', () => {
                  setTimeout(() => {
                    const image = new Image();
                    image.src = '${sentinel.origin}/delayed.png';
                    document.body.append(image);
                  }, 150);
                });
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 0,
      actionSettleTimeMs: 300,
      timeoutMs: 15_000,
      actions: [{ id: 'delayed', type: 'click', selector: '#delayed' }],
    });
    const action = result.checks.interactions.actions[0];

    expect(sentinelRequests).toBe(0);
    expect(result.status).toBe('partial');
    expect(action).toMatchObject({
      status: 'failed',
      remoteDependencies: [
        expect.objectContaining({
          blocked: true,
        }),
      ],
    });
    expect(action?.durationMs ?? 0).toBeGreaterThanOrEqual(350);
  }, 20_000);

  it('blocks a remote redirect target at the loopback proxy boundary', async () => {
    let sentinelRequests = 0;
    const sentinel = await startFixtureServer((_request, response) => {
      sentinelRequests += 1;
      response.writeHead(204);
      response.end();
    });
    const fixture = await startFixtureServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, {
          location: `${sentinel.origin}/redirect-canary`,
          'cache-control': 'no-store',
        });
        response.end();
        return;
      }

      sendHtml(
        response,
        '<!doctype html><html><body><img src="/redirect" alt=""><p>Redirect fixture</p></body></html>',
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 300,
      timeoutMs: 15_000,
    });

    expect(sentinelRequests).toBe(0);
    expect(result.status).toBe('partial');
    expect(result.checks.remoteDependencies.dependencies).toEqual([
      expect.objectContaining({
        blocked: true,
        resourceType: expect.stringMatching(/image|proxy-http/u),
      }),
    ]);
  }, 20_000);

  it('blocks worker WebTransport egress and proxies worker requests', async () => {
    let workerRanRequests = 0;
    let sentinelRequests = 0;
    let sentinelConnections = 0;
    const sentinel = await startFixtureServer((_request, response) => {
      sentinelRequests += 1;
      response.writeHead(204);
      response.end();
    });
    sentinel.server.on('connection', () => {
      sentinelConnections += 1;
    });
    const workerSource = `
      fetch('/worker-ran').catch(() => undefined);
      if (typeof WebTransport !== 'undefined') {
        try {
          const transport = new WebTransport(
            '${sentinel.origin.replace('http:', 'https:')}/worker-webtransport-canary',
          );
          transport.ready.catch(() => undefined);
        } catch {
          // A synchronously disabled constructor is also acceptable.
        }
      }
      fetch('${sentinel.origin}/worker-outbound-canary').catch(() => undefined);
    `;
    const fixture = await startFixtureServer((request, response) => {
      if (request.url === '/worker.js') {
        response.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'content-length': Buffer.byteLength(workerSource),
          'cache-control': 'no-store',
        });
        response.end(workerSource);
        return;
      }

      if (request.url === '/worker-ran') {
        workerRanRequests += 1;
        response.writeHead(204);
        response.end();
        return;
      }

      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <p>Worker transport fixture</p>
              <script>
                const worker = new Worker('/worker.js');
                addEventListener('pagehide', () => worker.terminate(), { once: true });
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 500,
      timeoutMs: 15_000,
    });

    expect(workerRanRequests).toBe(1);
    expect(sentinelRequests).toBe(0);
    expect(sentinelConnections).toBe(0);
    expect(result.status).toBe('partial');
    expect(result.checks.remoteDependencies.dependencies).toEqual([
      expect.objectContaining({
        blocked: true,
      }),
    ]);
  }, 20_000);

  it('fingerprints page-controlled form values in every diagnostic artifact', async () => {
    const canary = 'FORM_VALUE_CANARY_7f0bca1e';
    let sentinelRequests = 0;
    const sentinel = await startFixtureServer((_request, response) => {
      sentinelRequests += 1;
      response.writeHead(204);
      response.end();
    });
    const fixture = await startFixtureServer((request, response) => {
      if (request.url === '/') {
        sendHtml(
          response,
          `<!doctype html>
            <html>
              <body>
                <input id="private-value" value="${canary}">
                <script>
                  const value = document.querySelector('#private-value').value;
                  console.error(value);
                  setTimeout(() => { throw new Error(value); }, 0);
                  const local = new Image();
                  local.src = '/' + value + '?value=' + value;
                  document.body.append(local);
                  const remote = new Image();
                  remote.src = '${sentinel.origin}/' + value + '?value=' + value;
                  document.body.append(remote);
                </script>
              </body>
            </html>`,
        );
        return;
      }

      response.writeHead(404, {
        'content-type': 'text/plain; charset=utf-8',
      });
      response.end('missing');
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 300,
      timeoutMs: 15_000,
      visualReferences: {
        initial: solidReferencePng(),
      },
    });
    const validationJson = await readFile(join(outputDirectory, 'validation.json'), 'utf8');
    const reportHtml = await readFile(join(outputDirectory, 'report.html'), 'utf8');
    const screenshotPath = result.artifacts.screenshot;

    if (!screenshotPath) {
      throw new Error('Expected the masked first-view screenshot.');
    }

    const screenshotImage = PNG.sync.read(await readFile(join(outputDirectory, screenshotPath)));
    const containsMask = screenshotImage.data.some(
      (value, index, pixels) =>
        index % 4 === 0 &&
        value === 255 &&
        pixels[index + 1] === 0 &&
        pixels[index + 2] === 254 &&
        pixels[index + 3] === 255,
    );

    expect(sentinelRequests).toBe(0);
    expect(result.status).toBe('failed');
    expect(result.checks.http.local404s).toHaveLength(1);
    expect(result.checks.runtime.pageErrors).toHaveLength(1);
    expect(result.checks.runtime.consoleErrors.length).toBeGreaterThanOrEqual(1);
    expect(result.checks.remoteDependencies.dependencies).toHaveLength(1);
    expect(result.checks.screenshot.maskedSensitiveControls).toBe(true);
    expect(containsMask).toBe(true);
    expect(result.artifacts.referenceScreenshots).toBeUndefined();
    expect(result.artifacts.perceptualDiffs).toBeUndefined();
    expect(result.checks.perceptual.checked).toBe(false);
    expect(result.checks.perceptual.checkpoints[0]?.comparison.reason).toContain(
      'sensitive form controls',
    );
    expect(validationJson).not.toContain(canary);
    expect(reportHtml).not.toContain(canary);
    expect(validationJson).toContain('fingerprint:');
  }, 20_000);

  it('refuses screenshots when a closed shadow root could expose form values', async () => {
    const canary = 'CLOSED_SHADOW_FORM_CANARY_395b80';
    const fixture = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <div id="host"></div>
              <script>
                const root = document.querySelector('#host').attachShadow({ mode: 'closed' });
                const input = document.createElement('input');
                input.value = '${canary}';
                input.style.cssText = 'display:block;width:320px;height:48px;font-size:24px';
                root.append(input);
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 100,
      timeoutMs: 15_000,
      visualReferences: {
        initial: solidReferencePng(),
      },
    });
    const validationJson = await readFile(join(outputDirectory, 'validation.json'), 'utf8');
    const reportHtml = await readFile(join(outputDirectory, 'report.html'), 'utf8');
    const outputFiles = await readdir(outputDirectory, { recursive: true });

    expect(result.status).toBe('partial');
    expect(result.checks.screenshot).toMatchObject({
      passed: false,
      error: expect.stringContaining('closed Shadow DOM'),
    });
    expect(result.artifacts.screenshot).toBeUndefined();
    expect(result.artifacts.interactionScreenshots).toBeUndefined();
    expect(result.artifacts.referenceScreenshots).toBeUndefined();
    expect(result.artifacts.perceptualDiffs).toBeUndefined();
    expect(outputFiles.filter((file) => file.endsWith('.png'))).toEqual([]);
    expect(validationJson).not.toContain(canary);
    expect(reportHtml).not.toContain(canary);
  }, 20_000);

  it('marks Canvas evidence incomplete when a closed shadow root cannot be inspected', async () => {
    const fixture = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <div id="host"></div>
              <script>
                const root = document.querySelector('#host').attachShadow({ mode: 'closed' });
                const canvas = document.createElement('canvas');
                canvas.width = 320;
                canvas.height = 180;
                canvas.style.cssText = 'display:block;width:320px;height:180px';
                root.append(canvas);
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 100,
      canvasSettleTimeoutMs: 0,
      timeoutMs: 15_000,
    });

    expect(result.status).toBe('partial');
    expect(result.checks.canvas).toMatchObject({
      checked: true,
      present: true,
      passed: false,
      truncated: true,
      nonEmpty: 0,
    });
    expect(result.checks.canvas.omitted).toBeGreaterThan(0);
  }, 20_000);

  it('preserves blocking severity when a console event is dropped at the limit', async () => {
    const canary = 'DROPPED_BLOCKING_CANARY_b927b6';
    const fixture = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <script>
                for (let index = 0; index < 64; index += 1) {
                  console.error('Failed to load resource: filler-' + index);
                }
                console.error('${canary}');
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 100,
      timeoutMs: 15_000,
    });
    const serialized = await readFile(join(outputDirectory, 'validation.json'), 'utf8');
    const diagnostics = result.checks.diagnostics;

    expect(diagnostics).toBeDefined();

    if (!diagnostics) {
      throw new Error('Expected diagnostic budget metadata.');
    }

    expect(result.status).toBe('failed');
    expect(result.checks.runtime.blockingConsoleErrors).toEqual([]);
    expect(result.checks.runtime.passed).toBe(false);
    expect(diagnostics.categories.consoleErrors).toMatchObject({
      recorded: 64,
      dropped: 1,
      droppedBlocking: 1,
    });
    expect(result.errors.join(' ')).toContain('blocking runtime error');
    expect(serialized).not.toContain(canary);
  }, 20_000);

  it('bounds flooded evidence and marks the result partial when diagnostics truncate', async () => {
    let sentinelRequests = 0;
    const sentinel = await startFixtureServer((_request, response) => {
      sentinelRequests += 1;
      response.writeHead(204);
      response.end();
    });
    const fixture = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <p>Diagnostic flood fixture</p>
              <script>
                for (let index = 0; index < 512; index += 1) {
                  const image = new Image();
                  image.src = '${sentinel.origin}/flood-event-' + index;
                  document.body.append(image);
                }
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 500,
      timeoutMs: 20_000,
    });
    const validationJson = await readFile(join(outputDirectory, 'validation.json'), 'utf8');
    const reportHtml = await readFile(join(outputDirectory, 'report.html'), 'utf8');
    const diagnostics = result.checks.diagnostics;

    expect(diagnostics).toBeDefined();

    if (!diagnostics) {
      throw new Error('Expected diagnostic budget metadata.');
    }

    const remoteSummary = diagnostics.categories.remoteDependencies;

    expect(sentinelRequests).toBe(0);
    expect(result.status).toBe('partial');
    expect(diagnostics).toMatchObject({
      passed: false,
      truncated: true,
      droppedEvents: expect.any(Number),
    });
    expect(diagnostics.droppedEvents).toBeGreaterThan(0);
    expect(remoteSummary.recorded).toBeLessThanOrEqual(remoteSummary.eventLimit);
    expect(result.checks.remoteDependencies.dependencies.length).toBeLessThanOrEqual(
      remoteSummary.eventLimit,
    );
    expect(diagnostics.estimatedRecordedEventBytes).toBeLessThanOrEqual(
      diagnostics.eventByteBudget,
    );
    expect(Buffer.byteLength(validationJson)).toBeLessThan(300_000);
    expect(Buffer.byteLength(reportHtml)).toBeLessThan(100_000);
    expect(validationJson).not.toContain('flood-event-');
    expect(reportHtml).toContain('event(s) omitted after reaching evidence limits');
  }, 30_000);

  it('marks an action partial when same-origin network activity never becomes quiet', async () => {
    const fixture = await startFixtureServer((request, response) => {
      if (request.url === '/never') {
        // The validation context closes this response after the bounded quiet wait fails.
        return;
      }

      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <button id="never" type="button">Never quiet</button>
              <script>
                document.querySelector('#never').addEventListener('click', () => {
                  fetch('/never').catch(() => undefined);
                });
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 0,
      actionSettleTimeMs: 100,
      timeoutMs: 15_000,
      actions: [{ id: 'never', type: 'click', selector: '#never' }],
    });

    expect(result.status).toBe('partial');
    expect(result.checks.interactions.actions[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('network quiet'),
    });
  }, 20_000);

  it('closes additional pages immediately and fails the opening action', async () => {
    const fixture = await startFixtureServer((request, response) => {
      if (request.url === '/popup') {
        sendHtml(response, '<!doctype html><html><body><p>Popup</p></body></html>');
        return;
      }

      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <button id="popup" type="button">Open popup</button>
              <script>
                document.querySelector('#popup').addEventListener('click', () => {
                  window.open('/popup', '_blank');
                });
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 0,
      actionSettleTimeMs: 50,
      timeoutMs: 15_000,
      actions: [{ id: 'popup', type: 'click', selector: '#popup' }],
    });

    expect(result.status).toBe('partial');
    expect(result.checks.interactions.actions[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('additional page'),
    });
  }, 20_000);

  it('compares initial and action checkpoints against trusted PNG references', async () => {
    const fixture = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        `<!doctype html>
          <html>
            <head>
              <style>
                html, body { width: 100%; height: 100%; margin: 0; background: #4b6574; }
                #toggle { width: 100%; height: 100%; border: 0; background: transparent; }
              </style>
            </head>
            <body>
              <button id="toggle" type="button" aria-label="Toggle color"></button>
              <script>
                document.querySelector('#toggle').addEventListener('click', () => {
                  document.body.style.background = '#3c8458';
                });
              </script>
            </body>
          </html>`,
      );
    });
    const baselineOutput = await createOutputDirectory();
    const comparisonOutput = await createOutputDirectory();
    const actions: ValidationAction[] = [{ id: 'CON', type: 'click', selector: '#toggle' }];
    const baseline = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory: baselineOutput,
      viewport: { width: 320, height: 200 },
      settleTimeMs: 0,
      actionSettleTimeMs: 0,
      timeoutMs: 15_000,
      actions,
    });
    const [initialPath, actionPath] = baseline.artifacts.interactionScreenshots ?? [];

    if (!initialPath || !actionPath) {
      throw new Error('Expected baseline interaction screenshots.');
    }

    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory: comparisonOutput,
      viewport: { width: 320, height: 200 },
      settleTimeMs: 0,
      actionSettleTimeMs: 0,
      timeoutMs: 15_000,
      actions,
      visualReferences: {
        initial: await readFile(join(baselineOutput, initialPath)),
        CON: await readFile(join(baselineOutput, actionPath)),
      },
      perceptual: {
        threshold: 0.1,
        maxDifferenceRatio: 0.001,
        partialDifferenceRatio: 0.05,
      },
    });

    expect(result.status).toBe('complete');
    expect(result.checks.perceptual).toMatchObject({
      checked: true,
      passed: true,
      compared: 2,
      matched: 2,
      partial: 0,
      mismatched: 0,
      errors: 0,
    });
    expect(result.artifacts.referenceScreenshots).toHaveLength(2);
    expect(result.artifacts.perceptualDiffs).toHaveLength(2);
    expect(result.artifacts.referenceScreenshots).toContain(
      'screenshots/references/checkpoint-CON.png',
    );
    expect(
      result.checks.perceptual.checkpoints.every(
        (checkpoint) => checkpoint.comparison.similarity === 1,
      ),
    ).toBe(true);
  }, 30_000);

  it('does not report complete when a visual-reference-only replay cannot start', async () => {
    let documentRequests = 0;
    const fixture = await startFixtureServer((request, response) => {
      if (request.url !== '/') {
        response.writeHead(404);
        response.end();
        return;
      }

      documentRequests += 1;

      if (documentRequests === 1) {
        sendHtml(response, '<!doctype html><html><body><p>Fast validation</p></body></html>');
        return;
      }

      const binaryHtml = gzipSync(Buffer.from('<!doctype html><title>Undecoded</title>'));
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': binaryHtml.byteLength,
      });
      response.end(binaryHtml);
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 0,
      timeoutMs: 15_000,
      visualReferences: {
        initial: solidReferencePng(),
      },
    });

    expect(result.entry.ok).toBe(true);
    expect(result.status).toBe('partial');
    expect(result.checks.interactions).toMatchObject({
      checked: true,
      passed: false,
      errors: [expect.stringContaining('undecoded or binary data')],
    });
    expect(result.checks.perceptual.checked).toBe(false);
  }, 20_000);

  it('rejects action-provided JavaScript and unsupported action fields before launch', async () => {
    const outputDirectory = await createOutputDirectory();
    const unsafeActions = [
      {
        id: 'unsafe',
        type: 'script',
        code: 'globalThis.compromised = true',
      },
    ] as unknown as ValidationAction[];

    await expect(
      runValidation({
        entryUrl: 'http://127.0.0.1:1/',
        outputDirectory,
        actions: unsafeActions,
      }),
    ).rejects.toThrow('must be click, scroll, key, or drag');

    await expect(
      runValidation({
        entryUrl: 'http://127.0.0.1:1/',
        outputDirectory,
        viewport: {
          width: 100_000,
          height: 100_000,
          deviceScaleFactor: 4,
        },
      }),
    ).rejects.toThrow('screenshot pixel budget');

    await expect(
      runValidation({
        entryUrl: 'http://127.0.0.1:1/',
        outputDirectory,
        actions: [
          { id: 'Step', type: 'click', selector: '#one' },
          { id: 'step', type: 'click', selector: '#two' },
        ],
      }),
    ).rejects.toThrow('case-insensitive filesystems');

    await expect(
      runValidation({
        entryUrl: 'http://127.0.0.1:1/',
        outputDirectory,
        actions: [{ id: 'INITIAL', type: 'click', selector: '#one' }],
      }),
    ).rejects.toThrow('reserved for the initial checkpoint');
  });

  it('does not let key actions modify editable form controls', async () => {
    const fixture = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        '<!doctype html><html><body><input id="editable" value=""><p>Fixture</p></body></html>',
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 0,
      actionSettleTimeMs: 0,
      timeoutMs: 15_000,
      actions: [
        {
          id: 'edit',
          type: 'key',
          selector: '#editable',
          key: 'A',
        },
      ],
    });

    expect(result.status).toBe('partial');
    expect(result.checks.interactions.actions[0]).toMatchObject({
      status: 'failed',
      error: 'Key actions are disabled while an editable form control is focused',
    });
  }, 20_000);

  it('disables WebRTC constructors before mirrored code can open an untracked transport', async () => {
    const fixture = await startFixtureServer((_request, response) => {
      sendHtml(
        response,
        `<!doctype html>
          <html>
            <body>
              <button id="probe" type="button">Probe WebRTC</button>
              <button id="confirmed" type="button" hidden>Transport blocked</button>
              <script>
                document.querySelector('#probe').addEventListener('click', () => {
                  try {
                    new RTCPeerConnection({
                      iceServers: [{ urls: 'stun:example.invalid:3478' }],
                    });
                  } catch {
                    document.querySelector('#confirmed').hidden = false;
                  }
                });
              </script>
            </body>
          </html>`,
      );
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/`,
      outputDirectory,
      settleTimeMs: 0,
      actionSettleTimeMs: 0,
      timeoutMs: 15_000,
      actions: [
        { id: 'probe', type: 'click', selector: '#probe' },
        { id: 'confirm', type: 'click', selector: '#confirmed' },
      ],
    });

    expect(result.status).toBe('complete');
    expect(result.checks.interactions).toMatchObject({
      passed: true,
      completed: 2,
    });
  }, 20_000);

  it('returns a failed report on timeout', async () => {
    const fixture = await startFixtureServer((_request, _response) => {
      // Leave the response open until the validation deadline closes the browser connection.
    });
    const outputDirectory = await createOutputDirectory();
    const result = await runValidation({
      entryUrl: `${fixture.origin}/slow`,
      outputDirectory,
      timeoutMs: 800,
    });

    expect(result.status).toBe('failed');
    expect(result.errors.join(' ')).toContain('timed out');
    await expect(stat(join(outputDirectory, 'validation.json'))).resolves.toBeDefined();
    await expect(stat(join(outputDirectory, 'report.html'))).resolves.toBeDefined();
  }, 10_000);

  it('honors AbortSignal while still allowing the process to exit cleanly', async () => {
    const fixture = await startFixtureServer((_request, _response) => {
      // The caller aborts while navigation is pending.
    });
    const outputDirectory = await createOutputDirectory();
    const controller = new AbortController();
    const validation = runValidation({
      entryUrl: `${fixture.origin}/slow`,
      outputDirectory,
      timeoutMs: 15_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);

    await expect(validation).rejects.toMatchObject({ name: 'AbortError' });
    await expect(readFile(join(outputDirectory, 'validation.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(outputDirectory, 'report.html'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }, 10_000);
});
