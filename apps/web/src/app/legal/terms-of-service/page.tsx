import Link from 'next/link';

/**
 * Placeholder terms for a self-hosted deployment.
 *
 * This panel is somebody's private infrastructure. Whoever runs it sets the
 * terms for their own users - shipping boilerplate that pretends to be a real
 * agreement would be worse than shipping an obvious placeholder.
 */
export default function TermsPage() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-16">
      <Link href="/register" className="text-xs text-brand-500 hover:underline">
        ← Back
      </Link>

      <h1 className="mt-6 text-2xl font-extrabold uppercase tracking-wide">Terms of Service</h1>

      <div className="card mt-6 border-power-restart/40">
        <p className="text-sm leading-relaxed text-power-restart">
          <strong>This is a placeholder.</strong> This panel is self-hosted, so its terms are set by
          whoever operates it — not by the software.
        </p>
      </div>

      <div className="mt-8 space-y-4 text-sm leading-relaxed text-ink-900">
        <p>
          If you run this panel and offer accounts to other people, replace this page with your own
          terms. It lives at{' '}
          <code className="font-mono text-xs text-brand-400">
            apps/web/src/app/legal/terms-of-service/page.tsx
          </code>
          .
        </p>

        <h2 className="section-title pt-4">In the meantime</h2>
        <ul className="space-y-2">
          <li>· Accounts on this panel are granted at the operator&apos;s discretion.</li>
          <li>
            · Game servers you create run on the operator&apos;s hardware and are subject to their
            resource limits and policies.
          </li>
          <li>
            · You are responsible for content you host, including mods, missions and anything
            players upload.
          </li>
          <li>
            · Arma, Arma Reforger and related assets belong to Bohemia Interactive. Using their
            modding tools commercially without permission is prohibited by their own terms.
          </li>
          <li>· The operator may suspend or remove servers that breach their policies.</li>
        </ul>

        <h2 className="section-title pt-4">Software licence</h2>
        <p>
          The panel software is provided as-is, without warranty of any kind. Its authors are not a
          party to any agreement between you and whoever operates this deployment.
        </p>
      </div>
    </main>
  );
}
