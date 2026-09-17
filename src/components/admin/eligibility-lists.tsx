'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download, FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';

const ENDPOINT = '/api/admin/products/eligibility-lists';
const ACCEPT = '.xlsx,.xlsm,.csv,.txt';

type Rejection = { row: number; value: string; reason: string };
type Result = { message: string; duplicates: number; rejections: Rejection[]; rejectedCount: number };

async function postForm(url: string, form: FormData) {
  const response = await fetch(url, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, data };
}

function toResult(data: { message: string; summary: { duplicatesInFile: number; rejected: number }; rejections?: Rejection[] }): Result {
  return {
    message: data.message,
    duplicates: data.summary.duplicatesInFile,
    rejectedCount: data.summary.rejected,
    rejections: data.rejections ?? [],
  };
}

/** What happened to the file: how many loaded, and each row that did not, with why. */
function UploadResult({ result }: { result: Result }) {
  return (
    <div className="mt-2 text-xs">
      <p className="font-medium">{result.message}</p>
      {result.duplicates > 0 && <p className="text-muted-foreground">{result.duplicates} repeated number(s) in the file were counted once.</p>}
      {result.rejectedCount > 0 && (
        <>
          <p className="mt-1 text-destructive">
            {result.rejectedCount} row(s) were skipped{result.rejectedCount > result.rejections.length ? `; the first ${result.rejections.length} are listed` : ''}:
          </p>
          <ul className="mt-1 max-h-40 overflow-auto rounded bg-destructive/10 p-2 text-destructive">
            {result.rejections.map((r) => (
              <li key={r.row}>
                Row {r.row}
                {r.value ? ` (${r.value})` : ''}: {r.reason}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function TemplateLink() {
  return (
    <a href={ENDPOINT} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
      <Download className="h-3 w-3" /> Template
    </a>
  );
}

/**
 * Uploads a spreadsheet as a new saved list. Used on its own on the lists page,
 * and inside the product form, where the new list is selected straight away.
 */
export function NewEligibilityList({
  providerId,
  onCreated,
  onCancel,
}: {
  providerId: string;
  onCreated?: (list: { id: string; name: string; entryCount: number }) => void;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const problems: Record<string, string> = {};
    if (name.trim().length < 2) problems.name = 'Name the list.';
    if (!file) problems.file = 'Choose the Excel or CSV file.';
    setErrors(problems);
    if (Object.keys(problems).length) return;

    setBusy(true);
    setResult(null);
    try {
      const form = new FormData();
      form.append('providerId', providerId);
      form.append('name', name.trim());
      form.append('file', file!);
      const { ok, data } = await postForm(ENDPOINT, form);
      if (!ok) {
        if (data?.field === 'name' || data?.field === 'file') setErrors({ [data.field]: data.error });
        else toast({ variant: 'destructive', title: 'Upload failed', description: data?.error });
        return;
      }
      setResult(toResult(data));
      toast({ title: data.message });
      onCreated?.({ id: data.id, name: data.name, entryCount: data.summary.total });
      setName('');
      setFile(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-secondary/30 p-3 text-sm">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="list-name">List name</Label>
          <Input
            id="list-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            // This sits inside the product form, where Enter would submit the whole product.
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="Payroll customers – March"
            className={errors.name ? 'border-destructive' : ''}
          />
          {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label>Customers file</Label>
            <TemplateLink />
          </div>
          <input ref={fileInput} type="file" accept={ACCEPT} className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <Button type="button" variant="outline" className={`w-full justify-start ${errors.file ? 'border-destructive' : ''}`} onClick={() => fileInput.current?.click()}>
            <FileSpreadsheet className="mr-2 h-4 w-4 shrink-0" />
            <span className="truncate">{file ? file.name : 'Choose .xlsx or .csv'}</span>
          </Button>
          {errors.file ? (
            <p className="text-xs text-destructive">{errors.file}</p>
          ) : (
            <p className="text-xs text-muted-foreground">Needs a phone column (e.g. 0911223344). A name column is optional.</p>
          )}
        </div>
      </div>
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={submit} disabled={busy}>
          {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1.5 h-3.5 w-3.5" />}
          Upload and save list
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {result && <UploadResult result={result} />}
    </div>
  );
}

/** Loads a new file into an existing list: replacing its customers, or adding to them. */
export function ImportIntoList({ listId, listName, productCount }: { listId: string; listName: string; productCount: number }) {
  const router = useRouter();
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const mode = useRef<'replace' | 'append'>('append');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const openPicker = (next: 'replace' | 'append') => {
    mode.current = next;
    fileInput.current?.click();
  };

  const pick = (next: 'replace' | 'append') => {
    if (next === 'replace' && productCount > 0) {
      setConfirmReplace(true);
      return;
    }
    openPicker(next);
  };

  const upload = async (file: File) => {
    setBusy(true);
    setResult(null);
    try {
      const form = new FormData();
      form.append('mode', mode.current);
      form.append('file', file);
      const { ok, data } = await postForm(`${ENDPOINT}/${listId}`, form);
      if (!ok) {
        toast({ variant: 'destructive', title: 'Upload failed', description: data?.error });
        return;
      }
      setResult(toResult(data));
      router.refresh();
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <div>
      <input ref={fileInput} type="file" accept={ACCEPT} className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => pick('append')}>
          {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1.5 h-3.5 w-3.5" />}
          Add customers
        </Button>
        <AlertDialog open={confirmReplace} onOpenChange={setConfirmReplace}>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => pick('replace')}>
            Replace list
          </Button>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Replace list</AlertDialogTitle>
              <AlertDialogDescription>
                Replace everyone on {listName}? Customers missing from the new file can no longer take the {productCount} product(s) using it.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className={buttonVariants({ variant: 'destructive' })}
                // The picker needs the dialog gone first; the click still counts as user-initiated.
                onClick={() => setTimeout(() => openPicker('replace'), 0)}
              >
                Choose file
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      {result && <UploadResult result={result} />}
    </div>
  );
}
