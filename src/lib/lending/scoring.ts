import { z } from 'zod';
import { boolish } from './terms';

/**
 * Rule-based credit scoring.
 *
 * A provider defines parameters ("Monthly income", weight 30), each with rules
 * that award points when a borrower field satisfies a condition. A parameter
 * contributes the best score among its matching rules, capped at its weight,
 * and the total picks a loan-amount tier.
 *
 * Field names are matched ignoring case, spaces and punctuation. The previous
 * implementation camel-cased both sides with a regex, so a column uploaded as
 * "Monthly_Income" and a rule written against "monthly income" silently never
 * matched and the borrower scored zero.
 */

export const SCORING_OPERATORS = ['>', '<', '>=', '<=', '==', '!=', 'between', 'in'] as const;
export type ScoringOperator = (typeof SCORING_OPERATORS)[number];

export function normalizeFieldName(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const text = value.trim().replace(/,/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseRange(value: string): [number, number] | null {
  const parts = value.includes('..') ? value.split('..') : value.split(',');
  if (parts.length !== 2) return null;
  const min = asNumber(parts[0]);
  const max = asNumber(parts[1]);
  if (min === null || max === null || min > max) return null;
  return [min, max];
}

/** Whether a rule's own value is well-formed for its operator. Used when saving rules. */
export function ruleValueError(operator: ScoringOperator, value: string): string | null {
  const text = String(value ?? '').trim();
  if (!text) return 'Enter a value.';
  if (operator === 'between') {
    return parseRange(text) ? null : 'Use "min,max" with min not above max, e.g. 5000,20000.';
  }
  if (operator === 'in') {
    return text.split(',').some((v) => v.trim()) ? null : 'List one or more values separated by commas.';
  }
  if (['>', '<', '>=', '<='].includes(operator) && asNumber(text) === null) {
    return 'This comparison needs a number.';
  }
  return null;
}

export function evaluateRule(input: unknown, operator: ScoringOperator, ruleValue: string): boolean {
  if (input === null || input === undefined || (typeof input === 'string' && input.trim() === '')) {
    return false;
  }
  const inputNumber = asNumber(input);
  const inputText = String(input).trim().toLowerCase();
  const value = String(ruleValue ?? '').trim();

  switch (operator) {
    case '>':
    case '<':
    case '>=':
    case '<=': {
      const target = asNumber(value);
      if (inputNumber === null || target === null) return false;
      if (operator === '>') return inputNumber > target;
      if (operator === '<') return inputNumber < target;
      if (operator === '>=') return inputNumber >= target;
      return inputNumber <= target;
    }
    case 'between': {
      const range = parseRange(value);
      return range !== null && inputNumber !== null && inputNumber >= range[0] && inputNumber <= range[1];
    }
    case 'in': {
      const options = value.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
      return options.some((option) => {
        const optionNumber = asNumber(option);
        return optionNumber !== null && inputNumber !== null ? optionNumber === inputNumber : option === inputText;
      });
    }
    case '==':
    case '!=': {
      const target = asNumber(value);
      const equal =
        target !== null && inputNumber !== null ? target === inputNumber : value.toLowerCase() === inputText;
      return operator === '==' ? equal : !equal;
    }
    default:
      return false;
  }
}

export const scoringRuleSchema = z
  .object({
    field: z.string().trim().min(1, 'Choose a field.').max(100),
    operator: z.enum(SCORING_OPERATORS),
    value: z.string().trim().max(500),
    score: z.coerce.number().int().min(0, 'Points cannot be negative.').max(1000),
  })
  .superRefine((rule, ctx) => {
    const error = ruleValueError(rule.operator, rule.value);
    if (error) ctx.addIssue({ code: 'custom', path: ['value'], message: error });
  });

export const scoringParameterSchema = z.object({
  name: z.string().trim().min(1, 'Name the parameter.').max(100),
  weight: z.coerce.number().int().min(1, 'Weight must be at least 1.').max(1000),
  rules: z.array(scoringRuleSchema).min(1, 'Add at least one rule.').max(50),
});

export const scoringModelSchema = z
  .array(scoringParameterSchema)
  .max(50)
  .superRefine((parameters, ctx) => {
    const seen = new Set<string>();
    parameters.forEach((parameter, index) => {
      const key = normalizeFieldName(parameter.name);
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: [index, 'name'], message: 'Parameter names must be unique.' });
      }
      seen.add(key);
      parameter.rules.forEach((rule, ruleIndex) => {
        if (rule.score > parameter.weight) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'rules', ruleIndex, 'score'],
            message: `Points cannot exceed the parameter weight (${parameter.weight}).`,
          });
        }
      });
    });
  });

export type ScoringParameterInput = z.infer<typeof scoringParameterSchema>;

export interface ScoreBreakdown {
  parameter: string;
  weight: number;
  points: number;
  matchedRule: string | null;
}

export function scoreBorrower(
  parameters: ScoringParameterInput[],
  features: Record<string, unknown>
): { total: number; maxPossible: number; breakdown: ScoreBreakdown[] } {
  const normalized = new Map<string, unknown>();
  for (const [key, value] of Object.entries(features)) normalized.set(normalizeFieldName(key), value);

  let total = 0;
  let maxPossible = 0;
  const breakdown: ScoreBreakdown[] = [];

  for (const parameter of parameters) {
    let best = 0;
    let matchedRule: string | null = null;
    for (const rule of parameter.rules) {
      const input = normalized.get(normalizeFieldName(rule.field));
      if (evaluateRule(input, rule.operator, rule.value) && rule.score > best) {
        best = rule.score;
        matchedRule = `${rule.field} ${rule.operator} ${rule.value}`;
      }
    }
    const points = Math.min(best, parameter.weight);
    total += points;
    maxPossible += parameter.weight;
    breakdown.push({ parameter: parameter.name, weight: parameter.weight, points, matchedRule });
  }

  return { total, maxPossible, breakdown };
}

// ----------------------------------------
// Loan amount tiers and loan cycles
// ----------------------------------------

export const tierSchema = z.object({
  minScore: z.coerce.number().int().min(0),
  maxScore: z.coerce.number().int().min(0),
  maxAmount: z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((v) => /^\d+(\.\d{1,2})?$/.test(v) && Number(v) > 0, 'Enter a positive amount.'),
});

export const tiersSchema = z
  .array(tierSchema)
  .max(50)
  .superRefine((tiers, ctx) => {
    tiers.forEach((tier, index) => {
      if (tier.maxScore < tier.minScore) {
        ctx.addIssue({ code: 'custom', path: [index, 'maxScore'], message: 'The upper score is below the lower score.' });
      }
    });
    const sorted = tiers.map((t, i) => ({ ...t, i })).sort((a, b) => a.minScore - b.minScore);
    for (let k = 1; k < sorted.length; k += 1) {
      if (sorted[k].minScore <= sorted[k - 1].maxScore) {
        ctx.addIssue({
          code: 'custom',
          path: [sorted[k].i, 'minScore'],
          message: `Overlaps the ${sorted[k - 1].minScore}–${sorted[k - 1].maxScore} tier; a score must pick exactly one tier.`,
        });
      }
    }
  });

/**
 * Loan cycles: how much of their tier amount a borrower may take, from how
 * many loans they have repaid (the cycle, across) and their score (the grade,
 * down). A grade-A borrower on their first loan might get 50% of their tier,
 * a grade-C one 20%, and both reach 100% after a few loans repaid on time.
 *
 * Only repaid loans move a borrower up. There is no "total loans" or "late
 * loans" measure: either would reward borrowing, or repaying late, with a
 * bigger limit. With `lateSetsBack`, each loan repaid late takes one step back.
 *
 * Cycles are written as the loan count each one starts at, and grades as the
 * score each one starts at, both required to start at 0 — so every borrower
 * falls in exactly one cell. There are no ranges to leave gaps between.
 */
export const LOAN_CYCLE_METRICS = ['PAID_OFF_LOANS', 'ON_TIME_LOANS', 'EARLY_LOANS'] as const;
export type LoanCycleMetric = (typeof LOAN_CYCLE_METRICS)[number];

export const LOAN_CYCLE_METRIC_LABELS: Record<LoanCycleMetric, string> = {
  PAID_OFF_LOANS: 'Loans repaid in full',
  ON_TIME_LOANS: 'Loans repaid on time or early',
  EARLY_LOANS: 'Loans repaid early',
};

const percentCell = z.coerce.number().int('Use whole percentages.').min(0, 'Use 0–100.').max(100, 'Use 0–100.');

/** Before cycles had grades, a product had one row of `steps`. Read as a single grade covering every score. */
function upgradeLegacyCycle(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || !('steps' in raw) || 'cycles' in raw) return raw;
  const { steps, ...rest } = raw as { steps: unknown };
  if (!Array.isArray(steps)) return raw;
  const sorted = [...steps].sort((a, b) => Number(a?.minCount) - Number(b?.minCount));
  return {
    ...rest,
    cycles: sorted.map((step) => step?.minCount),
    grades: [{ label: 'All scores', minScore: 0, percents: sorted.map((step) => step?.percent) }],
  };
}

const loanCycleShape = z
  .object({
    enabled: boolish,
    metric: z.enum(LOAN_CYCLE_METRICS),
    lateSetsBack: boolish.default(false),
    /** Loan count each cycle starts at. */
    cycles: z.array(z.coerce.number().int().min(0).max(1000)).min(1, 'Add at least one cycle.').max(10, 'At most 10 cycles.'),
    grades: z
      .array(
        z.object({
          label: z.string().trim().min(1, 'Name the grade.').max(20),
          minScore: z.coerce.number().int().min(0).max(100_000),
          percents: z.array(percentCell),
        })
      )
      .min(1, 'Add at least one grade.')
      .max(10, 'At most 10 grades.'),
  })
  .superRefine((config, ctx) => {
    if (config.cycles[0] !== 0) {
      ctx.addIssue({ code: 'custom', path: ['cycles', 0], message: 'The first cycle is for new borrowers and starts at 0 loans.' });
    }
    config.cycles.forEach((start, i) => {
      if (i > 0 && start <= config.cycles[i - 1]) {
        ctx.addIssue({ code: 'custom', path: ['cycles', i], message: 'Each cycle must start at more loans than the one before.' });
      }
    });
    const scores = new Set<number>();
    config.grades.forEach((grade, g) => {
      if (scores.has(grade.minScore)) {
        ctx.addIssue({ code: 'custom', path: ['grades', g, 'minScore'], message: 'Two grades start at the same score.' });
      }
      scores.add(grade.minScore);
      if (grade.percents.length !== config.cycles.length) {
        ctx.addIssue({ code: 'custom', path: ['grades', g, 'percents'], message: `Grade ${grade.label} needs a percentage for every cycle.` });
      }
    });
    if (!scores.has(0)) {
      ctx.addIssue({ code: 'custom', path: ['grades'], message: 'One grade must start at score 0, so every borrower has a grade.' });
    }
  });

/** Validation for saving a cycle table: the stored-shape rules, plus the ones that catch a typo. */
export const loanCycleSchema = z.preprocess(
  upgradeLegacyCycle,
  loanCycleShape.superRefine((config, ctx) => {
    config.grades.forEach((grade, g) => {
      grade.percents.forEach((percent, c) => {
        if (c > 0 && percent < grade.percents[c - 1]) {
          ctx.addIssue({
            code: 'custom',
            path: ['grades', g, 'percents', c],
            message: `Grade ${grade.label}: a later cycle cannot give less than an earlier one (${percent}% after ${grade.percents[c - 1]}%).`,
          });
        }
      });
    });
  })
);

export type LoanCycleConfig = z.infer<typeof loanCycleShape>;

/**
 * A stored cycle table, or null when the product has none switched on.
 *
 * Read with the stored-shape rules only: a table saved before a newer
 * save-time rule existed still applies as it was approved.
 */
export function parseLoanCycle(raw: string | null | undefined): LoanCycleConfig | null {
  if (!raw) return null;
  try {
    const parsed = loanCycleShape.safeParse(upgradeLegacyCycle(JSON.parse(raw)));
    return parsed.success && parsed.data.enabled ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * True when a product's stored table is switched on but cannot be read. The
 * product must then refuse rather than lend without the limit it was approved with.
 */
export function loanCycleUnreadable(raw: string | null | undefined): boolean {
  if (!raw || parseLoanCycle(raw)) return false;
  try {
    return Boolean((JSON.parse(raw) as { enabled?: unknown })?.enabled);
  } catch {
    return true;
  }
}

/** "0", "1–2", "3+": the loan counts a cycle covers. */
export function cycleRangeLabel(cycles: number[], index: number): string {
  const start = cycles[index];
  const next = cycles[index + 1];
  if (next === undefined) return index === 0 ? 'any number of' : `${start}+`;
  return next - 1 === start ? String(start) : `${start}–${next - 1}`;
}

export interface CycleHistory {
  paidOffLoans: number;
  onTimeLoans: number;
  earlyLoans: number;
  lateLoans: number;
}

export interface CyclePosition {
  percent: number;
  /** 0-based column. */
  cycle: number;
  grade: string;
  /** The loan count that placed the borrower, after any late-repayment setback. */
  count: number;
  /** For reviewers: "cycle 2 (1–2 loans repaid in full), grade A". */
  description: string;
}

/** Where a borrower sits in the table. A borrower with no score takes the grade that starts at 0. */
export function loanCyclePosition(config: LoanCycleConfig, history: CycleHistory, score: number | null): CyclePosition {
  const repaid =
    config.metric === 'EARLY_LOANS' ? history.earlyLoans : config.metric === 'ON_TIME_LOANS' ? history.onTimeLoans : history.paidOffLoans;
  const count = config.lateSetsBack ? Math.max(0, repaid - history.lateLoans) : repaid;

  let cycle = 0;
  config.cycles.forEach((start, i) => {
    if (start <= count) cycle = i;
  });

  const grades = [...config.grades].sort((a, b) => b.minScore - a.minScore);
  const grade = grades.find((g) => (score ?? 0) >= g.minScore) ?? grades[grades.length - 1];
  const percent = grade.percents[Math.min(cycle, grade.percents.length - 1)] ?? 0;

  return {
    percent,
    cycle,
    grade: grade.label,
    count,
    description: `cycle ${cycle + 1} (${cycleRangeLabel(config.cycles, cycle)} ${LOAN_CYCLE_METRIC_LABELS[config.metric].toLowerCase()}), grade ${grade.label}`,
  };
}
