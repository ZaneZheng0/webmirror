import { parse, type AnyNode, type Comment, type Program } from 'acorn';
import MagicString from 'magic-string';

import {
  isKnownNonessentialExternalUrl,
  knownNonessentialTelemetryPathPrefixes,
  knownNonessentialTelemetryRoutes,
  knownNonessentialTelemetryPathnames,
  knownTrackingDomainSuffixes,
  sensitiveQueryNames,
} from '@webmirror/shared';

import {
  imageRenditionNeutralQueryParameterValues,
  imageRenditionQueryParameterNames,
} from './resource-map.js';
import { rewriteCssTextWithSession } from './rewrite-css.js';
import {
  createRewriteSession,
  type LocalReferenceStyle,
  type RewriteResult,
  type RewriteSession,
  type RewriteTextInput,
} from './rewriter-core.js';
import { discoverStaticJavaScriptAssets } from './static-javascript-assets.js';
import { isStandaloneTrackingJavaScript, trackingNoopScript } from './tracking.js';

interface StaticStringNode {
  node: AnyNode;
  value: string;
}

type AstVisitor = (
  node: AnyNode,
  parent: AnyNode | undefined,
  property: string | undefined,
) => void;

function parseJavaScript(text: string, comments?: Comment[]): Program {
  let moduleError: unknown;

  try {
    return parse(text, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
      ...(comments ? { onComment: comments } : {}),
    });
  } catch (error) {
    moduleError = error;
    comments?.splice(0);
  }

  try {
    return parse(text, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowHashBang: true,
      allowReturnOutsideFunction: true,
      ...(comments ? { onComment: comments } : {}),
    });
  } catch {
    throw moduleError;
  }
}

function isAstNode(value: unknown): value is AnyNode {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate = value as {
    type?: unknown;
    start?: unknown;
    end?: unknown;
  };

  return (
    typeof candidate.type === 'string' &&
    typeof candidate.start === 'number' &&
    typeof candidate.end === 'number'
  );
}

function walkAst(node: AnyNode, visitor: AstVisitor, parent?: AnyNode, property?: string): void {
  visitor(node, parent, property);

  for (const [childProperty, value] of Object.entries(node)) {
    if (isAstNode(value)) {
      walkAst(value, visitor, node, childProperty);
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) {
          walkAst(item, visitor, node, childProperty);
        }
      }
    }
  }
}

function staticString(node: AnyNode | undefined): StaticStringNode | undefined {
  if (!node) {
    return undefined;
  }

  if (node.type === 'Literal' && typeof node.value === 'string') {
    return { node, value: node.value };
  }

  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    const cooked = node.quasis[0]?.value.cooked;

    if (typeof cooked === 'string') {
      return { node, value: cooked };
    }
  }

  return undefined;
}

function isImportMetaUrl(node: AnyNode | undefined): boolean {
  if (
    !node ||
    node.type !== 'MemberExpression' ||
    node.computed ||
    node.object.type !== 'MetaProperty' ||
    node.object.meta.name !== 'import' ||
    node.object.property.name !== 'meta' ||
    node.property.type !== 'Identifier'
  ) {
    return false;
  }

  return node.property.name === 'url';
}

function isIdentifierNamed(node: AnyNode | undefined, names: ReadonlySet<string>): boolean {
  return node?.type === 'Identifier' && names.has(node.name);
}

function isBareModuleSpecifier(value: string): boolean {
  const trimmed = value.trim();
  return (
    Boolean(trimmed) &&
    !trimmed.startsWith('http://') &&
    !trimmed.startsWith('https://') &&
    !trimmed.startsWith('//') &&
    !trimmed.startsWith('/') &&
    !trimmed.startsWith('./') &&
    !trimmed.startsWith('../')
  );
}

function isImplicitRelativeReference(value: string): boolean {
  const trimmed = value.trim();

  return (
    Boolean(trimmed) &&
    !trimmed.startsWith('http://') &&
    !trimmed.startsWith('https://') &&
    !trimmed.startsWith('//') &&
    !trimmed.startsWith('/') &&
    !trimmed.startsWith('./') &&
    !trimmed.startsWith('../')
  );
}

function shouldSkipGenericStaticString(
  parent: AnyNode | undefined,
  property: string | undefined,
): boolean {
  if (!parent || !property) {
    return true;
  }

  if (
    property === 'key' &&
    (parent.type === 'Property' ||
      parent.type === 'MethodDefinition' ||
      parent.type === 'PropertyDefinition' ||
      parent.type === 'ImportAttribute')
  ) {
    return true;
  }

  if (property === 'property' && parent.type === 'MemberExpression') {
    return true;
  }

  if (
    parent.type === 'ImportSpecifier' ||
    parent.type === 'ExportSpecifier' ||
    parent.type === 'ImportAttribute'
  ) {
    return true;
  }

  if (
    property === 'source' &&
    (parent.type === 'ImportExpression' ||
      parent.type === 'ImportDeclaration' ||
      parent.type === 'ExportAllDeclaration' ||
      parent.type === 'ExportNamedDeclaration')
  ) {
    return true;
  }

  if (parent.type === 'BinaryExpression' && parent.operator === '+') {
    return true;
  }

  if (
    property === 'arguments' &&
    (parent.type === 'CallExpression' || parent.type === 'NewExpression')
  ) {
    return true;
  }

  return (
    parent.type === 'ExpressionStatement' &&
    property === 'expression' &&
    typeof parent.directive === 'string'
  );
}

function staticPropertyName(node: AnyNode): string | undefined {
  if (node.type === 'Identifier') {
    return node.name;
  }

  return node.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
}

function isKnownNonessentialEmbedLiteral(value: string): boolean {
  const trimmed = value.trim();

  if (!trimmed) {
    return false;
  }

  const candidates = [
    trimmed,
    ...(trimmed.startsWith('//') ? [`https:${trimmed}`] : []),
    ...(trimmed.startsWith('://') ? [`https${trimmed}`] : []),
  ];

  return candidates.some((candidate) => isKnownNonessentialExternalUrl(candidate));
}

function containsKnownNonessentialEmbedLiteral(node: AnyNode): boolean {
  let matched = false;

  walkAst(node, (candidate) => {
    const value = staticString(candidate)?.value;

    if (value && isKnownNonessentialEmbedLiteral(value)) {
      matched = true;
    }
  });

  return matched;
}

export function isNonessentialEmbedBootstrapJavaScript(text: string): boolean {
  let program: Program;

  try {
    program = parseJavaScript(text);
  } catch {
    return false;
  }

  let matched = false;

  walkAst(program, (node) => {
    if (
      node.type === 'AssignmentExpression' &&
      node.left.type === 'MemberExpression' &&
      staticPropertyName(node.left.property) === 'src' &&
      containsKnownNonessentialEmbedLiteral(node.right)
    ) {
      matched = true;
    }
  });

  return matched;
}

const staticAssetLoaderMethods = new Set([
  'batched',
  'curves',
  'fromUrl',
  'load',
  'loadAsync',
  'preload',
  'preloadAsync',
  'skinAnimation',
]);
const runtimeManifestReferenceKeys = new Set([
  'chunk',
  'chunks',
  'css',
  'import',
  'imports',
  'module',
  'modules',
  'stylesheet',
  'stylesheets',
]);
const runtimeComposedAssetReferenceSuffixes = [
  'asset',
  'assets',
  'binary',
  'binaries',
  'data',
  'file',
  'files',
  'font',
  'fonts',
  'image',
  'images',
  'leaf',
  'leaves',
  'model',
  'models',
  'path',
  'paths',
  'resource',
  'resources',
  'shader',
  'shaders',
  'source',
  'sources',
  'texture',
  'textures',
  'url',
  'urls',
  'wasm',
  'worker',
  'workers',
] as const;
const workerRuntimeUrlMapMarker = '/* webmirror-worker-runtime-url-map-v1 */';
const workerRuntimeUrlMapEndMarker = '/* /webmirror-worker-runtime-url-map-v1 */';
const legacyWorkerRuntimeUrlMapTerminator = '})(typeof self!=="undefined"?self:globalThis);';
const workerRuntimeUrlMapMarkerComment = 'webmirror-worker-runtime-url-map-v1';
const workerRuntimeUrlMapEndMarkerComment = '/webmirror-worker-runtime-url-map-v1';

function isWhitespaceOnly(text: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    const character = text[index];

    if (character !== ' ' && character !== '\t' && character !== '\r' && character !== '\n') {
      return false;
    }
  }

  return true;
}

function isExactBlockComment(comment: Comment, value: string): boolean {
  return comment.type === 'Block' && comment.value.trim() === value;
}

function isGeneratedWorkerRuntimeInvocationArgument(node: AnyNode | undefined): boolean {
  return (
    node?.type === 'ConditionalExpression' &&
    node.test.type === 'BinaryExpression' &&
    node.test.operator === '!==' &&
    node.test.left.type === 'UnaryExpression' &&
    node.test.left.operator === 'typeof' &&
    node.test.left.argument.type === 'Identifier' &&
    node.test.left.argument.name === 'self' &&
    node.test.right.type === 'Literal' &&
    node.test.right.value === 'undefined' &&
    node.consequent.type === 'Identifier' &&
    node.consequent.name === 'self' &&
    node.alternate.type === 'Identifier' &&
    node.alternate.name === 'globalThis'
  );
}

function isGeneratedWorkerRuntimeStatement(node: AnyNode | undefined): boolean {
  if (
    node?.type !== 'ExpressionStatement' ||
    node.expression.type !== 'CallExpression' ||
    node.expression.callee.type !== 'FunctionExpression' ||
    node.expression.callee.params.length !== 1 ||
    node.expression.callee.params[0]?.type !== 'Identifier' ||
    node.expression.callee.params[0].name !== 'global' ||
    node.expression.arguments.length !== 1 ||
    !isAstNode(node.expression.arguments[0]) ||
    !isGeneratedWorkerRuntimeInvocationArgument(node.expression.arguments[0])
  ) {
    return false;
  }

  let installsModuleMapper = false;
  walkAst(node.expression.callee.body, (candidate) => {
    if (
      candidate.type === 'AssignmentExpression' &&
      candidate.left.type === 'MemberExpression' &&
      !candidate.left.computed &&
      candidate.left.object.type === 'Identifier' &&
      candidate.left.object.name === 'global' &&
      candidate.left.property.type === 'Identifier' &&
      candidate.left.property.name === '__webmirrorMapModuleUrl'
    ) {
      installsModuleMapper = true;
    }
  });
  return installsModuleMapper;
}

function generatedWorkerRuntimeBlockEnd(text: string, end: number): number {
  let cursor = end;

  // createWorkerRuntimeUrlMapBootstrap contributes one trailing newline and the
  // insertion wrapper contributes another. Remove only those generated line
  // breaks so the user's original separator remains byte-for-byte stable.
  for (let lineBreak = 0; lineBreak < 2; lineBreak += 1) {
    if (text.startsWith('\r\n', cursor)) {
      cursor += 2;
    } else if (text[cursor] === '\n' || text[cursor] === '\r') {
      cursor += 1;
    } else {
      break;
    }
  }

  return cursor;
}

function withoutWorkerRuntimeUrlMapBootstrap(text: string): string {
  if (!text.includes(workerRuntimeUrlMapMarker)) {
    return text;
  }

  const comments: Comment[] = [];
  const program = parseJavaScript(text, comments);
  const insertionIndex = workerRuntimeInsertionIndex(text, program);
  let statementIndex = program.body.findIndex((statement) => statement.end > insertionIndex);

  if (statementIndex < 0) {
    return text;
  }

  let cursor = insertionIndex;
  let removalEnd: number | undefined;

  while (statementIndex < program.body.length) {
    const marker = comments.find(
      (comment) =>
        comment.start >= cursor &&
        isWhitespaceOnly(text, cursor, comment.start) &&
        isExactBlockComment(comment, workerRuntimeUrlMapMarkerComment),
    );
    const statement = program.body[statementIndex];

    if (
      !marker ||
      !statement ||
      marker.end > statement.start ||
      !isWhitespaceOnly(text, marker.end, statement.start) ||
      !isGeneratedWorkerRuntimeStatement(statement)
    ) {
      break;
    }

    const endMarker = comments.find(
      (comment) =>
        comment.start >= statement.end &&
        isWhitespaceOnly(text, statement.end, comment.start) &&
        isExactBlockComment(comment, workerRuntimeUrlMapEndMarkerComment),
    );
    let blockEnd: number;

    if (endMarker) {
      blockEnd = endMarker.end;
    } else if (
      text.slice(
        Math.max(statement.start, statement.end - legacyWorkerRuntimeUrlMapTerminator.length),
        statement.end,
      ) === legacyWorkerRuntimeUrlMapTerminator
    ) {
      blockEnd = statement.end;
    } else {
      break;
    }

    removalEnd = generatedWorkerRuntimeBlockEnd(text, blockEnd);
    cursor = removalEnd;
    statementIndex += 1;
  }

  return removalEnd === undefined
    ? text
    : `${text.slice(0, insertionIndex)}${text.slice(removalEnd)}`;
}

function normalizedRuntimeManifestReferenceKey(value: string | undefined): string | undefined {
  const name = value?.toLowerCase().replaceAll('-', '').replaceAll('_', '');

  return name && runtimeManifestReferenceKeys.has(name) ? name : undefined;
}

function normalizedRuntimeComposedAssetReferenceKey(value: string | undefined): string | undefined {
  const name = value?.toLowerCase().replaceAll('-', '').replaceAll('_', '');

  if (!name) {
    return undefined;
  }

  if (runtimeManifestReferenceKeys.has(name)) {
    return name;
  }

  return runtimeComposedAssetReferenceSuffixes.some(
    (suffix) => name === suffix || name.endsWith(suffix),
  )
    ? name
    : undefined;
}

function normalizedRuntimeManifestKey(node: AnyNode): string | undefined {
  if (node.type !== 'Property' || node.kind !== 'init' || node.computed || node.method) {
    return undefined;
  }

  return normalizedRuntimeManifestReferenceKey(staticPropertyName(node.key));
}

function runtimeManifestKeysUsedInRuntimeUrlExpressions(program: Program): ReadonlySet<string> {
  const composedKeys = new Set<string>();

  const collectMemberKeys = (expression: AnyNode): void => {
    walkAst(expression, (node) => {
      if (node.type !== 'MemberExpression') {
        return;
      }

      const key = normalizedRuntimeComposedAssetReferenceKey(staticPropertyName(node.property));

      if (key) {
        composedKeys.add(key);
      }
    });
  };

  walkAst(program, (node) => {
    if (
      (node.type === 'BinaryExpression' && node.operator === '+') ||
      node.type === 'ImportExpression' ||
      (node.type === 'TemplateLiteral' && node.expressions.length > 0)
    ) {
      collectMemberKeys(node);
      return;
    }

    if (
      node.type === 'NewExpression' &&
      isIdentifierNamed(node.callee, new Set(['URL', 'Worker', 'SharedWorker']))
    ) {
      collectMemberKeys(node);
      return;
    }

    if (
      node.type === 'CallExpression' &&
      isIdentifierNamed(node.callee, new Set(['fetch', 'importScripts']))
    ) {
      collectMemberKeys(node);
    }
  });

  return composedKeys;
}

function looksLikeAssetLoader(node: AnyNode): boolean {
  if (node.type === 'NewExpression' || node.type === 'CallExpression') {
    return true;
  }

  if (node.type === 'Identifier') {
    return /asset|loader|texture|model|audio|font|image|resource|file/iu.test(node.name);
  }

  if (node.type === 'MemberExpression') {
    const property = staticPropertyName(node.property);
    return (
      (property !== undefined &&
        /asset|loader|texture|model|audio|font|image|resource|file/iu.test(property)) ||
      looksLikeAssetLoader(node.object)
    );
  }

  return false;
}

function isStaticAssetLoaderArgument(
  parent: AnyNode | undefined,
  property: string | undefined,
): boolean {
  if (
    !parent ||
    property !== 'arguments' ||
    parent.type !== 'CallExpression' ||
    parent.arguments[0] === undefined
  ) {
    return false;
  }

  if (parent.callee.type === 'Identifier') {
    return false;
  }

  return (
    parent.callee.type === 'MemberExpression' &&
    staticAssetLoaderMethods.has(staticPropertyName(parent.callee.property) ?? '') &&
    looksLikeAssetLoader(parent.callee.object)
  );
}

function isStaticGetFetch(node: AnyNode): boolean {
  if (node.type !== 'CallExpression' || node.arguments.length < 2) {
    return true;
  }

  const init = node.arguments[1];

  if (!init || init.type !== 'ObjectExpression') {
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

    return staticString(property.value)?.value.toUpperCase() === 'GET';
  }

  return true;
}

function looksLikeEmbeddedCss(value: string): boolean {
  return (
    /(?:^|[{};])\s*@(font-face|import|supports|media|layer|keyframes)\b/iu.test(value) ||
    /\burl\s*\(/iu.test(value)
  );
}

function serializeRuntimeBootstrapData(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function workerRuntimeInsertionIndex(text: string, program: Program): number {
  let insertion = text.startsWith('#!') ? Math.max(0, text.indexOf('\n') + 1) : 0;

  for (const statement of program.body) {
    if (statement.type !== 'ExpressionStatement' || typeof statement.directive !== 'string') {
      break;
    }

    insertion = statement.end;
  }

  return insertion;
}

function createWorkerRuntimeUrlMapBootstrap(session: RewriteSession): string | undefined {
  const mappings = session.runtimeUrlMappings();
  const imageRenditionMappings = session.runtimeImageRenditionMappings();
  const pathMappings = session.runtimePathMappings();
  const suffixMappings = session.runtimeSuffixMappings();
  const volatileQueryMappings = session.runtimeVolatileQueryMappings();
  const localReferencePathMappings = [
    ...new Set(
      [...mappings, ...imageRenditionMappings, ...pathMappings, ...volatileQueryMappings].map(
        ([, localReference]) => new URL(localReference, 'https://webmirror.invalid').pathname,
      ),
    ),
  ]
    .sort()
    .map((localPath) => [localPath, localPath] as const);

  const serializedMappings = serializeRuntimeBootstrapData(mappings);
  const serializedImageRenditionMappings = serializeRuntimeBootstrapData(imageRenditionMappings);
  const serializedPathMappings = serializeRuntimeBootstrapData(pathMappings);
  const serializedSuffixMappings = serializeRuntimeBootstrapData(suffixMappings);
  const serializedVolatileQueryMappings = serializeRuntimeBootstrapData(volatileQueryMappings);
  const serializedLocalReferencePathMappings = serializeRuntimeBootstrapData(
    localReferencePathMappings,
  );
  const serializedSensitiveQueryNames = serializeRuntimeBootstrapData(sensitiveQueryNames);
  const serializedImageRenditionQueryParameterNames = serializeRuntimeBootstrapData(
    imageRenditionQueryParameterNames,
  );
  const serializedImageRenditionNeutralQueryParameterValues = serializeRuntimeBootstrapData(
    imageRenditionNeutralQueryParameterValues,
  );
  const serializedKnownTrackingDomainSuffixes = serializeRuntimeBootstrapData(
    knownTrackingDomainSuffixes,
  );
  const serializedKnownNonessentialTelemetryPathnames = serializeRuntimeBootstrapData(
    knownNonessentialTelemetryPathnames,
  );
  const serializedKnownNonessentialTelemetryPathPrefixes = serializeRuntimeBootstrapData(
    knownNonessentialTelemetryPathPrefixes,
  );
  const serializedKnownNonessentialTelemetryRoutes = serializeRuntimeBootstrapData(
    knownNonessentialTelemetryRoutes,
  );
  const serializedSourceOrigin = serializeRuntimeBootstrapData(session.runtimeMapSourceOrigin());
  const serializedSourceBaseUrl = serializeRuntimeBootstrapData(session.runtimeMapResourceUrl());
  const serializedTrackingNoopUrl = serializeRuntimeBootstrapData(
    `data:text/javascript;charset=utf-8,${encodeURIComponent(trackingNoopScript)}`,
  );

  return `${workerRuntimeUrlMapMarker}
(function(global){
if(!global){return;}
var urlMap=new Map(${serializedMappings});
var imageRenditionMap=new Map(${serializedImageRenditionMappings});
var pathAliasMap=new Map(${serializedPathMappings});
var pathSuffixMap=new Map(${serializedSuffixMappings});
var volatileQueryAliasMap=new Map(${serializedVolatileQueryMappings});
var localReferencePathMap=new Map(${serializedLocalReferencePathMappings});
var sensitiveQueryNames=new Set(${serializedSensitiveQueryNames});
var imageRenditionQueryNames=new Set(${serializedImageRenditionQueryParameterNames});
var imageRenditionNeutralQueryValues=${serializedImageRenditionNeutralQueryParameterValues};
var knownTrackingDomainSuffixes=${serializedKnownTrackingDomainSuffixes};
var knownNonessentialTelemetryPathnames=new Set(${serializedKnownNonessentialTelemetryPathnames});
var knownNonessentialTelemetryPathPrefixes=${serializedKnownNonessentialTelemetryPathPrefixes};
var knownNonessentialTelemetryRoutes=${serializedKnownNonessentialTelemetryRoutes};
var sourceOrigin=${serializedSourceOrigin};
var sourceBaseUrl=${serializedSourceBaseUrl};
var localOrigin=(global.location&&global.location.origin&&global.location.origin!=="null")?global.location.origin:sourceOrigin;
var nonessentialNoopUrl=new URL("/.webmirror/noop",localOrigin).href;
var runtimeNoopScriptUrl=new URL("/.webmirror/noop.js",localOrigin).href;
var trackingNoopUrl=${serializedTrackingNoopUrl};
function isKnownNonessentialUrl(value){
  try{
    var sourceBase=(global.location&&global.location.href)||sourceOrigin;
    var url=new URL(String(value),sourceBase);
    if(url.protocol!=="http:"&&url.protocol!=="https:"){return false;}
    var hostname=url.hostname.toLowerCase().replace(/\\.$/,"");
    var tracking=knownTrackingDomainSuffixes.some(function(domain){
      return hostname===domain||hostname.endsWith("."+domain);
    });
    var pathname=url.pathname.toLowerCase();
    var telemetryRoute=knownNonessentialTelemetryRoutes.some(function(route){
      return hostname===route[0]&&pathname===route[1];
    });
    var telemetryPath=knownNonessentialTelemetryPathPrefixes.some(function(prefix){
      return pathname.indexOf(prefix)===0;
    });
    return tracking||telemetryRoute||telemetryPath||knownNonessentialTelemetryPathnames.has(pathname);
  }catch(_error){
    return false;
  }
}
function imageRenditionKey(source){
  var normalized=new URL(source.href);
  var transformed=false;
  var retainedSearchParameters=new URLSearchParams();
  normalized.searchParams.forEach(function(value,name){
    var normalizedName=name.toLowerCase();
    var neutralValues=imageRenditionNeutralQueryValues[normalizedName];
    var neutralValue=Array.isArray(neutralValues)&&neutralValues.indexOf(String(value).trim().toLowerCase())!==-1;
    if(imageRenditionQueryNames.has(normalizedName)||neutralValue){
      transformed=true;
      return;
    }
    retainedSearchParameters.append(name,value);
  });
  if(transformed){normalized.search=retainedSearchParameters.toString();}
  return normalized.href;
}
function isSensitiveQueryName(name){
  var normalized=String(name).toLowerCase().replace(/[^a-z0-9]/g,"");
  return sensitiveQueryNames.has(normalized)||
    normalized.endsWith("token")||
    normalized.endsWith("secret")||
    normalized.endsWith("password")||
    normalized.endsWith("signature")||
    normalized.endsWith("credential");
}
function hasSensitiveQuery(source){
  var sensitive=false;
  source.searchParams.forEach(function(_value,name){
    if(isSensitiveQueryName(name)){sensitive=true;}
  });
  return sensitive;
}
function volatileQueryValueIdentity(value){
  var match=/^([A-Za-z][A-Za-z0-9_-]{0,63}[_-])?(\\d{11,})$/.exec(String(value).trim());
  return match?((match[1]||"")+"<timestamp>"):null;
}
function volatileQueryAliasKey(source){
  if(!source.search||hasSensitiveQuery(source)){return null;}
  var hasVolatileValue=false;
  var parameters=[];
  source.searchParams.forEach(function(value,name){
    var volatileValue=volatileQueryValueIdentity(value);
    if(volatileValue){hasVolatileValue=true;}
    parameters.push([name,volatileValue||value]);
  });
  parameters.sort(function(left,right){
    var nameComparison=left[0].localeCompare(right[0]);
    return nameComparison===0?left[1].localeCompare(right[1]):nameComparison;
  });
  return hasVolatileValue?JSON.stringify([source.origin,source.pathname,parameters]):null;
}
function mappedReference(source){
  var localReference=urlMap.get(source.href);
  if(!localReference){
    var renditionKey=imageRenditionKey(source);
    if(renditionKey){localReference=imageRenditionMap.get(renditionKey);}
  }
  if(!localReference){
    var volatileQueryKey=volatileQueryAliasKey(source);
    if(volatileQueryKey){localReference=volatileQueryAliasMap.get(volatileQueryKey);}
  }
  if(!localReference&&source.search===""&&source.origin===sourceOrigin){
    localReference=pathAliasMap.get(source.pathname);
  }
  return localReference||null;
}
function mappedSuffixReference(source){
  if(source.search){return null;}
  var segments=source.pathname.split("/").filter(Boolean);
  for(var index=0;index<segments.length;index+=1){
    var localReference=pathSuffixMap.get("/"+segments.slice(index).join("/"));
    if(localReference){return localReference;}
  }
  return null;
}
function mappedRoutePrefixedLocalReference(source){
  if(!global.location||source.origin!==global.location.origin){return null;}
  var locationPath=global.location.pathname||"";
  var routePath=locationPath.endsWith("/")?locationPath.slice(0,-1):locationPath;
  if(!routePath||routePath==="/"){return null;}
  var routePrefix=routePath+"/";
  if(source.pathname.indexOf(routePrefix)!==0){return null;}
  var rootPath=source.pathname.slice(routePath.length);
  if(!rootPath||rootPath[0]!=="/"){return null;}
  return mappedReference(new URL(rootPath+source.search,sourceOrigin));
}
function mappedEmbeddedLocalReference(source){
  if(!global.location||source.origin!==global.location.origin||source.search){return null;}
  var markers=["/_external/http/","/_external/https/"];
  for(var index=0;index<markers.length;index+=1){
    var markerIndex=source.pathname.lastIndexOf(markers[index]);
    if(markerIndex<0){continue;}
    var localPath=source.pathname.slice(markerIndex);
    var localReference=localReferencePathMap.get(localPath);
    if(localReference){return localReference;}
  }
  return null;
}
function mappedUrl(value,baseOverride){
  try{
    var sourceBase=baseOverride||sourceBaseUrl||(global.location&&global.location.href)||sourceOrigin;
    var source=new URL(String(value),sourceBase);
    if(source.protocol!=="http:"&&source.protocol!=="https:"){return null;}
    var fragment=source.hash;
    source.hash="";
    var localReference=mappedEmbeddedLocalReference(source)||mappedReference(source);
    if(!localReference&&global.location&&source.origin===global.location.origin){
      localReference=mappedReference(new URL(source.pathname+source.search,sourceOrigin));
      if(!localReference){localReference=mappedRoutePrefixedLocalReference(source);}
      if(!localReference){localReference=mappedSuffixReference(source);}
    }
    if(!localReference){return null;}
    var localBase=(global.location&&global.location.href)||sourceOrigin;
    var local=new URL(localReference,localBase);
    local.hash=fragment;
    return local.href;
  }catch(_error){
    return null;
  }
}
function isRemoteHttpUrl(value,baseOverride){
  try{
    var sourceBase=baseOverride||sourceBaseUrl||(global.location&&global.location.href)||sourceOrigin;
    var source=new URL(String(value),sourceBase);
    return (source.protocol==="http:"||source.protocol==="https:")&&source.origin!==localOrigin;
  }catch(_error){
    return false;
  }
}
function isHttpUrl(value,baseOverride){
  try{
    var sourceBase=baseOverride||sourceBaseUrl||(global.location&&global.location.href)||sourceOrigin;
    var source=new URL(String(value),sourceBase);
    return source.protocol==="http:"||source.protocol==="https:";
  }catch(_error){
    return false;
  }
}
global.__webmirrorMapModuleUrl=function(value,baseUrl){return mappedUrl(value,baseUrl)||value;};
  var nativeFetch=global.fetch;
  if(typeof nativeFetch==="function"){
  function offlineFetchResponse(){
    return nativeFetch.call(global,nonessentialNoopUrl,{method:"GET"});
  }
  global.fetch=function(input,init){
    var request=typeof global.Request==="function"&&input instanceof global.Request?input:null;
    var method=String((init&&init.method)||(request&&request.method)||"GET").toUpperCase();
    var requestUrl=request?request.url:input;
    if(isKnownNonessentialUrl(requestUrl)){
      return offlineFetchResponse();
    }
    if(method!=="GET"&&method!=="HEAD"&&isHttpUrl(requestUrl)){
      return offlineFetchResponse();
    }
    var localUrl=method==="GET"||method==="HEAD"?mappedUrl(requestUrl):null;
    if(!localUrl&&isRemoteHttpUrl(requestUrl)){
      return offlineFetchResponse();
    }
    if(!localUrl){return nativeFetch.apply(global,arguments);}
    if(request){
      try{input=new global.Request(localUrl,request);}catch(_error){input=localUrl;}
    }else{
      input=localUrl;
    }
    return nativeFetch.call(global,input,init);
  };
}
var xhrPrototype=global.XMLHttpRequest&&global.XMLHttpRequest.prototype;
if(xhrPrototype&&typeof xhrPrototype.open==="function"){
  var nativeXhrOpen=xhrPrototype.open;
  var nativeXhrSend=xhrPrototype.send;
  var offlineXhrs=typeof global.WeakSet==="function"?new global.WeakSet():null;
  var offlineXhrFlag="__webmirrorOfflineRequest";
  function setOfflineXhr(xhr,offline){
    if(offlineXhrs){
      if(offline){offlineXhrs.add(xhr);}else{offlineXhrs.delete(xhr);}
      return;
    }
    try{Object.defineProperty(xhr,offlineXhrFlag,{configurable:true,writable:true,value:offline});}
    catch(_error){try{xhr[offlineXhrFlag]=offline;}catch(_ignored){}}
  }
  function isOfflineXhr(xhr){
    return offlineXhrs?offlineXhrs.has(xhr):xhr&&xhr[offlineXhrFlag]===true;
  }
  xhrPrototype.open=function(method,url){
    var normalizedMethod=String(method).toUpperCase();
    var localUrl=(normalizedMethod==="GET"||normalizedMethod==="HEAD")?mappedUrl(url):null;
    var offline=isKnownNonessentialUrl(url)||
      ((normalizedMethod!=="GET"&&normalizedMethod!=="HEAD")&&isHttpUrl(url))||
      (!localUrl&&isRemoteHttpUrl(url));
    setOfflineXhr(this,offline);
    if(offline){
      var noopArgs=Array.prototype.slice.call(arguments);
      noopArgs[0]="GET";
      noopArgs[1]=nonessentialNoopUrl;
      return nativeXhrOpen.apply(this,noopArgs);
    }
    if(!localUrl){return nativeXhrOpen.apply(this,arguments);}
    var args=Array.prototype.slice.call(arguments);
    args[1]=localUrl;
    return nativeXhrOpen.apply(this,args);
  };
  if(typeof nativeXhrSend==="function"){
    xhrPrototype.send=function(){
      if(isOfflineXhr(this)){return nativeXhrSend.call(this);}
      return nativeXhrSend.apply(this,arguments);
    };
  }
}
var nativeImportScripts=global.importScripts;
if(typeof nativeImportScripts==="function"){
  global.importScripts=function(){
    var args=Array.prototype.slice.call(arguments).map(function(value){
      var localUrl=mappedUrl(value);
      if(isKnownNonessentialUrl(value)){return trackingNoopUrl;}
      if(localUrl){return localUrl;}
      return isRemoteHttpUrl(value)?runtimeNoopScriptUrl:value;
    });
    return nativeImportScripts.apply(global,args);
  };
}
function wrapWorkerConstructor(name){
  var NativeWorker=global[name];
  if(typeof NativeWorker!=="function"||typeof Proxy!=="function"){return;}
  try{
    global[name]=new Proxy(NativeWorker,{
      construct:function(target,args,newTarget){
        var nextArgs=Array.prototype.slice.call(args);
        var localUrl=nextArgs.length>0?mappedUrl(nextArgs[0]):null;
        if(localUrl){
          nextArgs[0]=localUrl;
        }else if(nextArgs.length>0&&isRemoteHttpUrl(nextArgs[0])){
          nextArgs[0]=runtimeNoopScriptUrl;
        }
        return Reflect.construct(target,nextArgs,newTarget);
      }
    });
  }catch(_error){}
}
wrapWorkerConstructor("Worker");
wrapWorkerConstructor("SharedWorker");
})(typeof self!=="undefined"?self:globalThis);
${workerRuntimeUrlMapEndMarker}
`;
}

export function rewriteJavaScriptTextWithSession(
  text: string,
  session: RewriteSession,
  workerContext = false,
): string {
  const sourceText = workerContext ? withoutWorkerRuntimeUrlMapBootstrap(text) : text;

  if (isStandaloneTrackingJavaScript(sourceText)) {
    return trackingNoopScript;
  }

  const program = parseJavaScript(sourceText);
  const output = new MagicString(sourceText);
  const handledRanges = new Set<string>();
  const staticAssets = discoverStaticJavaScriptAssets(
    program,
    session.runtimeMapSourceOrigin(),
    session.mappedResourceUrls(),
    session.runtimeMapResourceUrl(),
  );
  const staticWorkerDependencies = new Set(staticAssets.workerDependencies);
  const hasRuntimeModuleMappings = session.runtimeUrlMappings().length > 0;
  const runtimeManifestKeysComposedAtRuntime =
    runtimeManifestKeysUsedInRuntimeUrlExpressions(program);
  const urlConstructors = new Set(['URL']);
  const urlConsumers = new Set(['SharedWorker', 'Worker']);
  const urlCalls = new Set(['importScripts']);
  const fetchCalls = new Set(['fetch']);

  for (const dependency of staticAssets.dependencies) {
    session.rewriteStaticString(dependency, 'site-root-url');

    if (staticWorkerDependencies.has(dependency)) {
      session.markWorkerDependency(dependency);
    }
  }

  const replace = (
    candidate: StaticStringNode | undefined,
    knownUrl: boolean,
    style: LocalReferenceStyle = 'url',
    reportStaticDependency = true,
  ): void => {
    if (!candidate) {
      return;
    }

    const rangeKey = `${candidate.node.start}:${candidate.node.end}`;

    if (handledRanges.has(rangeKey)) {
      return;
    }

    handledRanges.add(rangeKey);
    const rewritten = knownUrl
      ? session.rewriteKnownUrl(candidate.value, style)
      : reportStaticDependency
        ? session.rewriteStaticString(candidate.value, style)
        : session.rewriteMappedStaticString(candidate.value, style);

    if (rewritten !== candidate.value) {
      output.overwrite(candidate.node.start, candidate.node.end, JSON.stringify(rewritten));
    }
  };
  const replaceFetch = (candidate: StaticStringNode | undefined): void => {
    if (!candidate) {
      return;
    }

    const rangeKey = `${candidate.node.start}:${candidate.node.end}`;

    if (handledRanges.has(rangeKey)) {
      return;
    }

    handledRanges.add(rangeKey);
    const rewritten = session.hasMappedUrl(candidate.value)
      ? session.rewriteMappedUrl(candidate.value, 'site-root-url')
      : session.rewriteStaticString(candidate.value, 'site-root-url');

    if (rewritten !== candidate.value) {
      output.overwrite(candidate.node.start, candidate.node.end, JSON.stringify(rewritten));
    }
  };
  const replaceGenericLiteral = (candidate: StaticStringNode | undefined): void => {
    if (!candidate || isImplicitRelativeReference(candidate.value)) {
      return;
    }

    const rangeKey = `${candidate.node.start}:${candidate.node.end}`;

    if (handledRanges.has(rangeKey)) {
      return;
    }

    handledRanges.add(rangeKey);
    const rewritten = session.rewriteMappedJavaScriptLiteral(candidate.value, 'site-root-url');

    if (rewritten !== candidate.value) {
      output.overwrite(candidate.node.start, candidate.node.end, JSON.stringify(rewritten));
    }
  };
  const replaceModuleSpecifier = (candidate: StaticStringNode | undefined): void => {
    if (!candidate || isBareModuleSpecifier(candidate.value)) {
      return;
    }

    replace(candidate, true, 'module-specifier');
  };
  const isRuntimeModuleMappingCall = (node: AnyNode): boolean =>
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'globalThis' &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === '__webmirrorMapModuleUrl';
  const replaceRuntimeModuleExpression = (node: AnyNode): void => {
    if (
      node.type !== 'ImportExpression' ||
      staticString(node.source) ||
      isRuntimeModuleMappingCall(node.source) ||
      !hasRuntimeModuleMappings
    ) {
      return;
    }

    output.appendLeft(node.source.start, 'globalThis.__webmirrorMapModuleUrl(');
    output.appendRight(node.source.end, `,${JSON.stringify(session.runtimeMapResourceUrl())})`);
  };
  const replaceRuntimeManifestValue = (node: AnyNode): void => {
    const runtimeManifestKey = normalizedRuntimeManifestKey(node);
    const runtimeComposedAssetKey =
      node.type === 'Property' && node.kind === 'init' && !node.computed && !node.method
        ? normalizedRuntimeComposedAssetReferenceKey(staticPropertyName(node.key))
        : undefined;

    if (node.type !== 'Property' || runtimeComposedAssetKey === undefined) {
      return;
    }

    const candidates: StaticStringNode[] = [];
    const direct = staticString(node.value);

    if (direct) {
      candidates.push(direct);
    } else if (node.value.type === 'ArrayExpression') {
      for (const element of node.value.elements) {
        if (isAstNode(element)) {
          const candidate = staticString(element);

          if (candidate) {
            candidates.push(candidate);
          }
        }
      }
    }

    if (runtimeManifestKeysComposedAtRuntime.has(runtimeComposedAssetKey)) {
      for (const candidate of candidates) {
        handledRanges.add(`${candidate.node.start}:${candidate.node.end}`);
      }

      return;
    }

    if (runtimeManifestKey === undefined) {
      return;
    }

    for (const candidate of candidates) {
      const rangeKey = `${candidate.node.start}:${candidate.node.end}`;

      if (handledRanges.has(rangeKey)) {
        continue;
      }

      handledRanges.add(rangeKey);
      const rewritten = session.rewriteRuntimeManifestString(candidate.value);

      if (rewritten !== candidate.value) {
        output.overwrite(candidate.node.start, candidate.node.end, JSON.stringify(rewritten));
      }
    }
  };
  const replaceEmbeddedCss = (candidate: StaticStringNode | undefined): boolean => {
    if (!candidate || !looksLikeEmbeddedCss(candidate.value)) {
      return false;
    }

    const rangeKey = `${candidate.node.start}:${candidate.node.end}`;

    if (handledRanges.has(rangeKey)) {
      return true;
    }

    let rewritten: string;

    try {
      rewritten = rewriteCssTextWithSession(candidate.value, session, 'site-root-url');
    } catch {
      return false;
    }

    handledRanges.add(rangeKey);

    if (rewritten !== candidate.value) {
      output.overwrite(candidate.node.start, candidate.node.end, JSON.stringify(rewritten));
    }

    return true;
  };
  walkAst(program, (node, parent, property) => {
    replaceRuntimeManifestValue(node);

    if (replaceEmbeddedCss(staticString(node))) {
      return;
    }

    if (
      node.type === 'NewExpression' &&
      isIdentifierNamed(node.callee, urlConstructors) &&
      isImportMetaUrl(node.arguments[1])
    ) {
      replace(staticString(node.arguments[0]), true);
    }

    if (node.type === 'NewExpression' && isIdentifierNamed(node.callee, urlConsumers)) {
      replace(staticString(node.arguments[0]), true, 'site-root-url');

      const workerArgument = node.arguments[0];

      if (!isAstNode(workerArgument)) {
        return;
      }

      const directWorkerReference = staticString(workerArgument);

      if (directWorkerReference) {
        session.markWorkerDependency(directWorkerReference.value);
        return;
      }

      if (
        workerArgument.type === 'NewExpression' &&
        isIdentifierNamed(workerArgument.callee, urlConstructors) &&
        isImportMetaUrl(workerArgument.arguments[1])
      ) {
        const importMetaWorkerReference = staticString(workerArgument.arguments[0]);

        if (importMetaWorkerReference) {
          session.markWorkerDependency(importMetaWorkerReference.value);
        }
      }
    }

    if (node.type === 'CallExpression' && isIdentifierNamed(node.callee, urlCalls)) {
      replace(staticString(node.arguments[0]), true);
    }

    if (
      node.type === 'CallExpression' &&
      isIdentifierNamed(node.callee, fetchCalls) &&
      isStaticGetFetch(node)
    ) {
      replaceFetch(staticString(node.arguments[0]));
    }

    if (node.type === 'ImportExpression') {
      replaceModuleSpecifier(staticString(node.source));
      replaceRuntimeModuleExpression(node);
    }

    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') {
      replaceModuleSpecifier(staticString(node.source));
    }

    if (node.type === 'ExportNamedDeclaration' && node.source) {
      replaceModuleSpecifier(staticString(node.source));
    }

    if (isStaticAssetLoaderArgument(parent, property)) {
      if (staticAssets.handledArgumentRanges.has(`${node.start}:${node.end}`)) {
        return;
      }

      // Loader APIs commonly accept a static path through an arbitrary function
      // or method call, so retain asset-shaped strings as discovery candidates.
      replace(staticString(node), false, 'site-root-url');
    } else if (!shouldSkipGenericStaticString(parent, property)) {
      // Implicit relative leaves frequently belong to manifests that a loader
      // composes with its own base URL. Preserve those leaves and let the exact
      // runtime URL map localize the final request.
      replaceGenericLiteral(staticString(node));
    }
  });

  if (workerContext) {
    const workerRuntimeBootstrap = createWorkerRuntimeUrlMapBootstrap(session);

    if (workerRuntimeBootstrap) {
      output.appendLeft(
        workerRuntimeInsertionIndex(sourceText, program),
        `\n${workerRuntimeBootstrap}\n`,
      );
    }
  }

  return output.toString();
}

export function rewriteJavaScript(input: RewriteTextInput): RewriteResult {
  const session = createRewriteSession(input);
  return session.result(
    rewriteJavaScriptTextWithSession(input.text, session, input.workerContext === true),
  );
}
