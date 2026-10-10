import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  sourcemap: true,
  // Bundle the workspace package (it ships TypeScript source); keep npm deps external.
  noExternal: ['@serverdeck/shared'],
});
