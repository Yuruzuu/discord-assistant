export const directMessageOwnerId = '291140236979732480';

export function acceptsListenerMessage({ guildId, channelId, directMessages = false, allServers = false }, message) {
  if (message.author?.id !== directMessageOwnerId || message.author.bot || message.webhook_id) return false;
  if (allServers) return Boolean(message.guild_id && message.channel_id);
  if (message.channel_id !== channelId) return false;
  if (directMessages) return !message.guild_id;

  return message.guild_id === guildId;
}

export function mentionsBot(message, botUserId) {
  return (message.mentions || []).some((user) => user.id === botUserId) || new RegExp(`<@!?${botUserId}>`).test(message.content || '');
}

export async function addressesBot(message, botUserId, resolveReplyAuthor) {
  if (mentionsBot(message, botUserId) || message.referenced_message?.author?.id === botUserId || message.referenceAuthorId === botUserId) return true;
  if (!message.message_reference?.message_id) return false;
  try { return await resolveReplyAuthor(message.message_reference.message_id) === botUserId; }
  catch { return false; }
}

export function assertOwnerDirectMessageChannel(channel) {
  if (channel.type !== 1 || channel.recipients?.length !== 1 || channel.recipients[0].id !== directMessageOwnerId) {
    throw new Error('The DM channel must belong only to the configured owner');
  }
}
