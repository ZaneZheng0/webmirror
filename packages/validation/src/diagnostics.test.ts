import { describe, expect, it } from 'vitest';

import { diagnosticErrorMessage, diagnosticUrl, PublicValidationError } from './diagnostics.js';

describe('validation diagnostics', () => {
  it('fingerprints unsupported URL schemes without preserving page-controlled protocol text', () => {
    const canary = 'formvalueschemecanary';
    const value = diagnosticUrl(`${canary}:payload`);

    expect(value).toMatch(/^unsupported-url:[a-f0-9]{32}$/u);
    expect(value).not.toContain(canary);
    expect(value).not.toContain('payload');
  });

  it('preserves only explicitly public errors and fingerprints unknown errors', () => {
    expect(
      diagnosticErrorMessage(new PublicValidationError('The action was blocked.'), 'Action error'),
    ).toBe('The action was blocked.');
    expect(diagnosticErrorMessage(new Error('private-value'), 'Action error')).toMatch(
      /^Action error \[fingerprint:[a-f0-9]{32}\]$/u,
    );
  });
});
