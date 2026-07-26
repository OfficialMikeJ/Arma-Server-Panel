/**
 * Mandatory host capability gate.
 *
 * The spec fixes a floor of 8 GB RAM, 4 cores/threads, 120 GB storage and
 * 50 Mbps in each direction. These are enforced, not advisory:
 *   * setup cannot complete on a host that fails,
 *   * registration is refused while the host is failing,
 *   * a node cannot be brought ONLINE while it fails.
 *
 * The values live in @asp/shared/constants and are deliberately not
 * configurable from the environment or the database.
 */

import os from 'node:os';
import { statfs } from 'node:fs/promises';
import {
  HOST_REQUIREMENTS,
  formatBytes,
  formatMbps,
  type HostRequirementCheck,
  type HostRequirementReport,
} from '@asp/shared';
import { loadConfig } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { getPlatformSettings, updatePlatformSettings } from '../platform/platform-settings.js';
import { measureThroughput, type ThroughputResult } from './speedtest.js';

export interface HostCapabilities {
  memoryBytes: number;
  cpuThreads: number;
  cpuModel: string;
  storageTotalBytes: number;
  storageFreeBytes: number;
  storagePath: string;
  platform: string;
  arch: string;
  kernel: string;
}

export async function detectHostCapabilities(): Promise<HostCapabilities> {
  const config = loadConfig();
  const cpus = os.cpus();

  let storageTotalBytes = 0;
  let storageFreeBytes = 0;
  const storagePath = config.DATA_ROOT;

  try {
    const stats = await statfs(storagePath);
    storageTotalBytes = Number(stats.blocks) * Number(stats.bsize);
    storageFreeBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    // The data root may not exist yet on a fresh install; fall back to the
    // filesystem the process is running from so the check still means something.
    try {
      const stats = await statfs(process.cwd());
      storageTotalBytes = Number(stats.blocks) * Number(stats.bsize);
      storageFreeBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch (error) {
      logger.warn({ err: error }, 'Could not determine storage capacity');
    }
  }

  return {
    memoryBytes: os.totalmem(),
    cpuThreads: cpus.length,
    cpuModel: cpus[0]?.model?.trim() ?? 'unknown',
    storageTotalBytes,
    storageFreeBytes,
    storagePath,
    platform: os.platform(),
    arch: os.arch(),
    kernel: os.release(),
  };
}

export interface RequirementsOptions {
  /** Run a live throughput test. Skipped when a recent result is still valid. */
  runSpeedTest?: boolean;
  /** Force a fresh test even if a cached one is within its TTL. */
  forceSpeedTest?: boolean;
}

export async function evaluateHostRequirements(
  options: RequirementsOptions = {},
): Promise<HostRequirementReport & { capabilities: HostCapabilities; throughput: ThroughputResult | null }> {
  const config = loadConfig();
  const capabilities = await detectHostCapabilities();
  const settings = await getPlatformSettings();

  const checks: HostRequirementCheck[] = [
    {
      key: 'memory',
      label: 'System memory',
      required: formatBytes(HOST_REQUIREMENTS.minMemoryBytes),
      detected: formatBytes(capabilities.memoryBytes),
      pass: capabilities.memoryBytes >= HOST_REQUIREMENTS.minMemoryBytes,
    },
    {
      key: 'cpu',
      label: 'CPU cores / threads',
      required: `${HOST_REQUIREMENTS.minCpuThreads}`,
      detected: `${capabilities.cpuThreads}`,
      pass: capabilities.cpuThreads >= HOST_REQUIREMENTS.minCpuThreads,
    },
    {
      key: 'storage',
      label: 'Storage',
      required: formatBytes(HOST_REQUIREMENTS.minStorageBytes),
      detected: formatBytes(capabilities.storageTotalBytes),
      pass: capabilities.storageTotalBytes >= HOST_REQUIREMENTS.minStorageBytes,
    },
  ];

  /* ---- Network throughput ---- */

  let throughput: ThroughputResult | null = null;
  let networkStale = false;

  const cachedAt = settings.lastSpeedTestAt?.getTime() ?? 0;
  const cacheValid = Date.now() - cachedAt < HOST_REQUIREMENTS.speedTestTtlMs;

  const manualDown = config.SPEEDTEST_MANUAL_DOWNLOAD_MBPS;
  const manualUp = config.SPEEDTEST_MANUAL_UPLOAD_MBPS;

  if (manualDown !== undefined && manualUp !== undefined) {
    // Air-gapped installs: the operator attests to capacity. Recorded as such
    // in the report so it is visible that it was not measured.
    throughput = { downloadMbps: manualDown, uploadMbps: manualUp, measuredAt: new Date(), method: 'declared' };
  } else if (options.forceSpeedTest || options.runSpeedTest || !cacheValid) {
    try {
      throughput = await measureThroughput();
      await updatePlatformSettings({ lastSpeedTestAt: throughput.measuredAt });
    } catch (error) {
      logger.warn({ err: error }, 'Throughput measurement failed');
      throughput = null;
    }
  } else {
    const prior = settings.requirementsReport as { throughput?: ThroughputResult } | null;
    if (prior?.throughput) {
      throughput = {
        ...prior.throughput,
        measuredAt: new Date(prior.throughput.measuredAt),
      };
    }
    networkStale = throughput === null;
  }

  checks.push(
    {
      key: 'download',
      label: 'Download throughput',
      required: formatMbps(HOST_REQUIREMENTS.minDownloadMbps),
      detected: throughput ? formatMbps(Math.round(throughput.downloadMbps)) : 'not measured',
      pass: throughput !== null && throughput.downloadMbps >= HOST_REQUIREMENTS.minDownloadMbps,
    },
    {
      key: 'upload',
      label: 'Upload throughput',
      required: formatMbps(HOST_REQUIREMENTS.minUploadMbps),
      detected: throughput ? formatMbps(Math.round(throughput.uploadMbps)) : 'not measured',
      pass: throughput !== null && throughput.uploadMbps >= HOST_REQUIREMENTS.minUploadMbps,
    },
  );

  const pass = checks.every((c) => c.pass);

  return {
    pass,
    checkedAt: new Date().toISOString(),
    checks,
    networkStale,
    capabilities,
    throughput,
  };
}

/** Evaluates and persists the result, which gates setup and registration. */
export async function refreshHostRequirements(
  options: RequirementsOptions = {},
): Promise<HostRequirementReport> {
  const report = await evaluateHostRequirements(options);

  await updatePlatformSettings({
    requirementsPass: report.pass,
    requirementsCheckedAt: new Date(),
    requirementsReport: {
      checks: report.checks,
      capabilities: report.capabilities,
      throughput: report.throughput,
      checkedAt: report.checkedAt,
    } as never,
  });

  if (!report.pass) {
    const failing = report.checks.filter((c) => !c.pass).map((c) => c.key);
    logger.warn({ failing }, 'Host does not meet the minimum requirements');
  }

  return {
    pass: report.pass,
    checkedAt: report.checkedAt,
    checks: report.checks,
    networkStale: report.networkStale,
  };
}

/** Throws unless the host currently satisfies every requirement. */
export async function assertHostRequirementsMet(): Promise<void> {
  const settings = await getPlatformSettings();
  const stale =
    settings.requirementsCheckedAt === null ||
    Date.now() - settings.requirementsCheckedAt.getTime() > HOST_REQUIREMENTS.speedTestTtlMs;

  const report = stale ? await refreshHostRequirements() : null;
  const pass = report ? report.pass : settings.requirementsPass;

  if (!pass) {
    const { AppError } = await import('../../lib/errors.js');
    throw new AppError(
      412,
      'host_requirements_not_met',
      'This host does not meet the minimum requirements (8 GB RAM, 4 cores, 120 GB storage, 50 Mbps up/down).',
    );
  }
}
