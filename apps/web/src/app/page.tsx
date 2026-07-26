import { redirect } from 'next/navigation';

/**
 * The panel has no landing page of its own.
 *
 * Marketing lives on the project website (apps/site); this deployment is
 * somebody's private infrastructure and should not advertise anything. The
 * root just forwards to the sign-in screen.
 */
export default function RootPage() {
  redirect('/login');
}
