import type { PendingChange } from '@prisma/client';
import prisma from '@/lib/prisma';
import { CHANGE_HANDLERS } from '@/lib/approvals';
import { getSettings, SETTINGS_BY_KEY } from '@/lib/settings';
import { formatAmount, formatMoney, toCents } from '@/lib/money';
import { formatDateTime } from '@/lib/format';
import { DOCUMENT_KINDS, parseRequiredDocuments } from '@/lib/documents';
import { providerFormValues, productFormValues } from '@/lib/lending/catalog';
import { describeFee, describeInterest } from '@/lib/lending/product-view';
import { cycleRangeLabel, LOAN_CYCLE_METRIC_LABELS, parseLoanCycle, type LoanCycleConfig } from '@/lib/lending/scoring';
import { providerFieldCatalogue } from '@/lib/lending/field-catalogue';
import { findField, type ScoringField } from '@/lib/lending/scoring-fields';
import { fundPosition } from '@/lib/lending/loan-service';

/**
 * A change request as a checker should read it.
 *
 * The queue used to show the stored payload: field keys, and anything nested
 * dumped as JSON. That asks the approver to read `serviceFeeType: PERCENT` next
 * to `serviceFeeValue: 2` and work out what borrowers will pay. Here each kind
 * of request says what it is about, what approving it does, and which fields
 * change — labelled, formatted, and compared with the record as it is now.
 */

export type Display =
  | { type: 'text'; text: string; mono?: boolean; muted?: boolean }
  | { type: 'long'; text: string }
  | { type: 'color'; hex: string }
  | { type: 'icon'; icon: string; color: string }
  | { type: 'list'; items: string[] }
  | { type: 'table'; columns: string[]; rows: string[][] };

export interface ChangeRow {
  label: string;
  /** Null when there is nothing to compare with: a creation, or a one-off action. */
  before: Display | null;
  after: Display;
  changed: boolean;
}

export interface ChangeSubject {
  label: string;
  name: string;
  href: string | null;
}

export interface ChangeSummary {
  id: string;
  kind: string;
  label: string;
  status: string;
  subject: ChangeSubject | null;
  provider: string | null;
  requestedBy: string;
  requestedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
}

export interface ChangeView extends ChangeSummary {
  sentence: string;
  reason: string | null;
  impact: string[];
  rows: ChangeRow[];
  /** What "before" is: the record now (pending), or as it was when requested (decided). */
  comparedWith: 'NOW' | 'AT_REQUEST' | null;
  /** The record has changed since the request was made, so the maker saw different values. */
  drifted: boolean;
  comment: string | null;
  failureReason: string | null;
}

type Record_ = Record<string, unknown>;
type Change = PendingChange & { createdBy: { fullName: string }; decidedBy: { fullName: string } | null };

interface Ctx {
  currency: string;
  money: (value: unknown) => string;
}

// ----------------------------------------
// Values
// ----------------------------------------

const text = (value: unknown, options: { mono?: boolean; empty?: string } = {}): Display => {
  const s = value === null || value === undefined ? '' : String(value).trim();
  return s ? { type: 'text', text: s, mono: options.mono } : { type: 'text', text: options.empty ?? '—', muted: true };
};
const yesNo = (value: unknown, yes = 'Yes', no = 'No'): Display => text(value === true || value === 'true' ? yes : no);
const same = (a: Display | null, b: Display | null) => JSON.stringify(a) === JSON.stringify(b);

function moneyOf(currency: string) {
  return (value: unknown) => {
    try {
      return formatAmount(String(value ?? ''), currency);
    } catch {
      return String(value ?? '—');
    }
  };
}

const PRODUCT_STATUS: Record<string, string> = { ACTIVE: 'Active — accepting applications', INACTIVE: 'Inactive — no new applications', DRAFT: 'Draft' };

function describePenalty(rule: Record_, ctx: Ctx) {
  const range = rule.toDay ? `days ${rule.fromDay}–${rule.toDay}` : `from day ${rule.fromDay}`;
  const amount =
    rule.type === 'FIXED'
      ? ctx.money(rule.value)
      : `${Number(rule.value)}% of the overdue ${rule.type === 'PERCENT_PRINCIPAL' ? 'amount' : 'amount and unpaid penalty'}`;
  return `${amount} ${rule.frequency === 'ONCE' ? 'once' : 'per day'} (${range} late)`;
}

function cycleTable(config: LoanCycleConfig | null): Display {
  if (!config) return text('', { empty: 'Off — every borrower can take their full tier amount' });
  const grades = [...config.grades].sort((a, b) => b.minScore - a.minScore);
  return {
    type: 'table',
    columns: ['Grade', 'From score', ...config.cycles.map((_, i) => `${cycleRangeLabel(config.cycles, i)} loans`)],
    rows: grades.map((g) => [g.label, String(g.minScore), ...g.percents.map((p) => `${p}%`)]),
  };
}

function cycleRule(config: LoanCycleConfig | null): Display {
  if (!config) return text('', { empty: 'Off' });
  return text(
    `Moves up for each ${LOAN_CYCLE_METRIC_LABELS[config.metric].toLowerCase().replace(/^loans/, 'loan')}${config.lateSetsBack ? '; each late repayment moves back one cycle' : ''}`
  );
}

// ----------------------------------------
// Field lists per kind of record
// ----------------------------------------

type FieldSpec = { label: string; show: (record: Record_, ctx: Ctx) => Display };

const PROVIDER_FIELDS: FieldSpec[] = [
  { label: 'Name', show: (r) => text(r.name) },
  { label: 'Code', show: (r) => text(r.code, { mono: true }) },
  { label: 'Status', show: (r) => text(r.status === 'INACTIVE' ? 'Inactive — no new loans' : 'Active — lending') },
  { label: 'Icon', show: (r) => ({ type: 'icon', icon: String(r.icon ?? ''), color: String(r.colorHex ?? '#E0A70B') }) },
  { label: 'Brand colour', show: (r) => ({ type: 'color', hex: String(r.colorHex ?? '') }) },
  { label: 'Funding account', show: (r) => text(r.fundingAccountNo, { mono: true }) },
  { label: 'Collection account', show: (r) => text(r.collectionAccountNo, { mono: true, empty: 'None — repayments go to the platform account' }) },
  { label: 'Non-performing after', show: (r) => text(`${r.nplThresholdDays} days past due`) },
  { label: 'Display order', show: (r) => text(r.displayOrder) },
];

function productFields(lists: Map<string, string>, providers: Map<string, string>, includeProvider: boolean): FieldSpec[] {
  return [
    ...(includeProvider ? [{ label: 'Provider', show: (r: Record_) => text(providers.get(String(r.providerId)) ?? r.providerId) }] : []),
    { label: 'Name', show: (r) => text(r.name) },
    { label: 'Code', show: (r) => text(r.code, { mono: true }) },
    { label: 'Description', show: (r) => ({ type: 'long', text: String(r.description ?? '') || '—' }) },
    { label: 'Minimum amount', show: (r, ctx) => text(ctx.money(r.minAmount)) },
    { label: 'Maximum amount', show: (r, ctx) => text(ctx.money(r.maxAmount)) },
    { label: 'Term', show: (r) => text(`${r.durationDays} days`) },
    { label: 'Repayment', show: (r) => text(Number(r.installmentCount) > 1 ? `${r.installmentCount} installments` : 'One repayment at maturity') },
    { label: 'Service fee', show: (r) => text(describeFee(String(r.serviceFeeType), String(r.serviceFeeValue))) },
    { label: 'Interest', show: (r) => text(describeInterest(String(r.interestType), String(r.interestValue), String(r.interestBasis))) },
    { label: 'Interest after maturity', show: (r) => yesNo(r.accrueInterestAfterMaturity, 'Keeps accruing', 'Stops at maturity') },
    {
      label: 'Late penalties',
      show: (r, ctx) => {
        const rules = Array.isArray(r.penaltyRules) ? (r.penaltyRules as Record_[]) : [];
        return rules.length ? { type: 'list', items: rules.map((rule) => describePenalty(rule, ctx)) } : text('', { empty: 'None' });
      },
    },
    { label: 'Uses credit score', show: (r) => yesNo(r.requiresScoring, 'Yes — the amount tier caps each borrower', 'No — the product maximum applies') },
    { label: 'Loan officer review', show: (r) => yesNo(r.requiresReview, 'Every application is reviewed', 'Eligible applications disburse at once') },
    { label: 'Alongside other loans', show: (r) => yesNo(r.allowConcurrentLoans, 'Allowed', 'Not allowed') },
    {
      label: 'Required documents',
      show: (r) => {
        const docs = parseRequiredDocuments(JSON.stringify(r.requiredDocuments ?? []));
        return docs.length
          ? { type: 'table', columns: ['Document', 'Borrower provides'], rows: docs.map((d) => [d.name, DOCUMENT_KINDS[d.type].label]) }
          : text('', { empty: 'None' });
      },
    },
    {
      label: 'Who can take it',
      show: (r) =>
        r.eligibilityListId
          ? text(`Only customers on ${lists.get(String(r.eligibilityListId)) ?? 'a list that no longer exists'}`)
          : text('Any borrower who qualifies'),
    },
    {
      label: 'Data conditions',
      show: (r) => {
        const filter = (r.eligibilityFilter ?? {}) as Record<string, string>;
        const entries = Object.entries(filter);
        return entries.length ? { type: 'list', items: entries.map(([field, values]) => `${field}: ${values}`) } : text('', { empty: 'None' });
      },
    },
    { label: 'Loan cycles', show: (r) => cycleTable(parseLoanCycle(r.cycleConfig ? JSON.stringify(r.cycleConfig) : null)) },
    { label: 'Cycle rule', show: (r) => cycleRule(parseLoanCycle(r.cycleConfig ? JSON.stringify(r.cycleConfig) : null)) },
  ];
}

const TAX_FIELDS: FieldSpec[] = [
  { label: 'Name', show: (r) => text(r.name) },
  { label: 'Rate', show: (r) => text(`${Number(r.ratePercent)}%`) },
  {
    label: 'Charged on',
    show: (r) =>
      text(
        [(r.appliesToFee === true || r.appliesToFee === 'true') && 'service fees', (r.appliesToInterest === true || r.appliesToInterest === 'true') && 'interest', (r.appliesToPenalty === true || r.appliesToPenalty === 'true') && 'penalties']
          .filter(Boolean)
          .join(', ')
      ),
  },
  { label: 'Status', show: (r) => text(r.status === 'INACTIVE' ? 'Inactive' : 'Active') },
];

function tiersTable(tiers: unknown, ctx: Ctx): Display {
  const rows = (Array.isArray(tiers) ? (tiers as Record_[]) : []).slice().sort((a, b) => Number(a.minScore) - Number(b.minScore));
  return rows.length
    ? { type: 'table', columns: ['Score from', 'Score to', 'Maximum amount'], rows: rows.map((t) => [String(t.minScore), String(t.maxScore), ctx.money(t.maxAmount)]) }
    : text('', { empty: 'No tiers — nobody qualifies' });
}

const OPERATOR_WORDS: Record<string, string> = {
  '>=': 'at least',
  '>': 'more than',
  '<=': 'at most',
  '<': 'less than',
  '==': 'is',
  '!=': 'is not',
  in: 'is one of',
  between: 'between',
};

function parameterList(parameter: Record_ | undefined, field: ScoringField | undefined): Display {
  if (!parameter) return text('', { empty: 'Not scored' });
  const unit = field?.unit && field.unit !== 'of 6' ? ` ${field.unit}` : '';
  const rules = (Array.isArray(parameter.rules) ? (parameter.rules as Record_[]) : []).slice().sort((a, b) => Number(b.score) - Number(a.score));
  return {
    type: 'list',
    items: [
      `Up to ${parameter.weight} points`,
      ...rules.map((rule) => {
        // Numbers read with separators: 150,000 rather than 150000.
        const number = (v: string) => (field?.type === 'number' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v).toLocaleString('en-US') : v.trim());
        const parts = String(rule.value).split(/,|\.\./).map(number);
        const condition =
          rule.operator === 'between' ? `between ${parts.join(' and ')}` : `${OPERATOR_WORDS[String(rule.operator)] ?? rule.operator} ${parts.join(', ')}`;
        return `${condition}${unit} → ${rule.score} points`;
      }),
    ],
  };
}

// ----------------------------------------
// Rows
// ----------------------------------------

function compareRows(specs: FieldSpec[], before: Record_ | null, after: Record_, ctx: Ctx): ChangeRow[] {
  return specs.map((spec) => {
    const b = before ? spec.show(before, ctx) : null;
    const a = spec.show(after, ctx);
    return { label: spec.label, before: b, after: a, changed: !before || !same(b, a) };
  });
}

const oneOff = (label: string, after: Display): ChangeRow => ({ label, before: null, after, changed: true });

async function subjectFor(change: PendingChange, payload: Record_): Promise<{ subject: ChangeSubject | null; provider: string | null }> {
  const id = change.entityId;
  const kind = `${change.entityType}.${change.action}`;
  const providerName = async (providerId: string | null | undefined) =>
    providerId ? (await prisma.loanProvider.findUnique({ where: { id: providerId }, select: { name: true } }))?.name ?? null : null;
  const loanSubject = async (loanId: string | null | undefined) => {
    const loan = loanId
      ? await prisma.loan.findUnique({ where: { id: loanId }, select: { id: true, loanNumber: true, providerId: true, borrower: { select: { fullName: true, phoneNumber: true } } } })
      : null;
    return {
      subject: loan ? { label: 'Loan', name: `${loan.loanNumber} · ${loan.borrower.fullName ?? loan.borrower.phoneNumber}`, href: `/admin/loans/${loan.id}` } : null,
      provider: await providerName(loan?.providerId),
    };
  };

  switch (change.entityType) {
    case 'Provider': {
      const name = id ? (await prisma.loanProvider.findUnique({ where: { id }, select: { name: true } }))?.name : null;
      return { subject: { label: 'Provider', name: name ?? String(payload.name ?? 'New provider'), href: id ? `/admin/providers/${id}` : null }, provider: name ?? String(payload.name ?? '') };
    }
    case 'Terms':
    case 'Capital':
    case 'TaxRemittance': {
      const name = await providerName(id ?? String(payload.providerId ?? ''));
      return { subject: { label: 'Provider', name: name ?? 'Unknown provider', href: id ? `/admin/providers/${id}` : null }, provider: name };
    }
    case 'ScoringModel': {
      const name = await providerName(id);
      return { subject: { label: 'Scoring model', name: name ?? 'Unknown provider', href: id ? `/admin/credit-scoring?providerId=${id}` : null }, provider: name };
    }
    case 'Product': {
      const product = id ? await prisma.loanProduct.findUnique({ where: { id }, select: { name: true, providerId: true } }) : null;
      return {
        subject: { label: 'Product', name: product?.name ?? String(payload.name ?? 'New product'), href: id ? `/admin/products/${id}` : null },
        provider: await providerName(product?.providerId ?? (payload.providerId as string | undefined)),
      };
    }
    case 'TaxRule': {
      const tax = id ? await prisma.taxRule.findUnique({ where: { id }, select: { name: true } }) : null;
      return { subject: { label: 'Tax', name: tax?.name ?? String(payload.name ?? 'New tax'), href: '/admin/taxes' }, provider: null };
    }
    case 'Settings':
      return { subject: { label: 'Settings', name: 'Platform settings', href: '/admin/settings' }, provider: null };
    case 'Loan':
      return loanSubject(id);
    case 'Repayment': {
      if (kind === 'Repayment.MANUAL') return loanSubject(id);
      const repayment = id ? await prisma.repayment.findUnique({ where: { id }, select: { receiptNo: true, loanId: true } }) : null;
      const loan = await loanSubject(repayment?.loanId);
      return { subject: repayment ? { label: 'Repayment', name: `Receipt ${repayment.receiptNo}`, href: loan.subject?.href ?? null } : null, provider: loan.provider };
    }
    case 'Disbursement': {
      const attempt = id ? await prisma.disbursementAttempt.findUnique({ where: { id }, select: { loanId: true } }) : null;
      return loanSubject(attempt?.loanId);
    }
    case 'Borrower': {
      const borrower = id ? await prisma.borrower.findUnique({ where: { id }, select: { fullName: true, phoneNumber: true } }) : null;
      return { subject: borrower ? { label: 'Borrower', name: borrower.fullName ?? borrower.phoneNumber, href: `/admin/borrowers/${id}` } : null, provider: null };
    }
    default:
      return { subject: null, provider: null };
  }
}

function handlerLabel(kind: string) {
  return (CHANGE_HANDLERS as Record<string, { label: string }>)[kind]?.label ?? kind;
}

function parse(json: string | null): Record_ | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json);
    return value && typeof value === 'object' ? (value as Record_) : null;
  } catch {
    return null;
  }
}

/** Just enough to list a request in the queue. */
export async function summarizeChange(change: Change): Promise<ChangeSummary> {
  const kind = `${change.entityType}.${change.action}`;
  const { subject, provider } = await subjectFor(change, parse(change.payload) ?? {});
  return {
    id: change.id,
    kind,
    label: handlerLabel(kind),
    status: change.status,
    subject,
    provider,
    requestedBy: change.createdBy.fullName,
    requestedAt: change.createdAt,
    decidedBy: change.decidedBy?.fullName ?? null,
    decidedAt: change.decidedAt,
  };
}

// ----------------------------------------
// The full view
// ----------------------------------------

interface Built {
  rows: ChangeRow[];
  impact: string[];
  /** Rows built from the snapshot taken at request time, to detect drift. */
  requestRows?: ChangeRow[];
}

async function build(change: PendingChange, payload: Record_, previous: Record_ | null, ctx: Ctx): Promise<Built> {
  const kind = `${change.entityType}.${change.action}`;
  const id = change.entityId;
  const pending = change.status === 'PENDING';

  switch (kind) {
    case 'Provider.CREATE':
      return {
        rows: compareRows(PROVIDER_FIELDS, null, payload, ctx),
        impact: [
          'Creates the provider with its own chart of accounts.',
          'It cannot lend until it is funded (Accounting → Capital) and has an active product.',
        ],
      };

    case 'Provider.UPDATE': {
      const current = pending && id ? await prisma.loanProvider.findUnique({ where: { id } }) : null;
      const before = current ? (providerFormValues(current) as unknown as Record_) : previous;
      const impact = ['Applies as soon as it is approved.'];
      if (before && before.collectionAccountNo !== payload.collectionAccountNo) {
        impact.push('Wallet repayments started after approval are collected into the new collection account.');
      }
      if (before?.status !== 'INACTIVE' && payload.status === 'INACTIVE' && id) {
        const products = await prisma.loanProduct.count({ where: { providerId: id, status: 'ACTIVE' } });
        impact.push(`Its ${products} active product(s) stop taking applications. Open loans are not affected.`);
      }
      return { rows: compareRows(PROVIDER_FIELDS, before, payload, ctx), impact, requestRows: current && previous ? compareRows(PROVIDER_FIELDS, previous, payload, ctx) : undefined };
    }

    case 'Product.CREATE':
    case 'Product.UPDATE': {
      const [lists, providers] = await Promise.all([
        prisma.eligibilityList.findMany({ select: { id: true, name: true, _count: { select: { entries: true } } } }),
        prisma.loanProvider.findMany({ select: { id: true, name: true } }),
      ]);
      const listNames = new Map(lists.map((l) => [l.id, `${l.name} (${l._count.entries.toLocaleString('en-US')} customers)`]));
      const specs = productFields(listNames, new Map(providers.map((p) => [p.id, p.name])), kind === 'Product.CREATE');
      if (kind === 'Product.CREATE') {
        return {
          rows: compareRows(specs, null, payload, ctx),
          impact: ['Created as a draft. Borrowers cannot apply until it is activated, which is a separate approval.'],
        };
      }
      const current = pending && id ? await prisma.loanProduct.findUnique({ where: { id } }) : null;
      const before = current ? (productFormValues(current) as unknown as Record_) : previous;
      const impact = ['Applies to loans taken after approval. Loans already issued keep the terms they were given.'];
      if (id) {
        const open = await prisma.loan.count({ where: { productId: id, status: { in: ['ACTIVE', 'PENDING_DISBURSEMENT'] } } });
        if (open) impact.push(`${open.toLocaleString('en-US')} open loan(s) on this product are unaffected.`);
      }
      if (before && (before.eligibilityListId ?? null) !== (payload.eligibilityListId ?? null)) {
        impact.push('Who can see and apply for the product changes the moment this is approved.');
      }
      return { rows: compareRows(specs, before, payload, ctx), impact, requestRows: current && previous ? compareRows(specs, previous, payload, ctx) : undefined };
    }

    case 'Product.STATUS': {
      const current = pending && id ? await prisma.loanProduct.findUnique({ where: { id }, select: { status: true } }) : null;
      const before = current ?? previous;
      const spec: FieldSpec[] = [{ label: 'Status', show: (r) => text(PRODUCT_STATUS[String(r.status)] ?? r.status) }];
      const impact =
        payload.status === 'ACTIVE'
          ? [
              'Borrowers who qualify can see and apply for the product as soon as this is approved.',
              'Refused when approved if the product uses credit scoring but has no amount tiers, or its provider has no scoring model.',
            ]
          : ['No new applications are accepted. Open loans and their repayments continue as normal.'];
      if (payload.status !== 'ACTIVE' && id) {
        const waiting = await prisma.loanApplication.count({ where: { productId: id, status: 'SUBMITTED' } });
        if (waiting) impact.push(`${waiting} application(s) already waiting for review stay in the queue.`);
      }
      return { rows: compareRows(spec, before, payload, ctx), impact };
    }

    case 'Product.TIERS': {
      const product = id ? await prisma.loanProduct.findUnique({ where: { id }, select: { maxAmount: true, requiresScoring: true, tiers: true } }) : null;
      const before = pending && product ? { tiers: product.tiers.map((t) => ({ minScore: t.minScore, maxScore: t.maxScore, maxAmount: t.maxAmount.toString() })) } : previous;
      const spec: FieldSpec[] = [{ label: 'Amount tiers', show: (r, c) => tiersTable(r.tiers, c) }];
      const impact = ['Changes the most each borrower can borrow, by credit score, from the moment it is approved. Open loans are not affected.'];
      if (product) impact.push(`The product maximum is ${formatMoney(toCents(product.maxAmount), ctx.currency)}; no tier can offer more.`);
      if (product && !product.requiresScoring) impact.push('This product does not use credit scoring at the moment, so the tiers have no effect until it does.');
      return { rows: compareRows(spec, before, payload, ctx), impact, requestRows: pending && previous ? compareRows(spec, previous, payload, ctx) : undefined };
    }

    case 'ScoringModel.UPDATE': {
      const catalogue = id ? await providerFieldCatalogue(prisma, id) : [];
      const stored = pending && id
        ? (await prisma.scoringParameter.findMany({ where: { providerId: id }, orderBy: { sortOrder: 'asc' }, include: { rules: true } })).map((p) => ({ field: p.rules[0]?.field ?? p.name, name: p.name, weight: p.weight, rules: p.rules }))
        : ((previous?.parameters as Record_[] | undefined) ?? []);
      const proposed = (payload.parameters as Record_[] | undefined) ?? [];
      const key = (p: Record_) => String(p.field ?? p.name).toLowerCase().replace(/[^a-z0-9]/g, '');
      const keys = [...new Set([...proposed.map(key), ...stored.map(key)])];
      const rows = keys.map((k) => {
        const b = stored.find((p) => key(p) === k);
        const a = proposed.find((p) => key(p) === k);
        const field = findField(catalogue, String((a ?? b)?.field ?? ''));
        const beforeDisplay = parameterList(b, field);
        const afterDisplay = a ? parameterList(a, field) : text('', { empty: 'Removed' });
        return { label: field?.label ?? String((a ?? b)?.name ?? k), before: beforeDisplay, after: afterDisplay, changed: !same(beforeDisplay, afterDisplay) };
      });
      const total = (list: Record_[]) => list.reduce((sum, p) => sum + Number(p.weight || 0), 0);
      const products = id ? await prisma.loanProduct.count({ where: { providerId: id, requiresScoring: true } }) : 0;
      return {
        rows,
        impact: [
          `Every borrower of this provider is scored with the new model from their next eligibility check — ${products} product(s) use scoring.`,
          `Highest possible score: ${total(stored)} ${pending ? 'now' : 'before'}, ${total(proposed)} with this model. Check the amount tiers cover the new range.`,
        ],
      };
    }

    case 'TaxRule.CREATE':
      return { rows: compareRows(TAX_FIELDS, null, payload, ctx), impact: ['Charged on loans taken after approval, on every provider. Existing loans keep the tax they were given.'] };

    case 'TaxRule.UPDATE': {
      const current = pending && id ? await prisma.taxRule.findUnique({ where: { id } }) : null;
      const before = current ? ({ ...current, ratePercent: current.ratePercent.toString() } as unknown as Record_) : previous;
      return {
        rows: compareRows(TAX_FIELDS, before, payload, ctx),
        impact: ['Applies to loans taken after approval, on every provider. Existing loans keep the tax they were given.'],
      };
    }

    case 'Terms.PUBLISH': {
      const providerId = String(payload.providerId ?? id ?? '');
      const active = await prisma.termsVersion.findFirst({ where: { providerId, isActive: true }, orderBy: { version: 'desc' } });
      const spec: FieldSpec[] = [{ label: 'Terms & conditions', show: (r) => ({ type: 'long', text: String(r.content ?? '') || 'None published' }) }];
      return {
        rows: compareRows(spec, { content: pending ? (active?.content ?? '') : '' }, payload, ctx).map((row) => (pending ? row : { ...row, before: null })),
        impact: [
          ...(pending ? [`Becomes version ${(active?.version ?? 0) + 1}; the current version stops being offered.`] : []),
          'Borrowers must accept the new version on their next application. Loans already taken keep the version accepted then.',
        ],
      };
    }

    case 'Settings.UPDATE': {
      const current = pending ? await getSettings(true) : null;
      const rows = Object.entries(payload).map(([key, value]) => {
        const def = SETTINGS_BY_KEY.get(key);
        const show = (v: unknown): Display => {
          if (def?.type === 'boolean') return yesNo(v, 'On', 'Off');
          const option = def?.options?.find((o) => o.value === String(v));
          return text(option?.label ?? v);
        };
        const beforeValue = current ? current[key] : previous?.[key];
        const b = beforeValue === undefined ? null : show(beforeValue);
        const a = show(value);
        return { label: def?.label ?? key, before: b, after: a, changed: !same(b, a) };
      });
      return { rows, impact: ['Applies across the whole platform as soon as it is approved.'] };
    }

    case 'Capital.POST': {
      const funds = id ? await fundPosition(prisma, id) : null;
      const inject = payload.direction === 'INJECT';
      const impact = [`Posts a journal that ${inject ? 'adds' : 'takes'} ${ctx.money(payload.amount)} ${inject ? 'to' : 'from'} the provider's fund.`];
      if (funds) impact.push(`Fund cash now: ${formatMoney(funds.cash, ctx.currency)}; available to lend: ${formatMoney(funds.available, ctx.currency)}.`);
      if (!inject) impact.push('Refused when approved if it is more than the fund has available then.');
      return {
        rows: [
          oneOff('Movement', text(inject ? 'Add capital to the fund' : 'Withdraw capital from the fund')),
          oneOff('Amount', text(ctx.money(payload.amount))),
          oneOff('Reference', text(payload.reference, { mono: true })),
          oneOff('Note', text(payload.note)),
        ],
        impact,
      };
    }

    case 'TaxRemittance.POST':
      return {
        rows: [oneOff('Amount', text(ctx.money(payload.amount))), oneOff('Reference', text(payload.reference, { mono: true }))],
        impact: [`Posts a journal paying ${ctx.money(payload.amount)} of collected tax out of the provider's cash.`],
      };

    case 'Repayment.MANUAL':
    case 'Loan.WRITE_OFF':
    case 'Loan.REFUND': {
      const loan = id ? await prisma.loan.findUnique({ where: { id } }) : null;
      const owed = loan
        ? toCents(loan.principalOutstanding) + toCents(loan.interestOutstanding) + toCents(loan.feeOutstanding) + toCents(loan.penaltyOutstanding) + toCents(loan.taxOutstanding)
        : null;
      const facts = loan ? [`The loan is ${loan.status.toLowerCase().replace(/_/g, ' ')} and owes ${formatMoney(owed!, ctx.currency)} as of its last accrual.`] : [];
      if (kind === 'Repayment.MANUAL') {
        return {
          rows: [oneOff('Amount received', text(ctx.money(payload.amount))), oneOff('Reference', text(payload.reference, { mono: true })), oneOff('Note', text(payload.note))],
          impact: [...facts, 'Applied as if the borrower paid it: penalties first, then fees, interest, tax and principal. Posts a journal and issues a receipt.'],
        };
      }
      if (kind === 'Loan.WRITE_OFF') {
        return {
          rows: loan ? [oneOff('Outstanding written off', text(formatMoney(owed!, ctx.currency)))] : [],
          impact: [
            ...facts,
            ...(pending && loan && loan.status !== 'ACTIVE' ? ['This loan is no longer active, so approving will be refused.'] : []),
            'Interest is brought up to date, then everything outstanding is removed from the books and the loan is closed. Only an active loan can be written off.',
          ],
        };
      }
      return {
        rows: [oneOff('Refund', text(ctx.money(payload.amount))), oneOff('Reference', text(payload.reference, { mono: true }))],
        impact: [
          ...(loan ? [`Overpayment held on this loan: ${formatMoney(toCents(loan.creditBalance), ctx.currency)}.`] : []),
          "Pays the overpayment back out of the provider's cash. Refused if it is more than the overpayment held.",
        ],
      };
    }

    case 'Repayment.REVERSE': {
      const repayment = id ? await prisma.repayment.findUnique({ where: { id } }) : null;
      return {
        rows: repayment
          ? [
              oneOff('Receipt', text(repayment.receiptNo, { mono: true })),
              oneOff('Amount', text(formatMoney(toCents(repayment.amount), ctx.currency))),
              oneOff('Received', text(formatDateTime(repayment.receivedAt))),
              oneOff('Channel', text(repayment.channel)),
            ]
          : [],
        impact: ['Undoes the repayment: the loan owes that money again, and a reversing journal is posted. A loan it had paid off is reopened.'],
      };
    }

    case 'Disbursement.RESOLVE': {
      const attempt = id ? await prisma.disbursementAttempt.findUnique({ where: { id } }) : null;
      const confirm = payload.resolution === 'CONFIRM';
      return {
        rows: [
          oneOff('Decision', text(confirm ? 'The money reached the borrower' : 'The money did not reach the borrower')),
          oneOff('Core banking reference', text(payload.reference ?? attempt?.cbsReference, { mono: true })),
          ...(attempt ? [oneOff('Amount', text(formatMoney(toCents(attempt.amount), ctx.currency))), oneOff('Paid to account', text(attempt.creditAccount, { mono: true }))] : []),
        ],
        impact: confirm
          ? ['The loan starts as disbursed: the borrower owes it and its schedule runs from today.']
          : ["Recorded as failed: the provider's reserved funds are released and the borrower owes nothing."],
      };
    }

    case 'Borrower.PHONE_CHANGE': {
      const borrower = id ? await prisma.borrower.findUnique({ where: { id }, select: { phoneNumber: true } }) : null;
      const taken = await prisma.borrowerPhone.findUnique({ where: { phoneNumber: String(payload.newPhoneNumber ?? '') }, select: { borrowerId: true } });
      const impact = ['The borrower signs in with the new number and sees their loans there. Their old number stays on record.'];
      if (taken && taken.borrowerId !== id) impact.push('Another borrower record already uses the new number; approving combines the two into this borrower.');
      return {
        rows: [{ label: 'Phone number', before: text(borrower?.phoneNumber ?? previous?.phoneNumber, { mono: true }), after: text(payload.newPhoneNumber, { mono: true }), changed: true }],
        impact,
      };
    }

    default:
      return { rows: Object.entries(payload).map(([k, v]) => oneOff(k, typeof v === 'object' ? { type: 'long', text: JSON.stringify(v, null, 2) } : text(v))), impact: [] };
  }
}

/** What the maker asked for, as the end of "Abebe asked to …". */
const PHRASES: Record<string, (named: string, payload: Record_) => string> = {
  'Provider.CREATE': (s) => `create provider ${s}`,
  'Provider.UPDATE': (s) => `update provider ${s}`,
  'Product.CREATE': (s) => `create product ${s}`,
  'Product.UPDATE': (s) => `update product ${s}`,
  'Product.STATUS': (s, p) => `${p.status === 'ACTIVE' ? 'activate' : 'deactivate'} product ${s}`,
  'Product.TIERS': (s) => `replace the amount tiers of product ${s}`,
  'ScoringModel.UPDATE': (s) => `replace the scoring model of ${s}`,
  'TaxRule.CREATE': (s) => `create tax ${s}`,
  'TaxRule.UPDATE': (s) => `update tax ${s}`,
  'Terms.PUBLISH': (s) => `publish new terms & conditions for ${s}`,
  'Settings.UPDATE': () => 'change platform settings',
  'Capital.POST': (s, p) => `${p.direction === 'INJECT' ? 'add capital to' : 'withdraw capital from'} ${s}`,
  'TaxRemittance.POST': (s) => `remit collected tax for ${s}`,
  'Repayment.MANUAL': (s) => `record a repayment on loan ${s}`,
  'Repayment.REVERSE': (s) => `reverse ${s}`,
  'Loan.WRITE_OFF': (s) => `write off loan ${s}`,
  'Loan.REFUND': (s) => `refund an overpayment on loan ${s}`,
  'Disbursement.RESOLVE': (s, p) => `mark the disbursement of loan ${s} as ${p.resolution === 'CONFIRM' ? 'received' : 'failed'}`,
  'Borrower.PHONE_CHANGE': (s) => `change the phone number of ${s}`,
};

export async function buildChangeView(change: Change): Promise<ChangeView> {
  const summary = await summarizeChange(change);
  const payload = parse(change.payload) ?? {};
  const previous = parse(change.previousData);
  const settings = await getSettings();
  const currency = String(settings['platform.currency'] || 'ETB');
  const ctx: Ctx = { currency, money: moneyOf(currency) };

  const built = await build(change, payload, previous, ctx);
  const hasBefore = built.rows.some((r) => r.before !== null);
  const drifted = Boolean(
    built.requestRows && built.requestRows.some((row, i) => !same(row.before, built.rows[i]?.before))
  );

  const reasonText = payload.reason ?? (change.entityType === 'Disbursement' ? payload.note : undefined);
  // Without a subject — the record it was about is gone — there is nothing to name.
  const phrase = (summary.subject && PHRASES[summary.kind]?.(`“${summary.subject.name}”`, payload)) || summary.label.toLowerCase();

  return {
    ...summary,
    sentence: `${summary.requestedBy} asked to ${phrase}.`,
    reason: typeof reasonText === 'string' && reasonText.trim() ? reasonText.trim() : null,
    impact: built.impact,
    rows: built.rows,
    comparedWith: hasBefore ? (change.status === 'PENDING' ? 'NOW' : 'AT_REQUEST') : null,
    drifted,
    comment: change.comment,
    failureReason: change.failureReason,
  };
}
