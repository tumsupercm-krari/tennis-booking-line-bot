import crypto from 'node:crypto';
import { config } from './config';

const LINE_API_BASE = 'https://api.line.me/v2/bot';

/**
 * Verify that a webhook request really came from LINE.
 * LINE signs the raw request body with the Channel Secret (HMAC-SHA256,
 * base64-encoded) and sends it in the `x-line-signature` header.
 * MUST be checked against the raw (unparsed) body bytes, not re-serialized
 * JSON, or the signature will never match.
 */
export function verifyLineSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac('sha256', config.line.channelSecret)
    .update(rawBody)
    .digest('base64');
  // timingSafeEqual requires equal-length buffers
  const expectedBuf = Buffer.from(expected);
  const givenBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== givenBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, givenBuf);
}

type LineMessage =
  | { type: 'text'; text: string }
  | Record<string, unknown>; // allows Flex Messages etc. later

async function lineApiCall(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${LINE_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.line.channelAccessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LINE API ${path} failed: ${res.status} ${errText}`);
  }
}

/** Reply to a specific incoming message (free, but only works once per replyToken and within its short expiry). */
export async function replyMessage(replyToken: string, messages: LineMessage[]): Promise<void> {
  await lineApiCall('/message/reply', { replyToken, messages });
}

/** Push a message to a user outside of a reply context (e.g. a proactive reminder). Counts against the free monthly push quota. */
export async function pushMessage(lineUserId: string, messages: LineMessage[]): Promise<void> {
  await lineApiCall('/message/push', { to: lineUserId, messages });
}

interface LineProfile {
  displayName: string;
  userId: string;
  pictureUrl?: string;
}

/** Look up a user's display name so replies can be personalized ("จองให้คุณต้อมเรียบร้อยครับ"). */
export async function getUserProfile(lineUserId: string): Promise<LineProfile | null> {
  const res = await fetch(`${LINE_API_BASE}/profile/${lineUserId}`, {
    headers: { Authorization: `Bearer ${config.line.channelAccessToken}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as LineProfile;
}
