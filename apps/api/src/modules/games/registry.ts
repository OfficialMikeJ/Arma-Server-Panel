import type { GameId } from '@asp/shared';
import type { GameAdapter } from './adapter.js';
import { arma3Adapter } from './adapters/arma3.js';
import { reforgerAdapter } from './adapters/reforger.js';
import { arma4Adapter } from './adapters/arma4.js';

const ADAPTERS: Record<GameId, GameAdapter> = {
  arma3: arma3Adapter,
  reforger: reforgerAdapter,
  arma4: arma4Adapter,
};

export function getAdapter(gameId: GameId): GameAdapter {
  const adapter = ADAPTERS[gameId];
  if (!adapter) throw new Error(`No adapter registered for game "${gameId}"`);
  return adapter;
}

export { ADAPTERS };
