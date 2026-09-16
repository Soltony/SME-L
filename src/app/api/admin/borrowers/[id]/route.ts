import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { ApiError, handle, isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { createAuditLog } from '@/lib/audit-log';
import { requestChange } from '@/lib/approvals';
import { parseEthiopianMobile } from '@/lib/format';
import { resolveBorrowerByPhone } from '@/lib/lending/borrower-identity';

export const dynamic = 'force-dynamic';

/**
 * Requests a change of phone number for a borrower.
 *
 * Sign-in recognises most changed numbers by itself, through the bank account
 * the new number holds. This is the path for the rest — a new number with a new
 * account, a recycled old number, or an account held by two people — and it
 * needs a second person's approval, because it decides whose loans somebody can
 * see and repay.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('borrowers', 'update');
  if (isGuardFailure(guard)) return guard.response;
  if (guard.user.providerId) {
    return jsonError('A phone number belongs to the borrower across every provider, so only platform staff can change it.', 403);
  }
  const body = await readJsonBody<{ newPhoneNumber?: string; reason?: string }>(req);
  if (body instanceof NextResponse) return body;
  const { id } = await params;

  return handle(async () => {
    const borrower = await prisma.borrower.findUnique({ where: { id } });
    if (!borrower) throw new ApiError(404, 'Borrower not found.');
    if (borrower.mergedIntoId) throw new ApiError(409, 'This record has been merged into another borrower.');

    const newPhone = parseEthiopianMobile(String(body.newPhoneNumber || ''));
    if (!newPhone) {
      throw new ApiError(400, 'Enter an Ethiopian mobile number, such as 0911223344.', 'newPhoneNumber');
    }
    if (newPhone === borrower.phoneNumber) {
      throw new ApiError(400, 'That is already this borrower’s number.', 'newPhoneNumber');
    }

    // Say plainly what approving it will do, so the checker is not surprised by
    // a second record being folded in.
    const occupant = await resolveBorrowerByPhone(newPhone);
    if (occupant && occupant.id !== id) {
      const loans = await prisma.loan.count({ where: { borrowerId: occupant.id } });
      if (loans > 0) {
        throw new ApiError(
          409,
          'That number already belongs to a borrower with loans of their own. Confirm they are the same person before merging the records.',
          'newPhoneNumber'
        );
      }
    }

    const change = await requestChange({
      kind: 'Borrower.PHONE_CHANGE',
      entityId: borrower.id,
      payload: { newPhoneNumber: newPhone, reason: body.reason },
      summary: `Move ${borrower.fullName ?? borrower.phoneNumber} to ${newPhone}`,
      user: guard.user,
    });

    return {
      ok: true,
      message: 'Phone number change requested. It takes effect once approved.',
      changeId: change.id,
    };
  });
}

/**
 * Blocks or unblocks a borrower. A block stops new sign-ins and applications;
 * it never touches loans already on the books, which keep accruing and can
 * still be repaid.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('borrowers', 'update');
  if (isGuardFailure(guard)) return guard.response;
  if (guard.user.providerId) {
    return jsonError('Blocking applies across every provider, so only platform staff can do it.', 403);
  }
  const body = await readJsonBody<{ status?: string; reason?: string }>(req);
  if (body instanceof NextResponse) return body;
  const { id } = await params;

  const status = String(body.status || '').toUpperCase();
  if (!['ACTIVE', 'BLOCKED'].includes(status)) return jsonError('Status must be ACTIVE or BLOCKED.', 400);
  const reason = String(body.reason || '').trim();
  if (status === 'BLOCKED' && reason.length < 5) return jsonError('Give a reason for blocking.', 400, { field: 'reason' });

  return handle(async () => {
    const borrower = await prisma.borrower.findUnique({ where: { id } });
    if (!borrower) throw new ApiError(404, 'Borrower not found.');
    await prisma.borrower.update({ where: { id }, data: { status } });
    await createAuditLog({
      actorId: guard.user.id,
      actorName: guard.user.fullName,
      action: status === 'BLOCKED' ? 'BORROWER_BLOCKED' : 'BORROWER_UNBLOCKED',
      entity: 'Borrower',
      entityId: id,
      details: { reason, phone: borrower.phoneNumber },
    });
    return { ok: true, message: status === 'BLOCKED' ? 'Borrower blocked.' : 'Borrower unblocked.' };
  });
}
