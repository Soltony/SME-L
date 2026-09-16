'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Undo2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { postJson } from './action-dialog';

/** Approve / reject for a checker, withdraw for the maker. */
export function ChangeDecision({
  changeId,
  canDecide,
  isOwn,
}: {
  changeId: string;
  canDecide: boolean;
  isOwn: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const send = async (decision: 'APPROVED' | 'REJECTED' | 'WITHDRAW') => {
    setBusy(decision);
    try {
      const { ok, data } = await postJson(`/api/admin/approvals/${changeId}`, { decision, comment });
      if (!ok) {
        toast({ variant: 'destructive', title: 'Not applied', description: data?.error });
        return;
      }
      toast({ title: data?.message || 'Done', description: data?.result ? `Reference: ${data.result}` : undefined });
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  if (isOwn) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">You requested this; someone else must decide it.</p>
        <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => send('WITHDRAW')}>
          {busy === 'WITHDRAW' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Undo2 className="mr-1.5 h-3.5 w-3.5" />}
          Withdraw
        </Button>
      </div>
    );
  }

  if (!canDecide) {
    return <p className="text-xs text-muted-foreground">You do not have approval rights for this kind of change.</p>;
  }

  return (
    <div className="space-y-2">
      <Textarea
        rows={2}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Comment (required to reject)"
        className="text-sm"
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={Boolean(busy)} onClick={() => send('APPROVED')}>
          {busy === 'APPROVED' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
          Approve & apply
        </Button>
        <Button size="sm" variant="outline" className="text-destructive" disabled={Boolean(busy) || comment.trim().length === 0} onClick={() => send('REJECTED')}>
          {busy === 'REJECTED' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <X className="mr-1.5 h-3.5 w-3.5" />}
          Reject
        </Button>
      </div>
    </div>
  );
}
