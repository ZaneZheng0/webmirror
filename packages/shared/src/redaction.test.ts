import { describe, expect, it } from 'vitest';

import { isSensitiveQueryName, redactSensitiveText, redactSensitiveUrl } from './redaction.js';

describe('privacy redaction', () => {
  it('redacts sensitive URL fields while preserving cache and layout parameters', () => {
    expect(
      redactSensitiveUrl(
        'https://user:password@example.com/asset.js?rev=7&access_token=secret&sessionId=abc#entry',
      ),
    ).toBe(
      'https://REDACTED:REDACTED@example.com/asset.js?rev=7&access_token=REDACTED&sessionId=REDACTED#entry',
    );
  });

  it('does not classify unrelated words that merely contain key-like letters', () => {
    expect(isSensitiveQueryName('monkey')).toBe(false);
    expect(isSensitiveQueryName('api_key')).toBe(true);
    expect(isSensitiveQueryName('refresh-token')).toBe(true);
  });

  it('redacts sensitive fragment parameters without removing client routes', () => {
    expect(
      redactSensitiveUrl(
        'https://example.com/app#/callback?access_token=fragment-secret&view=summary',
      ),
    ).toBe('https://example.com/app#/callback?access_token=REDACTED&view=summary');
    expect(redactSensitiveUrl('https://example.com/#sessionId=abc&panel=2')).toBe(
      'https://example.com/#sessionId=REDACTED&panel=2',
    );
  });

  it('redacts credentials embedded in diagnostic text', () => {
    expect(redactSensitiveText('Authorization=Bearer abc.def token=secret')).toBe(
      'Authorization=REDACTED token=REDACTED',
    );
    expect(redactSensitiveText('{"token":"secret","status":"ok"}')).toBe(
      '{"token":REDACTED,"status":"ok"}',
    );
    expect(isSensitiveQueryName('X-Amz-Credential')).toBe(true);
    expect(isSensitiveQueryName('code_verifier')).toBe(true);
  });
});
