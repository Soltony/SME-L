import { headers } from 'next/headers';
import { getSettings } from '@/lib/settings';
import { isTestLoginEnabled } from '@/lib/dev-switches';
import { LogoMark } from '@/components/icons';
import { ConnectClient } from './connect-client';
import { TestLoginForm } from './test-login-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Connecting' };

/** Only same-site paths are accepted as a place to land after connecting. */
function safeNext(value: string | undefined) {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/home';
}

/**
 * Entry point the super app opens. The webview attaches the customer's
 * Authorization header (or, for builds that cannot, `?token=`); the client
 * exchanges it for a borrower session and lands on the requested page.
 */
export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; token?: string; test?: string }>;
}) {
  const [headerList, params, settings] = await Promise.all([headers(), searchParams, getSettings().catch(() => null)]);
  const brand = String(settings?.['platform.name'] || 'SME Lending');
  const authHeader = headerList.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader : params.token ? `Bearer ${params.token}` : null;
  const next = safeNext(params.next);
  const testEnabled = isTestLoginEnabled();

  if (token && params.test !== '1') {
    return <ConnectClient superAppToken={token} next={next} brand={brand} />;
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <LogoMark src={String(settings?.['platform.logo'] || '') || null} className="h-12 w-12" />
          <h1 className="mt-3 text-lg font-semibold">Open {brand} from the super app</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            We use your super-app account to identify you, find your bank accounts and collect repayments from your wallet.
          </p>
        </div>
        {testEnabled && <TestLoginForm next={next} />}
      </div>
    </main>
  );
}
