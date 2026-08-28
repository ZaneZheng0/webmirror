import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createZstdDecompress,
} from 'node:zlib';

import {
  cacheMetadataFromHeaders,
  ContentAddressedCache,
  type ContentCacheLookup,
} from './cache.js';
import {
  createAbortError,
  DownloadSizeLimitError,
  DownloadTimeoutError,
  HttpStatusError,
  isAbortError,
  MirrorSecurityError,
  ResponseContentMismatchError,
} from './errors.js';
import { contentTypeForPath, normalizeContentType } from './mime.js';
import { resolveDownloadTarget } from './network-policy.js';
import type { DownloadResourceOptions, DownloadResourceResult } from './types.js';
import { canonicalizeResourceUrl, resolvePathInsideRoot } from './url-mapper.js';

const retryableStatusCodes = new Set([408, 425, 429, 500, 502, 503, 504]);
const retryableNetworkCodes = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
]);
const redirectStatusCodes = new Set([301, 302, 303, 307, 308]);
const defaultMaximumResourceBytes = 512 * 1024 * 1024;
const absoluteMaximumResourceBytes = 8 * 1024 * 1024 * 1024;

interface OpenResponseResult {
  response: IncomingMessage;
  finalUrl: string;
}

interface DownloadAttemptOptions {
  rootDirectory: string;
  localPath: string;
  expectedContentType?: string;
  expectedResourceType?: string;
  timeoutMs: number;
  maxRedirects: number;
  maxBytes: number;
  allowPrivateNetwork: boolean;
  requestHeaders?: Readonly<Record<string, string>>;
  allowNotModified?: boolean;
  signal?: AbortSignal;
}

type ResourceKind =
  | 'binary'
  | 'document'
  | 'font'
  | 'image'
  | 'media'
  | 'model'
  | 'script'
  | 'stylesheet'
  | 'structured'
  | 'text'
  | 'unknown'
  | 'wasm';

interface ExpectedResourceShape {
  localPath: string;
  expectedContentType?: string;
  expectedResourceType?: string;
}

const scriptContentTypes = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
]);

const structuredContentTypes = new Set([
  'application/json',
  'application/ld+json',
  'application/manifest+json',
  'application/xml',
  'text/xml',
]);

const textApplicationContentTypes = new Set([
  'application/srt',
  'application/x-srt',
  'application/x-subrip',
]);

function resourceKindForContentType(contentType: string | undefined): ResourceKind {
  const normalized = normalizeContentType(contentType);

  if (!normalized) {
    return 'unknown';
  }

  if (normalized === 'text/html' || normalized === 'application/xhtml+xml') {
    return 'document';
  }

  if (scriptContentTypes.has(normalized)) {
    return 'script';
  }

  if (normalized === 'text/css') {
    return 'stylesheet';
  }

  if (structuredContentTypes.has(normalized) || normalized.endsWith('+json')) {
    return 'structured';
  }

  if (textApplicationContentTypes.has(normalized)) {
    return 'text';
  }

  if (normalized.startsWith('image/')) {
    return 'image';
  }

  if (
    normalized.startsWith('font/') ||
    normalized.startsWith('application/font-') ||
    normalized === 'application/vnd.ms-fontobject'
  ) {
    return 'font';
  }

  if (normalized.startsWith('audio/') || normalized.startsWith('video/')) {
    return 'media';
  }

  if (normalized === 'application/wasm') {
    return 'wasm';
  }

  if (normalized === 'model/gltf-binary') {
    return 'model';
  }

  if (normalized.startsWith('text/')) {
    return 'text';
  }

  if (normalized === 'application/octet-stream') {
    return 'unknown';
  }

  return normalized.startsWith('application/') || normalized.startsWith('model/')
    ? 'binary'
    : 'unknown';
}

function resourceKindForPath(localPath: string): ResourceKind {
  switch (extname(localPath).toLowerCase()) {
    case '.cjs':
    case '.js':
    case '.mjs':
      return 'script';
    case '.css':
      return 'stylesheet';
    case '.gltf':
    case '.json':
    case '.map':
    case '.webmanifest':
    case '.xml':
      return 'structured';
    case '.html':
    case '.htm':
      return 'document';
    case '.avif':
    case '.bmp':
    case '.dds':
    case '.gif':
    case '.hdr':
    case '.ico':
    case '.jpeg':
    case '.jpg':
    case '.ktx':
    case '.ktx2':
    case '.png':
    case '.svg':
    case '.webp':
      return 'image';
    case '.eot':
    case '.otf':
    case '.ttf':
    case '.woff':
    case '.woff2':
      return 'font';
    case '.aac':
    case '.flac':
    case '.m4a':
    case '.m4v':
    case '.mov':
    case '.mp3':
    case '.mp4':
    case '.oga':
    case '.ogg':
    case '.ogv':
    case '.opus':
    case '.wav':
    case '.webm':
      return 'media';
    case '.wasm':
      return 'wasm';
    case '.glb':
      return 'model';
    case '.basis':
    case '.bin':
    case '.csv':
    case '.dae':
    case '.drc':
    case '.fbx':
    case '.pack':
    case '.pdf':
    case '.pvr':
    case '.riv':
    case '.zip':
      return 'binary';
    case '.frag':
    case '.glsl':
    case '.srt':
    case '.txt':
    case '.vert':
    case '.vtt':
      return 'text';
    default:
      return 'unknown';
  }
}

function strongResourceKindForPath(localPath: string): ResourceKind | undefined {
  const kind = resourceKindForPath(localPath);

  if (kind === 'unknown') {
    return undefined;
  }

  if (kind !== 'binary') {
    return kind;
  }

  // Generic containers such as .bin are intentionally weak evidence because
  // they are often used for JSON or other runtime-defined payloads. These
  // formats, however, have a stable non-HTML representation and must not be
  // satisfied by an application-shell fallback.
  return ['.pack', '.pdf', '.zip'].includes(extname(localPath).toLowerCase())
    ? 'binary'
    : undefined;
}

function resourceKindForExpected(options: ExpectedResourceShape): ResourceKind {
  const resourceType = options.expectedResourceType?.trim().toLowerCase();
  const pathKind = resourceKindForPath(options.localPath);
  const strongPathKind = strongResourceKindForPath(options.localPath);
  const contentTypeKind = resourceKindForContentType(options.expectedContentType);

  switch (resourceType) {
    case 'document':
      // CDP reports every top-level navigation as Document, including PDF and
      // other directly opened static files. Preserve stronger non-document
      // evidence instead of accepting an HTML SPA shell for those URLs.
      return strongPathKind && strongPathKind !== 'document'
        ? strongPathKind
        : contentTypeKind !== 'unknown' && contentTypeKind !== 'document'
          ? contentTypeKind
          : 'document';
    case 'font':
      return 'font';
    case 'image':
      return 'image';
    case 'media':
      return 'media';
    case 'texttrack':
      return 'text';
    case 'manifest':
      return 'structured';
    case 'script':
    case 'worker':
      return 'script';
    case 'stylesheet':
      return 'stylesheet';
  }

  if (strongPathKind) {
    return strongPathKind;
  }

  if (contentTypeKind !== 'unknown') {
    return contentTypeKind;
  }

  return pathKind;
}

function isNonDocumentKind(kind: ResourceKind): boolean {
  return kind !== 'document' && kind !== 'unknown';
}

function isTextLikeKind(kind: ResourceKind): boolean {
  return kind === 'script' || kind === 'stylesheet' || kind === 'structured' || kind === 'text';
}

function isCompatibleResourceKind(expected: ResourceKind, actual: ResourceKind): boolean {
  if (actual === 'unknown') {
    return true;
  }

  if (expected === actual) {
    return true;
  }

  if (actual === 'text' && isTextLikeKind(expected)) {
    return true;
  }

  if (actual === 'structured' && expected === 'text') {
    return true;
  }

  if (
    actual === 'binary' &&
    ['binary', 'font', 'image', 'media', 'model', 'wasm'].includes(expected)
  ) {
    return true;
  }

  return false;
}

function preferredContentType(
  options: ExpectedResourceShape,
  expectedKind: ResourceKind,
  declaredContentType: string | undefined,
): string {
  const declaredKind = resourceKindForContentType(declaredContentType);

  if (declaredKind === 'unknown') {
    return options.expectedContentType ?? contentTypeForPath(options.localPath);
  }

  if (declaredKind === 'text' && isTextLikeKind(expectedKind)) {
    return options.expectedContentType ?? contentTypeForPath(options.localPath);
  }

  return declaredContentType ?? contentTypeForPath(options.localPath);
}

async function bodyStartsWithHtmlDocument(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r');

  try {
    const buffer = Buffer.alloc(8 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const prefix = buffer
      .subarray(0, bytesRead)
      .toString('utf8')
      .replace(/^\uFEFF/u, '')
      .trimStart();
    return /^(?:<!--[\s\S]{0,512}?-->\s*)*<(?:!doctype\s+html|html|head|body)\b/iu.test(prefix);
  } finally {
    await handle.close();
  }
}

async function compatibleResponseContentType(
  filePath: string,
  options: ExpectedResourceShape,
  declaredContentType: string | undefined,
  effectiveContentType: string,
): Promise<string> {
  const expectedKind = resourceKindForExpected(options);

  if (!isNonDocumentKind(expectedKind)) {
    return effectiveContentType;
  }

  const expected =
    options.expectedResourceType ??
    normalizeContentType(options.expectedContentType) ??
    (extname(options.localPath).toLowerCase() || 'non-document resource');
  const bodyIsHtml = await bodyStartsWithHtmlDocument(filePath);

  if (bodyIsHtml) {
    throw new ResponseContentMismatchError(
      expected,
      `${normalizeContentType(effectiveContentType) ?? 'unknown MIME'} HTML body`,
      true,
    );
  }

  const declaredKind = resourceKindForContentType(declaredContentType);

  if (!isCompatibleResourceKind(expectedKind, declaredKind)) {
    throw new ResponseContentMismatchError(
      expected,
      normalizeContentType(declaredContentType) ?? 'unknown MIME',
    );
  }

  return preferredContentType(options, expectedKind, declaredContentType);
}

type DownloadAttemptResult =
  | {
      kind: 'downloaded';
      result: Omit<DownloadResourceResult, 'attempts'>;
    }
  | {
      kind: 'not_modified';
      finalUrl: string;
      headers: IncomingMessage['headers'];
    };

class HashingTransform extends Transform {
  readonly #hash = createHash('sha256');
  readonly #maximumBytes: number;
  #size = 0;

  constructor(maximumBytes: number) {
    super();
    this.#maximumBytes = maximumBytes;
  }

  get size(): number {
    return this.#size;
  }

  digest(): string {
    return this.#hash.digest('hex');
  }

  override _transform(chunk: unknown, encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk, encoding)
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : undefined;

      if (!buffer) {
        callback(new TypeError('Unexpected response stream chunk'));
        return;
      }

      if (this.#size + buffer.byteLength > this.#maximumBytes) {
        callback(new DownloadSizeLimitError(this.#maximumBytes, this.#size + buffer.byteLength));
        return;
      }

      this.#hash.update(buffer);
      this.#size += buffer.byteLength;
      callback(null, buffer);
    } catch (error) {
      callback(error instanceof Error ? error : new Error('Could not hash response data'));
    }
  }
}

function positiveByteLimit(value: number | undefined): number {
  const normalized = value ?? defaultMaximumResourceBytes;

  if (
    !Number.isSafeInteger(normalized) ||
    normalized <= 0 ||
    normalized > absoluteMaximumResourceBytes
  ) {
    throw new RangeError(
      `maxBytes must be an integer between 1 and ${absoluteMaximumResourceBytes}, received ${normalized}`,
    );
  }

  return normalized;
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`Expected an integer between 0 and ${maximum}, received ${value}`);
  }

  return value;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function responseCacheHeaders(headers: IncomingMessage['headers']): {
  etag?: string;
  'last-modified'?: string;
  'cache-control'?: string;
  expires?: string;
  date?: string;
  age?: string;
  vary?: string;
  'set-cookie'?: string[];
} {
  const etag = headerValue(headers.etag);
  const lastModified = headerValue(headers['last-modified']);
  const cacheControl = headerValue(headers['cache-control']);
  const expires = headerValue(headers.expires);
  const date = headerValue(headers.date);
  const age = headerValue(headers.age);
  const vary = headerValue(headers.vary);

  return {
    ...(etag ? { etag } : {}),
    ...(lastModified ? { 'last-modified': lastModified } : {}),
    ...(cacheControl ? { 'cache-control': cacheControl } : {}),
    ...(expires ? { expires } : {}),
    ...(date ? { date } : {}),
    ...(age ? { age } : {}),
    ...(vary ? { vary } : {}),
    ...(headers['set-cookie'] ? { 'set-cookie': headers['set-cookie'] } : {}),
  };
}

function contentLength(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/u.test(value)) {
    return undefined;
  }

  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}

function contentDecoders(contentEncoding: string | undefined): Transform[] {
  const encodings = (contentEncoding ?? '')
    .split(',')
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding && encoding !== 'identity');
  const decoders: Transform[] = [];

  for (const encoding of encodings.reverse()) {
    switch (encoding) {
      case 'gzip':
      case 'x-gzip':
        decoders.push(createGunzip());
        break;
      case 'deflate':
        decoders.push(createInflate());
        break;
      case 'br':
        decoders.push(createBrotliDecompress());
        break;
      case 'zstd':
        decoders.push(createZstdDecompress());
        break;
      default:
        throw new Error(`Unsupported HTTP content encoding: ${encoding}`);
    }
  }

  return decoders;
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number.parseInt(value, 10);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, 30_000);
  }

  const date = Date.parse(value);

  if (Number.isNaN(date)) {
    return undefined;
  }

  return Math.min(Math.max(0, date - Date.now()), 30_000);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function createAttemptController(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): {
  controller: AbortController;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort();

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', abort, { once: true });
    }
  }

  return {
    controller,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    },
  };
}

function wait(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      reject(createAbortError());
    };

    signal?.addEventListener('abort', abort, { once: true });
  });
}

function requestResponse(
  url: URL,
  options: RequestOptions,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request =
      url.protocol === 'https:'
        ? httpsRequest(url, options, resolve)
        : httpRequest(url, options, resolve);

    request.once('error', reject);
    signal.addEventListener(
      'abort',
      () => {
        request.destroy(createAbortError());
      },
      { once: true },
    );
    request.end();
  });
}

async function assertSafeWriteDirectory(
  rootDirectory: string,
  targetDirectory: string,
): Promise<void> {
  const root = resolve(rootDirectory);
  const relativeDirectory = relative(root, resolve(targetDirectory));
  const segments = relativeDirectory ? relativeDirectory.split(sep) : [];
  let current = root;

  for (const segment of ['', ...segments]) {
    if (segment) {
      current = join(current, segment);
    }

    try {
      const metadata = await lstat(current);

      if (metadata.isSymbolicLink()) {
        throw new MirrorSecurityError(
          'SYMLINK_PATH',
          'Download paths must not traverse symbolic links or junctions',
        );
      }

      if (!metadata.isDirectory()) {
        throw new MirrorSecurityError(
          'INVALID_LOCAL_PATH',
          'Download path contains a non-directory component',
        );
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        break;
      }

      throw error;
    }
  }
}

async function openResponse(
  value: string,
  signal: AbortSignal,
  allowPrivateNetwork: boolean,
  redirectsRemaining: number,
  requestHeaders: Readonly<Record<string, string>>,
): Promise<OpenResponseResult> {
  const target = await resolveDownloadTarget(value, allowPrivateNetwork);
  throwIfAborted(signal);

  const response = await requestResponse(
    target.url,
    {
      method: 'GET',
      headers: {
        accept: '*/*',
        'accept-encoding': 'identity',
        ...requestHeaders,
      },
      lookup: target.lookup,
      signal,
    },
    signal,
  );
  const statusCode = response.statusCode ?? 0;
  const location = headerValue(response.headers.location);

  if (redirectStatusCodes.has(statusCode) && location) {
    response.destroy();

    if (redirectsRemaining <= 0) {
      throw new Error('Maximum redirect count exceeded');
    }

    const redirectUrl = new URL(location, target.url).toString();
    return openResponse(redirectUrl, signal, allowPrivateNetwork, redirectsRemaining - 1, {});
  }

  return {
    response,
    finalUrl: target.url.toString(),
  };
}

function errorCode(error: unknown, seen = new Set<unknown>()): string | undefined {
  if (!error || (typeof error !== 'object' && typeof error !== 'function') || seen.has(error)) {
    return undefined;
  }

  seen.add(error);

  if ('code' in error && typeof error.code === 'string') {
    return error.code;
  }

  if (error instanceof AggregateError) {
    for (const nestedError of error.errors) {
      const nestedCode = errorCode(nestedError, seen);

      if (nestedCode) {
        return nestedCode;
      }
    }
  }

  return 'cause' in error ? errorCode(error.cause, seen) : undefined;
}

export function isRetryableDownloadError(error: unknown): boolean {
  if (error instanceof ResponseContentMismatchError) {
    return error.retryable;
  }

  if (error instanceof HttpStatusError) {
    return retryableStatusCodes.has(error.statusCode);
  }

  if (error instanceof DownloadTimeoutError) {
    return true;
  }

  if (error instanceof MirrorSecurityError || isAbortError(error)) {
    return false;
  }

  const code = errorCode(error);
  return code !== undefined && retryableNetworkCodes.has(code);
}

function retryJitterMs(canonicalUrl: string, attemptNumber: number, retryDelayMs: number): number {
  const maximumJitter = Math.min(250, retryDelayMs);

  if (maximumJitter <= 0) {
    return 0;
  }

  const digest = createHash('sha256')
    .update(canonicalUrl)
    .update('\0')
    .update(String(attemptNumber))
    .digest();
  return (digest.readUInt16BE(0) % maximumJitter) + 1;
}

async function replaceFile(tempPath: string, destinationPath: string): Promise<void> {
  try {
    await rename(tempPath, destinationPath);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }

    await rm(destinationPath, { force: true });
    await rename(tempPath, destinationPath);
  }
}

async function downloadAttempt(
  sourceUrl: string,
  options: DownloadAttemptOptions,
): Promise<DownloadAttemptResult> {
  const destinationPath = resolvePathInsideRoot(options.rootDirectory, options.localPath);
  await assertSafeWriteDirectory(options.rootDirectory, dirname(destinationPath));
  await mkdir(dirname(destinationPath), { recursive: true });
  await assertSafeWriteDirectory(options.rootDirectory, dirname(destinationPath));

  const tempPath = `${destinationPath}.part-${randomUUID()}`;
  const attempt = createAttemptController(options.signal, options.timeoutMs);
  let committed = false;

  try {
    const { response, finalUrl } = await openResponse(
      sourceUrl,
      attempt.controller.signal,
      options.allowPrivateNetwork,
      options.maxRedirects,
      options.requestHeaders ?? {},
    );
    const statusCode = response.statusCode ?? 0;

    if (statusCode === 304 && options.allowNotModified) {
      response.destroy();
      return {
        kind: 'not_modified',
        finalUrl,
        headers: response.headers,
      };
    }

    if (statusCode < 200 || statusCode >= 300) {
      const retryAfterMs = parseRetryAfter(headerValue(response.headers['retry-after']));
      response.destroy();
      throw new HttpStatusError(statusCode, retryAfterMs);
    }

    const declaredLength = contentLength(headerValue(response.headers['content-length']));

    if (declaredLength !== undefined && declaredLength > options.maxBytes) {
      response.destroy();
      throw new DownloadSizeLimitError(options.maxBytes, declaredLength);
    }

    let decoders: Transform[];

    try {
      decoders = contentDecoders(headerValue(response.headers['content-encoding']));
    } catch (error) {
      response.destroy();
      throw error;
    }

    const hashingStream = new HashingTransform(options.maxBytes);
    await pipeline(
      [response, ...decoders, hashingStream, createWriteStream(tempPath, { flags: 'wx' })],
      {
        signal: attempt.controller.signal,
      },
    );
    const sha256 = hashingStream.digest();
    const declaredContentType = headerValue(response.headers['content-type']);
    const contentType = await compatibleResponseContentType(
      tempPath,
      options,
      declaredContentType,
      declaredContentType ?? contentTypeForPath(options.localPath),
    );
    await replaceFile(tempPath, destinationPath);
    committed = true;
    return {
      kind: 'downloaded',
      result: {
        sourceUrl,
        finalUrl,
        localPath: options.localPath,
        contentType,
        httpStatus: statusCode,
        size: hashingStream.size,
        sha256,
        bodySource: 'network',
        cacheCandidate: cacheMetadataFromHeaders(
          finalUrl,
          contentType,
          statusCode,
          hashingStream.size,
          sha256,
          responseCacheHeaders(response.headers),
        ),
      },
    };
  } catch (error) {
    if (options.signal?.aborted) {
      throw createAbortError();
    }

    if (attempt.didTimeout()) {
      throw new DownloadTimeoutError(options.timeoutMs);
    }

    throw error;
  } finally {
    attempt.cleanup();

    if (!committed) {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

async function verifiedLocalBodyAttempt(
  sourceUrl: string,
  options: DownloadResourceOptions,
  maximumBytes: number,
  body: NonNullable<DownloadResourceOptions['capturedBody']>,
  bodySource: DownloadResourceResult['bodySource'],
  attempts: number,
  finalUrl = sourceUrl,
): Promise<DownloadResourceResult> {
  if (
    !isAbsolute(body.filePath) ||
    !Number.isSafeInteger(body.byteLength) ||
    body.byteLength < 0 ||
    body.byteLength > maximumBytes ||
    !/^[a-f0-9]{64}$/u.test(body.sha256)
  ) {
    throw new Error('The local response body descriptor is invalid.');
  }

  throwIfAborted(options.signal);
  const metadata = await lstat(body.filePath);

  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new MirrorSecurityError('SYMLINK_PATH', 'Local response bodies must be regular files');
  }

  if (metadata.size !== body.byteLength) {
    throw new Error('The local response body changed before it could be mirrored.');
  }

  const destinationPath = resolvePathInsideRoot(options.rootDirectory, options.localPath);
  await assertSafeWriteDirectory(options.rootDirectory, dirname(destinationPath));
  await mkdir(dirname(destinationPath), { recursive: true });
  await assertSafeWriteDirectory(options.rootDirectory, dirname(destinationPath));
  const tempPath = `${destinationPath}.part-${randomUUID()}`;
  let committed = false;

  try {
    const hashingStream = new HashingTransform(maximumBytes);
    const source = createReadStream(body.filePath);
    const destination = createWriteStream(tempPath, { flags: 'wx' });

    if (options.signal) {
      await pipeline(source, hashingStream, destination, { signal: options.signal });
    } else {
      await pipeline(source, hashingStream, destination);
    }
    const sha256 = hashingStream.digest();

    if (hashingStream.size !== body.byteLength || sha256 !== body.sha256) {
      throw new Error('The local response body failed integrity verification.');
    }

    const contentType = await compatibleResponseContentType(
      tempPath,
      options,
      body.contentType,
      body.contentType ?? contentTypeForPath(options.localPath),
    );
    await replaceFile(tempPath, destinationPath);
    committed = true;
    return {
      sourceUrl,
      finalUrl,
      localPath: options.localPath,
      contentType,
      httpStatus: body.httpStatus ?? 200,
      size: hashingStream.size,
      sha256,
      attempts,
      bodySource,
    };
  } finally {
    if (!committed) {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

async function capturedBodyAttempt(
  sourceUrl: string,
  options: DownloadResourceOptions,
  maximumBytes: number,
): Promise<DownloadResourceResult> {
  const capturedBody = options.capturedBody;

  if (!capturedBody) {
    throw new Error('A captured response body was not provided.');
  }

  return verifiedLocalBodyAttempt(sourceUrl, options, maximumBytes, capturedBody, 'browser', 1);
}

async function cachedBodyAttempt(
  sourceUrl: string,
  options: DownloadResourceOptions,
  maximumBytes: number,
  cached: ContentCacheLookup,
  bodySource: 'cache' | 'cache_revalidated',
  attempts: number,
): Promise<DownloadResourceResult> {
  return verifiedLocalBodyAttempt(
    sourceUrl,
    options,
    maximumBytes,
    {
      filePath: cached.objectPath,
      byteLength: cached.entry.object.size,
      sha256: cached.entry.object.sha256,
      contentType: cached.entry.representation.contentType,
      httpStatus: cached.entry.representation.httpStatus,
    },
    bodySource,
    attempts,
  );
}

async function downloadResourceWithNetworkPolicy(
  sourceUrl: string,
  options: DownloadResourceOptions,
  allowPrivateNetwork: boolean,
): Promise<DownloadResourceResult> {
  const canonicalUrl = canonicalizeResourceUrl(sourceUrl);
  const timeoutMs = positiveInteger(options.timeoutMs, 30_000, 600_000);
  const maxRetries = positiveInteger(options.maxRetries, 2, 10);
  const retryDelayMs = positiveInteger(options.retryDelayMs, 250, 30_000);
  const maxRedirects = positiveInteger(options.maxRedirects, 5, 20);
  const maxBytes = positiveByteLimit(options.maxBytes);

  if (
    options.expectedSize !== undefined &&
    (!Number.isFinite(options.expectedSize) || options.expectedSize < 0)
  ) {
    throw new RangeError('expectedSize must be a finite non-negative number');
  }

  if (options.expectedSize !== undefined && options.expectedSize > maxBytes) {
    throw new DownloadSizeLimitError(maxBytes, options.expectedSize);
  }

  const capturedBody = options.capturedBody;
  let capturedBodyRejectedAsIncompatible = false;
  const cache =
    !capturedBody && options.cacheDirectory
      ? new ContentAddressedCache(options.cacheDirectory)
      : undefined;

  if (capturedBody) {
    try {
      return await capturedBodyAttempt(canonicalUrl, options, maxBytes);
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) {
        throw createAbortError();
      }

      if (error instanceof ResponseContentMismatchError) {
        capturedBodyRejectedAsIncompatible = true;
      }

      if (
        !Number.isSafeInteger(capturedBody.byteLength) ||
        capturedBody.byteLength < 0 ||
        capturedBody.byteLength > maxBytes ||
        !/^[a-f0-9]{64}$/u.test(capturedBody.sha256)
      ) {
        throw error;
      }
    }
  }

  let cached = cache ? await cache.lookup(canonicalUrl) : undefined;

  if (cached && cache?.isFresh(cached.entry)) {
    try {
      return await cachedBodyAttempt(canonicalUrl, options, maxBytes, cached, 'cache', 0);
    } catch {
      await cache.invalidate(canonicalUrl);
      cached = undefined;
    }
  }

  let requestHeaders: Readonly<Record<string, string>> = {};

  if (cached?.entry.validators.etag) {
    requestHeaders = {
      ...requestHeaders,
      'if-none-match': cached.entry.validators.etag,
    };
  }

  if (cached?.entry.validators.lastModified) {
    requestHeaders = {
      ...requestHeaders,
      'if-modified-since': cached.entry.validators.lastModified,
    };
  }

  let lastError: unknown;

  for (let attemptNumber = 1; attemptNumber <= maxRetries + 1; attemptNumber += 1) {
    throwIfAborted(options.signal);

    try {
      let attemptResult = await downloadAttempt(canonicalUrl, {
        rootDirectory: options.rootDirectory,
        localPath: options.localPath,
        ...(options.expectedContentType
          ? { expectedContentType: options.expectedContentType }
          : {}),
        ...(options.expectedResourceType
          ? { expectedResourceType: options.expectedResourceType }
          : {}),
        timeoutMs,
        maxRedirects,
        maxBytes,
        allowPrivateNetwork,
        ...(Object.keys(requestHeaders).length > 0 ? { requestHeaders } : {}),
        ...(cached && Object.keys(requestHeaders).length > 0 ? { allowNotModified: true } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });

      if (attemptResult.kind === 'not_modified') {
        if (!cached || !cache) {
          throw new Error('The server returned 304 without a usable cache entry.');
        }

        try {
          const cachedResult = await cachedBodyAttempt(
            canonicalUrl,
            options,
            maxBytes,
            cached,
            'cache_revalidated',
            attemptNumber,
          );
          await cache.refresh(
            canonicalUrl,
            cached.entry,
            cacheMetadataFromHeaders(
              attemptResult.finalUrl,
              cached.entry.representation.contentType,
              cached.entry.representation.httpStatus,
              cached.entry.object.size,
              cached.entry.object.sha256,
              responseCacheHeaders(attemptResult.headers),
            ),
          );
          return cachedResult;
        } catch {
          await cache.invalidate(canonicalUrl);
          cached = undefined;
          requestHeaders = {};
          attemptResult = await downloadAttempt(canonicalUrl, {
            rootDirectory: options.rootDirectory,
            localPath: options.localPath,
            ...(options.expectedContentType
              ? { expectedContentType: options.expectedContentType }
              : {}),
            ...(options.expectedResourceType
              ? { expectedResourceType: options.expectedResourceType }
              : {}),
            timeoutMs,
            maxRedirects,
            maxBytes,
            allowPrivateNetwork,
            ...(options.signal ? { signal: options.signal } : {}),
          });
        }
      }

      if (attemptResult.kind !== 'downloaded') {
        throw new Error('The unconditional cache refresh returned HTTP 304.');
      }

      const downloaded = attemptResult.result;

      if (
        capturedBody &&
        !capturedBodyRejectedAsIncompatible &&
        (downloaded.size !== capturedBody.byteLength || downloaded.sha256 !== capturedBody.sha256)
      ) {
        await rm(resolvePathInsideRoot(options.rootDirectory, options.localPath), {
          force: true,
        }).catch(() => undefined);
        throw new Error(
          'The credential-free network response did not match the captured browser response body.',
        );
      }

      if (capturedBody) {
        const { cacheCandidate: _cacheCandidate, ...withoutCacheCandidate } = downloaded;
        return {
          ...withoutCacheCandidate,
          attempts: attemptNumber,
          bodySource: capturedBodyRejectedAsIncompatible ? 'network' : 'network_verified',
        };
      }

      return {
        ...downloaded,
        attempts: attemptNumber,
      };
    } catch (error) {
      lastError = error;

      if (attemptNumber > maxRetries || !isRetryableDownloadError(error)) {
        throw error;
      }

      const requestedDelay =
        error instanceof HttpStatusError && error.retryAfterMs !== undefined
          ? error.retryAfterMs
          : retryDelayMs * 2 ** (attemptNumber - 1);
      const jitter = retryJitterMs(canonicalUrl, attemptNumber, retryDelayMs);
      await wait(Math.min(requestedDelay + jitter, 30_000), options.signal);
    }
  }

  throw lastError;
}

export function downloadResource(
  sourceUrl: string,
  options: DownloadResourceOptions,
): Promise<DownloadResourceResult> {
  return downloadResourceWithNetworkPolicy(sourceUrl, options, false);
}

export function downloadResourceForTesting(
  sourceUrl: string,
  options: DownloadResourceOptions,
): Promise<DownloadResourceResult> {
  return downloadResourceWithNetworkPolicy(sourceUrl, options, true);
}
