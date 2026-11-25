import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    server: 'src/server.ts',
    migrate: 'src/cli/migrate.ts',
    'create-admin': 'src/cli/create-admin.ts',
  },
  format: 'esm',
  target: 'node24',
  noExternal: [/^@paysplit\//],
  sourcemap: true,
  clean: true,
});
