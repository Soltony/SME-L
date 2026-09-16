import { redirect } from 'next/navigation';

/** The proxy sends `/` to the borrower home or the staff sign-in; this is only a fallback. */
export default function Root() {
  redirect('/admin/login');
}
