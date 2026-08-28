export type MirrorSecurityErrorCode =
  | 'DANGEROUS_PROTOCOL'
  | 'URL_CREDENTIALS'
  | 'PRIVATE_NETWORK'
  | 'INVALID_LOCAL_PATH'
  | 'PATH_OUTSIDE_ROOT'
  | 'SYMLINK_PATH';

export class MirrorSecurityError extends Error {
  readonly code: MirrorSecurityErrorCode;

  constructor(code: MirrorSecurityErrorCode, message: string) {
    super(message);
    this.name = 'MirrorSecurityError';
    this.code = code;
  }
}

export class DownloadTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Download timed out after ${timeoutMs}ms`);
    this.name = 'DownloadTimeoutError';
  }
}

export class DownloadSizeLimitError extends Error {
  readonly maximumBytes: number;
  readonly requiredBytes?: number;

  constructor(maximumBytes: number, requiredBytes?: number) {
    super(`Download exceeded the ${maximumBytes}-byte safety limit`);
    this.name = 'DownloadSizeLimitError';
    this.maximumBytes = maximumBytes;

    if (requiredBytes !== undefined) {
      this.requiredBytes = requiredBytes;
    }
  }
}

export class HttpStatusError extends Error {
  readonly statusCode: number;
  readonly retryAfterMs?: number;

  constructor(statusCode: number, retryAfterMs?: number) {
    super(`Download failed with HTTP ${statusCode}`);
    this.name = 'HttpStatusError';
    this.statusCode = statusCode;

    if (retryAfterMs !== undefined) {
      this.retryAfterMs = retryAfterMs;
    }
  }
}

export class ResponseContentMismatchError extends Error {
  readonly expected: string;
  readonly actual: string;
  readonly retryable: boolean;

  constructor(expected: string, actual: string, retryable = false) {
    super(`Downloaded response content is incompatible with ${expected}: received ${actual}`);
    this.name = 'ResponseContentMismatchError';
    this.expected = expected;
    this.actual = actual;
    this.retryable = retryable;
  }
}

export function createAbortError(message = 'The operation was aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown mirror error';
}
