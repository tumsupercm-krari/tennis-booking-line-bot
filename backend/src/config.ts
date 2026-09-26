// Central place for all environment variables this service needs.
// Fails fast at boot if anything required is missing, rather than
// failing confusingly later when a webhook actually arrives.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),

  // Same Postgres instance as the Orbit ERP — reuse its connection string.
  databaseUrl: required('DATABASE_URL'),

  line: {
    channelSecret: required('LINE_CHANNEL_SECRET'),
    channelAccessToken: required('LINE_CHANNEL_ACCESS_TOKEN'),
  },

  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    // A small/cheap model is plenty for this NLU-extraction task.
    model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
  },

  business: {
    openHour: 6, // 06:00
    closeHour: 22, // 22:00 (last bookable end time)
    timeZone: 'Asia/Bangkok',
  },

  // Where customers transfer money to, shown in the booking confirmation
  // message. Required so the service fails fast at boot if these were
  // never set, rather than sending a broken "โอนไปที่: undefined" message.
  payment: {
    bankName: required('PAYMENT_BANK_NAME'),
    accountName: required('PAYMENT_ACCOUNT_NAME'),
    accountNumber: required('PAYMENT_ACCOUNT_NUMBER'),
    // How long an unpaid booking holds the slot before it's released back
    // to available automatically.
    holdMinutes: Number(process.env.PAYMENT_HOLD_MINUTES ?? 15),
  },

  booking: {
    // Minimum lead time before the requested start time.
    leadHours: Number(process.env.BOOKING_LEAD_HOURS ?? 2),
  },
};
