'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { formatBytes } from '@asp/shared';
import { api, ApiError, API_BASE } from '@/lib/api';
import { ServerTabs } from '@/components/panel/ServerTabs';

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  sizeBytes: number;
  modifiedAt: string;
  editable: boolean;
}

export default function FilesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<{ path: string; content: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (target: string) => {
      setLoading(true);
      try {
        const result = await api.get<{ entries: FileEntry[] }>(
          `/servers/${id}/files?path=${encodeURIComponent(target)}`,
        );
        setEntries(result.entries);
        setPath(target);
        setError(null);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'Could not list that folder.');
      } finally {
        setLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    void load('');
  }, [load]);

  async function open(entry: FileEntry) {
    if (entry.type === 'directory') {
      await load(entry.path);
      return;
    }
    if (!entry.editable) return;

    try {
      const result = await api.get<{ content: string }>(
        `/servers/${id}/files/content?path=${encodeURIComponent(entry.path)}`,
      );
      setEditing({ path: entry.path, content: result.content });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not open that file.');
    }
  }

  async function save() {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      await api.put(`/servers/${id}/files/content`, {
        path: editing.path,
        content: editing.content,
      });
      setEditing(null);
      await load(path);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save that file.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(entry: FileEntry) {
    if (!confirm(`Delete ${entry.name}? This cannot be undone.`)) return;
    try {
      await api.delete(`/servers/${id}/files`, { path: entry.path });
      await load(path);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not delete that.');
    }
  }

  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

  return (
    <div className="space-y-4">
      <ServerTabs serverId={id} />

      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-lg font-extrabold uppercase tracking-wide">Files</h1>
        <code className="truncate font-mono text-xs text-ink-700">/{path}</code>
      </div>

      {editing ? (
        <div className="card space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="truncate font-mono text-sm font-bold">{editing.path}</h2>
            <button type="button" className="btn-ghost h-8 px-3 text-[11px]" onClick={() => setEditing(null)}>
              Close
            </button>
          </div>
          <textarea
            className="input h-[420px] font-mono text-[12px] leading-relaxed"
            value={editing.content}
            onChange={(event) => setEditing({ ...editing, content: event.target.value })}
            spellCheck={false}
          />
          <button type="button" className="btn-primary w-full" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save file'}
          </button>
        </div>
      ) : (
        <div className="card p-0">
          {path ? (
            <button
              type="button"
              onClick={() => void load(parent)}
              className="flex w-full items-center gap-3 border-b border-ink-300 px-4 py-2.5 text-left text-sm hover:bg-ink-200"
            >
              <span className="text-ink-700">↰</span>
              <span className="font-semibold">..</span>
            </button>
          ) : null}

          {loading ? (
            <div className="h-40 animate-pulse bg-ink-200" />
          ) : entries.length === 0 ? (
            <p className="p-6 text-center text-sm text-ink-800">This folder is empty.</p>
          ) : (
            entries.map((entry) => (
              <div
                key={entry.path}
                className="flex items-center gap-3 border-b border-ink-300 px-4 py-2.5 last:border-0 hover:bg-ink-200"
              >
                <button
                  type="button"
                  onClick={() => void open(entry)}
                  disabled={entry.type === 'file' && !entry.editable}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
                >
                  <span className="shrink-0 text-ink-700" aria-hidden>
                    {entry.type === 'directory' ? '▸' : '·'}
                  </span>
                  <span
                    className={`truncate text-sm ${
                      entry.type === 'directory'
                        ? 'font-semibold'
                        : entry.editable
                          ? 'text-brand-400'
                          : 'text-ink-800'
                    }`}
                  >
                    {entry.name}
                  </span>
                </button>

                <span className="shrink-0 font-mono text-[11px] text-ink-700">
                  {entry.type === 'file' ? formatBytes(entry.sizeBytes) : ''}
                </span>

                {entry.type === 'file' ? (
                  <a
                    href={`${API_BASE}/api/v1/servers/${id}/files/download?path=${encodeURIComponent(entry.path)}`}
                    className="shrink-0 rounded px-2 py-1 text-[11px] font-semibold text-ink-800 hover:bg-ink-300 hover:text-white"
                  >
                    Download
                  </a>
                ) : null}

                <button
                  type="button"
                  onClick={() => void remove(entry)}
                  className="shrink-0 rounded px-2 py-1 text-[11px] font-semibold text-power-stop hover:bg-power-stop/10"
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>
      )}

      <p className="text-center text-xs text-ink-700">
        Only text config files can be edited here. Everything else is download-only.
      </p>

      {error ? (
        <p role="alert" className="rounded-md bg-power-stop/10 p-3 text-sm text-power-stop">
          {error}
        </p>
      ) : null}
    </div>
  );
}
