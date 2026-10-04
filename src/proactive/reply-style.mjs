// Nova's persona and rules live in instructions/nova/*.md; this module keeps the machine-checked reply-plan schema.
export const replySchema = {
  type: 'object', additionalProperties: false,
  required: ['shouldReply', 'messages', 'reactions', 'files', 'forwards', 'controls', 'images', 'channelMessages'],
  properties: {
    shouldReply: { type: 'boolean' },
    messages: {
      type: 'array', maxItems: 5,
      items: {
        type: 'object', additionalProperties: false, required: ['content', 'gifUrl', 'stickerIds'],
        properties: {
          content: { type: 'string', maxLength: 16000 },
          gifUrl: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          stickerIds: { type: 'array', maxItems: 3, items: { type: 'string' } },
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
      items: { type: 'object', additionalProperties: false, required: ['channelId', 'content', 'notify'],
        properties: { channelId: { type: 'string' }, content: { type: 'string', maxLength: 2000 }, notify: { type: 'boolean' } } },
    },
    files: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['name', 'content'], properties: { name: { type: 'string', maxLength: 100 }, content: { type: 'string', maxLength: 131072 } } } },
  },
};
