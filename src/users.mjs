import { assertSnowflake, snowflakeTimestamp } from './discord-url.mjs';

function avatarUrl(userId, avatar, guildId) {
  if (!avatar) return null;
  const extension = avatar.startsWith('a_') ? 'gif' : 'png';
  const path = guildId ? `guilds/${guildId}/users/${userId}/avatars` : 'avatars';

  return `https://cdn.discordapp.com/${path}/${guildId ? avatar : `${userId}/${avatar}`}.${extension}?size=256`;
}

export async function getUserInfo(service, { userId, guildId, accountId }) {
  assertSnowflake(userId, 'userId');
  if (guildId) assertSnowflake(guildId, 'guildId');
  const account = accountId ? service.accountById(accountId) : guildId ? await service.accountForGuild(guildId) : service.accounts[0];
  const [user, member, roles] = await Promise.all([
    account.client.getUser(userId),
    guildId ? account.client.getGuildMember(guildId, userId) : null,
    guildId ? account.client.listGuildRoles(guildId) : [],
  ]);

  return {
    accountId: account.id,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.global_name || user.username,
      bot: Boolean(user.bot),
      avatarUrl: avatarUrl(user.id, user.avatar),
      createdAt: new Date(snowflakeTimestamp(user.id)).toISOString(),
      publicFlags: user.public_flags ?? null,
    },
    member: member ? {
      guildId,
      nickname: member.nick || null,
      joinedAt: member.joined_at || null,
      serverAvatarUrl: avatarUrl(user.id, member.avatar, guildId),
      roles: (member.roles || []).map((id) => {
        const role = roles.find((role) => role.id === id);
        return { id, name: role?.name || null, color: role?.color ?? null };
      }),
    } : null,
  };
}
