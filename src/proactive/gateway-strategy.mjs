import { createShardingStrategy } from './gateway-sdk.cjs';

const guarded = new WeakSet();

// @discordjs/ws 1.2.3 clears a shard connection's onerror during destroy without closing a pending handshake. Destroy runs on shutdown and
// internally on reconnects (hello timeouts, resumable closes), so every shard is guarded: a still-connecting socket keeps an error listener
// and is terminated afterwards, instead of its handshake timeout becoming an unhandled 'error' that kills the listener process.
export function guardShard(shard, onError) {
  if (guarded.has(shard)) return shard;
  guarded.add(shard);
  const destroy = shard.destroy.bind(shard);
  shard.destroy = async (options) => {
    const socket = shard.connection?.readyState === 0 ? shard.connection : null;
    socket?.on('error', onError);
    try { return await destroy(options); }
    finally { if (socket?.readyState === 0) socket.terminate(); }
  };
  return shard;
}

export function createGatewayStrategy(manager, onError) {
  const strategy = createShardingStrategy(manager);
  const spawn = strategy.spawn.bind(strategy);
  strategy.spawn = async (shardIds) => {
    await spawn(shardIds);
    for (const shard of strategy.shards.values()) guardShard(shard, onError);
  };
  return strategy;
}
