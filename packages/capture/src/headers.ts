import type { HeaderMap } from './types.js';

import { redactSensitiveText } from '@webmirror/shared';

const safeHeaderNames = new Set([
  'accept',
  'accept-ranges',
  'access-control-allow-credentials',
  'access-control-allow-origin',
  'cache-control',
  'content-encoding',
  'content-language',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'expires',
  'if-modified-since',
  'if-none-match',
  'last-modified',
  'range',
  'vary',
]);

export function sanitizeHeaders(headers: Record<string, unknown> | undefined): HeaderMap {
  if (!headers) {
    return {};
  }

  const sanitized: Record<string, string> = {};

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();

    if (!safeHeaderNames.has(name)) {
      continue;
    }

    if (typeof rawValue === 'string' || typeof rawValue === 'number') {
      sanitized[name] = redactSensitiveText(String(rawValue));
    }
  }

  return sanitized;
}
