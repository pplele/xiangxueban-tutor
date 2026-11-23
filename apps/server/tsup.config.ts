import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: ['@tutor/shared'],
  external: ['pdf-parse', 'jieba-wasm', 'pino', 'pino-pretty', 'thread-stream'],
});
