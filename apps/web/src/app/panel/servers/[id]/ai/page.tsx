'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { ServerTabs } from '@/components/panel/ServerTabs';

/**
 * Per-server AI assistant.
 *
 * The approve button is the whole point of this screen: the model returns
 * proposals, and nothing happens to the server until a human presses it.
 */

interface Provider {
  id: string;
  label: string;
  model: string;
  enabled: boolean;
}

interface ProposedAction {
  index: number;
  kind: string;
  rationale: string;
  parameters: Record<string, unknown>;
  risk: 'low' | 'medium' | 'high';
}

interface Diagnosis {
  sessionId: string;
  summary: string;
  diagnosis: string;
  contextIncluded: string[];
  actions: ProposedAction[];
  droppedActions: number;
  notice: string;
}

const RISK_STYLE: Record<string, string> = {
  low: 'bg-power-start/15 text-power-start',
  medium: 'bg-power-restart/15 text-power-restart',
  high: 'bg-power-stop/15 text-power-stop',
};

export default function ServerAiPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState('');
  const [question, setQuestion] = useState('');
  const [include, setInclude] = useState({ console: true, config: true, mods: true, metrics: true });
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [resolved, setResolved] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ providers: Provider[] }>('/ai/providers')
      .then((result) => {
        const enabled = result.providers.filter((provider) => provider.enabled);
        setProviders(enabled);
        if (enabled[0]) setProviderId(enabled[0].id);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  async function diagnose(event: React.FormEvent) {
    event.preventDefault();
    setBusy('diagnose');
    setError(null);
    setDiagnosis(null);
    setResolved({});
    try {
      const result = await api.post<Diagnosis>(`/servers/${id}/ai/diagnose`, {
        providerId,
        question,
        include: { ...include, files: [] },
      });
      setDiagnosis(result);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The assistant could not be reached.');
    } finally {
      setBusy(null);
    }
  }

  async function decide(actionIndex: number, decision: 'approve' | 'reject') {
    if (!diagnosis) return;
    setBusy(`action-${actionIndex}`);
    setError(null);
    try {
      const response = await api.post<{ result?: string }>(
        `/ai/sessions/${diagnosis.sessionId}/${decision}`,
        { actionIndex },
      );
      setResolved((previous) => ({
        ...previous,
        [actionIndex]: decision === 'approve' ? (response.result ?? 'Applied.') : 'Rejected.',
      }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That action could not be applied.');
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <ServerTabs serverId={id} />
        <div className="card h-40 animate-pulse bg-ink-200" />
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div className="space-y-4">
        <ServerTabs serverId={id} />
        <div className="card text-center">
          <h1 className="text-lg font-bold">No AI provider connected</h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-800">
            Connect your own Claude, OpenAI or Codex key first. The panel holds no AI credential of
            its own.
          </p>
          <Link href="/panel/ai" className="btn-primary mt-6">
            Connect a provider
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ServerTabs serverId={id} />
      <h1 className="text-lg font-extrabold uppercase tracking-wide">AI assistant</h1>

      <form onSubmit={diagnose} className="card space-y-4">
        <div>
          <label className="label" htmlFor="provider">
            Provider
          </label>
          <select
            id="provider"
            className="input"
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
          >
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label} ({provider.model})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="question">
            What do you need help with?
          </label>
          <textarea
            id="question"
            className="input h-24"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="The server keeps crashing a few minutes after players join."
            maxLength={4000}
            required
          />
        </div>

        <div>
          <span className="label">Context to share</span>
          <div className="grid grid-cols-2 gap-2">
            {(['console', 'config', 'mods', 'metrics'] as const).map((key) => (
              <label
                key={key}
                className="flex cursor-pointer items-center gap-2 text-xs capitalize text-ink-900"
              >
                <input
                  type="checkbox"
                  checked={include[key]}
                  onChange={(event) => setInclude({ ...include, [key]: event.target.checked })}
                  className="accent-brand-500"
                />
                {key}
              </label>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-700">
            Passwords, API keys, webhook URLs and IP addresses are stripped before anything is sent.
          </p>
        </div>

        <button
          type="submit"
          className="btn-primary w-full"
          disabled={busy !== null || question.trim().length < 3}
        >
          {busy === 'diagnose' ? 'Thinking…' : 'Ask'}
        </button>
      </form>

      {diagnosis ? (
        <>
          <section className="card space-y-3">
            <h2 className="text-sm font-bold uppercase tracking-wide">Diagnosis</h2>
            <p className="text-sm leading-relaxed">{diagnosis.summary}</p>
            {diagnosis.diagnosis ? (
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink-800">
                {diagnosis.diagnosis}
              </p>
            ) : null}
            <p className="text-[11px] text-ink-700">
              Context shared: {diagnosis.contextIncluded.join(', ')}
            </p>
          </section>

          {diagnosis.actions.length > 0 ? (
            <section className="space-y-2">
              <h2 className="text-sm font-bold uppercase tracking-wide">
                Suggested actions
                <span className="ml-2 font-normal normal-case text-ink-700">
                  nothing has changed yet
                </span>
              </h2>

              {diagnosis.actions.map((action) => (
                <div key={action.index} className="card space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-sm font-bold text-brand-400">{action.kind}</code>
                    <span className={`badge ${RISK_STYLE[action.risk] ?? ''}`}>{action.risk} risk</span>
                  </div>

                  <p className="text-sm leading-relaxed text-ink-900">{action.rationale}</p>

                  {Object.keys(action.parameters ?? {}).length > 0 ? (
                    <pre className="overflow-x-auto rounded bg-ink-200 p-3 font-mono text-[11px] text-ink-950">
                      {JSON.stringify(action.parameters, null, 2)}
                    </pre>
                  ) : null}

                  {resolved[action.index] ? (
                    <p className="rounded-md bg-power-start/10 p-2.5 text-xs text-power-start">
                      {resolved[action.index]}
                    </p>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="btn-primary flex-1"
                        onClick={() => void decide(action.index, 'approve')}
                        disabled={busy !== null}
                      >
                        {busy === `action-${action.index}` ? 'Applying…' : 'Approve and apply'}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => void decide(action.index, 'reject')}
                        disabled={busy !== null}
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              ))}

              {diagnosis.droppedActions > 0 ? (
                <p className="text-[11px] text-ink-700">
                  {diagnosis.droppedActions} suggestion
                  {diagnosis.droppedActions === 1 ? ' was' : 's were'} discarded because you do not
                  have the permission they need.
                </p>
              ) : null}
            </section>
          ) : (
            <p className="card text-center text-sm text-ink-800">
              No actions were suggested.
            </p>
          )}

          <p className="text-center text-[11px] leading-relaxed text-ink-700">{diagnosis.notice}</p>
        </>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-md bg-power-stop/10 p-3 text-sm text-power-stop">
          {error}
        </p>
      ) : null}
    </div>
  );
}
