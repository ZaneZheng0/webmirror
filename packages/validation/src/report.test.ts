import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { atomicWriteFile } from './report.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('atomicWriteFile', () => {
  it('atomically replaces an existing file without leaving temporary files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webmirror-atomic-write-'));
    directories.push(directory);
    const target = join(directory, 'validation.json');

    await atomicWriteFile(target, '{"version":1}\n');
    await atomicWriteFile(target, '{"version":2}\n');

    expect(await readFile(target, 'utf8')).toBe('{"version":2}\n');
    expect((await readdir(directory)).some((file) => file.endsWith('.tmp'))).toBe(false);
  });
});
