import { Readable, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  nativeMessagingCapabilities,
  nativeMessagingMaxMessageBytes,
  nativeMessagingProtocolVersion,
  type NativeHandshakeRequest,
} from '../../../packages/shared/src/native-messaging.js';
import { helperVersion, runHelperCli } from './cli.js';
import {
  encodeNativeMessage,
  NativeMessagingProtocolError,
  readNativeMessages,
  runNativeMessagingHost,
} from './native-messaging.js';

class BufferSink extends Writable {
  readonly chunks: Buffer[] = [];

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk));
    callback();
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }

  toUtf8(): string {
    return this.toBuffer().toString('utf8');
  }
}

function readableFrom(chunks: readonly Uint8Array[]): Readable {
  return Readable.from(chunks);
}

async function collectMessages(input: AsyncIterable<Uint8Array>): Promise<unknown[]> {
  const messages: unknown[] = [];

  for await (const message of readNativeMessages(input)) {
    messages.push(message);
  }

  return messages;
}

function frameRawPayload(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function handshake(
  protocolVersion: number = nativeMessagingProtocolVersion,
): NativeHandshakeRequest {
  return {
    type: 'handshake',
    requestId: 'request-1',
    protocolVersion,
    extensionVersion: '0.0.1',
  };
}

describe('Native Messaging framing', () => {
  it('reads one frame split across header and payload chunks', async () => {
    const frame = encodeNativeMessage({ type: 'example', value: 42 });
    const chunks = Array.from({ length: frame.length }, (_, index) =>
      frame.subarray(index, index + 1),
    );

    await expect(collectMessages(readableFrom(chunks))).resolves.toEqual([
      { type: 'example', value: 42 },
    ]);
  });

  it('reads multiple frames from a shared stream', async () => {
    const combined = Buffer.concat([
      encodeNativeMessage({ sequence: 1 }),
      encodeNativeMessage({ sequence: 2 }),
      encodeNativeMessage({ sequence: 3 }),
    ]);
    const chunks = [combined.subarray(0, 7), combined.subarray(7, 19), combined.subarray(19)];

    await expect(collectMessages(readableFrom(chunks))).resolves.toEqual([
      { sequence: 1 },
      { sequence: 2 },
      { sequence: 3 },
    ]);
  });

  it('rejects a declared message above the configured limit', async () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(nativeMessagingMaxMessageBytes + 1, 0);

    await expect(collectMessages(readableFrom([header]))).rejects.toMatchObject({
      name: 'NativeMessagingProtocolError',
      code: 'MESSAGE_TOO_LARGE',
    });
  });

  it('rejects an encoded message above the configured limit', () => {
    expect(() => encodeNativeMessage({ value: 'too large' }, { maxMessageBytes: 8 })).toThrowError(
      expect.objectContaining({
        name: 'NativeMessagingProtocolError',
        code: 'MESSAGE_TOO_LARGE',
      }),
    );
  });

  it('rejects invalid JSON without exposing its contents', async () => {
    const invalidFrame = frameRawPayload('{"token":"secret",]');

    try {
      await collectMessages(readableFrom([invalidFrame]));
      throw new Error('Expected invalid JSON to be rejected.');
    } catch (error) {
      expect(error).toBeInstanceOf(NativeMessagingProtocolError);
      expect(error).toMatchObject({ code: 'INVALID_JSON' });
      expect((error as Error).message).not.toContain('secret');
    }
  });

  it('accepts clean EOF and rejects truncated headers or payloads', async () => {
    await expect(collectMessages(readableFrom([]))).resolves.toEqual([]);

    await expect(collectMessages(readableFrom([Buffer.from([0x01, 0x00])]))).rejects.toMatchObject({
      code: 'UNEXPECTED_EOF',
    });

    const truncatedPayload = Buffer.alloc(6);
    truncatedPayload.writeUInt32LE(5, 0);
    truncatedPayload.write('ab', 4, 'utf8');

    await expect(collectMessages(readableFrom([truncatedPayload]))).rejects.toMatchObject({
      code: 'UNEXPECTED_EOF',
    });
  });
});

describe('Native Messaging handshake', () => {
  it('returns a framed successful version handshake', async () => {
    const output = new BufferSink();
    const diagnostics: string[] = [];

    const exitCode = await runNativeMessagingHost({
      input: readableFrom([encodeNativeMessage(handshake())]),
      output,
      helperVersion,
      diagnostic: (message) => diagnostics.push(message),
    });

    expect(exitCode).toBe(0);
    expect(diagnostics).toEqual([]);
    await expect(collectMessages(readableFrom([output.toBuffer()]))).resolves.toEqual([
      {
        type: 'handshake_result',
        requestId: 'request-1',
        accepted: true,
        protocolVersion: nativeMessagingProtocolVersion,
        helperVersion,
        capabilities: nativeMessagingCapabilities,
        error: null,
      },
    ]);
  });

  it('rejects an incompatible protocol version with a framed result', async () => {
    const output = new BufferSink();
    const diagnostics: string[] = [];

    const exitCode = await runNativeMessagingHost({
      input: readableFrom([encodeNativeMessage(handshake(nativeMessagingProtocolVersion + 1))]),
      output,
      helperVersion,
      diagnostic: (message) => diagnostics.push(message),
    });

    expect(exitCode).toBe(1);
    expect(diagnostics).toEqual([
      `Rejected unsupported Native Messaging protocol version ${
        nativeMessagingProtocolVersion + 1
      }.`,
    ]);
    await expect(collectMessages(readableFrom([output.toBuffer()]))).resolves.toEqual([
      {
        type: 'handshake_result',
        requestId: 'request-1',
        accepted: false,
        protocolVersion: nativeMessagingProtocolVersion,
        helperVersion,
        capabilities: [],
        error: {
          code: 'UNSUPPORTED_PROTOCOL_VERSION',
          message: `Protocol version ${
            nativeMessagingProtocolVersion + 1
          } is not supported; expected ${nativeMessagingProtocolVersion}.`,
        },
      },
    ]);
  });

  it('returns a framed protocol error for invalid JSON', async () => {
    const output = new BufferSink();

    const exitCode = await runNativeMessagingHost({
      input: readableFrom([frameRawPayload('{invalid')]),
      output,
      helperVersion,
    });

    expect(exitCode).toBe(1);
    await expect(collectMessages(readableFrom([output.toBuffer()]))).resolves.toEqual([
      {
        type: 'error',
        requestId: null,
        protocolVersion: nativeMessagingProtocolVersion,
        error: {
          code: 'INVALID_JSON',
          message: 'Native message payload is not valid JSON (8 bytes).',
        },
      },
    ]);
  });

  it('dispatches valid post-handshake commands and serializes responses', async () => {
    const output = new BufferSink();
    const input = Buffer.concat([
      encodeNativeMessage(handshake()),
      encodeNativeMessage({
        type: 'mirror_cancel',
        requestId: 'request-2',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-1',
      }),
    ]);

    const exitCode = await runNativeMessagingHost({
      input: readableFrom([input]),
      output,
      helperVersion,
      handleRequest: async (request, send) => {
        expect(request.type).toBe('mirror_cancel');
        await send({
          type: 'mirror_cancel_result',
          requestId: request.requestId,
          protocolVersion: nativeMessagingProtocolVersion,
          jobId: request.jobId,
          accepted: false,
          error: {
            code: 'JOB_NOT_FOUND',
            message: 'Job not found.',
          },
        });
      },
    });

    expect(exitCode).toBe(0);
    await expect(collectMessages(readableFrom([output.toBuffer()]))).resolves.toMatchObject([
      {
        type: 'handshake_result',
        accepted: true,
      },
      {
        type: 'mirror_cancel_result',
        requestId: 'request-2',
        accepted: false,
      },
    ]);
  });

  it('reports invalid post-handshake messages without terminating the stream early', async () => {
    const output = new BufferSink();
    const input = Buffer.concat([
      encodeNativeMessage(handshake()),
      encodeNativeMessage({
        type: 'unsupported',
        requestId: 'request-2',
      }),
      encodeNativeMessage({
        type: 'mirror_cancel',
        requestId: 'request-3',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-1',
      }),
    ]);
    let handled = false;

    const exitCode = await runNativeMessagingHost({
      input: readableFrom([input]),
      output,
      helperVersion,
      handleRequest: () => {
        handled = true;
      },
    });

    expect(exitCode).toBe(1);
    expect(handled).toBe(true);
    await expect(collectMessages(readableFrom([output.toBuffer()]))).resolves.toMatchObject([
      { type: 'handshake_result' },
      {
        type: 'error',
        requestId: 'request-2',
        error: { code: 'INVALID_MESSAGE' },
      },
    ]);
  });

  it('runs disconnect cleanup before waiting for active command handlers', async () => {
    const output = new BufferSink();
    const input = Buffer.concat([
      encodeNativeMessage(handshake()),
      encodeNativeMessage({
        type: 'mirror_cancel',
        requestId: 'request-2',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-1',
      }),
    ]);
    const events: string[] = [];
    let releaseHandler: (() => void) | undefined;
    const handlerRelease = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    const exitCode = await runNativeMessagingHost({
      input: readableFrom([input]),
      output,
      helperVersion,
      handleRequest: async () => {
        events.push('handler-started');
        await handlerRelease;
        events.push('handler-finished');
      },
      onDisconnect: () => {
        events.push('disconnect');
        releaseHandler?.();
      },
    });

    expect(exitCode).toBe(0);
    expect(events).toEqual(['handler-started', 'disconnect', 'handler-finished']);
  });

  it('rejects requests above the configured pending-handler limit', async () => {
    const output = new BufferSink();
    const input = Buffer.concat([
      encodeNativeMessage(handshake()),
      encodeNativeMessage({
        type: 'mirror_cancel',
        requestId: 'request-2',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-1',
      }),
      encodeNativeMessage({
        type: 'mirror_cancel',
        requestId: 'request-3',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-2',
      }),
    ]);
    let releaseHandler: (() => void) | undefined;
    const handlerRelease = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    const exitCode = await runNativeMessagingHost({
      input: readableFrom([input]),
      output,
      helperVersion,
      maxPendingHandlers: 1,
      handleRequest: async () => {
        await handlerRelease;
      },
      onDisconnect: () => {
        releaseHandler?.();
      },
    });

    expect(exitCode).toBe(1);
    await expect(collectMessages(readableFrom([output.toBuffer()]))).resolves.toMatchObject([
      { type: 'handshake_result', accepted: true },
      {
        type: 'error',
        requestId: 'request-3',
        error: {
          code: 'RATE_LIMITED',
        },
      },
    ]);
  });
});

describe('helper CLI', () => {
  it('prints the helper version in --version mode', async () => {
    const output = new BufferSink();
    const errorOutput = new BufferSink();

    const exitCode = await runHelperCli(['--version'], {
      input: readableFrom([]),
      output,
      errorOutput,
    });

    expect(exitCode).toBe(0);
    expect(output.toUtf8()).toBe(`${helperVersion}\n`);
    expect(errorOutput.toUtf8()).toBe('');
  });

  it('keeps --native stdout limited to protocol frames', async () => {
    const output = new BufferSink();
    const errorOutput = new BufferSink();

    const exitCode = await runHelperCli(['--native'], {
      input: readableFrom([encodeNativeMessage(handshake())]),
      output,
      errorOutput,
    });

    expect(exitCode).toBe(0);
    expect(output.toBuffer().readUInt32LE(0)).toBe(output.toBuffer().length - 4);
    await expect(collectMessages(readableFrom([output.toBuffer()]))).resolves.toHaveLength(1);
    expect(errorOutput.toUtf8()).toBe('');
  });

  it('writes native protocol failures as frames and diagnostics to stderr', async () => {
    const output = new BufferSink();
    const errorOutput = new BufferSink();

    const exitCode = await runHelperCli(['--native'], {
      input: readableFrom([frameRawPayload('{invalid')]),
      output,
      errorOutput,
    });

    expect(exitCode).toBe(1);
    expect(output.toBuffer().readUInt32LE(0)).toBe(output.toBuffer().length - 4);
    await expect(collectMessages(readableFrom([output.toBuffer()]))).resolves.toMatchObject([
      {
        type: 'error',
        error: {
          code: 'INVALID_JSON',
        },
      },
    ]);
    expect(errorOutput.toUtf8()).toContain('Native Messaging protocol error INVALID_JSON');
  });
});
