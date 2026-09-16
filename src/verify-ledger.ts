import 'dotenv/config';
import prisma from './lib/prisma';
import { verifyLedger } from './lib/accounting/ledger';
import { centsToDecimal } from './lib/money';

/**
 * Proves the books reconcile, for a scheduler or an operator:
 *
 *   npm run ledger:verify
 *
 * Exits 1 when any check fails, so monitoring can alert on it.
 */
async function main() {
  const checks = await verifyLedger();
  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    const detail = c.ok ? '' : `  expected ${centsToDecimal(c.expected)}, found ${centsToDecimal(c.actual)}`;
    console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.providerName} — ${c.check}${detail}`);
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  process.exitCode = failed.length ? 1 : 0;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
