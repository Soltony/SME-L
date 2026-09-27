'use client';

import { useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock, FileUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { acceptAttribute, DOCUMENT_KINDS, MAX_ANSWER_LENGTH } from '@/lib/document-kinds';
import { REQUIREMENT_LABELS, type BorrowerDocumentItem } from '@/lib/lending/document-requirements';
import { cn } from '@/lib/utils';

/**
 * The borrower's required documents, each with where they stand and a way to
 * provide it. Used on the profile, for everything they have been asked for,
 * and on a product page, for what that product needs.
 *
 * Replacing an approved document is always possible and always reviewed; the
 * approved one keeps counting until then, and the card says so, so nobody
 * hesitates to keep their papers current for fear of losing access.
 */

function formatIso(iso: string | null) {
  if (!iso) return '';
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const STATUS_STYLE: Record<BorrowerDocumentItem['status'], string> = {
  APPROVED: 'bg-success/15 text-success',
  PENDING: 'bg-warning/15 text-warning',
  REJECTED: 'bg-destructive/10 text-destructive',
  EXPIRED: 'bg-destructive/10 text-destructive',
  MISSING: 'bg-secondary text-muted-foreground',
};

function StatusIcon({ status }: { status: BorrowerDocumentItem['status'] }) {
  if (status === 'APPROVED') return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (status === 'PENDING') return <Clock className="h-3.5 w-3.5" />;
  if (status === 'MISSING') return null;
  return <AlertCircle className="h-3.5 w-3.5" />;
}

export function DocumentCard({ item, color, onChanged }: { item: BorrowerDocumentItem; color?: string; onChanged: () => void | Promise<void> }) {
  const typed = item.kind === 'TEXT';
  const needsAction = item.status === 'MISSING' || item.status === 'REJECTED' || item.status === 'EXPIRED';
  const [open, setOpen] = useState(needsAction);
  const [value, setValue] = useState(item.pending?.value ?? item.approved?.value ?? '');
  const [expiresOn, setExpiresOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const send = async (body: FormData | string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch('/api/app/documents', {
        method: 'POST',
        body,
        ...(typeof body === 'string' ? { headers: { 'Content-Type': 'application/json' } } : {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data?.error || 'Could not send it. Please try again.');
        return;
      }
      setNotice(data?.message ?? 'Sent for review.');
      setOpen(false);
      setExpiresOn('');
      await onChanged();
    } catch {
      setError('Network error. Check your connection and try again.');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const chooseFile = () => {
    if (item.requiresExpiry && !expiresOn) {
      setError('Enter the expiry date first.');
      return;
    }
    fileInput.current?.click();
  };

  const upload = (file: File) => {
    const form = new FormData();
    form.append('documentTypeId', item.typeId);
    form.append('file', file);
    if (expiresOn) form.append('expiresOn', expiresOn);
    void send(form);
  };

  const actionLabel = item.status === 'APPROVED' ? 'Replace' : item.status === 'PENDING' ? 'Send a different one' : item.status === 'MISSING' ? (typed ? 'Enter' : 'Upload') : 'Upload again';

  return (
    <li className="rounded-xl border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 text-sm">
          <p className="font-medium">{item.name}</p>
          <p className="text-xs text-muted-foreground">
            {item.providerName ? `Asked by ${item.providerName}` : 'Required by the bank for every loan'}
            {item.description ? ` · ${item.description}` : ''}
          </p>
        </div>
        <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold', STATUS_STYLE[item.status])}>
          <StatusIcon status={item.status} />
          {REQUIREMENT_LABELS[item.status]}
        </span>
      </div>

      <div className="mt-2 space-y-1 text-xs text-muted-foreground">
        {item.approved && (
          <p>
            {item.status === 'EXPIRED' ? 'Expired' : 'On file'}: {item.approved.fileName ?? item.approved.value}
            {item.approved.expiresOn && ` · ${item.status === 'EXPIRED' ? 'expired' : 'valid until'} ${formatIso(item.approved.expiresOn)}`}
          </p>
        )}
        {item.pending && (
          <p className="text-warning">
            {item.approved ? 'New version' : 'Sent'} {formatIso(item.pending.submittedAt)} — waiting for review
            {item.approved && item.status === 'APPROVED' ? '. Your approved one stays in use until then.' : '.'}
          </p>
        )}
        {item.rejected && (
          <p className="rounded-lg bg-destructive/10 p-2 text-destructive">
            {item.approved && item.status === 'APPROVED' ? 'Your replacement was not accepted' : 'Not accepted'}
            {item.rejected.reason ? `: ${item.rejected.reason}` : '.'}
            {item.approved && item.status === 'APPROVED' ? ' Your approved document is still in use.' : ''}
          </p>
        )}
      </div>

      {notice && <p className="mt-2 text-xs text-success">{notice}</p>}

      {!open ? (
        <button type="button" className="mt-2 text-xs font-medium underline" style={color ? { color } : undefined} onClick={() => setOpen(true)}>
          {actionLabel}
        </button>
      ) : (
        <div className="mt-3 space-y-2">
          {item.status === 'APPROVED' && (
            <p className="text-[11px] text-muted-foreground">The new one is checked before it replaces your approved document.</p>
          )}
          {item.requiresExpiry && (
            <label className="block text-xs">
              <span className="text-muted-foreground">Expiry date</span>
              <Input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} className="mt-1 h-9" aria-label={`${item.name} expiry date`} />
            </label>
          )}
          {typed ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send(JSON.stringify({ documentTypeId: item.typeId, value, expiresOn: expiresOn || null }));
              }}
            >
              <Input aria-label={item.name} value={value} maxLength={MAX_ANSWER_LENGTH} onChange={(e) => setValue(e.target.value)} className="h-9" />
              <Button type="submit" size="sm" variant="outline" disabled={busy || !value.trim()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send'}
              </Button>
            </form>
          ) : (
            <>
              <input
                ref={fileInput}
                type="file"
                accept={acceptAttribute(item.kind)}
                className="hidden"
                onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
              />
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={chooseFile}>
                {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FileUp className="mr-1 h-4 w-4" />}
                Choose file
              </Button>
              <p className="text-[11px] text-muted-foreground">{DOCUMENT_KINDS[item.kind].hint}</p>
            </>
          )}
          {!needsAction && (
            <button type="button" className="text-[11px] text-muted-foreground underline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
          )}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </li>
  );
}

export function DocumentList({
  items,
  color,
  onChanged,
}: {
  items: BorrowerDocumentItem[];
  color?: string;
  onChanged: () => void | Promise<void>;
}) {
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <DocumentCard key={item.typeId} item={item} color={color} onChanged={onChanged} />
      ))}
    </ul>
  );
}
