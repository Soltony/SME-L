import prisma from './prisma';
import type { TxClient } from './db-lock';

/**
 * Human-readable document numbers (LN-000123, RC-000123, JE-00000123).
 *
 * They come from native SQL Server SEQUENCE objects rather than a counter row:
 * a counter row is a single hot lock every loan, receipt and journal in the
 * system would queue behind, while `NEXT VALUE FOR` never blocks. The trade is
 * that a rolled-back transaction leaves a gap in the numbering, which is the
 * normal behaviour of bank reference numbers and is harmless — nothing uses
 * them for arithmetic, and every row also carries its own id.
 */

const SEQUENCES = {
  loan: { name: 'seq_loan_no', prefix: 'LN-', width: 6 },
  application: { name: 'seq_application_no', prefix: 'AP-', width: 6 },
  receipt: { name: 'seq_receipt_no', prefix: 'RC-', width: 7 },
  journal: { name: 'seq_journal_no', prefix: 'JE-', width: 8 },
} as const;

export type SequenceKind = keyof typeof SEQUENCES;

let ensured: Promise<void> | null = null;

/** Creates any missing sequence. Idempotent; safe to call on every start. */
export function ensureSequences(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      for (const { name } of Object.values(SEQUENCES)) {
        // The name is a constant from the table above, never input.
        await prisma.$executeRawUnsafe(
          `IF OBJECT_ID(N'dbo.${name}', N'SO') IS NULL EXEC(N'CREATE SEQUENCE dbo.${name} AS BIGINT START WITH 1 INCREMENT BY 1 CACHE 20')`
        );
      }
    })().catch((error) => {
      ensured = null;
      throw error;
    });
  }
  return ensured;
}

export async function nextNumber(client: TxClient, kind: SequenceKind): Promise<string> {
  await ensureSequences();
  const { name, prefix, width } = SEQUENCES[kind];
  const rows = await client.$queryRawUnsafe<{ v: bigint | number }[]>(
    `SELECT NEXT VALUE FOR dbo.${name} AS v`
  );
  const value = Number(rows[0]?.v ?? 0);
  if (!value) throw new Error(`Sequence ${name} returned no value.`);
  return `${prefix}${String(value).padStart(width, '0')}`;
}
