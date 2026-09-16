'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Collapsed JSON payload for one audit row. */
export function AuditDetails({
  details,
  ipAddress,
}: {
  details: string | null;
  ipAddress: string | null;
}) {
  const [open, setOpen] = useState(false);

  if (!details) {
    return <span className="text-xs text-muted-foreground">{ipAddress || '—'}</span>;
  }

  let pretty = details;
  try {
    pretty = JSON.stringify(JSON.parse(details), null, 2);
  } catch {
    // Keep the raw string when it is not valid JSON.
  }

  return (
    <div className="max-w-[420px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        {open ? 'Hide' : 'Show'} details
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg bg-secondary/60 p-2 text-[11px] leading-relaxed">
          {pretty}
        </pre>
      )}
      {ipAddress && <p className="mt-1 text-[11px] text-muted-foreground">IP {ipAddress}</p>}
    </div>
  );
}
