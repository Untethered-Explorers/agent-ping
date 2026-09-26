// The renderer build (PRD 6.1: Vite 8.3.1, PRD 6.2: dashboard via Vite).
//
// DP-2 builds the static prototype page; LD-1 points the same config at the live
// entry point so the two pages differ only in what they mount.
//
// `root` is the prototype directory so the built artefact is one self-contained
// page with no other HTML entry competing for it. `base` is relative because the
// same artefact has to render identically in the Electron application window and
// from the loopback origin; an absolute base would only work for one of them.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('./src/dashboard/prototype', import.meta.url)),
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
  },
})
