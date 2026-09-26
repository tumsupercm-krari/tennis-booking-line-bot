import { sql } from 'kysely';
import { db } from './db';
import { config } from './config';

export interface Court {
  court_id: number;
  court_code: string;
  court_name: string;
  hourly_rate: number;
}

export async function listActiveCourts(): Promise<Court[]> {
  return db
    .selectFrom('tennis_courts')
    .select(['court_id', 'court_code', 'court_name', 'hourly_rate'])
    .where('is_active', '=', true)
    .orderBy('court_code')
    .execute();
}

/**
 * A "pending_payment" hold that has outlived its payment_deadline no
 * longer blocks the slot. Rather than run a separate background job, every
 * read/write path below calls this first so a stale hold flips to
 * 'expired' (and the slot shows green again) lazily, right when anyone —
 * a customer messaging the bot, or just someone looking at /schedule —
 * next looks.
 */
export async function expireStalePendingBookings(): Promise<void> {
  await db
    .updateTable('tennis_bookings')
    .set({ status: 'expired' })
    .where('status', '=', 'pending_payment')
    .where('payment_deadline', '<', sql<Date>`now()`)
    .execute();
}

function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const endH = Math.floor(total / 60);
  const endM = total % 60;
  return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

function minutesBetween(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}

export function isWithinBusinessHours(startTime: string, durationMinutes: number): boolean {
  const [h] = startTime.split(':').map(Number);
  const endTime = addMinutes(startTime, durationMinutes);
  const [endH, endM] = endTime.split(':').map(Number);
  const endTotalHours = endH + endM / 60;
  return h >= config.business.openHour && endTotalHours <= config.business.closeHour;
}

/**
 * A new booking must start at least config.booking.leadHours from now.
 * `nowBangkokSql` is 'YYYY-MM-DD HH:MM:SS' Asia/Bangkok wall-clock time
 * (see nowInBangkokSql() in webhook.route.ts) — both sides are built with
 * the same +07:00 offset, so the difference is correct regardless.
 */
export function isWithinLeadTime(date: string, startTime: string, nowBangkokSql: string): boolean {
  const requestedAt = new Date(`${date}T${startTime}:00+07:00`);
  const now = new Date(`${nowBangkokSql.replace(' ', 'T')}+07:00`);
  const minutesUntil = (requestedAt.getTime() - now.getTime()) / 60_000;
  return minutesUntil >= config.booking.leadHours * 60;
}

export type SlotStatus = 'available' | 'pending' | 'booked';

async function overlappingStatuses(
  courtId: number,
  date: string,
  startTime: string,
  durationMinutes: number,
): Promise<Set<string>> {
  const endTime = addMinutes(startTime, durationMinutes);
  const rows = await db
    .selectFrom('tennis_bookings')
    .select('status')
    .where('court_id', '=', courtId)
    .where('booking_date', '=', date)
    .where('status', 'in', ['confirmed', 'pending_payment'])
    // overlap test: existing.start < new.end AND existing.end > new.start
    .where('start_time', '<', endTime)
    .where('end_time', '>', startTime)
    .execute();
  return new Set(rows.map((r) => r.status));
}

/** Booked (red) beats pending (yellow) beats available (green) for a single slot. */
export async function getSlotStatus(
  courtId: number,
  date: string,
  startTime: string,
  durationMinutes: number,
): Promise<SlotStatus> {
  const statuses = await overlappingStatuses(courtId, date, startTime, durationMinutes);
  if (statuses.has('confirmed')) return 'booked';
  if (statuses.has('pending_payment')) return 'pending';
  return 'available';
}

/** True only if the slot is free for a brand-new booking — not booked, and not already held (pending payment) by someone else. */
export async function isCourtAvailable(
  courtId: number,
  date: string,
  startTime: string,
  durationMinutes: number,
): Promise<boolean> {
  return (await getSlotStatus(courtId, date, startTime, durationMinutes)) === 'available';
}

/** Among active courts, which ones are free for this slot (used for booking + for "what's available" replies). */
export async function findAvailableCourts(
  date: string,
  startTime: string,
  durationMinutes: number,
): Promise<Court[]> {
  const courts = await listActiveCourts();
  const results: Court[] = [];
  for (const court of courts) {
    if (await isCourtAvailable(court.court_id, date, startTime, durationMinutes)) {
      results.push(court);
    }
  }
  return results;
}

/** Free slots (hour-by-hour) across all courts for a given date — used for "ว่างช่วงไหนบ้าง" queries. */
export async function listOpenSlotsForDate(date: string): Promise<{ court: Court; slots: string[] }[]> {
  const courts = await listActiveCourts();
  const out: { court: Court; slots: string[] }[] = [];
  for (const court of courts) {
    const slots: string[] = [];
    for (let h = config.business.openHour; h < config.business.closeHour; h++) {
      const startTime = `${String(h).padStart(2, '0')}:00`;
      if (await isCourtAvailable(court.court_id, date, startTime, 60)) {
        slots.push(startTime);
      }
    }
    out.push({ court, slots });
  }
  return out;
}

export interface ScheduleSlot {
  time: string; // 'HH:00'
  status: SlotStatus;
}

export interface CourtSchedule {
  court: Court;
  slots: ScheduleSlot[];
}

/**
 * Full hour-by-hour grid for a date, across all active courts — every slot
 * marked available / pending / booked. Powers the public /schedule page.
 */
export async function getDailyScheduleGrid(date: string): Promise<CourtSchedule[]> {
  const courts = await listActiveCourts();
  const out: CourtSchedule[] = [];
  for (const court of courts) {
    const slots: ScheduleSlot[] = [];
    for (let h = config.business.openHour; h < config.business.closeHour; h++) {
      const time = `${String(h).padStart(2, '0')}:00`;
      const status = await getSlotStatus(court.court_id, date, time, 60);
      slots.push({ time, status });
    }
    out.push({ court, slots });
  }
  return out;
}

export interface CreateBookingInput {
  courtId: number;
  lineUserId: string;
  customerName: string | null;
  date: string;
  startTime: string;
  durationMinutes: number;
}

/** Holds the slot as 'pending_payment' rather than confirming it outright — payment now happens separately, via confirmBookingPayment(). */
export async function createPendingBooking(input: CreateBookingInput) {
  const endTime = addMinutes(input.startTime, input.durationMinutes);
  const paymentDeadline = new Date(Date.now() + config.payment.holdMinutes * 60_000);
  return db
    .insertInto('tennis_bookings')
    .values({
      court_id: input.courtId,
      line_user_id: input.lineUserId,
      customer_name: input.customerName,
      booking_date: input.date,
      start_time: input.startTime,
      end_time: endTime,
      status: 'pending_payment',
      payment_deadline: paymentDeadline,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export function expectedAmount(hourlyRate: number, durationMinutes: number): number {
  return Math.round(hourlyRate * (durationMinutes / 60) * 100) / 100;
}

export function formatBaht(amount: number): string {
  return Number.isInteger(amount) ? amount.toString() : amount.toFixed(2);
}

/** The user's most recent still-open payment hold, if any — used to match an incoming slip photo to a booking. */
export async function findPendingBookingForUser(lineUserId: string) {
  const row = await db
    .selectFrom('tennis_bookings as b')
    .innerJoin('tennis_courts as c', 'c.court_id', 'b.court_id')
    .select(['b.booking_id', 'b.booking_date', 'b.start_time', 'b.end_time', 'c.court_name', 'c.hourly_rate'])
    .where('b.line_user_id', '=', lineUserId)
    .where('b.status', '=', 'pending_payment')
    .orderBy('b.created_at', 'desc')
    .executeTakeFirst();
  if (!row) return null;
  return { ...row, duration_minutes: minutesBetween(String(row.start_time), String(row.end_time)) };
}

export async function confirmBookingPayment(
  bookingId: number,
  slipAmount: number | null,
  slipNote: string | null,
): Promise<void> {
  await db
    .updateTable('tennis_bookings')
    .set({ status: 'confirmed', verified_at: new Date(), slip_amount: slipAmount, slip_note: slipNote })
    .where('booking_id', '=', bookingId)
    .execute();
}

/**
 * The user's soonest upcoming booking (confirmed OR still pending payment,
 * today or later) — used for the "cancel" intent, since the demo doesn't
 * ask the user to specify which booking.
 *
 * `nowBangkokSql` must be the current Asia/Bangkok wall-clock time as
 * 'YYYY-MM-DD HH:MM:SS' (see nowInBangkokSql() in webhook.route.ts). We compare
 * against that instead of Postgres's own now() because now() is a
 * TIMESTAMPTZ evaluated in the DB session's timezone (Railway defaults to
 * UTC) — comparing it against booking_date/end_time (which are always
 * entered and meant as Bangkok wall-clock values) would silently shift
 * "upcoming" by 7 hours.
 */
export async function findUpcomingBookingForUser(lineUserId: string, nowBangkokSql: string) {
  return db
    .selectFrom('tennis_bookings as b')
    .innerJoin('tennis_courts as c', 'c.court_id', 'b.court_id')
    .select(['b.booking_id', 'b.booking_date', 'b.start_time', 'b.end_time', 'c.court_name', 'b.status'])
    .where('b.line_user_id', '=', lineUserId)
    .where('b.status', 'in', ['confirmed', 'pending_payment'])
    .where(sql<boolean>`(b.booking_date + b.end_time::interval) >= ${nowBangkokSql}::timestamp`)
    .orderBy('b.booking_date')
    .orderBy('b.start_time')
    .executeTakeFirst();
}

export async function cancelBooking(bookingId: number): Promise<void> {
  await db
    .updateTable('tennis_bookings')
    .set({ status: 'cancelled', cancelled_at: new Date() })
    .where('booking_id', '=', bookingId)
    .execute();
}

export function formatThaiDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00+07:00`);
  return d.toLocaleDateString('th-TH-u-ca-gregory', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Asia/Bangkok',
  });
}
