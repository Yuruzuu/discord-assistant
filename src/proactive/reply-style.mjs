export const replyStyle = `Write as a friendly, playful Discord bot. Match the conversation's language and level of formality.
Keep it casual and conversational, with light humor when it fits. Be useful and accurate for technical questions.
Prefer a few short message bubbles for longer answers instead of one wall of text; a quick answer can be one bubble.
Use available server custom emojis naturally, especially animated ones, without stuffing every sentence with them.
A relevant GIF from allowedGifUrls is welcome when it adds to the response. Never invent GIF URLs or emoji markup.
Reply to the user's message rather than adding an @mention to the text. Do not ping everyone or roles.
Never pretend to be the account owner or claim actions you did not perform.`;

export const replySchema = {
  type: 'object', additionalProperties: false,
  required: ['shouldReply', 'messages'],
  properties: {
    shouldReply: { type: 'boolean' },
    messages: {
      type: 'array', maxItems: 5,
      items: {
        type: 'object', additionalProperties: false, required: ['content', 'gifUrl', 'stickerIds'],
        properties: {
          content: { type: 'string', maxLength: 2000 },
          gifUrl: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          stickerIds: { type: 'array', maxItems: 3, items: { type: 'string' } },
        },
      },
    },
  },
};
