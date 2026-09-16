import { Badge } from '@/components/ui/badge';

type Variant = 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'outline';

const MAP: Record<string, { label: string; variant: Variant }> = {
  // Loans
  PENDING_DISBURSEMENT: { label: 'Awaiting disbursement', variant: 'warning' },
  ACTIVE: { label: 'Active', variant: 'success' },
  PAID_OFF: { label: 'Paid off', variant: 'default' },
  WRITTEN_OFF: { label: 'Written off', variant: 'destructive' },
  DISBURSEMENT_FAILED: { label: 'Disbursement failed', variant: 'outline' },
  // Applications
  SUBMITTED: { label: 'Under review', variant: 'warning' },
  APPROVED: { label: 'Approved', variant: 'success' },
  REJECTED: { label: 'Rejected', variant: 'destructive' },
  CANCELLED: { label: 'Cancelled', variant: 'outline' },
  DISBURSED: { label: 'Disbursed', variant: 'default' },
  FAILED: { label: 'Failed', variant: 'destructive' },
  // Disbursement attempts
  PENDING: { label: 'Pending', variant: 'warning' },
  SENT: { label: 'Sent', variant: 'secondary' },
  SUCCEEDED: { label: 'Succeeded', variant: 'success' },
  UNKNOWN: { label: 'Outcome unknown', variant: 'destructive' },
  // Payments & repayments
  COMPLETED: { label: 'Completed', variant: 'success' },
  EXPIRED: { label: 'Expired', variant: 'outline' },
  POSTED: { label: 'Posted', variant: 'success' },
  REVERSED: { label: 'Reversed', variant: 'destructive' },
  // Products & generic
  DRAFT: { label: 'Draft', variant: 'outline' },
  INACTIVE: { label: 'Inactive', variant: 'outline' },
  SUSPENDED: { label: 'Suspended', variant: 'warning' },
  BLOCKED: { label: 'Blocked', variant: 'destructive' },
  DISABLED: { label: 'Disabled', variant: 'outline' },
  NPL: { label: 'NPL', variant: 'destructive' },
  // Installments
  PAID: { label: 'Paid', variant: 'success' },
  OVERDUE: { label: 'Overdue', variant: 'destructive' },
  DUE_TODAY: { label: 'Due today', variant: 'warning' },
  UPCOMING: { label: 'Upcoming', variant: 'secondary' },
};

export function statusLabel(status: string) {
  return MAP[status]?.label ?? status;
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const entry = MAP[status] ?? { label: status, variant: 'secondary' as Variant };
  return (
    <Badge variant={entry.variant} className={className}>
      {entry.label}
    </Badge>
  );
}
