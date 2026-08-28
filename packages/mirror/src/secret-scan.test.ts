import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanFileForHighConfidenceSecrets } from './secret-scan.js';
import { createTestDirectory, removeTestDirectory } from './test-utils.js';

describe('high-confidence secret scanning', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await createTestDirectory('webmirror-secret-scan-');
  });

  afterEach(async () => {
    await removeTestDirectory(directory);
  });

  it('detects structured JSON credentials without returning their values', async () => {
    const filePath = join(directory, 'config.json');
    await writeFile(
      filePath,
      JSON.stringify({
        access_token: 'eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJlLXZhbHVl',
        status: 'ready',
      }),
      'utf8',
    );

    await expect(
      scanFileForHighConfidenceSecrets(filePath, 'application/json', 'site/config.json'),
    ).resolves.toMatchObject({
      scanned: true,
      findings: expect.arrayContaining(['structured_credential', 'jwt']),
    });
  });

  it('detects password defaults and private keys in HTML', async () => {
    const filePath = join(directory, 'index.html');
    await writeFile(
      filePath,
      `<!doctype html>
        <input type="password" value="correct horse battery staple">
        <script>const key = "-----BEGIN PRIVATE KEY-----";</script>`,
      'utf8',
    );

    await expect(
      scanFileForHighConfidenceSecrets(filePath, 'text/html', 'site/index.html'),
    ).resolves.toMatchObject({
      findings: expect.arrayContaining(['password_form_value', 'private_key']),
    });
  });

  it('does not flag ordinary static configuration placeholders', async () => {
    const filePath = join(directory, 'config.json');
    await writeFile(
      filePath,
      JSON.stringify({
        token: 'demo',
        password: 'changeme',
        api_key: 'your-token-here',
      }),
      'utf8',
    );

    await expect(
      scanFileForHighConfidenceSecrets(filePath, 'application/json', 'site/config.json'),
    ).resolves.toEqual({
      scanned: true,
      findings: [],
    });
  });

  it('does not quarantine browser-published Google API client identifiers', async () => {
    const javascriptPath = join(directory, 'constants.js');
    const jsonPath = join(directory, 'config.json');
    const publicClientKey = `AIza${'a'.repeat(35)}`;
    await writeFile(
      javascriptPath,
      `const GOOGLE_BROWSER_API_KEY = ${JSON.stringify(publicClientKey)};`,
      'utf8',
    );
    await writeFile(jsonPath, JSON.stringify({ api_key: publicClientKey }), 'utf8');

    await expect(
      scanFileForHighConfidenceSecrets(
        javascriptPath,
        'application/javascript',
        'site/constants.js',
      ),
    ).resolves.toEqual({
      scanned: true,
      findings: [],
    });
    await expect(
      scanFileForHighConfidenceSecrets(jsonPath, 'application/json', 'site/config.json'),
    ).resolves.toEqual({
      scanned: true,
      findings: [],
    });
  });

  it('does not treat public browser storefront and SDK configuration as a credential', async () => {
    const htmlPath = join(directory, 'index.html');
    const javascriptPath = join(directory, 'sdk.js');
    await writeFile(
      htmlPath,
      `<!doctype html>
        <script id="shop-features" type="application/json">
          {"accessToken":"${'a'.repeat(32)}","domain":"shop.example","shopId":123}
        </script>`,
      'utf8',
    );
    await writeFile(
      javascriptPath,
      [
        `mapboxgl.accessToken = ${JSON.stringify(`pk.${'b'.repeat(80)}`)};`,
        `const telemetry = { api_key: ${JSON.stringify('c'.repeat(35))} };`,
      ].join('\n'),
      'utf8',
    );

    await expect(
      scanFileForHighConfidenceSecrets(htmlPath, 'text/html', 'site/index.html'),
    ).resolves.toEqual({ scanned: true, findings: [] });
    await expect(
      scanFileForHighConfidenceSecrets(javascriptPath, 'application/javascript', 'site/sdk.js'),
    ).resolves.toEqual({ scanned: true, findings: [] });
  });

  it('does not quarantine public storefront JSON configuration', async () => {
    const filePath = join(directory, 'storefront.json');
    await writeFile(
      filePath,
      JSON.stringify({
        accessToken: 'a'.repeat(32),
        apiKey: 'b'.repeat(35),
        domain: 'shop.example',
        shopId: 123,
        locale: 'en',
        version: '2026-07',
      }),
      'utf8',
    );

    await expect(
      scanFileForHighConfidenceSecrets(filePath, 'application/json', 'site/storefront.json'),
    ).resolves.toEqual({ scanned: true, findings: [] });
  });

  it('retains public publishable browser keys without exempting provider secrets', async () => {
    const publicPath = join(directory, 'payments-public.json');
    const privatePath = join(directory, 'payments-private.json');
    await writeFile(publicPath, JSON.stringify({ api_key: `pk_test_${'a'.repeat(32)}` }), 'utf8');
    await writeFile(privatePath, JSON.stringify({ api_key: `sk_test_${'b'.repeat(32)}` }), 'utf8');

    await expect(
      scanFileForHighConfidenceSecrets(publicPath, 'application/json', 'site/public.json'),
    ).resolves.toEqual({ scanned: true, findings: [] });
    await expect(
      scanFileForHighConfidenceSecrets(privatePath, 'application/json', 'site/private.json'),
    ).resolves.toMatchObject({
      findings: expect.arrayContaining(['cloud_or_provider_token', 'structured_credential']),
    });
  });

  it('still detects unambiguous structured secrets in static JavaScript', async () => {
    const filePath = join(directory, 'private-config.js');
    await writeFile(
      filePath,
      `const config = { client_secret: ${JSON.stringify('secret-value-'.repeat(3))} };`,
      'utf8',
    );

    await expect(
      scanFileForHighConfidenceSecrets(
        filePath,
        'application/javascript',
        'site/private-config.js',
      ),
    ).resolves.toMatchObject({
      scanned: true,
      findings: expect.arrayContaining(['structured_credential']),
    });
  });

  it('does not mistake minified member access beginning with sk for a provider token', async () => {
    const filePath = join(directory, 'animation-runtime.js');
    await writeFile(
      filePath,
      'if(this.sk){if(this.sk.effectsSequence.length)return;this.pre.skewFromAxis(this.sk.v)}',
      'utf8',
    );

    await expect(
      scanFileForHighConfidenceSecrets(
        filePath,
        'application/javascript',
        'site/animation-runtime.js',
      ),
    ).resolves.toEqual({ scanned: true, findings: [] });
  });

  it('keeps opaque access tokens blocking in JSON API responses', async () => {
    const filePath = join(directory, 'response.json');
    await writeFile(filePath, JSON.stringify({ access_token: 'a'.repeat(32) }), 'utf8');

    await expect(
      scanFileForHighConfidenceSecrets(filePath, 'application/json', 'site/response.json'),
    ).resolves.toMatchObject({
      findings: expect.arrayContaining(['structured_credential']),
    });
  });

  it('keeps session identifiers blocking even inside otherwise public-looking JSON', async () => {
    const filePath = join(directory, 'session.json');
    await writeFile(
      filePath,
      JSON.stringify({
        domain: 'shop.example',
        shopId: 123,
        session_id: 's'.repeat(32),
      }),
      'utf8',
    );

    await expect(
      scanFileForHighConfidenceSecrets(filePath, 'application/json', 'site/session.json'),
    ).resolves.toMatchObject({
      findings: expect.arrayContaining(['structured_credential']),
    });
  });

  it('uses conservative generic scanning when declared JSON is malformed', async () => {
    const filePath = join(directory, 'malformed.json');
    await writeFile(filePath, `{"access_token":"${'a'.repeat(32)}",`, 'utf8');

    await expect(
      scanFileForHighConfidenceSecrets(filePath, 'application/json', 'site/malformed.json'),
    ).resolves.toMatchObject({
      findings: expect.arrayContaining(['structured_credential']),
    });
  });

  it('continues to detect provider credentials that can authenticate requests', async () => {
    const filePath = join(directory, 'leaked.js');
    await writeFile(filePath, 'const accessKey = "AKIA1234567890ABCDEF";', 'utf8');

    await expect(
      scanFileForHighConfidenceSecrets(filePath, 'application/javascript', 'site/leaked.js'),
    ).resolves.toMatchObject({
      scanned: true,
      findings: expect.arrayContaining(['cloud_or_provider_token']),
    });
  });

  it('skips binary resources', async () => {
    const filePath = join(directory, 'model.bin');
    await writeFile(filePath, Buffer.from([0x00, 0xff, 0x10, 0x20]));

    await expect(
      scanFileForHighConfidenceSecrets(filePath, 'application/octet-stream', 'site/model.bin'),
    ).resolves.toEqual({
      scanned: false,
      findings: [],
    });
  });

  it('scans printable text even when MIME and extension claim binary content', async () => {
    const filePath = join(directory, 'payload.bin');
    await writeFile(
      filePath,
      JSON.stringify({
        access_token: 'eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJlLXZhbHVl',
      }),
      'utf8',
    );

    await expect(
      scanFileForHighConfidenceSecrets(filePath, 'application/octet-stream', 'site/payload.bin'),
    ).resolves.toMatchObject({
      scanned: true,
      findings: expect.arrayContaining(['structured_credential', 'jwt']),
    });
  });
});
