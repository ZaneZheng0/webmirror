import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { comparePngScreenshots, normalizedPerceptualSettings } from './perceptual.js';

function solidPng(
  width: number,
  height: number,
  color: [number, number, number, number],
): Uint8Array {
  const image = new PNG({ width, height });

  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = color[0];
    image.data[offset + 1] = color[1];
    image.data[offset + 2] = color[2];
    image.data[offset + 3] = color[3];
  }

  return PNG.sync.write(image);
}

function replacePixel(
  source: Uint8Array,
  x: number,
  y: number,
  color: [number, number, number, number],
): Uint8Array {
  const image = PNG.sync.read(Buffer.from(source));
  const offset = (y * image.width + x) * 4;
  image.data[offset] = color[0];
  image.data[offset + 1] = color[1];
  image.data[offset + 2] = color[2];
  image.data[offset + 3] = color[3];
  return PNG.sync.write(image);
}

function declaredPngDimensions(width: number, height: number, interlaceMethod = 0): Uint8Array {
  const bytes = Buffer.from(solidPng(1, 1, [0, 0, 0, 255]));
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[28] = interlaceMethod;
  return bytes;
}

function duplicateIhdr(source: Uint8Array): Uint8Array {
  const duplicate = Buffer.alloc(25);
  duplicate.writeUInt32BE(13, 0);
  duplicate.write('IHDR', 4, 'ascii');
  duplicate.writeUInt32BE(100_000, 8);
  duplicate.writeUInt32BE(100_000, 12);
  duplicate[16] = 8;
  duplicate[17] = 6;
  duplicate[18] = 0;
  duplicate[19] = 0;
  duplicate[20] = 1;
  return Buffer.concat([
    Buffer.from(source).subarray(0, 33),
    duplicate,
    Buffer.from(source).subarray(33),
  ]);
}

function addEmptyAncillaryChunks(source: Uint8Array, count: number): Uint8Array {
  const chunks = Buffer.alloc(count * 12);

  for (let offset = 0; offset < chunks.byteLength; offset += 12) {
    chunks.writeUInt32BE(0, offset);
    chunks.write('tEXt', offset + 4, 'ascii');
  }

  return Buffer.concat([
    Buffer.from(source).subarray(0, source.byteLength - 12),
    chunks,
    Buffer.from(source).subarray(source.byteLength - 12),
  ]);
}

function addChunkAfterIhdr(source: Uint8Array, type: string, data: Uint8Array): Uint8Array {
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  chunk.write(type, 4, 'ascii');
  Buffer.from(data).copy(chunk, 8);
  return Buffer.concat([
    Buffer.from(source).subarray(0, 33),
    chunk,
    Buffer.from(source).subarray(33),
  ]);
}

describe('perceptual PNG comparison', () => {
  it('classifies a small tolerated difference as partial instead of strict failure', async () => {
    const reference = solidPng(10, 10, [40, 90, 130, 255]);
    const actual = replacePixel(reference, 4, 4, [240, 30, 30, 255]);
    const output = await comparePngScreenshots(
      actual,
      reference,
      {
        actualPath: 'actual.png',
        referencePath: 'reference.png',
        diffPath: 'diff.png',
      },
      normalizedPerceptualSettings({
        threshold: 0.05,
        maxDifferenceRatio: 0,
        partialDifferenceRatio: 0.02,
      }),
    );

    expect(output.comparison).toMatchObject({
      outcome: 'partial',
      differingPixels: 1,
      totalPixels: 100,
      differenceRatio: 0.01,
      similarity: 0.99,
    });
    expect(output.diff?.byteLength).toBeGreaterThan(0);
  });

  it('reports large differences and incompatible dimensions without throwing', async () => {
    const dark = solidPng(8, 8, [20, 30, 40, 255]);
    const light = solidPng(8, 8, [230, 235, 240, 255]);
    const settings = normalizedPerceptualSettings({
      maxDifferenceRatio: 0.01,
      partialDifferenceRatio: 0.1,
    });
    const mismatch = await comparePngScreenshots(
      dark,
      light,
      {
        actualPath: 'actual.png',
        referencePath: 'reference.png',
        diffPath: 'diff.png',
      },
      settings,
    );
    const dimensions = await comparePngScreenshots(
      solidPng(4, 4, [0, 0, 0, 255]),
      solidPng(5, 4, [0, 0, 0, 255]),
      {
        actualPath: 'actual.png',
        referencePath: 'reference.png',
        diffPath: 'diff.png',
      },
      settings,
    );

    expect(mismatch.comparison.outcome).toBe('mismatch');
    expect(dimensions.comparison).toMatchObject({
      outcome: 'error',
      reason: 'The actual and reference checkpoints have different dimensions.',
      actualWidth: 4,
      referenceWidth: 5,
    });
    expect(dimensions.diff).toBeUndefined();
  });

  it('rejects a PNG pixel-allocation bomb before decoding image data', async () => {
    const settings = normalizedPerceptualSettings(undefined);
    const bomb = await comparePngScreenshots(
      declaredPngDimensions(100_000, 100_000),
      solidPng(1, 1, [0, 0, 0, 255]),
      {
        actualPath: 'actual.png',
        referencePath: 'reference.png',
        diffPath: 'diff.png',
      },
      settings,
    );

    expect(bomb.comparison).toMatchObject({
      outcome: 'error',
      actualWidth: 100_000,
      actualHeight: 100_000,
      reason: 'The actual checkpoint exceeds the supported PNG dimensions or pixel budget.',
    });
    expect(bomb.diff).toBeUndefined();
  });

  it('rejects interlaced PNG data before the unbounded decoder path', async () => {
    const interlaced = await comparePngScreenshots(
      declaredPngDimensions(16, 16, 1),
      solidPng(16, 16, [0, 0, 0, 255]),
      {
        actualPath: 'actual.png',
        referencePath: 'reference.png',
        diffPath: 'diff.png',
      },
      normalizedPerceptualSettings(undefined),
    );

    expect(interlaced.comparison).toMatchObject({
      outcome: 'error',
      actualWidth: 16,
      actualHeight: 16,
      reason: 'The actual checkpoint uses interlaced PNG data, which is rejected before decode.',
    });
    expect(interlaced.diff).toBeUndefined();
  });

  it('rejects a later IHDR that could override preflighted dimensions', async () => {
    const valid = solidPng(16, 16, [0, 0, 0, 255]);
    const duplicate = await comparePngScreenshots(
      duplicateIhdr(valid),
      valid,
      {
        actualPath: 'actual.png',
        referencePath: 'reference.png',
        diffPath: 'diff.png',
      },
      normalizedPerceptualSettings(undefined),
    );

    expect(duplicate.comparison).toMatchObject({
      outcome: 'error',
      reason: 'The actual checkpoint contains more than one PNG IHDR chunk.',
    });
    expect(duplicate.diff).toBeUndefined();
  });

  it('bounds PNG chunk scanning before decoder invocation', async () => {
    const valid = solidPng(1, 1, [0, 0, 0, 255]);
    const excessive = await comparePngScreenshots(
      addEmptyAncillaryChunks(valid, 10_001),
      valid,
      {
        actualPath: 'actual.png',
        referencePath: 'reference.png',
        diffPath: 'diff.png',
      },
      normalizedPerceptualSettings(undefined),
    );

    expect(excessive.comparison).toMatchObject({
      outcome: 'error',
      reason: 'The actual checkpoint exceeds the supported PNG chunk count.',
    });
  });

  it('rejects an oversized palette before pngjs expands it into JavaScript arrays', async () => {
    const valid = solidPng(1, 1, [0, 0, 0, 255]);
    const palette = await comparePngScreenshots(
      addChunkAfterIhdr(valid, 'PLTE', Buffer.alloc(771)),
      valid,
      {
        actualPath: 'actual.png',
        referencePath: 'reference.png',
        diffPath: 'diff.png',
      },
      normalizedPerceptualSettings(undefined),
    );

    expect(palette.comparison).toMatchObject({
      outcome: 'error',
      reason: 'The actual checkpoint has an invalid PNG PLTE chunk.',
    });
  });

  it('observes cancellation between bounded comparison phases', async () => {
    const controller = new AbortController();
    const image = solidPng(1_024, 1_024, [30, 60, 90, 255]);
    setImmediate(() => controller.abort());

    await expect(
      comparePngScreenshots(
        image,
        image,
        {
          actualPath: 'actual.png',
          referencePath: 'reference.png',
          diffPath: 'diff.png',
        },
        normalizedPerceptualSettings(undefined),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
