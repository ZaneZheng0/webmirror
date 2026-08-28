import type { Writable } from 'node:stream';

import { NativeMirrorService } from './mirror-service.js';
import { runNativeMessagingHost } from './native-messaging.js';
import { serveMirrorDirectory } from './serve.js';

export const helperVersion = '0.0.60';

export interface HelperCliIo {
  input: AsyncIterable<Uint8Array>;
  output: Writable;
  errorOutput: Writable;
}

async function writeBytes(output: Writable, value: string | Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    output.write(value, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function writeDiagnostic(output: Writable, message: string): void {
  output.write(`[webmirror-helper] ${message}\n`);
}

function isBrowserNativeInvocation(args: readonly string[]): boolean {
  return (
    args.some((argument) => argument.startsWith('chrome-extension://')) ||
    args.some((argument) => argument.startsWith('--parent-window='))
  );
}

export async function runHelperCli(args: readonly string[], io: HelperCliIo): Promise<number> {
  if (args.length === 1 && args[0] === '--version') {
    await writeBytes(io.output, `${helperVersion}\n`);
    return 0;
  }

  if ((args.length === 1 && args[0] === '--native') || isBrowserNativeInvocation(args)) {
    const service = new NativeMirrorService();
    return runNativeMessagingHost({
      input: io.input,
      output: io.output,
      helperVersion,
      handleRequest: (request, send) => service.handleRequest(request, send),
      onDisconnect: () => service.dispose(),
      diagnostic: (message) => {
        writeDiagnostic(io.errorOutput, message);
      },
    });
  }

  if (args.length >= 2 && args[0] === '--serve') {
    const directory = args[1];

    if (!directory) {
      writeDiagnostic(io.errorOutput, 'A mirror directory is required after --serve.');
      return 64;
    }

    const extraArguments = args.slice(2);

    if (extraArguments.some((argument) => argument !== '--open')) {
      writeDiagnostic(io.errorOutput, 'Only --open may follow the mirror directory.');
      return 64;
    }

    return serveMirrorDirectory(directory, {
      open: extraArguments.includes('--open'),
      output: io.output,
    });
  }

  writeDiagnostic(
    io.errorOutput,
    'Usage: webmirror-helper --version | --native | --serve <mirror-directory> [--open]',
  );
  return 64;
}
