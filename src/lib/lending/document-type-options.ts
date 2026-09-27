import prisma from '@/lib/prisma';
import type { DocTypeOption } from '@/components/admin/product-form-values';

/**
 * What the product designer offers under Documents: the providers' own types
 * to tick, and the bank's, which every product asks for anyway.
 */
export async function productFormDocumentOptions(providerIds: string[]): Promise<{ documentTypes: DocTypeOption[]; bankDocuments: string[] }> {
  const [own, bank] = await Promise.all([
    prisma.documentType.findMany({
      where: { scope: 'PRODUCT', providerId: { in: providerIds } },
      select: { id: true, providerId: true, name: true, kind: true, requiresExpiry: true, status: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.documentType.findMany({
      where: { scope: 'GLOBAL', status: 'ACTIVE' },
      select: { name: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
  ]);
  return {
    documentTypes: own.flatMap((t) => (t.providerId ? [{ ...t, providerId: t.providerId }] : [])),
    bankDocuments: bank.map((t) => t.name),
  };
}
