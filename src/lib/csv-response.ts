import { NextResponse } from 'next/server';
import { toCsv } from './format';
import { centsToDecimal, type Cents } from './money';

/** A CSV download. The BOM makes Excel read UTF-8 (Amharic names) correctly. */
export function csvResponse(filename: string, header: string[], rows: unknown[][]) {
  const safeName = filename.replace(/[^\w.-]+/g, '_');
  return new NextResponse(`﻿${toCsv(header, rows)}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Cache-Control': 'no-store',
    },
  });
}

/** Cents as a plain decimal cell. */
export function amountCell(cents: Cents) {
  return centsToDecimal(cents);
}
