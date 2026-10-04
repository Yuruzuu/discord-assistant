const { SimpleShardingStrategy } = require('@discordjs/ws');

exports.createShardingStrategy = (manager) => new SimpleShardingStrategy(manager);
