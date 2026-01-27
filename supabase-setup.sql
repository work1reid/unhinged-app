-- Supabase Setup SQL for Unhinged AI
-- Run these in your Supabase SQL editor

-- =====================
-- SUBSCRIPTIONS TABLE
-- =====================
-- Stores active and cancelled subscriptions

CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    stripe_subscription_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active', -- 'active', 'cancelled', 'past_due'
    credits_per_period INTEGER NOT NULL DEFAULT 25,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast user lookups
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

-- RLS Policies
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- Users can only read their own subscriptions
CREATE POLICY "Users can read own subscriptions"
    ON subscriptions FOR SELECT
    USING (auth.uid() = user_id);

-- Only service role can insert/update (done via server webhook)
CREATE POLICY "Service role can manage subscriptions"
    ON subscriptions FOR ALL
    USING (auth.role() = 'service_role');


-- =====================
-- UPDATE PAYMENTS TABLE
-- =====================
-- Add type column to track subscription vs one-time payments

ALTER TABLE payments ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'one_time';


-- =====================
-- EXISTING TABLES (for reference)
-- =====================

-- Credits table (should already exist)
-- CREATE TABLE IF NOT EXISTS credits (
--     id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
--     balance INTEGER DEFAULT 0,
--     total_purchased INTEGER DEFAULT 0,
--     updated_at TIMESTAMPTZ DEFAULT NOW()
-- );

-- Generations table (should already exist)
-- CREATE TABLE IF NOT EXISTS generations (
--     id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
--     user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
--     match_name TEXT,
--     openers JSONB,
--     mode TEXT,
--     analysis JSONB,
--     feedback TEXT,
--     feedback_at TIMESTAMPTZ,
--     created_at TIMESTAMPTZ DEFAULT NOW()
-- );

-- Payments table (should already exist)
-- CREATE TABLE IF NOT EXISTS payments (
--     id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
--     user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
--     stripe_payment_id TEXT NOT NULL UNIQUE,
--     amount INTEGER NOT NULL,
--     credits INTEGER NOT NULL,
--     type TEXT DEFAULT 'one_time',
--     created_at TIMESTAMPTZ DEFAULT NOW()
-- );
