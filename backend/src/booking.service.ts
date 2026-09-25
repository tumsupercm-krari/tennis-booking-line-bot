import { sql } from 'kysely';
import { db } from './db';
import { config } from './config';

export interface Court {
  court_id: number;
  court_code: string;
  court_name: string;
}

export async function listActiveCourts(): Promise<Court[]> {
  return db
    .selectFrom('tennis_courts')
    .select(['court_id', 'court_code', 'court_name'])
    .where('is_active', '=', true)
    .orderBy('court_code')
    .execute();
}

function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const endH = Math.floor(total / 60);
  const endM = total % 60;
  return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

export function isWithinBusinessHours(startTime: string, durationMinutes: number): boolean {
  const [h] = startTime.split(':').map(Number);
  const endTime = addMinutes(startTime, durationMinutes);
  const [endH, endM] = endTime.split(':').map(Number);
  const endTotalHours = endH + endM / 60;
  return h >= config.business.openHour && endTotalHours <= config.business.closeHour;
}

/** True if `courtId` is free for [startTime, startTime+durationMinutes) on `date`. */
export async function isCourtAvailable(
  courtId: number,
  date: string,
  startTime: string,
  durationMinutes: number,
): Promise<boolean> {
  const endTime = addMinutes(startTime, durationMinutes);
  const conflict = await db
    .selectFrom('tennis_bookings')
    .select('booking_id')
    .where('court_id', '=', courtId)
    .where('booking_date', '=', date)
    .where('status', '=', 'confirmed')
    // overlap test: existing.start < new.end AND existing.end > new.start
    .where('start_time', '<', endTime)
    .where('end_time', '>', startTime)
    .executeTakeFirst();
  return !conflict;
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
  available: boolean;
}

export interface CourtSchedule {
  court: Court;
  slots: ScheduleSlot[];
}

/**
 * Full hour-by-hour grid for a date, across all active courts — every slot
 * marked available or not (unlike listOpenSlotsForDate, which only lists
 * the open ones). Powers the public /schedule page.
 */
export async function getDailyScheduleGrid(date: string): Promise<CourtSchedule[]> {
  const courts = await listActiveCourts();
  const out: CourtSchedule[] = [];
  for (const court of courts) {
    const slots: ScheduleSlot[] = [];
    for (let h = config.business.openHour; h < config.business.closeHour; h++) {
      const time = `${String(h).padStart(2, '0')}:00`;
      const available = await isCourtAvailable(court.court_id, date, time, 60);
      slots.push({ time, available });
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

export async function createBooking(input: CreateBookingInput) {
  const endTime = addMinutes(input.startTime, input.durationMinutes);
  return db
    .insertInto('tennis_bookings')
    .values({
      court_id: input.courtId,
      line_user_id: input.lineUserId,
      customer_name: input.customerName,
      booking_date: input.date,
      start_time: input.startTime,
      end_time: endTime,
      status: 'confirmed',
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * The user's soonest upcoming confirmed booking (today or later) — used for
 * the "cancel" intent, since the demo doesn't ask the user to specify which
 * booking.
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
    .select(['b.booking_id', 'b.booking_date', 'b.start_time', 'b.end_time', 'c.court_name'])
    .where('b.line_user_id', '=', lineUserId)
    .where('b.status', '=', 'confirmed')
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
