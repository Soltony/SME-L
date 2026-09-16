import 'dotenv/config';
import prisma from './lib/prisma';

/**
 * Puts every borrower's current number into their phone history.
 *
 *   npm run db:backfill-phones
 *
 * Sign-in resolves a borrower through `BorrowerPhone`, so a borrower whose
 * number predates that table would otherwise only be found by the column on
 * their record — which is exactly the lookup that misses a changed number.
 * Safe to run repeatedly.
 */
async function main() {
  const borrowers = await prisma.borrower.findMany({
    where: { mergedIntoId: null },
    select: { id: true, phoneNumber: true },
  });

  let added = 0;
  for (const borrower of borrowers) {
    const existing = await prisma.borrowerPhone.findUnique({
      where: { phoneNumber: borrower.phoneNumber },
      select: { borrowerId: true },
    });
    if (existing) {
      if (existing.borrowerId !== borrower.id) {
        console.warn(`! ${borrower.phoneNumber} is recorded against another borrower; left alone.`);
      }
      continue;
    }
    await prisma.borrowerPhone.create({
      data: { borrowerId: borrower.id, phoneNumber: borrower.phoneNumber, isCurrent: true, linkedBy: 'REGISTRATION' },
    });
    added += 1;
  }

  console.log(`${added} number(s) recorded; ${borrowers.length - added} already present.`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
