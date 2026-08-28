import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { isSensitiveQueryName } from '@webmirror/shared';

import { createAbortError } from './errors.js';

export const contentCacheSchemaVersion = 1 as const;
const cacheVariant = 'accept=*/*;accept-encoding=identity';
const maximumValidatorLength = 4_096;
const maximumContentTypeLength = 256;
const lockAttempts = 40;
const lockDelayMs = 25;
const staleLockMs = 5 * 60_000;
const staleTemporaryFileMs = 60 * 60_000;

export interface CacheResponseMetadata {
  finalUrl: string;
  contentType: string;
  httpStatus: number;
  size: number;
  sha256: string;
  etag?: string;
  lastModified?: string;
  cacheControl?: string;
  expires?: string;
  date?: string;
  age?: string;
  vary?: string;
  hasSetCookie?: boolean;
}

export interface ContentCacheEntry {
  schemaVersion: typeof contentCacheSchemaVersion;
  urlKey: string;
  finalUrlKey: string;
  variant: typeof cacheVariant;
  object: {
    sha256: string;
    size: number;
  };
  representation: {
    contentType: string;
    httpStatus: number;
  };
  validators: {
    etag?: string;
    lastModified?: string;
  };
  policy: {
    freshUntil?: string;
    revalidateAlways: boolean;
    vary: string[];
  };
  storedAt: string;
  validatedAt: string;
  secretScanPolicyVersion: 1;
}

export interface ContentCacheLookup {
  entry: ContentCacheEntry;
  objectPath: string;
}

export interface VerifiedFileCopy {
  size: number;
  sha256: string;
}

interface CacheLock {
  handle: FileHandle;
  token: string;
}

class CacheHashingTransform extends Transform {
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
    const value = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk, encoding)
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : undefined;

    if (!value) {
      callback(new TypeError('Unexpected cache file chunk.'));
      return;
    }

    if (this.#size + value.byteLength > this.#maximumBytes) {
      callback(new Error(`Cache object exceeds the ${this.#maximumBytes}-byte limit.`));
      return;
    }

    this.#hash.update(value);
    this.#size += value.byteLength;
    callback(null, value);
  }
}

function isSafeHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isSafeValidator(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumValidatorLength &&
    !hasControlCharacter(value)
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function safeContentType(value: string): string {
  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= maximumContentTypeLength &&
    !hasControlCharacter(normalized)
    ? normalized
    : 'application/octet-stream';
}

function urlKeyFor(url: string): string {
  return createHash('sha256').update(url, 'utf8').digest('hex');
}

function objectPathFor(rootDirectory: string, sha256: string): string {
  return join(rootDirectory, 'objects', 'sha256', sha256.slice(0, 2), sha256);
}

function entryPathFor(rootDirectory: string, urlKey: string): string {
  return join(rootDirectory, 'entries', 'url-sha256', urlKey.slice(0, 2), `${urlKey}.json`);
}

function lockPathFor(rootDirectory: string, urlKey: string): string {
  return join(rootDirectory, 'locks', `${urlKey}.lock`);
}

function objectLockPathFor(rootDirectory: string, sha256: string): string {
  return join(rootDirectory, 'locks', 'objects', `${sha256}.lock`);
}

function temporaryPath(directory: string, name: string): string {
  return join(directory, `.${name}.${process.pid}.${randomUUID()}.tmp`);
}

function parseCacheControl(value: string | undefined): {
  directives: Map<string, string | true>;
  noStore: boolean;
  isPrivate: boolean;
  revalidateAlways: boolean;
  maxAgeSeconds?: number;
} {
  const directives = new Map<string, string | true>();

  for (const rawDirective of (value ?? '').split(',')) {
    const [rawName, ...rawValue] = rawDirective.trim().split('=');
    const name = rawName?.toLowerCase();

    if (!name) {
      continue;
    }

    const valuePart = rawValue
      .join('=')
      .trim()
      .replace(/^"(.*)"$/u, '$1');
    directives.set(name, valuePart || true);
  }

  const maxAgeValue = directives.get('max-age');
  const parsedMaxAge =
    typeof maxAgeValue === 'string' && /^\d+$/u.test(maxAgeValue) ? Number(maxAgeValue) : undefined;

  return {
    directives,
    noStore: directives.has('no-store'),
    isPrivate: directives.has('private'),
    revalidateAlways:
      directives.has('no-cache') ||
      directives.has('must-revalidate') ||
      directives.has('proxy-revalidate') ||
      parsedMaxAge === 0,
    ...(parsedMaxAge !== undefined && Number.isSafeInteger(parsedMaxAge)
      ? { maxAgeSeconds: parsedMaxAge }
      : {}),
  };
}

function parseVary(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function unsupportedVary(vary: readonly string[]): boolean {
  return vary.some((value) => value !== 'accept-encoding');
}

function hasSensitiveQuery(url: string): boolean {
  try {
    const parsed = new URL(url);
    return [...parsed.searchParams.keys()].some(isSensitiveQueryName);
  } catch {
    return true;
  }
}

function cachePolicy(
  metadata: CacheResponseMetadata,
  now: Date,
): {
  cacheable: boolean;
  freshUntil?: string;
  revalidateAlways: boolean;
  vary: string[];
} {
  const cacheControl = parseCacheControl(metadata.cacheControl);
  const vary = parseVary(metadata.vary);

  if (
    metadata.httpStatus !== 200 ||
    metadata.hasSetCookie === true ||
    cacheControl.noStore ||
    cacheControl.isPrivate ||
    unsupportedVary(vary)
  ) {
    return {
      cacheable: false,
      revalidateAlways: true,
      vary,
    };
  }

  let freshUntil: Date | undefined;

  if (cacheControl.maxAgeSeconds !== undefined) {
    const responseDate = metadata.date ? Date.parse(metadata.date) : Number.NaN;
    const apparentAgeMs = Number.isNaN(responseDate)
      ? 0
      : Math.max(0, now.getTime() - responseDate);
    const ageSeconds = metadata.age && /^\d+$/u.test(metadata.age) ? Number(metadata.age) : 0;
    const currentAgeMs = Math.max(
      apparentAgeMs,
      Number.isFinite(ageSeconds) ? ageSeconds * 1_000 : 0,
    );
    const remainingMs = Math.max(0, cacheControl.maxAgeSeconds * 1_000 - currentAgeMs);
    freshUntil = new Date(now.getTime() + remainingMs);
  } else if (metadata.expires) {
    const expires = Date.parse(metadata.expires);

    if (!Number.isNaN(expires)) {
      freshUntil = new Date(expires);
    }
  }

  return {
    cacheable: true,
    ...(freshUntil ? { freshUntil: freshUntil.toISOString() } : {}),
    revalidateAlways: cacheControl.revalidateAlways || freshUntil === undefined,
    vary,
  };
}

function buildEntry(
  canonicalUrl: string,
  metadata: CacheResponseMetadata,
  now: Date,
  existing?: ContentCacheEntry,
): ContentCacheEntry | undefined {
  const policy = cachePolicy(metadata, now);

  if (
    !isSafeHttpUrl(canonicalUrl) ||
    !isSafeHttpUrl(metadata.finalUrl) ||
    !isSafeHash(metadata.sha256) ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 0 ||
    !Number.isSafeInteger(metadata.httpStatus)
  ) {
    return undefined;
  }

  const urlKey = urlKeyFor(canonicalUrl);
  const finalUrlKey = urlKeyFor(metadata.finalUrl);

  if (!policy.cacheable || finalUrlKey !== urlKey) {
    return undefined;
  }

  const etag = isSafeValidator(metadata.etag) ? metadata.etag : existing?.validators.etag;
  const lastModified = isSafeValidator(metadata.lastModified)
    ? metadata.lastModified
    : existing?.validators.lastModified;

  return {
    schemaVersion: contentCacheSchemaVersion,
    urlKey: `sha256:${urlKey}`,
    finalUrlKey: `sha256:${finalUrlKey}`,
    variant: cacheVariant,
    object: {
      sha256: metadata.sha256,
      size: metadata.size,
    },
    representation: {
      contentType: safeContentType(metadata.contentType),
      httpStatus: metadata.httpStatus,
    },
    validators: {
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
    },
    policy: {
      ...(policy.freshUntil
        ? { freshUntil: policy.freshUntil }
        : existing?.policy.freshUntil
          ? { freshUntil: existing.policy.freshUntil }
          : {}),
      revalidateAlways: policy.revalidateAlways,
      vary: policy.vary,
    },
    storedAt: existing?.storedAt ?? now.toISOString(),
    validatedAt: now.toISOString(),
    secretScanPolicyVersion: 1,
  };
}

function validEntry(value: unknown, expectedUrlKey: string): value is ContentCacheEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const entry = value as Partial<ContentCacheEntry>;
  return (
    entry.schemaVersion === contentCacheSchemaVersion &&
    entry.urlKey === `sha256:${expectedUrlKey}` &&
    typeof entry.finalUrlKey === 'string' &&
    /^sha256:[a-f0-9]{64}$/u.test(entry.finalUrlKey) &&
    entry.variant === cacheVariant &&
    typeof entry.object === 'object' &&
    entry.object !== null &&
    isSafeHash(entry.object.sha256) &&
    Number.isSafeInteger(entry.object.size) &&
    entry.object.size >= 0 &&
    typeof entry.representation === 'object' &&
    entry.representation !== null &&
    typeof entry.representation.contentType === 'string' &&
    entry.representation.contentType.length > 0 &&
    entry.representation.contentType.length <= maximumContentTypeLength &&
    !hasControlCharacter(entry.representation.contentType) &&
    Number.isSafeInteger(entry.representation.httpStatus) &&
    typeof entry.validators === 'object' &&
    entry.validators !== null &&
    (entry.validators.etag === undefined || isSafeValidator(entry.validators.etag)) &&
    (entry.validators.lastModified === undefined ||
      isSafeValidator(entry.validators.lastModified)) &&
    typeof entry.policy === 'object' &&
    entry.policy !== null &&
    typeof entry.policy.revalidateAlways === 'boolean' &&
    Array.isArray(entry.policy.vary) &&
    entry.policy.vary.every((item) => item === 'accept-encoding') &&
    (entry.policy.freshUntil === undefined ||
      (typeof entry.policy.freshUntil === 'string' &&
        !Number.isNaN(Date.parse(entry.policy.freshUntil)))) &&
    typeof entry.storedAt === 'string' &&
    !Number.isNaN(Date.parse(entry.storedAt)) &&
    typeof entry.validatedAt === 'string' &&
    !Number.isNaN(Date.parse(entry.validatedAt)) &&
    entry.secretScanPolicyVersion === 1
  );
}

async function regularFile(path: string): Promise<{ size: number } | undefined> {
  try {
    const metadata = await lstat(path);

    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      return undefined;
    }

    return { size: metadata.size };
  } catch {
    return undefined;
  }
}

async function ensureSafeDirectory(rootDirectory: string, targetDirectory: string): Promise<void> {
  const root = resolve(rootDirectory);
  const target = resolve(targetDirectory);
  const relativeTarget = relative(root, target);

  if (
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error('Cache paths must stay inside the configured cache root.');
  }

  await mkdir(root, { recursive: true });
  const segments = relativeTarget ? relativeTarget.split(sep) : [];
  let current = root;

  for (const segment of ['', ...segments]) {
    if (segment) {
      current = join(current, segment);
      try {
        await mkdir(current);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
          throw error;
        }
      }
    }

    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('Cache paths must not traverse symbolic links or junctions.');
    }
  }
}

async function waitForLock(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason ?? createAbortError();
  }

  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolvePromise();
    }, lockDelayMs);
    const abort = (): void => {
      clearTimeout(timeout);
      reject(signal?.reason ?? createAbortError());
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function acquireLock(path: string, signal?: AbortSignal): Promise<CacheLock | undefined> {
  for (let attempt = 0; attempt < lockAttempts; attempt += 1) {
    if (signal?.aborted) {
      throw signal.reason ?? createAbortError();
    }

    try {
      const handle = await open(path, 'wx');
      const token = `${process.pid}:${randomUUID()}`;

      try {
        await handle.writeFile(token, 'utf8');
        return { handle, token };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(path, { force: true }).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        return undefined;
      }

      try {
        const metadata = await lstat(path);
        if (Date.now() - metadata.mtimeMs >= staleLockMs) {
          await rm(path, { force: true });
          continue;
        }
      } catch {
        continue;
      }

      await waitForLock(signal);
    }
  }

  return undefined;
}

async function releaseLock(path: string, lock: CacheLock): Promise<void> {
  await lock.handle.close().catch(() => undefined);

  try {
    const currentToken = await readFile(path, 'utf8');
    if (currentToken === lock.token) {
      await rm(path, { force: true });
    }
  } catch {
    // A stale-lock recovery or another cleanup path may already own the path.
  }
}

async function cleanupStaleTemporaryFiles(directory: string, prefix: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const now = Date.now();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(`.${prefix}.`) || !entry.name.endsWith('.tmp')) {
      continue;
    }

    const path = join(directory, entry.name);

    try {
      const metadata = await lstat(path);
      if (!metadata.isSymbolicLink() && now - metadata.mtimeMs >= staleTemporaryFileMs) {
        await rm(path, { force: true });
      }
    } catch {
      // Concurrent cleanup may remove the temporary file first.
    }
  }
}

export async function copyVerifiedFile(
  sourcePath: string,
  destinationPath: string,
  maximumBytes: number,
  expected?: { size: number; sha256: string },
  signal?: AbortSignal,
): Promise<VerifiedFileCopy> {
  const sourceMetadata = await regularFile(sourcePath);

  if (!sourceMetadata) {
    throw new Error('The cache source must be a regular file.');
  }

  if (sourceMetadata.size > maximumBytes) {
    throw new Error(`The cache object exceeds the ${maximumBytes}-byte limit.`);
  }

  if (signal?.aborted) {
    throw signal.reason ?? createAbortError();
  }

  let complete = false;

  try {
    const hasher = new CacheHashingTransform(maximumBytes);

    if (signal) {
      await pipeline(
        createReadStream(sourcePath),
        hasher,
        createWriteStream(destinationPath, { flags: 'wx' }),
        { signal },
      );
    } else {
      await pipeline(
        createReadStream(sourcePath),
        hasher,
        createWriteStream(destinationPath, { flags: 'wx' }),
      );
    }

    const result = {
      size: hasher.size,
      sha256: hasher.digest(),
    };

    if (
      (expected && (result.size !== expected.size || result.sha256 !== expected.sha256)) ||
      result.size !== sourceMetadata.size
    ) {
      throw new Error('The cache object failed size or SHA-256 verification.');
    }

    complete = true;
    return result;
  } finally {
    if (!complete) {
      await rm(destinationPath, { force: true }).catch(() => undefined);
    }
  }
}

export class ContentAddressedCache {
  readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    if (!isAbsolute(rootDirectory)) {
      throw new TypeError('Cache directory must be an absolute path.');
    }

    this.rootDirectory = resolve(rootDirectory);
  }

  async lookup(canonicalUrl: string): Promise<ContentCacheLookup | undefined> {
    if (hasSensitiveQuery(canonicalUrl)) {
      return undefined;
    }

    const urlKey = urlKeyFor(canonicalUrl);
    const path = entryPathFor(this.rootDirectory, urlKey);
    let parsed: unknown;

    if (!(await regularFile(path))) {
      return undefined;
    }

    try {
      parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch {
      return undefined;
    }

    if (!validEntry(parsed, urlKey)) {
      return undefined;
    }

    const objectPath = objectPathFor(this.rootDirectory, parsed.object.sha256);
    const objectMetadata = await regularFile(objectPath);

    if (!objectMetadata || objectMetadata.size !== parsed.object.size) {
      return undefined;
    }

    return {
      entry: parsed,
      objectPath,
    };
  }

  isFresh(entry: ContentCacheEntry, now = new Date()): boolean {
    return (
      !entry.policy.revalidateAlways &&
      entry.policy.freshUntil !== undefined &&
      Date.parse(entry.policy.freshUntil) > now.getTime()
    );
  }

  async invalidate(canonicalUrl: string): Promise<void> {
    if (hasSensitiveQuery(canonicalUrl)) {
      return;
    }

    await rm(entryPathFor(this.rootDirectory, urlKeyFor(canonicalUrl)), { force: true }).catch(
      () => undefined,
    );
  }

  async put(
    canonicalUrl: string,
    sourcePath: string,
    metadata: CacheResponseMetadata,
    options: {
      now?: Date;
      signal?: AbortSignal;
    } = {},
  ): Promise<boolean> {
    if (hasSensitiveQuery(canonicalUrl)) {
      return false;
    }

    const entry = buildEntry(canonicalUrl, metadata, options.now ?? new Date());

    if (!entry) {
      await this.invalidate(canonicalUrl);
      return false;
    }

    return this.#writeLocked(
      canonicalUrl,
      sourcePath,
      entry,
      metadata.size,
      metadata.sha256,
      options.signal,
    );
  }

  async refresh(
    canonicalUrl: string,
    existing: ContentCacheEntry,
    metadata: CacheResponseMetadata,
    now = new Date(),
  ): Promise<boolean> {
    if (hasSensitiveQuery(canonicalUrl)) {
      return false;
    }

    const entry = buildEntry(canonicalUrl, metadata, now, existing);

    if (!entry) {
      await this.invalidate(canonicalUrl);
      return false;
    }

    const expectedUrlKey = urlKeyFor(canonicalUrl);
    if (existing.urlKey !== `sha256:${expectedUrlKey}`) {
      return false;
    }

    const lockPath = lockPathFor(this.rootDirectory, expectedUrlKey);
    await ensureSafeDirectory(this.rootDirectory, dirname(lockPath));
    const lock = await acquireLock(lockPath);

    if (!lock) {
      return false;
    }

    try {
      return await this.#writeEntry(entry);
    } finally {
      await releaseLock(lockPath, lock);
    }
  }

  async #writeLocked(
    canonicalUrl: string,
    sourcePath: string,
    entry: ContentCacheEntry,
    expectedSize: number,
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const urlKey = urlKeyFor(canonicalUrl);
    const lockPath = lockPathFor(this.rootDirectory, urlKey);
    await ensureSafeDirectory(this.rootDirectory, dirname(lockPath));
    const lock = await acquireLock(lockPath, signal);

    if (!lock) {
      return false;
    }

    try {
      const objectPath = objectPathFor(this.rootDirectory, expectedSha256);
      await ensureSafeDirectory(this.rootDirectory, dirname(objectPath));
      const objectLockPath = objectLockPathFor(this.rootDirectory, expectedSha256);
      await ensureSafeDirectory(this.rootDirectory, dirname(objectLockPath));
      const objectLock = await acquireLock(objectLockPath, signal);

      if (!objectLock) {
        return false;
      }

      const temporaryObjectPath = temporaryPath(dirname(objectPath), 'object');

      try {
        await cleanupStaleTemporaryFiles(dirname(objectPath), 'object');
        try {
          await copyVerifiedFile(
            sourcePath,
            temporaryObjectPath,
            expectedSize,
            {
              size: expectedSize,
              sha256: expectedSha256,
            },
            signal,
          );
          const existingObject = await this.#verifyObject(objectPath, expectedSize, expectedSha256);

          if (existingObject) {
            await rm(temporaryObjectPath, { force: true });
          } else {
            await rm(objectPath, { force: true });
            await rename(temporaryObjectPath, objectPath);
          }
        } finally {
          await rm(temporaryObjectPath, { force: true }).catch(() => undefined);
        }
      } finally {
        await releaseLock(objectLockPath, objectLock);
      }

      return await this.#writeEntry(entry);
    } catch {
      if (signal?.aborted) {
        throw signal.reason ?? createAbortError();
      }

      return false;
    } finally {
      await releaseLock(lockPath, lock);
    }
  }

  async #verifyObject(
    objectPath: string,
    expectedSize: number,
    expectedSha256: string,
  ): Promise<boolean> {
    const metadata = await regularFile(objectPath);

    if (!metadata || metadata.size !== expectedSize) {
      return false;
    }

    const hash = createHash('sha256');
    let size = 0;

    try {
      for await (const chunk of createReadStream(objectPath)) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.byteLength;

        if (size > expectedSize) {
          return false;
        }

        hash.update(bytes);
      }
    } catch {
      return false;
    }

    return size === expectedSize && hash.digest('hex') === expectedSha256;
  }

  async #writeEntry(entry: ContentCacheEntry): Promise<boolean> {
    const urlKey = entry.urlKey.slice('sha256:'.length);
    const path = entryPathFor(this.rootDirectory, urlKey);
    await ensureSafeDirectory(this.rootDirectory, dirname(path));
    await cleanupStaleTemporaryFiles(dirname(path), 'entry');
    const temporaryEntryPath = temporaryPath(dirname(path), 'entry');

    try {
      await writeFile(temporaryEntryPath, `${JSON.stringify(entry)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      await rm(path, { force: true });
      await rename(temporaryEntryPath, path);
      return true;
    } catch {
      await rm(temporaryEntryPath, { force: true }).catch(() => undefined);
      return false;
    }
  }
}

export function cacheMetadataFromHeaders(
  finalUrl: string,
  contentType: string,
  httpStatus: number,
  size: number,
  sha256: string,
  headers: {
    etag?: string;
    'last-modified'?: string;
    'cache-control'?: string;
    expires?: string;
    date?: string;
    age?: string;
    vary?: string;
    'set-cookie'?: string | string[];
  },
): CacheResponseMetadata {
  return {
    finalUrl,
    contentType,
    httpStatus,
    size,
    sha256,
    ...(headers.etag ? { etag: headers.etag } : {}),
    ...(headers['last-modified'] ? { lastModified: headers['last-modified'] } : {}),
    ...(headers['cache-control'] ? { cacheControl: headers['cache-control'] } : {}),
    ...(headers.expires ? { expires: headers.expires } : {}),
    ...(headers.date ? { date: headers.date } : {}),
    ...(headers.age ? { age: headers.age } : {}),
    ...(headers.vary ? { vary: headers.vary } : {}),
    ...(headers['set-cookie'] ? { hasSetCookie: true } : {}),
  };
}
