chrome.runtime.onInstalled.addListener(() => {
  console.info('WebMirror extension installed.');
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'webmirror.capture.requested'
  ) {
    console.info('Capture requested. CDP POC is not connected yet.', message);
  }
});
