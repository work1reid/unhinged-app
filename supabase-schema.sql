-- =============================================================================
-- UNHINGED AI - SUPABASE SCHEMA
-- =============================================================================
-- Run this in Supabase SQL Editor (https://supabase.com/dashboard)
-- Go to: SQL Editor > New Query > Paste this > Run
--
-- SAFETY: This script uses IF NOT EXISTS and safe patterns.
-- It will NOT delete existing data. Safe to run multiple times.
--
-- WARNING: NEVER use DROP TABLE or DROP POLICY without backing up first!
-- =============================================================================


-- =============================================================================
-- GENERATIONS TABLE (stores opener history)
-- =============================================================================

CREATE TABLE IF NOT EXISTS generations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    match_name TEXT,
    openers JSONB NOT NULL,
    mode TEXT,
    analysis JSONB,
    feedback TEXT,
    feedback_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add columns if they don't exist (safe for existing tables)
ALTER TABLE generations ADD COLUMN IF NOT EXISTS analysis JSONB;
ALTER TABLE generations ADD COLUMN IF NOT EXISTS feedback TEXT;
ALTER TABLE generations ADD COLUMN IF NOT EXISTS feedback_at TIMESTAMPTZ;
ALTER TABLE generations ADD COLUMN IF NOT EXISTS winning_opener INTEGER;

-- Indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_generations_user_id ON generations(user_id);
CREATE INDEX IF NOT EXISTS idx_generations_created_at ON generations(created_at DESC);

-- Enable Row Level Security
ALTER TABLE generations ENABLE ROW LEVEL SECURITY;

-- RLS Policies (using DO block to check if policy exists first)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'generations' AND policyname = 'Users can view own generations') THEN
        CREATE POLICY "Users can view own generations" ON generations FOR SELECT USING (auth.uid() = user_id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'generations' AND policyname = 'Users can insert own generations') THEN
        CREATE POLICY "Users can insert own generations" ON generations FOR INSERT WITH CHECK (auth.uid() = user_id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'generations' AND policyname = 'Users can delete own generations') THEN
        CREATE POLICY "Users can delete own generations" ON generations FOR DELETE USING (auth.uid() = user_id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'generations' AND policyname = 'Users can update own generations') THEN
        CREATE POLICY "Users can update own generations" ON generations FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
    END IF;
END $$;


-- =============================================================================
-- CREDITS TABLE (stores user credit balances)
-- =============================================================================

CREATE TABLE IF NOT EXISTS credits (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    balance INTEGER DEFAULT 0,
    total_purchased INTEGER DEFAULT 0,
    last_weekly_bonus TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add columns if they don't exist
ALTER TABLE credits ADD COLUMN IF NOT EXISTS last_weekly_bonus TIMESTAMPTZ;

-- Enable RLS
ALTER TABLE credits ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'credits' AND policyname = 'Users can view own credits') THEN
        CREATE POLICY "Users can view own credits" ON credits FOR SELECT USING (auth.uid() = id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'credits' AND policyname = 'Users can update own credits') THEN
        CREATE POLICY "Users can update own credits" ON credits FOR UPDATE USING (auth.uid() = id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'credits' AND policyname = 'Service role full access to credits') THEN
        CREATE POLICY "Service role full access to credits" ON credits FOR ALL USING (auth.role() = 'service_role');
    END IF;
END $$;


-- =============================================================================
-- PAYMENTS TABLE (stores payment history for idempotency)
-- =============================================================================

CREATE TABLE IF NOT EXISTS payments (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    stripe_payment_id TEXT NOT NULL UNIQUE,
    amount INTEGER NOT NULL,
    credits INTEGER NOT NULL,
    type TEXT DEFAULT 'one_time',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add columns if they don't exist
ALTER TABLE payments ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'one_time';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_id ON payments(stripe_payment_id);

-- Enable RLS
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'payments' AND policyname = 'Users can view own payments') THEN
        CREATE POLICY "Users can view own payments" ON payments FOR SELECT USING (auth.uid() = user_id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'payments' AND policyname = 'Service role full access to payments') THEN
        CREATE POLICY "Service role full access to payments" ON payments FOR ALL USING (auth.role() = 'service_role');
    END IF;
END $$;


-- =============================================================================
-- SUBSCRIPTIONS TABLE (stores Stripe subscriptions)
-- =============================================================================

CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    stripe_subscription_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    credits_per_period INTEGER NOT NULL DEFAULT 25,
    weekly_usage INTEGER DEFAULT 0,
    weekly_reset TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add columns if they don't exist (safe for existing tables)
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS weekly_usage INTEGER DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS weekly_reset TIMESTAMPTZ;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

-- Enable RLS
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'subscriptions' AND policyname = 'Users can read own subscriptions') THEN
        CREATE POLICY "Users can read own subscriptions" ON subscriptions FOR SELECT USING (auth.uid() = user_id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'subscriptions' AND policyname = 'Users can update own subscription usage') THEN
        CREATE POLICY "Users can update own subscription usage" ON subscriptions FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'subscriptions' AND policyname = 'Service role can manage subscriptions') THEN
        CREATE POLICY "Service role can manage subscriptions" ON subscriptions FOR ALL USING (auth.role() = 'service_role');
    END IF;
END $$;


-- =============================================================================
-- REFERRALS TABLE (stores referral relationships)
-- =============================================================================

CREATE TABLE IF NOT EXISTS referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_id UUID REFERENCES auth.users(id),
    referred_id UUID REFERENCES auth.users(id) UNIQUE,
    status TEXT DEFAULT 'pending', -- pending, confirmed, rewarded
    rewarded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add new columns if they don't exist
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS rewarded_at TIMESTAMPTZ;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);

-- Enable RLS
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'referrals' AND policyname = 'Users can read their own referrals') THEN
        CREATE POLICY "Users can read their own referrals" ON referrals FOR SELECT USING (auth.uid() = referrer_id OR auth.uid() = referred_id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'referrals' AND policyname = 'Users can insert referrals') THEN
        CREATE POLICY "Users can insert referrals" ON referrals FOR INSERT WITH CHECK (auth.uid() = referred_id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'referrals' AND policyname = 'Service role full access to referrals') THEN
        CREATE POLICY "Service role full access to referrals" ON referrals FOR ALL USING (auth.role() = 'service_role');
    END IF;
END $$;


-- =============================================================================
-- PROFILES TABLE (user profiles & leaderboard data)
-- =============================================================================

CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    referral_code TEXT UNIQUE,
    display_name TEXT,
    show_on_leaderboard BOOLEAN DEFAULT true,
    total_generations INTEGER DEFAULT 0,
    total_referrals INTEGER DEFAULT 0,
    total_spent INTEGER DEFAULT 0, -- in cents
    last_active TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add new columns if they don't exist
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS show_on_leaderboard BOOLEAN DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS total_generations INTEGER DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS total_referrals INTEGER DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS total_spent INTEGER DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_active TIMESTAMPTZ DEFAULT NOW();

-- Indexes for leaderboard queries
CREATE INDEX IF NOT EXISTS idx_profiles_generations ON profiles(total_generations DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_referrals ON profiles(total_referrals DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_spent ON profiles(total_spent DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_active ON profiles(last_active DESC);

-- Enable RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DO $$
BEGIN
    -- Users can view their own profile
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'Users can view own profile') THEN
        CREATE POLICY "Users can view own profile" ON profiles FOR SELECT USING (auth.uid() = id);
    END IF;

    -- Users can update their own profile
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'Users can update own profile') THEN
        CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);
    END IF;

    -- Users can insert their own profile
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'Users can insert own profile') THEN
        CREATE POLICY "Users can insert own profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
    END IF;

    -- Anyone can view leaderboard profiles (public)
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'Anyone can view leaderboard profiles') THEN
        CREATE POLICY "Anyone can view leaderboard profiles" ON profiles FOR SELECT USING (show_on_leaderboard = true);
    END IF;

    -- Service role full access
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'Service role full access to profiles') THEN
        CREATE POLICY "Service role full access to profiles" ON profiles FOR ALL USING (auth.role() = 'service_role');
    END IF;
END $$;


-- =============================================================================
-- ADMINS TABLE (stores admin users and their roles)
-- =============================================================================

CREATE TABLE IF NOT EXISTS admins (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
    role TEXT NOT NULL DEFAULT 'admin',
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Valid roles: 'owner', 'super_admin', 'admin', 'moderator'
-- owner: Full access, cannot be removed, can manage all admins
-- super_admin: Full access, can manage admins (except owner)
-- admin: Can manage users, credits, subscriptions
-- moderator: Read-only access to admin panel

-- Indexes
CREATE INDEX IF NOT EXISTS idx_admins_user_id ON admins(user_id);
CREATE INDEX IF NOT EXISTS idx_admins_role ON admins(role);

-- Enable RLS
ALTER TABLE admins ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'admins' AND policyname = 'Service role full access to admins') THEN
        CREATE POLICY "Service role full access to admins" ON admins FOR ALL USING (auth.role() = 'service_role');
    END IF;
END $$;


-- =============================================================================
-- ADMIN ACTIVITY LOG (tracks admin actions)
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    admin_id UUID REFERENCES auth.users(id),
    action TEXT NOT NULL,
    target_user_id UUID REFERENCES auth.users(id),
    details JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_admin_logs_admin_id ON admin_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_created_at ON admin_logs(created_at DESC);

-- Enable RLS
ALTER TABLE admin_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'admin_logs' AND policyname = 'Service role full access to admin_logs') THEN
        CREATE POLICY "Service role full access to admin_logs" ON admin_logs FOR ALL USING (auth.role() = 'service_role');
    END IF;
END $$;


-- =============================================================================
-- HELPER FUNCTIONS
-- =============================================================================

-- Function to increment profile stats safely
CREATE OR REPLACE FUNCTION increment_profile_stat(
    user_id UUID,
    stat_name TEXT,
    increment_by INTEGER DEFAULT 1
)
RETURNS void AS $$
BEGIN
    -- Upsert profile if doesn't exist
    INSERT INTO profiles (id, total_generations, total_referrals, total_spent, last_active)
    VALUES (user_id, 0, 0, 0, NOW())
    ON CONFLICT (id) DO NOTHING;

    -- Update the specific stat
    IF stat_name = 'total_generations' THEN
        UPDATE profiles SET total_generations = COALESCE(total_generations, 0) + increment_by, last_active = NOW() WHERE id = user_id;
    ELSIF stat_name = 'total_referrals' THEN
        UPDATE profiles SET total_referrals = COALESCE(total_referrals, 0) + increment_by, last_active = NOW() WHERE id = user_id;
    ELSIF stat_name = 'total_spent' THEN
        UPDATE profiles SET total_spent = COALESCE(total_spent, 0) + increment_by, last_active = NOW() WHERE id = user_id;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- =============================================================================
-- DONE! All tables created safely.
-- =============================================================================
