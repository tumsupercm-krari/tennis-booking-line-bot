import { buildApp } from './app';
import { config } from './config';

async function main() {
  const app = buildApp();
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
