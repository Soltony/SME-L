'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
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

export function ApplicationActions({ applicationId, open }: { applicationId: string; open: boolean }) {
  const router = useRouter();
  const [withdrawing, setWithdrawing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const withdraw = async () => {
    setWithdrawing(true);
    try {
      await fetch(`/api/app/applications/${applicationId}`, { method: 'DELETE' });
      setConfirmOpen(false);
      router.refresh();
    } finally {
      setWithdrawing(false);
    }
  };

  if (!open) return null;
  return (
    <AlertDialog open={confirmOpen} onOpenChange={(next) => !withdrawing && setConfirmOpen(next)}>
      <Button variant="ghost" className="w-full text-destructive" onClick={() => setConfirmOpen(true)} disabled={withdrawing}>
        {withdrawing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Withdraw application
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Withdraw application</AlertDialogTitle>
          <AlertDialogDescription>Withdraw this application? You will need to apply again if you change your mind.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={withdrawing}>Keep it</AlertDialogCancel>
          <AlertDialogAction
            disabled={withdrawing}
            className={buttonVariants({ variant: 'destructive' })}
            onClick={(event) => {
              event.preventDefault();
              void withdraw();
            }}
          >
            {withdrawing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Withdraw
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
