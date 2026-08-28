export const trackingNoopScript =
  'window.dataLayer=window.dataLayer||[];' +
  'window.ga=window.ga||function(){(window.ga.q=window.ga.q||[]).push(arguments)};' +
  'window.gtag=window.gtag||function(){window.dataLayer.push(arguments)};';

export const externalEmbedNoopScript =
  'window.FB=window.FB||{init:function(){},XFBML:{parse:function(){}},ui:function(){}};' +
  'window.twttr=window.twttr||{ready:function(callback){if(typeof callback==="function"){callback(window.twttr);}},widgets:{load:function(){}}};' +
  'window.gapi=window.gapi||{load:function(_name,callback){if(typeof callback==="function"){callback();}}};';

const standaloneGoogleTagRuntimePrefix =
  /^\s*\/\/ Copyright \d{4} Google Inc\. All rights reserved\.\s*\(function\(\)\s*\{\s*var data\s*=\s*\{\s*"resource"/u;

function isCloudflareRumRuntime(source: string): boolean {
  return (
    source.includes('/cdn-cgi/rum') &&
    (source.includes('sendBeacon') ||
      source.includes('PerformanceObserver') ||
      source.includes('cf-beacon'))
  );
}

export function isStandaloneTrackingJavaScript(source: string): boolean {
  return (
    isCloudflareRumRuntime(source) ||
    (standaloneGoogleTagRuntimePrefix.test(source.slice(0, 512)) &&
      source.includes('gtmOnSuccess') &&
      source.includes('www.googletagmanager.com') &&
      source.includes('google-analytics.com'))
  );
}
