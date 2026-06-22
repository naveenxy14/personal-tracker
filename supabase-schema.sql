-- ============================================================
--  FinTrack – Supabase Schema  (safe to re-run anytime)
--  Run this entire file in: Supabase Dashboard → SQL Editor
-- ============================================================

-- ── 1. TABLES ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS profiles (
    id                  UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
    theme               TEXT    DEFAULT 'dark',
    currency            TEXT    DEFAULT 'INR',
    monthly_budget      NUMERIC DEFAULT 50000,
    fin_month_start_day INTEGER DEFAULT 22,
    has_seeded          BOOLEAN DEFAULT false,
    payment_methods     JSONB   DEFAULT '["Cash","UPI","Google Pay","PhonePe","Credit Card","Debit Card","Net Banking","Bank Transfer","UPI Lite"]'::jsonb,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS incomes (
    id         BIGSERIAL PRIMARY KEY,
    user_id    UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
    amount     NUMERIC NOT NULL,
    date       DATE    NOT NULL,
    source     TEXT,
    category   TEXT,
    notes      TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS expenses (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
    amount      NUMERIC NOT NULL,
    date        DATE    NOT NULL,
    time        TEXT,
    category    TEXT,
    description TEXT,
    comments    TEXT,
    paid_using  TEXT    DEFAULT 'Cash',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budgets (
    id       BIGSERIAL PRIMARY KEY,
    user_id  UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
    category TEXT    NOT NULL,
    amount   NUMERIC NOT NULL,
    UNIQUE(user_id, category)
);

CREATE TABLE IF NOT EXISTS payment_budgets (
    id       BIGSERIAL PRIMARY KEY,
    user_id  UUID    REFERENCES auth.users ON DELETE CASCADE NOT NULL,
    method   TEXT    NOT NULL,
    amount   NUMERIC NOT NULL,
    UNIQUE(user_id, method)
);

-- Add new columns to existing tables (safe if columns already exist)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS has_seeded         BOOLEAN DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS payment_methods    JSONB   DEFAULT '["Cash","UPI","Google Pay","PhonePe","Credit Card","Debit Card","Net Banking","Bank Transfer","UPI Lite"]'::jsonb;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS paid_using         TEXT    DEFAULT 'Cash';

-- Mark all existing users as already seeded so they never get sample data on login
UPDATE profiles SET has_seeded = true WHERE has_seeded = false OR has_seeded IS NULL;

-- ── 2. ROW LEVEL SECURITY ──────────────────────────────────────

ALTER TABLE profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE incomes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses        ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets         ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_budgets ENABLE ROW LEVEL SECURITY;

-- Drop policies before recreating (safe re-run)
DROP POLICY IF EXISTS "users_own_profile"          ON profiles;
DROP POLICY IF EXISTS "users_own_incomes"          ON incomes;
DROP POLICY IF EXISTS "users_own_expenses"         ON expenses;
DROP POLICY IF EXISTS "users_own_budgets"          ON budgets;
DROP POLICY IF EXISTS "users_own_payment_budgets"  ON payment_budgets;

CREATE POLICY "users_own_profile"         ON profiles        FOR ALL USING (auth.uid() = id)      WITH CHECK (auth.uid() = id);
CREATE POLICY "users_own_incomes"         ON incomes         FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users_own_expenses"        ON expenses        FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users_own_budgets"         ON budgets         FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users_own_payment_budgets" ON payment_budgets FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ── 3. INDEXES ─────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_incomes_user_date      ON incomes         (user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_user_date     ON expenses        (user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_budgets_user           ON budgets         (user_id);
CREATE INDEX IF NOT EXISTS idx_payment_budgets_user   ON payment_budgets (user_id);

-- ── 4. AUTO-CREATE PROFILE ON SIGNUP ──────────────────────────

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.profiles (id) VALUES (NEW.id)
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();
