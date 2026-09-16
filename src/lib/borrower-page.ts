import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import prisma from './prisma';
import { getBorrowerSession } from './session';

/**
 * The signed-in borrower for a server-rendered borrower page, or a redirect
 * through /connect. The proxy only checks the cookie is present; the signature,
 * the expiry and the borrower's status are checked here.
 */
export async function requireBorrowerPage() {
  const session = await getBorrowerSession();
  if (!session) {
    const path = (await headers()).get('x-pathname') || '/home';
    redirect(`/connect?next=${encodeURIComponent(path)}`);
  }
  const borrower = await prisma.borrower.findUnique({ where: { id: session.borrowerId } });
  if (!borrower || borrower.phoneNumber !== session.phone || borrower.status === 'BLOCKED') {
    redirect('/connect');
  }
  return { session, borrower };
}
