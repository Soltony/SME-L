'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, FileUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { acceptAttribute, DOCUMENT_KINDS, MAX_ANSWER_LENGTH, type DocumentKind } from '@/lib/document-kinds';

type Required = { key: string; name: string; description: string | null; type: DocumentKind };

export function ApplicationActions({
  applicationId,
  open,
  required,
  uploaded,
  answers,
}: {
  applicationId: string;
  open: boolean;
  required: Required[];
  uploaded: { key: string; fileName: string }[];
  answers: { key: string; value: string }[];
}) {
  const router = useRouter();
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(answers.map((a) => [a.key, a.value])));
  const [withdrawing, setWithdrawing] = useState(false);
  const files = new Map(uploaded.map((u) => [u.key, u.fileName]));
  const answered = new Map(answers.map((a) => [a.key, a.value]));

  const send = async (key: string, body: FormData | string) => {
    setBusyKey(key);
    setErrors((e) => ({ ...e, [key]: '' }));
    try {
      const response = await fetch(`/api/app/applications/${applicationId}/documents`, {
        method: 'POST',
        body,
        ...(typeof body === 'string' ? { headers: { 'Content-Type': 'application/json' } } : {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setErrors((e) => ({ ...e, [key]: data?.error || 'Could not save.' }));
        return;
      }
      router.refresh();
    } finally {
      setBusyKey(null);
    }
  };

  const upload = (key: string, file: File) => {
    const form = new FormData();
    form.append('documentKey', key);
    form.append('file', file);
    return send(key, form);
  };

  const withdraw = async () => {
    if (!window.confirm('Withdraw this application?')) return;
    setWithdrawing(true);
    try {
      await fetch(`/api/app/applications/${applicationId}`, { method: 'DELETE' });
      router.refresh();
    } finally {
      setWithdrawing(false);
    }
  };

  return (
    <>
      {required.length > 0 && (
        <section className="rounded-2xl border border-border bg-card p-4">
          <h2 className="font-semibold">Documents</h2>
          <p className="text-xs text-muted-foreground">Up to 5 MB per file.</p>
          <ul className="mt-3 space-y-2">
            {required.map((doc) => {
              const typed = doc.type === 'TEXT';
              const done = typed ? answered.has(doc.key) : files.has(doc.key);
              const draft = drafts[doc.key] ?? '';
              return (
                <li key={doc.key} className="rounded-xl border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 text-sm">
                      <span className="flex items-center gap-1.5 font-medium">
                        {done && <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />}
                        {doc.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {typed ? doc.description ?? DOCUMENT_KINDS.TEXT.hint : files.get(doc.key) ?? doc.description ?? DOCUMENT_KINDS[doc.type].hint}
                      </span>
                    </span>
                    {open && !typed && (
                      <>
                        <input
                          ref={(el) => {
                            inputs.current[doc.key] = el;
                          }}
                          type="file"
                          accept={acceptAttribute(doc.type)}
                          className="hidden"
                          onChange={(e) => e.target.files?.[0] && upload(doc.key, e.target.files[0])}
                        />
                        <Button type="button" size="sm" variant="outline" disabled={busyKey !== null} onClick={() => inputs.current[doc.key]?.click()}>
                          {busyKey === doc.key ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="mr-1 h-4 w-4" />}
                          {done ? 'Replace' : 'Upload'}
                        </Button>
                      </>
                    )}
                  </div>
                  {typed &&
                    (open ? (
                      <form
                        className="mt-2 flex gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void send(doc.key, JSON.stringify({ documentKey: doc.key, value: draft }));
                        }}
                      >
                        <Input
                          aria-label={doc.name}
                          value={draft}
                          maxLength={MAX_ANSWER_LENGTH}
                          onChange={(e) => setDrafts((d) => ({ ...d, [doc.key]: e.target.value }))}
                        />
                        <Button type="submit" size="sm" variant="outline" disabled={busyKey !== null || !draft.trim() || draft.trim() === answered.get(doc.key)}>
                          {busyKey === doc.key ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
                        </Button>
                      </form>
                    ) : (
                      <p className="mt-1 break-words text-sm">{answered.get(doc.key) ?? 'Not provided'}</p>
                    ))}
                  {errors[doc.key] && <p className="mt-1 text-xs text-destructive">{errors[doc.key]}</p>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {open && (
        <Button variant="ghost" className="w-full text-destructive" onClick={withdraw} disabled={withdrawing}>
          {withdrawing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Withdraw application
        </Button>
      )}
    </>
  );
}
