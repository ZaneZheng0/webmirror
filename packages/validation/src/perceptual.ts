import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

import { validatePerceptualOptions } from './actions.js';
import type {
  ValidationPerceptualComparison,
  ValidationPerceptualOptions,
  ValidationPerceptualSettings,
} from './types.js';

const DEFAULT_SETTINGS: ValidationPerceptualSettings = {
  threshold: 0.15,
  maxDifferenceRatio: 0.02,
  partialDifferenceRatio: 0.15,
  includeAntialiasing: false,
};
const MAX_PNG_DIMENSION = 16_384;
const MAX_PNG_PIXELS = 8 * 1024 * 1024;
const MAX_PNG_CHUNKS = 10_000;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

export interface PngComparisonOutput {
  comparison: ValidationPerceptualComparison;
  diff?: Uint8Array;
}

function bufferView(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function roundedRatio(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  throw signal.reason ?? new DOMException('Perceptual comparison was aborted', 'AbortError');
}

async function yieldForCancellation(signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfAborted(signal);
}

interface PngHeader {
  width: number;
  height: number;
  error?: string;
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      (bytes[offset + 1] ?? 0) * 0x10000 +
      (bytes[offset + 2] ?? 0) * 0x100 +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function pngChunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

function validatePngChunkStructure(bytes: Uint8Array, label: string): string | undefined {
  const bitDepth = bytes[24] ?? 0;
  const colorType = bytes[25] ?? 0;
  let offset = 8;
  let ihdrCount = 0;
  let idatCount = 0;
  let iendCount = 0;
  let plteCount = 0;
  let paletteEntries = 0;
  let transparencyCount = 0;
  let gammaCount = 0;
  let idatEnded = false;
  let chunkCount = 0;

  while (offset < bytes.byteLength) {
    chunkCount += 1;

    if (chunkCount > MAX_PNG_CHUNKS) {
      return `The ${label} checkpoint exceeds the supported PNG chunk count.`;
    }

    if (offset + 12 > bytes.byteLength) {
      return `The ${label} checkpoint contains a truncated PNG chunk.`;
    }

    const length = readUint32BigEndian(bytes, offset);
    const type = pngChunkType(bytes, offset + 4);
    const chunkEnd = offset + 12 + length;
    const knownChunk = ['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA'].includes(type);
    const ancillary = ((bytes[offset + 4] ?? 0) & 0x20) !== 0;

    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.byteLength) {
      return `The ${label} checkpoint contains an out-of-bounds PNG chunk.`;
    }

    if (!/^[A-Za-z]{4}$/u.test(type) || (!knownChunk && !ancillary)) {
      return `The ${label} checkpoint contains an unsupported critical PNG chunk.`;
    }

    if (iendCount > 0) {
      return `The ${label} checkpoint contains data after the PNG IEND chunk.`;
    }

    if (idatCount > 0 && type !== 'IDAT') {
      idatEnded = true;
    }

    switch (type) {
      case 'IHDR':
        ihdrCount += 1;

        if (ihdrCount > 1) {
          return `The ${label} checkpoint contains more than one PNG IHDR chunk.`;
        }

        if (offset !== 8 || length !== 13) {
          return `The ${label} checkpoint has an invalid PNG IHDR position or length.`;
        }
        break;
      case 'PLTE':
        plteCount += 1;

        if (
          plteCount > 1 ||
          idatCount > 0 ||
          length < 3 ||
          length > 768 ||
          length % 3 !== 0 ||
          colorType === 0 ||
          colorType === 4
        ) {
          return `The ${label} checkpoint has an invalid PNG PLTE chunk.`;
        }

        paletteEntries = length / 3;

        if (colorType === 3 && paletteEntries > 2 ** bitDepth) {
          return `The ${label} checkpoint PNG palette exceeds its bit depth.`;
        }
        break;
      case 'IDAT':
        if (idatEnded || (colorType === 3 && plteCount !== 1)) {
          return `The ${label} checkpoint has an invalid PNG IDAT sequence.`;
        }

        idatCount += 1;
        break;
      case 'tRNS':
        transparencyCount += 1;

        if (transparencyCount > 1 || idatCount > 0) {
          return `The ${label} checkpoint has an invalid PNG tRNS chunk.`;
        }

        if (
          (colorType === 0 && length !== 2) ||
          (colorType === 2 && length !== 6) ||
          (colorType === 3 && (plteCount !== 1 || length < 1 || length > paletteEntries)) ||
          colorType === 4 ||
          colorType === 6
        ) {
          return `The ${label} checkpoint PNG transparency data does not match its color type.`;
        }
        break;
      case 'gAMA':
        gammaCount += 1;

        if (gammaCount > 1 || length !== 4 || plteCount > 0 || idatCount > 0) {
          return `The ${label} checkpoint has an invalid PNG gAMA chunk.`;
        }
        break;
      case 'IEND':
        iendCount += 1;

        if (length !== 0 || chunkEnd !== bytes.byteLength) {
          return `The ${label} checkpoint has an invalid PNG IEND chunk.`;
        }
        break;
    }

    offset = chunkEnd;
  }

  if (ihdrCount !== 1 || idatCount === 0 || iendCount !== 1) {
    return `The ${label} checkpoint is missing required PNG chunks.`;
  }

  return undefined;
}

function inspectPngHeader(bytes: Uint8Array, label: string): PngHeader {
  if (
    bytes.byteLength < 29 ||
    PNG_SIGNATURE.some((value, index) => bytes[index] !== value) ||
    readUint32BigEndian(bytes, 8) !== 13 ||
    String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR'
  ) {
    return {
      width: 0,
      height: 0,
      error: `The ${label} checkpoint is not a structurally valid PNG image.`,
    };
  }

  const chunkError = validatePngChunkStructure(bytes, label);

  if (chunkError) {
    return {
      width: 0,
      height: 0,
      error: chunkError,
    };
  }

  const width = readUint32BigEndian(bytes, 16);
  const height = readUint32BigEndian(bytes, 20);
  const bitDepth = bytes[24] ?? 0;
  const colorType = bytes[25] ?? 0;
  const compressionMethod = bytes[26] ?? 0;
  const filterMethod = bytes[27] ?? 0;
  const interlaceMethod = bytes[28] ?? 0;
  const pixels = width * height;
  const allowedBitDepths = new Map<number, ReadonlySet<number>>([
    [0, new Set([1, 2, 4, 8, 16])],
    [2, new Set([8, 16])],
    [3, new Set([1, 2, 4, 8])],
    [4, new Set([8, 16])],
    [6, new Set([8, 16])],
  ]);

  if (
    width === 0 ||
    height === 0 ||
    width > MAX_PNG_DIMENSION ||
    height > MAX_PNG_DIMENSION ||
    !Number.isSafeInteger(pixels) ||
    pixels > MAX_PNG_PIXELS
  ) {
    return {
      width,
      height,
      error: `The ${label} checkpoint exceeds the supported PNG dimensions or pixel budget.`,
    };
  }

  if (
    !allowedBitDepths.get(colorType)?.has(bitDepth) ||
    compressionMethod !== 0 ||
    filterMethod !== 0
  ) {
    return {
      width,
      height,
      error: `The ${label} checkpoint uses an unsupported PNG color, compression, or filter format.`,
    };
  }

  if (interlaceMethod !== 0) {
    return {
      width,
      height,
      error: `The ${label} checkpoint uses interlaced PNG data, which is rejected before decode.`,
    };
  }

  return { width, height };
}

export function normalizedPerceptualSettings(
  options: ValidationPerceptualOptions | undefined,
  fallback: ValidationPerceptualSettings = DEFAULT_SETTINGS,
): ValidationPerceptualSettings {
  const validated = validatePerceptualOptions(options);
  const settings: ValidationPerceptualSettings = {
    threshold: validated?.threshold ?? fallback.threshold,
    maxDifferenceRatio: validated?.maxDifferenceRatio ?? fallback.maxDifferenceRatio,
    partialDifferenceRatio: validated?.partialDifferenceRatio ?? fallback.partialDifferenceRatio,
    includeAntialiasing: validated?.includeAntialiasing ?? fallback.includeAntialiasing,
  };

  if (settings.partialDifferenceRatio < settings.maxDifferenceRatio) {
    throw new TypeError(
      'perceptual.partialDifferenceRatio must be greater than or equal to maxDifferenceRatio',
    );
  }

  return settings;
}

function failedComparison(
  actualPath: string,
  referencePath: string,
  reason: string,
  settings: ValidationPerceptualSettings,
  actual?: PNG,
  reference?: PNG,
): ValidationPerceptualComparison {
  return {
    outcome: 'error',
    actualPath,
    referencePath,
    ...(actual
      ? {
          actualWidth: actual.width,
          actualHeight: actual.height,
        }
      : {}),
    ...(reference
      ? {
          referenceWidth: reference.width,
          referenceHeight: reference.height,
        }
      : {}),
    settings,
    reason,
  };
}

export async function comparePngScreenshots(
  actualBytes: Uint8Array,
  referenceBytes: Uint8Array,
  paths: {
    actualPath: string;
    referencePath: string;
    diffPath: string;
  },
  settings: ValidationPerceptualSettings,
  signal?: AbortSignal,
): Promise<PngComparisonOutput> {
  throwIfAborted(signal);
  const actualHeader = inspectPngHeader(actualBytes, 'actual');
  const referenceHeader = inspectPngHeader(referenceBytes, 'reference');

  if (actualHeader.error || referenceHeader.error) {
    const headerError =
      actualHeader.error ??
      referenceHeader.error ??
      'The checkpoint PNG header could not be validated.';
    return {
      comparison: {
        outcome: 'error',
        actualPath: paths.actualPath,
        referencePath: paths.referencePath,
        ...(actualHeader.width > 0
          ? {
              actualWidth: actualHeader.width,
              actualHeight: actualHeader.height,
            }
          : {}),
        ...(referenceHeader.width > 0
          ? {
              referenceWidth: referenceHeader.width,
              referenceHeight: referenceHeader.height,
            }
          : {}),
        settings,
        reason: headerError,
      },
    };
  }

  let actual: PNG;
  let reference: PNG;

  try {
    actual = PNG.sync.read(bufferView(actualBytes));
  } catch {
    return {
      comparison: failedComparison(
        paths.actualPath,
        paths.referencePath,
        'The actual checkpoint is not a readable PNG image.',
        settings,
      ),
    };
  }
  await yieldForCancellation(signal);

  try {
    reference = PNG.sync.read(bufferView(referenceBytes));
  } catch {
    return {
      comparison: failedComparison(
        paths.actualPath,
        paths.referencePath,
        'The reference checkpoint is not a readable PNG image.',
        settings,
        actual,
      ),
    };
  }
  await yieldForCancellation(signal);

  if (actual.width !== reference.width || actual.height !== reference.height) {
    return {
      comparison: failedComparison(
        paths.actualPath,
        paths.referencePath,
        'The actual and reference checkpoints have different dimensions.',
        settings,
        actual,
        reference,
      ),
    };
  }

  const diff = new PNG({
    width: actual.width,
    height: actual.height,
  });
  const differingPixels = pixelmatch(
    actual.data,
    reference.data,
    diff.data,
    actual.width,
    actual.height,
    {
      threshold: settings.threshold,
      includeAA: settings.includeAntialiasing,
      alpha: 0.65,
      diffColor: [190, 36, 36],
      aaColor: [229, 153, 32],
    },
  );
  await yieldForCancellation(signal);
  const totalPixels = actual.width * actual.height;
  const differenceRatio = totalPixels === 0 ? 1 : differingPixels / totalPixels;
  const outcome =
    differenceRatio <= settings.maxDifferenceRatio
      ? ('match' as const)
      : differenceRatio <= settings.partialDifferenceRatio
        ? ('partial' as const)
        : ('mismatch' as const);

  const encodedDiff = PNG.sync.write(diff);
  await yieldForCancellation(signal);

  return {
    comparison: {
      outcome,
      actualPath: paths.actualPath,
      referencePath: paths.referencePath,
      diffPath: paths.diffPath,
      actualWidth: actual.width,
      actualHeight: actual.height,
      referenceWidth: reference.width,
      referenceHeight: reference.height,
      differingPixels,
      totalPixels,
      differenceRatio: roundedRatio(differenceRatio),
      similarity: roundedRatio(1 - differenceRatio),
      settings,
    },
    diff: encodedDiff,
  };
}
