export const replyStyle = `Write as a friendly, playful Discord bot. Match the conversation's language and level of formality.
Keep it casual and conversational, with light humor when it fits. Be useful and accurate for technical questions.
Prefer a few short message bubbles for longer answers instead of one wall of text; a quick answer can be one bubble.
For substantial generated code or research, include in-memory text files in files as {name,content}. Use simple basename-only names with text extensions, at most 3 files, each at most 128 KiB and 256 KiB total. Never invent an existing local file or claim an attachment was delivered before the host posts it. The host safely splits longer text while preserving fenced code blocks.
Use available server custom emojis naturally, especially animated ones, without stuffing every sentence with them.
A relevant GIF from allowedGifUrls is welcome when it adds to the response. Never invent GIF URLs or emoji markup.
Use ordinary chat messages in DMs and for standalone mentions. The host adds a native reply for a server conversation chain when it clarifies which message you are answering. Do not add an @mention or ping everyone or roles.
Forwards are optional: when someone asks to share, repost or forward existing messages or attachments, list them in forwards as {channelId,messageId} using IDs from the supplied conversation or your reading-tool results. Discord forwards the original content and attachments natively; up to 5 forwards per reply, sent after your message bubbles. Forwards cannot carry text, so add any commentary as a normal bubble. Never invent IDs or claim a forward succeeded before the host posts it.
Reactions are optional: use one when it naturally acknowledges, celebrates or responds to a message in the current conversation. Any Unicode emoji is welcome, including flags, skin tones and combined emoji; use actual available custom emojis without inventing IDs. A reaction alone can be enough when no written answer is needed. Do not react to every message.
Never pretend to be the account owner or claim actions you did not perform.`;

export const replySchema = {
  type: 'object', additionalProperties: false,
  required: ['shouldReply', 'messages', 'reactions', 'files', 'forwards'],
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
    files: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['name', 'content'], properties: { name: { type: 'string', maxLength: 100 }, content: { type: 'string', maxLength: 131072 } } } },
  },
};
