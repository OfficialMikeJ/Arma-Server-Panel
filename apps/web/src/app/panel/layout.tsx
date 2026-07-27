'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { PANEL_NAME } from '@asp/shared';
import { api, ApiError } from '@/lib/api';

interface SessionResponse {
  authenticated: boolean;
  account?: {
    id: string;
    username: string;
    type: string;
    isPlatformOwner: boolean;
    panelPermissions?: string[];
  };
  mustChangePassword?: boolean;
  totpVerified?: boolean;
}

const NAV = [
  { href: '/panel', label: 'Servers' },
  { href: '/panel/presets', label: 'Mod presets' },
  { href: '/panel/api-keys', label: 'API keys' },
  { href: '/panel/ai', label: 'AI assistant' },
  { href: '/panel/account', label: 'Account' },
];

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  const [session, setSession] = useState<SessionResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    api
      .get<SessionResponse>('/auth/session')
      .then((result) => {
        if (cancelled) return;
        if (!result.authenticated) {
          router.replace('/login');
          return;
        }

        // Both of these are hard gates - the API refuses every other route
        // until they are satisfied, so route the user there rather than
        // letting them hit a wall of 403s.
        //
        // The security pages are exempt, or the gate would redirect them to
        // themselves and they would never render.
        const onSecurityPage = pathname.startsWith('/panel/security');

        if (!onSecurityPage && result.mustChangePassword) {
          router.replace('/panel/security/change-password');
          return;
        }
        if (!onSecurityPage && result.totpVerified === false) {
          router.replace('/panel/security/setup-2fa');
          return;
        }
        setSession(result);
      })
      .catch((caught) => {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.status === 401) router.replace('/login');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [router, pathname]);

  async function signOut() {
    await api.post('/auth/logout').catch(() => undefined);
    router.replace('/login');
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink-0">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink-500 border-t-brand-500" />
        <span className="sr-only">Loading</span>
      </div>
    );
  }

  if (!session?.authenticated) return null;

  const isSecurityRoute = pathname.startsWith('/panel/security');

  return (
    <div className="min-h-screen bg-ink-0">
      <header className="sticky top-0 z-40 border-b border-ink-300 bg-ink-50/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <Link href="/panel" className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded bg-brand-500 text-sm font-black text-white">
                A
              </span>
              <span className="hidden text-sm font-bold sm:block">{PANEL_NAME}</span>
            </Link>

            {!isSecurityRoute ? (
              <nav className="hidden items-center gap-1 md:flex" aria-label="Panel sections">
                {NAV.map((item) => {
                  const active =
                    item.href === '/panel' ? pathname === '/panel' : pathname.startsWith(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={`rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition-colors ${
                        active ? 'bg-brand-500/15 text-brand-400' : 'text-ink-800 hover:text-white'
                      }`}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
            ) : null}
          </div>

          <div className="flex items-center gap-3">
            {/* Shown whenever the account holds any panel permission, so a
                sub-admin can reach the sections they were granted. */}
            {(session.account?.panelPermissions?.length ?? 0) > 0 ? (
              <Link
                href="/panel/admin"
                className="badge border border-brand-500/40 bg-brand-500/10 text-brand-400"
              >
                Admin
              </Link>
            ) : null}
            <span className="hidden text-xs text-ink-800 sm:block">{session.account?.username}</span>
            <button type="button" onClick={() => void signOut()} className="btn-ghost h-8 px-3 text-[11px]">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-[1400px] px-4 py-6">
        {children}
      </main>
    </div>
  );
}
