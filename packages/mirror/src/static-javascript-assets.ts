import { posix } from 'node:path';

import {
  parseExpressionAt,
  type AnyNode,
  type CallExpression,
  type ForStatement,
  type MemberExpression,
  type Program,
} from 'acorn';
import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';

import { isKnownNonessentialExternalUrl, isSensitiveQueryName } from '@webmirror/shared';

import {
  hasLikelyStaticAssetShape,
  hasLikelyStaticAssetShapeWithUnencodedSpaces,
} from './rewriter-core.js';

type LoaderCategory = 'audio' | 'font' | 'geometry' | 'gltf' | 'image' | 'video';
type StaticScalar = boolean | number | string;
type StaticValues = readonly StaticValue[];
type StaticEnvironment = ReadonlyMap<string, StaticValues>;
type MutableStaticEnvironment = Map<string, StaticValues>;
type StaticFunctionNode = Extract<
  AnyNode,
  { type: 'ArrowFunctionExpression' | 'FunctionExpression' }
>;

interface StaticArray {
  readonly kind: 'array';
  readonly values: StaticValues;
}

interface StaticObject {
  readonly kind: 'object';
  readonly properties: ReadonlyMap<string, StaticValues>;
}

interface StaticFunction {
  readonly kind: 'function';
  readonly node: StaticFunctionNode;
  readonly environment: StaticEnvironment;
  readonly boundArguments: readonly StaticValues[];
}

type StaticValue = StaticArray | StaticFunction | StaticObject | StaticScalar;

export interface StaticJavaScriptAssetDiscovery {
  readonly dependencies: readonly string[];
  readonly workerDependencies: readonly string[];
  readonly handledArgumentRanges: ReadonlySet<string>;
}

interface AssetTemplatePlaceholder {
  readonly name: string;
  readonly choices: readonly string[];
  readonly acceptsAnyValue: boolean;
}

interface AssetTemplateLiteralPart {
  readonly kind: 'literal';
  readonly value: string;
}

interface AssetTemplatePlaceholderPart {
  readonly kind: 'placeholder';
  readonly placeholder: AssetTemplatePlaceholder;
}

type AssetTemplatePart = AssetTemplateLiteralPart | AssetTemplatePlaceholderPart;

interface AssetTemplate {
  readonly source: string;
  readonly parts: readonly AssetTemplatePart[];
}

interface StructuredAssetReferences {
  readonly direct: readonly string[];
  readonly templates: readonly AssetTemplate[];
}

interface StructuredAssetExclusions {
  readonly suppressedSourceValueRanges: ReadonlySet<string>;
  readonly suppressedSourcePaths: ReadonlySet<string>;
  readonly deploymentReferences: readonly string[];
}

interface StaticAssetInventoryRecord {
  readonly filename: string;
  readonly normalizedFilename: string;
}

interface AssetTemplateInference {
  readonly baseUrl: string;
  readonly values: ReadonlyMap<string, ReadonlySet<string>>;
}

const maxAssetCandidates = 5_000;
const maxArrayItems = 64;
const maxExpressionDepth = 16;
const maxStaticValues = 64;
const maxTemplateExpansions = 16;
const maxCallbackExpansions = 256;
const maxEmbeddedHtmlBytes = 256 * 1024;
const maxEmbeddedHtmlExpansions = 64;
const maxEmbeddedJsonBytes = 2 * 1024 * 1024;
const maxEmbeddedJsonDocuments = 32;
const maxEmbeddedJsonDepth = 128;
const maxEmbeddedJsonTotalBytes = 4 * 1024 * 1024;
const maxEmbeddedJsonValues = 100_000;
const minimumObservedInventoryMatches = 2;
const dynamicHtmlTemplateMarker = 'webmirror-dynamic-template-value';
const staticJsonObjectDefaultsKey = '\0webmirror:json-object-defaults';
const assetLoaderMethods = new Set([
  'batched',
  'curves',
  'fromUrl',
  'load',
  'loadAsync',
  'preload',
  'preloadAsync',
  'skinAnimation',
]);
const imageExtensions = new Set([
  '.avif',
  '.basis',
  '.bmp',
  '.dds',
  '.exr',
  '.gif',
  '.hdr',
  '.icon',
  '.jpeg',
  '.jpg',
  '.ktx',
  '.ktx2',
  '.png',
  '.pvr',
  '.svg',
  '.tif',
  '.tiff',
  '.webp',
]);
const audioExtensions = new Set([
  '.aac',
  '.flac',
  '.m4a',
  '.mp3',
  '.oga',
  '.ogg',
  '.opus',
  '.wav',
  '.webm',
]);
const videoExtensions = new Set(['.m4v', '.mov', '.mp4', '.ogv', '.webm']);
const fontExtensions = new Set(['.eot', '.otf', '.ttf', '.woff', '.woff2']);
const contextualFontExtensions = new Set([...fontExtensions, '.txt']);
const structuredAssetPropertyNames = new Set([
  'asset',
  'audio',
  'file',
  'font',
  'image',
  'manifest',
  'model',
  'resource',
  'sound',
  'source',
  'src',
  'texture',
  'uri',
  'urls',
  'video',
  'wasm',
  'worker',
]);
const structuredObjectAssetPropertyNames = new Set(['source', 'src', 'uri', 'url']);
const embeddedHtmlResourceAttributeNames = new Set(['data', 'poster', 'src']);
const embeddedHtmlResourceHrefElementNames = new Set(['image', 'use']);
const finiteIdentityPropertyNames = new Set(['id', 'key', 'name', 'slug']);
const knownResolutionValues = new Set(['desktop', 'mobile', 'tablet']);
const deferredRuntimeAssetExtensions = new Set([
  '.aac',
  '.basis',
  '.bin',
  '.cjs',
  '.css',
  '.dds',
  '.drc',
  '.flac',
  '.frag',
  '.glb',
  '.gltf',
  '.glsl',
  '.hdr',
  '.js',
  '.json',
  '.ktx',
  '.ktx2',
  '.m4a',
  '.m4v',
  '.mov',
  '.mp3',
  '.mp4',
  '.mjs',
  '.oga',
  '.ogg',
  '.ogv',
  '.opus',
  '.otf',
  '.riv',
  '.shader',
  '.ttf',
  '.vert',
  '.wasm',
  '.wav',
  '.webm',
  '.webmanifest',
  '.woff',
  '.woff2',
]);
const deferredRenderedImageExtensions = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.tif',
  '.tiff',
  '.webp',
]);

function isTemplateToken(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 64 &&
    [...value].every((character) => /[A-Za-z0-9_.-]/u.test(character))
  );
}

function parseAssetTemplate(value: string): AssetTemplate | undefined {
  if (!value.includes('{') || [...value].some((character) => /\s/u.test(character))) {
    return undefined;
  }

  const parts: AssetTemplatePart[] = [];
  let cursor = 0;
  let placeholders = 0;

  while (cursor < value.length) {
    const opening = value.indexOf('{', cursor);

    if (opening < 0) {
      if (value.indexOf('}', cursor) >= 0) {
        return undefined;
      }

      parts.push({ kind: 'literal', value: value.slice(cursor) });
      break;
    }

    if (value.indexOf('}', cursor) >= 0 && value.indexOf('}', cursor) < opening) {
      return undefined;
    }

    parts.push({ kind: 'literal', value: value.slice(cursor, opening) });
    const closing = value.indexOf('}', opening + 1);
    const nestedOpening = value.indexOf('{', opening + 1);

    if (closing < 0 || (nestedOpening >= 0 && nestedOpening < closing)) {
      return undefined;
    }

    const descriptor = value.slice(opening + 1, closing);
    const separator = descriptor.indexOf(':');
    const name = (separator < 0 ? descriptor : descriptor.slice(0, separator)).trim();
    const choices =
      separator < 0
        ? []
        : descriptor
            .slice(separator + 1)
            .split(',')
            .map((choice) => choice.trim());

    if (
      !isTemplateToken(name) ||
      choices.some((choice) => !isTemplateToken(choice)) ||
      placeholders >= 8
    ) {
      return undefined;
    }

    parts.push({
      kind: 'placeholder',
      placeholder: {
        name,
        choices: choices.filter((choice) => choice.toLowerCase() !== 'all'),
        acceptsAnyValue:
          choices.length === 0 || choices.some((choice) => choice.toLowerCase() === 'all'),
      },
    });
    placeholders += 1;
    cursor = closing + 1;
  }

  if (placeholders === 0) {
    return undefined;
  }

  if (parts.at(-1)?.kind === 'placeholder') {
    parts.push({ kind: 'literal', value: '' });
  }

  return { source: value, parts };
}

function sampleTemplateReference(template: AssetTemplate): string {
  return template.parts
    .map((part) => {
      if (part.kind === 'literal') {
        return part.value;
      }

      const choice = part.placeholder.choices[0];

      if (choice) {
        return choice;
      }

      const name = part.placeholder.name.toLowerCase();

      if (name.includes('audio') || name.includes('sound')) {
        return 'ogg';
      }

      if (name.includes('video') || name.includes('movie')) {
        return 'mp4';
      }

      return 'value';
    })
    .join('');
}

function looksLikeAssetTemplate(template: AssetTemplate): boolean {
  return hasLikelyStaticAssetShape(sampleTemplateReference(template));
}

function looksLikeStructuredAssetValue(value: string): boolean {
  const template = parseAssetTemplate(value);
  return template
    ? looksLikeAssetTemplate(template)
    : hasLikelyStaticAssetShapeWithUnencodedSpaces(value);
}

function isAstNode(value: unknown): value is AnyNode {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate = value as {
    end?: unknown;
    start?: unknown;
    type?: unknown;
  };

  return (
    typeof candidate.type === 'string' &&
    typeof candidate.start === 'number' &&
    typeof candidate.end === 'number'
  );
}

function staticPropertyName(node: AnyNode | undefined): string | undefined {
  if (!node) {
    return undefined;
  }

  if (node.type === 'Identifier') {
    return node.name;
  }

  return node.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
}

function rangeKey(node: AnyNode): string {
  return `${node.start}:${node.end}`;
}

function isStaticArray(value: StaticValue): value is StaticArray {
  return typeof value === 'object' && value !== null && value.kind === 'array';
}

function isStaticFunction(value: StaticValue): value is StaticFunction {
  return typeof value === 'object' && value !== null && value.kind === 'function';
}

function isStaticObject(value: StaticValue): value is StaticObject {
  return typeof value === 'object' && value !== null && value.kind === 'object';
}

function uniqueStrings(values: Iterable<string>, maximum = maxStaticValues): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);

    if (result.length >= maximum) {
      break;
    }
  }

  return result;
}

function scalarStrings(values: StaticValues): string[] {
  return uniqueStrings(
    values.flatMap((value) =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? [String(value)]
        : [],
    ),
  );
}

function nestedScalarStrings(
  values: StaticValues,
  accept: (value: string) => boolean = () => true,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  const visit = (value: StaticValue): void => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const scalar = String(value);

      if (accept(scalar) && !seen.has(scalar)) {
        seen.add(scalar);
        result.push(scalar);
      }

      return;
    }

    if (isStaticArray(value)) {
      for (const item of value.values) {
        visit(item);

        if (result.length >= maxStaticValues) {
          return;
        }
      }

      return;
    }

    if (isStaticObject(value)) {
      for (const propertyValues of value.properties.values()) {
        for (const propertyValue of propertyValues) {
          visit(propertyValue);

          if (result.length >= maxStaticValues) {
            return;
          }
        }
      }
    }
  };

  for (const value of values) {
    visit(value);

    if (result.length >= maxStaticValues) {
      break;
    }
  }

  return result;
}

function scalarNumbers(values: StaticValues): number[] {
  const result: number[] = [];
  const seen = new Set<number>();

  for (const value of values) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);

    if (result.length >= maxStaticValues) {
      break;
    }
  }

  return result;
}

function numericBinaryValues(
  operator: string,
  left: StaticValues,
  right: StaticValues,
): StaticValues {
  const leftNumbers = scalarNumbers(left);
  const rightNumbers = scalarNumbers(right);

  if (leftNumbers.length === 0 || rightNumbers.length === 0) {
    return [];
  }

  const results: number[] = [];

  for (const leftValue of leftNumbers) {
    for (const rightValue of rightNumbers) {
      const value =
        operator === '+'
          ? leftValue + rightValue
          : operator === '-'
            ? leftValue - rightValue
            : undefined;

      if (value !== undefined && Number.isSafeInteger(value)) {
        results.push(value);
      }
    }
  }

  return uniqueStrings(results.map(String)).map(Number);
}

function staticArrays(values: StaticValues): StaticArray[] {
  return values.filter(isStaticArray).slice(0, maxStaticValues);
}

function staticObjects(values: StaticValues): StaticObject[] {
  return values.filter(isStaticObject).slice(0, maxStaticValues);
}

function staticFunctions(values: StaticValues): StaticFunction[] {
  return values.filter(isStaticFunction).slice(0, maxStaticValues);
}

function combineTextValues(parts: readonly string[][]): string[] {
  let results = [''];

  for (const part of parts) {
    if (part.length === 0) {
      return [];
    }

    const next: string[] = [];

    for (const prefix of results) {
      for (const suffix of part) {
        next.push(`${prefix}${suffix}`);

        if (next.length >= maxStaticValues) {
          break;
        }
      }

      if (next.length >= maxStaticValues) {
        break;
      }
    }

    results = uniqueStrings(next);
  }

  return results;
}

function propertyNames(
  node: MemberExpression,
  environment: StaticEnvironment,
  propertyDefaults: ReadonlyMap<string, StaticValues>,
  sourceOrigin: string,
  depth: number,
): string[] {
  if (!node.computed) {
    const name = staticPropertyName(node.property);
    return name ? [name] : [];
  }

  return scalarStrings(
    evaluateStaticExpression(node.property, environment, propertyDefaults, sourceOrigin, depth + 1),
  );
}

function functionReturnExpression(node: AnyNode): AnyNode | undefined {
  if (node.type !== 'ArrowFunctionExpression' && node.type !== 'FunctionExpression') {
    return undefined;
  }

  if (node.body.type !== 'BlockStatement') {
    return node.body;
  }

  if (node.body.body.length !== 1 || node.body.body[0]?.type !== 'ReturnStatement') {
    return undefined;
  }

  return node.body.body[0].argument ?? undefined;
}

function staticIterableCallback(
  node: AnyNode | undefined,
  environment: StaticEnvironment,
  propertyDefaults: ReadonlyMap<string, StaticValues>,
  sourceOrigin: string,
): StaticFunction | undefined {
  if (!node) {
    return undefined;
  }

  return staticFunctions(
    evaluateStaticExpression(node, environment, propertyDefaults, sourceOrigin),
  )[0];
}

function isArrayFromCall(node: CallExpression): boolean {
  return (
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'Array' &&
    staticPropertyName(node.callee.property) === 'from'
  );
}

function arrayInputValues(
  input: AnyNode,
  environment: StaticEnvironment,
  propertyDefaults: ReadonlyMap<string, StaticValues>,
  sourceOrigin: string,
  depth: number,
): StaticValues {
  const inputValues = evaluateStaticExpression(
    input,
    environment,
    propertyDefaults,
    sourceOrigin,
    depth + 1,
  );
  const inputArrays = staticArrays(inputValues);

  if (inputArrays.length > 0) {
    return inputArrays.slice(0, 1);
  }

  if (input.type !== 'ObjectExpression') {
    return [];
  }

  const lengthProperty = input.properties.find(
    (property) =>
      property.type === 'Property' &&
      property.kind === 'init' &&
      !property.computed &&
      staticPropertyName(property.key) === 'length',
  );

  if (!lengthProperty || lengthProperty.type !== 'Property') {
    return [];
  }

  const lengths = scalarNumbers(
    evaluateStaticExpression(
      lengthProperty.value,
      environment,
      propertyDefaults,
      sourceOrigin,
      depth + 1,
    ),
  ).filter((length) => length >= 0 && length <= maxArrayItems);

  const length = lengths[0];

  if (length === undefined) {
    return [];
  }

  return [
    {
      kind: 'array',
      values: Array.from({ length }, (_, index) => index),
    },
  ];
}

function arrayFromValues(
  node: CallExpression,
  environment: StaticEnvironment,
  propertyDefaults: ReadonlyMap<string, StaticValues>,
  sourceOrigin: string,
  depth: number,
): StaticValues {
  const input = node.arguments[0];

  if (!isAstNode(input)) {
    return [];
  }

  const values = arrayInputValues(input, environment, propertyDefaults, sourceOrigin, depth);

  if (values.length === 0 || node.arguments[1] === undefined) {
    return values;
  }

  const callback = node.arguments[1];

  if (
    !isAstNode(callback) ||
    (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression')
  ) {
    return [];
  }

  const indexParameter = callback.params[1];
  const returnExpression = functionReturnExpression(callback);

  return indexParameter?.type === 'Identifier' &&
    returnExpression?.type === 'Identifier' &&
    returnExpression.name === indexParameter.name
    ? values
    : [];
}

function objectKeysValues(
  node: CallExpression,
  environment: StaticEnvironment,
  propertyDefaults: ReadonlyMap<string, StaticValues>,
  sourceOrigin: string,
  depth: number,
): StaticValues {
  const input = node.arguments[0];

  if (!isAstNode(input)) {
    return [];
  }

  const keys = staticObjects(
    evaluateStaticExpression(input, environment, propertyDefaults, sourceOrigin, depth + 1),
  ).flatMap((value) => [...value.properties.keys()]);

  return keys.length > 0
    ? [
        {
          kind: 'array',
          values: uniqueStrings(keys).slice(0, maxArrayItems),
        },
      ]
    : [];
}

function objectValuesValues(
  node: CallExpression,
  environment: StaticEnvironment,
  propertyDefaults: ReadonlyMap<string, StaticValues>,
  sourceOrigin: string,
  depth: number,
): StaticValues {
  const input = node.arguments[0];

  if (!isAstNode(input)) {
    return [];
  }

  const values = staticObjects(
    evaluateStaticExpression(input, environment, propertyDefaults, sourceOrigin, depth + 1),
  ).flatMap((value) => [...value.properties.values()].flat());

  return values.length > 0
    ? [
        {
          kind: 'array',
          values: values.slice(0, maxArrayItems),
        },
      ]
    : [];
}

function flattenArrayValues(values: StaticValues): StaticValues {
  const flattened: StaticValue[] = [];

  for (const value of staticArrays(values)) {
    for (const item of value.values) {
      if (isStaticArray(item)) {
        flattened.push(...item.values);
      } else {
        flattened.push(item);
      }

      if (flattened.length >= maxArrayItems) {
        break;
      }
    }
  }

  return flattened.length > 0 ? [{ kind: 'array', values: flattened }] : [];
}

function ensureAvatarUrl(values: StaticValues): StaticValues {
  return uniqueStrings(
    scalarStrings(values)
      .filter((value) => /^[A-Za-z0-9_./-]+$/u.test(value))
      .map((value) => {
        const normalized = value.replace('.', '');
        return normalized.startsWith('avatar') ? normalized : `avatar/${normalized}`;
      }),
  );
}

function jsonStaticValue(value: unknown, depth = 0): StaticValue | undefined {
  if (depth > maxExpressionDepth) {
    return undefined;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    const values: StaticValue[] = [];

    for (const item of value.slice(0, maxArrayItems)) {
      const converted = jsonStaticValue(item, depth + 1);

      if (converted !== undefined) {
        values.push(converted);
      }
    }

    return { kind: 'array', values };
  }

  if (value !== null && typeof value === 'object') {
    const properties = new Map<string, StaticValues>();

    for (const [name, item] of Object.entries(value).slice(0, maxArrayItems)) {
      const converted = jsonStaticValue(item, depth + 1);

      if (converted !== undefined) {
        properties.set(name, [converted]);
      }
    }

    return { kind: 'object', properties };
  }

  return undefined;
}

function evaluateStaticExpression(
  node: AnyNode | undefined,
  environment: StaticEnvironment,
  propertyDefaults: ReadonlyMap<string, StaticValues>,
  sourceOrigin: string,
  depth = 0,
): StaticValues {
  if (!node || depth > maxExpressionDepth) {
    return [];
  }

  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' ||
        typeof node.value === 'number' ||
        typeof node.value === 'boolean'
        ? [node.value]
        : [];
    case 'Identifier':
      return environment.get(node.name) ?? [];
    case 'TemplateLiteral': {
      const parts: string[][] = [];

      for (let index = 0; index < node.quasis.length; index += 1) {
        const quasi = node.quasis[index];
        const literal = quasi?.value.cooked ?? quasi?.value.raw;

        if (typeof literal !== 'string') {
          return [];
        }

        parts.push([literal]);

        const expression = node.expressions[index];

        if (expression) {
          parts.push(
            scalarStrings(
              evaluateStaticExpression(
                expression,
                environment,
                propertyDefaults,
                sourceOrigin,
                depth + 1,
              ),
            ),
          );
        }
      }

      return combineTextValues(parts);
    }
    case 'BinaryExpression': {
      if (node.operator !== '+' && node.operator !== '-') {
        return [];
      }

      const left = evaluateStaticExpression(
        node.left,
        environment,
        propertyDefaults,
        sourceOrigin,
        depth + 1,
      );
      const right = evaluateStaticExpression(
        node.right,
        environment,
        propertyDefaults,
        sourceOrigin,
        depth + 1,
      );
      const numericValues = numericBinaryValues(node.operator, left, right);

      if (numericValues.length > 0) {
        return numericValues;
      }

      if (node.operator !== '+') {
        return [];
      }

      return combineTextValues([scalarStrings(left), scalarStrings(right)]);
    }
    case 'ConditionalExpression':
      return [
        ...evaluateStaticExpression(
          node.consequent,
          environment,
          propertyDefaults,
          sourceOrigin,
          depth + 1,
        ),
        ...evaluateStaticExpression(
          node.alternate,
          environment,
          propertyDefaults,
          sourceOrigin,
          depth + 1,
        ),
      ].slice(0, maxStaticValues);
    case 'LogicalExpression':
      return [
        ...evaluateStaticExpression(
          node.left,
          environment,
          propertyDefaults,
          sourceOrigin,
          depth + 1,
        ),
        ...evaluateStaticExpression(
          node.right,
          environment,
          propertyDefaults,
          sourceOrigin,
          depth + 1,
        ),
      ].slice(0, maxStaticValues);
    case 'UnaryExpression': {
      const values = scalarNumbers(
        evaluateStaticExpression(
          node.argument,
          environment,
          propertyDefaults,
          sourceOrigin,
          depth + 1,
        ),
      );

      if (node.operator === '+') {
        return values;
      }

      return node.operator === '-' ? values.map((value) => -value) : [];
    }
    case 'ArrayExpression': {
      const values: StaticValue[] = [];

      for (const item of node.elements) {
        if (!isAstNode(item)) {
          return [];
        }

        for (const value of evaluateStaticExpression(
          item,
          environment,
          propertyDefaults,
          sourceOrigin,
          depth + 1,
        )) {
          values.push(value);

          if (values.length >= maxArrayItems) {
            break;
          }
        }

        if (values.length >= maxArrayItems) {
          break;
        }
      }

      return [{ kind: 'array', values }];
    }
    case 'ObjectExpression': {
      const properties = new Map<string, StaticValues>();

      for (const property of node.properties) {
        if (
          property.type !== 'Property' ||
          property.kind !== 'init' ||
          property.method ||
          property.computed
        ) {
          continue;
        }

        const name = staticPropertyName(property.key);

        if (!name) {
          continue;
        }

        const values = evaluateStaticExpression(
          property.value,
          environment,
          propertyDefaults,
          sourceOrigin,
          depth + 1,
        );

        if (values.length > 0) {
          properties.set(name, values.slice(0, maxStaticValues));
        }
      }

      return [{ kind: 'object', properties }];
    }
    case 'MemberExpression': {
      const names = propertyNames(node, environment, propertyDefaults, sourceOrigin, depth);
      const values: StaticValue[] = [];

      for (const object of evaluateStaticExpression(
        node.object,
        environment,
        propertyDefaults,
        sourceOrigin,
        depth + 1,
      )) {
        if (isStaticObject(object)) {
          for (const name of names) {
            values.push(...(object.properties.get(name) ?? []));
          }
        } else if (isStaticArray(object)) {
          for (const name of names) {
            const index = Number(name);

            if (Number.isSafeInteger(index) && index >= 0 && index < object.values.length) {
              const item = object.values[index];

              if (item !== undefined) {
                values.push(item);
              }
            }
          }
        }
      }

      if (values.length > 0) {
        return values.slice(0, maxStaticValues);
      }

      const defaults: StaticValue[] = [];

      for (const name of names) {
        if (name === 'absolutePath') {
          defaults.push(sourceOrigin);
        }

        // Identity fields occur throughout component trees and registries. If
        // the receiver itself is unknown, borrowing every global `id`, `key`,
        // `name`, or `slug` value crosses unrelated object contexts and can
        // manufacture loader URLs such as `cdn.example/email.js`. Finite,
        // evidence-backed identity domains are handled separately below.
        if (finiteIdentityPropertyNames.has(name)) {
          continue;
        }

        defaults.push(...(propertyDefaults.get(name) ?? []));
      }

      return defaults.slice(0, maxStaticValues);
    }
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return [
        {
          kind: 'function',
          node,
          environment,
          boundArguments: [],
        },
      ];
    case 'CallExpression': {
      if (isArrayFromCall(node)) {
        return arrayFromValues(node, environment, propertyDefaults, sourceOrigin, depth);
      }

      if (
        node.callee.type === 'MemberExpression' &&
        !node.callee.computed &&
        node.callee.object.type === 'Identifier' &&
        node.callee.object.name === 'Object'
      ) {
        const method = staticPropertyName(node.callee.property);

        if (method === 'keys') {
          return objectKeysValues(node, environment, propertyDefaults, sourceOrigin, depth);
        }

        if (method === 'values') {
          return objectValuesValues(node, environment, propertyDefaults, sourceOrigin, depth);
        }
      }

      if (node.callee.type === 'MemberExpression') {
        const method = staticPropertyName(node.callee.property);

        if (
          method === 'parse' &&
          !node.callee.computed &&
          node.callee.object.type === 'Identifier' &&
          node.callee.object.name === 'JSON'
        ) {
          const argument = node.arguments[0];

          if (!isAstNode(argument)) {
            return [];
          }

          const documents = scalarStrings(
            evaluateStaticExpression(
              argument,
              environment,
              propertyDefaults,
              sourceOrigin,
              depth + 1,
            ),
          ).filter((value) => value.length <= maxEmbeddedJsonBytes);
          const parsedValues: StaticValue[] = [];

          for (const document of documents) {
            try {
              const converted = jsonStaticValue(JSON.parse(document) as unknown);

              if (converted !== undefined) {
                parsedValues.push(converted);
              }
            } catch {
              // Invalid JSON is not a finite static value.
            }
          }

          return parsedValues.slice(0, maxStaticValues);
        }

        if (method === 'concat') {
          const parts = [
            scalarStrings(
              evaluateStaticExpression(
                node.callee.object,
                environment,
                propertyDefaults,
                sourceOrigin,
                depth + 1,
              ),
            ),
          ];

          for (const argument of node.arguments) {
            if (!isAstNode(argument)) {
              return [];
            }

            parts.push(
              scalarStrings(
                evaluateStaticExpression(
                  argument,
                  environment,
                  propertyDefaults,
                  sourceOrigin,
                  depth + 1,
                ),
              ),
            );
          }

          return combineTextValues(parts);
        }

        if (method === 'join') {
          const separators =
            node.arguments.length === 0
              ? [',']
              : isAstNode(node.arguments[0])
                ? scalarStrings(
                    evaluateStaticExpression(
                      node.arguments[0],
                      environment,
                      propertyDefaults,
                      sourceOrigin,
                      depth + 1,
                    ),
                  )
                : [];
          const values: string[] = [];

          for (const array of staticArrays(
            evaluateStaticExpression(
              node.callee.object,
              environment,
              propertyDefaults,
              sourceOrigin,
              depth + 1,
            ),
          )) {
            const parts = array.values.map((value) =>
              typeof value === 'string' ? value : undefined,
            );

            if (parts.some((value) => value === undefined)) {
              continue;
            }

            for (const separator of separators) {
              values.push(parts.join(separator));

              if (values.length >= maxStaticValues) {
                return values;
              }
            }
          }

          return values;
        }

        if (method === 'bind') {
          const functions = staticFunctions(
            evaluateStaticExpression(
              node.callee.object,
              environment,
              propertyDefaults,
              sourceOrigin,
              depth + 1,
            ),
          );
          const boundArguments: StaticValues[] = [];

          for (const argument of node.arguments.slice(1)) {
            if (!isAstNode(argument)) {
              return [];
            }

            const values = evaluateStaticExpression(
              argument,
              environment,
              propertyDefaults,
              sourceOrigin,
              depth + 1,
            );

            if (values.length === 0) {
              return [];
            }

            boundArguments.push(values);
          }

          return functions.map((callback) => ({
            ...callback,
            boundArguments: [...callback.boundArguments, ...boundArguments],
          }));
        }

        if (method === 'flat') {
          return flattenArrayValues(
            evaluateStaticExpression(
              node.callee.object,
              environment,
              propertyDefaults,
              sourceOrigin,
              depth + 1,
            ),
          );
        }

        if (method === 'ensureAvatarUrl') {
          const argument = node.arguments[0];
          return isAstNode(argument)
            ? ensureAvatarUrl(
                evaluateStaticExpression(
                  argument,
                  environment,
                  propertyDefaults,
                  sourceOrigin,
                  depth + 1,
                ),
              )
            : [];
        }
      }

      return [];
    }
    case 'AssignmentExpression':
      return evaluateStaticExpression(
        node.right,
        environment,
        propertyDefaults,
        sourceOrigin,
        depth + 1,
      );
    case 'SequenceExpression': {
      const last = node.expressions.at(-1);
      return isAstNode(last)
        ? evaluateStaticExpression(last, environment, propertyDefaults, sourceOrigin, depth + 1)
        : [];
    }
    default:
      return [];
  }
}

function evaluateStaticExpressionWithJsonObjectDefaults(
  node: AnyNode,
  environment: StaticEnvironment,
  propertyDefaults: ReadonlyMap<string, StaticValues>,
  sourceOrigin: string,
): StaticValues {
  const objectDefaults = staticObjects(propertyDefaults.get(staticJsonObjectDefaultsKey) ?? []);

  if (objectDefaults.length === 0) {
    return evaluateStaticExpression(node, environment, propertyDefaults, sourceOrigin);
  }

  const requirements = new Map<string, Set<string>>();
  const visit = (candidate: AnyNode): void => {
    if (
      candidate.type === 'MemberExpression' &&
      candidate.object.type === 'Identifier' &&
      (environment.get(candidate.object.name)?.length ?? 0) === 0
    ) {
      const name = staticPropertyName(candidate.property);

      if (name) {
        const names = requirements.get(candidate.object.name) ?? new Set<string>();
        names.add(name);
        requirements.set(candidate.object.name, names);
      }
    }

    for (const value of Object.values(candidate)) {
      if (isAstNode(value)) {
        visit(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (isAstNode(item)) {
            visit(item);
          }
        }
      }
    }
  };

  visit(node);

  if (requirements.size === 0) {
    return evaluateStaticExpression(node, environment, propertyDefaults, sourceOrigin);
  }

  let environments: MutableStaticEnvironment[] = [new Map(environment)];
  let boundIdentifier = false;

  for (const [identifier, names] of requirements) {
    const candidates = objectDefaults.filter((value) =>
      [...names].every((name) => value.properties.has(name)),
    );

    if (candidates.length === 0) {
      continue;
    }

    boundIdentifier = true;
    const next: MutableStaticEnvironment[] = [];

    for (const candidateEnvironment of environments) {
      for (const candidate of candidates) {
        const scoped = new Map(candidateEnvironment);
        scoped.set(identifier, [candidate]);
        next.push(scoped);

        if (next.length >= maxStaticValues) {
          break;
        }
      }

      if (next.length >= maxStaticValues) {
        break;
      }
    }

    environments = next;
  }

  if (!boundIdentifier) {
    return evaluateStaticExpression(node, environment, propertyDefaults, sourceOrigin);
  }

  return environments
    .flatMap((candidateEnvironment) =>
      evaluateStaticExpression(node, candidateEnvironment, propertyDefaults, sourceOrigin),
    )
    .slice(0, maxStaticValues);
}

interface StaticForLoop {
  readonly counterName: string;
  readonly values: readonly number[];
}

interface AstVisitState {
  readonly activeCallbacks: Set<string>;
  callbackExpansions: number;
}

function staticForLoop(
  node: ForStatement,
  environment: StaticEnvironment,
  propertyDefaults: ReadonlyMap<string, StaticValues>,
  sourceOrigin: string,
): StaticForLoop | undefined {
  if (
    !node.init ||
    node.init.type !== 'VariableDeclaration' ||
    node.init.declarations.length !== 1 ||
    !node.test ||
    node.test.type !== 'BinaryExpression' ||
    !node.update ||
    node.update.type !== 'UpdateExpression'
  ) {
    return undefined;
  }

  const declaration = node.init.declarations[0];

  if (
    !declaration ||
    declaration.id.type !== 'Identifier' ||
    !declaration.init ||
    node.test.left.type !== 'Identifier' ||
    node.test.left.name !== declaration.id.name ||
    node.update.argument.type !== 'Identifier' ||
    node.update.argument.name !== declaration.id.name ||
    !['<', '<=', '>', '>='].includes(node.test.operator) ||
    !['++', '--'].includes(node.update.operator)
  ) {
    return undefined;
  }

  const starts = scalarNumbers(
    evaluateStaticExpression(declaration.init, environment, propertyDefaults, sourceOrigin),
  );
  const bounds = scalarNumbers(
    evaluateStaticExpression(node.test.right, environment, propertyDefaults, sourceOrigin),
  );
  const start = starts[0];
  const bound = bounds[0];
  const test = node.test;

  if (start === undefined || bound === undefined || starts.length !== 1 || bounds.length !== 1) {
    return undefined;
  }

  const step = node.update.operator === '++' ? 1 : -1;
  const matches = (value: number): boolean => {
    switch (test.operator) {
      case '<':
        return value < bound;
      case '<=':
        return value <= bound;
      case '>':
        return value > bound;
      case '>=':
        return value >= bound;
      default:
        return false;
    }
  };
  const values: number[] = [];
  let value = start;

  while (matches(value)) {
    values.push(value);

    if (values.length > maxArrayItems) {
      return undefined;
    }

    value += step;

    if (!Number.isSafeInteger(value)) {
      return undefined;
    }
  }

  return {
    counterName: declaration.id.name,
    values,
  };
}

function visitAst(
  node: AnyNode,
  environment: MutableStaticEnvironment,
  propertyDefaults: ReadonlyMap<string, StaticValues>,
  sourceOrigin: string,
  visitor: (node: AnyNode, environment: StaticEnvironment) => void,
  state: AstVisitState = {
    activeCallbacks: new Set<string>(),
    callbackExpansions: 0,
  },
): void {
  visitor(node, environment);

  if (node.type === 'Program' || node.type === 'BlockStatement') {
    const scope = new Map(environment);

    for (const statement of node.body) {
      visitAst(statement, scope, propertyDefaults, sourceOrigin, visitor, state);
    }

    return;
  }

  if (node.type === 'VariableDeclaration') {
    for (const declaration of node.declarations) {
      visitor(declaration, environment);

      if (declaration.init) {
        visitAst(declaration.init, environment, propertyDefaults, sourceOrigin, visitor, state);
      }

      if (declaration.id.type === 'Identifier' && declaration.init) {
        environment.set(
          declaration.id.name,
          evaluateStaticExpression(declaration.init, environment, propertyDefaults, sourceOrigin),
        );
      }
    }

    return;
  }

  if (node.type === 'CallExpression') {
    const arrayFrom = isArrayFromCall(node);
    const callback = node.arguments[arrayFrom ? 1 : 0];
    const method =
      node.callee.type === 'MemberExpression'
        ? staticPropertyName(node.callee.property)
        : undefined;
    const iterable =
      (arrayFrom || (method && ['flatMap', 'forEach', 'map'].includes(method))) &&
      isAstNode(callback)
        ? staticIterableCallback(callback, environment, propertyDefaults, sourceOrigin)
        : undefined;

    if (
      iterable &&
      (iterable.node.type === 'ArrowFunctionExpression' ||
        iterable.node.type === 'FunctionExpression') &&
      node.callee.type === 'MemberExpression'
    ) {
      const callbackKey = rangeKey(iterable.node);

      if (
        state.activeCallbacks.has(callbackKey) ||
        state.callbackExpansions >= maxCallbackExpansions
      ) {
        return;
      }

      state.activeCallbacks.add(callbackKey);
      state.callbackExpansions += 1;

      try {
        if (!arrayFrom) {
          visitAst(node.callee.object, environment, propertyDefaults, sourceOrigin, visitor, state);
        }

        const nonCallbackArguments = arrayFrom
          ? [node.arguments[0], ...node.arguments.slice(2)]
          : node.arguments.slice(1);

        for (const argument of nonCallbackArguments) {
          if (isAstNode(argument)) {
            visitAst(argument, environment, propertyDefaults, sourceOrigin, visitor, state);
          }
        }

        const input = node.arguments[0];
        const values = arrayFrom
          ? isAstNode(input)
            ? staticArrays(
                arrayInputValues(input, environment, propertyDefaults, sourceOrigin, 0),
              ).flatMap((array) => array.values)
            : []
          : staticArrays(
              evaluateStaticExpression(
                node.callee.object,
                environment,
                propertyDefaults,
                sourceOrigin,
              ),
            ).flatMap((array) => array.values);
        const callbackValues = values.slice(0, maxArrayItems);
        const createCallbackScope = (): MutableStaticEnvironment => {
          const scope = new Map(iterable.environment);

          for (const [index, values] of iterable.boundArguments.entries()) {
            const parameter = iterable.node.params[index];

            if (parameter?.type === 'Identifier') {
              scope.set(parameter.name, values);
            }
          }

          return scope;
        };

        if (callbackValues.length === 0) {
          visitAst(
            iterable.node.body,
            createCallbackScope(),
            propertyDefaults,
            sourceOrigin,
            visitor,
            state,
          );
          return;
        }

        for (const [index, value] of callbackValues.entries()) {
          const scope = createCallbackScope();
          const parameterOffset = iterable.boundArguments.length;
          const valueParameter = iterable.node.params[parameterOffset];
          const indexParameter = iterable.node.params[parameterOffset + 1];

          const bindsValueParameter = !arrayFrom || input?.type !== 'ObjectExpression';

          if (bindsValueParameter && valueParameter?.type === 'Identifier') {
            scope.set(valueParameter.name, [value]);
          }

          if (indexParameter?.type === 'Identifier') {
            scope.set(indexParameter.name, [index]);
          }

          visitAst(iterable.node.body, scope, propertyDefaults, sourceOrigin, visitor, state);
        }

        return;
      } finally {
        state.activeCallbacks.delete(callbackKey);
      }
    }
  }

  if (node.type === 'ForStatement') {
    const loop = staticForLoop(node, environment, propertyDefaults, sourceOrigin);

    if (loop) {
      for (const value of loop.values) {
        const scope = new Map(environment);
        scope.set(loop.counterName, [value]);
        visitAst(node.body, scope, propertyDefaults, sourceOrigin, visitor, state);
      }

      return;
    }
  }

  if (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression'
  ) {
    visitAst(node.body, new Map(environment), propertyDefaults, sourceOrigin, visitor, state);
    return;
  }

  for (const value of Object.values(node)) {
    if (isAstNode(value)) {
      visitAst(value, environment, propertyDefaults, sourceOrigin, visitor, state);
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) {
          visitAst(item, environment, propertyDefaults, sourceOrigin, visitor, state);
        }
      }
    }
  }
}

function appendPropertyDefault(
  propertyDefaults: Map<string, StaticValues>,
  name: string,
  value: AnyNode,
  sourceOrigin: string,
): void {
  const existing = propertyDefaults.get(name) ?? [];
  const values = evaluateStaticExpression(value, new Map(), propertyDefaults, sourceOrigin);
  const acceptsStructuredValue =
    /asset|audio|file|font|image|media|model|movie|sound|texture|uri|url|video/iu.test(name);
  const accepted = values.filter(
    (candidate) =>
      typeof candidate === 'string' ||
      (typeof candidate === 'number' && Number.isSafeInteger(candidate)) ||
      (acceptsStructuredValue && (isStaticArray(candidate) || isStaticObject(candidate))),
  );

  if (accepted.length > 0) {
    propertyDefaults.set(name, [...existing, ...accepted].slice(0, maxStaticValues));
  }
}

function collectPropertyDefaults(
  program: Program,
  sourceOrigin: string,
): Map<string, StaticValues> {
  const propertyDefaults = new Map<string, StaticValues>();

  visitAst(program, new Map(), propertyDefaults, sourceOrigin, (node) => {
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      !node.callee.computed &&
      node.callee.object.type === 'Identifier' &&
      node.callee.object.name === 'JSON' &&
      staticPropertyName(node.callee.property) === 'parse'
    ) {
      for (const value of evaluateStaticExpression(
        node,
        new Map(),
        propertyDefaults,
        sourceOrigin,
      )) {
        if (!isStaticObject(value)) {
          continue;
        }

        const existing = propertyDefaults.get(staticJsonObjectDefaultsKey) ?? [];
        propertyDefaults.set(
          staticJsonObjectDefaultsKey,
          [value, ...existing].slice(0, maxStaticValues),
        );
      }
    }

    if (node.type === 'Property' && node.kind === 'init' && !node.computed && !node.method) {
      const name = staticPropertyName(node.key);

      if (name) {
        appendPropertyDefault(propertyDefaults, name, node.value, sourceOrigin);
      }

      return;
    }

    if (
      node.type !== 'AssignmentExpression' ||
      node.left.type !== 'MemberExpression' ||
      node.left.computed
    ) {
      return;
    }

    const name = staticPropertyName(node.left.property);

    if (name) {
      appendPropertyDefault(propertyDefaults, name, node.right, sourceOrigin);
    }
  });

  return propertyDefaults;
}

function staticStringValue(node: AnyNode): string | undefined {
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }

  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
  }

  return undefined;
}

function directStructuredAssetValues(node: AnyNode): string[] {
  const direct = staticStringValue(node);

  if (direct !== undefined) {
    return [direct];
  }

  if (node.type !== 'ArrayExpression') {
    return [];
  }

  const values: string[] = [];

  for (const element of node.elements) {
    if (!isAstNode(element)) {
      continue;
    }

    const scalar = staticStringValue(element);

    if (scalar !== undefined) {
      values.push(scalar);
    } else if (element.type === 'ObjectExpression') {
      for (const property of element.properties) {
        if (
          property.type !== 'Property' ||
          property.kind !== 'init' ||
          property.computed ||
          property.method
        ) {
          continue;
        }

        const name = staticPropertyName(property.key)?.toLowerCase();
        const value = staticStringValue(property.value);

        if (name && structuredObjectAssetPropertyNames.has(name) && value !== undefined) {
          values.push(value);
        }

        if (values.length >= maxArrayItems) {
          break;
        }
      }
    }

    if (values.length >= maxArrayItems) {
      break;
    }
  }

  return uniqueStrings(values);
}

function staticNumberValue(node: AnyNode | undefined): number | undefined {
  if (
    !node ||
    node.type !== 'Literal' ||
    typeof node.value !== 'number' ||
    !Number.isSafeInteger(node.value)
  ) {
    return undefined;
  }

  return node.value;
}

function staticOptionalStringValue(node: AnyNode | undefined): string | undefined {
  return node ? staticStringValue(node) : undefined;
}

function objectPropertyValue(node: AnyNode, name: string): AnyNode | undefined {
  if (node.type !== 'ObjectExpression') {
    return undefined;
  }

  const property = node.properties.find(
    (candidate) =>
      candidate.type === 'Property' &&
      candidate.kind === 'init' &&
      !candidate.computed &&
      !candidate.method &&
      staticPropertyName(candidate.key)?.toLowerCase() === name.toLowerCase(),
  );

  return property?.type === 'Property' ? property.value : undefined;
}

function normalizedDeploymentPath(value: string): string | undefined {
  const trimmed = value.trim().replaceAll('\\', '/');

  if (!trimmed || [...trimmed].some((character) => character.codePointAt(0)! < 32)) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed, 'https://webmirror.invalid/');
    const pathname = parsed.pathname.replace(/^\/+/u, '');
    return pathname || undefined;
  } catch {
    return undefined;
  }
}

function staticAssetInventoryRecord(node: AnyNode): StaticAssetInventoryRecord | undefined {
  if (node.type !== 'ObjectExpression') {
    return undefined;
  }

  const filename = staticOptionalStringValue(objectPropertyValue(node, 'filename'));
  const bytes = staticNumberValue(objectPropertyValue(node, 'bytes'));

  if (filename === undefined || bytes === undefined || bytes < 0) {
    return undefined;
  }

  const normalizedInput = filename.trim().replaceAll('\\', '/');

  if (
    !normalizedInput ||
    normalizedInput.startsWith('/') ||
    normalizedInput.startsWith('//') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(normalizedInput) ||
    normalizedInput.includes('?') ||
    normalizedInput.includes('#') ||
    normalizedInput.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    return undefined;
  }

  const normalizedFilename = normalizedDeploymentPath(normalizedInput);

  return normalizedFilename ? { filename: normalizedInput, normalizedFilename } : undefined;
}

function observedInventoryBase(
  record: StaticAssetInventoryRecord,
  observedResourceUrl: string,
): string | undefined {
  let observed: URL;

  try {
    observed = new URL(observedResourceUrl);
  } catch {
    return undefined;
  }

  if (
    (observed.protocol !== 'http:' && observed.protocol !== 'https:') ||
    observed.username ||
    observed.password
  ) {
    return undefined;
  }

  const observedPath = observed.pathname.replace(/^\/+/, '');

  if (
    observedPath !== record.normalizedFilename &&
    !observedPath.endsWith(`/${record.normalizedFilename}`)
  ) {
    return undefined;
  }

  const prefix = observedPath.slice(0, observedPath.length - record.normalizedFilename.length);
  observed.pathname = `/${prefix}`;
  observed.search = '';
  observed.hash = '';
  return observed.toString();
}

function collectObservedAssetInventoryReferences(
  program: Program,
  sourceOrigin: string,
  observedResourceUrls: readonly string[],
): string[] {
  if (observedResourceUrls.length === 0) {
    return [];
  }

  const references = new Set<string>();

  visitAst(program, new Map(), new Map(), sourceOrigin, (node) => {
    if (
      node.type !== 'ArrayExpression' ||
      node.elements.length < minimumObservedInventoryMatches ||
      node.elements.length > maxAssetCandidates
    ) {
      return;
    }

    const records: StaticAssetInventoryRecord[] = [];

    for (const element of node.elements) {
      if (!isAstNode(element)) {
        return;
      }

      const record = staticAssetInventoryRecord(element);

      if (!record) {
        return;
      }

      records.push(record);
    }

    const supportByBase = new Map<string, Set<string>>();

    for (const record of records) {
      for (const observedResourceUrl of observedResourceUrls) {
        const base = observedInventoryBase(record, observedResourceUrl);

        if (!base) {
          continue;
        }

        const support = supportByBase.get(base) ?? new Set<string>();
        support.add(record.normalizedFilename);
        supportByBase.set(base, support);
      }
    }

    const rankedBases = [...supportByBase.entries()].sort((left, right) => {
      const supportOrder = right[1].size - left[1].size;
      return supportOrder === 0 ? left[0].localeCompare(right[0]) : supportOrder;
    });
    const strongest = rankedBases[0];
    const runnerUp = rankedBases[1];

    if (
      !strongest ||
      strongest[1].size < minimumObservedInventoryMatches ||
      (runnerUp && runnerUp[1].size === strongest[1].size)
    ) {
      return;
    }

    for (const record of records) {
      if (!hasLikelyStaticAssetShapeWithUnencodedSpaces(record.filename)) {
        continue;
      }

      try {
        const resolved = new URL(record.filename, strongest[0]);

        if (
          (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') ||
          resolved.username ||
          resolved.password ||
          [...resolved.searchParams.keys()].some(isSensitiveQueryName)
        ) {
          continue;
        }

        resolved.hash = '';
        references.add(resolved.toString());
      } catch {
        // Invalid inventory entries do not enter the dependency graph.
      }
    }
  });

  return [...references].sort();
}

function pathVariants(pathname: string): ReadonlySet<string> {
  const normalized = pathname.replace(/^\/+/u, '');
  const variants = new Set<string>([normalized]);

  try {
    variants.add(decodeURIComponent(normalized));
  } catch {
    // Keep the encoded spelling when it is not valid URI syntax.
  }

  return variants;
}

function canonicalAbsoluteHttpUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);

    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      [...parsed.searchParams.keys()].some(isSensitiveQueryName)
    ) {
      return undefined;
    }

    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function collectAbsoluteUrlLiterals(program: Program, sourceOrigin: string): ReadonlySet<string> {
  const urls = new Set<string>();

  visitAst(program, new Map(), new Map(), sourceOrigin, (node) => {
    if (node.type !== 'Literal' || typeof node.value !== 'string') {
      return;
    }

    const url = canonicalAbsoluteHttpUrl(node.value);

    if (url) {
      urls.add(url);
    }
  });

  return urls;
}

function collectStructuredAssetExclusions(
  program: Program,
  sourceOrigin: string,
  observedResourceUrls: readonly string[],
): StructuredAssetExclusions {
  const suppressedSourceValueRanges = new Set<string>();
  const suppressedSourcePaths = new Set<string>();
  const deploymentReferences = new Set<string>();
  const deploymentCandidates = new Set<string>(collectAbsoluteUrlLiterals(program, sourceOrigin));

  for (const observedResourceUrl of observedResourceUrls) {
    const canonical = canonicalAbsoluteHttpUrl(observedResourceUrl);

    if (canonical) {
      deploymentCandidates.add(canonical);
    }
  }

  const candidatePaths = [...deploymentCandidates].flatMap((candidate) => {
    try {
      const parsed = new URL(candidate);
      return [{ candidate, paths: pathVariants(parsed.pathname) }];
    } catch {
      return [];
    }
  });

  visitAst(program, new Map(), new Map(), sourceOrigin, (node) => {
    if (node.type !== 'ObjectExpression') {
      return;
    }

    const sourceNode = objectPropertyValue(node, 'source');
    const destinationNode = objectPropertyValue(node, 'destination');
    const directoryId = staticOptionalStringValue(objectPropertyValue(node, 'directoryID'));
    const position = staticNumberValue(objectPropertyValue(node, 'position'));
    const length = staticNumberValue(objectPropertyValue(node, 'length'));
    const source = staticOptionalStringValue(sourceNode);
    const destination = staticOptionalStringValue(destinationNode);

    if (!sourceNode || source === undefined) {
      return;
    }

    const isPackMember =
      directoryId?.toLowerCase().endsWith('.pack') === true &&
      position !== undefined &&
      position >= 0 &&
      length !== undefined &&
      length > 0;
    const isDeploymentRecord = destination !== undefined;

    if (!isPackMember && !isDeploymentRecord) {
      return;
    }

    // These source paths describe a build input or a virtual member inside a
    // container. They are not independently fetchable URLs and must remain
    // available to the original runtime manifest/unpacker.
    suppressedSourceValueRanges.add(rangeKey(sourceNode));
    const sourcePath = normalizedDeploymentPath(source);

    if (sourcePath) {
      suppressedSourcePaths.add(sourcePath);
    }

    if (!isDeploymentRecord || destination === undefined) {
      return;
    }

    const destinationPath = normalizedDeploymentPath(destination);

    if (!destinationPath) {
      return;
    }

    const matches = new Set(
      candidatePaths
        .filter(({ paths }) =>
          [...paths].some(
            (candidatePath) =>
              candidatePath === destinationPath || candidatePath.endsWith(`/${destinationPath}`),
          ),
        )
        .map(({ candidate }) => candidate),
    );

    if (matches.size === 1) {
      deploymentReferences.add([...matches][0]!);
    }
  });

  return {
    suppressedSourceValueRanges,
    suppressedSourcePaths,
    deploymentReferences: [...deploymentReferences].sort(),
  };
}

function isSuppressedStructuredSourceUrl(
  value: string,
  suppressedSourcePaths: ReadonlySet<string>,
): boolean {
  let pathname: string;

  try {
    pathname = new URL(value).pathname.replace(/^\/+/u, '');
  } catch {
    return false;
  }

  return [...suppressedSourcePaths].some(
    (sourcePath) => pathname === sourcePath || pathname.endsWith(`/${sourcePath}`),
  );
}

function collectStructuredAssetReferences(
  program: Program,
  propertyDefaults: ReadonlyMap<string, StaticValues>,
  sourceOrigin: string,
  exclusions: StructuredAssetExclusions,
): StructuredAssetReferences {
  const direct = new Set<string>(exclusions.deploymentReferences);
  const templates = new Map<string, AssetTemplate>();

  visitAst(program, new Map(), propertyDefaults, sourceOrigin, (node) => {
    if (node.type !== 'Property' || node.kind !== 'init' || node.computed || node.method) {
      return;
    }

    const name = staticPropertyName(node.key)?.toLowerCase();

    if (!name || !structuredAssetPropertyNames.has(name)) {
      return;
    }

    if (name === 'source' && exclusions.suppressedSourceValueRanges.has(rangeKey(node.value))) {
      return;
    }

    for (const value of directStructuredAssetValues(node.value)) {
      if (!looksLikeStructuredAssetValue(value)) {
        continue;
      }

      const template = parseAssetTemplate(value);

      if (template && looksLikeAssetTemplate(template)) {
        templates.set(template.source, template);
      } else if (hasLikelyStaticAssetShapeWithUnencodedSpaces(value)) {
        direct.add(value);
      }
    }
  });

  return {
    direct: [...direct].sort(),
    templates: [...templates.values()].sort((left, right) =>
      left.source.localeCompare(right.source),
    ),
  };
}

function isElementNode(
  node: DefaultTreeAdapterTypes.Node,
): node is DefaultTreeAdapterTypes.Element {
  return 'tagName' in node;
}

function pathContainsToken(reference: string, token: string): boolean {
  let index = reference.indexOf(token);

  while (index >= 0) {
    const before = reference[index - 1];
    const after = reference[index + token.length];
    const beforeBoundary = before === undefined || !/[A-Za-z0-9]/u.test(before);
    const afterBoundary = after === undefined || !/[A-Za-z0-9]/u.test(after);

    if (beforeBoundary && afterBoundary) {
      return true;
    }

    index = reference.indexOf(token, index + 1);
  }

  return false;
}

type RuntimePlaceholderKind = 'audio' | 'font' | 'language' | 'resolution' | 'video';

function normalizeRuntimeName(name: string): string {
  return name.toLowerCase().replaceAll('_', '').replaceAll('-', '');
}

function runtimePlaceholderKind(name: string): RuntimePlaceholderKind | undefined {
  const normalized = normalizeRuntimeName(name);

  if (normalized.includes('resolution')) {
    return 'resolution';
  }

  if (normalized.includes('audio') || normalized.includes('sound')) {
    return 'audio';
  }

  if (normalized.includes('video') || normalized.includes('movie')) {
    return 'video';
  }

  if (normalized.includes('font')) {
    return 'font';
  }

  return normalized === 'lang' || normalized.includes('language') ? 'language' : undefined;
}

function runtimePropertyKind(name: string): RuntimePlaceholderKind | undefined {
  switch (normalizeRuntimeName(name)) {
    case 'assetresolution':
    case 'resolution':
    case 'resolutions':
      return 'resolution';
    case 'audioformat':
    case 'soundformat':
      return 'audio';
    case 'videoformat':
    case 'movieformat':
      return 'video';
    case 'fontformat':
      return 'font';
    case 'lang':
    case 'language':
      return 'language';
    default:
      return undefined;
  }
}

function runtimeValueAllowed(kind: RuntimePlaceholderKind, value: string): boolean {
  const normalized = value.toLowerCase();

  switch (kind) {
    case 'audio':
      return audioExtensions.has(`.${normalized}`);
    case 'font':
      return contextualFontExtensions.has(`.${normalized}`);
    case 'video':
      return videoExtensions.has(`.${normalized}`);
    case 'resolution':
    case 'language':
      return isTemplateToken(value);
  }
}

function observedRuntimeValues(
  kind: RuntimePlaceholderKind,
  candidates: readonly string[],
  observedUrls: readonly string[],
): Set<string> {
  const observed = new Set<string>();

  for (const observedUrl of observedUrls) {
    let pathname: string;

    try {
      pathname = new URL(observedUrl).pathname;
    } catch {
      continue;
    }

    if (kind === 'resolution') {
      const segments = pathname.split('/');

      for (const candidate of candidates) {
        if (segments.includes(candidate)) {
          observed.add(candidate);
        }
      }

      continue;
    }

    if (kind === 'language') {
      const normalizedPath = pathname.toLowerCase();

      for (const candidate of candidates) {
        if (pathContainsToken(normalizedPath, candidate.toLowerCase())) {
          observed.add(candidate);
        }
      }

      continue;
    }

    const extension = posix.extname(pathname).slice(1).toLowerCase();

    for (const candidate of candidates) {
      if (candidate.toLowerCase() === extension) {
        observed.add(candidate);
      }
    }
  }

  return observed;
}

function collectRuntimePlaceholderDefaults(
  propertyDefaults: ReadonlyMap<string, StaticValues>,
  observedUrls: readonly string[],
): ReadonlyMap<RuntimePlaceholderKind, ReadonlySet<string>> {
  const collected = new Map<RuntimePlaceholderKind, Set<string>>();

  for (const [name, values] of propertyDefaults) {
    const kind = runtimePropertyKind(name);

    if (!kind) {
      continue;
    }

    const candidates = collected.get(kind) ?? new Set<string>();

    for (const value of scalarStrings(values)) {
      if (runtimeValueAllowed(kind, value)) {
        candidates.add(value);
      }
    }

    if (candidates.size > 0) {
      collected.set(kind, candidates);
    }
  }

  const defaults = new Map<RuntimePlaceholderKind, ReadonlySet<string>>();

  for (const [kind, values] of collected) {
    const candidates = [...values];
    const observed = observedRuntimeValues(kind, candidates, observedUrls);

    if (observed.size > 0) {
      defaults.set(kind, observed);
    } else if (values.size === 1) {
      defaults.set(kind, values);
    }
  }

  return defaults;
}

function narrowObservedPropertyDefaults(
  propertyDefaults: ReadonlyMap<string, StaticValues>,
  templateInferences: ReadonlyMap<string, AssetTemplateInference>,
  observedUrls: readonly string[],
): Map<string, StaticValues> {
  const narrowed = new Map(propertyDefaults);
  const observedResolutions = new Set<string>();

  for (const inference of templateInferences.values()) {
    for (const [name, values] of inference.values) {
      const normalized = name.toLowerCase().replaceAll('_', '');

      if (normalized !== 'resolution' && normalized !== 'resolutions') {
        continue;
      }

      for (const value of values) {
        observedResolutions.add(value);
      }
    }
  }

  for (const observedUrl of observedUrls) {
    let pathname: string;

    try {
      pathname = new URL(observedUrl).pathname;
    } catch {
      continue;
    }

    for (const candidate of ['desktop', 'tablet', 'mobile']) {
      if (pathname.split('/').includes(candidate)) {
        observedResolutions.add(candidate);
      }
    }
  }

  for (const [name, values] of propertyDefaults) {
    const kind = runtimePropertyKind(name);

    if (!kind) {
      continue;
    }

    const candidates = scalarStrings(values).filter(isTemplateToken);
    const observed =
      kind === 'resolution'
        ? new Set(candidates.filter((candidate) => observedResolutions.has(candidate)))
        : observedRuntimeValues(kind, candidates, observedUrls);

    if (observed.size === 1) {
      narrowed.set(name, [...observed]);
    }
  }

  return narrowed;
}

function isEvidenceBackedTemplateValue(value: string, assetReferences: readonly string[]): boolean {
  return (
    isTemplateToken(value) &&
    assetReferences.some((reference) => pathContainsToken(reference, value))
  );
}

interface FiniteTemplateDomain {
  readonly name: string;
  readonly priority: number;
  readonly candidates: readonly string[];
}

function appendFiniteTemplateDomain(
  domains: FiniteTemplateDomain[],
  name: string,
  priority: number,
  candidates: readonly string[],
): void {
  const unique = [...new Set(candidates)].sort();

  if (unique.length < 2 || unique.length > maxArrayItems) {
    return;
  }

  domains.push({ name, priority, candidates: unique });
}

function collectFiniteTemplateDomains(
  program: Program,
  structuredAssets: StructuredAssetReferences,
  propertyDefaults: ReadonlyMap<string, StaticValues>,
  sourceOrigin: string,
): readonly FiniteTemplateDomain[] {
  const domains: FiniteTemplateDomain[] = [];
  const assetReferences = [
    ...structuredAssets.direct,
    ...structuredAssets.templates.map((template) => template.source),
  ];

  visitAst(program, new Map(), propertyDefaults, sourceOrigin, (node) => {
    if (node.type === 'ObjectExpression') {
      const entries = node.properties.flatMap((property) => {
        if (
          property.type !== 'Property' ||
          property.kind !== 'init' ||
          property.computed ||
          property.method
        ) {
          return [];
        }

        const name = staticPropertyName(property.key);
        return name ? [{ name, value: property.value }] : [];
      });
      const registryLike =
        entries.length >= 2 &&
        entries.length <= maxArrayItems &&
        entries.every(
          (entry) =>
            entry.value.type === 'CallExpression' ||
            entry.value.type === 'Identifier' ||
            entry.value.type === 'NewExpression',
        );

      if (registryLike) {
        const candidates = entries
          .map((entry) => entry.name)
          .filter((candidate) => isEvidenceBackedTemplateValue(candidate, assetReferences));
        appendFiniteTemplateDomain(domains, 'key', 2, candidates);
      }
    }

    if (
      node.type !== 'ArrayExpression' ||
      node.elements.length < 2 ||
      node.elements.length > maxArrayItems
    ) {
      return;
    }

    const stringItems = node.elements.flatMap((item) => {
      const value = item && isAstNode(item) ? staticStringValue(item) : undefined;
      return value ? [value] : [];
    });

    if (stringItems.length === node.elements.length) {
      const candidates = stringItems.filter((candidate) =>
        isEvidenceBackedTemplateValue(candidate, assetReferences),
      );
      appendFiniteTemplateDomain(domains, 'key', 1, candidates);
      return;
    }

    const objectItems = node.elements.filter(
      (item): item is AnyNode & { type: 'ObjectExpression' } =>
        Boolean(item && isAstNode(item) && item.type === 'ObjectExpression'),
    );

    if (objectItems.length !== node.elements.length) {
      return;
    }

    for (const identityName of finiteIdentityPropertyNames) {
      const candidates = objectItems.flatMap((item) => {
        const property = item.properties.find(
          (candidate) =>
            candidate.type === 'Property' &&
            candidate.kind === 'init' &&
            !candidate.computed &&
            !candidate.method &&
            staticPropertyName(candidate.key) === identityName,
        );

        if (!property || property.type !== 'Property') {
          return [];
        }

        const value = staticStringValue(property.value);
        return value && isEvidenceBackedTemplateValue(value, assetReferences) ? [value] : [];
      });

      if (candidates.length === objectItems.length) {
        appendFiniteTemplateDomain(domains, identityName, 3, candidates);
      }
    }
  });

  return domains.sort((left, right) => {
    const priorityOrder = right.priority - left.priority;

    if (priorityOrder !== 0) {
      return priorityOrder;
    }

    const sizeOrder = right.candidates.length - left.candidates.length;

    if (sizeOrder !== 0) {
      return sizeOrder;
    }

    return left.candidates.join('\0').localeCompare(right.candidates.join('\0'));
  });
}

function templateScalarValue(
  node: AnyNode | undefined,
  bindings: ReadonlyMap<string, string>,
  depth = 0,
): StaticScalar | undefined {
  if (!node || depth > maxExpressionDepth) {
    return undefined;
  }

  if (node.type === 'Literal') {
    return typeof node.value === 'string' ||
      typeof node.value === 'number' ||
      typeof node.value === 'boolean'
      ? node.value
      : undefined;
  }

  if (node.type === 'Identifier') {
    return bindings.get(node.name);
  }

  if (node.type === 'UnaryExpression' && node.operator === '!') {
    const value = templateScalarValue(node.argument, bindings, depth + 1);
    return value === undefined ? undefined : !value;
  }

  if (node.type === 'BinaryExpression' && ['==', '===', '!=', '!=='].includes(node.operator)) {
    const left = templateScalarValue(node.left, bindings, depth + 1);
    const right = templateScalarValue(node.right, bindings, depth + 1);

    if (left === undefined || right === undefined) {
      return undefined;
    }

    return node.operator === '!=' || node.operator === '!==' ? left !== right : left === right;
  }

  if (node.type === 'LogicalExpression') {
    const left = templateScalarValue(node.left, bindings, depth + 1);

    if (left === undefined) {
      return undefined;
    }

    if (node.operator === '&&') {
      return left ? templateScalarValue(node.right, bindings, depth + 1) : left;
    }

    if (node.operator === '||') {
      return left ? left : templateScalarValue(node.right, bindings, depth + 1);
    }

    return undefined;
  }

  if (node.type === 'ConditionalExpression') {
    const test = templateScalarValue(node.test, bindings, depth + 1);

    if (typeof test !== 'boolean') {
      return undefined;
    }

    return templateScalarValue(test ? node.consequent : node.alternate, bindings, depth + 1);
  }

  return undefined;
}

function evaluateEmbeddedTemplateExpression(
  expression: string,
  bindings: ReadonlyMap<string, string>,
): string | undefined {
  try {
    const node = parseExpressionAt(expression, 0, { ecmaVersion: 'latest' });

    if (expression.slice(node.end).trim()) {
      return undefined;
    }

    const value = templateScalarValue(node, bindings);
    return value === undefined ? undefined : String(value);
  } catch {
    return undefined;
  }
}

function renderEmbeddedHtmlTemplate(
  template: string,
  bindings: ReadonlyMap<string, string>,
): string | undefined {
  let cursor = 0;
  let output = '';

  while (cursor < template.length) {
    const opening = template.indexOf('<%', cursor);

    if (opening < 0) {
      output += template.slice(cursor);
      break;
    }

    output += template.slice(cursor, opening);
    const closing = template.indexOf('%>', opening + 2);

    if (closing < 0) {
      return undefined;
    }

    if (template[opening + 2] === '=') {
      const expression = template.slice(opening + 3, closing).trim();
      output +=
        evaluateEmbeddedTemplateExpression(expression, bindings) ?? dynamicHtmlTemplateMarker;
    }

    cursor = closing + 2;
  }

  return output;
}

function embeddedHtmlBindings(
  candidates: readonly string[],
): readonly ReadonlyMap<string, string>[] {
  if (candidates.length === 0) {
    return [new Map()];
  }

  return [...new Set(candidates)]
    .sort()
    .slice(0, maxEmbeddedHtmlExpansions)
    .map(
      (candidate) =>
        new Map([
          ['id', candidate],
          ['key', candidate],
          ['name', candidate],
          ['slug', candidate],
        ]),
    );
}

function embeddedHtmlAttributeReferences(markup: string): string[] {
  const references = new Set<string>();
  const fragment = parseFragment(markup);

  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if (isElementNode(node)) {
      for (const currentAttribute of node.attrs) {
        const isResourceAttribute = embeddedHtmlResourceAttributeNames.has(currentAttribute.name);
        const isResourceHref =
          currentAttribute.name === 'href' &&
          embeddedHtmlResourceHrefElementNames.has(node.tagName);

        if (
          (isResourceAttribute || isResourceHref) &&
          !currentAttribute.value.includes(dynamicHtmlTemplateMarker) &&
          hasLikelyStaticAssetShape(currentAttribute.value)
        ) {
          references.add(currentAttribute.value);
        }
      }
    }

    if ('childNodes' in node) {
      for (const child of node.childNodes) {
        visit(child);
      }
    }
  };

  visit(fragment);
  return [...references].sort();
}

function referencePathSegments(reference: string): string[] {
  try {
    return new URL(reference, 'https://webmirror.invalid/').pathname.split('/').filter(Boolean);
  } catch {
    return [];
  }
}

function commonPathPrefixLength(left: readonly string[], right: readonly string[]): number {
  const maximum = Math.min(left.length, right.length);
  let length = 0;

  while (length < maximum && left[length] === right[length]) {
    length += 1;
  }

  return length;
}

function finiteTemplateDomainEvidence(
  template: string,
  domain: FiniteTemplateDomain,
  assetReferences: readonly string[],
  observedUrls: ReadonlySet<string>,
  baseUrl: string,
): number {
  let total = 0;

  for (const candidate of domain.candidates) {
    const binding = embeddedHtmlBindings([candidate])[0] ?? new Map<string, string>();
    const rendered = renderEmbeddedHtmlTemplate(template, binding);

    if (!rendered) {
      continue;
    }

    let candidateEvidence = 0;

    for (const reference of embeddedHtmlAttributeReferences(rendered)) {
      try {
        const resolved = new URL(reference, baseUrl);
        resolved.hash = '';

        if (observedUrls.has(resolved.toString())) {
          candidateEvidence = Math.max(candidateEvidence, 100);
        }
      } catch {
        // Path-context evidence below can still rank relative references.
      }

      const renderedPath = referencePathSegments(reference);

      for (const assetReference of assetReferences) {
        if (!pathContainsToken(assetReference, candidate)) {
          continue;
        }

        const prefix = commonPathPrefixLength(renderedPath, referencePathSegments(assetReference));
        if (prefix > 0) {
          candidateEvidence = Math.max(candidateEvidence, prefix);
        }
      }
    }

    total += candidateEvidence;
  }

  return Math.floor((total * 1_000) / domain.candidates.length);
}

function selectFiniteTemplateDomain(
  template: string,
  domains: readonly FiniteTemplateDomain[],
  assetReferences: readonly string[],
  observedUrls: ReadonlySet<string>,
  baseUrl: string,
): FiniteTemplateDomain | undefined {
  const ranked = domains
    .map((domain) => ({
      domain,
      evidence: finiteTemplateDomainEvidence(
        template,
        domain,
        assetReferences,
        observedUrls,
        baseUrl,
      ),
    }))
    .sort((left, right) => {
      const evidenceOrder = right.evidence - left.evidence;

      if (evidenceOrder !== 0) {
        return evidenceOrder;
      }

      const priorityOrder = right.domain.priority - left.domain.priority;

      if (priorityOrder !== 0) {
        return priorityOrder;
      }

      const sizeOrder = right.domain.candidates.length - left.domain.candidates.length;
      return sizeOrder === 0
        ? left.domain.candidates.join('\0').localeCompare(right.domain.candidates.join('\0'))
        : sizeOrder;
    });

  return (ranked[0]?.evidence ?? 0) > 0 ? ranked[0]?.domain : undefined;
}

function discoverEmbeddedHtmlAssets(
  program: Program,
  propertyDefaults: ReadonlyMap<string, StaticValues>,
  sourceOrigin: string,
  baseUrl: string,
  domains: readonly FiniteTemplateDomain[],
  assetReferences: readonly string[],
  observedResourceUrls: readonly string[],
  dependencies: Set<string>,
): void {
  const observedUrls = new Set(
    observedResourceUrls.flatMap((value) => {
      try {
        const url = new URL(value);
        url.hash = '';
        return [url.toString()];
      } catch {
        return [];
      }
    }),
  );
  const seenTemplates = new Set<string>();

  visitAst(program, new Map(), propertyDefaults, sourceOrigin, (node) => {
    const template = staticStringValue(node);

    if (
      !template ||
      seenTemplates.has(template) ||
      template.length > maxEmbeddedHtmlBytes ||
      !template.includes('<') ||
      !template.includes('>') ||
      (!template.includes('src=') &&
        !template.includes('poster=') &&
        !template.includes('data=') &&
        !template.includes('href='))
    ) {
      return;
    }

    seenTemplates.add(template);
    const domain = selectFiniteTemplateDomain(
      template,
      domains,
      assetReferences,
      observedUrls,
      baseUrl,
    );
    const bindings = embeddedHtmlBindings(domain?.candidates ?? []);

    for (const binding of bindings) {
      const rendered = renderEmbeddedHtmlTemplate(template, binding);

      if (!rendered) {
        continue;
      }

      for (const reference of embeddedHtmlAttributeReferences(rendered)) {
        appendDependency(dependencies, baseUrl, reference);
      }
    }
  });
}

function isEmbeddedJsonContainer(value: string): boolean {
  const trimmed = value.trim();
  return (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  );
}

function hasAbsoluteDeferredRuntimeAssetShape(value: string): boolean {
  const trimmed = value.trim();

  if (
    (!trimmed.startsWith('http://') &&
      !trimmed.startsWith('https://') &&
      !trimmed.startsWith('//')) ||
    [...trimmed].some((character) => /\s/u.test(character))
  ) {
    return false;
  }

  try {
    const url = new URL(trimmed, 'https://webmirror.invalid/');

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false;
    }

    return deferredRuntimeAssetExtensions.has(posix.extname(url.pathname).toLowerCase());
  } catch {
    return false;
  }
}

function hasEmbeddedJsonFontContext(context: readonly string[]): boolean {
  return context.some((name) => /font|glyph|msdf|typeface/iu.test(name));
}

function embeddedJsonAssetKind(
  value: string,
  context: readonly string[],
): 'image' | 'runtime' | undefined {
  const trimmed = value.trim();

  if (
    (!trimmed.startsWith('http://') &&
      !trimmed.startsWith('https://') &&
      !trimmed.startsWith('//')) ||
    [...trimmed].some((character) => /\s/u.test(character))
  ) {
    return undefined;
  }

  try {
    const url = new URL(trimmed, 'https://webmirror.invalid/');

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }

    const extension = posix.extname(url.pathname).toLowerCase();

    if (deferredRuntimeAssetExtensions.has(extension)) {
      return 'runtime';
    }

    if (extension === '.txt' && hasEmbeddedJsonFontContext(context)) {
      return 'runtime';
    }

    return deferredRenderedImageExtensions.has(extension) ? 'image' : undefined;
  } catch {
    return undefined;
  }
}

function appendDeferredRuntimeDependency(
  dependencies: Set<string>,
  base: string,
  reference: string,
): boolean {
  try {
    const resolved = new URL(reference, base);

    if (
      isKnownNonessentialExternalUrl(resolved.toString()) ||
      [...resolved.searchParams.keys()].some(isSensitiveQueryName)
    ) {
      return false;
    }
  } catch {
    return false;
  }

  return appendDependency(dependencies, base, reference);
}

function appendWorkerDependency(
  dependencies: Set<string>,
  workerDependencies: Set<string>,
  base: string,
  reference: string,
  deferred: boolean,
): boolean {
  const added = deferred
    ? appendDeferredRuntimeDependency(dependencies, base, reference)
    : appendDependency(dependencies, base, reference);

  if (!added) {
    return false;
  }

  try {
    const resolved = new URL(reference, base);
    resolved.hash = '';
    workerDependencies.add(resolved.toString());
  } catch {
    // appendDependency accepted the reference, so this is only defensive.
  }

  return true;
}

interface OptionalFallbackDiscovery {
  readonly expressionRanges: readonly { start: number; end: number }[];
  readonly observedDependencies: readonly string[];
}

function collectOptionalFallbackAssets(
  program: Program,
  propertyDefaults: ReadonlyMap<string, StaticValues>,
  sourceOrigin: string,
  observedResourceUrls: readonly string[],
): OptionalFallbackDiscovery {
  const observed = new Set(
    observedResourceUrls.flatMap((value) => {
      try {
        const url = new URL(value);
        url.hash = '';
        return [url.toString()];
      } catch {
        return [];
      }
    }),
  );
  const expressionRanges: Array<{ start: number; end: number }> = [];
  const observedDependencies = new Set<string>();

  visitAst(program, new Map(), propertyDefaults, sourceOrigin, (node, environment) => {
    let name: string | undefined;
    let expression: AnyNode | undefined;

    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') {
      name = staticPropertyName(node.left.property);
      expression = node.right;
    } else if (node.type === 'Property' && node.kind === 'init' && !node.computed && !node.method) {
      name = staticPropertyName(node.key);
      expression = node.value;
    }

    if (!name || !/fallback/iu.test(name) || !expression) {
      return;
    }

    const references = scalarStrings(
      evaluateStaticExpressionWithJsonObjectDefaults(
        expression,
        environment,
        propertyDefaults,
        sourceOrigin,
      ),
    ).filter(hasLikelyStaticAssetShape);

    if (references.length === 0) {
      return;
    }

    expressionRanges.push({ start: expression.start, end: expression.end });

    for (const reference of references) {
      try {
        const url = new URL(reference, sourceOrigin);
        url.hash = '';

        if (observed.has(url.toString())) {
          observedDependencies.add(url.toString());
        }
      } catch {
        // Invalid optional fallback references stay outside the dependency graph.
      }
    }
  });

  return {
    expressionRanges,
    observedDependencies: [...observedDependencies].sort(),
  };
}

function isInsideExpressionRanges(
  node: AnyNode,
  ranges: readonly { start: number; end: number }[],
): boolean {
  return ranges.some((range) => node.start >= range.start && node.end <= range.end);
}

function isStaticGetFetchCall(node: CallExpression): boolean {
  const isFetch =
    (node.callee.type === 'Identifier' && node.callee.name === 'fetch') ||
    (node.callee.type === 'MemberExpression' &&
      staticPropertyName(node.callee.property) === 'fetch' &&
      node.callee.object.type === 'Identifier' &&
      ['globalThis', 'self', 'window'].includes(node.callee.object.name));

  if (!isFetch || node.arguments.length < 2) {
    return isFetch;
  }

  const init = node.arguments[1];

  if (!isAstNode(init) || init.type !== 'ObjectExpression') {
    return false;
  }

  for (const property of init.properties) {
    if (
      property.type !== 'Property' ||
      property.kind !== 'init' ||
      property.computed ||
      staticPropertyName(property.key)?.toLowerCase() !== 'method'
    ) {
      continue;
    }

    const methods = scalarStrings(
      evaluateStaticExpression(property.value, new Map(), new Map(), 'https://webmirror.invalid'),
    ).map((value) => value.toUpperCase());
    return methods.length > 0 && methods.every((method) => method === 'GET' || method === 'HEAD');
  }

  return true;
}

function isWorkerConstructor(node: AnyNode): node is Extract<AnyNode, { type: 'NewExpression' }> {
  return (
    node.type === 'NewExpression' &&
    node.callee.type === 'Identifier' &&
    (node.callee.name === 'Worker' || node.callee.name === 'SharedWorker')
  );
}

function discoverEmbeddedJsonRuntimeAssets(
  program: Program,
  propertyDefaults: ReadonlyMap<string, StaticValues>,
  sourceOrigin: string,
  baseUrl: string,
  dependencies: Set<string>,
): void {
  const seenDocuments = new Set<string>();
  const runtimeDependencies = new Set<string>();
  const imageDependencies = new Set<string>();
  let parsedDocuments = 0;
  let parsedBytes = 0;
  let visitedValues = 0;

  const nestedContext = (context: readonly string[], name: string): string[] => {
    const normalized = name.trim().toLowerCase();
    return normalized ? [...context.slice(-7), normalized] : [...context];
  };
  const isIndexedTableReference = (value: unknown, length: number): value is number =>
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < length;
  const indexedTablePropertyName = (table: readonly unknown[], name: string): string => {
    const match = /^_(\d+)$/u.exec(name);
    const reference = match?.[1] ? Number(match[1]) : Number.NaN;
    const resolved = Number.isSafeInteger(reference) ? table[reference] : undefined;
    return typeof resolved === 'string' ? resolved : name;
  };
  const isIndexedSerializedTable = (value: unknown): boolean => {
    if (!Array.isArray(value) || value.length < 2) {
      return false;
    }

    return value.some((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return false;
      }

      return Object.entries(candidate).some(
        ([name, reference]) =>
          indexedTablePropertyName(value, name) !== name &&
          isIndexedTableReference(reference, value.length),
      );
    });
  };

  function visitString(value: string, depth: number, context: readonly string[]): void {
    const assetKind = embeddedJsonAssetKind(value, context);

    if (assetKind === 'runtime') {
      appendDeferredRuntimeDependency(runtimeDependencies, baseUrl, value);
    } else if (assetKind === 'image') {
      appendDeferredRuntimeDependency(imageDependencies, baseUrl, value);
    }

    if (
      !isEmbeddedJsonContainer(value) ||
      value.length > maxEmbeddedJsonBytes ||
      parsedDocuments >= maxEmbeddedJsonDocuments ||
      parsedBytes + value.length > maxEmbeddedJsonTotalBytes ||
      seenDocuments.has(value)
    ) {
      return;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return;
    }

    seenDocuments.add(value);
    parsedDocuments += 1;
    parsedBytes += value.length;
    visitValue(parsed, depth + 1, context);
  }

  function visitIndexedTable(
    table: readonly unknown[],
    depth: number,
    context: readonly string[],
  ): void {
    const seenReferences = new Set<string>();

    const visitReference = (
      index: number,
      referenceDepth: number,
      referenceContext: readonly string[],
    ): void => {
      if (referenceDepth > maxEmbeddedJsonDepth || visitedValues >= maxEmbeddedJsonValues) {
        return;
      }

      const semanticKey = hasEmbeddedJsonFontContext(referenceContext) ? 'font' : 'default';
      const seenKey = `${index}:${semanticKey}`;

      if (seenReferences.has(seenKey)) {
        return;
      }

      seenReferences.add(seenKey);
      visitedValues += 1;
      const value = table[index];

      if (typeof value === 'string') {
        visitString(value, referenceDepth, referenceContext);
        return;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          if (isIndexedTableReference(item, table.length)) {
            visitReference(item, referenceDepth + 1, referenceContext);
          } else {
            visitValue(item, referenceDepth + 1, referenceContext);
          }

          if (visitedValues >= maxEmbeddedJsonValues) {
            break;
          }
        }

        return;
      }

      if (value !== null && typeof value === 'object') {
        for (const [name, item] of Object.entries(value)) {
          const itemContext = nestedContext(
            referenceContext,
            indexedTablePropertyName(table, name),
          );

          if (isIndexedTableReference(item, table.length)) {
            visitReference(item, referenceDepth + 1, itemContext);
          } else {
            visitValue(item, referenceDepth + 1, itemContext);
          }

          if (visitedValues >= maxEmbeddedJsonValues) {
            break;
          }
        }
      }
    };

    visitReference(0, depth, context);
  }

  function visitValue(value: unknown, depth: number, context: readonly string[] = []): void {
    if (depth > maxEmbeddedJsonDepth || visitedValues >= maxEmbeddedJsonValues) {
      return;
    }

    visitedValues += 1;

    if (typeof value === 'string') {
      visitString(value, depth, context);
      return;
    }

    if (Array.isArray(value)) {
      if (isIndexedSerializedTable(value)) {
        visitIndexedTable(value, depth + 1, context);
        return;
      }

      for (const item of value) {
        visitValue(item, depth + 1, context);

        if (visitedValues >= maxEmbeddedJsonValues) {
          break;
        }
      }

      return;
    }

    if (value !== null && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) {
        visitValue(item, depth + 1, nestedContext(context, name));

        if (visitedValues >= maxEmbeddedJsonValues) {
          break;
        }
      }
    }
  }

  visitAst(program, new Map(), propertyDefaults, sourceOrigin, (node) => {
    const serialized = staticStringValue(node);

    if (
      serialized &&
      isEmbeddedJsonContainer(serialized) &&
      serialized.length <= maxEmbeddedJsonBytes
    ) {
      visitValue(serialized, 0);
    }
  });

  for (const dependency of [...runtimeDependencies].sort()) {
    if (!appendDependency(dependencies, baseUrl, dependency)) {
      break;
    }
  }

  for (const dependency of [...imageDependencies].sort()) {
    if (!appendDependency(dependencies, baseUrl, dependency)) {
      break;
    }
  }
}

interface ObservedTemplateCandidate {
  readonly baseUrl: string;
  readonly text: string;
}

function observedTemplateCandidates(
  template: AssetTemplate,
  observedUrl: string,
): ObservedTemplateCandidate[] {
  let parsed: URL;

  try {
    parsed = new URL(observedUrl);
  } catch {
    return [];
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password
  ) {
    return [];
  }

  parsed.hash = '';
  const includeSearch = template.source.includes('?');
  const search = includeSearch ? parsed.search : '';
  const lower = template.source.toLowerCase();

  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    return [{ baseUrl: `${parsed.origin}/`, text: parsed.toString() }];
  }

  if (template.source.startsWith('//')) {
    return [
      {
        baseUrl: `${parsed.origin}/`,
        text: `//${parsed.host}${parsed.pathname}${search}`,
      },
    ];
  }

  if (template.source.startsWith('/')) {
    return [{ baseUrl: `${parsed.origin}/`, text: `${parsed.pathname}${search}` }];
  }

  const path = parsed.pathname.replace(/^\/+/u, '');
  const candidates: ObservedTemplateCandidate[] = [];
  const starts = [0];

  for (let index = 0; index < path.length; index += 1) {
    if (path[index] === '/' && index + 1 < path.length) {
      starts.push(index + 1);
    }
  }

  for (const start of starts) {
    const prefix = path.slice(0, start);
    candidates.push({
      baseUrl: new URL(`/${prefix}`, parsed.origin).toString(),
      text: `${path.slice(start)}${search}`,
    });
  }

  return candidates;
}

function placeholderAcceptsValue(
  placeholder: AssetTemplatePlaceholder,
  value: string,
  runtimeDefaults: ReadonlyMap<RuntimePlaceholderKind, ReadonlySet<string>>,
): boolean {
  const runtimeKind = runtimePlaceholderKind(placeholder.name);
  const runtimeValues = runtimeKind ? runtimeDefaults.get(runtimeKind) : undefined;

  if (runtimeValues && runtimeValues.size > 0 && !runtimeValues.has(value)) {
    return false;
  }

  if (
    runtimeKind === 'resolution' &&
    (!runtimeValues || runtimeValues.size === 0) &&
    !knownResolutionValues.has(value)
  ) {
    return false;
  }

  if (
    runtimeKind &&
    runtimeKind !== 'language' &&
    runtimeKind !== 'resolution' &&
    !runtimeValueAllowed(runtimeKind, value)
  ) {
    return false;
  }

  return placeholder.acceptsAnyValue || placeholder.choices.includes(value);
}

function matchAssetTemplateParts(
  parts: readonly AssetTemplatePart[],
  candidate: string,
  partIndex: number,
  cursor: number,
  assignments: ReadonlyMap<string, string>,
  runtimeDefaults: ReadonlyMap<RuntimePlaceholderKind, ReadonlySet<string>>,
): ReadonlyMap<string, string> | undefined {
  if (partIndex >= parts.length) {
    return cursor === candidate.length ? assignments : undefined;
  }

  const part = parts[partIndex];

  if (!part) {
    return undefined;
  }

  if (part.kind === 'literal') {
    return candidate.startsWith(part.value, cursor)
      ? matchAssetTemplateParts(
          parts,
          candidate,
          partIndex + 1,
          cursor + part.value.length,
          assignments,
          runtimeDefaults,
        )
      : undefined;
  }

  const existing = assignments.get(part.placeholder.name);
  const next = parts[partIndex + 1];

  if (!next || next.kind !== 'literal') {
    return undefined;
  }

  const candidateEnds: number[] = [];

  if (!next.value) {
    candidateEnds.push(candidate.length);
  } else {
    let nextIndex = candidate.indexOf(next.value, cursor);

    while (nextIndex >= 0) {
      candidateEnds.push(nextIndex);
      nextIndex = candidate.indexOf(next.value, nextIndex + 1);
    }
  }

  for (const end of candidateEnds) {
    const value = candidate.slice(cursor, end);

    if (
      !isTemplateToken(value) ||
      !placeholderAcceptsValue(part.placeholder, value, runtimeDefaults) ||
      (existing !== undefined && existing !== value)
    ) {
      continue;
    }

    const nextAssignments = new Map(assignments);
    nextAssignments.set(part.placeholder.name, value);
    const matched = matchAssetTemplateParts(
      parts,
      candidate,
      partIndex + 1,
      end,
      nextAssignments,
      runtimeDefaults,
    );

    if (matched) {
      return matched;
    }
  }

  return undefined;
}

function matchAssetTemplate(
  template: AssetTemplate,
  candidate: string,
  runtimeDefaults: ReadonlyMap<RuntimePlaceholderKind, ReadonlySet<string>>,
): ReadonlyMap<string, string> | undefined {
  return matchAssetTemplateParts(template.parts, candidate, 0, 0, new Map(), runtimeDefaults);
}

function observedUrlSharesTemplateDirectory(template: AssetTemplate, observedUrl: string): boolean {
  let templatePath: string;
  let observedPath: string;

  try {
    templatePath = new URL(sampleTemplateReference(template), 'https://webmirror.invalid/')
      .pathname;
    observedPath = new URL(observedUrl).pathname;
  } catch {
    return false;
  }

  const templateDirectory = posix
    .dirname(templatePath)
    .split('/')
    .filter((segment) => segment && segment !== '.');
  const observedDirectory = posix
    .dirname(observedPath)
    .split('/')
    .filter((segment) => segment && segment !== '.');

  if (templateDirectory.length === 0 || templateDirectory.length > observedDirectory.length) {
    return false;
  }

  return templateDirectory.every(
    (segment, index) =>
      observedDirectory[observedDirectory.length - templateDirectory.length + index] === segment,
  );
}

function mostFrequentObservedExtension(
  observedUrls: readonly string[],
  acceptedExtensions: ReadonlySet<string>,
  template: AssetTemplate,
): string | undefined {
  const counts = new Map<string, number>();

  for (const observedUrl of observedUrls) {
    try {
      if (!observedUrlSharesTemplateDirectory(template, observedUrl)) {
        continue;
      }

      const pathname = new URL(observedUrl).pathname;
      const extension = posix.extname(pathname).toLowerCase();

      if (!acceptedExtensions.has(extension)) {
        continue;
      }

      const value = extension.slice(1);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    } catch {
      // Ignore malformed mapping keys. RewriteSession has already validated the useful ones.
    }
  }

  const ranked = [...counts.entries()].sort(([leftValue, leftCount], [rightValue, rightCount]) => {
    const countOrder = rightCount - leftCount;
    return countOrder === 0 ? leftValue.localeCompare(rightValue) : countOrder;
  });
  const first = ranked[0];
  const second = ranked[1];

  return first && first[1] !== second?.[1] ? first[0] : undefined;
}

function placeholderMediaExtensions(placeholderName: string): ReadonlySet<string> | undefined {
  const name = placeholderName.toLowerCase();

  if (name.includes('audio') || name.includes('sound')) {
    return audioExtensions;
  }

  if (name.includes('video') || name.includes('movie')) {
    return videoExtensions;
  }

  return name.includes('font') ? contextualFontExtensions : undefined;
}

function inferAssetTemplateValues(
  templates: readonly AssetTemplate[],
  observedUrls: readonly string[],
  sourceOrigin: string,
  runtimeDefaults: ReadonlyMap<RuntimePlaceholderKind, ReadonlySet<string>>,
): ReadonlyMap<string, AssetTemplateInference> {
  const accumulators = new Map<
    string,
    {
      baseUrlCounts: Map<string, number>;
      placeholderNames: Set<string>;
      values: Map<string, Set<string>>;
    }
  >();
  const incrementCount = (counts: Map<string, number>, value: string): void => {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  };

  for (const template of templates) {
    const accumulator = {
      baseUrlCounts: new Map<string, number>(),
      placeholderNames: new Set<string>(),
      values: new Map<string, Set<string>>(),
    };

    for (const part of template.parts) {
      if (part.kind === 'placeholder') {
        accumulator.placeholderNames.add(part.placeholder.name);
      }
    }

    accumulators.set(template.source, accumulator);
  }

  for (const template of templates) {
    const accumulator = accumulators.get(template.source);

    if (!accumulator) {
      continue;
    }

    for (const observedUrl of observedUrls) {
      for (const candidate of observedTemplateCandidates(template, observedUrl)) {
        const assignments = matchAssetTemplate(template, candidate.text, runtimeDefaults);

        if (!assignments) {
          continue;
        }

        incrementCount(accumulator.baseUrlCounts, candidate.baseUrl);

        for (const [name, value] of assignments) {
          const candidates = accumulator.values.get(name) ?? new Set<string>();
          candidates.add(value);
          accumulator.values.set(name, candidates);
        }
      }
    }
  }

  const sourceBaseUrl = new URL('/', sourceOrigin).toString();
  const inferences = new Map<string, AssetTemplateInference>();

  for (const template of templates) {
    const accumulator = accumulators.get(template.source);

    if (!accumulator) {
      continue;
    }

    for (const name of accumulator.placeholderNames) {
      if ((accumulator.values.get(name)?.size ?? 0) > 0) {
        continue;
      }

      const runtimeKind = runtimePlaceholderKind(name);
      const configuredValues = runtimeKind ? runtimeDefaults.get(runtimeKind) : undefined;

      if (configuredValues && configuredValues.size > 0) {
        accumulator.values.set(name, new Set(configuredValues));
        continue;
      }

      const extensions = placeholderMediaExtensions(name);
      const extension = extensions
        ? mostFrequentObservedExtension(observedUrls, extensions, template)
        : undefined;

      if (extension) {
        accumulator.values.set(name, new Set([extension]));
      }
    }

    const baseUrl =
      [...accumulator.baseUrlCounts.entries()]
        .sort(([leftUrl, leftCount], [rightUrl, rightCount]) => {
          const countOrder = rightCount - leftCount;

          if (countOrder !== 0) {
            return countOrder;
          }

          const lengthOrder = leftUrl.length - rightUrl.length;
          return lengthOrder === 0 ? leftUrl.localeCompare(rightUrl) : lengthOrder;
        })
        .at(0)?.[0] ?? sourceBaseUrl;

    inferences.set(template.source, {
      baseUrl,
      values: accumulator.values,
    });
  }

  return inferences;
}

function placeholderExpansionValues(
  placeholder: AssetTemplatePlaceholder,
  inference: AssetTemplateInference,
): string[] {
  const inferred = [...(inference.values.get(placeholder.name) ?? [])].sort();

  if (placeholder.choices.length === 0) {
    return inferred;
  }

  if (inferred.length > 0) {
    return inferred.filter((value) => placeholder.choices.includes(value));
  }

  return placeholder.acceptsAnyValue && placeholder.choices.length > 1
    ? [...placeholder.choices].sort()
    : [];
}

function expandAssetTemplate(template: AssetTemplate, inference: AssetTemplateInference): string[] {
  const references = new Set<string>();

  const visit = (
    partIndex: number,
    output: string,
    assignments: ReadonlyMap<string, string>,
  ): void => {
    if (references.size >= maxTemplateExpansions) {
      return;
    }

    const part = template.parts[partIndex];

    if (!part) {
      if (hasLikelyStaticAssetShape(output)) {
        references.add(output);
      }
      return;
    }

    if (part.kind === 'literal') {
      visit(partIndex + 1, `${output}${part.value}`, assignments);
      return;
    }

    const assigned = assignments.get(part.placeholder.name);
    const candidates = assigned
      ? [assigned]
      : placeholderExpansionValues(part.placeholder, inference);

    for (const candidate of candidates) {
      const nextAssignments = new Map(assignments);
      nextAssignments.set(part.placeholder.name, candidate);
      visit(partIndex + 1, `${output}${candidate}`, nextAssignments);
    }
  };

  visit(0, '', new Map());
  return [...references].sort();
}

function receiverName(node: AnyNode): string {
  if (node.type === 'Identifier') {
    return node.name;
  }

  if (node.type === 'MemberExpression') {
    const property = staticPropertyName(node.property);
    const object = receiverName(node.object);
    return property ? `${object}.${property}` : object;
  }

  return '';
}

function loaderCategoryForName(value: string): LoaderCategory | undefined {
  const name = value.toLowerCase();

  if (/video|movie|media/iu.test(name)) {
    return 'video';
  }

  if (/gltf/iu.test(name)) {
    return 'gltf';
  }

  if (/geometry|draco|mesh|model/iu.test(name)) {
    return 'geometry';
  }

  if (/texture|ktx|bitmap|image|exr|basic/iu.test(name)) {
    return 'image';
  }

  if (/audio|sound|buffer/iu.test(name)) {
    return 'audio';
  }

  return /font|glyph|msdf/iu.test(name) ? 'font' : undefined;
}

function loaderCategoryForReference(value: string): LoaderCategory | undefined {
  let path: string;

  try {
    path = new URL(value, 'https://webmirror.invalid/').pathname.toLowerCase();
  } catch {
    return undefined;
  }

  const extensionIndex = path.lastIndexOf('.');
  const extension = extensionIndex < 0 ? '' : path.slice(extensionIndex);

  if (extension === '.drc') {
    return 'geometry';
  }

  if (extension === '.glb' || extension === '.gltf') {
    return 'gltf';
  }

  if (imageExtensions.has(extension)) {
    return 'image';
  }

  if (videoExtensions.has(extension)) {
    return 'video';
  }

  if (audioExtensions.has(extension)) {
    return 'audio';
  }

  return fontExtensions.has(extension) ? 'font' : undefined;
}

function collectLoaderBaseUrls(
  program: Program,
  propertyDefaults: ReadonlyMap<string, StaticValues>,
  sourceOrigin: string,
): ReadonlyMap<LoaderCategory, ReadonlySet<string>> {
  const bases = new Map<LoaderCategory, Set<string>>();

  visitAst(program, new Map(), propertyDefaults, sourceOrigin, (node, environment) => {
    if (
      node.type !== 'CallExpression' ||
      node.callee.type !== 'MemberExpression' ||
      staticPropertyName(node.callee.property) !== 'setPath'
    ) {
      return;
    }

    const category = loaderCategoryForName(receiverName(node.callee.object));
    const argument = node.arguments[0];

    if (!category || !isAstNode(argument)) {
      return;
    }

    const categoryBases = bases.get(category) ?? new Set<string>();

    for (const value of scalarStrings(
      evaluateStaticExpression(argument, environment, propertyDefaults, sourceOrigin),
    )) {
      try {
        const base = new URL(value, sourceOrigin);

        if (
          (base.protocol !== 'http:' && base.protocol !== 'https:') ||
          base.username ||
          base.password ||
          base.origin !== sourceOrigin
        ) {
          continue;
        }

        base.search = '';
        base.hash = '';
        if (!base.pathname.endsWith('/')) {
          base.pathname += '/';
        }
        categoryBases.add(base.toString());
      } catch {
        // Only syntactically valid, same-origin loader bases are useful.
      }
    }

    if (categoryBases.size > 0) {
      bases.set(category, categoryBases);
    }
  });

  return bases;
}

function loaderArgument(node: AnyNode): AnyNode | undefined {
  if (
    node.type !== 'CallExpression' ||
    node.callee.type !== 'MemberExpression' ||
    !assetLoaderMethods.has(staticPropertyName(node.callee.property) ?? '')
  ) {
    return undefined;
  }

  const argument = node.arguments[0];
  return isAstNode(argument) ? argument : undefined;
}

function isDefaultAssetDeclaration(node: AnyNode): node is AnyNode & {
  id: AnyNode;
  init: AnyNode;
} {
  return (
    node.type === 'VariableDeclarator' &&
    node.id.type === 'Identifier' &&
    node.init !== null &&
    /(?:asset|file|image|model|texture)/iu.test(node.id.name) &&
    /default/iu.test(node.id.name)
  );
}

function appendDependency(dependencies: Set<string>, base: string, reference: string): boolean {
  if (dependencies.size >= maxAssetCandidates) {
    return false;
  }

  try {
    const resolved = new URL(reference, base);

    if (
      (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') ||
      resolved.username ||
      resolved.password
    ) {
      return false;
    }

    resolved.hash = '';
    dependencies.add(resolved.toString());
    return true;
  } catch {
    return false;
  }
}

function hasExplicitAssetPath(reference: string): boolean {
  const trimmed = reference.trim();
  return (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.includes('/')
  );
}

function observedDependencyForReference(
  reference: string,
  contextUrl: string | undefined,
  observedResourceUrls: readonly string[],
): string | undefined {
  if (!contextUrl || !hasExplicitAssetPath(reference)) {
    return undefined;
  }

  let context: URL;
  let resolved: URL;

  try {
    context = new URL(contextUrl);
    resolved = new URL(reference, context);
  } catch {
    return undefined;
  }

  const rootRelativeReference =
    reference.trim().startsWith('/') && !reference.trim().startsWith('//');
  const candidates = new Set<string>();

  for (const observedResourceUrl of observedResourceUrls) {
    let observed: URL;

    try {
      observed = new URL(observedResourceUrl);
    } catch {
      continue;
    }

    observed.hash = '';

    if (observed.toString() === resolved.toString()) {
      candidates.add(observed.toString());
      continue;
    }

    if (
      rootRelativeReference ||
      observed.origin !== context.origin ||
      resolved.search !== observed.search ||
      !observed.pathname.endsWith(`/${resolved.pathname.replace(/^\/+/u, '')}`)
    ) {
      continue;
    }

    candidates.add(observed.toString());
  }

  return candidates.size === 1 ? [...candidates][0] : undefined;
}

function addReferencesForCategory(
  dependencies: Set<string>,
  bases: ReadonlyMap<LoaderCategory, ReadonlySet<string>>,
  category: LoaderCategory | undefined,
  references: readonly string[],
): boolean {
  if (!category) {
    return false;
  }

  const categoryBases = bases.get(category);

  if (!categoryBases || categoryBases.size === 0) {
    return false;
  }

  let added = false;

  for (const base of categoryBases) {
    for (const reference of references) {
      added = appendDependency(dependencies, base, reference) || added;

      if (dependencies.size >= maxAssetCandidates) {
        return added;
      }
    }
  }

  return added;
}

export function discoverStaticJavaScriptAssets(
  program: Program,
  sourceOrigin: string,
  observedResourceUrls: readonly string[] = [],
  contextUrl?: string,
): StaticJavaScriptAssetDiscovery {
  const structuredAssetExclusions = collectStructuredAssetExclusions(
    program,
    sourceOrigin,
    observedResourceUrls,
  );
  const collectedPropertyDefaults = collectPropertyDefaults(program, sourceOrigin);
  const initialStructuredAssets = collectStructuredAssetReferences(
    program,
    collectedPropertyDefaults,
    sourceOrigin,
    structuredAssetExclusions,
  );
  const initialRuntimeDefaults = collectRuntimePlaceholderDefaults(
    collectedPropertyDefaults,
    observedResourceUrls,
  );
  const initialTemplateInferences = inferAssetTemplateValues(
    initialStructuredAssets.templates,
    observedResourceUrls,
    sourceOrigin,
    initialRuntimeDefaults,
  );
  const propertyDefaults = narrowObservedPropertyDefaults(
    collectedPropertyDefaults,
    initialTemplateInferences,
    observedResourceUrls,
  );
  const bases = collectLoaderBaseUrls(program, propertyDefaults, sourceOrigin);
  const structuredAssets = collectStructuredAssetReferences(
    program,
    propertyDefaults,
    sourceOrigin,
    structuredAssetExclusions,
  );
  const runtimeDefaults = collectRuntimePlaceholderDefaults(propertyDefaults, observedResourceUrls);
  const templateInferences = inferAssetTemplateValues(
    structuredAssets.templates,
    observedResourceUrls,
    sourceOrigin,
    runtimeDefaults,
  );
  const finiteTemplateDomains = collectFiniteTemplateDomains(
    program,
    structuredAssets,
    propertyDefaults,
    sourceOrigin,
  );
  const dependencies = new Set<string>();
  const workerDependencies = new Set<string>();
  const handledArgumentRanges = new Set<string>();
  const avatarModels = new Set<string>();
  let containsEnsureAvatarUrl = false;
  const sourceBaseUrl = new URL('/', sourceOrigin).toString();
  const optionalFallbacks = collectOptionalFallbackAssets(
    program,
    propertyDefaults,
    sourceOrigin,
    observedResourceUrls,
  );

  for (const reference of collectObservedAssetInventoryReferences(
    program,
    sourceOrigin,
    observedResourceUrls,
  )) {
    appendDependency(dependencies, sourceBaseUrl, reference);
  }

  for (const reference of structuredAssets.direct) {
    appendDependency(dependencies, sourceBaseUrl, reference);
  }

  for (const template of structuredAssets.templates) {
    const inference = templateInferences.get(template.source) ?? {
      baseUrl: sourceBaseUrl,
      values: new Map<string, ReadonlySet<string>>(),
    };

    for (const reference of expandAssetTemplate(template, inference)) {
      appendDependency(dependencies, inference.baseUrl, reference);
    }
  }

  for (const dependency of optionalFallbacks.observedDependencies) {
    appendDeferredRuntimeDependency(dependencies, sourceBaseUrl, dependency);
  }

  discoverEmbeddedJsonRuntimeAssets(
    program,
    propertyDefaults,
    sourceOrigin,
    sourceBaseUrl,
    dependencies,
  );
  discoverEmbeddedHtmlAssets(
    program,
    propertyDefaults,
    sourceOrigin,
    sourceBaseUrl,
    finiteTemplateDomains,
    [...structuredAssets.direct, ...structuredAssets.templates.map((template) => template.source)],
    observedResourceUrls,
    dependencies,
  );

  visitAst(program, new Map(), propertyDefaults, sourceOrigin, (node, environment) => {
    if (
      isInsideExpressionRanges(node, optionalFallbacks.expressionRanges) ||
      structuredAssetExclusions.suppressedSourceValueRanges.has(rangeKey(node))
    ) {
      return;
    }

    if (node.type === 'Literal' && typeof node.value === 'string') {
      if (/^avatar\/[A-Za-z0-9_./-]+$/u.test(node.value)) {
        avatarModels.add(node.value);
      }

      if (hasAbsoluteDeferredRuntimeAssetShape(node.value)) {
        appendDeferredRuntimeDependency(dependencies, sourceBaseUrl, node.value);
      }

      addReferencesForCategory(dependencies, bases, loaderCategoryForReference(node.value), [
        node.value,
      ]);
      return;
    }

    if (node.type === 'TemplateLiteral') {
      for (const reference of scalarStrings(
        evaluateStaticExpressionWithJsonObjectDefaults(
          node,
          environment,
          propertyDefaults,
          sourceOrigin,
        ),
      )) {
        if (hasAbsoluteDeferredRuntimeAssetShape(reference)) {
          appendDeferredRuntimeDependency(dependencies, sourceBaseUrl, reference);
        }

        addReferencesForCategory(dependencies, bases, loaderCategoryForReference(reference), [
          reference,
        ]);
      }

      return;
    }

    if (
      node.type === 'CallExpression' &&
      isStaticGetFetchCall(node) &&
      isAstNode(node.arguments[0]) &&
      staticStringValue(node.arguments[0]) === undefined
    ) {
      for (const reference of scalarStrings(
        evaluateStaticExpressionWithJsonObjectDefaults(
          node.arguments[0],
          environment,
          propertyDefaults,
          sourceOrigin,
        ),
      )) {
        if (hasLikelyStaticAssetShape(reference)) {
          const observedDependency = observedDependencyForReference(
            reference,
            contextUrl,
            observedResourceUrls,
          );

          if (observedDependency) {
            appendDependency(dependencies, sourceBaseUrl, observedDependency);
          } else if (hasExplicitAssetPath(reference)) {
            appendDeferredRuntimeDependency(dependencies, sourceBaseUrl, reference);
          }
        }
      }
    }

    if (
      isWorkerConstructor(node) &&
      isAstNode(node.arguments[0]) &&
      staticStringValue(node.arguments[0]) === undefined
    ) {
      for (const reference of scalarStrings(
        evaluateStaticExpressionWithJsonObjectDefaults(
          node.arguments[0],
          environment,
          propertyDefaults,
          sourceOrigin,
        ),
      )) {
        if (!hasLikelyStaticAssetShape(reference)) {
          continue;
        }

        const observedDependency = observedDependencyForReference(
          reference,
          contextUrl,
          observedResourceUrls,
        );

        if (observedDependency) {
          appendWorkerDependency(
            dependencies,
            workerDependencies,
            sourceBaseUrl,
            observedDependency,
            false,
          );
        } else if (hasExplicitAssetPath(reference)) {
          appendWorkerDependency(dependencies, workerDependencies, sourceBaseUrl, reference, true);
        }
      }
    }

    if (
      node.type === 'CallExpression' ||
      node.type === 'BinaryExpression' ||
      node.type === 'ConditionalExpression' ||
      node.type === 'LogicalExpression'
    ) {
      for (const reference of scalarStrings(
        evaluateStaticExpressionWithJsonObjectDefaults(
          node,
          environment,
          propertyDefaults,
          sourceOrigin,
        ),
      )) {
        if (hasAbsoluteDeferredRuntimeAssetShape(reference)) {
          appendDeferredRuntimeDependency(dependencies, sourceBaseUrl, reference);
        }
      }
    }

    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const invocationCategory = loaderCategoryForName(receiverName(node.callee));

      if (invocationCategory) {
        for (const argument of node.arguments) {
          if (!isAstNode(argument)) {
            continue;
          }

          const references = nestedScalarStrings(
            evaluateStaticExpression(argument, environment, propertyDefaults, sourceOrigin),
            hasLikelyStaticAssetShape,
          );
          let handled = false;

          for (const reference of references) {
            const category = loaderCategoryForReference(reference) ?? invocationCategory;
            const addedFromBase = addReferencesForCategory(dependencies, bases, category, [
              reference,
            ]);
            const observedDependency = !addedFromBase
              ? observedDependencyForReference(reference, contextUrl, observedResourceUrls)
              : undefined;
            const addedDirectly = observedDependency
              ? appendDependency(dependencies, sourceBaseUrl, observedDependency)
              : !addedFromBase && hasExplicitAssetPath(reference)
                ? appendDependency(dependencies, sourceOrigin, reference)
                : false;
            handled = addedFromBase || addedDirectly || handled;
          }

          if (handled) {
            handledArgumentRanges.add(rangeKey(argument));
          }
        }
      }
    }

    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
      if (staticPropertyName(node.callee.property) === 'ensureAvatarUrl') {
        containsEnsureAvatarUrl = true;
      }

      const argument = loaderArgument(node);

      if (!argument) {
        return;
      }

      const references = nestedScalarStrings(
        evaluateStaticExpression(argument, environment, propertyDefaults, sourceOrigin),
        hasLikelyStaticAssetShape,
      );
      const receiverCategory = loaderCategoryForName(receiverName(node.callee.object));
      let handled = false;

      for (const reference of references) {
        const category = receiverCategory ?? loaderCategoryForReference(reference);
        const addedFromBase = addReferencesForCategory(dependencies, bases, category, [reference]);
        const observedDependency = !addedFromBase
          ? observedDependencyForReference(reference, contextUrl, observedResourceUrls)
          : undefined;
        const addedDirectly = observedDependency
          ? appendDependency(dependencies, sourceBaseUrl, observedDependency)
          : !addedFromBase && hasExplicitAssetPath(reference)
            ? appendDependency(dependencies, sourceOrigin, reference)
            : false;
        handled = addedFromBase || addedDirectly || handled;
      }

      if (handled) {
        handledArgumentRanges.add(rangeKey(argument));
      }
      return;
    }

    if (!isDefaultAssetDeclaration(node)) {
      return;
    }

    const references = scalarStrings(
      evaluateStaticExpression(node.init, environment, propertyDefaults, sourceOrigin),
    );

    for (const reference of references) {
      addReferencesForCategory(dependencies, bases, loaderCategoryForReference(reference), [
        reference,
      ]);
    }
  });

  if (containsEnsureAvatarUrl) {
    const avatarReferences = [...avatarModels]
      .filter((value) => !value.endsWith('.drc'))
      .map((value) => `${value}.drc`);
    addReferencesForCategory(dependencies, bases, 'geometry', avatarReferences);
  }

  for (const dependency of dependencies) {
    if (
      isSuppressedStructuredSourceUrl(dependency, structuredAssetExclusions.suppressedSourcePaths)
    ) {
      dependencies.delete(dependency);
      workerDependencies.delete(dependency);
    }
  }

  return {
    dependencies: [...dependencies].sort(),
    workerDependencies: [...workerDependencies].sort(),
    handledArgumentRanges,
  };
}
