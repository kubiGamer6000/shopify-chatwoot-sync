import axios from 'axios';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import type { ChatwootMessage } from '../types/chatwoot.js';

export type SupportedMediaType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp';

export interface CustomerImage {
  mediaType: SupportedMediaType;
  base64: string;
}

const SUPPORTED_MEDIA_TYPES = new Set<SupportedMediaType>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// Guardrails to keep request size and cost sane. Claude allows up to 10MB per
// image (direct API); we also cap the count so a spammy thread can't blow up
// the payload.
const MAX_IMAGES = 6;
const MAX_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;

function mediaTypeFromExtension(url: string): SupportedMediaType | null {
  const clean = url.split('?')[0]?.toLowerCase() ?? '';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.gif')) return 'image/gif';
  if (clean.endsWith('.webp')) return 'image/webp';
  return null;
}

function normalizeMediaType(raw: string | undefined): SupportedMediaType | null {
  const mt = (raw ?? '').split(';')[0]?.trim().toLowerCase();
  if (mt === 'image/jpg') return 'image/jpeg';
  return mt && SUPPORTED_MEDIA_TYPES.has(mt as SupportedMediaType)
    ? (mt as SupportedMediaType)
    : null;
}

let chatwootHost: string | null | undefined;
function getChatwootHost(): string | null {
  if (chatwootHost !== undefined) return chatwootHost;
  try {
    chatwootHost = new URL(env.chatwootBaseUrl).host;
  } catch {
    chatwootHost = null;
  }
  return chatwootHost;
}

/**
 * Extracts inline image URLs embedded in an incoming email's HTML body. Email
 * clients embed customer photos inline (rather than as separate attachments),
 * and Chatwoot rewrites those into same-host active_storage blob URLs. We only
 * keep those same-host active_storage URLs so signature logos / tracking pixels
 * (hotlinked from external hosts) are ignored.
 */
function extractInlineEmailImageUrls(message: ChatwootMessage): string[] {
  const ca = message.content_attributes as
    | { email?: { html_content?: { full?: unknown } } }
    | undefined;
  const html = ca?.email?.html_content?.full;
  if (typeof html !== 'string' || !html) return [];

  const host = getChatwootHost();
  const urls: string[] = [];
  const imgRegex = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = imgRegex.exec(html)) !== null) {
    const raw = match[1]?.trim();
    if (!raw || raw.startsWith('data:') || raw.startsWith('cid:')) continue;
    try {
      const parsed = new URL(raw);
      if (host && parsed.host !== host) continue;
      if (!parsed.pathname.includes('/rails/active_storage/')) continue;
      urls.push(raw);
    } catch {
      // Not an absolute URL — skip.
    }
  }
  return urls;
}

/**
 * Collects image attachments the customer sent in the current conversation and
 * downloads them as base64 so they can be passed to Claude as image content
 * blocks. Only real (non-private) customer messages (message_type 0) are
 * considered. Best-effort: any image that can't be fetched or isn't a supported
 * type is skipped, never throwing.
 */
export async function gatherCustomerImages(
  messages: ChatwootMessage[],
): Promise<CustomerImage[]> {
  // Collect candidate image URLs from customer messages, oldest first, deduped.
  const urls: string[] = [];
  const seen = new Set<string>();
  const sorted = [...messages].sort((a, b) => a.created_at - b.created_at);

  const pushUrl = (url: string | undefined | null): boolean => {
    if (!url || seen.has(url)) return urls.length < MAX_IMAGES;
    seen.add(url);
    urls.push(url);
    return urls.length < MAX_IMAGES;
  };

  for (const m of sorted) {
    if (m.private || m.message_type !== 0) continue;

    let room = true;
    for (const att of m.attachments ?? []) {
      const isImage =
        att.file_type === 'image' || (att.file_type as unknown) === 0;
      if (!isImage || !att.data_url) continue;
      room = pushUrl(att.data_url);
      if (!room) break;
    }
    if (!room) break;

    // Email channel: images arrive inline in the HTML body, not as attachments.
    for (const url of extractInlineEmailImageUrls(m)) {
      room = pushUrl(url);
      if (!room) break;
    }
    if (!room) break;
  }

  if (urls.length === 0) return [];

  const images: CustomerImage[] = [];
  for (const url of urls) {
    try {
      const res = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: FETCH_TIMEOUT_MS,
        maxContentLength: MAX_BYTES,
        maxBodyLength: MAX_BYTES,
      });

      const buf = Buffer.from(res.data);
      if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) {
        logger.warn('Skipping customer image (empty or too large)', {
          bytes: buf.byteLength,
        });
        continue;
      }

      const mediaType =
        normalizeMediaType(res.headers['content-type'] as string | undefined) ??
        mediaTypeFromExtension(url);
      if (!mediaType) {
        logger.warn('Skipping customer image (unsupported media type)', {
          contentType: res.headers['content-type'],
        });
        continue;
      }

      images.push({ mediaType, base64: buf.toString('base64') });
    } catch (err) {
      logger.warn('Failed to fetch customer image attachment', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return images;
}
