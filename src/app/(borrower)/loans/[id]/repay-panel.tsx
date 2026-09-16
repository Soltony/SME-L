'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Loader2, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { money } from '@/components/money';
import { requestWalletApproval } from '@/lib/superapp-bridge';

type Stage = 'idle' | 'starting' | 'waiting' | 'done' | 'failed';

export function RepayPanel({
  loanId,
  currency,
  payoff,
  dueNow,
  isTest,
}: {
  loanId: string;
  currency: string;
  payoff: number;
  dueNow: number;
  isTest: boolean;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState((dueNow > 0 ? dueNow : payoff).toFixed(2));
  const [stage, setStage] = useState<Stage>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const polls = useRef(0);

  useEffect(() => {
    if (stage !== 'waiting' || !transactionId) return;
    const timer = setInterval(async () => {
      polls.current += 1;
      const response = await fetch(`/api/app/payments/${transactionId}`, { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (data.status === 'COMPLETED') {
        clearInterval(timer);
        setStage('done');
        setMessage(data.receiptNo ? `Receipt ${data.receiptNo}` : 'Payment received.');
        router.refresh();
      } else if (data.status === 'FAILED') {
        clearInterval(timer);
        setStage('failed');
        setMessage('The payment was not completed. No money was taken.');
      } else if (polls.current > 90) {
        clearInterval(timer);
        setStage('failed');
        setMessage('Still waiting for the wallet. If you approved it, the payment will show here shortly.');
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [stage, transactionId, router]);

  const pay = async () => {
    setStage('starting');
    setMessage(null);
    polls.current = 0;
    try {
      const response = await fetch(`/api/app/loans/${loanId}/repay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setStage('failed');
        setMessage(data?.error || 'The payment could not be started.');
        return;
      }
      if (data.status === 'COMPLETED') {
        setStage('done');
        setMessage(`Receipt ${data.receiptNo}`);
        router.refresh();
        return;
      }
      setTransactionId(data.transactionId);
      const handoff = requestWalletApproval(data.paymentToken);
      setStage('waiting');
      if (!handoff.delivered) {
        setMessage('Open this app from the super app to approve the payment in your wallet.');
      }
    } catch {
      setStage('failed');
      setMessage('Network error. Please try again.');
    }
  };

  const numeric = Number(amount);
  const valid = /^\d+(\.\d{1,2})?$/.test(amount) && numeric >= 1 && numeric <= payoff;

  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <h2 className="font-semibold">Make a payment</h2>
      {stage === 'done' ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-success">
          <CheckCircle2 className="h-5 w-5" /> Payment received. {message}
        </p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap gap-2">
            {dueNow > 0 && dueNow < payoff && (
              <Button type="button" size="sm" variant="outline" onClick={() => setAmount(dueNow.toFixed(2))}>
                Overdue {money(dueNow)}
              </Button>
            )}
            <Button type="button" size="sm" variant="outline" onClick={() => setAmount(payoff.toFixed(2))}>
              Pay off {money(payoff)}
            </Button>
          </div>
          <Input className="num mt-3 h-12 text-lg" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} aria-label="Amount" />
          {!valid && <p className="mt-1 text-xs text-destructive">Enter between 1.00 and {money(payoff, currency)}.</p>}
          {message && <p className={`mt-2 text-sm ${stage === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{message}</p>}
          <Button className="gold mt-3 h-12 w-full text-base font-bold" disabled={!valid || stage === 'starting' || stage === 'waiting'} onClick={pay}>
            {stage === 'starting' || stage === 'waiting' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wallet className="mr-2 h-4 w-4" />}
            {stage === 'waiting' ? 'Waiting for wallet approval…' : `Pay ${valid ? money(numeric, currency) : ''}`}
          </Button>
          {isTest && <p className="mt-2 text-center text-[11px] text-muted-foreground">Test session: the payment is applied without a wallet.</p>}
        </>
      )}
    </section>
  );
}
