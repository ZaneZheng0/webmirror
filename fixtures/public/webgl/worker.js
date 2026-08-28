/* global importScripts */

const runtimeAssetRoot = ['http://127.0.0.1:4178', '/webgl/'].join('');
const runtimeManifest = {
  libraryLeaf: ['worker', '-runtime.js'].join(''),
  modelLeaf: ['model', '.bin'].join(''),
};

importScripts(runtimeAssetRoot + runtimeManifest.libraryLeaf);

self.addEventListener('message', async (event) => {
  const model = await fetch(runtimeAssetRoot + runtimeManifest.modelLeaf).then((response) =>
    response.arrayBuffer(),
  );

  if (model.byteLength !== event.data.bytes || self.webmirrorWorkerRuntimeLoaded !== true) {
    throw new Error('The worker runtime dependencies did not load.');
  }

  self.postMessage({
    bytes: model.byteLength,
    textureWidth: event.data.textureWidth,
  });
});
