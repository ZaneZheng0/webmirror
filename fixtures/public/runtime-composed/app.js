const status = document.querySelector('#status');
const cssomSurface = document.querySelector('#cssom-surface');
const runtimeRoot = ['http://127.0.0.1:4178', '/runtime-composed/'].join('');
const runtimeManifest = {
  imageLeaf: 'style.svg',
  moduleLeaf: 'runtime-module.js',
  workerLeaf: 'module-worker.js',
};

async function startWorker() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(runtimeRoot + runtimeManifest.workerLeaf, { type: 'module' });
    worker.addEventListener('message', (event) => resolve(event.data), { once: true });
    worker.addEventListener('error', () => reject(new Error('Runtime worker failed.')), {
      once: true,
    });
  });
}

async function initialize() {
  const runtimeModule = await import(runtimeRoot + runtimeManifest.moduleLeaf);

  if (!cssomSurface) {
    throw new Error('The CSSOM fixture surface is missing.');
  }

  const imageUrl = runtimeRoot + runtimeManifest.imageLeaf;
  const stylesheet = new globalThis.CSSStyleSheet();
  stylesheet.replaceSync(`.cssom-surface { background-image: url("${imageUrl}"); }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, stylesheet];
  cssomSurface.style.backgroundImage = `url("${imageUrl}")`;
  cssomSurface.style.maskImage = `url("${imageUrl}")`;
  cssomSurface.style.borderImageSource = `url("${imageUrl}")`;

  const styleTextContent = document.createElement('style');
  styleTextContent.textContent = `.style-text-content-surface { background-image: url("${imageUrl}"); }`;
  document.head.append(styleTextContent);

  const styleInnerText = document.createElement('style');
  styleInnerText.innerText = `.style-inner-text-surface { background-image: url("${imageUrl}"); }`;
  document.head.append(styleInnerText);

  const styleInnerHtml = document.createElement('style');
  styleInnerHtml.innerHTML = `.style-inner-html-surface { background-image: url("${imageUrl}"); }`;
  document.head.append(styleInnerHtml);

  const styleAppend = document.createElement('style');
  styleAppend.append(`.style-append-surface { background-image: url("${imageUrl}"); }`);
  document.head.append(styleAppend);

  const styleAppendChild = document.createElement('style');
  styleAppendChild.appendChild(
    document.createTextNode(
      `.style-append-child-surface { background-image: url("${imageUrl}"); }`,
    ),
  );
  document.head.append(styleAppendChild);

  const workerResult = await startWorker();

  if (
    runtimeModule.runtimeValue !== 'module-ready' ||
    workerResult?.value !== 'nested-worker-ready'
  ) {
    throw new Error('Runtime-composed dependencies did not resolve.');
  }

  if (status) {
    status.textContent = 'runtime composed complete';
  }
}

initialize().catch((error) => {
  if (status) {
    status.textContent =
      error instanceof Error ? error.message : 'Runtime-composed fixture failed.';
  }

  throw error;
});
