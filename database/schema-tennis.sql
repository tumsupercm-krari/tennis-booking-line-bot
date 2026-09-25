-- =====================================================================
-- Tennis Court Booking Demo — database schema
-- Runs against the SAME Postgres instance as the Orbit ERP (krit-kaset
-- ERP), but in its own set of tables, all prefixed "tennis_" so there
-- is zero chance of colliding with the ERP's tables.
--
-- This is a portfolio DEMO project (not a real business). Keep it
-- simple: 2 courts, whole-hour or half-hour bookings, one status
-- lifecycle (confirmed -> cancelled).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Courts
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tennis_courts (
    court_id     SERIAL PRIMARY KEY,
    court_code   TEXT NOT NULL UNIQUE,      -- 'A', 'B'
    court_name   TEXT NOT NULL,             -- 'คอร์ต A', 'คอร์ต B'
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tennis_courts (court_code, court_name) VALUES
    ('A', 'คอร์ต A'),
    ('B', 'คอร์ต B')
ON CONFLICT (court_code) DO NOTHING;

-- ---------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tennis_bookings (
    booking_id          BIGSERIAL PRIMARY KEY,
    court_id            INTEGER NOT NULL REFERENCES tennis_courts(court_id),
    line_user_id        TEXT NOT NULL,          -- LINE's opaque user id (source.userId)
    customer_name       TEXT,                    -- LINE display name at booking time
    booking_date        DATE NOT NULL,
    start_time          TIME NOT NULL,
    end_time             TIME NOT NULL,
    status               TEXT NOT NULL DEFAULT 'confirmed'
                            CHECK (status IN ('confirmed', 'cancelled')),
    notes                TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    cancelled_at         TIMESTAMPTZ,
    CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_tennis_bookings_date_court
    ON tennis_bookings (booking_date, court_id)
    WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS idx_tennis_bookings_line_user
    ON tennis_bookings (line_user_id, booking_date)
    WHERE status = 'confirmed';

-- ---------------------------------------------------------------------
-- Conversation log — every inbound message + how Claude parsed it.
-- Not required for the bot to function, but great for a portfolio demo:
-- it lets you SHOW a recruiter/client "here's the raw Thai message and
-- here's the structured intent the AI extracted from it."
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tennis_conversation_log (
    log_id           BIGSERIAL PRIMARY KEY,
    line_user_id     TEXT NOT NULL,
    direction        TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    message_text     TEXT NOT NULL,
    parsed_intent    JSONB,               -- only set on 'in' rows
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tennis_conv_log_user
    ON tennis_conversation_log (line_user_id, created_at);
