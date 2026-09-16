import 'dotenv/config';
import prisma from '../src/lib/prisma';
import { centsToDecimal, formatMoney, toCents } from '../src/lib/money';
import { today, type Day } from '../src/lib/business-date';
import { ensureSequences, nextNumber } from '../src/lib/numbering';
import { provisionChartOfAccounts, verifyLedger } from '../src/lib/accounting/ledger';
import {
  accrueLoanInTx,
  confirmDisbursementInTx,
  createLoanFromApplicationInTx,
  failDisbursementInTx,
  postCapitalInTx,
  recordRepaymentInTx,
  refreshNplFlags,
  reverseRepaymentInTx,
  runAccrualBatch,
  writeOffLoanInTx,
  type Actor,
} from '../src/lib/lending/loan-service';
import { totalOutstanding } from '../src/lib/lending/engine';
import { stateFromRow } from '../src/lib/lending/loan-store';

/**
 * Demo dataset: two providers, three products, a scoring model, borrowers with
 * provisioned data, and loans in every state — built by calling the real
 * service layer with back-dated business days, not by writing balances by hand.
 * Every figure you see afterwards is what the platform would have produced.
 *
 *   npm run db:seed:demo            # add the demo data (skips if present)
 *   npm run db:seed:demo -- --reset # remove demo data first
 *
 * Everything is namespaced (provider codes DEMO-*, phones 25191000xxxx) so a
 * reset never touches anything else. Ends by verifying the ledger.
 */

const SEED: Actor = { id: 'SEED', name: 'Demo seed', type: 'SYSTEM' };
const PHONE_PREFIX = '25191000';

async function reset() {
  const providers = await prisma.loanProvider.findMany({ where: { code: { startsWith: 'DEMO-' } }, select: { id: true } });
  const providerIds = providers.map((p) => p.id);
  if (!providerIds.length) return;
  const loans = await prisma.loan.findMany({ where: { providerId: { in: providerIds } }, select: { id: true } });
  const loanIds = loans.map((l) => l.id);
  const journals = await prisma.journalEntry.findMany({ where: { providerId: { in: providerIds } }, select: { id: true } });

  await prisma.$transaction([
    prisma.repayment.deleteMany({ where: { loanId: { in: loanIds } } }),
    prisma.paymentIntent.deleteMany({ where: { loanId: { in: loanIds } } }),
    prisma.ledgerLine.deleteMany({ where: { journalId: { in: journals.map((j) => j.id) } } }),
    prisma.journalEntry.updateMany({ where: { providerId: { in: providerIds } }, data: { reversalOfId: null } }),
    prisma.journalEntry.deleteMany({ where: { providerId: { in: providerIds } } }),
    prisma.disbursementAttempt.deleteMany({ where: { loanId: { in: loanIds } } }),
    prisma.loanInstallment.deleteMany({ where: { loanId: { in: loanIds } } }),
    prisma.loan.deleteMany({ where: { id: { in: loanIds } } }),
    prisma.applicationDocument.deleteMany({ where: { application: { providerId: { in: providerIds } } } }),
    prisma.loanApplication.deleteMany({ where: { providerId: { in: providerIds } } }),
    prisma.ledgerAccount.deleteMany({ where: { providerId: { in: providerIds } } }),
    prisma.loanAmountTier.deleteMany({ where: { product: { providerId: { in: providerIds } } } }),
    prisma.loanProduct.deleteMany({ where: { providerId: { in: providerIds } } }),
    prisma.scoringRule.deleteMany({ where: { parameter: { providerId: { in: providerIds } } } }),
    prisma.scoringParameter.deleteMany({ where: { providerId: { in: providerIds } } }),
    prisma.borrowerDataRow.deleteMany({ where: { config: { providerId: { in: providerIds } } } }),
    prisma.dataUpload.deleteMany({ where: { config: { providerId: { in: providerIds } } } }),
    prisma.dataProvisioningConfig.deleteMany({ where: { providerId: { in: providerIds } } }),
    prisma.termsAcceptance.deleteMany({ where: { terms: { providerId: { in: providerIds } } } }),
    prisma.termsVersion.deleteMany({ where: { providerId: { in: providerIds } } }),
    prisma.pendingChange.deleteMany({ where: { providerId: { in: providerIds } } }),
    prisma.user.updateMany({ where: { providerId: { in: providerIds } }, data: { providerId: null } }),
    prisma.loanProvider.deleteMany({ where: { id: { in: providerIds } } }),
    prisma.borrowerAccount.deleteMany({ where: { borrower: { phoneNumber: { startsWith: PHONE_PREFIX } } } }),
    prisma.borrowerPhone.deleteMany({ where: { borrower: { phoneNumber: { startsWith: PHONE_PREFIX } } } }),
    prisma.borrower.deleteMany({ where: { phoneNumber: { startsWith: PHONE_PREFIX } } }),
    prisma.taxRule.deleteMany({ where: { name: 'VAT (demo)' } }),
  ]);
  console.log(`Removed demo data (${providerIds.length} providers, ${loanIds.length} loans).`);
}

const penalty = (rules: object[]) => JSON.stringify(rules);

async function createProviders() {
  const asf = await prisma.loanProvider.create({
    data: { code: 'DEMO-ASF', name: 'Addis SME Finance', colorHex: '#E0A70B', displayOrder: 1, nplThresholdDays: 60, fundingAccountNo: '1000900100' },
  });
  const nmc = await prisma.loanProvider.create({
    data: { code: 'DEMO-NMC', name: 'Nile Microcredit', colorHex: '#0E7C66', displayOrder: 2, nplThresholdDays: 30, fundingAccountNo: '1000900200' },
  });
  for (const p of [asf, nmc]) await prisma.$transaction((tx) => provisionChartOfAccounts(tx, p.id));
  return { asf, nmc };
}

async function main() {
  const args = process.argv.slice(2);
  await ensureSequences();
  if (args.includes('--reset')) await reset();
  if (args.includes('--reset-only')) return;

  if (await prisma.loanProvider.findFirst({ where: { code: 'DEMO-ASF' } })) {
    console.log('Demo data already present. Run with --reset to rebuild it.');
    return;
  }

  const T = today();
  const { asf, nmc } = await createProviders();

  // ---- Capital ------------------------------------------------------------
  await prisma.$transaction((tx) =>
    postCapitalInTx(tx, { providerId: asf.id, amount: 5_000_000_00, direction: 'INJECT', reference: 'DEMO-CAP-ASF-1', note: 'Opening capital' }, SEED)
  );
  await prisma.$transaction((tx) =>
    postCapitalInTx(tx, { providerId: nmc.id, amount: 1_500_000_00, direction: 'INJECT', reference: 'DEMO-CAP-NMC-1', note: 'Opening capital' }, SEED)
  );

  // ---- Tax ----------------------------------------------------------------
  await prisma.taxRule.create({
    data: { name: 'VAT (demo)', ratePercent: '15', appliesToFee: true, appliesToInterest: true, appliesToPenalty: true, status: 'ACTIVE' },
  });

  // ---- Products -----------------------------------------------------------
  const workingCapital = await prisma.loanProduct.create({
    data: {
      providerId: asf.id,
      code: 'WC30',
      name: 'Working Capital 30',
      description: 'Short-term stock and cash-flow finance, repaid in one payment after 30 days.',
      status: 'ACTIVE',
      minAmount: '1000.00',
      maxAmount: '100000.00',
      durationDays: 30,
      installmentCount: 1,
      serviceFeeType: 'PERCENT',
      serviceFeeValue: '2',
      interestType: 'PERCENT_DAILY',
      interestValue: '0.1',
      interestBasis: 'SIMPLE',
      penaltyRules: penalty([
        { fromDay: 1, toDay: 1, type: 'FIXED', value: '100', frequency: 'ONCE' },
        { fromDay: 1, toDay: null, type: 'PERCENT_PRINCIPAL', value: '0.5', frequency: 'DAILY' },
      ]),
      allowConcurrentLoans: true,
      requiresScoring: true,
      cycleConfig: JSON.stringify({
        enabled: true,
        metric: 'PAID_OFF_LOANS',
        steps: [
          { minCount: 0, percent: 50 },
          { minCount: 1, percent: 75 },
          { minCount: 3, percent: 100 },
        ],
      }),
      tiers: {
        create: [
          { minScore: 0, maxScore: 39, maxAmount: '0.00' },
          { minScore: 40, maxScore: 69, maxAmount: '30000.00' },
          { minScore: 70, maxScore: 100, maxAmount: '100000.00' },
        ],
      },
    },
  });

  const equipment = await prisma.loanProduct.create({
    data: {
      providerId: asf.id,
      code: 'EQ90',
      name: 'Equipment Loan 90',
      description: 'Machinery and equipment finance in three monthly installments. Reviewed by a loan officer.',
      status: 'ACTIVE',
      minAmount: '10000.00',
      maxAmount: '300000.00',
      durationDays: 90,
      installmentCount: 3,
      serviceFeeType: 'PERCENT',
      serviceFeeValue: '1.5',
      interestType: 'PERCENT_DAILY',
      interestValue: '0.05',
      interestBasis: 'SIMPLE',
      penaltyRules: penalty([{ fromDay: 1, toDay: null, type: 'PERCENT_PRINCIPAL', value: '1', frequency: 'DAILY' }]),
      allowConcurrentLoans: true,
      requiresReview: true,
      requiresScoring: true,
      requiredDocuments: JSON.stringify([
        { key: 'business_licence', name: 'Business licence' },
        { key: 'national_id', name: 'National ID' },
        { key: 'proforma', name: 'Equipment proforma invoice' },
      ]),
      tiers: {
        create: [
          { minScore: 0, maxScore: 59, maxAmount: '0.00' },
          { minScore: 60, maxScore: 79, maxAmount: '150000.00' },
          { minScore: 80, maxScore: 100, maxAmount: '300000.00' },
        ],
      },
    },
  });

  const quick = await prisma.loanProduct.create({
    data: {
      providerId: nmc.id,
      code: 'QA14',
      name: 'Quick Advance 14',
      description: 'A small advance for a fixed daily charge, repaid within two weeks.',
      status: 'ACTIVE',
      minAmount: '500.00',
      maxAmount: '5000.00',
      durationDays: 14,
      installmentCount: 1,
      serviceFeeType: 'FIXED',
      serviceFeeValue: '25',
      interestType: 'FIXED_DAILY',
      interestValue: '5',
      penaltyRules: penalty([{ fromDay: 1, toDay: 30, type: 'FIXED', value: '15', frequency: 'DAILY' }]),
      allowConcurrentLoans: false,
      requiresScoring: false,
    },
  });

  // ---- Scoring & provisioned data ------------------------------------------
  const params = [
    {
      name: 'Monthly revenue',
      weight: 40,
      rules: [
        { field: 'Monthly revenue', operator: '>=', value: '150000', score: 40 },
        { field: 'Monthly revenue', operator: 'between', value: '60000,149999', score: 28 },
        { field: 'Monthly revenue', operator: 'between', value: '20000,59999', score: 15 },
      ],
    },
    {
      name: 'Years in business',
      weight: 30,
      rules: [
        { field: 'Years in business', operator: '>=', value: '5', score: 30 },
        { field: 'Years in business', operator: 'between', value: '2,4', score: 20 },
        { field: 'Years in business', operator: '<', value: '2', score: 8 },
      ],
    },
    {
      name: 'Repayment history',
      weight: 30,
      rules: [
        { field: 'onTimeLoans', operator: '>=', value: '2', score: 30 },
        { field: 'onTimeLoans', operator: '>=', value: '1', score: 22 },
        { field: 'disbursedLoans', operator: '==', value: '0', score: 15 },
      ],
    },
  ];
  for (const [index, p] of params.entries()) {
    await prisma.scoringParameter.create({
      data: { providerId: asf.id, name: p.name, weight: p.weight, sortOrder: index, rules: { create: p.rules } },
    });
  }

  const config = await prisma.dataProvisioningConfig.create({
    data: {
      providerId: asf.id,
      name: 'Business profile',
      columns: JSON.stringify([
        { name: 'Phone', type: 'string', isIdentifier: true },
        { name: 'Business name', type: 'string', isIdentifier: false },
        { name: 'Sector', type: 'string', isIdentifier: false },
        { name: 'Monthly revenue', type: 'number', isIdentifier: false },
        { name: 'Years in business', type: 'number', isIdentifier: false },
      ]),
    },
  });
  const upload = await prisma.dataUpload.create({
    data: { configId: config.id, fileName: 'business-profiles-demo.xlsx', totalRows: 8, acceptedRows: 8, rejectedRows: 0, uploadedById: 'SEED', uploadedBy: 'Demo seed' },
  });

  const people = [
    ['Abebe Kebede', 'Kebede Trading', 'Retail', 180000, 7],
    ['Hanna Tesfaye', 'Hanna Bakery', 'Food', 95000, 4],
    ['Dawit Haile', 'Haile Metal Works', 'Manufacturing', 240000, 9],
    ['Selam Girma', 'Selam Salon', 'Services', 42000, 3],
    ['Yonas Alemu', 'Alemu Logistics', 'Transport', 130000, 2],
    ['Meron Bekele', 'Meron Fashion', 'Retail', 70000, 6],
    ['Tewodros Assefa', 'Assefa Farm Supply', 'Agriculture', 210000, 11],
    ['Liya Solomon', 'Liya Coffee', 'Food', 25000, 1],
  ] as const;

  const borrowers: { id: string; phoneNumber: string }[] = [];
  for (const [i, [name, business, sector, revenue, years]] of people.entries()) {
    const phone = `${PHONE_PREFIX}${String(i + 1).padStart(4, '0')}`;
    const borrower = await prisma.borrower.create({
      data: {
        phoneNumber: phone,
        fullName: name,
        accounts: {
          create: [{ accountNumber: `1000${phone.slice(-8)}`, accountName: `${name} — savings (demo)`, source: 'SIMULATED' }],
        },
        // Sign-in resolves a borrower through their numbers, so the first one
        // is on record from the start, exactly as registration would write it.
        phones: { create: [{ phoneNumber: phone, isCurrent: true, linkedBy: 'REGISTRATION' }] },
      },
    });
    await prisma.borrowerDataRow.create({
      data: {
        configId: config.id,
        uploadId: upload.id,
        borrowerKey: phone,
        data: JSON.stringify({ Phone: phone, 'Business name': business, Sector: sector, 'Monthly revenue': revenue, 'Years in business': years }),
      },
    });
    borrowers.push(borrower);
  }

  await prisma.termsVersion.create({
    data: {
      providerId: asf.id,
      version: 1,
      isActive: true,
      content:
        'By accepting this loan you agree to repay the principal, the service fee, daily interest and any applicable tax by the due dates shown. Late installments attract penalties as described in the product terms. Addis SME Finance may share repayment information with credit bureaus.',
    },
  });

  // ---- Loans, built through the service layer on past business days ------
  async function originate(borrowerIndex: number, productId: string, amount: number, disbursedOn: Day, outcome: 'SUCCEED' | 'FAIL' | 'PENDING' = 'SUCCEED') {
    const borrower = borrowers[borrowerIndex];
    const product = await prisma.loanProduct.findUniqueOrThrow({ where: { id: productId } });
    return prisma.$transaction(async (tx) => {
      const application = await tx.loanApplication.create({
        data: {
          applicationNo: await nextNumber(tx, 'application'),
          borrowerId: borrower.id,
          providerId: product.providerId,
          productId: product.id,
          requestedAmount: centsToDecimal(amount),
          disbursementAccount: `1000${borrower.phoneNumber.slice(-8)}`,
          score: 75,
          eligibleAmount: centsToDecimal(amount),
          createdAt: new Date((disbursedOn - 0.2) * 86_400_000),
        },
      });
      const { loan, attempt } = await createLoanFromApplicationInTx(tx, application.id, amount, SEED);
      if (outcome === 'PENDING') return loan.id;
      await tx.disbursementAttempt.update({ where: { id: attempt.id }, data: { status: 'SENT' } });
      if (outcome === 'FAIL') {
        await failDisbursementInTx(tx, attempt.id, { httpStatus: 422, errorMessage: 'Account is dormant (demo).' }, SEED);
        return loan.id;
      }
      await confirmDisbursementInTx(tx, attempt.id, { reference: `DEMO-CBS-${loan.loanNumber}`, httpStatus: 200 }, SEED, disbursedOn);
      return loan.id;
    });
  }

  const accrueTo = (loanId: string, day: Day) => prisma.$transaction((tx) => accrueLoanInTx(tx, loanId, day, SEED));
  const repay = (loanId: string, amount: number, day: Day, channel: 'MANUAL' | 'TEST' = 'TEST') =>
    prisma.$transaction((tx) => recordRepaymentInTx(tx, { loanId, amount, channel, valueDay: day, actor: SEED, externalReference: `DEMO-${day}` }));
  const payoff = async (loanId: string, day: Day) => {
    await accrueTo(loanId, day);
    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId }, include: { installments: true } });
    return totalOutstanding(stateFromRow(loan));
  };

  // 1. Repaid early, in full.
  const l1 = await originate(0, workingCapital.id, 40_000_00, T - 70);
  await repay(l1, await payoff(l1, T - 52), T - 52);

  // 2. Repaid on the due date, in two parts.
  const l2 = await originate(2, workingCapital.id, 60_000_00, T - 65);
  await repay(l2, 20_000_00, T - 50);
  await repay(l2, await payoff(l2, T - 35), T - 35);

  // 3. Paid late with penalties, then settled.
  const l3 = await originate(1, workingCapital.id, 15_000_00, T - 55);
  await repay(l3, await payoff(l3, T - 18), T - 18);

  // 4. Active, current, partly repaid.
  const l4 = await originate(6, workingCapital.id, 80_000_00, T - 12);
  await repay(l4, 10_000_00, T - 4, 'MANUAL');

  // 5. Active and overdue (arrears, penalties accruing).
  await originate(4, workingCapital.id, 25_000_00, T - 41);

  // 6. Installment loan: first installment paid, second overdue.
  const l6 = await originate(2, equipment.id, 150_000_00, T - 75);
  await accrueTo(l6, T - 44);
  const firstInstallment = await payoff(l6, T - 44);
  const l6row = await prisma.loan.findUniqueOrThrow({ where: { id: l6 }, include: { installments: true } });
  const inst1 = l6row.installments.find((i) => i.number === 1)!;
  const nonPrincipal = firstInstallment - toCents(l6row.principalOutstanding);
  await repay(l6, nonPrincipal + toCents(inst1.principalDue), T - 44, 'MANUAL');

  // 7. Quick advance, deeply overdue, borrower becomes NPL, then written off.
  const l7 = await originate(7, quick.id, 3_000_00, T - 80);
  await accrueTo(l7, T - 1);
  await refreshNplFlags();
  await prisma.$transaction((tx) => writeOffLoanInTx(tx, l7, 'Borrower unreachable for 60 days (demo)', SEED));

  // 8. Quick advance, active, current.
  await originate(3, quick.id, 4_000_00, T - 6);

  // 9. A repayment posted in error and reversed.
  const l9 = await originate(5, quick.id, 2_000_00, T - 9);
  const wrong = await repay(l9, 500_00, T - 3, 'MANUAL');
  await prisma.$transaction((tx) => reverseRepaymentInTx(tx, wrong.repayment.id, 'Posted to the wrong loan (demo)', SEED));

  // 10. Overpayment held as a credit.
  const l10 = await originate(0, quick.id, 1_000_00, T - 8);
  await repay(l10, (await payoff(l10, T - 2)) + 150_00, T - 2);

  // 11. A disbursement core banking refused, and one still waiting.
  await originate(1, workingCapital.id, 5_000_00, T - 3, 'FAIL');
  await originate(2, workingCapital.id, 8_000_00, T - 1, 'PENDING');

  // A reviewed application waiting for a loan officer.
  await prisma.loanApplication.create({
    data: {
      applicationNo: await nextNumber(prisma, 'application'),
      borrowerId: borrowers[6].id,
      providerId: asf.id,
      productId: equipment.id,
      requestedAmount: '120000.00',
      disbursementAccount: `1000${borrowers[6].phoneNumber.slice(-8)}`,
      score: 92,
      eligibleAmount: '300000.00',
    },
  });

  // ---- Bring every book up to today and prove it balances ---------------
  const batch = await runAccrualBatch({ toDay: T });
  console.log(
    `Accrual batch: ${batch.processed} loans, ${batch.posted} journals, interest ${formatMoney(batch.interest)}, penalty ${formatMoney(batch.penalty)}, failed ${batch.failed}`
  );
  if (batch.errors.length) console.log(batch.errors);

  const checks = await verifyLedger();
  const failed = checks.filter((c) => !c.ok);
  console.log(`Ledger verification: ${checks.length - failed.length}/${checks.length} checks passed.`);
  for (const f of failed) console.log(`  FAILED ${f.providerName}: ${f.check} (expected ${f.expected}, actual ${f.actual})`);
  if (failed.length) process.exitCode = 1;

  const counts = await prisma.loan.groupBy({ by: ['status'], _count: true, where: { providerId: { in: [asf.id, nmc.id] } } });
  console.log('Loans by status:', Object.fromEntries(counts.map((c) => [c.status, c._count])));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
