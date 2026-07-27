'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  configGroups,
  getConfigValue,
  setConfigValue,
  unmappedConfigKeys,
  type ConfigField,
  type NumberField,
} from '@asp/shared';

/**
 * Renders a game's configuration as ordinary form controls.
 *
 * The fields come from CONFIG_FIELDS in the shared package, which is checked
 * against each adapter's schema by a test - so this component never needs to
 * know which game it is showing.
 *
 * It edits a plain object and hands it back unchanged in shape. Anything the
 * form does not cover is carried through untouched, so switching between this
 * and the JSON editor can never quietly drop a setting.
 */

interface Props {
  fields: readonly ConfigField[];
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** Field paths the server rejected, so the offending control can be marked. */
  invalidPaths?: readonly string[];
  disabled?: boolean;
}

export function ConfigForm({ fields, config, onChange, invalidPaths = [], disabled }: Props) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const groups = useMemo(() => configGroups(fields), [fields]);
  const unmapped = useMemo(() => unmappedConfigKeys(config, fields), [config, fields]);

  const hasAdvanced = fields.some((field) => field.advanced);
  const visible = (field: ConfigField) => showAdvanced || !field.advanced;

  const set = (key: string, value: unknown) => onChange(setConfigValue(config, key, value));

  return (
    <div className="space-y-5">
      {hasAdvanced ? (
        <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-800">
          <input
            type="checkbox"
            checked={showAdvanced}
            onChange={(event) => setShowAdvanced(event.target.checked)}
            className="accent-brand-500"
          />
          Show advanced settings
        </label>
      ) : null}

      {groups.map((group) => {
        const groupFields = fields.filter((field) => field.group === group && visible(field));
        if (groupFields.length === 0) return null;

        return (
          <fieldset key={group} className="space-y-3" disabled={disabled}>
            <legend className="mb-2 text-xs font-bold uppercase tracking-wide text-brand-400">
              {group}
            </legend>

            {groupFields.map((field) => (
              <Field
                key={field.key}
                field={field}
                value={getConfigValue(config, field.key)}
                // Prefix match: zod reports a bad list entry as "admins.0", and
                // the control that owns it is the one named "admins".
                invalid={invalidPaths.some(
                  (path) => path === field.key || path.startsWith(`${field.key}.`),
                )}
                onChange={(value) => set(field.key, value)}
              />
            ))}
          </fieldset>
        );
      })}

      {unmapped.length > 0 ? (
        <p className="rounded-md bg-ink-200/50 p-3 text-xs leading-relaxed text-ink-700">
          Not shown here, and only editable as JSON:{' '}
          <span className="font-mono text-ink-900">{unmapped.join(', ')}</span>. Saving this form
          leaves them exactly as they are.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Field({
  field,
  value,
  invalid,
  onChange,
}: {
  field: ConfigField;
  value: unknown;
  invalid: boolean;
  onChange: (value: unknown) => void;
}) {
  const id = `cfg-${field.key.replace(/\./g, '-')}`;
  const describedBy = field.help ? `${id}-help` : undefined;
  const ring = invalid ? 'ring-1 ring-power-stop' : '';

  if (field.kind === 'toggle') {
    // Compared against trueValue rather than coerced: Arma 3 stores 1/0 and
    // Reforger true/false, and `Boolean(0)` would be right for one and wrong
    // for a config that had somehow stored "0" as a string.
    const checked = value === field.trueValue;
    return (
      <div>
        <label className="flex cursor-pointer items-start gap-2 text-sm text-ink-900" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={checked}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.checked ? field.trueValue : field.falseValue)}
            className="mt-0.5 accent-brand-500"
          />
          <span>{field.label}</span>
        </label>
        <Help id={describedBy} text={field.help} indented />
      </div>
    );
  }

  return (
    <div>
      <label className="label" htmlFor={id}>
        {field.label}
      </label>

      {field.kind === 'select' ? (
        <select
          id={id}
          className={`input ${ring}`}
          // Values are stringified for the DOM and mapped back through the
          // option list on change, so a numeric 2 never becomes the string "2".
          value={String(value ?? '')}
          aria-describedby={describedBy}
          onChange={(event) => {
            const option = field.options.find((o) => String(o.value) === event.target.value);
            if (option) onChange(option.value);
          }}
        >
          {/* A value set by hand in the JSON editor may not be one of the
              offered options. Without this the browser would silently display
              the first option instead, so the form would disagree with what is
              actually stored. */}
          {value !== undefined && !field.options.some((o) => o.value === value) ? (
            <option value={String(value)}>{String(value)} (set manually)</option>
          ) : null}
          {field.options.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.kind === 'number' ? (
        <NumberInput id={id} field={field} value={value} describedBy={describedBy} ring={ring} onChange={onChange} />
      ) : field.kind === 'stringList' ? (
        <StringList
          id={id}
          values={Array.isArray(value) ? (value as unknown[]).map(String) : []}
          placeholder={field.placeholder}
          maxItems={field.maxItems}
          describedBy={describedBy}
          onChange={onChange}
        />
      ) : (
        <input
          id={id}
          type={field.kind === 'password' ? 'password' : 'text'}
          className={`input ${ring}`}
          value={typeof value === 'string' ? value : ''}
          maxLength={field.maxLength}
          placeholder={field.placeholder}
          autoComplete={field.kind === 'password' ? 'new-password' : 'off'}
          spellCheck={false}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
      )}

      <Help id={describedBy} text={field.help} />
    </div>
  );
}

/**
 * A number box that lets you actually type.
 *
 * A plain controlled input bound straight to the parsed number cannot be
 * cleared - emptying it re-renders the old value under the cursor - and eats
 * the decimal point, because `Number("0.")` is 0 and the input snaps back to
 * "0" before you can type the digit after it. So the text being typed is held
 * locally and only pushed up once it parses, while an external change (loading
 * a server, saving, switching from JSON) still wins.
 */
function NumberInput({
  id,
  field,
  value,
  describedBy,
  ring,
  onChange,
}: {
  id: string;
  field: NumberField;
  value: unknown;
  describedBy?: string;
  ring: string;
  onChange: (value: unknown) => void;
}) {
  const external = value === null || value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(external);

  // Adopt the incoming value whenever it stops matching what is being typed.
  // Number(draft) rather than a string compare, so "2500" and 2500 agree and
  // the cursor is not reset on every keystroke.
  useEffect(() => {
    if (draft !== '' && Number(draft) === Number(external) && external !== '') return;
    if (draft === '' && external === '') return;
    setDraft(external);
    // Only re-syncs on an external change; `draft` is deliberately not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [external]);

  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="number"
        className={`input ${ring}`}
        value={draft}
        min={field.min}
        max={field.max}
        step={field.step ?? 1}
        aria-describedby={describedBy}
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);

          if (raw === '') {
            // Empty means "unset" for a nullable field. For the rest it means
            // mid-edit, so the stored value is left alone until something
            // parseable is typed.
            if (field.nullable) onChange(null);
            return;
          }

          const parsed = Number(raw);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        onBlur={() => {
          // Leaving the box empty on a non-nullable field would save the old
          // value while showing nothing, so put the real one back.
          if (draft === '' && !field.nullable) setDraft(external);
        }}
      />
      {field.unit ? <span className="text-xs text-ink-700">{field.unit}</span> : null}
    </div>
  );
}

function Help({ id, text, indented }: { id?: string; text?: string; indented?: boolean }) {
  if (!text) return null;
  return (
    <p id={id} className={`mt-1 text-xs leading-relaxed text-ink-700 ${indented ? 'ml-6' : ''}`}>
      {text}
    </p>
  );
}

/* ------------------------------------------------------------------ */

/** A list of free-text entries, one row each. */
function StringList({
  id,
  values,
  placeholder,
  maxItems,
  describedBy,
  onChange,
}: {
  id: string;
  values: string[];
  placeholder?: string;
  maxItems?: number;
  describedBy?: string;
  onChange: (values: string[]) => void;
}) {
  const atLimit = maxItems !== undefined && values.length >= maxItems;

  return (
    <div className="space-y-1.5" aria-describedby={describedBy}>
      {values.map((entry, index) => (
        // Index as key is correct here: the rows have no identity of their own,
        // and the list is reordered only by add/remove at a known position.
        <div key={index} className="flex gap-1.5">
          <input
            id={index === 0 ? id : undefined}
            className="input flex-1"
            value={entry}
            placeholder={placeholder}
            spellCheck={false}
            onChange={(event) => {
              const next = [...values];
              next[index] = event.target.value;
              onChange(next);
            }}
          />
          <button
            type="button"
            className="btn-secondary px-3"
            aria-label={`Remove entry ${index + 1}`}
            onClick={() => onChange(values.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </div>
      ))}

      <button
        type="button"
        // Carries the label's id when there are no rows, so the label still
        // points at something focusable.
        id={values.length === 0 ? id : undefined}
        className="btn-secondary w-full text-xs"
        disabled={atLimit}
        onClick={() => onChange([...values, ''])}
      >
        {atLimit ? `Limit of ${maxItems} reached` : '+ Add'}
      </button>
    </div>
  );
}
