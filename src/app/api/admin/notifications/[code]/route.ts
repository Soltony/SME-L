import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { ApiError, handle, isGuardFailure, readJsonBody, requirePermission } from '@/lib/api';
import { createAuditLog } from '@/lib/audit-log';
import { checkTemplateBody, TEMPLATES_BY_CODE } from '@/lib/notification-templates';

export const dynamic = 'force-dynamic';

/**
 * Edits one borrower message: its English and Amharic wording, and whether it
 * is sent at all. The first edit creates the row; until then the default
 * wording is what goes out. Applies at once and is audited with the previous
 * text — wording is not money, and a bad edit is undone the same way.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const guard = await requirePermission('notifications.templates', 'update');
  if (isGuardFailure(guard)) return guard.response;
  const { user } = guard;

  const body = await readJsonBody<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;

  return handle(async () => {
    if (user.providerId) {
      throw new ApiError(403, 'Message templates are shared by every provider and can only be changed by platform staff.');
    }

    const { code } = await params;
    const definition = TEMPLATES_BY_CODE.get(code);
    if (!definition) throw new ApiError(404, 'Template not found.');

    const saved = await prisma.notificationTemplate.findUnique({ where: { code } });
    const current = {
      bodyEn: saved?.bodyEn ?? definition.bodyEn,
      bodyAm: saved ? saved.bodyAm : definition.bodyAm,
      active: saved?.active ?? true,
    };
    const next = { ...current };

    if (body.bodyEn !== undefined) {
      const text = String(body.bodyEn ?? '');
      const problem = checkTemplateBody(definition, text, 'The English message');
      if (problem) throw new ApiError(400, problem, 'bodyEn');
      next.bodyEn = text.trim();
    }
    if (body.bodyAm !== undefined) {
      const text = String(body.bodyAm ?? '').trim();
      if (text) {
        const problem = checkTemplateBody(definition, text, 'The Amharic message');
        if (problem) throw new ApiError(400, problem, 'bodyAm');
      }
      next.bodyAm = text || null;
    }
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') throw new ApiError(400, 'active must be true or false.', 'active');
      next.active = body.active;
    }

    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((key) => next[key] !== current[key]);
    if (changed.length === 0) return { ok: true, message: 'Nothing changed.' };

    await prisma.notificationTemplate.upsert({
      where: { code },
      create: { code, ...next, updatedById: user.id },
      update: { ...next, updatedById: user.id },
    });

    await createAuditLog({
      actorId: user.id,
      actorName: user.fullName,
      action: 'NOTIFICATION_TEMPLATE_UPDATED',
      entity: 'NotificationTemplate',
      entityId: code,
      details: {
        changed,
        previous: Object.fromEntries(changed.map((key) => [key, current[key]])),
        values: Object.fromEntries(changed.map((key) => [key, next[key]])),
      },
    });

    const message =
      changed.length === 1 && changed[0] === 'active'
        ? `${definition.name} ${next.active ? 'switched on' : 'switched off'}.`
        : `${definition.name} saved.`;
    return { ok: true, message };
  });
}
