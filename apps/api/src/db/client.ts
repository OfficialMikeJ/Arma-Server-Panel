import { PrismaClient } from '@prisma/client';
import { loadConfig } from '../config/env.js';

const config = loadConfig();

/**
 * Query logging is deliberately limited to warnings and errors. Prisma's
 * `query` event includes bound parameters, which would leak session tokens and
 * secret envelopes into the log stream.
 */
export const prisma = new PrismaClient({
  log: config.isProduction
    ? [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }]
    : [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }],
  errorFormat: config.isProduction ? 'minimal' : 'pretty',
});

export type Db = typeof prisma;

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}
