'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

/**
 * AI provider management.
 *
 * Bring-your-own-key. The panel holds no platform-wide AI credential; each
 * operator supplies their own and it is used only for their own servers.
 */

interface Provider {
  id: string;
  provider: string;
  label: string;
  model: string;
  baseUrl: string | null;
  enabled: boolean;
  apiKeyHint: string;
  createdAt: string;
}

interface Supported {
  id: string;
  label: string;
  defaultModel: string;
}

export default function AiProvidersPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [supported, setSupported] = useState<Supported[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [provider, setProvider] = useState('anthropic');
  const [label, setLabel] = useState('');
  const [model, setModel] = useState('claude-sonnet-5');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');

  async function load() {
    try {
      const result = await api.get<{ providers: Provider[]; supported: Supported[] }>(
        '/ai/providers',
      );
      setProviders(result.providers);
      setSupported(result.supported);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load providers.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/ai/providers', {
        provider,
        label: label || supported.find((s) => s.id === provider)?.label || provider,
        model,
        apiKey,
        baseUrl: provider === 'custom' ? baseUrl : null,
        autonomousActions: [],
      });
      setApiKey('');
      setLabel('');
      setShowForm(false);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not add the provider.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await api.delete(`/ai/providers/${id}`);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not remove the provider.');
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-extrabold uppercase tracking-wide">AI assistant</h1>
          <p className="text-sm text-ink-800">Connect your own Claude, OpenAI or Codex key.</p>
        </div>
        {!showForm ? (
          <button type="button" className="btn-primary" onClick={() => setShowForm(true)}>
            Add provider
          </button>
        ) : null}
      </div>

      <div className="rounded-lg border border-brand-500/30 bg-brand-500/5 p-4 text-xs leading-relaxed text-ink-900">
        <strong className="text-brand-400">It proposes, you approve.</strong> Credentials and IP
        addresses are stripped from anything sent to the provider. The assistant cannot change your
        server — it returns suggested actions, each needing a human with the matching permission to
        approve it. Every approval is written to the audit log.
      </div>

      {showForm ? (
        <form onSubmit={add} className="card space-y-4">
          <div>
            <label className="label" htmlFor="provider">
              Provider
            </label>
            <select
              id="provider"
              className="input"
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value);
                const match = supported.find((s) => s.id === event.target.value);
                if (match?.defaultModel) setModel(match.defaultModel);
              }}
            >
              {supported.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="model">
              Model
            </label>
            <input
              id="model"
              className="input"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              required
            />
          </div>

          {provider === 'custom' ? (
            <div>
              <label className="label" htmlFor="baseUrl">
                Base URL (OpenAI-compatible)
              </label>
              <input
                id="baseUrl"
                type="url"
                className="input"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://..."
                required
              />
            </div>
          ) : null}

          <div>
            <label className="label" htmlFor="apiKey">
              API key
            </label>
            <input
              id="apiKey"
              type="password"
              className="input font-mono"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
              required
            />
            <p className="mt-1.5 text-xs text-ink-700">
              Stored AES-256-GCM encrypted. Only the last four characters are ever shown again.
            </p>
          </div>

          <div className="flex gap-2">
            <button type="submit" className="btn-primary flex-1" disabled={busy || !apiKey}>
              {busy ? 'Saving…' : 'Add provider'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {loading ? (
        <div className="card h-24 animate-pulse bg-ink-200" />
      ) : providers.length === 0 && !showForm ? (
        <div className="card text-center text-sm text-ink-800">
          No providers connected yet.
        </div>
      ) : (
        <div className="space-y-2">
          {providers.map((item) => (
            <div key={item.id} className="card flex items-center justify-between gap-3 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-bold">{item.label}</span>
                  <span className="badge bg-ink-300 text-ink-900">{item.provider}</span>
                  {item.enabled ? (
                    <span className="badge bg-power-start/20 text-power-start">enabled</span>
                  ) : null}
                </div>
                <p className="mt-0.5 font-mono text-[11px] text-ink-700">
                  {item.model} · key {item.apiKeyHint}
                </p>
              </div>
              <button
                type="button"
                className="btn-ghost h-8 px-3 text-[11px] text-power-stop"
                onClick={() => void remove(item.id)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="text-center text-xs text-ink-700">
        Once a provider is connected, open a server and use its <strong>AI assistant</strong> tab to
        diagnose problems.
      </p>

      {error ? (
        <p role="alert" className="rounded-md bg-power-stop/10 p-3 text-sm text-power-stop">
          {error}
        </p>
      ) : null}
    </div>
  );
}
