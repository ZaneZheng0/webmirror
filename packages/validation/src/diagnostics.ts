import { createHmac, randomBytes } from 'node:crypto';

import { redactSensitiveText } from '@webmirror/shared';

const MAX_TRUSTED_TEXT_LENGTH = 2_000;
const MAX_FINGERPRINT_INPUT_LENGTH = 64 * 1024;
const FINGERPRINT_BYTES = 16;
const fingerprintKey = randomBytes(32);

function diagnosticFingerprint(value: string): string {
  const hash = createHmac('sha256', fingerprintKey).update(String(value.length)).update('\0');
  hash.update(
    value.length <= MAX_FINGERPRINT_INPUT_LENGTH
      ? value
      : value.slice(0, MAX_FINGERPRINT_INPUT_LENGTH),
  );
  return hash.digest('hex').slice(0, FINGERPRINT_BYTES * 2);
}

function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PublicValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicValidationError';
  }
}

export function sanitizeTrustedText(value: string): string {
  const singleLine = value.replaceAll('\0', '').replaceAll(/\s+/g, ' ').trim();
  const redacted = redactSensitiveText(singleLine);

  return redacted.length <= MAX_TRUSTED_TEXT_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_TRUSTED_TEXT_LENGTH)}...`;
}

export function diagnosticMessage(category: string, value: string): string {
  return `${category} [fingerprint:${diagnosticFingerprint(value)}]`;
}

export function diagnosticErrorMessage(error: unknown, category: string): string {
  if (error instanceof PublicValidationError) {
    return sanitizeTrustedText(error.message);
  }

  return diagnosticMessage(category, rawErrorMessage(error));
}

export function diagnosticUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return diagnosticMessage('Unparseable URL', value);
  }

  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    return `unsupported-url:${diagnosticFingerprint(url.href)}`;
  }

  const origin = `${url.protocol}//origin-${diagnosticFingerprint(url.origin)}.invalid`;
  const path = diagnosticFingerprint(`${url.pathname}${url.search}${url.hash}`);
  return `${origin}/path-${path}`;
}

export function diagnosticOrigin(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//origin-${diagnosticFingerprint(url.origin)}.invalid`;
  } catch {
    return diagnosticMessage('Origin', value);
  }
}
