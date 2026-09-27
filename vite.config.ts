// The renderer build (PRD 6.1: Vite 8.3.1, PRD 6.2: dashboard via Vite).
//
// One build, two pages, one artefact (LD-FR-10):
//
//   - `src/dashboard/index.html` is the live dashboard and the page the hub serves
//     at `/`, so it has to be the built `index.html`.
//   - `src/dashboard/prototype/index.html` is the approved static design prototype.
//     DP-4 approved it as a design artefact and the layout the live page draws with
//     is its layout, so it stays in the same build rather than being deleted or
//     pushed behind a second config.
//
// `base` is relative because the same artefact has to render identically in the
// Electron application window and from the loopback origin; an absolute base would
// only work for one of them, and a window-specific code path is a defect.
//
// `outDir` sits outside `root`, so `emptyOutDir` is stated explicitly: Vite refuses
// to clear a directory it does not own unless it is told to, and a stale hashed
// asset left behind from the previous build is a page that serves two scripts.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const dashboardRoot = fileURLToPath(new URL('./src/dashboard', import.meta.url))

export default defineConfig({
  root: dashboardRoot,
  base: './',
  resolve: {
    // Mirrors the `@/*` path map in tsconfig.json, because Vite does not read
    // tsconfig paths. Node-hosted code under src/ uses relative imports instead.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/dashboard', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        // The live page. Named `index` so it is the built `index.html` the hub's
        // static route maps `/` onto.
        index: resolve(dashboardRoot, 'index.html'),
        // The approved prototype, kept as a second page in the same artefact.
        prototype: resolve(dashboardRoot, 'prototype/index.html'),
      },
    },
  },
})
