'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, FileUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ApplicationActions({
  applicationId,
  open,
  required,
  uploaded,
}: {
  applicationId: string;
  open: boolean;
  required: { key: string; name: string; description: string | null }[];
  uploaded: { key: string; fileName: string }[];
}) {
  const router = useRouter();
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [withdrawing, setWithdrawing] = useState(false);
  const done = new Map(uploaded.map((u) => [u.key, u.fileName]));

  const upload = async (key: string, file: File) => {
    setBusyKey(key);
    setErrors((e) => ({ ...e, [key]: '' }));
    try {
      const form = new FormData();
      form.append('documentKey', key);
      form.append('file', file);
      const response = await fetch(`/api/app/applications/${applicationId}/documents`, { method: 'POST', body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setErrors((e) => ({ ...e, [key]: data?.error || 'Upload failed.' }));
        return;
      }
      router.refresh();
    } finally {
      setBusyKey(null);
    }
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
          <p className="text-xs text-muted-foreground">PDF, JPEG or PNG, up to 5 MB each.</p>
          <ul className="mt-3 space-y-2">
            {required.map((doc) => (
              <li key={doc.key} className="rounded-xl border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm">
                    <span className="flex items-center gap-1.5 font-medium">
                      {done.has(doc.key) && <CheckCircle2 className="h-4 w-4 text-success" />}
                      {doc.name}
                    </span>
                    <span className="block text-xs text-muted-foreground">{done.get(doc.key) ?? doc.description ?? 'Not uploaded yet'}</span>
                  </span>
                  {open && (
                    <>
                      <input
                        ref={(el) => {
                          inputs.current[doc.key] = el;
                        }}
                        type="file"
                        accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                        className="hidden"
                        onChange={(e) => e.target.files?.[0] && upload(doc.key, e.target.files[0])}
                      />
                      <Button type="button" size="sm" variant="outline" disabled={busyKey !== null} onClick={() => inputs.current[doc.key]?.click()}>
                        {busyKey === doc.key ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="mr-1 h-4 w-4" />}
                        {done.has(doc.key) ? 'Replace' : 'Upload'}
                      </Button>
                    </>
                  )}
                </div>
                {errors[doc.key] && <p className="mt-1 text-xs text-destructive">{errors[doc.key]}</p>}
              </li>
            ))}
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
