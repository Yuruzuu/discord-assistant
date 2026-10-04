import { createShardingStrategy } from './gateway-sdk.cjs';

export async function destroyGatewaySockets(strategy, destroy, options, onError) {
  const connecting = [...strategy.shards.values()].map((shard) => shard.connection).filter((socket) => socket?.readyState === 0);
  for (const socket of connecting) socket.on('error', onError);
  try { await destroy(options); }
  finally {
    for (const socket of connecting) if (socket.readyState === 0) socket.terminate();
  }
}

export function createGatewayStrategy(manager, onError) {
  const strategy = createShardingStrategy(manager);
  const destroy = strategy.destroy.bind(strategy);
  // @discordjs/ws 1.2.3 clears onerror without closing a pending handshake.
  strategy.destroy = (options) => destroyGatewaySockets(strategy, destroy, options, onError);
  return strategy;
}
