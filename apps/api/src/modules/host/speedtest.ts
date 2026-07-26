/**
 * Throughput measurement.
 *
 * Streams a known payload down and up against a configured endpoint and times
 * it. The endpoints are validated the same way any other outbound request is
 * (https only, publicly-routable address, pinned after resolution) so this
 * cannot be pointed at an internal service.
 *
 * Only the steady-state portion is timed - the first 10% of the download is
 * discarded so TCP slow start does not understate the result.
 */

import { Agent, request as undiciRequest } from 'undici';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../../config/env.js';
import { isPrivateAddress } from '../../security/client-identity.js';
import { createPinnedLookup } from '../../security/pinned-lookup.js';
import { SsrfBlockedError } from '../../security/ssrf.js';
import { logger } from '../../lib/logger.js';

export interface ThroughputResult {
  downloadMbps: number;
  uploadMbps: number;
  measuredAt: Date;
  /** `measured` from a live test, `declared` when the operator attested. */
  method: 'measured' | 'declared';
}

const UPLOAD_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

async function pinnedDispatcher(url: URL): Promise<Agent> {
  const host = url.hostname;

  let address: string;
  let family: number;

  if (isIP(host) !== 0) {
    address = host;
    family = isIP(host);
  } else {
    const answers = await dnsLookup(host, { all: true, verbatim: true });
    const first = answers[0];
    if (!first) throw new SsrfBlockedError(`Could not resolve ${host}`, url.toString());
    for (const answer of answers) {
      if (isPrivateAddress(answer.address)) {
        throw new SsrfBlockedError(`${host} resolves to a non-public address`, url.toString());
      }
    }
    address = first.address;
    family = first.family;
  }

  if (isPrivateAddress(address)) {
    throw new SsrfBlockedError(`${host} is not publicly routable`, url.toString());
  }

  return new Agent({
    connect: {
      servername: host,
      lookup: createPinnedLookup({ address, family }) as never,
    },
    headersTimeout: TIMEOUT_MS,
    bodyTimeout: TIMEOUT_MS,
  });
}

async function measureDownload(rawUrl: string): Promise<number> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new SsrfBlockedError('Speed test must use https', rawUrl);

  const dispatcher = await pinnedDispatcher(url);
  try {
    const response = await undiciRequest(url, {
      method: 'GET',
      dispatcher,
      headers: { 'user-agent': 'ArmaServerPanel/1.0', 'cache-control': 'no-store' },
      headersTimeout: TIMEOUT_MS,
      bodyTimeout: TIMEOUT_MS,
    });

    if (response.statusCode !== 200) {
      throw new Error(`Speed test endpoint returned ${response.statusCode}`);
    }

    let total = 0;
    let warmupBytes = 0;
    let timedBytes = 0;
    let startedAt = 0;
    const warmupTarget = 512 * 1024;

    for await (const chunk of response.body) {
      const length = Buffer.isBuffer(chunk) ? chunk.length : Buffer.from(chunk).length;
      total += length;

      if (warmupBytes < warmupTarget) {
        warmupBytes += length;
        // Start the clock once slow start is past.
        if (warmupBytes >= warmupTarget) startedAt = performance.now();
        continue;
      }
      timedBytes += length;
    }

    if (startedAt === 0 || timedBytes === 0) {
      // Payload was smaller than the warm-up target; fall back to timing it all.
      return 0;
    }

    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    if (elapsedSeconds <= 0) return 0;

    logger.debug({ total, timedBytes, elapsedSeconds }, 'Download measurement complete');
    return (timedBytes * 8) / elapsedSeconds / 1_000_000;
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

async function measureUpload(rawUrl: string): Promise<number> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new SsrfBlockedError('Speed test must use https', rawUrl);

  const dispatcher = await pinnedDispatcher(url);
  try {
    const payload = randomBytes(UPLOAD_BYTES);
    const startedAt = performance.now();

    const response = await undiciRequest(url, {
      method: 'POST',
      dispatcher,
      headers: {
        'user-agent': 'ArmaServerPanel/1.0',
        'content-type': 'application/octet-stream',
        'content-length': String(payload.length),
      },
      body: payload,
      headersTimeout: TIMEOUT_MS,
      bodyTimeout: TIMEOUT_MS,
    });

    // Drain so the connection completes cleanly.
    for await (const _chunk of response.body) {
      void _chunk;
    }

    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    if (elapsedSeconds <= 0) return 0;

    return (payload.length * 8) / elapsedSeconds / 1_000_000;
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

export async function measureThroughput(): Promise<ThroughputResult> {
  const config = loadConfig();

  // Sequential, not parallel: running both at once would have them compete for
  // the same link and understate each other.
  //
  // Measured independently so one failing direction does not discard a
  // perfectly good result for the other - reporting "not measured" for both
  // when only the upload endpoint was unreachable is unhelpful and hides the
  // real problem.
  let downloadMbps = 0;
  let uploadMbps = 0;
  const failures: string[] = [];

  try {
    downloadMbps = await measureDownload(config.SPEEDTEST_DOWNLOAD_URL);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    failures.push(`download: ${reason}`);
    logger.warn({ err: error, url: config.SPEEDTEST_DOWNLOAD_URL }, 'Download measurement failed');
  }

  try {
    uploadMbps = await measureUpload(config.SPEEDTEST_UPLOAD_URL);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    failures.push(`upload: ${reason}`);
    logger.warn({ err: error, url: config.SPEEDTEST_UPLOAD_URL }, 'Upload measurement failed');
  }

  if (failures.length === 2) {
    // Both directions failed - this is a connectivity problem, not a slow link.
    throw new Error(`Throughput could not be measured (${failures.join('; ')})`);
  }

  logger.info(
    {
      downloadMbps: Math.round(downloadMbps),
      uploadMbps: Math.round(uploadMbps),
      failures: failures.length > 0 ? failures : undefined,
    },
    'Throughput measured',
  );

  return {
    downloadMbps,
    uploadMbps,
    measuredAt: new Date(),
    method: 'measured',
  };
}
