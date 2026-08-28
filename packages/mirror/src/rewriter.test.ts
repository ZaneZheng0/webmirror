import { parse, type Program } from 'acorn';
import { describe, expect, it } from 'vitest';

import { discoverStaticJavaScriptAssets } from './static-javascript-assets.js';
import { createDownloadedResourceUrlMap, imageRenditionIdentity } from './resource-map.js';
import {
  rewriteCss,
  rewriteHtml,
  rewriteJavaScript,
  rewriteJson,
  rewriteResource,
} from './rewriter.js';

describe('discoverStaticJavaScriptAssets', () => {
  it('does not use unrelated component identities as dynamic loader file names', () => {
    const program = parse(
      `
        const componentDefinitions = [
          { id: "email" },
          { id: "first_name" },
          { id: "copy_svg__a" },
        ];
        FontLoader.prototype.load = function () {
          var kit = this.config.id;
          return (this.config.api || "https://use.typekit.net") + "/" + kit + ".js";
        };
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;
    const result = discoverStaticJavaScriptAssets(program, 'https://storefront.example');

    expect(result.dependencies).not.toEqual(
      expect.arrayContaining([
        'https://use.typekit.net/email.js',
        'https://use.typekit.net/first_name.js',
        'https://use.typekit.net/copy_svg__a.js',
      ]),
    );
  });

  it('keeps template bases and arbitrary placeholder values isolated', () => {
    const program = parse(
      `
        const manifests = {
          first: { src: "packs/a/{variant}/seed.png" },
          second: { src: "packs/b/{variant}/seed.png" },
        };
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;
    const result = discoverStaticJavaScriptAssets(program, 'https://page.example', [
      'https://cdn-a.example/root/packs/a/red/seed.png',
      'https://cdn-b.example/assets/packs/b/blue/seed.png',
    ]);

    expect(result.dependencies).toEqual([
      'https://cdn-a.example/root/packs/a/red/seed.png',
      'https://cdn-b.example/assets/packs/b/blue/seed.png',
    ]);
  });

  it('distinguishes observed audio WebM paths from video WebM paths', () => {
    const program = parse(
      `
        const manifest = {
          sound: { src: "sounds/theme.{audio}" },
          video: { src: "videos/theme.{video}" },
        };
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;
    const result = discoverStaticJavaScriptAssets(program, 'https://example.com', [
      'https://example.com/sounds/intro.webm',
      'https://example.com/videos/intro.webm',
    ]);

    expect(result.dependencies).toEqual([
      'https://example.com/sounds/theme.webm',
      'https://example.com/videos/theme.webm',
    ]);
  });

  it('only treats direct structured values as assets', () => {
    const program = parse(
      `
        const manifest = [{
          id: "background.jpg",
          src: "images/covers/yelle/desktop/background.jpg",
        }];
        const audio = {
          urls: ["sounds/content/noise.ogg", "sounds/content/noise.mp3"],
        };
        const runtimeAudio = { urls: [this.getAsset("robot").src] };
        const runtimeTexture = { image: this.textureCache["background.jpg"] };
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;
    const result = discoverStaticJavaScriptAssets(program, 'https://example.com');

    expect(result.dependencies).toEqual([
      'https://example.com/images/covers/yelle/desktop/background.jpg',
      'https://example.com/sounds/content/noise.mp3',
      'https://example.com/sounds/content/noise.ogg',
    ]);
    expect(result.dependencies).not.toContain('https://example.com/background.jpg');
  });

  it('discovers structured asset paths with URL-encoded spaces', () => {
    const program = parse(
      `
        const playlist = [{
          title: "Flint - Fly up High",
          metadata: "media/ignored - sample.mp3",
          src: "assets/music/Flint - Fly up High.mp3",
        }];
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;
    const result = discoverStaticJavaScriptAssets(program, 'https://example.com');

    expect(result.dependencies).toEqual([
      'https://example.com/assets/music/Flint%20-%20Fly%20up%20High.mp3',
    ]);
  });

  it('does not propagate a placeholder value between unrelated templates', () => {
    const program = parse(
      `
        const manifest = {
          observed: { src: "sounds/a.{audio}" },
          deferred: { src: "music/b.{audio}" },
        };
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;
    const result = discoverStaticJavaScriptAssets(program, 'https://example.com', [
      'https://example.com/sounds/a.ogg',
    ]);

    expect(result.dependencies).toEqual(['https://example.com/sounds/a.ogg']);
  });

  it('keeps declared placeholder choices local to each template', () => {
    const program = parse(
      `
        const manifest = {
          flexible: { src: "images/{variant:all}/hero.png" },
          constrained: { src: "themes/{variant:red,blue}/swatch.png" },
        };
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;
    const result = discoverStaticJavaScriptAssets(program, 'https://example.com', [
      'https://example.com/images/red-dark/hero.png',
    ]);

    expect(result.dependencies).toContain('https://example.com/images/red-dark/hero.png');
  });

  it('does not expand ambiguous conditional runtime formats without observations', () => {
    const program = parse(
      `
        settings.audioFormat = Modernizr.audio.ogg ? "ogg" : "mp3";
        settings.videoFormat = Modernizr.video.webm ? "webm" : "mp4";
        const manifest = {
          sound: { src: "sounds/theme.{audio}" },
          video: { src: "videos/theme.{video}" },
        };
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;
    const result = discoverStaticJavaScriptAssets(program, 'https://example.com');

    expect(result.dependencies).toEqual([]);
  });

  it('uses exact runtime defaults without accepting compound resolution evidence', () => {
    const program = parse(
      `
        settings.assetResolution = "desktop";
        if (tablet) settings.assetResolution = "tablet";
        if (mobile) settings.assetResolution = "mobile";
        const manifest = { hero: { src: "images/{assetResolution}/hero.png" } };
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;
    const falseEvidence = discoverStaticJavaScriptAssets(program, 'https://example.com', [
      'https://example.com/images/b-desktop/hero.png',
    ]);
    const exactEvidence = discoverStaticJavaScriptAssets(program, 'https://example.com', [
      'https://example.com/images/desktop/hero.png',
    ]);

    expect(falseEvidence.dependencies).not.toContain(
      'https://example.com/images/b-desktop/hero.png',
    );
    expect(exactEvidence.dependencies).toEqual(['https://example.com/images/desktop/hero.png']);
  });

  it('keeps the bounded prefix of oversized finite arrays', () => {
    const items = Array.from({ length: 65 }, (_, index) => `"images/item-${index}.png"`).join(',');
    const program = parse(
      `
        const assets = [${items}];
        assets.forEach((asset) => imageLoader.load(asset));
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;
    const result = discoverStaticJavaScriptAssets(program, 'https://example.com');

    expect(result.dependencies).toHaveLength(64);
    expect(result.dependencies).toContain('https://example.com/images/item-0.png');
    expect(result.dependencies).toContain('https://example.com/images/item-63.png');
    expect(result.dependencies).not.toContain('https://example.com/images/item-64.png');
  });

  it('resolves finite callback aliases bound to this', () => {
    const program = parse(
      `
        const callback = function (name) {
          imageLoader.load("images/" + name + ".png");
        }.bind(this);
        const names = ["alpha", "beta"];
        names.forEach(callback);
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;
    const result = discoverStaticJavaScriptAssets(program, 'https://example.com');

    expect(result.dependencies).toEqual([
      'https://example.com/images/alpha.png',
      'https://example.com/images/beta.png',
    ]);
  });

  it('uses callback definition scope and honors pre-bound parameters', () => {
    const program = parse(
      `
        const prefix = "declared/";
        const lexicalCallback = function (name) {
          imageLoader.load(prefix + name + ".png");
        }.bind(this);
        const boundCallback = function (name) {
          imageLoader.load("bound/" + name + ".png");
        }.bind(this, "fixed");

        {
          const prefix = "callsite/";
          ["alpha"].forEach(lexicalCallback);
          ["ignored"].forEach(boundCallback);
        }
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;
    const result = discoverStaticJavaScriptAssets(program, 'https://example.com');

    expect(result.dependencies).toEqual([
      'https://example.com/bound/fixed.png',
      'https://example.com/declared/alpha.png',
    ]);
  });

  it('resolves live bindings declared later in the callback definition scope', () => {
    const program = parse(
      `
        const callback = (name) => imageLoader.load(prefix + name + ".png");
        const prefix = "images/";
        ["alpha"].forEach(callback);
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;
    const result = discoverStaticJavaScriptAssets(program, 'https://example.com');

    expect(result.dependencies).toEqual(['https://example.com/images/alpha.png']);
  });

  it('bounds recursive callback aliases without overflowing the stack', () => {
    const program = parse(
      `
        const names = ["alpha"];
        const callback = () => names.forEach(callback);
        names.forEach(callback);
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;

    expect(() => discoverStaticJavaScriptAssets(program, 'https://example.com')).not.toThrow();
  });

  it('uses same-directory WebM evidence for audio placeholders', () => {
    const program = parse(`const manifest = { next: { src: "media/next.{audio}" } };`, {
      ecmaVersion: 'latest',
      sourceType: 'script',
    }) as Program;
    const result = discoverStaticJavaScriptAssets(program, 'https://example.com', [
      'https://example.com/media/intro.webm',
    ]);

    expect(result.dependencies).toEqual(['https://example.com/media/next.webm']);
  });

  it('prefers a unique observed loader target over an origin-root guess', () => {
    const program = parse(`loader.load("models/gltf/LittlestTokyo.glb");`, {
      ecmaVersion: 'latest',
      sourceType: 'script',
    }) as Program;
    const result = discoverStaticJavaScriptAssets(
      program,
      'https://threejs.org',
      ['https://threejs.org/examples/models/gltf/LittlestTokyo.glb'],
      'https://threejs.org/examples/webgl_animation_keyframes.html',
    );

    expect(result.dependencies).toEqual([
      'https://threejs.org/examples/models/gltf/LittlestTokyo.glb',
    ]);
  });

  it('does not suffix-match a root-relative loader target', () => {
    const program = parse(`loader.load("/models/a.glb");`, {
      ecmaVersion: 'latest',
      sourceType: 'script',
    }) as Program;
    const result = discoverStaticJavaScriptAssets(
      program,
      'https://example.com',
      ['https://example.com/build/models/a.glb'],
      'https://example.com/build/app.js',
    );

    expect(result.dependencies).toEqual(['https://example.com/models/a.glb']);
  });

  it('discovers statically composed Worker constructor URLs', () => {
    const program = parse(
      `
        const runtimeRoot = ['https://example.com', '/runtime/'].join('');
        const manifest = { nestedWorker: ['nested', '-worker.js'].join('') };
        new Worker(runtimeRoot + manifest.nestedWorker, { type: 'module' });
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;
    const result = discoverStaticJavaScriptAssets(program, 'https://example.com');

    expect(result.dependencies).toEqual(['https://example.com/runtime/nested-worker.js']);
    expect(result.workerDependencies).toEqual(['https://example.com/runtime/nested-worker.js']);
  });

  it('discovers asset paths passed to named media constructors and nested options', () => {
    const program = parse(
      `
        const video = new VideoTexture("assets/video/reel.mp4", {
          firstFrame: "assets/video/reel-frame.jpg",
        });
        const texture = Utils3D.getTexture("assets/images/fallback.jpg");
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;
    const result = discoverStaticJavaScriptAssets(
      program,
      'https://example.com',
      [],
      'https://example.com/assets/js/app.js',
    );

    expect(result.dependencies).toEqual(
      expect.arrayContaining([
        'https://example.com/assets/video/reel.mp4',
        'https://example.com/assets/video/reel-frame.jpg',
        'https://example.com/assets/images/fallback.jpg',
      ]),
    );
  });

  it('does not guess a root URL for an unobserved bare runtime resolver leaf', () => {
    const program = parse(
      `
        let wasm = "decoder_variant.wasm";
        wasm = runtimeResolve(wasm);
        fetch(wasm);
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;
    const result = discoverStaticJavaScriptAssets(
      program,
      'https://example.com',
      [],
      'https://example.com/examples/decoder-wrapper.js',
    );

    expect(result.dependencies).toEqual([]);
  });

  it('does not fetch virtual members of pack containers as standalone URLs', () => {
    const program = parse(
      `
        const manifest = {
          "canvas.pack": {
            files: {
              "Character.glb": {
                source: "src/canvas/assets/canvas.pack/Character.glb",
                directoryID: "canvas.pack",
                length: 1518764,
                position: 919115,
              },
            },
          },
        };
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;

    const result = discoverStaticJavaScriptAssets(program, 'https://example.test');

    expect(result.dependencies).toEqual([]);
    expect(result.dependencies).not.toContain(
      'https://example.test/src/canvas/assets/canvas.pack/Character.glb',
    );
  });

  it('resolves source-and-destination records only to a unique deployed URL', () => {
    const program = parse(
      `
        const manifest = {
          static: {
            files: {
              "Guide.pdf": {
                source: "src/app/assets/app.static/Guide.pdf",
                destination: "static/app/Guide.pdf",
              },
            },
          },
          map: {
            "app.static/Guide.pdf":
              "https://cdn.example.test/build/static/app/Guide.pdf",
          },
        };
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;

    const deployedUrl = 'https://cdn.example.test/build/static/app/Guide.pdf';
    const result = discoverStaticJavaScriptAssets(program, 'https://example.test', [deployedUrl]);

    expect(result.dependencies).toEqual([deployedUrl]);
    expect(result.dependencies).not.toContain(
      'https://example.test/src/app/assets/app.static/Guide.pdf',
    );
  });

  it('does not guess when multiple observed URLs match a deployment destination', () => {
    const program = parse(
      `
        const record = {
          source: "src/assets/site.static/Guide.pdf",
          destination: "static/site/Guide.pdf",
        };
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;

    const result = discoverStaticJavaScriptAssets(program, 'https://example.test', [
      'https://a.example.test/build/static/site/Guide.pdf',
      'https://b.example.test/build/static/site/Guide.pdf',
    ]);

    expect(result.dependencies).toEqual([]);
  });

  it('expands filename-and-byte deployment inventories from a uniquely observed base', () => {
    const program = parse(
      `
        window.RUNTIME_TEXTURES = [
          { filename: "pbr/base.ktx2", bytes: 1200, lastChange: "2026-01-01" },
          { filename: "pbr/normal.ktx2", bytes: 2400, lastChange: "2026-01-01" },
          { filename: "room/hero image.png", bytes: 3600, lastChange: "2026-01-01" },
        ];
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;
    const result = discoverStaticJavaScriptAssets(program, 'https://example.test', [
      'https://example.test/build/assets/pbr/base.ktx2',
      'https://example.test/build/assets/room/hero%20image.png',
    ]);

    expect(result.dependencies).toEqual([
      'https://example.test/build/assets/pbr/base.ktx2',
      'https://example.test/build/assets/pbr/normal.ktx2',
      'https://example.test/build/assets/room/hero%20image.png',
    ]);
  });

  it('does not guess a deployment-inventory base without multiple observations', () => {
    const program = parse(
      `
        const inventory = [
          { filename: "textures/a.ktx2", bytes: 10 },
          { filename: "textures/b.ktx2", bytes: 20 },
        ];
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;
    const result = discoverStaticJavaScriptAssets(program, 'https://example.test', [
      'https://cdn.example.test/deploy/textures/a.ktx2',
    ]);

    expect(result.dependencies).toEqual([]);
  });

  it('does not expand a deployment inventory when observed bases tie', () => {
    const program = parse(
      `
        const inventory = [
          { filename: "textures/a.ktx2", bytes: 10 },
          { filename: "textures/b.ktx2", bytes: 20 },
        ];
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;
    const result = discoverStaticJavaScriptAssets(program, 'https://example.test', [
      'https://a.example.test/deploy/textures/a.ktx2',
      'https://a.example.test/deploy/textures/b.ktx2',
      'https://b.example.test/deploy/textures/a.ktx2',
      'https://b.example.test/deploy/textures/b.ktx2',
    ]);

    expect(result.dependencies).toEqual([]);
  });
});

describe('rewriteHtml', () => {
  it('rewrites mapped attributes, srcset, inline CSS, style blocks, and meta refresh', () => {
    const urlToLocalPath = new Map<string, string>([
      [
        'https://cdn.example.net/css/site.css?v=7',
        'site/_external/https/cdn.example.net/css/site~q-v7.css',
      ],
      ['https://example.com/css/print.css?mode=dark', 'site/css/print~q-dark.css'],
      [
        'https://cdn.example.net/images/style-hero.png?dpr=2',
        'site/_external/https/cdn.example.net/images/style-hero~q-2.png',
      ],
      ['https://example.com/next.html?from=mirror', 'site/next~q-from.html'],
      ['https://example.com/images/bg.png', 'site/images/bg.png'],
      ['https://example.com/images/hero.jpg?size=large', 'site/images/hero~q-large.jpg'],
      ['https://example.com/images/small.jpg?dpr=1', 'site/images/small~q-1.jpg'],
      [
        'https://cdn.example.net/images/large.jpg?dpr=2',
        'site/_external/https/cdn.example.net/images/large~q-2.jpg',
      ],
      ['https://example.com/media/poster.jpg', 'site/media/poster.jpg'],
      ['https://example.com/models/scene.glb', 'site/models/scene.glb'],
    ]);
    const html = `<!doctype html>
      <html>
        <head>
          <link rel="stylesheet" href="https://cdn.example.net/css/site.css?v=7#theme">
          <style>
            @import "/css/print.css?mode=dark";
            .hero { background-image: url("https://cdn.example.net/images/style-hero.png?dpr=2#focus"); }
            .skip { mask: url(#mask); cursor: url(data:image/png;base64,AAAA); }
          </style>
          <meta http-equiv="refresh" content="5; url='/next.html?from=mirror#top'">
        </head>
        <body style="background-image: url('/images/bg.png#tile')">
          <img
            src="/images/hero.jpg?size=large#main"
            srcset="/images/small.jpg?dpr=1 1x, https://cdn.example.net/images/large.jpg?dpr=2#large 2x, data:image/png;base64,AAAA 3x"
          >
          <video poster="/media/poster.jpg"></video>
          <object data="/models/scene.glb"></object>
          <a href="#section">Anchor</a>
          <a href="mailto:test@example.com">Mail</a>
          <img src="data:image/png;base64,AAAA">
          <img src="about:blank">
          <script src="blob:https://example.com/runtime"></script>
          <a href="javascript:alert(1)">Script</a>
          <img src="https://unknown.example.net/missing.png">
          <img src="/missing-local.png">
        </body>
      </html>`;

    const result = rewriteHtml({
      text: html,
      resourceUrl: 'https://example.com/pages/index.html',
      urlToLocalPath,
      currentLocalPath: 'site/pages/index.html',
    });

    expect(result.text).toContain(
      'href="../_external/https/cdn.example.net/css/site~q-v7.css#theme"',
    );
    expect(result.text).toContain('@import "/css/print~q-dark.css"');
    expect(result.text).toContain(
      'url("/_external/https/cdn.example.net/images/style-hero~q-2.png#focus")',
    );
    expect(result.text).toContain('content="5; url=\'../next~q-from.html#top\'"');
    expect(result.text).toContain('style="background-image: url(\'/images/bg.png#tile\')"');
    expect(result.text).toContain('src="../images/hero~q-large.jpg#main"');
    expect(result.text).toContain(
      'srcset="../images/small~q-1.jpg 1x, ../_external/https/cdn.example.net/images/large~q-2.jpg#large 2x, data:image/png;base64,AAAA 3x"',
    );
    expect(result.text).toContain('poster="../media/poster.jpg"');
    expect(result.text).toContain('data="../models/scene.glb"');
    expect(result.text).toContain('href="#section"');
    expect(result.text).toContain('href="mailto:test@example.com"');
    expect(result.text).toContain('src="data:image/png;base64,AAAA"');
    expect(result.text).toContain(
      'src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="',
    );
    expect(result.text).toContain('src="blob:https://example.com/runtime"');
    expect(result.text).toContain('href="javascript:alert(1)"');
    expect(result.unresolvedDependencies).toEqual(['https://example.com/missing-local.png']);
    expect(result.onlineDependencies).toEqual(['https://unknown.example.net/missing.png']);
  });

  it('keeps only mapped and data srcset candidates without discovering redundant variants', () => {
    const result = rewriteHtml({
      text: `<!doctype html>
        <img srcset="/images/hero-320.jpg 320w, /images/hero-1280.jpg 1280w, /images/hero-2560.jpg 2560w, data:image/png;base64,AAAA 3x">`,
      resourceUrl: 'https://example.com/pages/index.html',
      urlToLocalPath: new Map([
        ['https://example.com/images/hero-1280.jpg', 'site/images/hero-1280.jpg'],
      ]),
      currentLocalPath: 'site/pages/index.html',
    });

    expect(result.text).toContain(
      'srcset="../images/hero-1280.jpg 1280w, data:image/png;base64,AAAA 3x"',
    );
    expect(result.text).not.toContain('hero-320.jpg');
    expect(result.text).not.toContain('hero-2560.jpg');
    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('preserves absolute data-attribute asset URLs for URL constructors', () => {
    const heroUrl = 'https://cdn.example.net/images/hero.png?v=7';
    const result = rewriteHtml({
      text: `<!doctype html>
        <html><body data-hero-url="${heroUrl}" data-relative-url="images/hero.png">
        </body></html>`,
      resourceUrl: 'https://example.com/pages/index.html',
      urlToLocalPath: new Map([
        [heroUrl, 'site/_external/https/cdn.example.net/images/hero~q-v7.png'],
        ['https://example.com/pages/images/hero.png', 'site/pages/images/hero.png'],
      ]),
      currentLocalPath: 'site/pages/index.html',
    });

    expect(result.text).toContain(`data-hero-url="${heroUrl}"`);
    expect(result.text).toContain('data-relative-url="/pages/images/hero.png"');
    expect(result.text).toContain(`"${heroUrl}"`);
    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('discovers explicit absolute static assets in ordinary JSON URL fields', () => {
    const videoUrl = 'https://cdn.example.net/videos/scene.webm';
    const runtimeUrl = 'https://cdn.example.net/runtime/scene.json?rev=7';
    const input = {
      url: videoUrl,
      nested: {
        endpoint: runtimeUrl,
        privateAsset: 'https://cdn.example.net/runtime/private.wasm?token=do-not-capture',
      },
      website: 'https://www.example.net/product',
    };
    const discovered = rewriteJson({
      text: JSON.stringify(input),
      resourceUrl: 'https://example.com/data/scene.json',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/data/scene.json',
    });

    expect(discovered.onlineDependencies).toEqual([videoUrl, runtimeUrl]);
    expect(discovered.onlineDependencies.join('\n')).not.toContain('do-not-capture');
    expect(JSON.parse(discovered.text)).toEqual(input);

    const localized = rewriteJson({
      text: JSON.stringify(input),
      resourceUrl: 'https://example.com/data/scene.json',
      urlToLocalPath: new Map([
        [videoUrl, 'site/media/scene.webm'],
        [runtimeUrl, 'site/runtime/scene~q-rev.json'],
      ]),
      currentLocalPath: 'site/data/scene.json',
    });

    expect(JSON.parse(localized.text)).toEqual({
      ...input,
      url: '../media/scene.webm',
      nested: {
        ...input.nested,
        endpoint: '../runtime/scene~q-rev.json',
      },
    });
    expect(localized.onlineDependencies).toEqual([]);
  });

  it('maps runtime image rendition variants to the largest downloaded local image', () => {
    const mapping = createDownloadedResourceUrlMap([
      {
        sourceUrl: 'https://cdn.example.net/hero.png?v=7&width=100&height=50&crop=center',
        canonicalUrl: 'https://cdn.example.net/hero.png?v=7&width=100&height=50&crop=center',
        status: 'downloaded',
        localPath: 'site/_external/https/cdn.example.net/hero-small.png',
        contentType: 'image/png',
        size: 4_000,
      },
      {
        sourceUrl: 'https://cdn.example.net/hero.png?v=7&width=1300&height=650&crop=center',
        canonicalUrl: 'https://cdn.example.net/hero.png?v=7&width=1300&height=650&crop=center',
        status: 'downloaded',
        localPath: 'site/_external/https/cdn.example.net/hero-large.png',
        contentType: 'image/png',
        size: 400_000,
      },
    ]);
    const result = rewriteHtml({
      text: `<!doctype html>
        <html>
          <head></head>
          <body>
            <img src="https://cdn.example.net/hero.png?v=7&width=100&height=50&crop=center">
            <img src="https://cdn.example.net/hero.png?v=7&width=600&height=300&crop=center">
            <img src="https://cdn.example.net/hero.png?v=7">
          </body>
        </html>`,
      resourceUrl: 'https://example.com/pages/index.html',
      urlToLocalPath: mapping,
      currentLocalPath: 'site/pages/index.html',
    });

    expect(result.text).toContain('src="../_external/https/cdn.example.net/hero-small.png"');
    expect(
      result.text.match(/src="\.\.\/_external\/https\/cdn\.example\.net\/hero-large\.png"/gu),
    ).toHaveLength(2);
    expect(result.text).toContain(
      '["https://cdn.example.net/hero.png?v=7","/_external/https/cdn.example.net/hero-large.png"]',
    );
    expect(result.text).toContain(
      'var imageRenditionQueryNames=new Set(["dpr","h","height","quality","w","width"]);',
    );
    expect(result.text).toContain(
      'var imageRenditionNeutralQueryValues={"crop":["center","centre"]};',
    );
    expect(result.text).toContain('var localUrl=mappedUrl(value);');
    expect(result.text).toContain('value=mappedSrcset(value);');
    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('only treats centered crop values as neutral image rendition parameters', () => {
    const baseUrl = 'https://cdn.example.net/hero.png?v=7';

    expect(imageRenditionIdentity(`${baseUrl}&width=1280&height=720&crop=center`)).toBe(baseUrl);
    expect(imageRenditionIdentity(`${baseUrl}&width=1280&height=720&crop=CENTRE`)).toBe(baseUrl);
    expect(imageRenditionIdentity(`${baseUrl}&width=1280&crop=center&crop=top`)).toBe(
      `${baseUrl}&crop=top`,
    );
    expect(imageRenditionIdentity(`${baseUrl}&width=1280&height=720&crop=left`)).toBe(
      `${baseUrl}&crop=left`,
    );
  });

  it('uses a downloaded base image when runtime code adds rendition parameters later', () => {
    const baseUrl = 'https://cdn.example.net/runtime/theme.webp?v=7';
    const mapping = createDownloadedResourceUrlMap([
      {
        sourceUrl: baseUrl,
        canonicalUrl: baseUrl,
        status: 'downloaded',
        localPath: 'site/_external/https/cdn.example.net/runtime/theme.webp',
        contentType: 'image/webp',
        size: 800_000,
      },
    ]);
    const result = rewriteHtml({
      text: '<!doctype html><html><head></head><body></body></html>',
      resourceUrl: 'https://example.com/pages/index.html',
      urlToLocalPath: mapping,
      currentLocalPath: 'site/pages/index.html',
    });

    expect(result.text).toContain(
      '["https://cdn.example.net/runtime/theme.webp?v=7","/_external/https/cdn.example.net/runtime/theme.webp"]',
    );
    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('uses site-root URLs for inline CSS custom properties', () => {
    const input = {
      resourceUrl: 'https://example.com/editions/winter2026',
      urlToLocalPath: new Map([
        ['https://cdn.example.net/icon.svg?v=1', 'site/_external/https/cdn.example.net/icon.svg'],
      ]),
      currentLocalPath: 'site/editions/winter2026.html',
    };
    const result = rewriteHtml({
      ...input,
      text: `<!doctype html>
        <html>
          <head>
            <style>.icon { --mask-url: url("https://cdn.example.net/icon.svg?v=1"); }</style>
          </head>
          <body>
            <span style="--mask-url:url('https://cdn.example.net/icon.svg?v=1')"></span>
          </body>
        </html>`,
    });
    const upgraded = rewriteHtml({
      ...input,
      text: result.text.replaceAll(
        '/_external/https/cdn.example.net/icon.svg',
        '../_external/https/cdn.example.net/icon.svg',
      ),
    });

    expect(result.text).toContain('--mask-url: url("/_external/https/cdn.example.net/icon.svg")');
    expect(result.text).toContain(
      'style="--mask-url:url(&quot;/_external/https/cdn.example.net/icon.svg&quot;)"',
    );
    expect(result.text).not.toContain('../_external/https/cdn.example.net/icon.svg');
    expect(upgraded.text).toBe(result.text);
  });

  it('discovers only one representative srcset candidate when none are mapped', () => {
    const result = rewriteHtml({
      text: `<!doctype html>
        <img srcset="/images/hero-320.jpg 320w, /images/hero-960.jpg 960w, /images/hero-1280.jpg 1280w, /images/hero-2560.jpg 2560w, data:image/png;base64,AAAA 3x">
        <img srcset="/images/hero-1x.jpg 1x, /images/hero-2x.jpg 2x, /images/hero-3x.jpg 3x">`,
      resourceUrl: 'https://example.com/pages/index.html',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/pages/index.html',
    });

    expect(result.text).toContain('srcset="data:image/png;base64,AAAA 3x"');
    expect(result.text).toContain('srcset=""');
    expect(result.text).not.toContain('hero-320.jpg');
    expect(result.text).not.toContain('hero-960.jpg');
    expect(result.text).not.toContain('hero-1280.jpg');
    expect(result.text).not.toContain('hero-2560.jpg');
    expect(result.text).not.toContain('hero-1x.jpg');
    expect(result.text).not.toContain('hero-2x.jpg');
    expect(result.text).not.toContain('hero-3x.jpg');
    expect(result.unresolvedDependencies).toEqual([
      'https://example.com/images/hero-1280.jpg',
      'https://example.com/images/hero-1x.jpg',
    ]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('discovers resource hrefs without treating navigation hrefs as download dependencies', () => {
    const result = rewriteHtml({
      text: `<!doctype html>
        <link rel="stylesheet" href="/assets/missing.css">
        <meta http-equiv="refresh" content="5; url=/redirect-target.html">
        <a href="/captured-page.html">Captured</a>
        <a href="/uncaptured-page.html">Uncaptured</a>
        <svg>
          <use href="/icons/sprite.svg#logo"></use>
          <image href="/images/hero.svg"></image>
        </svg>`,
      resourceUrl: 'https://example.com/index.html',
      urlToLocalPath: new Map([
        ['https://example.com/captured-page.html', 'site/captured-page.html'],
      ]),
      currentLocalPath: 'site/index.html',
    });

    expect(result.text).toContain('href="captured-page.html"');
    expect(result.text).toContain('href="/uncaptured-page.html"');
    expect(result.text).toContain('content="5; url=/redirect-target.html"');
    expect(result.unresolvedDependencies).toEqual([
      'https://example.com/assets/missing.css',
      'https://example.com/icons/sprite.svg',
      'https://example.com/images/hero.svg',
    ]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('disables known analytics scripts while preserving application scripts', () => {
    const result = rewriteHtml({
      text: `<!doctype html>
        <script>
          window.GoogleAnalyticsObject = "ga";
          const source = "https://www.google-analytics.com/analytics.js";
        </script>
        <script src="https://www.googletagmanager.com/gtag/js?id=public"></script>
        <script>window.applicationReady = true;</script>`,
      resourceUrl: 'https://example.com/index.html',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/index.html',
    });

    expect(result.text).not.toContain('https://www.google-analytics.com/analytics.js');
    expect(result.text).not.toContain('https://www.googletagmanager.com/gtag/js');
    expect(result.text).toContain('data-webmirror-disabled="tracking"');
    expect(result.text).toContain('window.ga=window.ga||function()');
    expect(result.text).toContain('window.gtag=window.gtag||function()');
    expect(result.text).toContain('window.applicationReady = true;');
    expect(result.onlineDependencies).toEqual([]);
  });

  it('disables legacy social embed loaders without changing application scripts', () => {
    const result = rewriteHtml({
      text: `<!doctype html>
        <script>
          !function(d,s,id){
            var js,fjs=d.getElementsByTagName(s)[0];
            if(!d.getElementById(id)){
              js=d.createElement(s);
              js.id=id;
              js.src='//connect.facebook.net/en_US/sdk.js';
              fjs.parentNode.insertBefore(js,fjs);
            }
          }(document,'script','facebook-jssdk');
        </script>
        <script>
          !function(d,s,id){
            var js,fjs=d.getElementsByTagName(s)[0],p='https';
            if(!d.getElementById(id)){
              js=d.createElement(s);
              js.id=id;
              js.src=p+'://platform.twitter.com/widgets.js';
              fjs.parentNode.insertBefore(js,fjs);
            }
          }(document,'script','twitter-wjs');
        </script>
        <script src="https://apis.google.com/js/platform.js"></script>
        <script>window.applicationReady=true;</script>`,
      resourceUrl: 'https://example.com/index.html',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/index.html',
    });

    expect(result.text).not.toContain('src="http://connect.facebook.net');
    expect(result.text).not.toContain('src="https://platform.twitter.com');
    expect(result.text).not.toContain('src="https://apis.google.com');
    expect(result.text).toContain('data-webmirror-disabled="external-embed"');
    expect(result.text).toContain('window.FB=window.FB||');
    expect(result.text).toContain('window.applicationReady=true;');
    expect(result.onlineDependencies).toEqual([]);
  });

  it('keeps mapped form targets local and disables unmapped submissions', () => {
    const result = rewriteHtml({
      text: `<!doctype html>
        <form action="/saved.html">
          <button formaction="https://api.example.net/submit">Send</button>
        </form>
        <form action="/unknown-submit"></form>`,
      resourceUrl: 'https://example.com/index.html',
      urlToLocalPath: new Map([['https://example.com/saved.html', 'site/saved.html']]),
      currentLocalPath: 'site/index.html',
    });

    expect(result.text).toContain('action="saved.html"');
    expect(result.text).toContain('formaction="#"');
    expect(result.text).toContain('action="#"');
    expect(result.text).toContain('data-webmirror-disabled-action="online"');
    expect(result.onlineDependencies).toEqual([]);
  });

  it('neutralizes base and stale integrity while rewriting inline runtime references', () => {
    const result = rewriteHtml({
      text: `<!doctype html>
        <base href="https://example.com/original/">
        <link rel="canonical" href="/canonical">
        <link rel="stylesheet" href="/assets/app.css" integrity="sha384-stale">
        <script src="/assets/app.js" integrity="sha384-stale"></script>
        <script>fetch("/data/config.json");</script>
        <script type="importmap">{"imports":{"scene":"/modules/scene.js"}}</script>`,
      resourceUrl: 'https://example.com/pages/index.html',
      urlToLocalPath: new Map([
        ['https://example.com/assets/app.css', 'site/assets/app.css'],
        ['https://example.com/assets/app.js', 'site/assets/app.js'],
        ['https://example.com/data/config.json', 'site/data/config.json'],
        ['https://example.com/modules/scene.js', 'site/modules/scene.js'],
      ]),
      currentLocalPath: 'site/pages/index.html',
    });

    expect(result.text).toContain('<base href="">');
    expect(result.text).toContain('rel="canonical" href="/canonical"');
    expect(result.text).toContain('rel="stylesheet" href="../assets/app.css"');
    expect(result.text).toContain('<script src="../assets/app.js"></script>');
    expect(result.text).not.toContain('integrity=');
    expect(result.text).toContain('fetch("/data/config.json")');
    expect(result.text).toContain('"scene":"../modules/scene.js"');
    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('keeps already-localized cross-origin references stable on retry passes', () => {
    const input = {
      resourceUrl: 'https://example.com/pages/index.html',
      urlToLocalPath: new Map([
        [
          'https://cdn.example.net/assets/app.js',
          'site/_external/https/cdn.example.net/assets/app.js',
        ],
      ]),
      currentLocalPath: 'site/pages/index.html',
    };
    const first = rewriteHtml({
      ...input,
      text: '<!doctype html><script src="https://cdn.example.net/assets/app.js"></script>',
    });
    const second = rewriteHtml({
      ...input,
      text: first.text,
    });

    expect(second.text).toBe(first.text);
    expect(second.unresolvedDependencies).toEqual([]);
    expect(second.onlineDependencies).toEqual([]);
  });

  it('injects an exact runtime URL map before captured scripts', () => {
    const result = rewriteHtml({
      text: `<!doctype html>
        <html>
          <head><script src="/assets/app.js"></script></head>
          <body></body>
        </html>`,
      resourceUrl: 'https://example.com/index.html',
      urlToLocalPath: new Map([
        ['https://example.com/index.html', 'site/index.html'],
        ['https://example.com/assets/app.js', 'site/assets/app.js'],
        [
          'https://cdn.example.net/files/mud_normal.webp?v=7',
          'site/_external/https/cdn.example.net/files/mud_normal~q-0123456789ab.webp',
        ],
        [
          'https://unpkg.com/@rive-app/canvas-lite@2.26.4/rive.wasm',
          'site/_external/https/unpkg.com/@rive-app/canvas-lite@2.26.4/rive.wasm',
        ],
      ]),
      currentLocalPath: 'site/index.html',
    });

    const runtimeIndex = result.text.indexOf('<script data-webmirror-runtime="url-map-v1">');
    const applicationIndex = result.text.indexOf('<script src="assets/app.js">');

    expect(runtimeIndex).toBeGreaterThanOrEqual(0);
    expect(applicationIndex).toBeGreaterThan(runtimeIndex);
    expect(result.text).toContain(
      '["https://unpkg.com/@rive-app/canvas-lite@2.26.4/rive.wasm","/_external/https/unpkg.com/@rive-app/canvas-lite@2.26.4/rive.wasm"]',
    );
    expect(result.text).toContain(
      '["/mud_normal.webp","/_external/https/cdn.example.net/files/mud_normal~q-0123456789ab.webp"]',
    );
    expect(result.text).toContain('var sourceOrigin="https://example.com";');
    expect(result.text).toContain('function sourceCompatibleUrl(value,baseOverride)');
    expect(result.text).toContain('if(text.trim().indexOf("//")===0){sourceBase=sourceOrigin;}');
    expect(result.text).toContain(
      'localReference=mappedReference(new URL(source.pathname+source.search,sourceOrigin));',
    );
    expect(result.text).toContain('window.fetch=function(input,init)');
    expect(result.text).toContain('xhrPrototype.open=function(method,url)');
    expect(result.text).toContain('wrapWorkerConstructor("Worker")');
    expect(result.text).toContain('function localizeCssStyleDeclaration(declaration)');
    expect(result.text).toContain(
      'wrapStyleGetter(window.HTMLElement&&window.HTMLElement.prototype);',
    );
    expect(result.text).toContain('function wrapWebSocket()');
    expect(result.text).toContain('function wrapEventSource()');
    expect(result.text).toContain('wrapWebSocket();');
    expect(result.text).toContain('wrapEventSource();');
    expect(result.text).toContain('knownNonessentialTelemetryPathnames');
    expect(result.text).toContain('knownNonessentialTelemetryPathPrefixes');
    expect(result.text).toContain(
      'return nativeFetch.call(window,nonessentialNoopUrl,{method:"GET"});',
    );
    expect(result.text).toContain('(!localUrl&&isRemoteHttpUrl(url));');
    expect(result.text).not.toContain('(!localUrl&&isHttpUrl(url));');
    expect(result.text).toContain('if(isOfflineXhr(this)){return nativeXhrSend.call(this);}');
    expect(result.text).toContain('var trackingNoopUrl="data:text/javascript;charset=utf-8,');
    expect(result.text).toContain(
      'var runtimeUnavailableScriptUrl=new URL("/.webmirror/unavailable.js",location.origin).href;',
    );
    expect(result.text).toContain('return descriptor.set.call(this,runtimeUnavailableScriptUrl);');
    expect(result.text).toContain(
      'if(tagName==="script"&&name==="src"){return runtimeUnavailableScriptUrl;}',
    );
    expect(result.text).toContain('window.navigator.sendBeacon=function(_url,_data){return true;}');
    expect(result.text).toContain(
      'wrapUrlProperty(window.HTMLImageElement&&window.HTMLImageElement.prototype,"src")',
    );
    expect(result.text).toContain('String(value).trim().toLowerCase()==="about:blank"');
    expect(result.text).toContain('function wrapUrlAttributes(prototype,urlNames,srcsetNames)');
    expect(result.text).toContain(
      'wrapUrlAttributes(window.HTMLImageElement&&window.HTMLImageElement.prototype,["src"],["srcset"])',
    );
    expect(result.text).toContain('function localizeMarkup(value)');
    expect(result.text).toContain('function wrapStyleTextProperty(prototype,name)');
    expect(result.text).toContain(
      'wrapStyleTextProperty(htmlStyleElementPrototype,"textContent");',
    );
    expect(result.text).toContain('wrapStyleTextProperty(htmlStyleElementPrototype,"innerText");');
    expect(result.text).toContain('wrapStyleTextMethod(htmlStyleElementPrototype,"append",null);');
    expect(result.text).toContain('isStyleElement(this)?mapCssText(value):localizeMarkup(value)');
    expect(result.text).toContain('wrapInnerHtml(window.Element&&window.Element.prototype);');
    expect(result.text).toContain('wrapInsertAdjacentHtml();');
    expect(result.text).toContain('wrapContextualFragment();');
  });

  it('localizes mapped protocol-relative assets stored in custom data attributes', () => {
    const result = rewriteHtml({
      text: `<!doctype html><html><head></head><body
        data-model="//cdn.example.net/scenes/hero.gltf?v=7"
        data-hdr="//cdn.example.net/scenes/studio.hdr?v=8"
        data-label="hero scene"></body></html>`,
      resourceUrl: 'https://example.com/index.html',
      urlToLocalPath: new Map([
        [
          'https://cdn.example.net/scenes/hero.gltf?v=7',
          'site/_external/https/cdn.example.net/scenes/hero~q-model.gltf',
        ],
        [
          'https://cdn.example.net/scenes/studio.hdr?v=8',
          'site/_external/https/cdn.example.net/scenes/studio~q-hdr.hdr',
        ],
      ]),
      currentLocalPath: 'site/index.html',
    });

    expect(result.text).toContain(
      'data-model="/_external/https/cdn.example.net/scenes/hero~q-model.gltf"',
    );
    expect(result.text).toContain(
      'data-hdr="/_external/https/cdn.example.net/scenes/studio~q-hdr.hdr"',
    );
    expect(result.text).toContain('data-label="hero scene"');
    expect(result.onlineDependencies).toEqual([]);
  });

  it('repairs composed URLs only when they contain an exact generated local resource path', () => {
    const result = rewriteHtml({
      text: '<!doctype html><html><head></head><body></body></html>',
      resourceUrl: 'https://example.com/index.html',
      urlToLocalPath: new Map([
        [
          'https://cdn.example.net/images/arrow.png',
          'site/_external/https/cdn.example.net/images/arrow.png',
        ],
      ]),
      currentLocalPath: 'site/index.html',
    });

    expect(result.text).toContain(
      'var localReferencePathMap=new Map([["/_external/https/cdn.example.net/images/arrow.png","/_external/https/cdn.example.net/images/arrow.png"]]);',
    );
    expect(result.text).toContain('function mappedEmbeddedLocalReference(source)');
    expect(result.text).toContain(
      'localReference=mappedEmbeddedLocalReference(source)||mappedReference(source);',
    );
    expect(result.text).toContain('var localReference=localReferencePathMap.get(localPath);');
  });

  it('escapes runtime mapping data so it cannot terminate the injected script', () => {
    const unsafeLocalPath = 'site/assets/<runtime>\u2028.wasm';
    const result = rewriteHtml({
      text: '<!doctype html><title>Safe runtime map</title>',
      resourceUrl: 'https://example.com/index.html',
      urlToLocalPath: new Map([['https://example.com/runtime.wasm', unsafeLocalPath]]),
      currentLocalPath: 'site/index.html',
    });

    expect(result.text).toContain('assets/\\u003cruntime>\u005cu2028.wasm');
    expect(result.text).not.toContain('assets/<runtime>');
    expect(result.text).not.toContain('\u2028');
  });

  it('omits sensitive query values from the runtime URL map', () => {
    const result = rewriteHtml({
      text: '<!doctype html><title>Private runtime URL</title>',
      resourceUrl: 'https://example.com/index.html',
      urlToLocalPath: new Map([
        ['https://example.com/private.bin?token=do-not-store', 'site/assets/private.bin'],
        ['https://example.com/public.bin?rev=7', 'site/assets/public.bin'],
      ]),
      currentLocalPath: 'site/index.html',
    });

    expect(result.text).not.toContain('do-not-store');
    expect(result.text).not.toContain('["/private.bin","/assets/private.bin"]');
    expect(result.text).toContain('https://example.com/public.bin?rev=7');
    expect(result.text).toContain('["/public.bin","/assets/public.bin"]');
    expect(result.text).toContain('source.search===""');
    expect(result.text).toContain(
      'if(source.origin!==location.origin||source.search){return null;}',
    );
  });

  it('emits only safe timestamp-shaped runtime query aliases', () => {
    const timestampedUrl = 'https://cdn.example.net/cms/projects.json?v=CMS_DATA_1730000000000';
    const result = rewriteHtml({
      text: '<!doctype html><title>Volatile runtime URL</title>',
      resourceUrl: 'https://example.com/work',
      urlToLocalPath: new Map([
        [timestampedUrl, 'site/_external/https/cdn.example.net/cms/projects~q-captured.json'],
        [
          'https://cdn.example.net/cms/variant.json?v=light',
          'site/_external/https/cdn.example.net/cms/variant~q-light.json',
        ],
        [
          'https://cdn.example.net/cms/private.json?token=do-not-store',
          'site/_external/https/cdn.example.net/cms/private~q-secret.json',
        ],
      ]),
      currentLocalPath: 'site/work.html',
    });
    const prefix = 'var volatileQueryAliasMap=new Map(';
    const start = result.text.indexOf(prefix);
    const end = result.text.indexOf(');', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const mappings = JSON.parse(result.text.slice(start + prefix.length, end)) as Array<
      readonly [string, string]
    >;

    expect(mappings).toEqual([
      [
        JSON.stringify([
          'https://cdn.example.net',
          '/cms/projects.json',
          [['v', 'CMS_DATA_<timestamp>']],
        ]),
        '/_external/https/cdn.example.net/cms/projects~q-captured.json',
      ],
    ]);
    expect(result.text).toContain('function volatileQueryAliasKey(source)');
    expect(result.text).toContain('function mappedRoutePrefixedLocalReference(source)');
    expect(result.text).toContain('function mappedSuffixReference(source)');
    expect(result.text).toContain('var pathSuffixMap=new Map(');
    expect(result.text).not.toContain('do-not-store');
  });

  it('keeps byte-identical timestamped captures routable across replay timestamps', () => {
    const firstUrl = 'https://cdn.example.net/cms/projects.json?v=CMS_DATA_1730000000000';
    const secondUrl = 'https://cdn.example.net/cms/projects.json?v=CMS_DATA_1730000009000';
    const mapping = createDownloadedResourceUrlMap([
      {
        sourceUrl: firstUrl,
        canonicalUrl: firstUrl,
        status: 'downloaded',
        localPath: 'site/_external/https/cdn.example.net/cms/projects~q-first.json',
        contentType: 'application/json',
        size: 128,
        sha256: 'same-public-payload',
      },
      {
        sourceUrl: secondUrl,
        canonicalUrl: secondUrl,
        status: 'downloaded',
        localPath: 'site/_external/https/cdn.example.net/cms/projects~q-second.json',
        contentType: 'application/json',
        size: 128,
        sha256: 'same-public-payload',
      },
    ]);
    const result = rewriteHtml({
      text: '<!doctype html><title>Repeated volatile payload</title>',
      resourceUrl: 'https://example.com/work',
      urlToLocalPath: mapping,
      currentLocalPath: 'site/work.html',
    });
    const prefix = 'var volatileQueryAliasMap=new Map(';
    const start = result.text.indexOf(prefix);
    const end = result.text.indexOf(');', start);
    const mappings = JSON.parse(result.text.slice(start + prefix.length, end)) as Array<
      readonly [string, string]
    >;

    expect(mappings).toEqual([
      [
        JSON.stringify([
          'https://cdn.example.net',
          '/cms/projects.json',
          [['v', 'CMS_DATA_<timestamp>']],
        ]),
        '/_external/https/cdn.example.net/cms/projects~q-first.json',
      ],
    ]);
  });

  it('does not alias timestamped captures when their payloads differ', () => {
    const mapping = createDownloadedResourceUrlMap([
      {
        sourceUrl: 'https://cdn.example.net/cms/projects.json?v=CMS_DATA_1730000000000',
        canonicalUrl: 'https://cdn.example.net/cms/projects.json?v=CMS_DATA_1730000000000',
        status: 'downloaded',
        localPath: 'site/_external/https/cdn.example.net/cms/projects~q-first.json',
        contentType: 'application/json',
        size: 128,
        sha256: 'first-public-payload',
      },
      {
        sourceUrl: 'https://cdn.example.net/cms/projects.json?v=CMS_DATA_1730000009000',
        canonicalUrl: 'https://cdn.example.net/cms/projects.json?v=CMS_DATA_1730000009000',
        status: 'downloaded',
        localPath: 'site/_external/https/cdn.example.net/cms/projects~q-second.json',
        contentType: 'application/json',
        size: 256,
        sha256: 'second-public-payload',
      },
    ]);
    const result = rewriteHtml({
      text: '<!doctype html><title>Changed volatile payload</title>',
      resourceUrl: 'https://example.com/work',
      urlToLocalPath: mapping,
      currentLocalPath: 'site/work.html',
    });

    expect(result.text).toContain('var volatileQueryAliasMap=new Map([]);');
  });

  it('does not use pathname aliases for a different query-qualified resource', () => {
    const result = rewriteHtml({
      text: '<!doctype html><img id="dark" src="/assets/theme.bin?variant=dark"><img id="plain" src="/assets/theme.bin">',
      resourceUrl: 'https://example.com/index.html',
      urlToLocalPath: new Map([
        ['https://example.com/assets/theme.bin?variant=light', 'site/assets/theme~q-light.bin'],
      ]),
      currentLocalPath: 'site/index.html',
    });

    expect(result.text).toContain('id="dark" src="/assets/theme.bin?variant=dark"');
    expect(result.text).toContain('id="plain" src="assets/theme~q-light.bin"');
  });
});

describe('rewriteCss', () => {
  it('rewrites url() and both @import forms while reporting unmapped dependencies', () => {
    const result = rewriteCss({
      text: `
        @import "https://cdn.example.net/css/theme.css?v=2" layer(base);
        @import url("./print.css?media=print") print;
        .hero {
          background: url("../images/bg.png#hero");
          mask: url(#mask);
          cursor: url(data:image/png;base64,AAAA);
        }
        .remote { background-image: url("https://assets.unknown.example/pixel.png?x=1"); }
        .missing { background-image: url("../images/missing.png"); }
      `,
      resourceUrl: 'https://example.com/css/app/main.css',
      urlToLocalPath: new Map([
        [
          'https://cdn.example.net/css/theme.css?v=2',
          'site/_external/https/cdn.example.net/css/theme~q-v2.css',
        ],
        ['https://example.com/css/app/print.css?media=print', 'site/css/app/print~q-print.css'],
        ['https://example.com/css/images/bg.png', 'site/css/images/bg.png'],
      ]),
      currentLocalPath: 'site/css/app/main.css',
    });

    expect(result.text).toContain(
      '@import "../../_external/https/cdn.example.net/css/theme~q-v2.css" layer(base)',
    );
    expect(result.text).toContain('@import url("print~q-print.css") print');
    expect(result.text).toContain('background: url("../images/bg.png#hero")');
    expect(result.text).toContain('mask: url(#mask)');
    expect(result.text).toContain('cursor: url(data:image/png;base64,AAAA)');
    expect(result.unresolvedDependencies).toEqual(['https://example.com/css/images/missing.png']);
    expect(result.onlineDependencies).toEqual(['https://assets.unknown.example/pixel.png?x=1']);
  });
});

describe('rewriteJson', () => {
  it('traverses nested string values without changing ordinary strings', () => {
    const input = {
      model: '../../assets/model.glb?rev=7#mesh',
      thumbnail: 'thumb.jpg',
      nested: {
        cdn: 'https://cdn.example.net/audio/theme.mp3?rev=4#loop',
        missing: './missing.bin',
      },
      online: 'https://api.unknown.example/v1/state?session=public#latest',
      inline: 'data:application/octet-stream;base64,AAAA',
      label: 'hero',
    };
    const result = rewriteJson({
      text: `${JSON.stringify(input, null, 2)}\n`,
      resourceUrl: 'https://example.com/data/config/manifest.json?build=1',
      urlToLocalPath: {
        'https://example.com/assets/model.glb?rev=7': 'site/assets/model~q-rev.glb',
        'https://example.com/data/config/thumb.jpg': 'site/data/config/thumb.jpg',
        'https://cdn.example.net/audio/theme.mp3?rev=4':
          'site/_external/https/cdn.example.net/audio/theme~q-rev.mp3',
      },
      currentLocalPath: 'site/data/config/manifest~q-build.json',
    });
    const rewritten = JSON.parse(result.text) as typeof input;

    expect(rewritten).toEqual({
      model: '../../assets/model~q-rev.glb#mesh',
      thumbnail: 'thumb.jpg',
      nested: {
        cdn: '../../_external/https/cdn.example.net/audio/theme~q-rev.mp3#loop',
        missing: './missing.bin',
      },
      online: 'https://api.unknown.example/v1/state?session=public#latest',
      inline: 'data:application/octet-stream;base64,AAAA',
      label: 'hero',
    });
    expect(result.text.endsWith('\n')).toBe(true);
    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('discovers nested asset-manifest references without treating ordinary strings as URLs', () => {
    const result = rewriteJson({
      text: JSON.stringify({
        meta: { image: 'atlas.png' },
        buffers: [{ uri: '../../geometry/scene.bin' }],
        frames: [{ filename: 'frame-0001.png', src: './thumbnail.webp' }],
        assets: { hero: '/images/hero.png' },
        optional: './not-requested.png',
        endpoint: { url: '/api/current' },
        label: 'intro',
      }),
      resourceUrl: 'https://example.com/images/sprites/atlas.json',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/images/sprites/atlas.json',
    });

    expect(result.unresolvedDependencies).toEqual([
      'https://example.com/images/sprites/atlas.png',
      'https://example.com/geometry/scene.bin',
      'https://example.com/images/sprites/thumbnail.webp',
      'https://example.com/images/hero.png',
    ]);
    expect(result.onlineDependencies).toEqual([]);
    expect(JSON.parse(result.text)).toMatchObject({
      optional: './not-requested.png',
      endpoint: { url: '/api/current' },
      label: 'intro',
    });

    const localized = rewriteJson({
      text: result.text,
      resourceUrl: 'https://example.com/images/sprites/atlas.json',
      urlToLocalPath: new Map([
        ['https://example.com/images/sprites/atlas.png', 'site/images/sprites/atlas.png'],
      ]),
      currentLocalPath: 'site/images/sprites/atlas.json',
    });

    expect(JSON.parse(localized.text)).toMatchObject({
      meta: { image: 'atlas.png' },
      frames: [{ filename: 'frame-0001.png' }],
    });
  });

  it('discovers and localizes runtime manifest fields relative to the JSON file directory', () => {
    const input = {
      entry: {
        module: 'entry.client.js',
        modules: ['routes/root.js'],
        import: './runtime.js',
        imports: ['vendor.js', 'react', '@scope/package'],
        chunk: 'chunks/scene.js',
        chunks: ['../shared.js'],
        css: ['styles/app.css'],
        stylesheet: 'theme.css',
        stylesheets: ['./print.css'],
      },
      navigation: {
        id: 'route-id.js',
        path: 'routes/home.js',
        href: 'next.html',
        url: 'docs.html',
        route: 'route.js',
      },
    };
    const resourceUrl = 'https://example.com/build/assets/manifest.json';
    const currentLocalPath = 'site/build/assets/manifest.json';
    const dependencies = [
      'https://example.com/build/assets/entry.client.js',
      'https://example.com/build/assets/routes/root.js',
      'https://example.com/build/assets/runtime.js',
      'https://example.com/build/assets/vendor.js',
      'https://example.com/build/assets/chunks/scene.js',
      'https://example.com/build/shared.js',
      'https://example.com/build/assets/styles/app.css',
      'https://example.com/build/assets/theme.css',
      'https://example.com/build/assets/print.css',
    ];
    const discovered = rewriteJson({
      text: JSON.stringify(input),
      resourceUrl,
      urlToLocalPath: new Map(),
      currentLocalPath,
    });

    expect(discovered.unresolvedDependencies).toEqual(dependencies);
    expect(discovered.onlineDependencies).toEqual([]);

    const localized = rewriteJson({
      text: JSON.stringify(input),
      resourceUrl,
      urlToLocalPath: new Map([
        [dependencies[0]!, 'site/runtime/entry.client.js'],
        [dependencies[1]!, 'site/runtime/root.js'],
        [dependencies[2]!, 'site/runtime/runtime.js'],
        [dependencies[3]!, 'site/runtime/vendor.js'],
        [dependencies[4]!, 'site/runtime/scene.js'],
        [dependencies[5]!, 'site/runtime/shared.js'],
        [dependencies[6]!, 'site/runtime/app.css'],
        [dependencies[7]!, 'site/runtime/theme.css'],
        [dependencies[8]!, 'site/runtime/print.css'],
      ]),
      currentLocalPath,
    });

    expect(JSON.parse(localized.text)).toEqual({
      entry: {
        module: '/runtime/entry.client.js',
        modules: ['/runtime/root.js'],
        import: '/runtime/runtime.js',
        imports: ['/runtime/vendor.js', 'react', '@scope/package'],
        chunk: '/runtime/scene.js',
        chunks: ['/runtime/shared.js'],
        css: ['/runtime/app.css'],
        stylesheet: '/runtime/theme.css',
        stylesheets: ['/runtime/print.css'],
      },
      navigation: input.navigation,
    });
    expect(localized.unresolvedDependencies).toEqual([]);
    expect(localized.onlineDependencies).toEqual([]);
  });

  it('uses known mappings to disambiguate bare JSON asset paths', () => {
    const result = rewriteJson({
      text: JSON.stringify({
        image: 'images/covers/relative.png',
      }),
      resourceUrl: 'https://example.com/images/config/manifest.json',
      urlToLocalPath: new Map([
        [
          'https://example.com/images/config/images/covers/relative.png',
          'site/assets/relative.png',
        ],
      ]),
      currentLocalPath: 'site/images/config/manifest.json',
    });

    expect(JSON.parse(result.text)).toEqual({
      image: '../../assets/relative.png',
    });
    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('uses standard document-relative semantics for unmapped bare JSON assets', () => {
    const result = rewriteJson({
      text: JSON.stringify({
        image: 'images/a.png',
      }),
      resourceUrl: 'https://example.com/images/config/manifest.json',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/images/config/manifest.json',
    });

    expect(result.unresolvedDependencies).toEqual([
      'https://example.com/images/config/images/a.png',
    ]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('maps a uniquely proven path suffix when a runtime drops a deployment prefix', () => {
    const result = rewriteHtml({
      text: '<!doctype html><script src="/assets/app.js"></script>',
      resourceUrl: 'https://example.com/work',
      urlToLocalPath: new Map([
        ['https://example.com/assets/app.js', 'site/assets/app.js'],
        ['https://example.com/assets/images/pbr/road.ktx2', 'site/assets/images/pbr/road.ktx2'],
      ]),
      currentLocalPath: 'site/work.html',
    });

    expect(result.text).toContain('["/images/pbr/road.ktx2","/assets/images/pbr/road.ktx2"]');
    expect(result.text).toContain(
      'if(!localReference){localReference=mappedSuffixReference(source);}',
    );
  });

  it('does not emit an ambiguous shortened path suffix', () => {
    const result = rewriteHtml({
      text: '<!doctype html><script src="/assets/app.js"></script>',
      resourceUrl: 'https://example.com/work',
      urlToLocalPath: new Map([
        ['https://example.com/assets/app.js', 'site/assets/app.js'],
        ['https://example.com/assets/a/shared.png', 'site/assets/a/shared.png'],
        ['https://example.com/assets/b/shared.png', 'site/assets/b/shared.png'],
      ]),
      currentLocalPath: 'site/work.html',
    });

    expect(result.text).not.toContain('["/shared.png",');
    expect(result.text).toContain('["/a/shared.png","/assets/a/shared.png"]');
    expect(result.text).toContain('["/b/shared.png","/assets/b/shared.png"]');
  });

  it('uses a unique known same-origin suffix for config-relative asset paths', () => {
    const result = rewriteJson({
      text: JSON.stringify({
        image: 'assets/images/pbr/road.ktx2',
      }),
      resourceUrl: 'https://example.com/assets/data/runtime.json',
      urlToLocalPath: new Map(),
      knownResourceUrls: ['https://example.com/assets/images/pbr/road.ktx2'],
      currentLocalPath: 'site/assets/data/runtime.json',
    });

    expect(result.unresolvedDependencies).toEqual([
      'https://example.com/assets/images/pbr/road.ktx2',
    ]);
    expect(result.unresolvedDependencies).not.toContain(
      'https://example.com/assets/data/assets/images/pbr/road.ktx2',
    );
  });

  it('uses a unique known same-origin basename when a config repeats deployment directories', () => {
    const result = rewriteJson({
      text: JSON.stringify({
        geometry: {
          filename: 'caustic-plane.bin',
          relative: 'legacy.bin',
          src: 'legacy.bin/caustic-plane.bin',
        },
      }),
      resourceUrl: 'https://example.com/assets/data/runtime.json',
      urlToLocalPath: new Map(),
      knownResourceUrls: ['https://example.com/assets/geometry/room/caustic-plane.bin'],
      currentLocalPath: 'site/assets/data/runtime.json',
    });

    expect(result.unresolvedDependencies).toEqual([
      'https://example.com/assets/geometry/room/caustic-plane.bin',
    ]);
    expect(result.unresolvedDependencies).not.toContain(
      'https://example.com/assets/data/legacy.bin/caustic-plane.bin',
    );
  });

  it('does not basename-match an ordinary JSON src field without descriptor evidence', () => {
    const result = rewriteJson({
      text: JSON.stringify({
        src: 'legacy.bin/scene.bin',
      }),
      resourceUrl: 'https://example.com/assets/data/runtime.json',
      urlToLocalPath: new Map(),
      knownResourceUrls: ['https://example.com/assets/geometry/room/scene.bin'],
      currentLocalPath: 'site/assets/data/runtime.json',
    });

    expect(result.unresolvedDependencies).toEqual([
      'https://example.com/assets/data/legacy.bin/scene.bin',
    ]);
  });

  it('keeps standard config-relative semantics when known basenames are ambiguous', () => {
    const result = rewriteJson({
      text: JSON.stringify({
        src: 'legacy.bin/scene.bin',
      }),
      resourceUrl: 'https://example.com/assets/data/runtime.json',
      urlToLocalPath: new Map(),
      knownResourceUrls: [
        'https://example.com/assets/geometry/a/scene.bin',
        'https://example.com/assets/geometry/b/scene.bin',
      ],
      currentLocalPath: 'site/assets/data/runtime.json',
    });

    expect(result.unresolvedDependencies).toEqual([
      'https://example.com/assets/data/legacy.bin/scene.bin',
    ]);
  });

  it('matches a cache-marked bare path to the unique known queryless resource', () => {
    const result = rewriteJson({
      text: JSON.stringify({
        src: 'assets/images/pbr/road.png?1704405926050-compressedKtx2',
      }),
      resourceUrl: 'https://example.com/assets/data/runtime.json',
      urlToLocalPath: new Map(),
      knownResourceUrls: ['https://example.com/assets/images/pbr/road.png'],
      currentLocalPath: 'site/assets/data/runtime.json',
    });

    expect(result.unresolvedDependencies).toEqual([
      'https://example.com/assets/images/pbr/road.png',
    ]);
    expect(result.unresolvedDependencies).not.toContain(
      'https://example.com/assets/data/assets/images/pbr/road.png?1704405926050-compressedKtx2',
    );
  });

  it('does not strip an ordinary or sensitive query to force a known-path match', () => {
    const ordinary = rewriteJson({
      text: JSON.stringify({ src: 'assets/images/road.png?variant=night' }),
      resourceUrl: 'https://example.com/assets/data/runtime.json',
      urlToLocalPath: new Map(),
      knownResourceUrls: ['https://example.com/assets/images/road.png'],
      currentLocalPath: 'site/assets/data/runtime.json',
    });
    const sensitive = rewriteJson({
      text: JSON.stringify({ src: 'assets/images/road.png?token=private' }),
      resourceUrl: 'https://example.com/assets/data/runtime.json',
      urlToLocalPath: new Map(),
      knownResourceUrls: ['https://example.com/assets/images/road.png'],
      currentLocalPath: 'site/assets/data/runtime.json',
    });

    expect(ordinary.unresolvedDependencies).toEqual([
      'https://example.com/assets/data/assets/images/road.png?variant=night',
    ]);
    expect(sensitive.unresolvedDependencies).toEqual([
      'https://example.com/assets/data/assets/images/road.png?token=private',
    ]);
  });

  it('keeps standard config-relative semantics when known suffixes are ambiguous', () => {
    const result = rewriteJson({
      text: JSON.stringify({
        image: 'assets/images/road.png',
      }),
      resourceUrl: 'https://example.com/data/runtime.json',
      urlToLocalPath: new Map(),
      knownResourceUrls: [
        'https://example.com/v1/assets/images/road.png',
        'https://example.com/v2/assets/images/road.png',
      ],
      currentLocalPath: 'site/data/runtime.json',
    });

    expect(result.unresolvedDependencies).toEqual([
      'https://example.com/data/assets/images/road.png',
    ]);
  });

  it('recognizes repeated leading directories as a site-root JSON reference', () => {
    const result = rewriteJson({
      text: JSON.stringify({
        image: 'images/sprites/atlas.png',
      }),
      resourceUrl: 'https://example.com/images/sprites/atlas.json',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/images/sprites/atlas.json',
    });

    expect(result.unresolvedDependencies).toEqual(['https://example.com/images/sprites/atlas.png']);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('prefers standard relative JSON semantics when both candidate mappings exist', () => {
    const result = rewriteJson({
      text: JSON.stringify({
        image: 'images/a.png',
      }),
      resourceUrl: 'https://example.com/images/config/manifest.json',
      urlToLocalPath: new Map([
        ['https://example.com/images/config/images/a.png', 'site/assets/relative-a.png'],
        ['https://example.com/images/a.png', 'site/assets/root-a.png'],
      ]),
      currentLocalPath: 'site/images/config/manifest.json',
    });

    expect(JSON.parse(result.text)).toEqual({
      image: '../../assets/relative-a.png',
    });
    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('propagates asset-container semantics through nested arrays and grouping objects', () => {
    const result = rewriteJson({
      text: JSON.stringify({
        assets: [
          ['images/a.png'],
          {
            group: {
              hero: 'images/b.png',
            },
          },
        ],
      }),
      resourceUrl: 'https://example.com/data/manifest.json',
      urlToLocalPath: new Map([
        ['https://example.com/images/a.png', 'site/images/a.png'],
        ['https://example.com/images/b.png', 'site/images/b.png'],
      ]),
      currentLocalPath: 'site/data/manifest.json',
    });

    expect(JSON.parse(result.text)).toEqual({
      assets: [
        ['/images/a.png'],
        {
          group: {
            hero: '/images/b.png',
          },
        },
      ],
    });
    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('keeps nested resource groups inside mixed asset containers', () => {
    const result = rewriteJson({
      text: JSON.stringify({
        assets: {
          image: 'images/hero.png',
          variants: {
            desktop: 'images/desktop.png',
          },
          url: 'https://artist.example/profile.html',
        },
      }),
      resourceUrl: 'https://example.com/data/manifest.json',
      urlToLocalPath: new Map([
        ['https://example.com/data/images/hero.png', 'site/images/hero.png'],
        ['https://example.com/data/images/desktop.png', 'site/images/desktop.png'],
      ]),
      currentLocalPath: 'site/data/manifest.json',
    });

    expect(JSON.parse(result.text)).toEqual({
      assets: {
        image: '../images/hero.png',
        variants: {
          desktop: '../images/desktop.png',
        },
        url: 'https://artist.example/profile.html',
      },
    });
    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('keeps nonstandard scalar variants inside mixed asset containers', () => {
    const result = rewriteJson({
      text: JSON.stringify({
        assets: {
          image: 'hero.png',
          desktop: 'desktop.png',
          mobile: 'mobile.png',
        },
      }),
      resourceUrl: 'https://example.com/data/manifest.json',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/data/manifest.json',
    });

    expect(result.unresolvedDependencies).toEqual([
      'https://example.com/data/hero.png',
      'https://example.com/data/desktop.png',
      'https://example.com/data/mobile.png',
    ]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('rewrites exact extensionless JSON mappings before applying asset-shape heuristics', () => {
    const result = rewriteJson({
      text: JSON.stringify({
        image: '/media/hero',
      }),
      resourceUrl: 'https://example.com/data/manifest.json',
      urlToLocalPath: new Map([['https://example.com/media/hero', 'site/assets/hero.bin']]),
      currentLocalPath: 'site/data/manifest.json',
    });

    expect(JSON.parse(result.text)).toEqual({
      image: '/assets/hero.bin',
    });
    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('does not propagate asset-container semantics into nested navigation objects', () => {
    const result = rewriteJson({
      text: JSON.stringify({
        assets: [
          {
            url: 'https://artist.example/profile.html',
            image: 'images/covers/artist.png',
          },
        ],
      }),
      resourceUrl: 'https://example.com/data/manifest.json',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/data/manifest.json',
    });

    expect(result.unresolvedDependencies).toEqual([
      'https://example.com/data/images/covers/artist.png',
    ]);
    expect(result.onlineDependencies).toEqual([]);
    expect(JSON.parse(result.text)).toMatchObject({
      assets: [{ url: 'https://artist.example/profile.html' }],
    });
  });

  it('rejects JSON structures deeper than the bounded rewrite budget', () => {
    let nested: unknown = 'images/final.png';

    for (let depth = 0; depth < 300; depth += 1) {
      nested = { assets: nested };
    }

    expect(() =>
      rewriteJson({
        text: JSON.stringify(nested),
        resourceUrl: 'https://example.com/data/manifest.json',
        urlToLocalPath: new Map(),
        currentLocalPath: 'site/data/manifest.json',
      }),
    ).toThrow('JSON nesting exceeds');
  });
});

describe('rewriteJavaScript', () => {
  it('injects runtime URL mapping only for worker-context scripts', () => {
    const source = `"use strict";
const runtimeRoot = "https://cdn.example.net/assets/";
importScripts(runtimeRoot + "worker-runtime.js");
fetch(runtimeRoot + "model.bin");
`;
    const input = {
      text: source,
      resourceUrl: 'https://cdn.example.net/assets/worker.js',
      urlToLocalPath: new Map([
        [
          'https://cdn.example.net/assets/worker-runtime.js',
          'site/_external/https/cdn.example.net/assets/worker-runtime.js',
        ],
        [
          'https://cdn.example.net/assets/model.bin',
          'site/_external/https/cdn.example.net/assets/model.bin',
        ],
        [
          'https://cdn.example.net/cms/projects.json?v=CMS_DATA_1730000000000',
          'site/_external/https/cdn.example.net/cms/projects~q-captured.json',
        ],
      ]),
      currentLocalPath: 'site/_external/https/cdn.example.net/assets/worker.js',
    };
    const documentResult = rewriteJavaScript(input);
    const workerResult = rewriteJavaScript({
      ...input,
      workerContext: true,
    });

    expect(documentResult.text).toBe(source);
    expect(workerResult.text).toContain('"use strict";\n/* webmirror-worker-runtime-url-map-v1 */');
    expect(workerResult.text).toContain('global.fetch=function(input,init)');
    expect(workerResult.text).toContain('global.importScripts=function()');
    expect(workerResult.text).toContain('global.__webmirrorMapModuleUrl=function(value,baseUrl)');
    expect(workerResult.text).toContain('wrapWorkerConstructor("Worker")');
    expect(workerResult.text).toContain('var volatileQueryAliasMap=new Map(');
    expect(workerResult.text).toContain('function volatileQueryAliasKey(source)');
    expect(workerResult.text).toContain('function mappedRoutePrefixedLocalReference(source)');
    expect(workerResult.text).toContain(
      'var sourceBaseUrl="https://cdn.example.net/assets/worker.js";',
    );
    expect(workerResult.text).toContain('var localReferencePathMap=new Map(');
    expect(workerResult.text).toContain('function mappedEmbeddedLocalReference(source)');
    expect(workerResult.text).toContain(
      'var sourceBase=baseOverride||sourceBaseUrl||(global.location&&global.location.href)||sourceOrigin;',
    );
    expect(workerResult.text).toContain('function isKnownNonessentialUrl(value)');
    expect(workerResult.text).toContain('function isRemoteHttpUrl(value,baseOverride)');
    expect(workerResult.text).toContain('function isHttpUrl(value,baseOverride)');
    expect(workerResult.text).toContain(
      'if(!localUrl&&isRemoteHttpUrl(requestUrl)){\n      return offlineFetchResponse();',
    );
    expect(workerResult.text).toContain(
      'return isRemoteHttpUrl(value)?runtimeNoopScriptUrl:value;',
    );
    expect(workerResult.text).toContain('hostname=url.hostname.toLowerCase().replace(/\\.$/,"");');
    expect(workerResult.text).toContain(
      'return nativeFetch.call(global,nonessentialNoopUrl,{method:"GET"});',
    );
    expect(workerResult.text).toContain('(!localUrl&&isRemoteHttpUrl(url));');
    expect(workerResult.text).not.toContain('(!localUrl&&isHttpUrl(url));');
    expect(workerResult.text).toContain('if(isOfflineXhr(this)){return nativeXhrSend.call(this);}');
    expect(workerResult.text).toContain('source.search===""');
    expect(workerResult.text).toContain(
      '["https://cdn.example.net/assets/model.bin","/_external/https/cdn.example.net/assets/model.bin"]',
    );
    expect(workerResult.text).toContain('importScripts(runtimeRoot + "worker-runtime.js")');
  });

  it('injects offline network containment into workers without mapped dependencies', () => {
    const result = rewriteJavaScript({
      text: 'fetch(runtimeUrl);',
      resourceUrl: 'https://example.test/assets/worker.js',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/assets/worker.js',
      workerContext: true,
    });

    expect(result.text).toContain('/* webmirror-worker-runtime-url-map-v1 */');
    expect(result.text).toContain('var urlMap=new Map([]);');
    expect(result.text).toContain('function isRemoteHttpUrl(value,baseOverride)');
    expect(result.text).toContain('return offlineFetchResponse();');
  });

  it('preserves marker text that is not a structurally generated top-level bootstrap', () => {
    const source = [
      '/* webmirror-worker-runtime-url-map-v1 */',
      'postMessage("ordinary marker comment");',
      '/* /webmirror-worker-runtime-url-map-v1 */',
      'const markerString = "/* webmirror-worker-runtime-url-map-v1 */";',
      'const markerTemplate = `/* webmirror-worker-runtime-url-map-v1 */`;',
      'const markerPattern = /\\/\\* webmirror-worker-runtime-url-map-v1 \\*\\//;',
      'postMessage(markerString + markerTemplate + markerPattern.source);',
    ].join('\n');
    const result = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://example.test/assets/worker.js',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/assets/worker.js',
      workerContext: true,
    });

    expect(result.text).toContain('postMessage("ordinary marker comment");');
    expect(result.text).toContain(
      'const markerString = "/* webmirror-worker-runtime-url-map-v1 */";',
    );
    expect(result.text).toContain(
      'const markerTemplate = `/* webmirror-worker-runtime-url-map-v1 */`;',
    );
    expect(result.text).toContain(
      'const markerPattern = /\\/\\* webmirror-worker-runtime-url-map-v1 \\*\\//;',
    );
  });

  it('refreshes legacy and duplicate generated worker bootstraps without touching user code', () => {
    const marker = '/* webmirror-worker-runtime-url-map-v1 */';
    const endMarker = '/* /webmirror-worker-runtime-url-map-v1 */';
    const input = {
      text: '"use strict";\npostMessage("user worker code");\n',
      resourceUrl: 'https://example.test/assets/worker.js',
      urlToLocalPath: new Map([
        ['https://example.test/assets/runtime.js', 'site/assets/runtime.js'],
      ]),
      currentLocalPath: 'site/assets/worker.js',
      workerContext: true,
    };
    const first = rewriteJavaScript(input);
    const markerIndex = first.text.indexOf(marker);
    const endMarkerIndex = first.text.indexOf(endMarker, markerIndex);
    const bootstrapEnd = endMarkerIndex + endMarker.length;
    const bootstrap = first.text.slice(markerIndex, bootstrapEnd);
    const duplicateText = `${first.text.slice(0, markerIndex)}${bootstrap}\n${bootstrap}${first.text.slice(bootstrapEnd)}`;
    const refreshedDuplicate = rewriteJavaScript({ ...input, text: duplicateText });
    const legacyText = first.text.replace(`\n${endMarker}`, '');
    const refreshedLegacy = rewriteJavaScript({ ...input, text: legacyText });

    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(endMarkerIndex).toBeGreaterThan(markerIndex);
    expect(refreshedDuplicate.text).toBe(first.text);
    expect(refreshedLegacy.text).toBe(first.text);
    expect(
      refreshedDuplicate.text.match(/\/\* webmirror-worker-runtime-url-map-v1 \*\//gu),
    ).toHaveLength(1);
    expect(refreshedDuplicate.text).toContain('postMessage("user worker code");');
  });

  it('is idempotent for worker runtime URL consumers and dynamic imports', () => {
    const input = {
      text: `"use strict";
        const runtimeRoot = "https://cdn.example.net/assets/";
        const chunkName = "scene-module.js";
        const workerName = "scene-worker.js";
        const sharedWorkerName = "shared-worker.js";
        const supportName = "support.js";
        import(runtimeRoot + chunkName);
        new Worker(runtimeRoot + workerName, { type: "module" });
        new SharedWorker(runtimeRoot + sharedWorkerName);
        importScripts(runtimeRoot + supportName);
      `,
      resourceUrl: 'https://cdn.example.net/assets/worker-entry.js',
      urlToLocalPath: new Map([
        [
          'https://cdn.example.net/assets/scene-module.js',
          'site/_external/https/cdn.example.net/assets/scene-module.js',
        ],
        [
          'https://cdn.example.net/assets/scene-worker.js',
          'site/_external/https/cdn.example.net/assets/scene-worker.js',
        ],
        [
          'https://cdn.example.net/assets/shared-worker.js',
          'site/_external/https/cdn.example.net/assets/shared-worker.js',
        ],
        [
          'https://cdn.example.net/assets/support.js',
          'site/_external/https/cdn.example.net/assets/support.js',
        ],
      ]),
      currentLocalPath: 'site/_external/https/cdn.example.net/assets/worker-entry.js',
      workerContext: true,
    };
    const first = rewriteJavaScript(input);
    const second = rewriteJavaScript({ ...input, text: first.text });

    expect(first.text).toContain('import(globalThis.__webmirrorMapModuleUrl(');
    expect(second.text).toBe(first.text);
  });

  it('wraps runtime-composed dynamic imports only when a local URL map exists', () => {
    const source = `
      const runtimeRoot = "https://cdn.example.net/assets/";
      const manifest = { chunk: "scene-module.js" };
      const scene = import(runtimeRoot + manifest.chunk);
    `;
    const result = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://cdn.example.net/assets/app.js',
      urlToLocalPath: new Map([
        [
          'https://cdn.example.net/assets/scene-module.js',
          'site/_external/https/cdn.example.net/assets/scene-module.js',
        ],
      ]),
      currentLocalPath: 'site/_external/https/cdn.example.net/assets/app.js',
    });

    expect(result.text).toContain(
      'import(globalThis.__webmirrorMapModuleUrl(runtimeRoot + manifest.chunk,"https://cdn.example.net/assets/app.js"))',
    );
    expect(result.text).toContain('const manifest = { chunk: "scene-module.js" };');
    expect(result.text).not.toContain(
      'const manifest = { chunk: "/_external/https/cdn.example.net/assets/scene-module.js" };',
    );
    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('preserves mapped asset manifest leaves when a runtime base URL composes them', () => {
    const source = `
      const assetBase = "https://cdn.example.net/assets/";
      const manifest = {
        imageLeaf: "./images/composed.png",
        shaderPath: "../shaders/scene.frag",
      };
      const image = new Image();
      image.src = assetBase + manifest.imageLeaf;
      shaderLoader.load(assetBase + manifest.shaderPath);
    `;
    const result = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://cdn.example.net/assets/app.js',
      urlToLocalPath: new Map([
        [
          'https://cdn.example.net/assets/images/composed.png',
          'site/_external/https/cdn.example.net/assets/images/composed.png',
        ],
        [
          'https://cdn.example.net/shaders/scene.frag',
          'site/_external/https/cdn.example.net/shaders/scene.frag',
        ],
      ]),
      currentLocalPath: 'site/_external/https/cdn.example.net/assets/app.js',
    });

    expect(result.text).toContain('imageLeaf: "./images/composed.png"');
    expect(result.text).toContain('shaderPath: "../shaders/scene.frag"');
    expect(result.text).not.toContain(
      'imageLeaf: "/_external/https/cdn.example.net/assets/images/composed.png"',
    );
    expect(result.text).not.toContain(
      'shaderPath: "/_external/https/cdn.example.net/shaders/scene.frag"',
    );
    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('does not serialize sensitive source script queries into dynamic import wrappers', () => {
    const source = `
      const runtimeRoot = "https://cdn.example.net/assets/";
      const manifest = { chunk: "scene-module.js" };
      const scene = import(runtimeRoot + manifest.chunk);
    `;
    const result = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://cdn.example.net/assets/app.js?token=do-not-store',
      urlToLocalPath: new Map([
        [
          'https://cdn.example.net/assets/scene-module.js',
          'site/_external/https/cdn.example.net/assets/scene-module.js',
        ],
      ]),
      currentLocalPath: 'site/_external/https/cdn.example.net/assets/app.js',
    });

    expect(result.text).toContain(
      'import(globalThis.__webmirrorMapModuleUrl(runtimeRoot + manifest.chunk,"https://cdn.example.net/assets/app.js"))',
    );
    expect(result.text).not.toContain('do-not-store');
  });

  it('uses the Acorn AST for static strings and preserves dynamic expressions', () => {
    const source = `
      import config from "./config.json?build=2";
      export { helper } from "../shared/util.js";
      const chunk = import("./chunks/scene.js?rev=1#chunk");
      const worker = new Worker("./worker.js");
      const texture = new URL("../../textures/albedo.png?rev=3#diffuse", import.meta.url);
      const dynamicTexture = new URL(texturePath, import.meta.url);
      const model = "https://cdn.example.net/models/scene.glb?rev=7#mesh";
      const theme = \`./audio/theme.mp3\`;
      const response = fetch("/data/config.json?mode=full");
      const missing = fetch("./missing.json");
      const api = fetch("/api");
      const submit = fetch("/submit.json", { method: "POST" });
      const dynamicRequest = fetch("/dynamic.json", requestOptions);
      const events = new EventSource("/events.json");
      const external = "https://api.unknown.example/live?x=1#stream";
      const undeclaredAsset = "./not-loaded.png";
      const geometry = assetLoader.load("mountain.drc");
      const optionalTranscoder = a.loadAsync("basis_transcoder.js");
      const rootSeparator = "/";
      const namespaceSeparator = ".";
      const relativePrefix = "./";
      const computed = base + "/dynamic.bin";
      const lookup = { "https://cdn.example.net/models/scene.glb?rev=7#mesh": true };
    `;
    const result = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://example.com/scripts/app/main.js?build=9',
      urlToLocalPath: new Map([
        [
          'https://example.com/scripts/app/config.json?build=2',
          'site/scripts/app/config~q-build.json',
        ],
        ['https://example.com/scripts/shared/util.js', 'site/scripts/shared/util.js'],
        [
          'https://example.com/scripts/app/chunks/scene.js?rev=1',
          'site/scripts/app/chunks/scene~q-rev.js',
        ],
        ['https://example.com/scripts/app/worker.js', 'site/scripts/app/worker.js'],
        ['https://example.com/textures/albedo.png?rev=3', 'site/textures/albedo~q-rev.png'],
        [
          'https://cdn.example.net/models/scene.glb?rev=7',
          'site/_external/https/cdn.example.net/models/scene~q-rev.glb',
        ],
        ['https://example.com/scripts/app/audio/theme.mp3', 'site/scripts/app/audio/theme.mp3'],
        ['https://example.com/data/config.json?mode=full', 'site/data/config~q-full.json'],
        ['https://example.com/submit.json', 'site/submit.json'],
        ['https://example.com/events.json', 'site/events.json'],
        ['https://example.com/', 'site/index.html'],
      ]),
      currentLocalPath: 'site/scripts/app/main~q-build.js',
    });

    expect(result.text).toContain('import config from "./config~q-build.json"');
    expect(result.text).toContain('export { helper } from "../shared/util.js"');
    expect(result.text).toContain('import("./chunks/scene~q-rev.js#chunk")');
    expect(result.text).toContain('new Worker("/scripts/app/worker.js")');
    expect(result.text).toContain(
      'new URL("../../textures/albedo~q-rev.png#diffuse", import.meta.url)',
    );
    expect(result.text).toContain('new URL(texturePath, import.meta.url)');
    expect(result.text).toContain('"/_external/https/cdn.example.net/models/scene~q-rev.glb#mesh"');
    expect(result.text).toContain('const theme = "/scripts/app/audio/theme.mp3"');
    expect(result.text).toContain('fetch("/data/config~q-full.json")');
    expect(result.text).toContain('fetch("./missing.json")');
    expect(result.text).toContain('fetch("/api")');
    expect(result.text).toContain('fetch("/submit.json", { method: "POST" })');
    expect(result.text).toContain('fetch("/dynamic.json", requestOptions)');
    expect(result.text).toContain('new EventSource("/events.json")');
    expect(result.text).toContain('"https://api.unknown.example/live?x=1#stream"');
    expect(result.text).toContain('const undeclaredAsset = "./not-loaded.png"');
    expect(result.text).toContain('assetLoader.load("mountain.drc")');
    expect(result.text).toContain('a.loadAsync("basis_transcoder.js")');
    expect(result.text).toContain('const rootSeparator = "/"');
    expect(result.text).toContain('const namespaceSeparator = "."');
    expect(result.text).toContain('const relativePrefix = "./"');
    expect(result.text).toContain('base + "/dynamic.bin"');
    expect(result.text).toContain(
      '{ "https://cdn.example.net/models/scene.glb?rev=7#mesh": true }',
    );
    expect(result.unresolvedDependencies).toEqual([
      'https://example.com/scripts/app/missing.json',
      'https://example.com/scripts/app/mountain.drc',
    ]);
    expect(result.onlineDependencies).toEqual([]);
    expect(result.workerDependencies).toEqual(['https://example.com/scripts/app/worker.js']);
  });

  it('discovers and localizes runtime manifest fields relative to the JavaScript file directory', () => {
    const source = `
      const manifest = {
        entry: {
          module: "entry.client.js",
          modules: ["routes/root.js"],
          import: "./runtime.js",
          imports: ["vendor.js", "react", "@scope/package"],
          chunk: "chunks/scene.js",
          chunks: ["../shared.js"],
          css: ["styles/app.css"],
          stylesheet: "theme.css",
          stylesheets: ["./print.css"],
        },
        navigation: {
          id: "route-id.js",
          path: "routes/home.js",
          href: "next.html",
          url: "docs.html",
          route: "route.js",
        },
      };
    `;
    const resourceUrl = 'https://example.com/build/assets/manifest.js';
    const currentLocalPath = 'site/build/assets/manifest.js';
    const dependencies = [
      'https://example.com/build/assets/entry.client.js',
      'https://example.com/build/assets/routes/root.js',
      'https://example.com/build/assets/runtime.js',
      'https://example.com/build/assets/vendor.js',
      'https://example.com/build/assets/chunks/scene.js',
      'https://example.com/build/shared.js',
      'https://example.com/build/assets/styles/app.css',
      'https://example.com/build/assets/theme.css',
      'https://example.com/build/assets/print.css',
    ];
    const discovered = rewriteJavaScript({
      text: source,
      resourceUrl,
      urlToLocalPath: new Map(),
      currentLocalPath,
    });

    expect(discovered.unresolvedDependencies).toEqual(dependencies);
    expect(discovered.onlineDependencies).toEqual([]);

    const localized = rewriteJavaScript({
      text: source,
      resourceUrl,
      urlToLocalPath: new Map([
        [dependencies[0]!, 'site/runtime/entry.client.js'],
        [dependencies[1]!, 'site/runtime/root.js'],
        [dependencies[2]!, 'site/runtime/runtime.js'],
        [dependencies[3]!, 'site/runtime/vendor.js'],
        [dependencies[4]!, 'site/runtime/scene.js'],
        [dependencies[5]!, 'site/runtime/shared.js'],
        [dependencies[6]!, 'site/runtime/app.css'],
        [dependencies[7]!, 'site/runtime/theme.css'],
        [dependencies[8]!, 'site/runtime/print.css'],
      ]),
      currentLocalPath,
    });

    expect(localized.text).toContain('module: "/runtime/entry.client.js"');
    expect(localized.text).toContain('modules: ["/runtime/root.js"]');
    expect(localized.text).toContain('import: "/runtime/runtime.js"');
    expect(localized.text).toContain('imports: ["/runtime/vendor.js", "react", "@scope/package"]');
    expect(localized.text).toContain('chunk: "/runtime/scene.js"');
    expect(localized.text).toContain('chunks: ["/runtime/shared.js"]');
    expect(localized.text).toContain('css: ["/runtime/app.css"]');
    expect(localized.text).toContain('stylesheet: "/runtime/theme.css"');
    expect(localized.text).toContain('stylesheets: ["/runtime/print.css"]');
    expect(localized.text).toContain('path: "routes/home.js"');
    expect(localized.text).toContain('href: "next.html"');
    expect(localized.text).toContain('url: "docs.html"');
    expect(localized.unresolvedDependencies).toEqual([]);
    expect(localized.onlineDependencies).toEqual([]);
  });

  it('roots same-directory runtime assets while preserving ESM module-relative semantics', () => {
    const resourceUrl = 'https://cdn.example.net/build/assets/manifest.js';
    const currentLocalPath = 'site/_external/https/cdn.example.net/build/assets/manifest.js';
    const mapping = new Map([
      [resourceUrl, currentLocalPath],
      [
        'https://cdn.example.net/build/assets/entry.client.js',
        'site/_external/https/cdn.example.net/build/assets/entry.client.js',
      ],
      [
        'https://cdn.example.net/build/assets/icon.svg',
        'site/_external/https/cdn.example.net/build/assets/icon.svg',
      ],
    ]);
    const source = `
      import "./entry.client.js";
      window.__runtimeManifest = {
        entry: { module: "entry.client.js" },
        url: "manifest.js",
      };
      const icons = { menu: "icon.svg" };
    `;
    const first = rewriteJavaScript({
      text: source,
      resourceUrl,
      urlToLocalPath: mapping,
      currentLocalPath,
    });
    const second = rewriteJavaScript({
      text: first.text,
      resourceUrl,
      urlToLocalPath: mapping,
      currentLocalPath,
    });

    expect(first.text).toContain('import "./entry.client.js"');
    expect(first.text).toContain(
      'module: "/_external/https/cdn.example.net/build/assets/entry.client.js"',
    );
    expect(first.text).toContain('url: "manifest.js"');
    expect(first.text).toContain('menu: "icon.svg"');
    expect(second).toEqual(first);
    expect(first.unresolvedDependencies).toEqual([]);
    expect(first.onlineDependencies).toEqual([]);
  });

  it('preserves bare JavaScript asset leaves that a runtime base URL composes', () => {
    const resourceUrl = 'https://runtime.example.net/build/app.js';
    const source = `
      const baseUrl = "https://assets.example.net/rive/";
      const files = {
        signature: "signature.riv",
        button: "button.riv",
      };
      function assetUrl(name) {
        return baseUrl + files[name];
      }
      Object.keys(files).map(assetUrl);
    `;
    const result = rewriteJavaScript({
      text: source,
      resourceUrl,
      urlToLocalPath: new Map([
        [
          'https://assets.example.net/rive/signature.riv',
          'site/_external/https/assets.example.net/rive/signature.riv',
        ],
        [
          'https://assets.example.net/rive/button.riv',
          'site/_external/https/assets.example.net/rive/button.riv',
        ],
      ]),
      currentLocalPath: 'site/_external/https/runtime.example.net/build/app.js',
    });

    expect(result.text).toContain('signature: "signature.riv"');
    expect(result.text).toContain('button: "button.riv"');
    expect(result.text).toContain('return baseUrl + files[name]');
    expect(result.text).not.toContain('baseUrl + "/_external/');
    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('preserves mapped structured asset paths that a custom loader composes with its base URL', () => {
    const resourceUrl = 'https://cdn.example.net/loader.js';
    const source = `
      const CDN = "https://cdn.example.net/";
      const manifest = {
        textures: [
          { id: "arrow", url: "images/arrow.png" },
          { id: "logo", url: "textures/logo.png" },
        ],
        fonts: [
          { id: "body", url: "fonts/body.json" },
        ],
      };
      new AssetBatch(manifest, { baseUrl: CDN }).start();
    `;
    const result = rewriteJavaScript({
      text: source,
      resourceUrl,
      urlToLocalPath: new Map([
        [
          'https://cdn.example.net/images/arrow.png',
          'site/_external/https/cdn.example.net/images/arrow.png',
        ],
        [
          'https://cdn.example.net/textures/logo.png',
          'site/_external/https/cdn.example.net/textures/logo.png',
        ],
        [
          'https://cdn.example.net/fonts/body.json',
          'site/_external/https/cdn.example.net/fonts/body.json',
        ],
      ]),
      currentLocalPath: 'site/_external/https/cdn.example.net/loader.js',
    });

    expect(result.text).toContain('url: "images/arrow.png"');
    expect(result.text).toContain('url: "textures/logo.png"');
    expect(result.text).toContain('url: "fonts/body.json"');
    expect(result.text).not.toContain('baseUrl: CDN }).start();\n    "/_external/');
    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('keeps same-origin absolute aliases to existing local paths idempotent', () => {
    const resourceUrl = 'https://cdn.example.net/build/assets/app.js';
    const currentLocalPath = 'site/_external/https/cdn.example.net/build/assets/app.js';
    const localAssetPath = 'site/_external/https/cdn.example.net/files/scene~q-0123456789ab.ktx2';
    const mapping = new Map([
      [resourceUrl, currentLocalPath],
      ['https://cdn.example.net/files/scene.ktx2?v=7', localAssetPath],
    ]);
    const source = `
      const scene = "https://cdn.example.net/_external/https/cdn.example.net/files/scene~q-0123456789ab.ktx2?local=1#layer";
      textureLoader.load(scene);
    `;
    const first = rewriteJavaScript({
      text: source,
      resourceUrl,
      urlToLocalPath: mapping,
      currentLocalPath,
    });
    const second = rewriteJavaScript({
      text: first.text,
      resourceUrl,
      urlToLocalPath: mapping,
      currentLocalPath,
    });

    expect(first.text).toContain(
      '"/_external/https/cdn.example.net/files/scene~q-0123456789ab.ktx2?local=1#layer"',
    );
    expect(second).toEqual(first);
    expect(first.unresolvedDependencies).toEqual([]);
    expect(first.onlineDependencies).toEqual([]);
  });

  it('discovers structured asset manifests using observed runtime placeholder values', () => {
    const source = `
      settings.assetResolution = "desktop";
      if (tablet) settings.assetResolution = "tablet";
      if (mobile) settings.assetResolution = "mobile";
      settings.audioFormat = Modernizr.audio.ogg ? "ogg" : "mp3";
      settings.videoFormat = Modernizr.video.webm ? "webm" : "mp4";
      settings.lang = document.documentElement.lang === "fr" ? "fr" : "en";
      const manifest = {
        intro: { src: "images/intro/{resolutions:all}/logo.png" },
        loading: { src: "sounds/common/loading.{audio}" },
        language: { src: "data/{lang}.json" },
        nextCover: { src: "images/artists/next/{resolutions:all}/cover.png" },
        nextSprite: { src: "images/artists/next/sprite-{resolutions:desktop,mobile}.json" },
        mobileOnly: { src: "images/artists/next/mobile-{resolutions:mobile}.png" },
        nextAudio: { src: "sounds/next/theme.{audio}" },
        nextVideo: { src: "videos/next/scene.{video}" },
        fixed: { src: "images/fixed.png" },
        api: { src: "/api/current" },
      };
    `;
    const result = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://example.com/scripts/app.js',
      urlToLocalPath: new Map([
        ['https://example.com/images/intro/desktop/logo.png', 'site/images/intro/desktop/logo.png'],
        ['https://example.com/sounds/common/loading.ogg', 'site/sounds/common/loading.ogg'],
        ['https://example.com/data/en.json', 'site/data/en.json'],
        ['https://example.com/videos/common/intro.mp4', 'site/videos/common/intro.mp4'],
      ]),
      currentLocalPath: 'site/scripts/app.js',
    });

    expect(result.unresolvedDependencies).toEqual([
      'https://example.com/images/artists/next/desktop/cover.png',
      'https://example.com/images/artists/next/sprite-desktop.json',
      'https://example.com/images/fixed.png',
      'https://example.com/sounds/next/theme.ogg',
      'https://example.com/videos/next/scene.mp4',
    ]);
    expect(result.onlineDependencies).toEqual([]);
    expect(result.text).toContain('images/artists/next/{resolutions:all}/cover.png');
    expect(result.text).toContain('images/artists/next/mobile-{resolutions:mobile}.png');
  });

  it('discovers finite video URLs inside bound iteration callbacks', () => {
    const source = `
      settings.assetResolution = "desktop";
      if (tablet) settings.assetResolution = "tablet";
      if (mobile) settings.assetResolution = "mobile";
      const clips = ["dance", "dvno", "stress", "stop"];
      soundManager.addSound("noise", {
        urls: ["sounds/content/noise.ogg", "sounds/content/noise.mp3"],
      });

      clips.forEach(function (clip) {
        PIXI.VideoBaseTexture.fromUrl([
          {
            src:
              "videos/justice/" +
              clip +
              "-" +
              settings.assetResolution +
              ".webm",
            mime: "video/webm",
          },
          {
            src:
              "videos/justice/" +
              clip +
              "-" +
              settings.assetResolution +
              ".mp4",
            mime: "video/mp4",
          },
        ]);
      }.bind(this));
    `;
    const result = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://example.com/scripts/app.js',
      urlToLocalPath: new Map([
        [
          'https://example.com/images/content/artists/desktop/justice.jpg',
          'site/images/content/artists/desktop/justice.jpg',
        ],
      ]),
      currentLocalPath: 'site/scripts/app.js',
    });

    expect(result.unresolvedDependencies).toEqual([
      'https://example.com/sounds/content/noise.mp3',
      'https://example.com/sounds/content/noise.ogg',
      'https://example.com/videos/justice/dance-desktop.mp4',
      'https://example.com/videos/justice/dance-desktop.webm',
      'https://example.com/videos/justice/dvno-desktop.mp4',
      'https://example.com/videos/justice/dvno-desktop.webm',
      'https://example.com/videos/justice/stop-desktop.mp4',
      'https://example.com/videos/justice/stop-desktop.webm',
      'https://example.com/videos/justice/stress-desktop.mp4',
      'https://example.com/videos/justice/stress-desktop.webm',
    ]);
    expect(result.unresolvedDependencies.join('\n')).not.toContain('tablet');
    expect(result.unresolvedDependencies.join('\n')).not.toContain('mobile');
    expect(result.onlineDependencies).toEqual([]);
  });

  it('binds finite Array.from values and resource arrays accessed through this', () => {
    const source = `
      this.videoNames = ["alpha", "beta"];

      this.videoNames.forEach(function (name) {
        videoLoader.fromUrl("videos/" + name + ".mp4");
      }.bind(this));

      Array.from(this.videoNames, function (name) {
        videoLoader.fromUrl("previews/" + name + ".webm");
      }.bind(this));
    `;
    const result = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://example.com/scripts/app.js',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/scripts/app.js',
    });

    expect(result.unresolvedDependencies).toEqual([
      'https://example.com/previews/alpha.webm',
      'https://example.com/previews/beta.webm',
      'https://example.com/videos/alpha.mp4',
      'https://example.com/videos/beta.mp4',
    ]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('discovers embedded HTML template assets from a finite AST-backed key domain', () => {
    const source = `
      const manifests = {
        alpha: { manifest: [{ id: "artist", src: "images/scenes/alpha/main.png" }] },
        beta: { manifest: [{ id: "artist", src: "images/scenes/beta/main.png" }] },
      };
      const themeManifests = {
        red: { src: "themes/red/main.png" },
        green: { src: "themes/green/main.png" },
        blue: { src: "themes/blue/main.png" },
      };
      const scenes = [{ name: "alpha" }, { name: "beta" }];
      const themes = [{ name: "red" }, { name: "green" }, { name: "blue" }];
      const coverTemplate = '<img src="images/covers/<%= key %>.jpg">';
      const badgeTemplate =
        '<img src="images/badge<%= key === "beta" ? "-alt" : "" %>.png">';
      const themeTemplate = '<img src="themes/<%= key %>.png">';
      const navigationTemplate = '<a href="<%= artist.url %>">Artist</a>';
    `;
    const result = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://example.com/scripts/app.js',
      urlToLocalPath: new Map([
        ['https://example.com/images/scenes/alpha/main.png', 'site/images/scenes/alpha/main.png'],
        ['https://example.com/images/scenes/beta/main.png', 'site/images/scenes/beta/main.png'],
        ['https://example.com/themes/red/main.png', 'site/themes/red/main.png'],
        ['https://example.com/themes/green/main.png', 'site/themes/green/main.png'],
        ['https://example.com/themes/blue/main.png', 'site/themes/blue/main.png'],
      ]),
      currentLocalPath: 'site/scripts/app.js',
    });

    expect(result.unresolvedDependencies).toEqual([
      'https://example.com/images/badge-alt.png',
      'https://example.com/images/badge.png',
      'https://example.com/images/covers/alpha.jpg',
      'https://example.com/images/covers/beta.jpg',
      'https://example.com/themes/blue.png',
      'https://example.com/themes/green.png',
      'https://example.com/themes/red.png',
    ]);
    expect(result.onlineDependencies).toEqual([]);
    expect(result.text).toContain('images/covers/<%= key %>.jpg');
    expect(result.unresolvedDependencies).not.toContain(
      'https://example.com/images/covers/red.jpg',
    );
    expect(result.text).toContain('<%= artist.url %>');
  });

  it('does not guess a finite domain for an unrelated embedded HTML template', () => {
    const source = `
      const manifests = {
        alpha: { src: "images/scenes/alpha/main.png" },
        beta: { src: "images/scenes/beta/main.png" },
      };
      const scenes = [{ name: "alpha" }, { name: "beta" }];
      const template = '<img src="common/<%= key %>.png">';
    `;
    const result = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://example.com/scripts/app.js',
      urlToLocalPath: new Map([
        ['https://example.com/images/scenes/alpha/main.png', 'site/images/alpha.png'],
        ['https://example.com/images/scenes/beta/main.png', 'site/images/beta.png'],
      ]),
      currentLocalPath: 'site/scripts/app.js',
    });

    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('discovers finite loader templates relative to their declared asset base paths', () => {
    const source = `
      const ACCESSORIES = {
        base: ["base"],
        hair: ["hair1", "hair2"],
      };
      const terrainOptions = { terrain: "present", chunks: 3 };
      const terrainChunks = Array.from(
        { length: terrainOptions.chunks },
        (_, index) => index,
      );
      const hitMeshes = Array.from({ length: 2 }, (_, index) => index);
      const models = ["avatar/avatar-bones", "avatar/avatar-idle"];
      const DEFAULT_TEXTURE = "uv/uvchecker-srgb.png";
      const staticSceneConfig = {
        deliveries: ["deliveries/note.drc"],
        emojis: ["emojis/1.drc"],
        npc: {
          modelURL: "npcs/present/scout/scout.drc",
          bonesURL: "npcs/present/scout/scout-bones.drc",
          animations: ["npcs/present/scout/scout-idle.drc"],
        },
        icons: ["ui/npc-icons/active.icon", "ui/npc-icons/inactive.icon"],
      };

      geometryLoader.setPath(\`\${client.absolutePath}/assets/geometries/\`);
      textureLoader.setPath(\`\${client.absolutePath}/assets/images/\`);

      Object.keys(ACCESSORIES).forEach((group) => {
        ACCESSORIES[group].forEach((part) => {
          geometryLoader.load(\`avatar/accessories/\${part}.drc\`);
        });
      });
      terrainChunks.forEach((index) => {
        geometryLoader.batched(
          \`planets/\${terrainOptions.terrain}/full_\${index}.drc\`,
        );
      });
      hitMeshes.forEach((index) => {
        geometryLoader.load(
          \`planets/\${terrainOptions.terrain}/hitmesh_\${index}.drc\`,
        );
      });
      class EmojiConfig {
        constructor() {
          this.numEmojis = 3;
          Array.from(
            { length: this.numEmojis },
            (_, index) => geometryLoader.load(\`emojis/\${index + 1}.drc\`),
          );
        }
      }
      models.forEach((file) => {
        geometryLoader.load(\`\${Mt.ensureAvatarUrl(file)}.drc\`);
      });
      geometryLoader.load("../planets/intro/points.drc");
      textureLoader.load("controls/circles.avif");
    `;
    const result = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://example.com/assets/App3D.js',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/assets/App3D.js',
    });

    expect(result.unresolvedDependencies).toEqual([
      'https://example.com/assets/geometries/avatar/accessories/base.drc',
      'https://example.com/assets/geometries/avatar/accessories/hair1.drc',
      'https://example.com/assets/geometries/avatar/accessories/hair2.drc',
      'https://example.com/assets/geometries/avatar/avatar-bones.drc',
      'https://example.com/assets/geometries/avatar/avatar-idle.drc',
      'https://example.com/assets/geometries/deliveries/note.drc',
      'https://example.com/assets/geometries/emojis/1.drc',
      'https://example.com/assets/geometries/emojis/2.drc',
      'https://example.com/assets/geometries/emojis/3.drc',
      'https://example.com/assets/geometries/npcs/present/scout/scout-bones.drc',
      'https://example.com/assets/geometries/npcs/present/scout/scout-idle.drc',
      'https://example.com/assets/geometries/npcs/present/scout/scout.drc',
      'https://example.com/assets/geometries/planets/present/full_0.drc',
      'https://example.com/assets/geometries/planets/present/full_1.drc',
      'https://example.com/assets/geometries/planets/present/full_2.drc',
      'https://example.com/assets/geometries/planets/present/hitmesh_0.drc',
      'https://example.com/assets/geometries/planets/present/hitmesh_1.drc',
      'https://example.com/assets/images/controls/circles.avif',
      'https://example.com/assets/images/ui/npc-icons/active.icon',
      'https://example.com/assets/images/ui/npc-icons/inactive.icon',
      'https://example.com/assets/images/uv/uvchecker-srgb.png',
      'https://example.com/assets/planets/intro/points.drc',
    ]);
    expect(result.text).toContain('geometryLoader.load(`avatar/accessories/${part}.drc`)');
    expect(result.text).toContain('textureLoader.load("controls/circles.avif")');
  });

  it('discovers loader assets in async iterable sources before callback traversal', () => {
    const source = `
      customDracoLoader.setPath(\`\${client.absolutePath}/assets/geometries/\`);

      class EmojiScene {
        constructor() {
          this.numEmojis = 10;
          this.init();
        }

        async init() {
          (
            await Promise.all(
              Array.from(
                { length: this.numEmojis },
                (unused, index) => geometryLoader.load(\`emojis/\${index + 1}.drc\`),
              ),
            )
          ).forEach(() => {});
        }
      }

      Promise.all(
        [
          {
            options: {
              curve: "birds/curve-1.drc",
              bird: "birds/1.drc",
            },
          },
          {
            options: {
              curve: "birds/curve-2.drc",
              bird: "birds/2.drc",
            },
          },
        ].map(({ options }) => Promise.resolve(options)),
      );
    `;
    const result = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://example.com/assets/App3D.js',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/assets/App3D.js',
    });

    expect(result.unresolvedDependencies).toEqual([
      'https://example.com/assets/geometries/birds/1.drc',
      'https://example.com/assets/geometries/birds/2.drc',
      'https://example.com/assets/geometries/birds/curve-1.drc',
      'https://example.com/assets/geometries/birds/curve-2.drc',
      'https://example.com/assets/geometries/emojis/1.drc',
      'https://example.com/assets/geometries/emojis/10.drc',
      'https://example.com/assets/geometries/emojis/2.drc',
      'https://example.com/assets/geometries/emojis/3.drc',
      'https://example.com/assets/geometries/emojis/4.drc',
      'https://example.com/assets/geometries/emojis/5.drc',
      'https://example.com/assets/geometries/emojis/6.drc',
      'https://example.com/assets/geometries/emojis/7.drc',
      'https://example.com/assets/geometries/emojis/8.drc',
      'https://example.com/assets/geometries/emojis/9.drc',
    ]);
  });

  it('discovers and localizes CSS URLs embedded in static JavaScript strings', () => {
    const source = `
      const styles = \`
        @font-face {
          font-family: Demo;
          src: url("https://example.com/assets/fonts/demo.woff2") format("woff2");
        }
        .hero { background: url("/assets/hero.png"); }
      \`;
      document.head.append(Object.assign(document.createElement("style"), { textContent: styles }));
    `;
    const first = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://example.com/assets/app.js',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/assets/app.js',
    });

    expect(first.unresolvedDependencies).toEqual([
      'https://example.com/assets/fonts/demo.woff2',
      'https://example.com/assets/hero.png',
    ]);

    const localized = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://example.com/assets/app.js',
      urlToLocalPath: new Map([
        ['https://example.com/assets/fonts/demo.woff2', 'site/assets/fonts/demo.woff2'],
        ['https://example.com/assets/hero.png', 'site/assets/hero.png'],
      ]),
      currentLocalPath: 'site/assets/app.js',
    });

    expect(localized.text).toContain('/assets/fonts/demo.woff2');
    expect(localized.text).toContain('/assets/hero.png');
    expect(localized.unresolvedDependencies).toEqual([]);
    expect(localized.onlineDependencies).toEqual([]);
  });

  it('discovers runtime assets inside serialized JSON without rewriting the payload', () => {
    const nested = JSON.stringify({
      fallbackWasm: 'https://cdn.example.net/runtime/rive-fallback.wasm',
      poster: 'https://cdn.example.net/images/poster.webp',
    });
    const payload = JSON.stringify([
      {
        loaderData: {
          scene: 'https://cdn.example.net/scenes/ShippingScene.theatre-project-state.json?v=7',
          model: 'https://cdn.example.net/models/shipping.glb',
          texture: 'https://cdn.example.net/textures/shipping.ktx2',
          animation: 'https://cdn.example.net/animations/shipping.riv',
          fonts: [
            {
              mimeType: 'text/plain',
              url: 'https://cdn.example.net/fonts/GT-Standard-Semibold.txt?v=3',
            },
          ],
          video: 'https://cdn.example.net/videos/shipping.mp4',
          image: 'https://cdn.example.net/images/shipping.webp',
          documentation: 'https://docs.example.net/runtime',
          readme: 'https://docs.example.net/README.txt',
          privateAsset: 'https://cdn.example.net/models/private.glb?token=do-not-capture',
          nested,
        },
      },
    ]);
    const source = `window.__runtime.streamController.enqueue(${JSON.stringify(payload)});`;
    const expectedDependencies = [
      'https://cdn.example.net/animations/shipping.riv',
      'https://cdn.example.net/fonts/GT-Standard-Semibold.txt?v=3',
      'https://cdn.example.net/images/poster.webp',
      'https://cdn.example.net/images/shipping.webp',
      'https://cdn.example.net/models/shipping.glb',
      'https://cdn.example.net/runtime/rive-fallback.wasm',
      'https://cdn.example.net/scenes/ShippingScene.theatre-project-state.json?v=7',
      'https://cdn.example.net/textures/shipping.ktx2',
      'https://cdn.example.net/videos/shipping.mp4',
    ];
    const discovered = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://example.com/app.js',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/app.js',
    });

    expect(discovered.text).toBe(source);
    expect(discovered.unresolvedDependencies).toEqual([]);
    expect(discovered.onlineDependencies).toEqual(expectedDependencies);
    expect(discovered.onlineDependencies.join('\n')).not.toContain('do-not-capture');
    expect(discovered.onlineDependencies.join('\n')).not.toContain('README.txt');

    const localized = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://example.com/app.js',
      urlToLocalPath: new Map(
        expectedDependencies.map((dependency, index) => [
          dependency,
          `site/runtime/asset-${index}`,
        ]),
      ),
      currentLocalPath: 'site/app.js',
    });

    expect(localized.text).toBe(source);
    expect(localized.unresolvedDependencies).toEqual([]);
    expect(localized.onlineDependencies).toEqual([]);
  });

  it('discovers text fonts in indexed serialized JSON without capturing ordinary text files', () => {
    const payload = JSON.stringify([
      {
        _1: 2,
        _6: 7,
      },
      'fonts',
      [3],
      {
        _4: 5,
      },
      'url',
      'https://cdn.example.net/fonts/Inter.txt?v=2',
      'documentation',
      'https://docs.example.net/README.txt',
    ]);
    const source = `window.__runtime.streamController.enqueue(${JSON.stringify(payload)});`;
    const result = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://example.com/app.js',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/app.js',
    });

    expect(result.onlineDependencies).toEqual(['https://cdn.example.net/fonts/Inter.txt?v=2']);
    expect(result.onlineDependencies.join('\n')).not.toContain('README.txt');
  });

  it('discovers explicit deferred runtime URLs in ordinary JavaScript', () => {
    const source = `
      const wasmUrl = "https://cdn.example.net/runtime/rive.wasm";
      const animationUrl = "https://example.com/animations/checkout.riv?v=3";
      const ordinaryImage = "https://cdn.example.net/images/checkout.webp";
    `;
    const result = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://example.com/assets/app.js',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/assets/app.js',
    });

    expect(result.unresolvedDependencies).toEqual([
      'https://example.com/animations/checkout.riv?v=3',
    ]);
    expect(result.onlineDependencies).toEqual(['https://cdn.example.net/runtime/rive.wasm']);
    expect(result.text).toBe(source);
  });

  it('discovers finite fetch templates and package-metadata concat runtime URLs', () => {
    const source = `
      const assetBase = "https://cdn.example.net/files";
      fetch(\`\${assetBase}/rest.json\`);
      runtime.wasmURL = "https://unpkg.com/"
        .concat(packageMetadata.name, "@")
        .concat(packageMetadata.version, "/rive.wasm");
      runtime.wasmFallbackURL = "https://cdn.jsdelivr.net/npm/"
        .concat(packageMetadata.name, "@")
        .concat(packageMetadata.version, "/rive_fallback.wasm");
      module.exports = JSON.parse(\`{"name":"@rive-app/webgl2","version":"2.37.2"}\`);
    `;
    const result = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://example.com/assets/app.js',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/assets/app.js',
    });

    expect(result.onlineDependencies).toEqual([
      'https://cdn.example.net/files/rest.json',
      'https://unpkg.com/@rive-app/webgl2@2.37.2/rive.wasm',
    ]);
    expect(result.text).toBe(source);
  });

  it('retains an optional fallback runtime URL when the browser observed it', () => {
    const fallbackUrl = 'https://cdn.jsdelivr.net/npm/@rive-app/webgl2@2.37.2/rive_fallback.wasm';
    const program = parse(
      `
        runtime.wasmFallbackURL = "https://cdn.jsdelivr.net/npm/"
          .concat(packageMetadata.name, "@")
          .concat(packageMetadata.version, "/rive_fallback.wasm");
        module.exports = JSON.parse(
          \`{"name":"@rive-app/webgl2","version":"2.37.2"}\`
        );
      `,
      { ecmaVersion: 'latest', sourceType: 'script' },
    ) as Program;
    const result = discoverStaticJavaScriptAssets(program, 'https://example.com', [fallbackUrl]);

    expect(result.dependencies).toEqual([fallbackUrl]);
  });

  it('preserves bare module specifiers for the page import map', () => {
    const source = `
      import * as THREE from "three";
      import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
      const dynamicThree = import("three");
      const dynamicLoader = import("three/addons/loaders/GLTFLoader.js");
    `;
    const result = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://cdn.example.net/files/popup.js',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/_external/https/cdn.example.net/files/popup.js',
    });

    expect(result).toEqual({
      text: source,
      unresolvedDependencies: [],
      onlineDependencies: [],
    });
  });

  it('maps a unique observed filename alias for root-relative runtime assets', () => {
    const source = 'new TextureLoader().load("/mud_normal.webp");';
    const result = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://cdn.example.net/files/popup.js',
      urlToLocalPath: new Map([
        [
          'https://cdn.example.net/files/mud_normal.webp?v=7',
          'site/_external/https/cdn.example.net/files/mud_normal~q-0123456789ab.webp',
        ],
      ]),
      currentLocalPath: 'site/_external/https/cdn.example.net/files/popup.js',
    });

    expect(result.text).toBe(source);
    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('maps a unique observed pathname alias when a CDN origin is omitted at runtime', () => {
    const videoUrl = 'https://cdn.example.net/videos/c/o/v/87f637ea1e5944d888a5c1e6e4f97c0b.webm';
    const result = rewriteHtml({
      text: `<!doctype html><html><head></head><body>
        <video src="/videos/c/o/v/87f637ea1e5944d888a5c1e6e4f97c0b.webm"></video>
      </body></html>`,
      resourceUrl: 'https://example.com/pages/index.html',
      urlToLocalPath: new Map([
        [
          videoUrl,
          'site/_external/https/cdn.example.net/videos/c/o/v/87f637ea1e5944d888a5c1e6e4f97c0b.webm',
        ],
      ]),
      currentLocalPath: 'site/pages/index.html',
    });

    expect(result.text).toContain(
      'src="../_external/https/cdn.example.net/videos/c/o/v/87f637ea1e5944d888a5c1e6e4f97c0b.webm"',
    );
    expect(result.text).toContain(
      '["/videos/c/o/v/87f637ea1e5944d888a5c1e6e4f97c0b.webm","/_external/https/cdn.example.net/videos/c/o/v/87f637ea1e5944d888a5c1e6e4f97c0b.webm"]',
    );
    expect(result.text).toContain('localReference=pathAliasMap.get(source.pathname);');
    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('does not map an ambiguous pathname alias across different source origins', () => {
    const path = '/videos/c/o/v/shared.webm';
    const result = rewriteHtml({
      text: `<!doctype html><html><head></head><body><video src="${path}"></video></body></html>`,
      resourceUrl: 'https://example.com/pages/index.html',
      urlToLocalPath: new Map([
        [
          `https://cdn-a.example.net${path}`,
          'site/_external/https/cdn-a.example.net/videos/c/o/v/shared.webm',
        ],
        [
          `https://cdn-b.example.net${path}`,
          'site/_external/https/cdn-b.example.net/videos/c/o/v/shared.webm',
        ],
      ]),
      currentLocalPath: 'site/pages/index.html',
    });

    expect(result.text).toContain(`src="${path}"`);
    expect(result.text).not.toContain(`["${path}",`);
    expect(result.unresolvedDependencies).toEqual([`https://example.com${path}`]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('does not alias an unrelated absolute URL that happens to share a pathname', () => {
    const path = '/videos/c/o/v/shared.webm';
    const result = rewriteHtml({
      text: `<!doctype html><html><head></head><body>
        <video src="https://unrelated.example.org${path}"></video>
      </body></html>`,
      resourceUrl: 'https://example.com/pages/index.html',
      urlToLocalPath: new Map([
        [
          `https://cdn.example.net${path}`,
          'site/_external/https/cdn.example.net/videos/c/o/v/shared.webm',
        ],
      ]),
      currentLocalPath: 'site/pages/index.html',
    });

    expect(result.text).toContain(`src="https://unrelated.example.org${path}"`);
    expect(result.onlineDependencies).toEqual([`https://unrelated.example.org${path}`]);
    expect(result.unresolvedDependencies).toEqual([]);
  });

  it('replaces standalone first-party Google tag runtimes with local no-ops', () => {
    const source = `
      // Copyright 2012 Google Inc. All rights reserved.
      (function(){
        var data = { "resource": {}, "runtime": [] };
        function complete(a) { return a.gtmOnSuccess(); }
        var hosts = "www.googletagmanager.com google-analytics.com";
        complete({ gtmOnSuccess: function() {} });
      })();
    `;
    const result = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://example.com/first-party-tag-runtime',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/first-party-tag-runtime.js',
    });

    expect(result.text).toContain('window.dataLayer=window.dataLayer||[]');
    expect(result.text).toContain('window.gtag=window.gtag||function()');
    expect(result.text).not.toContain('www.googletagmanager.com');
    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });

  it('replaces Cloudflare RUM telemetry with a local no-op', () => {
    const source =
      'new PerformanceObserver(function(){});' +
      'navigator.sendBeacon("/cdn-cgi/rum?token=public", "metrics");';
    const result = rewriteJavaScript({
      text: source,
      resourceUrl: 'https://example.com/assets/beacon.min.js',
      urlToLocalPath: new Map(),
      currentLocalPath: 'site/assets/beacon.min.js',
    });

    expect(result.text).toContain('window.dataLayer=window.dataLayer||[]');
    expect(result.text).not.toContain('/cdn-cgi/rum');
    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });
});

describe('rewriteResource', () => {
  it('dispatches through the shared public API', () => {
    const result = rewriteResource({
      type: 'json',
      text: '"https://example.com/assets/item.json#entry"',
      resourceUrl: 'https://example.com/data/source.json',
      urlToLocalPath: new Map([['https://example.com/assets/item.json', 'site/assets/item.json']]),
      currentLocalPath: 'site/data/source.json',
    });

    expect(JSON.parse(result.text)).toBe('../assets/item.json#entry');
    expect(result.unresolvedDependencies).toEqual([]);
    expect(result.onlineDependencies).toEqual([]);
  });
});
