import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ContentAddressedCache,
  cacheMetadataFromHeaders,
  copyVerifiedFile,
  type CacheResponseMetadata,
} from './cache.js';
import { createTestDirectory, removeTestDirectory } from './test-utils.js';

function metadata(
  finalUrl: string,
  body: Buffer,
  headers: Parameters<typeof cacheMetadataFromHeaders>[5] = {},
): CacheResponseMetadata {
  return cacheMetadataFromHeaders(
    finalUrl,
    'text/plain; charset=utf-8',
    200,
    body.byteLength,
    createHash('sha256').update(body).digest('hex'),
    headers,
  );
}

describe('ContentAddressedCache', () => {
  let directory: string;
  let sourcePath: string;

  beforeEach(async () => {
    directory = await createTestDirectory('webmirror-cache-');
    sourcePath = join(directory, 'source.txt');
    await writeFile(sourcePath, 'shared response', 'utf8');
  });

  afterEach(async () => {
    await removeTestDirectory(directory);
  });

  it('stores one immutable object for identical content and does not persist full URLs', async () => {
    const cacheRoot = join(directory, 'cache');
    const cache = new ContentAddressedCache(cacheRoot);
    const firstUrl = 'https://example.test/assets/one.txt';
    const secondUrl = 'https://cdn.example.test/assets/two.txt';
    const body = Buffer.from('shared response', 'utf8');

    await expect(
      cache.put(
        firstUrl,
        sourcePath,
        metadata(firstUrl, body, {
          etag: '"shared-v1"',
          'cache-control': 'max-age=3600',
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      cache.put(
        secondUrl,
        sourcePath,
        metadata(secondUrl, body, {
          etag: '"shared-v1"',
          'cache-control': 'max-age=3600',
        }),
      ),
    ).resolves.toBe(true);

    const bodyHash = createHash('sha256').update(body).digest('hex');
    const objects = await readdir(join(cacheRoot, 'objects', 'sha256', bodyHash.slice(0, 2)));
    expect(objects).toHaveLength(1);
    const entryText = await readFile(
      join(
        cacheRoot,
        'entries',
        'url-sha256',
        createHash('sha256').update(firstUrl).digest('hex').slice(0, 2),
        `${createHash('sha256').update(firstUrl).digest('hex')}.json`,
      ),
      'utf8',
    );
    expect(entryText).not.toContain(firstUrl);
    expect(await cache.lookup(firstUrl)).toBeDefined();
    expect(await cache.lookup(secondUrl)).toBeDefined();
  });

  it.each([
    ['no-store', { 'cache-control': 'no-store' }],
    ['private', { 'cache-control': 'private, max-age=60' }],
    ['set-cookie', { 'set-cookie': 'session=secret' }],
    ['unsupported vary', { vary: 'Cookie' }],
  ])('does not persist %s responses', async (_name, headers) => {
    const cache = new ContentAddressedCache(join(directory, 'cache'));
    const url = `https://example.test/${String(_name)}.txt`;

    await expect(
      cache.put(url, sourcePath, metadata(url, Buffer.from('shared response'), headers)),
    ).resolves.toBe(false);
    await expect(cache.lookup(url)).resolves.toBeUndefined();
  });

  it('marks max-age entries fresh and permits validator refresh', async () => {
    const cache = new ContentAddressedCache(join(directory, 'cache'));
    const url = 'https://example.test/fresh.txt';
    const body = Buffer.from('shared response', 'utf8');
    const entryMetadata = metadata(url, body, {
      etag: '"shared-v1"',
      'cache-control': 'max-age=3600',
    });

    await cache.put(url, sourcePath, entryMetadata);
    const lookup = await cache.lookup(url);

    expect(lookup).toBeDefined();
    expect(cache.isFresh(lookup!.entry)).toBe(true);
    await expect(
      cache.refresh(
        url,
        lookup!.entry,
        metadata(url, body, {
          etag: '"shared-v2"',
          'cache-control': 'max-age=0',
        }),
      ),
    ).resolves.toBe(true);
    const refreshed = await cache.lookup(url);
    expect(refreshed?.entry.validators.etag).toBe('"shared-v2"');
    expect(cache.isFresh(refreshed!.entry)).toBe(false);
  });

  it('uses private-cache max-age semantics and accounts for existing Age', async () => {
    const cache = new ContentAddressedCache(join(directory, 'cache'));
    const body = Buffer.from('shared response', 'utf8');
    const now = new Date('2026-07-18T12:00:00.000Z');
    const url = 'https://example.test/aged.txt';

    await cache.put(
      url,
      sourcePath,
      metadata(url, body, {
        age: '120',
        'cache-control': 's-maxage=3600, max-age=60',
        date: now.toUTCString(),
      }),
      { now },
    );

    const lookup = await cache.lookup(url);
    expect(lookup).toBeDefined();
    expect(cache.isFresh(lookup!.entry, now)).toBe(false);
  });

  it('rejects a corrupted object during verified materialization', async () => {
    const cacheRoot = join(directory, 'cache');
    const cache = new ContentAddressedCache(cacheRoot);
    const url = 'https://example.test/corrupt.txt';
    const body = Buffer.from('shared response', 'utf8');

    await cache.put(url, sourcePath, metadata(url, body, { 'cache-control': 'max-age=3600' }));
    const lookup = await cache.lookup(url);
    expect(lookup).toBeDefined();
    await writeFile(lookup!.objectPath, 'corrupted', 'utf8');

    await expect(
      copyVerifiedFile(lookup!.objectPath, join(directory, 'materialized.txt'), body.byteLength, {
        size: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
      }),
    ).rejects.toThrow('SHA-256 verification');
  });

  it('refuses to write through a cache junction or symbolic link', async () => {
    const cacheRoot = join(directory, 'cache');
    const outside = join(directory, 'outside');
    const body = Buffer.from('shared response', 'utf8');
    const bodyHash = createHash('sha256').update(body).digest('hex');
    await mkdir(join(cacheRoot, 'objects', 'sha256'), { recursive: true });
    await mkdir(outside);
    await symlink(
      outside,
      join(cacheRoot, 'objects', 'sha256', bodyHash.slice(0, 2)),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const cache = new ContentAddressedCache(cacheRoot);
    const url = 'https://example.test/junction.txt';

    await expect(cache.put(url, sourcePath, metadata(url, body))).resolves.toBe(false);
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it('rejects malformed cache metadata before constructing object paths', async () => {
    const cacheRoot = join(directory, 'cache');
    const cache = new ContentAddressedCache(cacheRoot);
    const url = 'https://example.test/malformed.txt';
    const malformed = {
      ...metadata(url, Buffer.from('shared response', 'utf8')),
      sha256: '../../outside',
    };

    await expect(cache.put(url, sourcePath, malformed)).resolves.toBe(false);
    await expect(readdir(directory)).resolves.not.toContain('outside');
  });

  it('does not cache redirected or sensitive final URLs', async () => {
    const cache = new ContentAddressedCache(join(directory, 'cache'));
    const body = Buffer.from('shared response', 'utf8');
    const url = 'https://example.test/original.txt';

    await expect(
      cache.put(
        url,
        sourcePath,
        metadata('https://cdn.example.test/final.txt?token=secret', body, {
          'cache-control': 'max-age=3600',
        }),
      ),
    ).resolves.toBe(false);
    await expect(cache.lookup(url)).resolves.toBeUndefined();
  });
});
