import type { Generated, ColumnType } from 'kysely';

export interface CourtsTable {
  court_id: Generated<number>;
  court_code: string;
  court_name: string;
  hourly_rate: number;
  is_active: boolean;
  created_at: Generated<Date>;
}

export interface BookingsTable {
  booking_id: Generated<number>;
  court_id: number;
  line_user_id: string;
  customer_name: string | null;
  booking_date: ColumnType<string, string, string>; // 'YYYY-MM-DD'
  start_time: ColumnType<string, string, string>; // 'HH:MM:SS'
  end_time: ColumnType<string, string, string>;
  status: 'confirmed' | 'cancelled' | 'pending_payment' | 'expired';
  notes: string | null;
  payment_deadline: Date | null;
  slip_amount: number | null;
  slip_note: string | null;
  verified_at: Date | null;
  created_at: Generated<Date>;
  cancelled_at: Date | null;
}

export interface ConversationLogTable {
  log_id: Generated<number>;
  line_user_id: string;
  direction: 'in' | 'out';
  message_text: string;
  parsed_intent: unknown | null;
  created_at: Generated<Date>;
}

export interface Database {
  tennis_courts: CourtsTable;
  tennis_bookings: BookingsTable;
  tennis_conversation_log: ConversationLogTable;
}
