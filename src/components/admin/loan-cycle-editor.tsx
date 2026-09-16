'use client';

import { Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cycleRangeLabel, LOAN_CYCLE_METRIC_LABELS, LOAN_CYCLE_METRICS } from '@/lib/lending/scoring';
import type { GradeRow } from './product-form-values';

const MAX_CYCLES = 10;
const MAX_GRADES = 10;
const CELL = 'h-9 w-[72px] text-right';

export interface LoanCycleValues {
  cycleMetric: string;
  cycleLateSetsBack: boolean;
  cycleStarts: string[];
  cycleGrades: GradeRow[];
}

/**
 * The loan cycle table: score grades down, cycles across, and in each cell the
 * share of their tier amount a borrower in that grade and cycle may take.
 */
export function LoanCycleEditor({
  values,
  onChange,
  errors,
  usesScoring,
}: {
  values: LoanCycleValues;
  onChange: (patch: Partial<LoanCycleValues>) => void;
  errors: string[];
  usesScoring: boolean;
}) {
  const { cycleStarts: starts, cycleGrades: grades } = values;
  const numericStarts = starts.map((s) => Number(s));
  const labelsReady = starts.every((s) => /^\d+$/.test(s.trim()));
  const metricLabel = LOAN_CYCLE_METRIC_LABELS[values.cycleMetric as keyof typeof LOAN_CYCLE_METRIC_LABELS]?.toLowerCase() ?? 'loans';

  const setGrade = (g: number, patch: Partial<GradeRow>) =>
    onChange({ cycleGrades: grades.map((row, i) => (i === g ? { ...row, ...patch } : row)) });

  const addCycle = () => {
    const last = Number(starts[starts.length - 1]);
    onChange({
      cycleStarts: [...starts, Number.isFinite(last) ? String(last + 2) : ''],
      cycleGrades: grades.map((row) => ({ ...row, percents: [...row.percents, row.percents[row.percents.length - 1] ?? '100'] })),
    });
  };

  const removeCycle = (c: number) =>
    onChange({
      cycleStarts: starts.filter((_, i) => i !== c),
      cycleGrades: grades.map((row) => ({ ...row, percents: row.percents.filter((_, i) => i !== c) })),
    });

  const addGrade = () => {
    const last = grades[grades.length - 1];
    onChange({
      cycleGrades: [
        ...grades,
        { label: String.fromCharCode(65 + grades.length), minScore: '', percents: last ? [...last.percents] : starts.map(() => '100') },
      ],
    });
  };

  return (
    <div className="mt-3 space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1.5 text-sm">
          <span className="font-medium">Borrowers move up a cycle for each</span>
          <select
            value={values.cycleMetric}
            onChange={(e) => onChange({ cycleMetric: e.target.value })}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {LOAN_CYCLE_METRICS.map((metric) => (
              <option key={metric} value={metric}>
                {LOAN_CYCLE_METRIC_LABELS[metric].replace(/^Loans/, 'Loan')}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-start gap-2 self-end pb-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={values.cycleLateSetsBack}
            onChange={(e) => onChange({ cycleLateSetsBack: e.target.checked })}
          />
          <span>
            A late repayment moves the borrower back one cycle
            <span className="block text-xs text-muted-foreground">Otherwise a late loan simply does not count towards moving up.</span>
          </span>
        </label>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="text-sm">
          <thead className="bg-secondary/50 text-left text-xs">
            <tr>
              <th className="px-3 py-2 font-semibold">Grade</th>
              {usesScoring && <th className="px-3 py-2 font-semibold">From score</th>}
              {starts.map((start, c) => (
                <th key={c} className="px-2 py-2 align-top font-semibold">
                  <div className="flex items-center justify-between gap-1">
                    <span>Cycle {c + 1}</span>
                    {c > 0 && (
                      <button type="button" aria-label={`Remove cycle ${c + 1}`} onClick={() => removeCycle(c)} className="rounded p-0.5 text-muted-foreground hover:bg-secondary">
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  {c === 0 ? (
                    <span className="mt-1 block font-normal text-muted-foreground">from 0</span>
                  ) : (
                    <label className="mt-1 flex items-center gap-1 font-normal text-muted-foreground">
                      from
                      <Input
                        aria-label={`Cycle ${c + 1} starts at`}
                        value={start}
                        inputMode="numeric"
                        onChange={(e) => onChange({ cycleStarts: starts.map((s, i) => (i === c ? e.target.value : s)) })}
                        className="h-7 w-12 px-1 text-right text-xs"
                      />
                    </label>
                  )}
                  {labelsReady && <span className="block font-normal text-muted-foreground">{cycleRangeLabel(numericStarts, c)} loans</span>}
                </th>
              ))}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {grades.map((grade, g) => (
              <tr key={g}>
                <td className="px-3 py-2">
                  <Input aria-label="Grade" value={grade.label} onChange={(e) => setGrade(g, { label: e.target.value })} className="h-9 w-24" />
                </td>
                {usesScoring && (
                  <td className="px-3 py-2">
                    <Input
                      aria-label={`Grade ${grade.label} from score`}
                      value={grade.minScore}
                      inputMode="numeric"
                      onChange={(e) => setGrade(g, { minScore: e.target.value })}
                      className="h-9 w-20 text-right"
                    />
                  </td>
                )}
                {starts.map((_, c) => (
                  <td key={c} className="px-2 py-2">
                    <span className="flex items-center gap-1">
                      <Input
                        aria-label={`Grade ${grade.label}, cycle ${c + 1}, percent`}
                        value={grade.percents[c] ?? ''}
                        inputMode="numeric"
                        onChange={(e) => setGrade(g, { percents: starts.map((__, i) => (i === c ? e.target.value : grade.percents[i] ?? '')) })}
                        className={CELL}
                      />
                      <span className="text-xs text-muted-foreground">%</span>
                    </span>
                  </td>
                ))}
                <td className="px-1 py-2">
                  {grades.length > 1 && (
                    <Button type="button" variant="ghost" size="icon" aria-label={`Remove grade ${grade.label}`} onClick={() => onChange({ cycleGrades: grades.filter((_, i) => i !== g) })}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={addCycle} disabled={starts.length >= MAX_CYCLES}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add cycle
        </Button>
        {usesScoring && (
          <Button type="button" size="sm" variant="outline" onClick={addGrade} disabled={grades.length >= MAX_GRADES}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add grade
          </Button>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {usesScoring
          ? `A borrower takes the highest grade their score reaches — one grade must start at 0 — and the cycle for how many ${metricLabel} they have. A cell of 0% keeps the product closed to them for now.`
          : `This product does not use credit scoring, so one row applies to every borrower, by how many ${metricLabel} they have. A cell of 0% keeps the product closed to them for now.`}
      </p>

      {errors.length > 0 && (
        <ul className="space-y-0.5">
          {errors.map((message, i) => (
            <li key={i} className="text-xs text-destructive">
              {message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
