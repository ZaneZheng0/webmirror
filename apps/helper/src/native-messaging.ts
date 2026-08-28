import type { Writable } from 'node:stream';

import {
  isNativeHandshakeRequest,
  isNativePostHandshakeRequest,
  nativeMessagingCapabilities,
  nativeMessagingMaxMessageBytes,
  nativeMessagingProtocolVersion,
  type NativeHandshakeResult,
  type NativeHostErrorCode,
  type NativeHostErrorResponse,
  type NativeHostResponse,
  type NativePostHandshakeRequest,
} from '../../../packages/shared/src/native-messaging.js';

export const nativeMessagingProtocolErrorCodes = [
  'MESSAGE_TOO_LARGE',
  'INVALID_JSON',
  'UNEXPECTED_EOF',
  'SERIALIZATION_ERROR',
  'WRITE_FAILED',
] as const;

export type NativeMessagingProtocolErrorCode = (typeof nativeMessagingProtocolErrorCodes)[number];

export class NativeMessagingProtocolError extends Error {
  readonly code: NativeMessagingProtocolErrorCode;

  constructor(code: NativeMessagingProtocolErrorCode, message: string) {
    super(message);
    this.name = 'NativeMessagingProtocolError';
    this.code = code;
  }
}

export interface NativeMessagingOptions {
  maxMessageBytes?: number;
}

export interface NativeMessagingHostOptions extends NativeMessagingOptions {
  input: AsyncIterable<Uint8Array>;
  output: Writable;
  helperVersion: string;
  diagnostic?: (message: string) => void;
  handleRequest?: NativeHostCommandHandler;
  onDisconnect?: () => Promise<void> | void;
  maxPendingHandlers?: number;
}

export type NativeHostSender = (response: NativeHostResponse) => Promise<void>;

export type NativeHostCommandHandler = (
  request: NativePostHandshakeRequest,
  send: NativeHostSender,
) => Promise<void> | void;

const headerBytes = 4;
const maximumLengthPrefix = 0xffff_ffff;
const defaultMaximumPendingHandlers = 256;

function resolveMessageLimit(options: NativeMessagingOptions): number {
  const messageLimit = options.maxMessageBytes ?? nativeMessagingMaxMessageBytes;

  if (
    !Number.isSafeInteger(messageLimit) ||
    messageLimit <= 0 ||
    messageLimit > maximumLengthPrefix
  ) {
    throw new RangeError(
      `maxMessageBytes must be an integer between 1 and ${maximumLengthPrefix}.`,
    );
  }

  return messageLimit;
}

function parseJsonPayload(payload: Buffer): unknown {
  let json: string;

  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    throw new NativeMessagingProtocolError(
      'INVALID_JSON',
      'Native message payload is not valid UTF-8 JSON.',
    );
  }

  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new NativeMessagingProtocolError(
      'INVALID_JSON',
      `Native message payload is not valid JSON (${payload.length} bytes).`,
    );
  }
}

export function encodeNativeMessage(
  message: unknown,
  options: NativeMessagingOptions = {},
): Buffer {
  const messageLimit = resolveMessageLimit(options);
  let json: string | undefined;

  try {
    json = JSON.stringify(message);
  } catch {
    throw new NativeMessagingProtocolError(
      'SERIALIZATION_ERROR',
      'Native message could not be serialized as JSON.',
    );
  }

  if (json === undefined) {
    throw new NativeMessagingProtocolError(
      'SERIALIZATION_ERROR',
      'Native message must be representable as JSON.',
    );
  }

  const payload = Buffer.from(json, 'utf8');

  if (payload.length > messageLimit) {
    throw new NativeMessagingProtocolError(
      'MESSAGE_TOO_LARGE',
      `Native message is ${payload.length} bytes; limit is ${messageLimit} bytes.`,
    );
  }

  const frame = Buffer.allocUnsafe(headerBytes + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, headerBytes);
  return frame;
}

export async function writeNativeMessage(
  output: Writable,
  message: unknown,
  options: NativeMessagingOptions = {},
): Promise<void> {
  const frame = encodeNativeMessage(message, options);

  try {
    await new Promise<void>((resolve, reject) => {
      output.write(frame, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  } catch {
    throw new NativeMessagingProtocolError(
      'WRITE_FAILED',
      'Failed to write a Native Messaging protocol frame.',
    );
  }
}

export async function* readNativeMessages(
  input: AsyncIterable<Uint8Array>,
  options: NativeMessagingOptions = {},
): AsyncGenerator<unknown> {
  const messageLimit = resolveMessageLimit(options);
  const header = Buffer.allocUnsafe(headerBytes);
  let headerOffset = 0;
  let payload: Buffer | null = null;
  let payloadOffset = 0;

  for await (const chunk of input) {
    const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let incomingOffset = 0;

    while (incomingOffset < incoming.length) {
      if (payload === null) {
        const bytesToCopy = Math.min(headerBytes - headerOffset, incoming.length - incomingOffset);
        incoming.copy(header, headerOffset, incomingOffset, incomingOffset + bytesToCopy);
        headerOffset += bytesToCopy;
        incomingOffset += bytesToCopy;

        if (headerOffset < headerBytes) {
          continue;
        }

        const declaredPayloadBytes = header.readUInt32LE(0);
        headerOffset = 0;

        if (declaredPayloadBytes > messageLimit) {
          throw new NativeMessagingProtocolError(
            'MESSAGE_TOO_LARGE',
            `Native message declares ${declaredPayloadBytes} bytes; limit is ${messageLimit} bytes.`,
          );
        }

        payload = Buffer.allocUnsafe(declaredPayloadBytes);
        payloadOffset = 0;

        if (declaredPayloadBytes === 0) {
          const completePayload = payload;
          payload = null;
          yield parseJsonPayload(completePayload);
        }

        continue;
      }

      const bytesToCopy = Math.min(
        payload.length - payloadOffset,
        incoming.length - incomingOffset,
      );
      incoming.copy(payload, payloadOffset, incomingOffset, incomingOffset + bytesToCopy);
      payloadOffset += bytesToCopy;
      incomingOffset += bytesToCopy;

      if (payloadOffset === payload.length) {
        const completePayload = payload;
        payload = null;
        payloadOffset = 0;
        yield parseJsonPayload(completePayload);
      }
    }
  }

  if (payload !== null) {
    throw new NativeMessagingProtocolError(
      'UNEXPECTED_EOF',
      `Native Messaging input ended after ${payloadOffset} of ${payload.length} payload bytes.`,
    );
  }

  if (headerOffset > 0) {
    throw new NativeMessagingProtocolError(
      'UNEXPECTED_EOF',
      `Native Messaging input ended after ${headerOffset} of ${headerBytes} header bytes.`,
    );
  }
}

function getRequestId(message: unknown): string | null {
  if (
    typeof message === 'object' &&
    message !== null &&
    !Array.isArray(message) &&
    'requestId' in message &&
    typeof message.requestId === 'string' &&
    message.requestId.length > 0 &&
    message.requestId.length <= 128
  ) {
    return message.requestId;
  }

  return null;
}

function createErrorResponse(
  code: NativeHostErrorCode,
  message: string,
  requestId: string | null,
): NativeHostErrorResponse {
  return {
    type: 'error',
    requestId,
    protocolVersion: nativeMessagingProtocolVersion,
    error: {
      code,
      message,
    },
  };
}

function mapProtocolError(error: NativeMessagingProtocolError): NativeHostErrorCode {
  switch (error.code) {
    case 'INVALID_JSON':
      return 'INVALID_JSON';
    case 'MESSAGE_TOO_LARGE':
      return 'MESSAGE_TOO_LARGE';
    case 'UNEXPECTED_EOF':
      return 'UNEXPECTED_EOF';
    case 'SERIALIZATION_ERROR':
    case 'WRITE_FAILED':
      return 'INTERNAL_ERROR';
  }
}

export async function runNativeMessagingHost(options: NativeMessagingHostOptions): Promise<number> {
  const maxMessageBytes = resolveMessageLimit(options);
  const maxPendingHandlers = options.maxPendingHandlers ?? defaultMaximumPendingHandlers;

  if (
    !Number.isSafeInteger(maxPendingHandlers) ||
    maxPendingHandlers < 1 ||
    maxPendingHandlers > 10_000
  ) {
    throw new RangeError('maxPendingHandlers must be an integer between 1 and 10000.');
  }

  const diagnostic = options.diagnostic ?? (() => undefined);
  let handshakeComplete = false;
  let exitCode = 0;
  let writeQueue = Promise.resolve();
  const pendingHandlers = new Set<Promise<void>>();
  let disconnectNotified = false;
  const send: NativeHostSender = (response) => {
    const pendingWrite = writeQueue.then(() =>
      writeNativeMessage(options.output, response, { maxMessageBytes }),
    );
    writeQueue = pendingWrite.catch(() => undefined);
    return pendingWrite;
  };
  const notifyDisconnect = async (): Promise<void> => {
    if (disconnectNotified) {
      return;
    }

    disconnectNotified = true;

    try {
      await options.onDisconnect?.();
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown disconnect failure.';
      diagnostic(`Native Messaging disconnect cleanup failed: ${detail}`);
      exitCode = 1;
    }
  };

  try {
    for await (const message of readNativeMessages(options.input, { maxMessageBytes })) {
      if (!handshakeComplete) {
        if (!isNativeHandshakeRequest(message)) {
          const requestId = getRequestId(message);
          await send(
            createErrorResponse(
              'HANDSHAKE_REQUIRED',
              'The first Native Messaging request must be a valid handshake.',
              requestId,
            ),
          );
          diagnostic('Rejected a Native Messaging request before a valid handshake.');
          return 1;
        }

        if (message.protocolVersion !== nativeMessagingProtocolVersion) {
          const response: NativeHandshakeResult = {
            type: 'handshake_result',
            requestId: message.requestId,
            accepted: false,
            protocolVersion: nativeMessagingProtocolVersion,
            helperVersion: options.helperVersion,
            capabilities: [],
            error: {
              code: 'UNSUPPORTED_PROTOCOL_VERSION',
              message: `Protocol version ${message.protocolVersion} is not supported; expected ${nativeMessagingProtocolVersion}.`,
            },
          };

          await send(response);
          diagnostic(
            `Rejected unsupported Native Messaging protocol version ${message.protocolVersion}.`,
          );
          return 1;
        }

        const response: NativeHandshakeResult = {
          type: 'handshake_result',
          requestId: message.requestId,
          accepted: true,
          protocolVersion: nativeMessagingProtocolVersion,
          helperVersion: options.helperVersion,
          capabilities: nativeMessagingCapabilities,
          error: null,
        };

        await send(response);
        handshakeComplete = true;
        continue;
      }

      if (!isNativePostHandshakeRequest(message)) {
        await send(
          createErrorResponse(
            'INVALID_MESSAGE',
            `The Native Messaging request is not valid for protocol version ${nativeMessagingProtocolVersion}.`,
            getRequestId(message),
          ),
        );
        diagnostic('Rejected an invalid post-handshake Native Messaging request.');
        exitCode = 1;
        continue;
      }

      if (!options.handleRequest) {
        await send(
          createErrorResponse(
            'INVALID_MESSAGE',
            'The Native Messaging host does not have a command handler.',
            message.requestId,
          ),
        );
        diagnostic('Rejected a Native Messaging request because no command handler is configured.');
        exitCode = 1;
        continue;
      }

      if (pendingHandlers.size >= maxPendingHandlers) {
        await send(
          createErrorResponse(
            'RATE_LIMITED',
            'Too many Native Messaging requests are still in progress.',
            message.requestId,
          ),
        );
        diagnostic('Rejected a Native Messaging request because the handler limit was reached.');
        exitCode = 1;
        continue;
      }

      const handlerTask = Promise.resolve(options.handleRequest(message, send))
        .catch(async (error: unknown) => {
          const detail = error instanceof Error ? error.message : 'Native command failed.';
          diagnostic(`Native Messaging command ${message.type} failed: ${detail}`);
          await send(createErrorResponse('INTERNAL_ERROR', detail, message.requestId));
          exitCode = 1;
        })
        .finally(() => {
          pendingHandlers.delete(handlerTask);
        });
      pendingHandlers.add(handlerTask);
    }

    await notifyDisconnect();
    await Promise.allSettled([...pendingHandlers]);
    await writeQueue;
    return exitCode;
  } catch (error) {
    await notifyDisconnect();
    await Promise.allSettled([...pendingHandlers]);

    if (error instanceof NativeMessagingProtocolError && error.code === 'WRITE_FAILED') {
      diagnostic(`Native Messaging output failed: ${error.message}`);
      return 1;
    }

    const protocolError =
      error instanceof NativeMessagingProtocolError
        ? error
        : new NativeMessagingProtocolError(
            'SERIALIZATION_ERROR',
            'The Native Messaging host failed unexpectedly.',
          );
    const hostErrorCode = mapProtocolError(protocolError);

    diagnostic(`Native Messaging protocol error ${hostErrorCode}: ${protocolError.message}`);

    try {
      await send(createErrorResponse(hostErrorCode, protocolError.message, null));
      await writeQueue;
    } catch (writeError) {
      const message = writeError instanceof Error ? writeError.message : 'Unknown output failure.';
      diagnostic(`Could not return the Native Messaging error frame: ${message}`);
    }

    return 1;
  }
}
