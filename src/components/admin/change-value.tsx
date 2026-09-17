import type { Display } from '@/lib/approval-view';
import { ProviderIcon } from '@/components/provider-icon';
import { cn } from '@/lib/utils';

/** One side of a change: a value, formatted as the approver should read it. */
export function ChangeValue({ value, emphasis = false }: { value: Display; emphasis?: boolean }) {
  switch (value.type) {
    case 'text':
      return (
        <span className={cn(value.mono && 'font-mono', value.muted && 'text-muted-foreground', emphasis && !value.muted && 'font-medium')}>{value.text}</span>
      );
    case 'long':
      return <p className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-secondary/40 p-2 text-xs">{value.text}</p>;
    case 'color':
      return (
        <span className="inline-flex items-center gap-2">
          <span className="h-4 w-4 rounded border border-border" style={{ backgroundColor: value.hex }} />
          <span className="font-mono text-xs">{value.hex}</span>
        </span>
      );
    case 'icon':
      return (
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border">
          <ProviderIcon icon={value.icon} color={value.color} />
        </span>
      );
    case 'list':
      return (
        <ul className="list-inside list-disc space-y-0.5">
          {value.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="bg-secondary/50 text-left">
              <tr>
                {value.columns.map((column) => (
                  <th key={column} className="whitespace-nowrap px-2 py-1 font-semibold">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {value.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} className="whitespace-nowrap px-2 py-1">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}
