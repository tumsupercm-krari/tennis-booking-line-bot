import Anthropic from '@anthropic-ai/sdk';
import { config } from './config';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

export interface BookingIntent {
  intent: 'book' | 'cancel' | 'check_availability' | 'greeting' | 'unclear';
  date: string | null; // 'YYYY-MM-DD', resolved from relative words like "พรุ่งนี้"
  start_time: string | null; // 'HH:MM', 24-hour
  duration_minutes: number | null;
  court_preference: 'A' | 'B' | 'any' | null;
  clarification_needed: string | null; // what to ask the user, in Thai, if intent is 'unclear'
}

// A tool definition forces Claude to answer in this exact shape instead of
// free-form prose, which is what makes this reliable enough to run
// unattended in a webhook (no fragile "please output only JSON" prompting).
const EXTRACT_TOOL: Anthropic.Tool = {
  name: 'extract_booking_intent',
  description: 'Extract structured tennis-court booking intent from a Thai (or English) message.',
  input_schema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: ['book', 'cancel', 'check_availability', 'greeting', 'unclear'],
        description:
          "'book' = wants to reserve a court, 'cancel' = wants to cancel an existing booking, " +
          "'check_availability' = asking what's free without committing to book, " +
          "'greeting' = hello/thanks/small talk, 'unclear' = a booking-related message missing key info",
      },
      date: {
        type: ['string', 'null'],
        description: "Resolved calendar date as 'YYYY-MM-DD', using the 'today' date given in the prompt to resolve words like พรุ่งนี้/มะรืนนี้/วันเสาร์นี้. Null if no date mentioned or not applicable.",
      },
      start_time: {
        type: ['string', 'null'],
        description: "Start time as 24-hour 'HH:MM', e.g. '18:00' for 6 โมงเย็น. Null if not mentioned.",
      },
      duration_minutes: {
        type: ['number', 'null'],
        description: 'Requested duration in minutes (e.g. 1 ชั่วโมง = 60, ชั่วโมงครึ่ง = 90). Default to 60 if a booking is clearly wanted but no duration is stated.',
      },
      court_preference: {
        type: ['string', 'null'],
        enum: ['A', 'B', 'any', null],
        description: "'A' or 'B' if a specific court is named/preferred, 'any' if no preference stated but intent is book/check_availability.",
      },
      clarification_needed: {
        type: ['string', 'null'],
        description: 'If intent is "unclear", a short, friendly Thai question asking for exactly the missing piece (date, time, etc). Null otherwise.',
      },
    },
    required: ['intent', 'date', 'start_time', 'duration_minutes', 'court_preference', 'clarification_needed'],
  },
};

/**
 * Turn a raw Thai chat message into structured booking intent.
 * `nowBangkok` is the current wall-clock date/time in Asia/Bangkok
 * ('YYYY-MM-DD HH:MM:SS'), passed in explicitly so relative words like
 * "พรุ่งนี้" (tomorrow) resolve correctly no matter when this runs.
 */
export async function extractBookingIntent(userMessage: string, nowBangkok: string): Promise<BookingIntent> {
  const response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 512,
    system:
      `You are the natural-language understanding layer for a Thai tennis-court booking LINE bot. ` +
      `The current date/time in Asia/Bangkok (UTC+7) is ${nowBangkok}. There are two courts, "A" and "B". ` +
      `Business hours are 06:00–22:00 daily. Always call the extract_booking_intent tool exactly once — never reply in plain text.`,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: 'extract_booking_intent' },
    messages: [{ role: 'user', content: userMessage }],
  });

  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
  if (!toolUse) {
    // Extremely unlikely given tool_choice is forced, but fail safe rather than crash the webhook.
    return {
      intent: 'unclear',
      date: null,
      start_time: null,
      duration_minutes: null,
      court_preference: null,
      clarification_needed: 'ขอโทษครับ ช่วยพิมพ์อีกครั้งได้ไหมครับ เช่น "จองคอร์ตพรุ่งนี้ 18:00 ชั่วโมงนึง"',
    };
  }
  return toolUse.input as BookingIntent;
}

export interface SlipReading {
  looks_like_transfer_slip: boolean;
  transfer_looks_recent: boolean;
  amount_thb: number | null;
  bank_name: string | null;
  transferred_at_text: string | null;
}

const SLIP_TOOL: Anthropic.Tool = {
  name: 'read_payment_slip',
  description: 'Extract what a Thai bank-transfer slip image shows, without judging whether the transfer is genuine.',
  input_schema: {
    type: 'object',
    properties: {
      looks_like_transfer_slip: {
        type: 'boolean',
        description: 'True if the image resembles a bank/mobile-banking transfer confirmation screen or printed slip at all.',
      },
      transfer_looks_recent: {
        type: 'boolean',
        description:
          'True only if the date/time printed on the slip falls within the recent window stated in the prompt (allowing a little clock skew). ' +
          'False if the slip is clearly older than that window, dated in the future, or has no readable date/time at all.',
      },
      amount_thb: {
        type: ['number', 'null'],
        description: 'The transferred amount in Thai Baht as printed on the slip (e.g. 400 or 400.00). Null if unreadable or not a slip.',
      },
      bank_name: {
        type: ['string', 'null'],
        description: 'Bank or app name shown on the slip (e.g. "กสิกรไทย", "SCB", "PromptPay"). Null if not visible.',
      },
      transferred_at_text: {
        type: ['string', 'null'],
        description: 'The date/time text printed on the slip, exactly as shown. Null if not visible.',
      },
    },
    required: ['looks_like_transfer_slip', 'transfer_looks_recent', 'amount_thb', 'bank_name', 'transferred_at_text'],
  },
};

const SLIP_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type SlipMediaType = (typeof SLIP_MEDIA_TYPES)[number];

/**
 * Reads a payment-slip image with Claude's vision and reports what it shows.
 *
 * IMPORTANT: this is a best-effort OCR read, NOT real payment verification.
 * It only reports what pixels are on the image, which a customer could in
 * principle edit before sending — there is no check against the bank's
 * actual records. This demo only gates on (a) it looking like a transfer
 * slip at all and (b) its printed date/time being recent — it does not
 * check the amount. Good enough for a low-stakes demo; a real business
 * handling real money should verify against an actual bank / slip
 * -verification API instead.
 *
 * `nowBangkok` is 'YYYY-MM-DD HH:MM:SS' Asia/Bangkok wall-clock time, used
 * so Claude can judge whether the slip's printed timestamp is recent.
 */
export async function readPaymentSlip(imageBase64: string, contentType: string, nowBangkok: string): Promise<SlipReading> {
  const mediaType: SlipMediaType = (SLIP_MEDIA_TYPES as readonly string[]).includes(contentType)
    ? (contentType as SlipMediaType)
    : 'image/jpeg';

  // A little slack beyond the payment hold window, for clock skew between
  // the customer's phone/bank app and this server.
  const recentWindowMinutes = config.payment.holdMinutes + 10;

  const response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 512,
    system:
      'You read Thai bank transfer slip images (screenshots or photos) and report exactly what they show. ' +
      `The current date/time in Asia/Bangkok (UTC+7) is ${nowBangkok}. Set transfer_looks_recent to true only if the ` +
      `slip's printed date/time is within about ${recentWindowMinutes} minutes before that current time. ` +
      'Call read_payment_slip exactly once. Do not guess values that are not visibly printed on the image.',
    tools: [SLIP_TOOL],
    tool_choice: { type: 'tool', name: 'read_payment_slip' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: 'อ่านสลิปโอนเงินนี้ครับ' },
        ],
      },
    ],
  });

  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
  if (!toolUse) {
    return {
      looks_like_transfer_slip: false,
      transfer_looks_recent: false,
      amount_thb: null,
      bank_name: null,
      transferred_at_text: null,
    };
  }
  return toolUse.input as SlipReading;
}
