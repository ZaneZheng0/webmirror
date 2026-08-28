import { describe, expect, it, vi } from 'vitest';

import {
  openExternalTarget,
  type ExternalProcessSpawner,
  type SpawnedExternalProcess,
} from './open-external.js';

class TestExternalProcess implements SpawnedExternalProcess {
  readonly unref = vi.fn();
  readonly #errorListeners: Array<(error: Error) => void> = [];
  readonly #spawnListeners: Array<() => void> = [];

  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'spawn', listener: () => void): this;
  once(event: 'error' | 'spawn', listener: ((error: Error) => void) | (() => void)): this {
    if (event === 'error') {
      this.#errorListeners.push(listener as (error: Error) => void);
    } else {
      this.#spawnListeners.push(listener as () => void);
    }

    return this;
  }

  emitError(error: Error): void {
    this.#errorListeners.shift()?.(error);
  }

  emitSpawn(): void {
    this.#spawnListeners.shift()?.();
  }
}

describe('openExternalTarget', () => {
  it('launches a visible detached Explorer process without shell parsing', async () => {
    const child = new TestExternalProcess();
    const spawnProcess = vi.fn<ExternalProcessSpawner>(() => child);
    const opening = openExternalTarget(' C:\\Mirror Output ', {
      platform: 'win32',
      spawnProcess,
    });
    child.emitSpawn();
    await opening;

    expect(spawnProcess).toHaveBeenCalledWith('explorer.exe', ['C:\\Mirror Output'], {
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: false,
    });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('reports launch failures and rejects invalid targets', async () => {
    const child = new TestExternalProcess();
    const spawnProcess = vi.fn<ExternalProcessSpawner>(() => child);
    const opening = openExternalTarget('C:\\Missing', {
      platform: 'win32',
      spawnProcess,
    });
    child.emitError(new Error('explorer unavailable'));

    await expect(opening).rejects.toThrow('explorer unavailable');
    expect(() =>
      openExternalTarget(' \0 ', {
        platform: 'win32',
        spawnProcess,
      }),
    ).toThrow('external target is invalid');
  });

  it('rejects unsupported platforms', () => {
    expect(() => openExternalTarget('C:\\Mirror', { platform: 'linux' })).toThrow(
      'supported only on Windows',
    );
  });
});
