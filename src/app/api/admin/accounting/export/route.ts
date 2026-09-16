import { NextRequest } from 'next/server';
import prisma from '@/lib/prisma';
import { isGuardFailure, jsonError, requirePermission } from '@/lib/api';
import { createAuditLog } from '@/lib/audit-log';
import { amountCell, csvResponse } from '@/lib/csv-response';
import { dayToIso, parseIsoDay, today } from '@/lib/business-date';
import { trialBalance } from '@/lib/accounting/ledger';
import { generalLedger } from '@/lib/reports';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requirePermission('accounting', 'read');
  if (isGuardFailure(guard)) return guard.response;
  const { user } = guard;
  const url = new URL(req.url);
  const kind = url.searchParams.get('kind') ?? '';

  if (kind === 'trial-balance') {
    const providerId = user.providerId ?? url.searchParams.get('providerId') ?? '';
    const provider = await prisma.loanProvider.findUnique({ where: { id: providerId }, select: { name: true, code: true } });
    if (!provider) return jsonError('Choose a provider.', 400);
    const asOf = parseIsoDay(url.searchParams.get('asOf'), today());
    const rows = await trialBalance(providerId, asOf);
    const totals = rows.reduce((t, r) => ({ debit: t.debit + r.debit, credit: t.credit + r.credit }), { debit: 0, credit: 0 });
    await createAuditLog({ actorId: user.id, actorName: user.fullName, action: 'TRIAL_BALANCE_EXPORTED', details: { providerId, asOf: dayToIso(asOf) } });
    return csvResponse(
      `trial-balance_${provider.code}_${dayToIso(asOf)}.csv`,
      ['Code', 'Account', 'Type', 'Debit', 'Credit'],
      [...rows.map((r) => [r.code, r.name, r.type, amountCell(r.debit), amountCell(r.credit)]), ['', 'Total', '', amountCell(totals.debit), amountCell(totals.credit)]]
    );
  }

  if (kind === 'general-ledger') {
    const accountId = url.searchParams.get('accountId') ?? '';
    const account = await prisma.ledgerAccount.findUnique({ where: { id: accountId }, select: { providerId: true } });
    if (!account || (user.providerId && account.providerId !== user.providerId)) return jsonError('Account not found.', 404);
    const to = parseIsoDay(url.searchParams.get('to'), today());
    const from = parseIsoDay(url.searchParams.get('from'), to - 30);
    const ledger = await generalLedger(accountId, from, to);
    if (!ledger) return jsonError('Account not found.', 404);
    await createAuditLog({ actorId: user.id, actorName: user.fullName, action: 'GENERAL_LEDGER_EXPORTED', details: { accountId, from: dayToIso(from), to: dayToIso(to) } });
    return csvResponse(
      `ledger_${ledger.account.code}_${dayToIso(from)}_${dayToIso(to)}.csv`,
      ['Date', 'Journal', 'Type', 'Description', 'Debit', 'Credit', 'Balance'],
      [
        ['', '', '', 'Opening balance', '', '', amountCell(ledger.openingBalance)],
        ...ledger.rows.map((r) => [r.date, r.journalNo, r.type, r.description, amountCell(r.debit), amountCell(r.credit), amountCell(r.balance)]),
        ['', '', '', 'Closing balance', '', '', amountCell(ledger.closingBalance)],
      ]
    );
  }

  return jsonError('Unknown export.', 400);
}
