'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { postJson } from './action-dialog';

type Column = { name: string; type: string; isIdentifier: boolean };

export function NewDataSet({ providerId }: { providerId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [columns, setColumns] = useState<Column[]>([
    { name: 'Phone', type: 'string', isIdentifier: true },
    { name: '', type: 'number', isIdentifier: false },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-4 w-4" /> New data set
      </Button>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await postJson(`/api/admin/credit-scoring/${providerId}`, { action: 'create-config', name, columns });
      if (!ok) {
        setError(data?.error || 'Could not create.');
        return;
      }
      toast({ title: data.message });
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel space-y-3 p-4 text-sm">
      <h3 className="font-semibold">New data set</h3>
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Business profile" aria-label="Data set name" />
      <p className="text-xs text-muted-foreground">Declare the columns the spreadsheet will have. One column must hold the borrower&apos;s phone number.</p>
      {columns.map((column, i) => (
        <div key={i} className="grid grid-cols-[1fr_120px_140px_40px] items-center gap-2">
          <Input value={column.name} onChange={(e) => setColumns(columns.map((c, j) => (j === i ? { ...c, name: e.target.value } : c)))} placeholder="Column name" aria-label="Column name" />
          <select value={column.type} onChange={(e) => setColumns(columns.map((c, j) => (j === i ? { ...c, type: e.target.value } : c)))} className="h-10 rounded-md border border-input bg-background px-2" aria-label="Type">
            <option value="string">Text</option>
            <option value="number">Number</option>
            <option value="date">Date</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs">
            <input type="radio" name="identifier" checked={column.isIdentifier} onChange={() => setColumns(columns.map((c, j) => ({ ...c, isIdentifier: j === i })))} />
            Phone identifier
          </label>
          <Button type="button" variant="ghost" size="icon" aria-label="Remove column" onClick={() => setColumns(columns.filter((_, j) => j !== i))}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      {error && <p className="text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setColumns([...columns, { name: '', type: 'string', isIdentifier: false }])}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Column
        </Button>
        <Button type="button" size="sm" onClick={submit} disabled={busy}>
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Create
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function UploadData({ configId }: { configId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ message: string; rejections: { row: number; reason: string }[] } | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setResult(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch(`/api/admin/credit-scoring/uploads/${configId}`, { method: 'POST', body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast({ variant: 'destructive', title: 'Upload failed', description: data?.error });
        return;
      }
      setResult({ message: data.message, rejections: data.rejections ?? [] });
      router.refresh();
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div>
      <input ref={input} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1.5 h-3.5 w-3.5" />}
        Upload .xlsx / .csv
      </Button>
      {result && (
        <div className="mt-2 text-xs">
          <p className="font-medium">{result.message}</p>
          {result.rejections.length > 0 && (
            <ul className="mt-1 max-h-40 overflow-auto rounded bg-destructive/10 p-2 text-destructive">
              {result.rejections.map((r) => (
                <li key={r.row}>
                  Row {r.row}: {r.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
