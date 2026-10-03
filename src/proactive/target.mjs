export const directMessageOwnerId = '291140236979732480';

export function acceptsListenerMessage({ guildId, channelId, directMessages = false }, message) {
  if (message.channel_id !== channelId) return false;
  if (directMessages) return !message.guild_id && message.author?.id === directMessageOwnerId;

  return message.guild_id === guildId;
}

export function assertOwnerDirectMessageChannel(channel) {
  if (channel.type !== 1 || channel.recipients?.length !== 1 || channel.recipients[0].id !== directMessageOwnerId) {
    throw new Error('The DM channel must belong only to the configured owner');
  }
}
