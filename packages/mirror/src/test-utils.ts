import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function createTestDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export function removeTestDirectory(directory: string): Promise<void> {
  return rm(directory, { force: true, recursive: true });
}
