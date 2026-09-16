import Link from 'next/link';
import { cn } from '@/lib/utils';

export function TableCard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-border bg-card',
        className
      )}
    >
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

export function EmptyRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10 text-center text-sm text-muted-foreground">
        {message}
      </td>
    </tr>
  );
}

/** Server-rendered pagination; keeps all other query params intact. */
export function Pager({
  page,
  pageSize,
  total,
  basePath,
  params,
}: {
  page: number;
  pageSize: number;
  total: number;
  basePath: string;
  params: Record<string, string | undefined>;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;

  const buildHref = (target: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, value);
    }
    search.set('page', String(target));
    return `${basePath}?${search.toString()}`;
  };

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-sm">
      <p className="text-muted-foreground">
        Showing <strong>{from}</strong>–<strong>{to}</strong> of <strong>{total}</strong>
      </p>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link
            href={buildHref(page - 1)}
            className="rounded-md border border-border px-3 py-1.5 font-medium transition hover:bg-secondary"
          >
            Previous
          </Link>
        ) : (
          <span className="rounded-md border border-border px-3 py-1.5 font-medium opacity-40">
            Previous
          </span>
        )}
        <span className="text-muted-foreground">
          Page {page} of {totalPages}
        </span>
        {page < totalPages ? (
          <Link
            href={buildHref(page + 1)}
            className="rounded-md border border-border px-3 py-1.5 font-medium transition hover:bg-secondary"
          >
            Next
          </Link>
        ) : (
          <span className="rounded-md border border-border px-3 py-1.5 font-medium opacity-40">
            Next
          </span>
        )}
      </div>
    </div>
  );
}

export function FilterBar({ children }: { children: React.ReactNode }) {
  return (
    <form
      method="get"
      className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-3"
    >
      {children}
    </form>
  );
}
