import { cn } from '@/lib/utils';

export function Th({ children, right, className }: { children: React.ReactNode; right?: boolean; className?: string }) {
  return <th className={cn('px-4 py-2.5 font-semibold', right && 'text-right', className)}>{children}</th>;
}

export function Td({ children, right, className }: { children: React.ReactNode; right?: boolean; className?: string }) {
  return <td className={cn('px-4 py-2', right && 'num text-right', className)}>{children}</td>;
}

export function THead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="border-b border-border bg-secondary/50 text-left">
      <tr>{children}</tr>
    </thead>
  );
}

export function SectionTitle({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-2 mt-6 first:mt-0">
      <h2 className="text-sm font-semibold">{title}</h2>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

export function percentOf(part: number, whole: number, digits = 1) {
  return whole ? `${((part / whole) * 100).toFixed(digits)}%` : '—';
}
