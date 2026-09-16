import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    // `maxWait` is how long a transaction may queue for a pooled connection;
    // `timeout` is how long one may run. The defaults (2s / 5s) are sized for a
    // quiet request, not for the nightly accrual pass over a large book or a
    // burst of repayments at month end. Both are ceilings, not reservations.
    transactionOptions: {
      maxWait: 10_000,
      timeout: 30_000,
    },
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
