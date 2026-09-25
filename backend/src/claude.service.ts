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
