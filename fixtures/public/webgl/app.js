const canvas = document.querySelector('#scene');
const status = document.querySelector('#status');

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);

  if (!shader) {
    throw new Error('Could not create a WebGL shader.');
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || 'WebGL shader compilation failed.');
  }

  return shader;
}

function drawScene(gl) {
  const vertex = compileShader(
    gl,
    gl.VERTEX_SHADER,
    'attribute vec2 position; attribute vec3 color; varying vec3 vColor; void main(){vColor=color;gl_Position=vec4(position,0.0,1.0);}',
  );
  const fragment = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    'precision mediump float; varying vec3 vColor; void main(){gl_FragColor=vec4(vColor,1.0);}',
  );
  const program = gl.createProgram();

  if (!program) {
    throw new Error('Could not create a WebGL program.');
  }

  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.useProgram(program);

  const vertices = new Float32Array([
    -0.72, -0.62, 0.12, 0.74, 0.48, 0.72, -0.62, 0.2, 0.45, 0.86, 0, 0.76, 0.94, 0.32, 0.28,
  ]);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  const stride = 5 * Float32Array.BYTES_PER_ELEMENT;
  const position = gl.getAttribLocation(program, 'position');
  const color = gl.getAttribLocation(program, 'color');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(color);
  gl.vertexAttribPointer(color, 3, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  gl.clearColor(0.04, 0.07, 0.09, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

async function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${url}`));
    image.src = url;
  });
}

async function initialize() {
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('The WebGL canvas is missing.');
  }

  const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });

  if (!gl) {
    throw new Error('WebGL is unavailable.');
  }

  const scene = await fetch('./scene.json').then((response) => response.json());
  const runtimeAssetRoot = ['http://127.0.0.1:4178', '/webgl/'].join('');
  const runtimeManifest = {
    binaryLeaf: 'model.bin',
    imageLeaf: 'texture.svg',
  };
  const [model, texture] = await Promise.all([
    fetch(runtimeAssetRoot + runtimeManifest.binaryLeaf).then((response) => response.arrayBuffer()),
    loadImage(runtimeAssetRoot + runtimeManifest.imageLeaf),
  ]);

  const expectedModelLeaf = ['model', '.bin'].join('');
  const expectedTextureLeaf = ['texture', '.svg'].join('');

  if (scene.model !== expectedModelLeaf || scene.texture !== expectedTextureLeaf) {
    throw new Error('The scene manifest did not retain its relative asset leaves.');
  }
  const worker = new Worker('./worker.js');
  const workerReady = new Promise((resolve) => {
    worker.addEventListener('message', (event) => resolve(event.data), { once: true });
  });
  worker.postMessage({ bytes: model.byteLength, textureWidth: texture.width });
  const workerResult = await workerReady;
  drawScene(gl);

  if (status) {
    status.textContent = `WebGL ready: ${workerResult.bytes} model bytes.`;
  }
}

initialize().catch((error) => {
  if (status) {
    status.textContent = error instanceof Error ? error.message : 'WebGL fixture failed.';
  }
  throw error;
});
