import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyLineSignature, replyMessage, getUserProfile } from './line.service';
import { extractBookingIntent, type BookingIntent } from './claude.service';
import {
  findAvailableCourts,
  createBooking,
  isWithinBusinessHours,
  listOpenSlotsForDate,
  findUpcomingBookingForUser,
  cancelBooking,
  formatThaiDate,
} from './booking.service';
import { db } from './db';
import { config } from './config';

interface LineWebhookEvent {
  type: string;
  replyToken?: string;
  source: { type: string; userId?: string };
  message?: { type: string; text?: string };
}

interface LineWebhookBody {
  destination: string;
  events: LineWebhookEvent[];
}

/**
 * The current wall-clock date/time in Asia/Bangkok, as 'YYYY-MM-DD HH:MM:SS'.
 * The server itself may run in any timezone (Railway defaults to UTC), so
 * this always reasons about "now" in Bangkok — where every user is —
 * built directly from Intl parts rather than any Date-round-tripping trick,
 * to avoid subtle off-by-N-hours bugs.
 */
function nowInBangkokSql(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.business.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

async function logMessage(lineUserId: string, direction: 'in' | 'out', text: string, parsed?: unknown) {
  await db
    .insertInto('tennis_conversation_log')
    .values({ line_user_id: lineUserId, direction, message_text: text, parsed_intent: parsed ?? null })
    .execute();
}

async function handleTextMessage(lineUserId: string, replyToken: string, text: string): Promise<void> {
  await logMessage(lineUserId, 'in', text);

  const nowBangkok = nowInBangkokSql();
  const intent: BookingIntent = await extractBookingIntent(text, nowBangkok);
  await logMessage(lineUserId, 'in', `[parsed] ${text}`, intent);

  const reply = await buildReplyForIntent(lineUserId, intent, nowBangkok);
  await logMessage(lineUserId, 'out', reply);
  await replyMessage(replyToken, [{ type: 'text', text: reply }]);
}

async function buildReplyForIntent(lineUserId: string, intent: BookingIntent, nowBangkokSql: string): Promise<string> {
  switch (intent.intent) {
    case 'greeting':
      return (
        'สวัสดีครับ 🎾 ผมเป็นบอทจองคอร์ตเทนนิส (ตัวอย่าง Demo)\n' +
        'พิมพ์บอกวัน-เวลาที่ต้องการได้เลยครับ เช่น "จองคอร์ตพรุ่งนี้ 18:00 ชั่วโมงนึง"'
      );

    case 'unclear':
      return intent.clarification_needed ?? 'รบกวนบอกวัน เวลา และระยะเวลาที่ต้องการจองอีกครั้งได้ไหมครับ';

    case 'check_availability': {
      if (!intent.date) {
        return 'อยากทราบช่วงว่างวันไหนครับ บอกวันที่มาได้เลยครับ เช่น "พรุ่งนี้" หรือ "เสาร์นี้"';
      }
      const openSlots = await listOpenSlotsForDate(intent.date);
      const dateLabel = formatThaiDate(intent.date);
      const lines = openSlots
        .filter((c) => c.slots.length > 0)
        .map((c) => `${c.court_name}: ${c.slots.join(', ')}`);
      if (lines.length === 0) {
        return `วัน${dateLabel} เต็มทุกคอร์ตแล้วครับ ลองเลือกวันอื่นดูไหมครับ`;
      }
      return `ช่วงที่ว่างวัน${dateLabel}\n${lines.join('\n')}`;
    }

    case 'book': {
      if (!intent.date || !intent.start_time) {
        return 'รบกวนบอกวันและเวลาที่ต้องการจองด้วยครับ เช่น "จองคอร์ตพรุ่งนี้ 18:00 ชั่วโมงนึง"';
      }
      const duration = intent.duration_minutes ?? 60;
      if (!isWithinBusinessHours(intent.start_time, duration)) {
        return `ขอโทษครับ เปิดให้บริการเวลา ${String(config.business.openHour).padStart(2, '0')}:00–${String(config.business.closeHour).padStart(2, '0')}:00 รบกวนเลือกเวลาในช่วงนี้ครับ`;
      }

      const available = await findAvailableCourts(intent.date, intent.start_time, duration);
      if (available.length === 0) {
        return `ขอโทษครับ วัน${formatThaiDate(intent.date)} เวลา ${intent.start_time} เต็มทุกคอร์ตแล้ว ลองเวลาอื่นดูไหมครับ`;
      }

      const preferred =
        intent.court_preference && intent.court_preference !== 'any'
          ? available.find((c) => c.court_code === intent.court_preference)
          : undefined;

      if (intent.court_preference && intent.court_preference !== 'any' && !preferred) {
        return `ขอโทษครับ คอร์ต ${intent.court_preference} ไม่ว่างช่วงเวลานั้น แต่คอร์ต ${available.map((c) => c.court_code).join(', ')} ว่างครับ ต้องการจองคอร์ตไหนครับ`;
      }

      const chosenCourt = preferred ?? available[0];
      const profile = await getUserProfile(lineUserId);
      const booking = await createBooking({
        courtId: chosenCourt.court_id,
        lineUserId,
        customerName: profile?.displayName ?? null,
        date: intent.date,
        startTime: intent.start_time,
        durationMinutes: duration,
      });

      const durationLabel = duration === 60 ? '1 ชั่วโมง' : `${duration} นาที`;
      return (
        `จองสำเร็จครับ ✅\n` +
        `${chosenCourt.court_name}\n` +
        `วัน${formatThaiDate(intent.date)} เวลา ${intent.start_time} น. (${durationLabel})\n` +
        `รหัสการจอง #${booking.booking_id}\n\n` +
        `พิมพ์ "ยกเลิกการจอง" ได้ถ้าต้องการยกเลิกครับ`
      );
    }

    case 'cancel': {
      const upcoming = await findUpcomingBookingForUser(lineUserId, nowBangkokSql);
      if (!upcoming) {
        return 'ไม่พบรายการจองที่กำลังจะถึงของคุณครับ';
      }
      await cancelBooking(upcoming.booking_id);
      return (
        `ยกเลิกการจองเรียบร้อยครับ ❌\n` +
        `${upcoming.court_name} วัน${formatThaiDate(String(upcoming.booking_date))} เวลา ${upcoming.start_time} น.`
      );
    }

    default:
      return 'รบกวนบอกวัน เวลา และระยะเวลาที่ต้องการจองอีกครั้งได้ไหมครับ';
  }
}

export async function webhookRoutes(app: FastifyInstance) {
  // app.ts registers a custom content-type parser that stashes the raw
  // request body on request.rawBody before JSON-parsing it — LINE's
  // signature is computed over those exact raw bytes, so verification
  // below reads that instead of re-serializing request.body.
  app.post('/webhook', async (request: FastifyRequest, reply: FastifyReply) => {
      const rawBody = request.rawBody;
      const signature = request.headers['x-line-signature'] as string | undefined;

      if (!rawBody || !verifyLineSignature(rawBody, signature)) {
        reply.code(401).send({ error: 'invalid signature' });
        return;
      }

      const body = JSON.parse(rawBody) as LineWebhookBody;

      // LINE requires a fast 200 response; do NOT make it wait for the
      // Claude call + DB work. Acknowledge immediately, then process.
      reply.code(200).send({ status: 'ok' });

      for (const event of body.events) {
        if (event.type !== 'message' || event.message?.type !== 'text') continue;
        const lineUserId = event.source.userId;
        const replyToken = event.replyToken;
        if (!lineUserId || !replyToken) continue;

        try {
          await handleTextMessage(lineUserId, replyToken, event.message.text ?? '');
        } catch (err) {
          request.log.error(err, 'Failed to handle LINE message');
        }
      }
  });
}
