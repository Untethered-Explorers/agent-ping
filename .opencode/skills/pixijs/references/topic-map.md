# Global PixiJS topic map

> Load when the global router does not name a topic package, or when you need to confirm which
> package owns a mechanic.

All 25 topic packages are installed globally alongside the `pixijs` router. This map exists so
you can go straight to the right one.

| Mechanic | Global package |
|----------|----------------|
| Application construction, async `app.init`, resize, renderer teardown | `pixijs-application` |
| Renderers, systems and pipes, renderer selection, environment detection | `pixijs-core-concepts` |
| Containers, transforms, render order, bounds, masks | `pixijs-scene-container` |
| Scene graph concepts: leaf vs container, local vs world, culling | `pixijs-scene-core-concepts` |
| Graphics shapes, paths, fills, strokes, holes, `GraphicsContext` | `pixijs-scene-graphics` |
| Sprites, animated sprites, nine-slice, tiling sprites | `pixijs-scene-sprite` |
| Text, `BitmapText`, `HTMLText`, `TextStyle`, tag styles | `pixijs-scene-text` |
| Pointer, mouse, touch and wheel input, hit testing, event modes | `pixijs-events` |
| Ticker, delta time, `UPDATE_PRIORITY`, render loop control | `pixijs-ticker` |
| Colour formats, conversion, tinting, premultiplied alpha | `pixijs-color` |
| Coordinates, vectors, matrices, shapes, layout rectangles | `pixijs-math` |
| Asset loading, bundles, manifests, spritesheets, fonts | `pixijs-assets` |
| Filters, both built-in and custom | `pixijs-filters` |
| Custom shaders, uniforms, filters and batchers | `pixijs-custom-rendering` |
| Blend modes, standard and advanced | `pixijs-blend-modes` |
| Particle containers and particles | `pixijs-scene-particle-container` |
| Meshes, custom geometry, plane and rope meshes | `pixijs-scene-mesh` |
| DOM containers overlaying the canvas | `pixijs-scene-dom-container` |
| GIF sprites and playback | `pixijs-scene-gif` |
| Rendering live HTML as textures | `pixijs-html-source` |
| Screen reader and keyboard access inside the canvas | `pixijs-accessibility` |
| Profiling, FPS, draw calls, destroy patterns, texture GC | `pixijs-performance` |
| Project scaffolding, Vite and bundler integration | `pixijs-create` |
| Upgrading from v7 and v8 breaking changes | `pixijs-migration-v8` |
| Web workers, OffscreenCanvas, SSR, CSP-restricted contexts | `pixijs-environments` |

## Routing notes

- **Accessibility has two distinct answers.** `pixijs-accessibility` covers PixiJS's own
  accessibility system inside the canvas. agent-ping's canvas-plus-DOM-mirror requirement is
  project-specific and lives in the `canvas-dom-mirror` skill, not here.
- **`pixijs-create` is the Vite one.** It covers the bundler and top-level-await production
  build gotcha, which matters because the dashboard is built with Vite.
- **Unlisted mechanic.** Load the global `pixijs` router, which enumerates the full surface and
  routes onward.
