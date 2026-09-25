import { Pool, types as pgTypes } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { config } from './config';
import type { Database } from './types';

// Same BIGINT-as-string caveat as the ERP backend: node-postgres returns
// BIGINT (oid 20) columns as JS strings unless a parser is registered.
// booking_id is BIGSERIAL, so register a parser that turns it into a
// real number here (unlike the ERP, this service has no IDs large
// enough to lose precision as a Number, so this is safe and simpler
// than comparing strings everywhere on the frontend/reply-message side).
const BIGINT_OID = 20;
const NUMERIC_OID = 1700;
const DATE_OID = 1082;
pgTypes.setTypeParser(BIGINT_OID, (value) => parseInt(value, 10));
pgTypes.setTypeParser(NUMERIC_OID, (value) => (value === null ? null : parseFloat(value)));
// Keep DATE as a plain 'YYYY-MM-DD' string — pg's default parser turns it
// into a JS Date (midnight UTC), which shifts to the wrong calendar day
// once formatted in Asia/Bangkok (UTC+7). booking_date is compared and
// formatted as a string everywhere in this service, so leave it alone.
pgTypes.setTypeParser(DATE_OID, (value) => value);

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 5,
});

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
});
