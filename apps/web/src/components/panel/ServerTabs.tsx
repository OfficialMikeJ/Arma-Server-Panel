'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Shared sub-navigation for the per-server screens. */
export function ServerTabs({ serverId }: { serverId: string }) {
  const pathname = usePathname();
  const base = `/panel/servers/${serverId}`;

  const tabs = [
    { href: base, label: 'Overview' },
    { href: `${base}/mods`, label: 'Mods' },
    { href: `${base}/files`, label: 'Files' },
    { href: `${base}/settings`, label: 'Settings' },
    { href: `${base}/network`, label: 'Network' },
    { href: `${base}/ai`, label: 'AI assistant' },
  ];

  return (
    <nav className="flex flex-wrap gap-1 border-b border-ink-300 pb-2" aria-label="Server sections">
      {tabs.map((tab) => {
        const active = tab.href === base ? pathname === base : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition-colors ${
              active ? 'bg-brand-500/15 text-brand-400' : 'text-ink-800 hover:text-white'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
