export async function reportPreparation(onProgress, event, signal) {
  signal?.throwIfAborted();
  try { await onProgress?.(event, signal); } catch { signal?.throwIfAborted(); }
}

export async function readContextImages(client, messages, { maxImages = 3, maxBytes = 2 * 1024 * 1024 } = {}, signal, { onProgress } = {}) {
  const images = []; const warnings = []; const seen = new Set(); let totalBytes = 0;
  for (const message of messages) {
    for (const attachment of message.attachments || []) {
      signal?.throwIfAborted();
      if (images.length >= maxImages || totalBytes >= 6 * 1024 * 1024) return { images, warnings };
      if (!attachment.url || !/^image\/(png|jpeg|webp|gif)$/.test(attachment.content_type || '') || seen.has(attachment.url)) continue;
      seen.add(attachment.url);
      try {
        await reportPreparation(onProgress, { stage: 'started', toolName: 'image_read' }, signal);
        const image = await client.fetchImage(attachment.url, { maxBytes: Math.min(maxBytes, 6 * 1024 * 1024 - totalBytes), signal });
        signal?.throwIfAborted();
        if (image.size > maxBytes || !/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType)) throw new Error('Image exceeds its supported format or byte limit');
        totalBytes += image.size;
        images.push({ imageUrl: `data:${image.mimeType};base64,${image.data}`, sourceMessageId: message.id });
        await reportPreparation(onProgress, { stage: 'completed', toolName: 'image_read', resultCount: 1 }, signal);
      } catch (error) { signal?.throwIfAborted(); warnings.push({ messageId: message.id, error: String(error.message).slice(0, 200) }); await reportPreparation(onProgress, { stage: 'failed', toolName: 'image_read' }, signal); }
    }
  }
  return { images, warnings };
}

export async function transcribeVoiceNotes(messages, transcribe, signal, { onProgress, cache = new Map() } = {}) {
  const transcripts = []; const warnings = [];
  const seen = new Set(); let processed = 0;
  for (const message of messages) for (const attachment of message.attachments || []) {
    if (!isVoiceAttachment(attachment)) continue;
    signal?.throwIfAborted();
    const key = `${message.id}:${attachment.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (processed >= 3) { warnings.push({ messageId: message.id, error: 'Only three voice notes are processed per turn; send the remaining notes in another message.' }); continue; }
    processed += 1;
    if (!transcribe) { warnings.push({ messageId: message.id, error: 'Voice transcription is not configured. Ask the owner to select a local executable or speech provider.' }); continue; }
    if (cache.has(key)) { transcripts.push(cache.get(key)); continue; }
    try {
      await reportPreparation(onProgress, { stage: 'started', toolName: 'voice_transcribe' }, signal);
      const text = await transcribe(attachment, { signal });
      signal?.throwIfAborted();
      const transcript = { messageId: message.id, text: String(text).slice(0, 20000), untrustedContent: true };
      transcripts.push(transcript); cache.set(key, transcript);
      while (cache.size > 32) cache.delete(cache.keys().next().value);
      await reportPreparation(onProgress, { stage: 'completed', toolName: 'voice_transcribe', resultCount: 1 }, signal);
    } catch (error) { signal?.throwIfAborted(); warnings.push({ messageId: message.id, error: String(error.message).slice(0, 200) }); await reportPreparation(onProgress, { stage: 'failed', toolName: 'voice_transcribe' }, signal); }
  }
  return { transcripts, warnings };
}
import { isVoiceAttachment } from './voice-transcriber.mjs';
