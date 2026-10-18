// Vite config for the example.
//
// The dapp is plain ESM: no framework, no JSX, nothing to transform. Vite is
// here for the two things a browser cannot do on its own — resolve bare imports
// (`@stellar/stellar-sdk`, `@scure/bip39`) and produce a static bundle.
//
// `base: './'` keeps the built bundle relative, so `dist/` can be served from a
// subdirectory (or a file URL) without editing the HTML.
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    // Readable output: this is an example meant to be read.
    minify: false,
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    // Listening on the LAN is what makes it reachable from a phone, which is
    // the point of a mobile wallet example.
    host: true,
    port: 5173,
  },
});
