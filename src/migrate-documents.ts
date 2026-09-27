import 'dotenv/config';
import prisma from './lib/prisma';
import { createAuditLog } from './lib/audit-log';
import { parseRequiredDocuments } from './lib/documents';
import { parseDocumentTypeIds } from './lib/lending/document-requirements';

/**
 * Moves products and waiting applications onto the document catalogue.
 *
 *   npm run db:migrate-documents
 *
 * Products used to name their documents in free text, and borrowers uploaded
 * them with each application. For each product that still has such a list and
 * asks for nothing from the catalogue yet, every document becomes a document
 * type of the product's provider (reusing one of the same name) and the product
 * asks for those. Files and answers already uploaded with applications still
 * waiting for review become the borrower's documents, waiting for the
 * provider's staff, so those applications do not stall.
 *
 * A document every borrower should give — a National ID, say — is better as a
 * bank document: create it under Document types, then untick the provider copy.
 *
 * Safe to run repeatedly.
 */
async function main() {
  const products = await prisma.loanProduct.findMany({
    select: { id: true, providerId: true, name: true, requiredDocuments: true, documentTypeIds: true },
  });

  let productsMoved = 0;
  let typesCreated = 0;
  /** `${productId}:${legacyKey}` → document type, for the uploads below. */
  const typeFor = new Map<string, { id: string; kind: string; providerId: string | null }>();

  for (const product of products) {
    const legacy = parseRequiredDocuments(product.requiredDocuments);
    if (legacy.length === 0) continue;
    // Already on the catalogue: map what exists by name, but never re-add what was deliberately dropped.
    const alreadyMoved = parseDocumentTypeIds(product.documentTypeIds).length > 0;
    const ids: string[] = [];
    for (const doc of legacy) {
      let type = await prisma.documentType.findFirst({
        where: { scope: 'PRODUCT', providerId: product.providerId, name: doc.name },
        select: { id: true, kind: true, providerId: true },
      });
      if (!type && !alreadyMoved) {
        type = await prisma.documentType.create({
          data: { scope: 'PRODUCT', providerId: product.providerId, name: doc.name, description: doc.description ?? '', kind: doc.type },
          select: { id: true, kind: true, providerId: true },
        });
        typesCreated += 1;
      }
      if (!type) continue;
      ids.push(type.id);
      typeFor.set(`${product.id}:${doc.key}`, type);
    }
    if (!alreadyMoved && ids.length) {
      await prisma.loanProduct.update({ where: { id: product.id }, data: { documentTypeIds: JSON.stringify([...new Set(ids)]) } });
      productsMoved += 1;
      console.log(`  ${product.name}: asks for ${legacy.map((d) => d.name).join(', ')}`);
    }
  }

  const waiting = await prisma.loanApplication.findMany({
    where: { status: 'SUBMITTED' },
    select: { borrowerId: true, productId: true, documents: true, answers: true },
  });

  let copied = 0;
  for (const application of waiting) {
    const uploads = [
      ...application.documents.map((file) => ({ key: file.documentKey, file, value: null as string | null, at: file.uploadedAt })),
      ...application.answers.map((answer) => ({ key: answer.documentKey, file: null, value: answer.value as string | null, at: answer.answeredAt })),
    ];
    for (const upload of uploads) {
      const type = typeFor.get(`${application.productId}:${upload.key}`);
      if (!type) continue;
      // Given in the other form (a file for a typed document, or the reverse): the borrower sends it again.
      if ((type.kind === 'TEXT') !== (upload.value !== null)) continue;
      const existing = await prisma.borrowerDocument.count({ where: { borrowerId: application.borrowerId, documentTypeId: type.id } });
      if (existing) continue;
      await prisma.borrowerDocument.create({
        data: {
          borrowerId: application.borrowerId,
          documentTypeId: type.id,
          providerId: type.providerId,
          version: 1,
          status: 'PENDING',
          fileName: upload.file?.fileName ?? null,
          mimeType: upload.file?.mimeType ?? null,
          sizeBytes: upload.file?.sizeBytes ?? null,
          sha256: upload.file?.sha256 ?? null,
          // The same stored file: neither record ever deletes it.
          storageName: upload.file?.storageName ?? null,
          value: upload.value,
          submittedAt: upload.at,
        },
      });
      copied += 1;
    }
  }

  if (productsMoved || typesCreated || copied) {
    await createAuditLog({
      actorId: 'SYSTEM',
      actorType: 'SYSTEM',
      action: 'DOCUMENTS_MIGRATED',
      details: { productsMoved, typesCreated, uploadsQueuedForReview: copied },
    });
  }
  console.log(
    `${productsMoved} product(s) moved onto the catalogue, ${typesCreated} document type(s) created, ${copied} upload(s) queued for review.`
  );
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
