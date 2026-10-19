// Nova's persona and rules live in instructions/nova/*.md; this module keeps the machine-checked reply-plan schema.
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const embeds = {
  type: 'array', maxItems: 3,
  items: {
    type: 'object', additionalProperties: false, required: ['title', 'description', 'url', 'color', 'fields', 'imageUrl', 'thumbnailUrl', 'footer'],
    properties: {
      title: nullable({ type: 'string', maxLength: 256 }), description: nullable({ type: 'string', maxLength: 4096 }), url: nullable({ type: 'string', maxLength: 2048 }), color: nullable({ type: 'string', maxLength: 7 }),
      fields: { type: 'array', maxItems: 25, items: { type: 'object', additionalProperties: false, required: ['name', 'value', 'inline'], properties: { name: { type: 'string', maxLength: 256 }, value: { type: 'string', maxLength: 1024 }, inline: { type: 'boolean' } } } },
      imageUrl: nullable({ type: 'string', maxLength: 2048 }), thumbnailUrl: nullable({ type: 'string', maxLength: 2048 }), footer: nullable({ type: 'string', maxLength: 2048 }),
    },
  },
};
const buttons = { type: 'array', maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['label', 'url'], properties: { label: { type: 'string', maxLength: 80 }, url: { type: 'string', maxLength: 512 } } } };

export const replySchema = {
  type: 'object', additionalProperties: false,
  required: ['shouldReply', 'messages', 'reactions', 'files', 'forwards', 'controls', 'images', 'channelMessages', 'expressionUploads'],
  properties: {
    shouldReply: { type: 'boolean' },
    messages: {
      type: 'array', maxItems: 5,
      items: {
        type: 'object', additionalProperties: false, required: ['content', 'gifUrl', 'stickerIds', 'embeds', 'buttons'],
        properties: {
          content: { type: 'string', maxLength: 16000 },
          gifUrl: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          stickerIds: { type: 'array', maxItems: 3, items: { type: 'string' } },
          embeds, buttons,
        },
      },
    },
    reactions: {
      type: 'array', maxItems: 3,
      items: { type: 'object', additionalProperties: false, required: ['messageId', 'emoji'],
        properties: { messageId: { type: 'string' }, emoji: { type: 'string', maxLength: 100 } } },
    },
    forwards: {
      type: 'array', maxItems: 5,
      items: { type: 'object', additionalProperties: false, required: ['channelId', 'messageId'],
        properties: { channelId: { type: 'string' }, messageId: { type: 'string' } } },
    },
    controls: { type: 'boolean' },
    images: { type: 'array', maxItems: 4, items: { type: 'string' } },
    channelMessages: {
      type: 'array', maxItems: 3,
      items: { type: 'object', additionalProperties: false, required: ['channelId', 'content', 'notify', 'embeds', 'buttons'],
        properties: { channelId: { type: 'string' }, content: { type: 'string', maxLength: 2000 }, notify: { type: 'boolean' }, embeds, buttons } },
    },
    expressionUploads: {
      type: 'array', maxItems: 25,
      items: { type: 'object', additionalProperties: false, required: ['guildId', 'kind', 'filePath', 'name', 'tags'],
        properties: { guildId: { type: 'string' }, kind: { type: 'string', enum: ['emoji', 'sticker'] }, filePath: { type: 'string', maxLength: 4096 }, name: nullable({ type: 'string', maxLength: 32 }), tags: nullable({ type: 'string', maxLength: 200 }) } },
    },
    files: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['name', 'content'], properties: { name: { type: 'string', maxLength: 100 }, content: { type: 'string', maxLength: 131072 } } } },
  },
};
