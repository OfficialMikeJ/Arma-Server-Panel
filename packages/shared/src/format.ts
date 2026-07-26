/** Presentation helpers shared by the API and the web app. */

const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    BINARY_UNITS.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  const unit = BINARY_UNITS[exponent] ?? 'B';
  return `${value.toFixed(exponent === 0 ? 0 : decimals)} ${unit}`;
}

export function formatMbps(mbps: number): string {
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(mbps % 1000 === 0 ? 0 : 1)} Gbps`;
  return `${mbps} Mbps`;
}

/** Renders MiB as GB/TB the way the resource sliders label themselves. */
export function formatMemory(mib: number): string {
  const gib = mib / 1024;
  if (gib >= 1024) return `${(gib / 1024).toFixed(1)} TB`;
  return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GB`;
}

export function formatStorage(gib: number): string {
  if (gib >= 1024) {
    const tib = gib / 1024;
    return `${Number.isInteger(tib) ? tib : tib.toFixed(2)} TB`;
  }
  return `${gib} GB`;
}

export function formatCpu(cores: number): string {
  return `${Number.isInteger(cores) ? cores : cores.toFixed(1)} ${cores === 1 ? 'core' : 'cores'}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function formatCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

/**
 * Strips ANSI escape sequences and control characters from console output
 * before it is sent to a browser. Terminal escapes rendered into the DOM are a
 * spoofing vector, so the panel renders plain text only.
 */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u2028\u2029]/g;

export function sanitizeConsoleText(input: string, maxLength = 8192): string {
  return input
    .replace(ANSI_PATTERN, '')
    .replace(CONTROL_PATTERN, '')
    .replace(/\r\n?/g, '\n')
    .slice(0, maxLength);
}
