-- ============================================================
--  FinTrack – Supabase Schema
--  Run this entire file once in: Supabase Dashboard → SQL Editor
-- ============================================================

-- 1. TABLES

CREATE TABLE IF NOT EXISTS profiles (
    id                  UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
    theme               TEXT    DEFAULT 'dark',
    currency            TEXT    DEFAULT 'INR',
    monthly_budget      NUMERIC DEFAULT 50000,
    fin_month_start_day INTEGER DEFAULT 22,
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
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budgets (
    id       BIGSERIAL PRIMARY KEY,
    user_id  UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
    category TEXT    NOT NULL,
    amount   NUMERIC NOT NULL,
    UNIQUE(user_id, category)
);

-- 2. ROW LEVEL SECURITY

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE incomes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_profile"  ON profiles FOR ALL USING (auth.uid() = id)      WITH CHECK (auth.uid() = id);
CREATE POLICY "users_own_incomes"  ON incomes  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users_own_expenses" ON expenses FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users_own_budgets"  ON budgets  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- 3. INDEXES (performance)

CREATE INDEX IF NOT EXISTS idx_incomes_user_date  ON incomes  (user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses (user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_budgets_user       ON budgets  (user_id);

-- 4. AUTO-CREATE PROFILE ON SIGNUP

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO profiles (id) VALUES (NEW.id)
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();
