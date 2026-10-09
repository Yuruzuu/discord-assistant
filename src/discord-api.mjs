import { createConcurrencyLimit } from './concurrency.mjs';
import { setTimeout as wait } from 'node:timers/promises';

const API_BASE = 'https://discord.com/api/v10';
const USER_AGENT = 'discord-readonly-mcp/2.0 (+https://github.com/Vorakorn1001/discord-readonly-mcp)';
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// Only idempotent methods are retried after a server or connection failure; a POST may already have been applied.
const IDEMPOTENT_METHODS = new Set(['GET', 'PUT', 'PATCH', 'DELETE']);
const RETRYABLE_CONNECTION_CODES = new Set([
  'FETCH_FAILED', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED',
  'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);

function isAllowedMediaHost(hostname) {
  const host = hostname.toLowerCase();
  return (
    host === 'cdn.discordapp.com' ||
    host === 'media.discordapp.net' ||
    /^images-ext-\d+\.discordapp\.net$/.test(host)
  );
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function requestRoute(path) {
  const parts = path.split('?')[0].split('/');
  const major = ['channels', 'guilds'].includes(parts[1]) ? `${parts[1]}/${parts[2]}` : '';
  const route = parts.map((part, index) => /^\d+$/.test(part) && !(major && index === 2) ? ':id' : part).join('/');

  return { route, major };
}

function secondsToMilliseconds(value) {
  if (value == null || value === '') return null;
  const seconds = Number(value);

  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
}

function connectionErrorCode(error) {
  const causes = [error, error?.cause, ...(error?.cause?.errors || [])];
  const code = causes.find((cause) => typeof cause?.code === 'string')?.code;
  if (code) return code;
  if (error?.name === 'TimeoutError') return 'REQUEST_TIMEOUT';
  if (error?.name === 'AbortError') return 'ABORT_ERR';

  return error instanceof TypeError && error.message === 'fetch failed' ? 'FETCH_FAILED' : null;
}

function connectionErrorMessage(code) {
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return `Discord DNS lookup failed (${code}). Check the MCP server's network connection.`;
  if (['EPERM', 'EACCES'].includes(code)) return `The execution environment blocked Discord network access (${code}).`;
  if (['REQUEST_TIMEOUT', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) {
    return `Discord request timed out (${code}).`;
  }
  if (code.includes('CERT') || code.startsWith('UNABLE_TO_VERIFY')) return `Discord TLS certificate verification failed (${code}).`;

  return `Discord connection failed (${code}).`;
}

function detectImageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export class DiscordApiError extends Error {
  constructor(message, { status = null, code = null, path = null, accountId = null } = {}) {
    super(message);
    this.name = 'DiscordApiError';
    this.status = status;
    this.code = code;
    this.path = path;
    this.accountId = accountId;
  }
}

export class DiscordApiClient {
  constructor({ accountId, token, fetchImpl = globalThis.fetch, sleep = wait, maxRetries = 3, requestTimeoutMs = 30_000, maxConcurrentRequests = 4, now = Date.now }) {
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
    this.accountId = accountId;
    this.token = token;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.maxRetries = maxRetries;
    this.requestTimeoutMs = requestTimeoutMs;
    this.now = now;
    this.runRequest = createConcurrencyLimit(maxConcurrentRequests);
    this.pendingRequests = new Map();
    this.pendingImages = new Map();
    this.routeRequests = new Map();
    this.routeBuckets = new Map();
    this.rateLimitResets = new Map();
    this.globalResetAt = 0;
  }

  async get(path) {
    const existing = this.pendingRequests.get(path);
    if (existing) return existing;

    const request = this.scheduleRequest('GET', path).finally(() => {
      this.pendingRequests.delete(path);
    });
    this.pendingRequests.set(path, request);

    return request;
  }

  post(path, payload, options) {
    return this.scheduleRequest('POST', path, payload, options);
  }

  addReaction(channelId, messageId, emoji, options) {
    return this.scheduleRequest('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, undefined, options);
  }

  scheduleRequest(method, path, payload, options) {
    if (!path.startsWith('/')) throw new Error('Discord API paths must start with /');
    const { route, major } = requestRoute(path);
    const methodRoute = `${method} ${route}`;
    const queueKey = this.routeBuckets.get(methodRoute) || methodRoute;
    const previous = this.routeRequests.get(queueKey) || Promise.resolve();
    const request = previous.catch(() => {}).then(() => this.requestJson(path, methodRoute, major, method, payload, options)).finally(() => {
      if (this.routeRequests.get(queueKey) === request) this.routeRequests.delete(queueKey);
    });
    this.routeRequests.set(queueKey, request);

    return request;
  }

  async waitForRateLimit(route) {
    while (true) {
      const key = this.routeBuckets.get(route) || route;
      const resetAt = this.rateLimitResets.get(key) || 0;
      const remaining = Math.max(this.globalResetAt, resetAt) - this.now();
      if (remaining <= 0) {
        this.rateLimitResets.delete(key);
        return;
      }
      await this.sleep(remaining);
    }
  }

  recordRateLimit(route, major, response, body) {
    const bucket = response.headers.get('x-ratelimit-bucket');
    if (bucket) this.routeBuckets.set(route, `${bucket}:${major}`);
    const key = this.routeBuckets.get(route) || route;
    const resetAfter = secondsToMilliseconds(response.headers.get('x-ratelimit-reset-after'));
    if (response.headers.get('x-ratelimit-remaining') === '0' && resetAfter != null) {
      this.rateLimitResets.set(key, Math.max(this.rateLimitResets.get(key) || 0, this.now() + resetAfter));
    }
    if (response.status !== 429) return false;

    const bodyDelay = secondsToMilliseconds(body?.retry_after);
    const headerDelay = secondsToMilliseconds(response.headers.get('retry-after'));
    const retryDelay = Math.max(bodyDelay ?? resetAfter ?? 0, headerDelay ?? 0, 50);
    const resetAt = this.now() + retryDelay;
    if (body?.global === true || response.headers.get('x-ratelimit-global') === 'true' || response.headers.get('x-ratelimit-scope') === 'global') {
      this.globalResetAt = Math.max(this.globalResetAt, resetAt);
    } else {
      this.rateLimitResets.set(key, Math.max(this.rateLimitResets.get(key) || 0, resetAt));
    }

    return bodyDelay != null || headerDelay != null || resetAfter != null;
  }

  createGuildChannel(guildId, payload, options) {
    return this.post(`/guilds/${guildId}/channels`, payload, options);
  }

  createGuildRole(guildId, payload, options) {
    return this.post(`/guilds/${guildId}/roles`, payload, options);
  }

  addGuildMemberRole(guildId, userId, roleId, options) {
    return this.scheduleRequest('PUT', `/guilds/${guildId}/members/${userId}/roles/${roleId}`, undefined, options);
  }

  removeGuildMemberRole(guildId, userId, roleId, options) {
    return this.scheduleRequest('DELETE', `/guilds/${guildId}/members/${userId}/roles/${roleId}`, undefined, options);
  }

  async requestJson(path, route, major, method, payload, { signal, reason } = {}) {
    const idempotent = IDEMPOTENT_METHODS.has(method);
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.waitForRateLimit(route);
      signal?.throwIfAborted();
      let result;
      try {
        result = await this.runRequest(async () => {
          await this.waitForRateLimit(route);
          signal?.throwIfAborted();
          const response = await this.fetch(`${API_BASE}${path}`, {
            method,
            headers: {
              Authorization: `Bot ${this.token}`,
              'User-Agent': USER_AGENT,
              ...(reason ? { 'X-Audit-Log-Reason': encodeURIComponent(reason) } : {}),
              ...(payload === undefined || payload instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(payload === undefined ? {} : { body: payload instanceof FormData ? payload : JSON.stringify(payload) }),
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]) : AbortSignal.timeout(this.requestTimeoutMs),
          });
          const body = parseJson(await response.text());
          const retryable = this.recordRateLimit(route, major, response, body);

          return { response, body, retryable };
        });
      } catch (error) {
        const code = connectionErrorCode(error);
        if (!code) throw error;
        if (idempotent && attempt < this.maxRetries && RETRYABLE_CONNECTION_CODES.has(code)) {
          await this.sleep(250 * 2 ** attempt);
          continue;
        }

        const failure = new DiscordApiError(connectionErrorMessage(code), {
          code,
          path: path.split('?')[0],
          accountId: this.accountId,
        });
        failure.cause = error;
        throw failure;
      }

      const { response, body, retryable } = result;

      if (response.ok) return body;
      if (response.status === 429 && attempt < this.maxRetries && retryable) continue;
      if (idempotent && response.status >= 500 && attempt < this.maxRetries) {
        await this.sleep(250 * 2 ** attempt);
        continue;
      }

      const detail = typeof body === 'string' ? body : body?.message;
      throw new DiscordApiError(
        `Discord API ${response.status}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`,
        {
          status: response.status,
          code: typeof body === 'object' && body ? body.code : null,
          path: path.split('?')[0],
          accountId: this.accountId,
        },
      );
    }
    throw new DiscordApiError('Discord API retry limit exceeded', { accountId: this.accountId });
  }

  getCurrentUser() {
    return this.get('/users/@me');
  }

  getUser(userId) {
    return this.get(`/users/${userId}`);
  }

  createDirectMessageChannel(userId) {
    return this.post('/users/@me/channels', { recipient_id: userId });
  }

  getGuildMember(guildId, userId) {
    return this.get(`/guilds/${guildId}/members/${userId}`);
  }

  searchGuildMembers(guildId, query, limit = 25) {
    return this.get(`/guilds/${guildId}/members/search?${new URLSearchParams({ query, limit: String(limit) })}`);
  }

  listGuildRoles(guildId) {
    return this.get(`/guilds/${guildId}/roles`);
  }

  async searchGuildMessages(guildId, parameters, { signal } = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(parameters)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) for (const item of value) query.append(key, String(item));
      else query.set(key, String(value));
    }
    const path = `/guilds/${guildId}/messages/search?${query}`;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      signal?.throwIfAborted();
      const result = await this.get(path);
      signal?.throwIfAborted();
      if (result?.code !== 110000) {
        if (!Array.isArray(result?.messages)) throw new DiscordApiError('Discord returned an invalid message search result', { path, accountId: this.accountId });
        return result;
      }
      if (attempt === this.maxRetries) throw new DiscordApiError('Discord is still indexing this server. Retry the search later.', { status: 202, code: 110000, path, accountId: this.accountId });
      const delay = Number(result.retry_after);
      await this.sleep(Number.isFinite(delay) && delay >= 0 ? Math.max(delay * 1000, 250) : 1000, undefined, { signal });
    }
  }

  async listGuilds() {
    const guilds = [];
    let after;
    do {
      const query = new URLSearchParams({ limit: '200' });
      if (after) query.set('after', after);
      const page = await this.get(`/users/@me/guilds?${query}`);
      if (!Array.isArray(page)) throw new DiscordApiError('Discord returned an invalid guild list');
      guilds.push(...page);
      after = page.length === 200 ? page.at(-1)?.id : null;
    } while (after);
    return guilds;
  }

  getGuild(guildId) {
    return this.get(`/guilds/${guildId}`);
  }

  listGuildChannels(guildId) {
    return this.get(`/guilds/${guildId}/channels`);
  }

  listGuildEmojis(guildId) {
    return this.get(`/guilds/${guildId}/emojis`);
  }

  listGuildStickers(guildId) {
    return this.get(`/guilds/${guildId}/stickers`);
  }

  listActiveGuildThreads(guildId) {
    return this.get(`/guilds/${guildId}/threads/active`);
  }

  getChannel(channelId) {
    return this.get(`/channels/${channelId}`);
  }

  getMessage(channelId, messageId) {
    return this.get(`/channels/${channelId}/messages/${messageId}`);
  }

  sendMessage(channelId, payload, options) {
    return this.post(`/channels/${channelId}/messages`, payload, options);
  }

  editMessage(channelId, messageId, payload, options) {
    return this.scheduleRequest('PATCH', `/channels/${channelId}/messages/${messageId}`, payload, options);
  }

  deleteMessage(channelId, messageId, options) {
    return this.scheduleRequest('DELETE', `/channels/${channelId}/messages/${messageId}`, undefined, options);
  }

  removeOwnReaction(channelId, messageId, emoji, options) {
    return this.scheduleRequest('DELETE', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, undefined, options);
  }

  // toBlob validates each upload and throws synchronously, so an invalid upload never starts a request.
  sendMessageForm(channelId, payload, uploads, toBlob, options) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    for (const [index, upload] of uploads.entries()) form.append(`files[${index}]`, toBlob(upload), upload.name);
    return this.post(`/channels/${channelId}/messages`, form, options);
  }

  sendMessageFiles(channelId, payload, files, options) {
    if (!Array.isArray(files) || files.length < 1 || files.length > 3) throw new Error('Provide one to three generated text files');
    let total = 0;
    return this.sendMessageForm(channelId, payload, files, (file) => {
      if (typeof file.name !== 'string' || !SAFE_FILENAME.test(file.name) || typeof file.content !== 'string') throw new Error('Generated files require a safe filename and text content');
      const size = Buffer.byteLength(file.content);
      total += size;
      if (size > 128 * 1024 || total > 256 * 1024) throw new Error('Generated file byte limit exceeded');
      return new Blob([file.content], { type: 'text/plain;charset=utf-8' });
    }, options);
  }

  sendMessageImages(channelId, payload, images, options) {
    if (!Array.isArray(images) || images.length < 1 || images.length > 4) throw new Error('Provide one to four images');
    let total = 0;
    return this.sendMessageForm(channelId, payload, images, (image) => {
      if (typeof image.name !== 'string' || !SAFE_FILENAME.test(image.name) || !/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType) || typeof image.data !== 'string') throw new Error('Images require a safe filename, a supported image type and base64 data');
      const bytes = Buffer.from(image.data, 'base64');
      total += bytes.length;
      if (!bytes.length || bytes.length > 8 * 1024 * 1024 || total > 20 * 1024 * 1024) throw new Error('Image byte limit exceeded');
      return new Blob([bytes], { type: image.mimeType });
    }, options);
  }

  createThread(channelId, payload, options) {
    return this.post(`/channels/${channelId}/threads`, payload, options);
  }

  registerCommand(applicationId, command) {
    return this.post(`/applications/${applicationId}/commands`, command);
  }

  triggerTyping(channelId, options) {
    return this.post(`/channels/${channelId}/typing`, undefined, options);
  }

  listMessages(channelId, { limit = 50, before, after, around } = {}) {
    const query = new URLSearchParams({ limit: String(Math.min(Math.max(Number(limit) || 50, 1), 100)) });
    if (before) query.set('before', before);
    if (after) query.set('after', after);
    if (around) query.set('around', around);
    return this.get(`/channels/${channelId}/messages?${query}`);
  }

  async listArchivedThreads(channelId, { kind = 'public', limit = 100, maxItems = 500, archivedAfter } = {}) {
    const joined = kind === 'joined-private';
    const route = joined ? `/channels/${channelId}/users/@me/threads/archived/private` : `/channels/${channelId}/threads/archived/${kind}`;
    // Public archives are newest-archived first, so a caller interested in a recent window can stop at the first older page.
    const recentOnly = archivedAfter !== undefined && !joined;
    const threads = [];
    let before;
    let hasMore = true;
    while (hasMore && threads.length < maxItems) {
      const query = new URLSearchParams({ limit: String(Math.min(Math.max(limit, 1), 100)) });
      if (before) query.set('before', before);
      const page = await this.get(`${route}?${query}`);
      const pageThreads = Array.isArray(page?.threads) ? page.threads : [];
      threads.push(...pageThreads);
      const last = pageThreads.at(-1);
      before = (joined ? last?.id : last?.thread_metadata?.archive_timestamp) || null;
      hasMore = Boolean(page?.has_more && before) && !(recentOnly && Date.parse(before) < archivedAfter);
    }
    if (recentOnly) return { threads: threads.filter((thread) => !(Date.parse(thread.thread_metadata?.archive_timestamp) < archivedAfter)).slice(0, maxItems), hasMore: false };
    return { threads: threads.slice(0, maxItems), hasMore };
  }

  async fetchImage(url, { maxBytes }) {
    const key = `${maxBytes}:${url}`;
    const existing = this.pendingImages.get(key);
    if (existing) return existing;

    const request = this.runRequest(() => this.requestImage(url, { maxBytes })).finally(() => {
      this.pendingImages.delete(key);
    });
    this.pendingImages.set(key, request);

    return request;
  }

  async requestImage(url, { maxBytes }) {
    let current;
    try {
      current = new URL(url);
    } catch {
      throw new Error('Attachment URL is invalid');
    }

    for (let redirect = 0; redirect <= 3; redirect += 1) {
      if (current.protocol !== 'https:' || !isAllowedMediaHost(current.hostname)) {
        throw new Error('Attachment URL must use an approved Discord media host');
      }
      const response = await this.fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      let reader;
      try {
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location || redirect === 3) throw new Error('Discord attachment redirected too many times');
          current = new URL(location, current);
          continue;
        }
        if (!response.ok) throw new Error(`Discord attachment returned HTTP ${response.status}`);

        const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
        if (!IMAGE_MIME_TYPES.has(mimeType)) {
          throw new Error(`Unsupported attachment MIME type: ${mimeType || 'unknown'}`);
        }
        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          throw new Error(`Attachment exceeds the ${maxBytes}-byte image limit`);
        }

        const chunks = [];
        let size = 0;
        reader = response.body?.getReader();
        if (!reader) throw new Error('Attachment response has no readable body');
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            throw new Error(`Attachment exceeds the ${maxBytes}-byte image limit`);
          }
          chunks.push(value);
        }
        const buffer = Buffer.concat(chunks);
        const detectedMimeType = detectImageMime(buffer);
        if (!detectedMimeType || detectedMimeType !== mimeType) {
          throw new Error(`Attachment bytes do not match declared MIME type ${mimeType}`);
        }
        return { data: buffer.toString('base64'), mimeType, size };
      } finally {
        if (reader) {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        } else if (response.body) {
          await response.body.cancel().catch(() => {});
        }
      }
    }
    throw new Error('Unable to fetch Discord attachment');
  }
}
