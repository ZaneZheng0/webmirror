import { html, parse, serialize } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';

import {
  isKnownNonessentialExternalUrl,
  isKnownTrackingUrl,
  knownNonessentialTelemetryPathPrefixes,
  knownNonessentialTelemetryRoutes,
  knownNonessentialTelemetryPathnames,
  knownTrackingDomainSuffixes,
  sensitiveQueryNames,
} from '@webmirror/shared';

import { rewriteCssDeclarationsWithSession, rewriteCssTextWithSession } from './rewrite-css.js';
import {
  isNonessentialEmbedBootstrapJavaScript,
  rewriteJavaScriptTextWithSession,
} from './rewrite-javascript.js';
import { rewriteJsonTextWithSession } from './rewrite-json.js';
import {
  imageRenditionNeutralQueryParameterValues,
  imageRenditionQueryParameterNames,
} from './resource-map.js';
import {
  createRewriteSession,
  type RewriteResult,
  type RewriteSession,
  type RewriteTextInput,
} from './rewriter-core.js';
import { externalEmbedNoopScript, trackingNoopScript } from './tracking.js';

const resourceUrlAttributeNames = new Set(['src', 'poster', 'data']);
const resourceHrefElementNames = new Set(['image', 'use']);
const resourceLinkRelations = new Set([
  'apple-touch-icon',
  'icon',
  'manifest',
  'mask-icon',
  'modulepreload',
  'preload',
  'stylesheet',
]);
const javaScriptMimeTypes = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
]);
const actionAttributeNames = new Set(['action', 'formaction']);
const runtimeUrlMapAttribute = 'data-webmirror-runtime';
const runtimeUrlMapAttributeValue = 'url-map-v1';
const inertImagePlaceholderUrl =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

interface SrcsetCandidate {
  url: string;
  descriptor: string;
}

interface TextRange {
  start: number;
  end: number;
}

function isHtmlSpace(character: string): boolean {
  return (
    character === '\u0009' ||
    character === '\u000a' ||
    character === '\u000c' ||
    character === '\u000d' ||
    character === '\u0020'
  );
}

function parseSrcset(value: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  let position = 0;

  while (position < value.length) {
    while (
      position < value.length &&
      (isHtmlSpace(value[position] ?? '') || value[position] === ',')
    ) {
      position += 1;
    }

    if (position >= value.length) {
      break;
    }

    const urlStart = position;

    while (position < value.length && !isHtmlSpace(value[position] ?? '')) {
      position += 1;
    }

    let url = value.slice(urlStart, position);
    let trailingCommaCount = 0;

    while (url.endsWith(',')) {
      url = url.slice(0, -1);
      trailingCommaCount += 1;
    }

    if (!url) {
      continue;
    }

    if (trailingCommaCount > 0) {
      candidates.push({ url, descriptor: '' });
      continue;
    }

    while (position < value.length && isHtmlSpace(value[position] ?? '')) {
      position += 1;
    }

    const descriptorStart = position;
    let parenthesisDepth = 0;

    while (position < value.length) {
      const character = value[position] ?? '';

      if (character === '(') {
        parenthesisDepth += 1;
      } else if (character === ')' && parenthesisDepth > 0) {
        parenthesisDepth -= 1;
      } else if (character === ',' && parenthesisDepth === 0) {
        break;
      }

      position += 1;
    }

    candidates.push({
      url,
      descriptor: value.slice(descriptorStart, position).trim(),
    });

    if (value[position] === ',') {
      position += 1;
    }
  }

  return candidates;
}

function rewriteSrcset(value: string, session: RewriteSession): string {
  const candidates = parseSrcset(value);
  const retained = candidates.filter(({ url }) => {
    const trimmed = url.trim().toLowerCase();
    return trimmed.startsWith('data:') || session.hasMappedUrl(url);
  });

  if (retained.some(({ url }) => session.hasMappedUrl(url))) {
    return retained
      .map(({ url, descriptor }) => {
        const rewrittenUrl = session.hasMappedUrl(url) ? session.rewriteMappedUrl(url) : url;
        return descriptor ? `${rewrittenUrl} ${descriptor}` : rewrittenUrl;
      })
      .join(', ');
  }

  const networkCandidates = candidates.filter(
    ({ url }) => !url.trim().toLowerCase().startsWith('data:'),
  );

  if (networkCandidates.length > 0) {
    const widthCandidates = networkCandidates
      .map((candidate) => ({
        candidate,
        width: /^(\d+)w$/u.exec(candidate.descriptor)?.[1],
      }))
      .filter(
        (
          value,
        ): value is {
          candidate: SrcsetCandidate;
          width: string;
        } => value.width !== undefined,
      )
      .map(({ candidate, width }) => ({
        candidate,
        width: Number.parseInt(width, 10),
      }))
      .filter(({ width }) => Number.isSafeInteger(width) && width > 0)
      .sort((left, right) => {
        const targetWidth = 1280;
        const distance = Math.abs(left.width - targetWidth) - Math.abs(right.width - targetWidth);
        return distance === 0 ? left.width - right.width : distance;
      });
    const densityCandidates = networkCandidates
      .map((candidate) => ({
        candidate,
        density: /^(\d+(?:\.\d+)?)x$/u.exec(candidate.descriptor)?.[1],
      }))
      .filter(
        (
          value,
        ): value is {
          candidate: SrcsetCandidate;
          density: string;
        } => value.density !== undefined,
      )
      .map(({ candidate, density }) => ({
        candidate,
        density: Number.parseFloat(density),
      }))
      .filter(({ density }) => Number.isFinite(density) && density > 0)
      .sort((left, right) => {
        const targetDensity = 1;
        const distance =
          Math.abs(left.density - targetDensity) - Math.abs(right.density - targetDensity);
        return distance === 0 ? left.density - right.density : distance;
      });
    const representative =
      widthCandidates[0]?.candidate ?? densityCandidates[0]?.candidate ?? networkCandidates[0];

    if (representative) {
      session.rewriteKnownUrl(representative.url);
    }
  }

  return retained
    .map(({ url, descriptor }) => (descriptor ? `${url} ${descriptor}` : url))
    .join(', ');
}

function findMetaRefreshUrl(content: string): TextRange | undefined {
  const separator = content.indexOf(';');

  if (separator === -1) {
    return undefined;
  }

  let position = separator + 1;

  while (isHtmlSpace(content[position] ?? '')) {
    position += 1;
  }

  if (content.slice(position, position + 3).toLowerCase() === 'url') {
    let equalsPosition = position + 3;

    while (isHtmlSpace(content[equalsPosition] ?? '')) {
      equalsPosition += 1;
    }

    if (content[equalsPosition] === '=') {
      position = equalsPosition + 1;

      while (isHtmlSpace(content[position] ?? '')) {
        position += 1;
      }
    }
  }

  const quote = content[position];

  if (quote === '"' || quote === "'") {
    const start = position + 1;
    const closingQuote = content.indexOf(quote, start);
    return {
      start,
      end: closingQuote === -1 ? content.length : closingQuote,
    };
  }

  let end = content.length;

  while (end > position && isHtmlSpace(content[end - 1] ?? '')) {
    end -= 1;
  }

  return end > position ? { start: position, end } : undefined;
}

function rewriteMetaRefresh(content: string, session: RewriteSession): string {
  const range = findMetaRefreshUrl(content);

  if (!range) {
    return content;
  }

  const reference = content.slice(range.start, range.end);
  const rewritten = session.rewriteMappedUrl(reference);

  if (rewritten === reference) {
    return content;
  }

  return `${content.slice(0, range.start)}${rewritten}${content.slice(range.end)}`;
}

function isElement(node: DefaultTreeAdapterTypes.Node): node is DefaultTreeAdapterTypes.Element {
  return 'tagName' in node;
}

function isTextNode(node: DefaultTreeAdapterTypes.Node): node is DefaultTreeAdapterTypes.TextNode {
  return node.nodeName === '#text';
}

function attribute(element: DefaultTreeAdapterTypes.Element, name: string) {
  return element.attrs.find((candidate) => candidate.name === name);
}

function isRuntimeUrlMapScript(element: DefaultTreeAdapterTypes.Element): boolean {
  return (
    element.tagName === 'script' &&
    attribute(element, runtimeUrlMapAttribute)?.value === runtimeUrlMapAttributeValue
  );
}

function removeAttribute(element: DefaultTreeAdapterTypes.Element, name: string): void {
  const index = element.attrs.findIndex((candidate) => candidate.name === name);

  if (index >= 0) {
    element.attrs.splice(index, 1);
  }
}

function isResourceLink(element: DefaultTreeAdapterTypes.Element): boolean {
  if (element.tagName !== 'link') {
    return false;
  }

  const relations = (attribute(element, 'rel')?.value ?? '')
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
  return relations.some((relation) => resourceLinkRelations.has(relation));
}

function isInertAboutBlankImage(
  element: DefaultTreeAdapterTypes.Element,
  currentAttribute: DefaultTreeAdapterTypes.Element['attrs'][number],
): boolean {
  return (
    element.tagName === 'img' &&
    currentAttribute.name === 'src' &&
    currentAttribute.value.trim().toLowerCase() === 'about:blank'
  );
}

function disableUnmappedAction(
  element: DefaultTreeAdapterTypes.Element,
  currentAttribute: DefaultTreeAdapterTypes.Element['attrs'][number],
  session: RewriteSession,
): void {
  const value = currentAttribute.value.trim();

  if (!value || value.startsWith('#')) {
    return;
  }

  if (session.hasMappedUrl(value)) {
    currentAttribute.value = session.rewriteMappedUrl(currentAttribute.value);
    return;
  }

  currentAttribute.value = '#';

  if (!attribute(element, 'data-webmirror-disabled-action')) {
    element.attrs.push({
      name: 'data-webmirror-disabled-action',
      value: 'online',
    });
  }
}

function markScriptDisabled(
  element: DefaultTreeAdapterTypes.Element,
  reason: 'tracking' | 'external-embed',
): void {
  if (!attribute(element, 'data-webmirror-disabled')) {
    element.attrs.push({
      name: 'data-webmirror-disabled',
      value: reason,
    });
  }
}

function replaceScriptWithNoop(element: DefaultTreeAdapterTypes.Element, source: string): void {
  const textNodes = element.childNodes.filter(isTextNode);
  const firstTextNode = textNodes[0];

  if (firstTextNode) {
    firstTextNode.value = source;

    for (const textNode of textNodes.slice(1)) {
      textNode.value = '';
    }

    return;
  }

  element.childNodes.push({
    nodeName: '#text',
    value: source,
    parentNode: element,
  });
}

function disableTrackingScript(
  element: DefaultTreeAdapterTypes.Element,
  resourceUrl: string,
): boolean {
  if (element.tagName !== 'script') {
    return false;
  }

  const sourceAttribute = attribute(element, 'src');

  if (sourceAttribute && isKnownTrackingUrl(sourceAttribute.value, resourceUrl)) {
    const sourceIndex = element.attrs.indexOf(sourceAttribute);

    if (sourceIndex >= 0) {
      element.attrs.splice(sourceIndex, 1);
    }

    replaceScriptWithNoop(element, trackingNoopScript);
    markScriptDisabled(element, 'tracking');
    return true;
  }

  if (sourceAttribute && isKnownNonessentialExternalUrl(sourceAttribute.value, resourceUrl)) {
    const sourceIndex = element.attrs.indexOf(sourceAttribute);

    if (sourceIndex >= 0) {
      element.attrs.splice(sourceIndex, 1);
    }

    replaceScriptWithNoop(element, externalEmbedNoopScript);
    markScriptDisabled(element, 'external-embed');
    return true;
  }

  const textNodes = element.childNodes.filter(isTextNode);
  const source = textNodes.map((node) => node.value).join('');
  const trackingSnippet =
    source.length <= 10_000 &&
    (/\bGoogleAnalyticsObject\b/u.test(source) ||
      /google-analytics\.com\/analytics\.js/iu.test(source) ||
      /googletagmanager\.com\/gtag\/js/iu.test(source));

  if (!trackingSnippet) {
    const externalEmbedBootstrap =
      source.length <= 10_000 && isNonessentialEmbedBootstrapJavaScript(source);

    if (!externalEmbedBootstrap) {
      return false;
    }

    replaceScriptWithNoop(element, externalEmbedNoopScript);
    markScriptDisabled(element, 'external-embed');
    return true;
  }

  replaceScriptWithNoop(element, trackingNoopScript);
  markScriptDisabled(element, 'tracking');
  return true;
}

function rewriteElementAttributes(
  element: DefaultTreeAdapterTypes.Element,
  session: RewriteSession,
): void {
  for (const currentAttribute of element.attrs) {
    if (isInertAboutBlankImage(element, currentAttribute)) {
      currentAttribute.value = inertImagePlaceholderUrl;
    } else if (resourceUrlAttributeNames.has(currentAttribute.name)) {
      currentAttribute.value = session.rewriteKnownUrl(currentAttribute.value);
    } else if (currentAttribute.name === 'href') {
      if (element.tagName === 'base') {
        currentAttribute.value = '';
      } else {
        currentAttribute.value =
          resourceHrefElementNames.has(element.tagName) || isResourceLink(element)
            ? session.rewriteKnownUrl(currentAttribute.value)
            : session.rewriteMappedUrl(currentAttribute.value);
      }
    } else if (currentAttribute.name === 'srcset') {
      currentAttribute.value = rewriteSrcset(currentAttribute.value, session);
    } else if (currentAttribute.name.startsWith('data-')) {
      // Creative runtimes commonly keep GLTF, HDR, Lottie, texture, and audio
      // URLs in custom data attributes before handing them to a loader. Rewrite
      // only values that resolve to an already downloaded asset; ordinary
      // application data remains byte-for-byte unchanged.
      currentAttribute.value = session.rewriteMappedDataAttribute(
        currentAttribute.value,
        'site-root-url',
      );
    } else if (actionAttributeNames.has(currentAttribute.name)) {
      disableUnmappedAction(element, currentAttribute, session);
    } else if (currentAttribute.name === 'style') {
      currentAttribute.value = rewriteCssDeclarationsWithSession(
        currentAttribute.value,
        session,
        'site-root-url',
      );
    }
  }

  if (element.tagName === 'script' || element.tagName === 'link') {
    removeAttribute(element, 'integrity');
  }

  if (
    element.tagName === 'meta' &&
    attribute(element, 'http-equiv')?.value.trim().toLowerCase() === 'refresh'
  ) {
    const contentAttribute = attribute(element, 'content');

    if (contentAttribute) {
      contentAttribute.value = rewriteMetaRefresh(contentAttribute.value, session);
    }
  }
}

function replaceTextNodes(element: DefaultTreeAdapterTypes.Element, rewritten: string): void {
  const textNodes = element.childNodes.filter(isTextNode);
  const firstTextNode = textNodes[0];

  if (firstTextNode) {
    firstTextNode.value = rewritten;

    for (const textNode of textNodes.slice(1)) {
      textNode.value = '';
    }

    return;
  }

  element.childNodes.push({
    nodeName: '#text',
    value: rewritten,
    parentNode: element,
  });
}

function rewriteStyleElement(
  element: DefaultTreeAdapterTypes.Element,
  session: RewriteSession,
): void {
  const textNodes = element.childNodes.filter(isTextNode);

  if (textNodes.length === 0) {
    return;
  }

  const rewritten = rewriteCssTextWithSession(
    textNodes.map((node) => node.value).join(''),
    session,
    'site-root-url',
  );
  const firstTextNode = textNodes[0];

  if (!firstTextNode) {
    return;
  }

  firstTextNode.value = rewritten;

  for (const textNode of textNodes.slice(1)) {
    textNode.value = '';
  }
}

function rewriteInlineScript(
  element: DefaultTreeAdapterTypes.Element,
  session: RewriteSession,
): void {
  if (attribute(element, 'src') || isRuntimeUrlMapScript(element)) {
    return;
  }

  const source = element.childNodes
    .filter(isTextNode)
    .map((node) => node.value)
    .join('');

  if (!source.trim()) {
    return;
  }

  const type = (attribute(element, 'type')?.value ?? '').trim().toLowerCase();

  if (type === 'importmap') {
    replaceTextNodes(element, rewriteJsonTextWithSession(source, session));
    return;
  }

  if (!type || type === 'module' || javaScriptMimeTypes.has(type)) {
    replaceTextNodes(element, rewriteJavaScriptTextWithSession(source, session));
  }
}

function findElement(
  node: DefaultTreeAdapterTypes.Node,
  predicate: (element: DefaultTreeAdapterTypes.Element) => boolean,
): DefaultTreeAdapterTypes.Element | undefined {
  if (isElement(node) && predicate(node)) {
    return node;
  }

  if ('childNodes' in node) {
    for (const child of node.childNodes) {
      const match = findElement(child, predicate);

      if (match) {
        return match;
      }
    }
  }

  if (isElement(node) && node.tagName === 'template' && 'content' in node) {
    return findElement(node.content, predicate);
  }

  return undefined;
}

function serializeInlineScriptData(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function createRuntimeUrlMapBootstrap(session: RewriteSession): string | undefined {
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

  const serializedMappings = serializeInlineScriptData(mappings);
  const serializedImageRenditionMappings = serializeInlineScriptData(imageRenditionMappings);
  const serializedPathMappings = serializeInlineScriptData(pathMappings);
  const serializedSuffixMappings = serializeInlineScriptData(suffixMappings);
  const serializedVolatileQueryMappings = serializeInlineScriptData(volatileQueryMappings);
  const serializedLocalReferencePathMappings = serializeInlineScriptData(
    localReferencePathMappings,
  );
  const serializedSensitiveQueryNames = serializeInlineScriptData(sensitiveQueryNames);
  const serializedImageRenditionQueryParameterNames = serializeInlineScriptData(
    imageRenditionQueryParameterNames,
  );
  const serializedImageRenditionNeutralQueryParameterValues = serializeInlineScriptData(
    imageRenditionNeutralQueryParameterValues,
  );
  const serializedKnownTrackingDomainSuffixes = serializeInlineScriptData(
    knownTrackingDomainSuffixes,
  );
  const serializedKnownNonessentialTelemetryPathnames = serializeInlineScriptData(
    knownNonessentialTelemetryPathnames,
  );
  const serializedKnownNonessentialTelemetryPathPrefixes = serializeInlineScriptData(
    knownNonessentialTelemetryPathPrefixes,
  );
  const serializedKnownNonessentialTelemetryRoutes = serializeInlineScriptData(
    knownNonessentialTelemetryRoutes,
  );
  const serializedSourceOrigin = serializeInlineScriptData(session.runtimeMapSourceOrigin());
  const serializedInertImagePlaceholderUrl = serializeInlineScriptData(inertImagePlaceholderUrl);
  const serializedTrackingNoopUrl = serializeInlineScriptData(
    `data:text/javascript;charset=utf-8,${encodeURIComponent(trackingNoopScript)}`,
  );

  return `(function(){
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
var inertImagePlaceholderUrl=${serializedInertImagePlaceholderUrl};
var nonessentialNoopUrl=new URL("/.webmirror/noop",location.origin).href;
var runtimeNoopScriptUrl=new URL("/.webmirror/noop.js",location.origin).href;
var runtimeNoopStyleUrl=new URL("/.webmirror/noop.css",location.origin).href;
var runtimeUnavailableScriptUrl=new URL("/.webmirror/unavailable.js",location.origin).href;
var trackingNoopUrl=${serializedTrackingNoopUrl};
function sourceCompatibleUrl(value,baseOverride){
  var text=String(value);
  var sourceBase=baseOverride||document.baseURI;
  if(text.trim().indexOf("//")===0){sourceBase=sourceOrigin;}
  return new URL(text,sourceBase);
}
function isKnownNonessentialUrl(value){
  try{
    var url=sourceCompatibleUrl(value);
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
  if(!localReference&&source.search===""&&(source.origin===location.origin||source.origin===sourceOrigin)){
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
  if(source.origin!==location.origin){return null;}
  var locationPath=location.pathname||"";
  var routePath=locationPath.endsWith("/")?locationPath.slice(0,-1):locationPath;
  if(!routePath||routePath==="/"){return null;}
  var routePrefix=routePath+"/";
  if(source.pathname.indexOf(routePrefix)!==0){return null;}
  var rootPath=source.pathname.slice(routePath.length);
  if(!rootPath||rootPath[0]!=="/"){return null;}
  return mappedReference(new URL(rootPath+source.search,sourceOrigin));
}
function mappedEmbeddedLocalReference(source){
  if(source.origin!==location.origin||source.search){return null;}
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
    var source=sourceCompatibleUrl(value,baseOverride);
    if(source.protocol!=="http:"&&source.protocol!=="https:"){return null;}
    var fragment=source.hash;
    source.hash="";
    var localReference=mappedEmbeddedLocalReference(source)||mappedReference(source);
    if(!localReference&&source.origin===location.origin){
      localReference=mappedReference(new URL(source.pathname+source.search,sourceOrigin));
      if(!localReference){localReference=mappedRoutePrefixedLocalReference(source);}
      if(!localReference){localReference=mappedSuffixReference(source);}
    }
    if(!localReference){return null;}
    var local=new URL(localReference,document.baseURI);
    local.hash=fragment;
    return local.href;
  }catch(_error){
    return null;
  }
}
function isRemoteHttpUrl(value,baseOverride){
  try{
    var source=sourceCompatibleUrl(value,baseOverride);
    return (source.protocol==="http:"||source.protocol==="https:")&&source.origin!==location.origin;
  }catch(_error){
    return false;
  }
}
function isHttpUrl(value,baseOverride){
  try{
    var source=sourceCompatibleUrl(value,baseOverride);
    return source.protocol==="http:"||source.protocol==="https:";
  }catch(_error){
    return false;
  }
}
window.__webmirrorMapModuleUrl=function(value,baseUrl){return mappedUrl(value,baseUrl)||value;};
function parseSrcset(value){
  var candidates=[];
  var position=0;
  function isSpace(character){
    return character==="\\u0009"||character==="\\u000a"||character==="\\u000c"||character==="\\u000d"||character==="\\u0020";
  }
  while(position<value.length){
    while(position<value.length&&(isSpace(value[position])||value[position]===",")){position+=1;}
    if(position>=value.length){break;}
    var urlStart=position;
    while(position<value.length&&!isSpace(value[position])){position+=1;}
    var url=value.slice(urlStart,position);
    var trailingComma=false;
    while(url.endsWith(",")){url=url.slice(0,-1);trailingComma=true;}
    if(!url){continue;}
    if(trailingComma){candidates.push([url,""]);continue;}
    while(position<value.length&&isSpace(value[position])){position+=1;}
    var descriptorStart=position;
    var parenthesisDepth=0;
    while(position<value.length){
      var character=value[position];
      if(character==="("){parenthesisDepth+=1;}
      else if(character===")"&&parenthesisDepth>0){parenthesisDepth-=1;}
      else if(character===","&&parenthesisDepth===0){break;}
      position+=1;
    }
    candidates.push([url,value.slice(descriptorStart,position).trim()]);
    if(value[position]===","){position+=1;}
  }
  return candidates;
}
function mappedSrcset(value){
  return parseSrcset(String(value)).map(function(candidate){
    var url=candidate[0];
    var descriptor=candidate[1];
    if(url.trim().toLowerCase().startsWith("data:")){
      return descriptor?url+" "+descriptor:url;
    }
    var localUrl=mappedUrl(url);
    if(!localUrl){return null;}
    return descriptor?localUrl+" "+descriptor:localUrl;
  }).filter(Boolean).join(", ");
}
function isCssWhitespace(character){
  var code=character.charCodeAt(0);
  return code===9||code===10||code===12||code===13||code===32;
}
function isCssIdentifierCharacter(character){
  if(!character){return false;}
  var code=character.charCodeAt(0);
  return (
    (code>=48&&code<=57)||
    (code>=65&&code<=90)||
    (code>=97&&code<=122)||
    character==="_"||
    character==="-"
  );
}
function mapCssText(value){
  if(typeof value!=="string"||value.toLowerCase().indexOf("url")<0){return value;}
  var output="";
  var position=0;
  while(position<value.length){
    var character=value[position];
    if(character==="/"&&value[position+1]==="*"){
      var commentEnd=value.indexOf("*/",position+2);
      if(commentEnd<0){return value;}
      output+=value.slice(position,commentEnd+2);
      position=commentEnd+2;
      continue;
    }
    if(character==="'"||character==='"'){
      var quote=character;
      var quotedEnd=position+1;
      while(quotedEnd<value.length){
        if(value.charCodeAt(quotedEnd)===92){quotedEnd+=2;continue;}
        if(value[quotedEnd]===quote){quotedEnd+=1;break;}
        quotedEnd+=1;
      }
      output+=value.slice(position,quotedEnd);
      position=quotedEnd;
      continue;
    }
    if(
      value.slice(position,position+3).toLowerCase()!=="url"||
      isCssIdentifierCharacter(value[position-1])||
      isCssIdentifierCharacter(value[position+3])
    ){
      output+=character;
      position+=1;
      continue;
    }
    var openParenthesis=position+3;
    while(openParenthesis<value.length&&isCssWhitespace(value[openParenthesis])){openParenthesis+=1;}
    if(value[openParenthesis]!=="("){
      output+=character;
      position+=1;
      continue;
    }
    var argumentStart=openParenthesis+1;
    while(argumentStart<value.length&&isCssWhitespace(value[argumentStart])){argumentStart+=1;}
    var valueStart=argumentStart;
    var valueEnd=argumentStart;
    var closeParenthesis=-1;
    var urlQuote=value[argumentStart];
    if(urlQuote==="'"||urlQuote==='"'){
      valueStart=argumentStart+1;
      valueEnd=valueStart;
      while(valueEnd<value.length){
        if(value.charCodeAt(valueEnd)===92){valueEnd+=2;continue;}
        if(value[valueEnd]===urlQuote){break;}
        valueEnd+=1;
      }
      if(value[valueEnd]!==urlQuote){
        output+=character;
        position+=1;
        continue;
      }
      closeParenthesis=valueEnd+1;
      while(closeParenthesis<value.length&&isCssWhitespace(value[closeParenthesis])){closeParenthesis+=1;}
    }else{
      closeParenthesis=argumentStart;
      while(closeParenthesis<value.length&&value[closeParenthesis]!==")"){
        if(value.charCodeAt(closeParenthesis)===92){closeParenthesis+=2;continue;}
        closeParenthesis+=1;
      }
      var rawRegion=value.slice(argumentStart,closeParenthesis);
      var leadingWhitespace=rawRegion.length-rawRegion.trimStart().length;
      var trailingWhitespace=rawRegion.length-rawRegion.trimEnd().length;
      valueStart=argumentStart+leadingWhitespace;
      valueEnd=closeParenthesis-trailingWhitespace;
    }
    if(value[closeParenthesis]!==")"){
      output+=character;
      position+=1;
      continue;
    }
    var localUrl=mappedUrl(value.slice(valueStart,valueEnd));
    var offlineUrl=!localUrl&&isRemoteHttpUrl(value.slice(valueStart,valueEnd))?nonessentialNoopUrl:null;
    output+=value.slice(position,valueStart);
    output+=localUrl||offlineUrl||value.slice(valueStart,valueEnd);
    output+=value.slice(valueEnd,closeParenthesis+1);
    position=closeParenthesis+1;
  }
  return output;
}
function wrapCssTextMethod(prototype,name,valueIndex){
  if(!prototype||typeof prototype[name]!=="function"){return;}
  var nativeMethod=prototype[name];
  try{
    prototype[name]=function(){
      var args=Array.prototype.slice.call(arguments);
      if(args.length>valueIndex){args[valueIndex]=mapCssText(args[valueIndex]);}
      return nativeMethod.apply(this,args);
    };
  }catch(_error){}
}
var localizedCssStyleDeclarations=typeof WeakSet==="function"?new WeakSet():null;
var cssUrlPropertyNames=[
  "background",
  "backgroundImage",
  "borderImage",
  "borderImageSource",
  "clipPath",
  "content",
  "cursor",
  "filter",
  "listStyle",
  "listStyleImage",
  "mask",
  "maskBorder",
  "maskBorderSource",
  "maskImage",
  "shapeOutside",
  "webkitMask",
  "webkitMaskBoxImage",
  "webkitMaskBoxImageSource",
  "webkitMaskImage"
];
function cssPropertyName(name){
  if(name.slice(0,6)==="webkit"){
    return "-webkit-"+name.slice(6).replace(/[A-Z]/g,function(character){return "-"+character.toLowerCase();});
  }
  return name.replace(/[A-Z]/g,function(character){return "-"+character.toLowerCase();});
}
function cssStyleDescriptor(declaration,name){
  var current=declaration;
  while(current&&current!==Object.prototype){
    var descriptor=Object.getOwnPropertyDescriptor(current,name);
    if(descriptor){return descriptor;}
    current=Object.getPrototypeOf(current);
  }
  return null;
}
function wrapCssUrlPropertySetter(declaration,name){
  var descriptor=cssStyleDescriptor(declaration,name);
  if(!descriptor){return;}
  try{
    if(Object.prototype.hasOwnProperty.call(descriptor,"value")){
      if(typeof descriptor.value!=="string"||!descriptor.configurable){return;}
      var propertyName=cssPropertyName(name);
      Object.defineProperty(declaration,name,{
        configurable:descriptor.configurable,
        enumerable:descriptor.enumerable,
        get:function(){return this.getPropertyValue(propertyName);},
        set:function(value){return this.setProperty(propertyName,mapCssText(value));}
      });
      return;
    }
    if(typeof descriptor.set!=="function"){return;}
    Object.defineProperty(declaration,name,{
      configurable:descriptor.configurable,
      enumerable:descriptor.enumerable,
      get:descriptor.get,
      set:function(value){return descriptor.set.call(this,mapCssText(value));}
    });
  }catch(_error){}
}
function localizeCssStyleDeclaration(declaration){
  if(!declaration){return declaration;}
  if(localizedCssStyleDeclarations){
    if(localizedCssStyleDeclarations.has(declaration)){return declaration;}
    localizedCssStyleDeclarations.add(declaration);
  }
  cssUrlPropertyNames.forEach(function(name){wrapCssUrlPropertySetter(declaration,name);});
  wrapCssUrlPropertySetter(declaration,"cssText");
  return declaration;
}
function wrapStyleGetter(prototype){
  if(!prototype){return;}
  var descriptor=Object.getOwnPropertyDescriptor(prototype,"style");
  if(!descriptor||typeof descriptor.get!=="function"){return;}
  try{
    Object.defineProperty(prototype,"style",{
      configurable:descriptor.configurable,
      enumerable:descriptor.enumerable,
      get:function(){return localizeCssStyleDeclaration(descriptor.get.call(this));}
    });
  }catch(_error){}
}
var cssStyleSheetPrototype=window.CSSStyleSheet&&window.CSSStyleSheet.prototype;
wrapCssTextMethod(cssStyleSheetPrototype,"replace",0);
wrapCssTextMethod(cssStyleSheetPrototype,"replaceSync",0);
wrapCssTextMethod(cssStyleSheetPrototype,"insertRule",0);
wrapCssTextMethod(window.CSSGroupingRule&&window.CSSGroupingRule.prototype,"insertRule",0);
var cssStyleDeclarationPrototype=window.CSSStyleDeclaration&&window.CSSStyleDeclaration.prototype;
wrapCssTextMethod(cssStyleDeclarationPrototype,"setProperty",1);
wrapStyleGetter(window.HTMLElement&&window.HTMLElement.prototype);
wrapStyleGetter(window.SVGElement&&window.SVGElement.prototype);
wrapStyleGetter(window.CSSStyleRule&&window.CSSStyleRule.prototype);
wrapStyleGetter(window.CSSFontFaceRule&&window.CSSFontFaceRule.prototype);
wrapStyleGetter(window.CSSKeyframeRule&&window.CSSKeyframeRule.prototype);
wrapStyleGetter(window.CSSPageRule&&window.CSSPageRule.prototype);
  var nativeFetch=window.fetch;
  if(typeof nativeFetch==="function"){
  function offlineFetchResponse(){
    return nativeFetch.call(window,nonessentialNoopUrl,{method:"GET"});
  }
  window.fetch=function(input,init){
    var request=typeof Request==="function"&&input instanceof Request?input:null;
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
    if(!localUrl){return nativeFetch.apply(window,arguments);}
    if(request){
      try{input=new Request(localUrl,request);}catch(_error){input=localUrl;}
    }else{
      input=localUrl;
    }
    return nativeFetch.call(window,input,init);
  };
}
var xhrPrototype=window.XMLHttpRequest&&window.XMLHttpRequest.prototype;
if(xhrPrototype&&typeof xhrPrototype.open==="function"){
  var nativeXhrOpen=xhrPrototype.open;
  var nativeXhrSend=xhrPrototype.send;
  var offlineXhrs=typeof WeakSet==="function"?new WeakSet():null;
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
    var localUrl=normalizedMethod==="GET"||normalizedMethod==="HEAD"?mappedUrl(url):null;
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
function wrapWorkerConstructor(name){
  var NativeWorker=window[name];
  if(typeof NativeWorker!=="function"||typeof Proxy!=="function"){return;}
  try{
    window[name]=new Proxy(NativeWorker,{
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
function wrapWebSocket(){
  if(typeof window.WebSocket!=="function"){return;}
  function OfflineWebSocket(url){
    this.url=String(url);
    this.readyState=3;
    this.bufferedAmount=0;
    this.extensions="";
    this.protocol="";
    this.binaryType="blob";
  }
  OfflineWebSocket.prototype.close=function(){};
  OfflineWebSocket.prototype.send=function(){};
  OfflineWebSocket.prototype.addEventListener=function(){};
  OfflineWebSocket.prototype.removeEventListener=function(){};
  OfflineWebSocket.prototype.dispatchEvent=function(){return false;};
  OfflineWebSocket.CONNECTING=0;
  OfflineWebSocket.OPEN=1;
  OfflineWebSocket.CLOSING=2;
  OfflineWebSocket.CLOSED=3;
  try{window.WebSocket=OfflineWebSocket;}catch(_error){}
}
function wrapEventSource(){
  if(typeof window.EventSource!=="function"){return;}
  function OfflineEventSource(url){
    this.url=String(url);
    this.readyState=2;
    this.withCredentials=false;
  }
  OfflineEventSource.prototype.close=function(){};
  OfflineEventSource.prototype.addEventListener=function(){};
  OfflineEventSource.prototype.removeEventListener=function(){};
  OfflineEventSource.prototype.dispatchEvent=function(){return false;};
  OfflineEventSource.CONNECTING=0;
  OfflineEventSource.OPEN=1;
  OfflineEventSource.CLOSED=2;
  try{window.EventSource=OfflineEventSource;}catch(_error){}
}
wrapWebSocket();
wrapEventSource();
var nativeSendBeacon=window.navigator&&window.navigator.sendBeacon;
if(typeof nativeSendBeacon==="function"){
  try{
    window.navigator.sendBeacon=function(_url,_data){return true;};
  }catch(_error){}
}
function offlineElementUrl(element,name,value,localUrl){
  var tagName=String((element&&element.localName)||(element&&element.nodeName)||"").toLowerCase();
  if(!isKnownNonessentialUrl(value)){return null;}
  if(tagName==="script"&&name==="src"){return runtimeUnavailableScriptUrl;}
  if(tagName==="img"&&name==="src"){
    return inertImagePlaceholderUrl;
  }
  return nonessentialNoopUrl;
}
function wrapUrlProperty(prototype,name){
  if(!prototype){return;}
  var descriptor=Object.getOwnPropertyDescriptor(prototype,name);
  if(!descriptor||typeof descriptor.set!=="function"){return;}
  try{
    Object.defineProperty(prototype,name,{
      configurable:descriptor.configurable,
      enumerable:descriptor.enumerable,
      get:descriptor.get,
      set:function(value){
        var localUrl=mappedUrl(value);
        var offlineUrl=offlineElementUrl(this,name,value,localUrl);
        if(offlineUrl){return descriptor.set.call(this,offlineUrl);}
        if(prototype===window.HTMLImageElement.prototype&&name==="src"&&String(value).trim().toLowerCase()==="about:blank"){
          return descriptor.set.call(this,inertImagePlaceholderUrl);
        }
        if(!localUrl&&isRemoteHttpUrl(value)){
          if(String((this&&this.localName)||(this&&this.nodeName)||"").toLowerCase()==="script"&&name==="src"){
            return descriptor.set.call(this,runtimeUnavailableScriptUrl);
          }
          if(String((this&&this.localName)||(this&&this.nodeName)||"").toLowerCase()==="img"&&name==="src"){
            return descriptor.set.call(this,inertImagePlaceholderUrl);
          }
          if(
            String((this&&this.localName)||(this&&this.nodeName)||"").toLowerCase()==="link"&&
            name==="href"&&
            String(this.rel||"").toLowerCase().split(/\\s+/).indexOf("stylesheet")!==-1
          ){
            return descriptor.set.call(this,runtimeNoopStyleUrl);
          }
          return descriptor.set.call(this,nonessentialNoopUrl);
        }
        return descriptor.set.call(this,localUrl||value);
      }
    });
  }catch(_error){}
}
function wrapSrcsetProperty(prototype,name){
  if(!prototype){return;}
  var descriptor=Object.getOwnPropertyDescriptor(prototype,name);
  if(!descriptor||typeof descriptor.set!=="function"){return;}
  try{
    Object.defineProperty(prototype,name,{
      configurable:descriptor.configurable,
      enumerable:descriptor.enumerable,
      get:descriptor.get,
      set:function(value){return descriptor.set.call(this,mappedSrcset(value));}
    });
  }catch(_error){}
}
function wrapUrlAttributes(prototype,urlNames,srcsetNames){
  if(!prototype||typeof prototype.setAttribute!=="function"){return;}
  var nativeSetAttribute=prototype.setAttribute;
  try{
    prototype.setAttribute=function(name,value){
      var normalizedName=String(name).toLowerCase();
      if(urlNames.indexOf(normalizedName)!==-1){
        var localUrl=mappedUrl(value);
        var offlineUrl=offlineElementUrl(this,normalizedName,value,localUrl);
        if(offlineUrl){
          value=offlineUrl;
        }else if(
          prototype===window.HTMLImageElement.prototype&&
          normalizedName==="src"&&
          String(value).trim().toLowerCase()==="about:blank"
        ){
          value=inertImagePlaceholderUrl;
        }else{
          if(localUrl){
            value=localUrl;
          }else if(isRemoteHttpUrl(value)){
            var tagName=String((this&&this.localName)||(this&&this.nodeName)||"").toLowerCase();
            if(tagName==="script"&&normalizedName==="src"){
              value=runtimeUnavailableScriptUrl;
            }else if(tagName==="img"&&normalizedName==="src"){
              value=inertImagePlaceholderUrl;
            }else if(
              tagName==="link"&&
              normalizedName==="href"&&
              String(this.rel||"").toLowerCase().split(/\\s+/).indexOf("stylesheet")!==-1
            ){
              value=runtimeNoopStyleUrl;
            }else{
              value=nonessentialNoopUrl;
            }
          }
        }
      }else if(srcsetNames.indexOf(normalizedName)!==-1){
        value=mappedSrcset(value);
      }
      return nativeSetAttribute.call(this,name,value);
    };
  }catch(_error){}
}
var nativeElementSetAttribute=window.Element&&window.Element.prototype.setAttribute;
var nativeElementInnerHtmlDescriptor=window.Element&&Object.getOwnPropertyDescriptor(window.Element.prototype,"innerHTML");
function markupUrlAttribute(element,name,value){
  var tagName=String(element.localName||element.nodeName||"").toLowerCase();
  var localUrl=mappedUrl(value);
  var offlineUrl=offlineElementUrl(element,name,value,localUrl);
  if(offlineUrl){
    return offlineUrl;
  }
  if(tagName==="img"&&name==="src"&&String(value).trim().toLowerCase()==="about:blank"){
    return inertImagePlaceholderUrl;
  }
  if(localUrl){return localUrl;}
  if(isRemoteHttpUrl(value)){
    if(tagName==="script"&&name==="src"){return runtimeUnavailableScriptUrl;}
    if(tagName==="img"&&name==="src"){return inertImagePlaceholderUrl;}
    if(
      tagName==="link"&&
      name==="href"&&
      String(element.rel||"").toLowerCase().split(/\\s+/).indexOf("stylesheet")!==-1
    ){
      return runtimeNoopStyleUrl;
    }
    return nonessentialNoopUrl;
  }
  return value;
}
function localizeMarkupTree(root){
  if(!root||typeof root.querySelectorAll!=="function"||typeof nativeElementSetAttribute!=="function"){
    return;
  }
  var elements=Array.prototype.slice.call(root.querySelectorAll("*"));
  elements.forEach(function(element){
    var tagName=String(element.localName||element.nodeName||"").toLowerCase();
    var urlNames=["src","poster","data"];
    if(tagName==="link"||tagName==="image"||tagName==="use"){urlNames.push("href");}
    urlNames.forEach(function(name){
      if(!element.hasAttribute(name)){return;}
      nativeElementSetAttribute.call(
        element,
        name,
        markupUrlAttribute(element,name,element.getAttribute(name))
      );
    });
    if(element.hasAttribute("srcset")){
      nativeElementSetAttribute.call(element,"srcset",mappedSrcset(element.getAttribute("srcset")));
    }
  });
}
function localizeMarkup(value){
  if(
    typeof value!=="string"||
    !nativeElementInnerHtmlDescriptor||
    typeof nativeElementInnerHtmlDescriptor.get!=="function"||
    typeof nativeElementInnerHtmlDescriptor.set!=="function"
  ){
    return value;
  }
  var lower=value.toLowerCase();
  if(
    lower.indexOf("<")<0||
    (
      lower.indexOf("src")<0&&
      lower.indexOf("href")<0&&
      lower.indexOf("poster")<0&&
      lower.indexOf("data")<0
    )
  ){
    return value;
  }
  try{
    var template=document.createElement("template");
    nativeElementInnerHtmlDescriptor.set.call(template,value);
    localizeMarkupTree(template.content);
    return nativeElementInnerHtmlDescriptor.get.call(template);
  }catch(_error){
    return value;
  }
}
function inheritedPropertyDescriptor(prototype,name){
  var current=prototype;
  while(current&&current!==Object.prototype){
    var descriptor=Object.getOwnPropertyDescriptor(current,name);
    if(descriptor){return descriptor;}
    current=Object.getPrototypeOf(current);
  }
  return null;
}
function isStyleElement(element){
  return String((element&&element.localName)||(element&&element.nodeName)||"").toLowerCase()==="style";
}
function localizeStyleTextNode(node){
  if(!node){return node;}
  if(node.nodeType===3||node.nodeType===4){
    try{node.data=mapCssText(node.data);}catch(_error){}
    return node;
  }
  if(node.nodeType===11&&node.childNodes){
    Array.prototype.forEach.call(node.childNodes,localizeStyleTextNode);
  }
  return node;
}
function localizeStyleTextArgument(value){
  return typeof value==="string"?mapCssText(value):localizeStyleTextNode(value);
}
function wrapStyleTextProperty(prototype,name){
  if(!prototype){return;}
  var descriptor=inheritedPropertyDescriptor(prototype,name);
  if(!descriptor||typeof descriptor.set!=="function"){return;}
  try{
    Object.defineProperty(prototype,name,{
      configurable:true,
      enumerable:descriptor.enumerable,
      get:descriptor.get,
      set:function(value){return descriptor.set.call(this,mapCssText(value));}
    });
  }catch(_error){}
}
function wrapStyleTextMethod(prototype,name,valueIndexes){
  if(!prototype||typeof prototype[name]!=="function"){return;}
  var nativeMethod=prototype[name];
  try{
    prototype[name]=function(){
      var args=Array.prototype.slice.call(arguments);
      if(valueIndexes===null){
        args=args.map(localizeStyleTextArgument);
      }else{
        valueIndexes.forEach(function(index){
          if(args.length>index){args[index]=localizeStyleTextArgument(args[index]);}
        });
      }
      return nativeMethod.apply(this,args);
    };
  }catch(_error){}
}
function wrapInnerHtml(prototype){
  if(!prototype){return;}
  var descriptor=Object.getOwnPropertyDescriptor(prototype,"innerHTML");
  if(!descriptor||typeof descriptor.set!=="function"){return;}
  try{
    Object.defineProperty(prototype,"innerHTML",{
      configurable:descriptor.configurable,
      enumerable:descriptor.enumerable,
      get:descriptor.get,
      set:function(value){
        return descriptor.set.call(this,isStyleElement(this)?mapCssText(value):localizeMarkup(value));
      }
    });
  }catch(_error){}
}
function wrapInsertAdjacentHtml(){
  var prototype=window.Element&&window.Element.prototype;
  if(!prototype||typeof prototype.insertAdjacentHTML!=="function"){return;}
  var nativeInsertAdjacentHtml=prototype.insertAdjacentHTML;
  try{
    prototype.insertAdjacentHTML=function(position,text){
      return nativeInsertAdjacentHtml.call(this,position,localizeMarkup(text));
    };
  }catch(_error){}
}
function wrapContextualFragment(){
  var prototype=window.Range&&window.Range.prototype;
  if(!prototype||typeof prototype.createContextualFragment!=="function"){return;}
  var nativeCreateContextualFragment=prototype.createContextualFragment;
  try{
    prototype.createContextualFragment=function(text){
      return nativeCreateContextualFragment.call(this,localizeMarkup(text));
    };
  }catch(_error){}
}
wrapUrlProperty(window.HTMLImageElement&&window.HTMLImageElement.prototype,"src");
wrapSrcsetProperty(window.HTMLImageElement&&window.HTMLImageElement.prototype,"srcset");
wrapUrlProperty(window.HTMLScriptElement&&window.HTMLScriptElement.prototype,"src");
wrapUrlProperty(window.HTMLLinkElement&&window.HTMLLinkElement.prototype,"href");
wrapUrlProperty(window.HTMLMediaElement&&window.HTMLMediaElement.prototype,"src");
wrapUrlProperty(window.HTMLVideoElement&&window.HTMLVideoElement.prototype,"poster");
wrapUrlProperty(window.HTMLSourceElement&&window.HTMLSourceElement.prototype,"src");
wrapSrcsetProperty(window.HTMLSourceElement&&window.HTMLSourceElement.prototype,"srcset");
wrapUrlProperty(window.HTMLTrackElement&&window.HTMLTrackElement.prototype,"src");
wrapUrlProperty(window.HTMLIFrameElement&&window.HTMLIFrameElement.prototype,"src");
wrapUrlProperty(window.HTMLEmbedElement&&window.HTMLEmbedElement.prototype,"src");
wrapUrlProperty(window.HTMLObjectElement&&window.HTMLObjectElement.prototype,"data");
wrapUrlAttributes(window.HTMLImageElement&&window.HTMLImageElement.prototype,["src"],["srcset"]);
wrapUrlAttributes(window.HTMLScriptElement&&window.HTMLScriptElement.prototype,["src"],[]);
wrapUrlAttributes(window.HTMLLinkElement&&window.HTMLLinkElement.prototype,["href"],[]);
wrapUrlAttributes(window.HTMLMediaElement&&window.HTMLMediaElement.prototype,["src"],[]);
wrapUrlAttributes(window.HTMLVideoElement&&window.HTMLVideoElement.prototype,["poster"],[]);
wrapUrlAttributes(window.HTMLSourceElement&&window.HTMLSourceElement.prototype,["src"],["srcset"]);
wrapUrlAttributes(window.HTMLTrackElement&&window.HTMLTrackElement.prototype,["src"],[]);
wrapUrlAttributes(window.HTMLIFrameElement&&window.HTMLIFrameElement.prototype,["src"],[]);
wrapUrlAttributes(window.HTMLEmbedElement&&window.HTMLEmbedElement.prototype,["src"],[]);
wrapUrlAttributes(window.HTMLObjectElement&&window.HTMLObjectElement.prototype,["data"],[]);
var htmlStyleElementPrototype=window.HTMLStyleElement&&window.HTMLStyleElement.prototype;
wrapStyleTextProperty(htmlStyleElementPrototype,"textContent");
wrapStyleTextProperty(htmlStyleElementPrototype,"innerText");
wrapStyleTextMethod(htmlStyleElementPrototype,"append",null);
wrapStyleTextMethod(htmlStyleElementPrototype,"prepend",null);
wrapStyleTextMethod(htmlStyleElementPrototype,"replaceChildren",null);
wrapStyleTextMethod(htmlStyleElementPrototype,"appendChild",[0]);
wrapStyleTextMethod(htmlStyleElementPrototype,"insertBefore",[0]);
wrapStyleTextMethod(htmlStyleElementPrototype,"replaceChild",[0]);
wrapStyleTextMethod(htmlStyleElementPrototype,"insertAdjacentText",[1]);
wrapInnerHtml(window.Element&&window.Element.prototype);
wrapInnerHtml(window.ShadowRoot&&window.ShadowRoot.prototype);
wrapInsertAdjacentHtml();
wrapContextualFragment();
})();`;
}

function upsertRuntimeUrlMapScript(
  document: DefaultTreeAdapterTypes.Document,
  session: RewriteSession,
): void {
  const bootstrap = createRuntimeUrlMapBootstrap(session);

  if (!bootstrap) {
    return;
  }

  const existing = findElement(document, isRuntimeUrlMapScript);

  if (existing) {
    replaceTextNodes(existing, bootstrap);
    return;
  }

  const head = findElement(document, (element) => element.tagName === 'head');

  if (!head) {
    return;
  }

  const script: DefaultTreeAdapterTypes.Element = {
    nodeName: 'script',
    tagName: 'script',
    attrs: [
      {
        name: runtimeUrlMapAttribute,
        value: runtimeUrlMapAttributeValue,
      },
    ],
    namespaceURI: html.NS.HTML,
    childNodes: [],
    parentNode: head,
  };
  script.childNodes.push({
    nodeName: '#text',
    value: bootstrap,
    parentNode: script,
  });
  head.childNodes.unshift(script);
}

function visitHtmlNode(
  node: DefaultTreeAdapterTypes.Node,
  session: RewriteSession,
  resourceUrl: string,
): void {
  if (!isElement(node)) {
    if ('childNodes' in node) {
      for (const child of node.childNodes) {
        visitHtmlNode(child, session, resourceUrl);
      }
    }

    return;
  }

  const trackingScriptDisabled = disableTrackingScript(node, resourceUrl);

  if (!trackingScriptDisabled) {
    rewriteElementAttributes(node, session);
  }

  if (node.tagName === 'style') {
    rewriteStyleElement(node, session);
  }

  if (node.tagName === 'script' && !trackingScriptDisabled) {
    rewriteInlineScript(node, session);
  }

  for (const child of node.childNodes) {
    visitHtmlNode(child, session, resourceUrl);
  }

  if (node.tagName === 'template' && 'content' in node) {
    visitHtmlNode(node.content, session, resourceUrl);
  }
}

export function rewriteHtml(input: RewriteTextInput): RewriteResult {
  const session = createRewriteSession(input);
  const document = parse(input.text);
  visitHtmlNode(document, session, input.resourceUrl);
  upsertRuntimeUrlMapScript(document, session);
  return session.result(serialize(document));
}
