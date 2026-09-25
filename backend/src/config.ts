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
};
