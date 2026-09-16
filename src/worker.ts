import 'dotenv/config';
import prisma from './lib/prisma';
import { runMaintenance } from './lib/maintenance';
import { ensureSequences } from './lib/numbering';

/**
 * Standalone maintenance worker for deployments without a scheduler.
 *
 *   npm run run:worker            # loop every WORKER_INTERVAL_SECONDS (default 60)
 *   npm run run:worker -- --once  # one pass, then exit
 */

const intervalSeconds = Math.min(3600, Math.max(15, Number(process.env.WORKER_INTERVAL_SECONDS) || 60));

async function pass() {
  const startedAt = Date.now();
  try {
    const summary = await runMaintenance();
    console.log(`[worker] ${new Date().toISOString()} ${Date.now() - startedAt}ms`, JSON.stringify(summary));
  } catch (error) {
    console.error('[worker] pass failed', error);
  }
}

async function main() {
  await ensureSequences();
  if (process.argv.includes('--once')) {
    await pass();
    return;
  }
  console.log(`[worker] running every ${intervalSeconds}s`);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (!stopping) {
    await pass();
    for (let waited = 0; waited < intervalSeconds && !stopping; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
