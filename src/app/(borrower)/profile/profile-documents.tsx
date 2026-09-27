'use client';

import { useRouter } from 'next/navigation';
import { DocumentList } from '@/components/borrower/document-list';
import type { BorrowerDocumentItem } from '@/lib/lending/document-requirements';

export function ProfileDocuments({ items }: { items: BorrowerDocumentItem[] }) {
  const router = useRouter();
  const approved = items.filter((i) => i.satisfied).length;

  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-semibold">My documents</h2>
        {items.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {approved} of {items.length} approved
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Checked once, then used for every loan that needs them. Changes are reviewed before they replace what is on file.
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing has been asked of you yet.</p>
      ) : (
        <DocumentList items={items} onChanged={() => router.refresh()} />
      )}
    </section>
  );
}
