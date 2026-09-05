import { defineConfig } from 'vite';

// Declared locally rather than adding @types/node, which would make Node globals
// (Buffer, setImmediate, process) type-check inside src/sim — the eslint boundary
// bans `process` there, but the rest would slip through. Not worth it for one var.
declare const process: { env: Record<string, string | undefined> };

export default defineConfig({
  // Relative, so the built bundle does not care what path it is served from.
  // GitHub Pages serves this repo from `/deep-field-td/`, and the default `/`
  // would make every asset URL absolute and 404 there. Relative also keeps
  // localhost and the tailnet IP working, which pinning `/deep-field-td/`
  // would have broken — `npm run play` serves the same dist from the root.
  // The app routes on query parameters (`?race`, `?seed=`) and never on path
  // segments, so there is no nested-URL case where a relative base resolves
  // against the wrong directory.
  base: './',
  server: {
    // Bind all interfaces so a friend can reach the dev server over Tailscale.
    // Phase 2 relies on this; harmless now.
    host: true,
    // Honour a harness-assigned PORT so this can run alongside another chat's
    // dev server; 5173 stays the default for a plain `npm run dev`.
    port: Number(process.env.PORT) || 5173,
  },
  build: {
    target: 'es2022',
  },
});
