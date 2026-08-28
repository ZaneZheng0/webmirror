const runtimeRoot = ['http://127.0.0.1:4178', '/runtime-composed/'].join('');
const workerManifest = {
  moduleLeaf: ['worker', '-module.js'].join(''),
  nestedWorkerLeaf: ['nested', '-worker.js'].join(''),
};

if (typeof self.__webmirrorMapModuleUrl === 'function') {
  void fetch('https://www.google-analytics.com/g/collect?v=2').catch(() => undefined);
}

async function run() {
  const workerModule = await import(runtimeRoot + workerManifest.moduleLeaf);
  const nestedWorker = new Worker(runtimeRoot + workerManifest.nestedWorkerLeaf, {
    type: 'module',
  });
  const nestedResult = await new Promise((resolve, reject) => {
    nestedWorker.addEventListener('message', (event) => resolve(event.data), { once: true });
    nestedWorker.addEventListener('error', () => reject(new Error('Nested worker failed.')), {
      once: true,
    });
  });

  if (
    workerModule.workerValue !== 'worker-module-ready' ||
    nestedResult?.value !== 'nested-worker-ready'
  ) {
    throw new Error('Worker runtime dependencies did not resolve.');
  }

  self.postMessage({ value: nestedResult.value });
}

run().catch((error) => {
  throw error;
});
