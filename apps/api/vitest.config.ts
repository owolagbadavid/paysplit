import { defineConfig } from 'vitest/config';

// One file at a time: the suites share a database and each starts from a clean schema.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 30_000, hookTimeout: 60_000 } });
