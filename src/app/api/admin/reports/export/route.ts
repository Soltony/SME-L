import { NextRequest } from 'next/server';
import prisma from '@/lib/prisma';
import { isGuardFailure, jsonError, requirePermission } from '@/lib/api';
import { createAuditLog } from '@/lib/audit-log';
import { amountCell, csvResponse } from '@/lib/csv-response';
import { dayToIso, parseIsoDay, today } from '@/lib/business-date';
import { toCents } from '@/lib/money';
import { agingReport, collectionsReport, disbursementsReport, incomeReport, portfolioReport } from '@/lib/reports';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requirePermission('reports', 'read');
  if (isGuardFailure(guard)) return guard.response;
  const { user } = guard;
  const url = new URL(req.url);
  const report = url.searchParams.get('report') ?? '';
  // Provider staff always get their own provider, whatever the query says.
  const providerId = user.providerId ?? (url.searchParams.get('providerId') || null);
  const to = parseIsoDay(url.searchParams.get('to'), today());
  const from = parseIsoDay(url.searchParams.get('from'), to - 30);
  if (from > to) return jsonError('The start date is after the end date.', 400);
  if (to - from > 3660) return jsonError('Choose a range of at most ten years.', 400);
  const stamp = `${dayToIso(from)}_${dayToIso(to)}`;

  await createAuditLog({
    actorId: user.id,
    actorName: user.fullName,
    action: 'REPORT_EXPORTED',
    details: { report, providerId, from: dayToIso(from), to: dayToIso(to) },
  });

  switch (report) {
    case 'portfolio': {
      const rows = await portfolioReport(providerId);
      return csvResponse(
        `portfolio_${dayToIso(today())}.csv`,
        ['Provider', 'Active loans', 'Principal', 'Interest', 'Fees', 'Penalties', 'Tax', 'Total outstanding', 'Overdue principal', 'PAR 1+', 'PAR 30+', 'PAR 90+', 'NPL borrowers', 'Fund cash', 'Reserved', 'Accrued through'],
        rows.map((r) => [r.providerName, r.activeLoans, amountCell(r.principal), amountCell(r.interest), amountCell(r.fee), amountCell(r.penalty), amountCell(r.tax), amountCell(r.totalOutstanding), amountCell(r.overduePrincipal), amountCell(r.par1), amountCell(r.par30), amountCell(r.par90), r.nplBorrowers, amountCell(r.cash), amountCell(r.reserved), r.accruedThrough ?? ''])
      );
    }
    case 'aging': {
      const rows = await agingReport(providerId);
      return csvResponse(
        `aging_${dayToIso(today())}.csv`,
        ['Days past due', 'Loans', 'Principal', 'Total outstanding'],
        rows.map((r) => [r.bucket, r.loans, amountCell(r.principal), amountCell(r.totalOutstanding)])
      );
    }
    case 'collections': {
      const { rows, total } = await collectionsReport(from, to, providerId);
      return csvResponse(
        `collections_${stamp}.csv`,
        ['Date', 'Receipts', 'Amount', 'Principal', 'Interest', 'Fees', 'Penalties', 'Tax', 'Overpayment'],
        [...rows, total].map((r) => [r.date, r.receipts, amountCell(r.amount), amountCell(r.principal), amountCell(r.interest), amountCell(r.fee), amountCell(r.penalty), amountCell(r.tax), amountCell(r.excess)])
      );
    }
    case 'income': {
      const rows = await incomeReport(from, to, providerId);
      return csvResponse(
        `income_${stamp}.csv`,
        ['Provider', 'Interest earned', 'Fees earned', 'Penalties earned', 'Write-offs', 'Net income', 'Interest collected', 'Fees collected', 'Penalties collected', 'Tax charged', 'Tax collected'],
        rows.map((r) => [r.providerName, amountCell(r.interestEarned), amountCell(r.feeEarned), amountCell(r.penaltyEarned), amountCell(r.writeOffs), amountCell(r.netIncome), amountCell(r.interestCollected), amountCell(r.feeCollected), amountCell(r.penaltyCollected), amountCell(r.taxCharged), amountCell(r.taxCollected)])
      );
    }
    case 'disbursements': {
      const rows = await disbursementsReport(from, to, providerId);
      return csvResponse(
        `disbursements_${stamp}.csv`,
        ['Requested at', 'Completed at', 'Loan', 'Provider', 'Product', 'Borrower phone', 'Borrower name', 'Credit account', 'Amount', 'Disbursement status', 'Loan status', 'CBS reference', 'HTTP status', 'Error'],
        rows.map((r) => [r.requestedAt, r.completedAt ?? '', r.loanNumber, r.provider, r.product, r.borrowerPhone, r.borrowerName ?? '', r.account, amountCell(r.amount), r.status, r.loanStatus, r.cbsReference ?? '', r.httpStatus ?? '', r.error ?? ''])
      );
    }
    case 'loans': {
      const loans = await prisma.loan.findMany({
        where: providerId ? { providerId } : {},
        include: { provider: { select: { name: true } }, product: { select: { name: true } }, borrower: { select: { phoneNumber: true, fullName: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50_000,
      });
      return csvResponse(
        `loan-book_${dayToIso(today())}.csv`,
        ['Loan', 'Status', 'Provider', 'Product', 'Borrower phone', 'Borrower name', 'Principal', 'Disbursed', 'Maturity', 'Principal outstanding', 'Interest outstanding', 'Fee outstanding', 'Penalty outstanding', 'Tax outstanding', 'Overpayment held', 'Days past due', 'Interest accrued', 'Principal paid', 'Written off', 'Accrued through'],
        loans.map((l) => [l.loanNumber, l.status, l.provider.name, l.product.name, l.borrower.phoneNumber, l.borrower.fullName ?? '', amountCell(toCents(l.principalAmount)), l.disbursementDate?.toISOString().slice(0, 10) ?? '', l.maturityDate?.toISOString().slice(0, 10) ?? '', amountCell(toCents(l.principalOutstanding)), amountCell(toCents(l.interestOutstanding)), amountCell(toCents(l.feeOutstanding)), amountCell(toCents(l.penaltyOutstanding)), amountCell(toCents(l.taxOutstanding)), amountCell(toCents(l.creditBalance)), l.daysPastDue, amountCell(toCents(l.interestAccrued)), amountCell(toCents(l.principalPaid)), amountCell(toCents(l.writtenOff)), l.accruedThrough?.toISOString().slice(0, 10) ?? ''])
      );
    }
    default:
      return jsonError('Unknown report.', 400);
  }
}
