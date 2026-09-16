/** Form state for the product designer. Shared by server pages and the client form. */

import type { DocumentKind } from '@/lib/document-kinds';

export type PenaltyRow = { fromDay: string; toDay: string; type: string; value: string; frequency: string };
export type DocRow = { key: string; name: string; description?: string; type: DocumentKind };
export type FilterRow = { field: string; values: string };
/** One score grade of the loan cycle table: a percentage per cycle, as typed. */
export type GradeRow = { label: string; minScore: string; percents: string[] };
/** A saved customer list the product can be restricted to. */
export type ListOption = { id: string; providerId: string; name: string; entryCount: number };

export interface ProductFormValues {
  providerId: string;
  code: string;
  name: string;
  description: string;
  minAmount: string;
  maxAmount: string;
  durationDays: string;
  installmentCount: string;
  serviceFeeType: string;
  serviceFeeValue: string;
  interestType: string;
  interestValue: string;
  interestBasis: string;
  accrueInterestAfterMaturity: boolean;
  penaltyRules: PenaltyRow[];
  allowConcurrentLoans: boolean;
  requiresReview: boolean;
  requiresScoring: boolean;
  requiredDocuments: DocRow[];
  eligibilityFilter: FilterRow[];
  /** Empty when anyone may apply. */
  eligibilityListId: string;
  cycleEnabled: boolean;
  cycleMetric: string;
  cycleLateSetsBack: boolean;
  /** Loan count each cycle starts at, as typed. */
  cycleStarts: string[];
  cycleGrades: GradeRow[];
}

export function blankProduct(providerId: string): ProductFormValues {
  return {
    providerId,
    code: '',
    name: '',
    description: '',
    minAmount: '1000',
    maxAmount: '50000',
    durationDays: '30',
    installmentCount: '1',
    serviceFeeType: 'PERCENT',
    serviceFeeValue: '2',
    interestType: 'PERCENT_DAILY',
    interestValue: '0.1',
    interestBasis: 'SIMPLE',
    accrueInterestAfterMaturity: false,
    penaltyRules: [{ fromDay: '1', toDay: '', type: 'PERCENT_PRINCIPAL', value: '0.5', frequency: 'DAILY' }],
    allowConcurrentLoans: false,
    requiresReview: false,
    requiresScoring: true,
    requiredDocuments: [],
    eligibilityFilter: [],
    eligibilityListId: '',
    cycleEnabled: false,
    cycleMetric: 'ON_TIME_LOANS',
    cycleLateSetsBack: false,
    cycleStarts: ['0', '1', '3'],
    cycleGrades: [{ label: 'A', minScore: '0', percents: ['50', '75', '100'] }],
  };
}

