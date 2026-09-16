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

export const LOAN_CYCLE_METRICS = ['PAID_OFF_LOANS', 'ON_TIME_LOANS'] as const;

export const loanCycleSchema = z.object({
  enabled: boolish,
  metric: z.enum(LOAN_CYCLE_METRICS),
  steps: z
    .array(
      z.object({
        minCount: z.coerce.number().int().min(0).max(1000),
        percent: z.coerce.number().int().min(1).max(100),
      })
    )
    .min(1)
    .max(20)
    .superRefine((steps, ctx) => {
      const counts = new Set<number>();
      steps.forEach((step, index) => {
        if (counts.has(step.minCount)) {
          ctx.addIssue({ code: 'custom', path: [index, 'minCount'], message: 'Each step needs a different loan count.' });
        }
        counts.add(step.minCount);
      });
      if (!counts.has(0)) {
        ctx.addIssue({ code: 'custom', path: [0, 'minCount'], message: 'Include a step for first-time borrowers (0 loans).' });
      }
    }),
});

export type LoanCycleConfig = z.infer<typeof loanCycleSchema>;

export function parseLoanCycle(raw: string | null | undefined): LoanCycleConfig | null {
  if (!raw) return null;
  try {
    const parsed = loanCycleSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.enabled ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The share of the tier amount a borrower with `count` qualifying loans may take. */
export function cyclePercent(config: LoanCycleConfig, count: number): number {
  const eligible = config.steps.filter((s) => s.minCount <= count).sort((a, b) => b.minCount - a.minCount);
  return eligible[0]?.percent ?? 0;
}
