-- Run this in Supabase SQL Editor (https://supabase.com/dashboard)
-- Go to: SQL Editor > New Query > Paste this > Run

-- Table to store generation history
CREATE TABLE IF NOT EXISTS generations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    match_name TEXT,
    openers JSONB NOT NULL,
    mode TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for faster queries by user
CREATE INDEX IF NOT EXISTS idx_generations_user_id ON generations(user_id);
CREATE INDEX IF NOT EXISTS idx_generations_created_at ON generations(created_at DESC);

-- Enable Row Level Security (RLS)
ALTER TABLE generations ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own generations
CREATE POLICY "Users can view own generations"
    ON generations FOR SELECT
    USING (auth.uid() = user_id);

-- Policy: Users can insert their own generations
CREATE POLICY "Users can insert own generations"
    ON generations FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Policy: Users can delete their own generations
CREATE POLICY "Users can delete own generations"
    ON generations FOR DELETE
    USING (auth.uid() = user_id);

-- Policy: Users can update their own generations (for feedback)
CREATE POLICY "Users can update own generations"
    ON generations FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
