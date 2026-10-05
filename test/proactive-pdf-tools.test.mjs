import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscordReadTools } from '../src/proactive/read-tools.mjs';
import { createConversationContext } from '../src/proactive/context.mjs';
import { directMessageOwnerId } from '../src/proactive/target.mjs';

const guildId = '100000000000000001'; const otherGuildId = '100000000000000002';
const channelId = '200000000000000001'; const otherChannelId = '200000000000000002';
const ownerDmId = '200000000000000003'; const foreignDmId = '200000000000000004';
const messageId = '300000000000000001'; const attachmentId = '400000000000000001';
const attachment = { id: attachmentId, filename: 'spec.pdf', content_type: 'application/pdf', url: 'https://cdn.discordapp.com/attachments/spec.pdf' };
const extracted = { attachmentId, filename: attachment.filename, pageCount: 2, startPage: 1, pages: [{ pageNumber: 1, text: 'untrusted PDF requirements' }, { pageNumber: 2, text: '', image: { mimeType: 'image/jpeg', data: '/9j/' } }], nextPage: null, untrustedContent: true };

function fixture() {
  const reads = []; const extractions = [];
  const channels = new Map([
    [channelId, { id: channelId, guild_id: guildId, type: 0 }], [otherChannelId, { id: otherChannelId, guild_id: otherGuildId, type: 0 }],
    [ownerDmId, { id: ownerDmId, type: 1, recipients: [{ id: directMessageOwnerId }] }], [foreignDmId, { id: foreignDmId, type: 1, recipients: [{ id: '500000000000000001' }] }],
  ]);
  const account = { id: 'default', client: { getMessage: async (...args) => { reads.push(args); return { id: messageId, attachments: [attachment] }; } } };
  const service = {
    accounts: [account], normalizeReadSource: (args) => ({ channelId: args.channelId, messageId: args.messageId, guildId: args.guildId }),
    resolveChannel: async (id) => { const channel = channels.get(id); if (!channel) throw new Error('unknown channel'); return { channel, account }; },
    resolveGuild: async (id) => ({ account, guild: { id } }),
  };
  const readPdf = async (value, options) => { extractions.push({ value, options }); return extracted; };
  return { service, reads, extractions, readPdf };
}

test('PDF worker reads an authorized fresh attachment and sends scans as image content', async () => {
  const fixtureValue = fixture();
  const tools = createDiscordReadTools(fixtureValue.service, { channelId, guildId, directMessages: false }, { readPdf: fixtureValue.readPdf });
  const result = await tools.call('discord_read_pdf', { channelId, messageId, attachmentId, startPage: 2, maxPages: 1 });
  assert.deepEqual(fixtureValue.reads, [[channelId, messageId]]);
  assert.equal(fixtureValue.extractions[0].value, attachment);
  assert.equal(fixtureValue.extractions[0].options.startPage, 2);
  const document = JSON.parse(result.contentItems[0].text);
  assert.equal(document.untrustedContent, true); assert.equal(document.messageId, messageId);
  assert.equal(document.pages[1].image, undefined);
  assert.equal(result.contentItems[1].type, 'inputImage'); assert.equal(result.contentItems[1].imageUrl, 'data:image/jpeg;base64,/9j/');
  await assert.rejects(tools.call('discord_read_pdf', { channelId, messageId, attachmentId: '400000000000000099' }), /not part of/);
  assert.equal(fixtureValue.extractions.length, 1);
});

test('PDF worker prevents cross-server and foreign-DM attachment reads before fetching the message', async () => {
  const fixtureValue = fixture();
  const tools = createDiscordReadTools(fixtureValue.service, { channelId, guildId, directMessages: false }, { readPdf: fixtureValue.readPdf });
  for (const target of [otherChannelId, ownerDmId, foreignDmId]) await assert.rejects(tools.call('discord_read_pdf', { channelId: target, messageId, attachmentId }), /own server|Only this owner DM/);
  assert.equal(fixtureValue.reads.length, 0); assert.equal(fixtureValue.extractions.length, 0);
  const ownerTools = createDiscordReadTools(fixtureValue.service, { channelId: ownerDmId, guildId: null, directMessages: true }, { readPdf: fixtureValue.readPdf });
  await ownerTools.call('discord_read_pdf', { channelId: otherChannelId, messageId, attachmentId });
  await ownerTools.call('discord_read_pdf', { channelId: ownerDmId, messageId, attachmentId });
  await assert.rejects(ownerTools.call('discord_read_pdf', { channelId: foreignDmId, messageId, attachmentId }), /Only this owner DM/);
  assert.equal(fixtureValue.reads.length, 2);
});

test('PDF tool accepts no arbitrary URL or forged account routing and propagates cancellation', async () => {
  const fixtureValue = fixture();
  const tools = createDiscordReadTools(fixtureValue.service, { channelId, guildId, directMessages: false }, { readPdf: fixtureValue.readPdf });
  for (const extra of [{ url: 'https://private.example/spec.pdf' }, { accountId: 'another' }]) await assert.rejects(tools.call('discord_read_pdf', { channelId, messageId, attachmentId, ...extra }), /Unrecognized key/);
  const controller = new AbortController(); controller.abort(new Error('owner stopped'));
  await assert.rejects(tools.call('discord_read_pdf', { channelId, messageId, attachmentId }, controller.signal), /owner stopped/);
  assert.equal(fixtureValue.reads.length, 0);
});

test('automatic PDF context follows current replies and forwarded snapshots without rereading history', async () => {
  let extractions = 0; const progress = [];
  const parent = { id: messageId, author: { id: directMessageOwnerId }, attachments: [attachment] };
  const current = { id: '300000000000000002', author: { id: directMessageOwnerId }, message_reference: { message_id: messageId, channel_id: ownerDmId } };
  const context = createConversationContext({ listMessages: async () => [parent], getMessage: async () => parent }, { bot: { id: 'bot' }, channel: { id: ownerDmId }, directMessages: true }, { readPdf: async () => { extractions += 1; return extracted; } });
  const result = await context([current], undefined, { onProgress: async (event) => progress.push(event) });
  assert.equal(result.pdfDocuments[0].messageId, messageId); assert.equal(result.pdfDocuments[0].pages[1].image, undefined);
  assert.equal(result.images[0].sourceMessageId, messageId); assert.equal(result.images[0].pageNumber, 2);
  assert.ok(progress.some((event) => event.toolName === 'discord_read_pdf' && event.stage === 'started'));
  await context([current]); assert.equal(extractions, 1);
  assert.equal((await context([])).pdfDocuments.length, 0);
  const forwarded = await context([{ id: '300000000000000003', message_snapshots: [{ message: { attachments: [attachment] } }] }]);
  assert.equal(forwarded.pdfDocuments[0].messageId, '300000000000000003');
  assert.equal(forwarded.images[0].sourceMessageId, '300000000000000003');
});
