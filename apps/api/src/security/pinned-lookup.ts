/**
 * DNS pinning for outbound connections.
 *
 * We resolve a hostname ourselves, validate every answer, then force the
 * connection to use the address we validated. That closes the DNS-rebinding
 * window between "check" and "connect".
 *
 * The subtlety this file exists for: undici invokes a custom `lookup` with
 * `all: true` and expects the callback to receive an **array** of
 * `{ address, family }`. Node's own `net.connect` calls it without `all` and
 * expects `(err, address, family)`. Getting this wrong produces
 * `Invalid IP address: undefined`, because the consumer reads
 * `addresses[0].address` off a plain string.
 *
 * Supporting both shapes is the whole point.
 */

export interface PinnedAddress {
  address: string;
  family: number;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  addressOrAddresses: string | PinnedAddress[],
  family?: number,
) => void;

/**
 * Builds a `lookup` implementation that always resolves to `pinned`,
 * in whichever calling convention the consumer used.
 */
export function createPinnedLookup(pinned: PinnedAddress) {
  const family = pinned.family === 6 ? 6 : 4;

  return function pinnedLookup(
    _hostname: string,
    options: { all?: boolean } | number | undefined,
    callback: LookupCallback,
  ): void {
    // `options` may be a plain family number in the legacy signature.
    const wantsAll = typeof options === 'object' && options !== null && options.all === true;

    if (wantsAll) {
      callback(null, [{ address: pinned.address, family }]);
      return;
    }
    callback(null, pinned.address, family);
  };
}
