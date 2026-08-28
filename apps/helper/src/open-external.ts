import { spawn, type SpawnOptions } from 'node:child_process';

export interface SpawnedExternalProcess {
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'spawn', listener: () => void): this;
  unref(): void;
}

export type ExternalProcessSpawner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => SpawnedExternalProcess;

export interface OpenExternalOptions {
  platform?: NodeJS.Platform;
  spawnProcess?: ExternalProcessSpawner;
}

const defaultSpawner: ExternalProcessSpawner = (command, args, options) =>
  spawn(command, args, options);

export function openExternalTarget(
  target: string,
  options: OpenExternalOptions = {},
): Promise<void> {
  const normalizedTarget = target.trim();

  if (!normalizedTarget || normalizedTarget.includes('\0')) {
    throw new Error('The external target is invalid.');
  }

  if ((options.platform ?? process.platform) !== 'win32') {
    throw new Error('Opening files is supported only on Windows in this release.');
  }

  const spawnProcess = options.spawnProcess ?? defaultSpawner;

  return new Promise<void>((resolveOpen, reject) => {
    let child: SpawnedExternalProcess;

    try {
      child = spawnProcess('explorer.exe', [normalizedTarget], {
        detached: true,
        shell: false,
        stdio: 'ignore',
        windowsHide: false,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    const settle = (operation: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      operation();
    };

    child.once('error', (error) => {
      settle(() => reject(error));
    });
    child.once('spawn', () => {
      settle(() => {
        child.unref();
        resolveOpen();
      });
    });
  });
}
