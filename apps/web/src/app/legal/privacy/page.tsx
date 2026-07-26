import Link from 'next/link';

/**
 * Privacy notice for a self-hosted deployment.
 *
 * Unlike the terms, most of this is determined by the software rather than the
 * operator, so it can be stated accurately: this is what the panel actually
 * stores and how.
 */
export default function PrivacyPage() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-16">
      <Link href="/register" className="text-xs text-brand-500 hover:underline">
        ← Back
      </Link>

      <h1 className="mt-6 text-2xl font-extrabold uppercase tracking-wide">Privacy</h1>
      <p className="mt-2 text-sm text-ink-800">
        This panel is self-hosted. Everything below stays on the operator&apos;s hardware.
      </p>

      <div className="mt-8 space-y-6 text-sm leading-relaxed text-ink-900">
        <section>
          <h2 className="section-title mb-2">What your account holds</h2>
          <ul className="space-y-1.5">
            <li>· Your username.</li>
            <li>
              · Your two-factor secret, encrypted with AES-256-GCM. Nobody — including the operator —
              can read it out of the database.
            </li>
            <li>· Recovery codes, stored only as Argon2id hashes.</li>
            <li>
              · Your Discord ID and display name, if you chose to link Discord. No email, no guild
              list.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="section-title mb-2">What is never stored in the clear</h2>
          <p>
            Your IP address and browser user-agent are kept only as salted HMAC hashes, so a database
            leak cannot be reversed into a list of addresses. Server RCON passwords, webhook URLs and
            any AI provider key you add are encrypted at rest.
          </p>
        </section>

        <section>
          <h2 className="section-title mb-2">Activity records</h2>
          <p>
            Privileged actions — signing in, power actions, console commands, file writes, permission
            changes — are written to an append-only audit log. This is a security feature: it is how
            an operator finds out what happened after something goes wrong. You can read your own
            entries under Account → Activity.
          </p>
        </section>

        <section>
          <h2 className="section-title mb-2">Server data</h2>
          <p>
            Console output is retained for 14 days and performance metrics for 30 days, then deleted
            automatically. Game server files live on the operator&apos;s disk for as long as the
            server exists.
          </p>
        </section>

        <section>
          <h2 className="section-title mb-2">Third parties</h2>
          <p>
            The panel talks to no third party on your behalf unless something is configured to. If
            an AI provider is connected, requests go directly from this panel to that provider using
            the operator&apos;s own key, with credentials and IP addresses stripped first. Discord is
            contacted only if you link an account. Anonymous usage counts are sent to the project
            website only if the operator opted in, and contain no personal data.
          </p>
        </section>

        <section>
          <h2 className="section-title mb-2">Deleting your account</h2>
          <p>
            Account → Delete removes your two-factor secret and Discord link immediately. Your
            username stays reserved and your audit entries are retained, so the record of what was
            done on the platform stays intact.
          </p>
        </section>
      </div>
    </main>
  );
}
