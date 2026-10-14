import { z } from 'zod/v4';

// One input shape serves MCP callers and Nova's reply plan (whose strict output schema sends null for unused keys).
const text = (max) => z.string().max(max).nullish();
const link = (max = 2048) => z.string().max(max).nullish();
const fieldSchema = z.object({ name: z.string().min(1).max(256), value: z.string().min(1).max(1024), inline: z.boolean().nullish() }).strict();
export const embedSchema = z.object({
  title: text(256), description: text(4096), url: link(),
  color: z.union([z.number().int().min(0).max(0xFFFFFF), z.string().regex(/^#?[0-9A-Fa-f]{6}$/)]).nullish().describe('Sidebar colour as #RRGGBB or an integer'),
  author: z.object({ name: z.string().min(1).max(256), url: link(), iconUrl: link() }).strict().nullish(),
  fields: z.array(fieldSchema).max(25).nullish(),
  imageUrl: link(), thumbnailUrl: link(),
  footer: z.union([z.string().max(2048), z.object({ text: z.string().min(1).max(2048), iconUrl: link() }).strict()]).nullish(),
  timestamp: z.string().max(40).nullish().describe('ISO 8601 time shown beside the footer'),
}).strict();
export const linkButtonSchema = z.object({ label: z.string().min(1).max(80), url: z.string().max(512) }).strict();

// Only link buttons: Nova has no handler for custom interactive components, and links need no interaction round trip.
function httpsUrl(value, name, max = 2048) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a valid HTTPS URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || value.length > max) throw new Error(`${name} must be a valid HTTPS URL without credentials`);
  return value;
}
const present = (value) => value !== null && value !== undefined && value !== '';

function toDiscordEmbed(input, index) {
  const embed = embedSchema.parse(input);
  const footer = typeof embed.footer === 'string' ? (embed.footer ? { text: embed.footer } : null) : embed.footer;
  const result = {
    ...(present(embed.title) ? { title: embed.title } : {}),
    ...(present(embed.description) ? { description: embed.description } : {}),
    ...(present(embed.url) ? { url: httpsUrl(embed.url, `embeds[${index}].url`) } : {}),
    ...(present(embed.color) ? { color: typeof embed.color === 'number' ? embed.color : Number.parseInt(embed.color.replace('#', ''), 16) } : {}),
    ...(embed.author ? { author: { name: embed.author.name, ...(present(embed.author.url) ? { url: httpsUrl(embed.author.url, `embeds[${index}].author.url`) } : {}), ...(present(embed.author.iconUrl) ? { icon_url: httpsUrl(embed.author.iconUrl, `embeds[${index}].author.iconUrl`) } : {}) } } : {}),
    ...(embed.fields?.length ? { fields: embed.fields.map((field) => ({ name: field.name, value: field.value, ...(field.inline ? { inline: true } : {}) })) } : {}),
    ...(present(embed.imageUrl) ? { image: { url: httpsUrl(embed.imageUrl, `embeds[${index}].imageUrl`) } } : {}),
    ...(present(embed.thumbnailUrl) ? { thumbnail: { url: httpsUrl(embed.thumbnailUrl, `embeds[${index}].thumbnailUrl`) } } : {}),
    ...(footer ? { footer: { text: footer.text, ...(present(footer.iconUrl) ? { icon_url: httpsUrl(footer.iconUrl, `embeds[${index}].footer.iconUrl`) } : {}) } } : {}),
  };
  if (present(embed.timestamp)) {
    const time = new Date(embed.timestamp);
    if (Number.isNaN(time.getTime())) throw new Error(`embeds[${index}].timestamp must be an ISO 8601 time`);
    result.timestamp = time.toISOString();
  }
  if (!['title', 'description', 'author', 'fields', 'image', 'thumbnail', 'footer'].some((key) => key in result)) throw new Error(`embeds[${index}] needs a title, description, fields, image or footer`);
  return result;
}

export function embedText(embed) {
  return [embed.title, embed.description, embed.author?.name, ...(embed.fields || []).flatMap((field) => [field.name, field.value]), embed.footer?.text].filter((value) => typeof value === 'string');
}

export function discordEmbeds(embeds = []) {
  if (!Array.isArray(embeds) || embeds.length > 10) throw new Error('Provide at most 10 embeds');
  const converted = embeds.map(toDiscordEmbed);
  // Discord rejects a message whose embeds together exceed 6000 characters of text.
  if (converted.reduce((total, embed) => total + embedText(embed).reduce((sum, value) => sum + value.length, 0), 0) > 6000) throw new Error('Embeds may contain at most 6000 characters in total');
  return converted;
}

export function linkButtonRows(buttons = []) {
  if (!Array.isArray(buttons) || buttons.length > 25) throw new Error('Provide at most 25 link buttons');
  const components = buttons.map((input, index) => {
    const button = linkButtonSchema.parse(input);
    return { type: 2, style: 5, label: button.label, url: httpsUrl(button.url, `buttons[${index}].url`, 512) };
  });
  const rows = [];
  for (let index = 0; index < components.length; index += 5) rows.push({ type: 1, components: components.slice(index, index + 5) });
  return rows;
}
