import https from 'node:https';
import http from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [first, second] = address.split('.').map(Number);
    return !(first === 0 || first === 10 || first === 127 || first >= 224 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && (second === 168 || second === 0)) || (first === 100 && second >= 64 && second <= 127) || (first === 198 && [18, 19, 51].includes(second)) || (first === 203 && second === 0));
  }
  // IPv4-mapped addresses and non-global IPv6 are rejected rather than guessed.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2002:|^2001:(db8|0|10|20):/i.test(address);
}

export async function readPublicLink({ url, maxCharacters = 20000 }, { signal, lookupImpl = lookup, requestImpl } = {}) {
  let current = new URL(url);
  const combinedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  for (let redirect = 0; redirect < 4; redirect += 1) {
    combinedSignal.throwIfAborted();
    if (!['https:', 'http:'].includes(current.protocol) || current.username || current.password || (current.port && !['80', '443'].includes(current.port))) throw new Error('Only public HTTP(S) links without credentials or custom ports are readable');
    const hostname = current.hostname.replace(/^\[|\]$/g, '');
    const addresses = await lookupImpl(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('Private, local and reserved network addresses are unavailable');
    const selected = addresses[0];
    const response = await new Promise((resolve, reject) => {
      const request = (requestImpl || (current.protocol === 'https:' ? https.request : http.request))(current, {
        method: 'GET', signal: combinedSignal,
        headers: { 'User-Agent': 'Nova-LinkReader/1.0', Accept: 'text/html,text/plain,application/json' },
        lookup: (_hostname, options, callback) => callback(null, options.all ? [selected] : selected.address, selected.family),
      }, resolve);
      request.once('error', reject); request.end();
    });
    if (response.statusCode >= 300 && response.statusCode < 400) {
      response.destroy(); const location = response.headers.location;
      if (!location) throw new Error('Redirect has no destination');
      current = new URL(location, current); continue;
    }
    if (response.statusCode !== 200) { response.destroy(); throw new Error(`Link returned HTTP ${response.statusCode}`); }
    const mime = String(response.headers['content-type'] || '').split(';')[0];
    if (!['text/plain', 'text/html', 'application/json'].includes(mime)) { response.destroy(); throw new Error('Only text, HTML and JSON links are readable'); }
    const chunks = []; let bytes = 0;
    for await (const chunk of response) { bytes += chunk.length; if (bytes > 512 * 1024) { response.destroy(); break; } chunks.push(chunk); }
    let text = Buffer.concat(chunks).toString('utf8');
    if (mime === 'text/html') text = text.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    return { url: current.href, text: text.slice(0, maxCharacters), truncated: bytes > 512 * 1024 || text.length > maxCharacters, untrustedContent: true };
  }
  throw new Error('Too many link redirects');
}
