import { describe, expect, it } from 'vitest';

import { redactStaticJavaScriptCredentials } from './secret-redaction.js';

describe('static JavaScript credential redaction', () => {
  it('redacts parseable credential literals while retaining ordinary runtime code', () => {
    const bearer = `Bearer ${'a'.repeat(40)}`;
    const providerKey = `sk-test-${'b'.repeat(40)}`;
    const source = [
      'const config = {',
      `  authorization: ${JSON.stringify(bearer)},`,
      `  "xi-api-key": ${JSON.stringify(providerKey)},`,
      '};',
      'window.runtimeBooted = true;',
    ].join('\n');

    const result = redactStaticJavaScriptCredentials(source);

    expect(result).toMatchObject({
      replacements: 2,
      redactedPropertyNames: expect.arrayContaining(['authorization', 'xiapikey']),
    });
    expect(result.text).toContain('window.runtimeBooted = true;');
    expect(result.text).toContain('Bearer <redacted>');
    expect(result.text).not.toContain(bearer);
    expect(result.text).not.toContain(providerKey);
  });

  it('does not modify unparseable source', () => {
    const source = 'const = "Bearer something";';

    expect(redactStaticJavaScriptCredentials(source)).toEqual({
      text: source,
      replacements: 0,
      redactedPropertyNames: [],
    });
  });

  it('retains public browser identifiers while redacting recognized secret tokens', () => {
    const mapboxPublicToken = `pk.${'a'.repeat(80)}`;
    const browserApiKey = 'b'.repeat(35);
    const providerSecret = `sk-test-${'c'.repeat(40)}`;
    const source = [
      `const publicConfig = { accessToken: ${JSON.stringify(mapboxPublicToken)}, api_key: ${JSON.stringify(browserApiKey)} };`,
      `const privateConfig = { api_key: ${JSON.stringify(providerSecret)} };`,
    ].join('\n');

    const result = redactStaticJavaScriptCredentials(source);

    expect(result.replacements).toBe(1);
    expect(result.text).toContain(mapboxPublicToken);
    expect(result.text).toContain(browserApiKey);
    expect(result.text).not.toContain(providerSecret);
  });
});
