// Bundles the Electron main + preload scripts. Everything is bundled (no node_modules in the
// installer); only electron and ssh2's optional native speed-ups stay external.
import { build } from 'esbuild';

/** ssh2 loads sshcrypto.node / cpu-features in try/catch and falls back to pure JS. */
const skipOptionalNative = {
  name: 'skip-optional-native',
  setup(b) {
    b.onResolve({ filter: /\.node$|^cpu-features$/ }, (args) => ({ path: args.path, external: true }));
  },
};

const apiUrl = process.env.SERVERDECK_API_URL ?? 'http://localhost:4000';

await build({
  entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts' },
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  external: ['electron'],
  plugins: [skipOptionalNative],
  define: { 'process.env.SERVERDECK_API_URL': JSON.stringify(apiUrl) },
  logLevel: 'warning',
});
console.log(`Built dist-electron (API: ${apiUrl})`);
