// ===================
// STATE
// ===================
let selectedFile = null;
let currentOpeners = [];
let currentAnalysis = null;
let currentProfile = null;
let supabaseClient = null;
let currentUser = null;
let currentUsername = null;
let history = [];
let purchasedCredits = 0;
let analyticsCache = null;

// ===================
// CONSTANTS
// ===================
const FREE_LIMIT_ANONYMOUS = 0;
const FREE_LIMIT_AUTHENTICATED = 0;
const COOLDOWN_DAYS = 2; // Days until free generations reset
const CREDIT_PACK_SIZE = 30;
const CREDIT_PACK_PRICE = 7.95;

// ===================
// SUPABASE
// ===================
async function initSupabase() {
    try {
        if (!window.supabase) {
            console.log('Supabase not loaded');
            return false;
        }

        const response = await fetch('/api/config');
        const config = await response.json();

        if (!config.supabaseUrl) {
            console.log('Supabase not configured');
            return false;
        }

        supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
        console.log('Supabase initialized');

        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session) {
            currentUser = session.user;
            await loadUsername();
            await loadCredits();
            await checkWeeklyBonus();
            await loadSubscription();
            await checkAdminStatus();
        }

        supabaseClient.auth.onAuthStateChange(async (event, session) => {
            console.log('Auth:', event);
            currentUser = session?.user || null;

            if (event === 'SIGNED_IN') {
                // Give signup bonus first (only for new users)
                await giveSignupBonus();
                // Load username, credits, subscription and migrate history
                await loadUsername();
                await loadCredits();
                // Check for weekly Monday bonus
                await checkWeeklyBonus();
                await loadSubscription();
                await checkAdminStatus();
                await migrateLocalHistoryToCloud();
                await processReferralOnSignup();
                showHome();
                showToast('Signed in!');
            } else if (event === 'SIGNED_OUT') {
                currentUsername = null;
                purchasedCredits = 0;
                currentSubscription = null;
                isAdmin = false;
                document.getElementById('settings-admin-btn')?.classList.add('hidden');
                showLogin();
            }

            updateUI();
        });

        return true;
    } catch (error) {
        console.error('Supabase error:', error);
        return false;
    }
}

// ===================
// AUTH
// ===================
async function signInWithGoogle() {
    if (!supabaseClient) return;

    try {
        await supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: 'https://unhingedai.app' }
        });
    } catch (error) {
        showAuthMessage(error.message, 'error');
    }
}

// ===================
// EMAIL AUTH
// ===================
let isSignUpMode = false;

function showEmailAuth() {
    isSignUpMode = false;
    updateEmailAuthUI();
    document.getElementById('email-auth-modal').classList.remove('hidden');
    document.getElementById('auth-email').focus();
}

function closeEmailAuth() {
    document.getElementById('email-auth-modal').classList.add('hidden');
    document.getElementById('email-auth-form').reset();
    document.getElementById('auth-error').classList.add('hidden');
}

function toggleAuthMode(e) {
    e.preventDefault();
    isSignUpMode = !isSignUpMode;
    updateEmailAuthUI();
    document.getElementById('auth-error').classList.add('hidden');
}

function updateEmailAuthUI() {
    const title = document.getElementById('email-auth-title');
    const submitBtn = document.getElementById('email-auth-submit');
    const toggleText = document.getElementById('auth-toggle-text');
    const toggleLink = document.getElementById('auth-toggle-link');
    const confirmGroup = document.getElementById('confirm-password-group');

    if (isSignUpMode) {
        title.textContent = 'Create Account';
        submitBtn.textContent = 'Sign Up';
        toggleText.textContent = 'Already have an account?';
        toggleLink.textContent = 'Sign In';
        confirmGroup.classList.remove('hidden');
        document.getElementById('auth-confirm-password').required = true;
    } else {
        title.textContent = 'Sign In';
        submitBtn.textContent = 'Sign In';
        toggleText.textContent = "Don't have an account?";
        toggleLink.textContent = 'Sign Up';
        confirmGroup.classList.add('hidden');
        document.getElementById('auth-confirm-password').required = false;
    }
}

async function handleEmailAuth(e) {
    e.preventDefault();
    if (!supabaseClient) return;

    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const errorEl = document.getElementById('auth-error');

    errorEl.classList.add('hidden');

    if (isSignUpMode) {
        const confirmPassword = document.getElementById('auth-confirm-password').value;
        if (password !== confirmPassword) {
            errorEl.textContent = 'Passwords do not match';
            errorEl.classList.remove('hidden');
            return;
        }

        try {
            const { data, error } = await supabaseClient.auth.signUp({
                email,
                password,
                options: { emailRedirectTo: 'https://unhingedai.app' }
            });

            if (error) throw error;

            if (data.user && !data.user.confirmed_at) {
                closeEmailAuth();
                showToast('Check your email to confirm your account!');
            } else {
                closeEmailAuth();
                showToast('Account created!');
            }
        } catch (error) {
            errorEl.textContent = error.message;
            errorEl.classList.remove('hidden');
        }
    } else {
        try {
            const { data, error } = await supabaseClient.auth.signInWithPassword({
                email,
                password
            });

            if (error) throw error;

            closeEmailAuth();
            showToast('Signed in!');
        } catch (error) {
            errorEl.textContent = error.message;
            errorEl.classList.remove('hidden');
        }
    }
}

async function signOut() {
    if (!supabaseClient) return;
    await supabaseClient.auth.signOut();
    currentUser = null;
    currentUsername = null;
    showLogin();
    showToast('Signed out');
}

async function deleteAccount() {
    if (!currentUser) return;

    const confirmed = confirm(
        'Are you sure you want to delete your account?\n\n' +
        'This will permanently delete:\n' +
        '• All your generated openers\n' +
        '• Your credits and purchase history\n' +
        '• Your analytics and feedback data\n\n' +
        'This action cannot be undone.'
    );

    if (!confirmed) return;

    const doubleConfirm = confirm('This is your final warning. Delete everything?');
    if (!doubleConfirm) return;

    try {
        const response = await fetch('/api/delete-account', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id })
        });

        const data = await response.json();

        if (data.success) {
            showToast('Account deleted. Goodbye!');
            currentUser = null;
            currentUsername = null;
            closeSettings();
            showLogin();
        } else {
            showToast(data.error || 'Failed to delete account');
        }
    } catch (e) {
        console.error('Delete account error:', e);
        showToast('Failed to delete account');
    }
}

// ===================
// PROFILE / USERNAME
// ===================
async function loadUsername() {
    if (!currentUser || !supabaseClient) return null;

    try {
        const { data, error } = await supabaseClient
            .from('profiles')
            .select('username')
            .eq('id', currentUser.id)
            .single();

        if (data?.username) {
            currentUsername = data.username;
            return data.username;
        }
    } catch (e) {
        console.log('No profile yet');
    }
    return null;
}

async function saveUsername(username) {
    if (!currentUser || !supabaseClient) return false;

    try {
        const { error } = await supabaseClient
            .from('profiles')
            .upsert({
                id: currentUser.id,
                username: username,
                updated_at: new Date().toISOString()
            });

        if (!error) {
            currentUsername = username;
            updateUI();
            showToast('Username saved!');
            return true;
        }
    } catch (e) {
        console.error('Save username failed:', e);
    }
    showToast('Failed to save');
    return false;
}

function showAuthMessage(message, type) {
    const el = document.getElementById('auth-message');
    if (el) {
        el.textContent = message;
        el.className = `auth-message ${type}`;
    }
}

// ===================
// CREDITS SYSTEM
// ===================
async function loadCredits() {
    if (!currentUser || !supabaseClient) {
        purchasedCredits = 0;
        return 0;
    }

    try {
        const { data, error } = await supabaseClient
            .from('credits')
            .select('balance')
            .eq('id', currentUser.id)
            .single();

        if (data?.balance) {
            purchasedCredits = data.balance;
            return data.balance;
        }
    } catch (e) {
        console.log('No credits yet');
    }
    purchasedCredits = 0;
    return 0;
}

async function addCredits(amount) {
    if (!currentUser || !supabaseClient) return false;

    try {
        const { error } = await supabaseClient
            .from('credits')
            .upsert({
                id: currentUser.id,
                balance: purchasedCredits + amount,
                total_purchased: (purchasedCredits + amount),
                updated_at: new Date().toISOString()
            });

        if (!error) {
            purchasedCredits += amount;
            await updateStats();
            return true;
        }
    } catch (e) {
        console.error('Add credits failed:', e);
    }
    return false;
}

const SIGNUP_BONUS_CREDITS = 5;
const WEEKLY_BONUS_CREDITS = 0; // Disabled - was bleeding money

async function giveSignupBonus() {
    if (!currentUser || !supabaseClient) return;

    try {
        // Check if user already has a credits record (meaning they already got bonus)
        const { data: existing } = await supabaseClient
            .from('credits')
            .select('id')
            .eq('id', currentUser.id)
            .single();

        if (existing) {
            // Already has credits record, no bonus
            return;
        }

        // New user - give signup bonus
        const { error } = await supabaseClient
            .from('credits')
            .insert({
                id: currentUser.id,
                balance: SIGNUP_BONUS_CREDITS,
                total_purchased: 0,
                updated_at: new Date().toISOString()
            });

        if (!error) {
            purchasedCredits = SIGNUP_BONUS_CREDITS;
            showToast(`🎁 ${SIGNUP_BONUS_CREDITS} free credits added!`);
        }
    } catch (e) {
        // Record doesn't exist, give bonus
        try {
            await supabaseClient
                .from('credits')
                .insert({
                    id: currentUser.id,
                    balance: SIGNUP_BONUS_CREDITS,
                    total_purchased: 0,
                    updated_at: new Date().toISOString()
                });
            purchasedCredits = SIGNUP_BONUS_CREDITS;
            showToast(`🎁 ${SIGNUP_BONUS_CREDITS} free credits added!`);
        } catch (e2) {
            console.error('Signup bonus failed:', e2);
        }
    }
}

function getMondayOfWeek(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Sunday
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

async function checkWeeklyBonus() {
    // Weekly bonus disabled - was hemorrhaging money
    if (WEEKLY_BONUS_CREDITS <= 0) return;
    if (!currentUser || !supabaseClient) return;

    try {
        // Get last weekly bonus date from database
        const { data } = await supabaseClient
            .from('credits')
            .select('last_weekly_bonus')
            .eq('id', currentUser.id)
            .single();

        const lastBonus = data?.last_weekly_bonus ? new Date(data.last_weekly_bonus) : null;
        const now = new Date();
        const thisMonday = getMondayOfWeek(now);

        // Check if we've already given bonus this week
        if (lastBonus && lastBonus >= thisMonday) {
            return; // Already got this week's bonus
        }

        // Give weekly bonus
        const success = await addCredits(WEEKLY_BONUS_CREDITS);
        if (success) {
            // Update last_weekly_bonus in database
            await supabaseClient
                .from('credits')
                .update({ last_weekly_bonus: now.toISOString() })
                .eq('id', currentUser.id);

            showToast(`🎁 Weekly bonus: +${WEEKLY_BONUS_CREDITS} credit!`);
        }
    } catch (e) {
        console.error('Weekly bonus check failed:', e);
    }
}

async function useCredit() {
    if (!currentUser || !supabaseClient || purchasedCredits <= 0) return false;

    try {
        const { error } = await supabaseClient
            .from('credits')
            .update({
                balance: purchasedCredits - 1,
                updated_at: new Date().toISOString()
            })
            .eq('id', currentUser.id);

        if (!error) {
            purchasedCredits--;
            return true;
        }
    } catch (e) {
        console.error('Use credit failed:', e);
    }
    return false;
}

async function buyCredits(pack = 'value') {
    if (!currentUser) {
        showToast('Sign in to buy credits');
        showLogin();
        return;
    }

    try {
        const response = await fetch('/api/create-checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser.id,
                email: currentUser.email,
                pack: pack
            })
        });

        const data = await response.json();

        if (data.url) {
            window.location.href = data.url;
        } else {
            showToast('Failed to start checkout');
        }
    } catch (error) {
        console.error('Checkout error:', error);
        showToast('Payment error');
    }
}

// ===================
// SUBSCRIPTION SYSTEM
// ===================
let currentSubscription = null;

async function loadSubscription() {
    if (!currentUser || !supabaseClient) {
        currentSubscription = null;
        cachedSubWeeklyUsage = null;
        return null;
    }

    try {
        const { data, error } = await supabaseClient
            .from('subscriptions')
            .select('*')
            .eq('user_id', currentUser.id)
            .eq('status', 'active')
            .single();

        if (data) {
            currentSubscription = data;
            cachedSubWeeklyUsage = null; // Reset cache to load fresh from subscription
            return data;
        }
    } catch (e) {
        console.log('No active subscription');
    }
    currentSubscription = null;
    cachedSubWeeklyUsage = null;
    return null;
}

async function buySubscription(plan = 'weekly') {
    if (!currentUser) {
        showToast('Sign in to subscribe');
        showLogin();
        return;
    }

    try {
        const response = await fetch('/api/create-subscription', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser.id,
                email: currentUser.email,
                plan: plan
            })
        });

        const data = await response.json();

        if (data.url) {
            window.location.href = data.url;
        } else {
            showToast('Failed to start subscription');
        }
    } catch (error) {
        console.error('Subscription error:', error);
        showToast('Subscription error');
    }
}

async function cancelSubscription() {
    if (!currentUser || !currentSubscription) {
        showToast('No active subscription');
        return;
    }

    if (!confirm('Cancel your subscription? You\'ll keep your remaining credits.')) {
        return;
    }

    try {
        const response = await fetch('/api/cancel-subscription', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id })
        });

        const data = await response.json();

        if (data.success) {
            currentSubscription = null;
            showToast('Subscription cancelled');
            await updateSettingsUI();
            await updateStats();
        } else {
            showToast(data.error || 'Failed to cancel');
        }
    } catch (error) {
        console.error('Cancel error:', error);
        showToast('Error cancelling');
    }
}

// ===================
// REFERRAL SYSTEM
// ===================
function getReferralCode() {
    if (!currentUser) return null;
    // Generate short code from user ID
    return currentUser.id.substring(0, 8).toUpperCase();
}

function getReferralLink() {
    const code = getReferralCode();
    if (!code) return null;
    return `https://unhingedai.app/?ref=${code}`;
}

async function checkReferral() {
    const params = new URLSearchParams(window.location.search);
    const refCode = params.get('ref');

    if (refCode) {
        // Store referral code for later (when user signs up)
        localStorage.setItem('referral_code', refCode);
        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);
    }
}

async function processReferralOnSignup() {
    if (!currentUser || !supabaseClient) return;

    const refCode = localStorage.getItem('referral_code');
    if (!refCode) return;

    try {
        // Find referrer by code (first 8 chars of their user ID)
        const { data: users } = await supabaseClient
            .from('profiles')
            .select('id')
            .ilike('id', `${refCode.toLowerCase()}%`);

        if (users && users.length > 0) {
            const referrerId = users[0].id;

            // Don't self-refer
            if (referrerId === currentUser.id) {
                localStorage.removeItem('referral_code');
                return;
            }

            // Check if already referred
            const { data: existing } = await supabaseClient
                .from('referrals')
                .select('id')
                .eq('referred_id', currentUser.id)
                .single();

            if (existing) {
                localStorage.removeItem('referral_code');
                return;
            }

            // Record referral
            await supabaseClient.from('referrals').insert({
                referrer_id: referrerId,
                referred_id: currentUser.id
            });

            // Award credits to referrer (3 credits)
            const { data: referrerCredits } = await supabaseClient
                .from('credits')
                .select('balance')
                .eq('id', referrerId)
                .single();

            await supabaseClient.from('credits').upsert({
                id: referrerId,
                balance: (referrerCredits?.balance || 0) + 3,
                updated_at: new Date().toISOString()
            });

            // Award credits to new user (3 credits)
            await addCredits(3);

            showToast('🎉 You got 3 bonus credits!');
            console.log('Referral processed');
        }

        localStorage.removeItem('referral_code');
    } catch (e) {
        console.error('Referral processing failed:', e);
    }
}

async function copyReferralLink() {
    const link = getReferralLink();
    if (!link) {
        showToast('Sign in to get your referral link');
        return;
    }

    try {
        await navigator.clipboard.writeText(link);
        showToast('Referral link copied!');
    } catch (e) {
        showToast('Failed to copy');
    }
}

async function shareReferral() {
    const link = getReferralLink();
    if (!link) {
        showToast('Sign in to share');
        return;
    }

    const text = `Get unhinged dating openers with AI! Use my link for 3 free credits: ${link}`;

    if (navigator.share) {
        try {
            await navigator.share({ title: 'Unhinged AI', text });
            return;
        } catch {}
    }

    await copyReferralLink();
}

// ===================
// PUSH NOTIFICATIONS
// ===================
let notificationsEnabled = false;

async function requestNotificationPermission() {
    if (!('Notification' in window)) {
        showToast('Notifications not supported');
        return false;
    }

    if (Notification.permission === 'granted') {
        notificationsEnabled = true;
        return true;
    }

    if (Notification.permission !== 'denied') {
        const permission = await Notification.requestPermission();
        notificationsEnabled = permission === 'granted';
        if (notificationsEnabled) {
            localStorage.setItem('notifications_enabled', 'true');
            showToast('Notifications enabled!');
            scheduleReminder();
        }
        return notificationsEnabled;
    }

    return false;
}

function toggleNotifications() {
    const toggle = document.getElementById('notifications-toggle');
    if (toggle.checked) {
        requestNotificationPermission();
    } else {
        notificationsEnabled = false;
        localStorage.setItem('notifications_enabled', 'false');
        showToast('Notifications disabled');
    }
}

function scheduleReminder() {
    // Store timestamp of last activity
    localStorage.setItem('last_activity', Date.now().toString());
}

function checkForReminder() {
    if (!notificationsEnabled) return;

    const lastActivity = parseInt(localStorage.getItem('last_activity') || '0');
    const hoursSince = (Date.now() - lastActivity) / (1000 * 60 * 60);

    // Send reminder after 24 hours of inactivity
    if (hoursSince >= 24 && Notification.permission === 'granted') {
        const lastReminder = parseInt(localStorage.getItem('last_reminder') || '0');
        const hoursSinceReminder = (Date.now() - lastReminder) / (1000 * 60 * 60);

        // Only remind once per day
        if (hoursSinceReminder >= 24) {
            sendNotification(
                'Time for some rizz? 🔥',
                'Your matches are waiting. Generate some unhinged openers!'
            );
            localStorage.setItem('last_reminder', Date.now().toString());
        }
    }
}

function sendNotification(title, body) {
    if (Notification.permission !== 'granted') return;

    try {
        new Notification(title, {
            body,
            icon: '/favicon.ico',
            badge: '/favicon.ico',
            tag: 'unhinged-reminder'
        });
    } catch (e) {
        console.log('Notification failed:', e);
    }
}

function initNotifications() {
    notificationsEnabled = localStorage.getItem('notifications_enabled') === 'true';

    if (notificationsEnabled && Notification.permission === 'granted') {
        checkForReminder();
    }

    // Update activity timestamp
    scheduleReminder();
}

// ===================
// ANALYTICS DASHBOARD
// ===================
function closeAnalytics() {
    document.getElementById('analytics-modal').classList.add('hidden');
}

async function loadAnalytics() {
    const container = document.getElementById('analytics-content');

    if (!currentUser || !supabaseClient) {
        container.innerHTML = '<p class="analytics-empty">Sign in to see analytics</p>';
        return;
    }

    container.innerHTML = '<div class="analytics-loading">Loading stats...</div>';

    try {
        // Get all generations with feedback
        const { data: generations } = await supabaseClient
            .from('generations')
            .select('mode, feedback, created_at')
            .eq('user_id', currentUser.id);

        if (!generations || generations.length === 0) {
            container.innerHTML = `
                <div class="analytics-empty">
                    <span>📊</span>
                    <p>No data yet</p>
                    <span class="hint">Generate some openers to see analytics</span>
                </div>
            `;
            return;
        }

        // Calculate mode stats
        const modeStats = {};
        const modes = ['chaotic', 'flirty', 'unhinged', 'mysterious', 'dadjoke', 'poetic'];

        modes.forEach(mode => {
            modeStats[mode] = { total: 0, replied: 0, date: 0, blocked: 0 };
        });

        generations.forEach(gen => {
            const mode = gen.mode || 'chaotic';
            if (modeStats[mode]) {
                modeStats[mode].total++;
                if (gen.feedback === 'replied') modeStats[mode].replied++;
                if (gen.feedback === 'date') modeStats[mode].date++;
                if (gen.feedback === 'blocked') modeStats[mode].blocked++;
            }
        });

        // Calculate success rates
        const modeResults = modes.map(mode => {
            const stats = modeStats[mode];
            const withFeedback = stats.replied + stats.date + stats.blocked;
            const successRate = withFeedback > 0
                ? Math.round(((stats.replied + stats.date) / withFeedback) * 100)
                : null;
            return { mode, ...stats, successRate };
        }).filter(m => m.total > 0)
          .sort((a, b) => (b.successRate || 0) - (a.successRate || 0));

        // Get best mode
        const bestMode = modeResults.find(m => m.successRate !== null);

        // Calculate overall stats
        const totalGenerations = generations.length;
        const withFeedback = generations.filter(g => g.feedback).length;
        const successes = generations.filter(g => g.feedback === 'replied' || g.feedback === 'date').length;
        const overallSuccess = withFeedback > 0 ? Math.round((successes / withFeedback) * 100) : 0;

        // Mode emoji map
        const modeEmoji = {
            chaotic: '🌀',
            flirty: '😏',
            unhinged: '🔥',
            mysterious: '🎭',
            dadjoke: '👴',
            poetic: '🎨'
        };

        // Build HTML
        let html = `
            <div class="analytics-overview">
                <div class="analytics-stat">
                    <span class="stat-value">${totalGenerations}</span>
                    <span class="stat-label">Total Openers</span>
                </div>
                <div class="analytics-stat">
                    <span class="stat-value">${overallSuccess}%</span>
                    <span class="stat-label">Success Rate</span>
                </div>
                <div class="analytics-stat highlight">
                    <span class="stat-value">${bestMode ? modeEmoji[bestMode.mode] : '—'}</span>
                    <span class="stat-label">Best Mode</span>
                </div>
            </div>

            <div class="analytics-section">
                <h3>📊 Mode Performance</h3>
                <div class="mode-performance">
        `;

        modeResults.forEach(m => {
            const emoji = modeEmoji[m.mode] || '🔥';
            const barWidth = m.successRate !== null ? m.successRate : 0;
            const rateText = m.successRate !== null ? `${m.successRate}%` : 'No feedback';

            html += `
                <div class="mode-row">
                    <span class="mode-name">${emoji} ${m.mode.charAt(0).toUpperCase() + m.mode.slice(1)}</span>
                    <div class="mode-bar-container">
                        <div class="mode-bar" style="width: ${barWidth}%"></div>
                    </div>
                    <span class="mode-rate">${rateText}</span>
                    <span class="mode-count">(${m.total})</span>
                </div>
            `;
        });

        html += `
                </div>
            </div>

            <div class="analytics-tip">
                ${bestMode && bestMode.successRate !== null
                    ? `💡 <strong>${bestMode.mode.charAt(0).toUpperCase() + bestMode.mode.slice(1)}</strong> mode is working best for you!`
                    : '💡 Record feedback on your openers to see which modes work best'}
            </div>
        `;

        container.innerHTML = html;

    } catch (e) {
        console.error('Analytics error:', e);
        container.innerHTML = '<p>Failed to load analytics</p>';
    }
}

// ===================
// STAT BREAKDOWNS
// ===================

function closeBreakdown(type) {
    document.getElementById(`${type}-breakdown-modal`).classList.add('hidden');
}

async function showCreditsBreakdown() {
    const modal = document.getElementById('credits-breakdown-modal');
    const container = document.getElementById('credits-breakdown-content');
    modal.classList.remove('hidden');

    const freeRemaining = await getRemainingFreeGenerations();
    const freeLimit = getFreeLimit();
    const freeUsed = freeLimit - freeRemaining;

    let subscriptionHtml = '';
    if (currentSubscription) {
        subscriptionHtml = `
            <div class="breakdown-row">
                <span class="breakdown-label">🔥 Weekly Unlimited</span>
                <span class="breakdown-value active">Active</span>
            </div>
            <div class="breakdown-row sub">
                <span class="breakdown-label">Fair use</span>
                <span class="breakdown-value">150/week cap</span>
            </div>
        `;
    }

    container.innerHTML = `
        <div class="breakdown-section">
            <div class="breakdown-row highlight">
                <span class="breakdown-label">Total Available</span>
                <span class="breakdown-value big">${freeRemaining + purchasedCredits}</span>
            </div>
        </div>
        <div class="breakdown-section">
            <div class="breakdown-row">
                <span class="breakdown-label">🆓 Free Credits</span>
                <span class="breakdown-value">${freeRemaining} / ${freeLimit}</span>
            </div>
            <div class="breakdown-row">
                <span class="breakdown-label">💰 Purchased Credits</span>
                <span class="breakdown-value">${purchasedCredits}</span>
            </div>
            ${subscriptionHtml}
        </div>
        <div class="breakdown-hint">Free credits reset every 2 days</div>
    `;
}

async function showGeneratedBreakdown() {
    const modal = document.getElementById('generated-breakdown-modal');
    const container = document.getElementById('generated-breakdown-content');
    modal.classList.remove('hidden');

    if (!currentUser || !supabaseClient) {
        container.innerHTML = '<p class="breakdown-empty">Sign in to see breakdown</p>';
        return;
    }

    container.innerHTML = '<div class="analytics-loading">Loading...</div>';

    try {
        const { data: generations } = await supabaseClient
            .from('generations')
            .select('mode, created_at')
            .eq('user_id', currentUser.id);

        if (!generations || generations.length === 0) {
            container.innerHTML = '<p class="breakdown-empty">No generations yet</p>';
            return;
        }

        // Count by mode
        const modeEmoji = {
            chaotic: '🌀', flirty: '😏', unhinged: '🔥',
            mysterious: '🎭', dadjoke: '👴', poetic: '🎨'
        };
        const modeCounts = {};
        generations.forEach(g => {
            const mode = g.mode || 'chaotic';
            modeCounts[mode] = (modeCounts[mode] || 0) + 1;
        });

        // Count by time period
        const now = new Date();
        const today = generations.filter(g => {
            const d = new Date(g.created_at);
            return d.toDateString() === now.toDateString();
        }).length;
        const thisWeek = generations.filter(g => {
            const d = new Date(g.created_at);
            const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
            return d >= weekAgo;
        }).length;

        let modeHtml = Object.entries(modeCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([mode, count]) => `
                <div class="breakdown-row">
                    <span class="breakdown-label">${modeEmoji[mode] || '🔥'} ${mode.charAt(0).toUpperCase() + mode.slice(1)}</span>
                    <span class="breakdown-value">${count}</span>
                </div>
            `).join('');

        container.innerHTML = `
            <div class="breakdown-section">
                <div class="breakdown-row highlight">
                    <span class="breakdown-label">Total Generated</span>
                    <span class="breakdown-value big">${generations.length}</span>
                </div>
            </div>
            <div class="breakdown-section">
                <div class="breakdown-row">
                    <span class="breakdown-label">📅 Today</span>
                    <span class="breakdown-value">${today}</span>
                </div>
                <div class="breakdown-row">
                    <span class="breakdown-label">📆 This Week</span>
                    <span class="breakdown-value">${thisWeek}</span>
                </div>
            </div>
            <div class="breakdown-section">
                <span class="breakdown-title">By Mode</span>
                ${modeHtml}
            </div>
        `;
    } catch (e) {
        console.error('Generated breakdown error:', e);
        container.innerHTML = '<p>Failed to load</p>';
    }
}

async function showSuccessBreakdown() {
    const modal = document.getElementById('success-breakdown-modal');
    const container = document.getElementById('success-breakdown-content');
    modal.classList.remove('hidden');

    if (!currentUser || !supabaseClient) {
        container.innerHTML = '<p class="breakdown-empty">Sign in to see breakdown</p>';
        return;
    }

    container.innerHTML = '<div class="analytics-loading">Loading...</div>';

    try {
        const { data: generations } = await supabaseClient
            .from('generations')
            .select('feedback')
            .eq('user_id', currentUser.id);

        if (!generations || generations.length === 0) {
            container.innerHTML = '<p class="breakdown-empty">No generations yet</p>';
            return;
        }

        const total = generations.length;
        const sent = generations.filter(g => g.feedback === 'sent').length;
        const replied = generations.filter(g => g.feedback === 'replied').length;
        const dates = generations.filter(g => g.feedback === 'date').length;
        const blocked = generations.filter(g => g.feedback === 'blocked').length;
        const noFeedback = generations.filter(g => !g.feedback).length;

        const withFeedback = sent + replied + dates + blocked;
        const successCount = replied + dates;
        const successRate = withFeedback > 0 ? Math.round((successCount / withFeedback) * 100) : 0;

        container.innerHTML = `
            <div class="breakdown-section">
                <div class="breakdown-row highlight">
                    <span class="breakdown-label">Success Rate</span>
                    <span class="breakdown-value big ${successRate >= 50 ? 'success' : ''}">${successRate}%</span>
                </div>
            </div>
            <div class="breakdown-section">
                <div class="breakdown-row">
                    <span class="breakdown-label">📤 Sent</span>
                    <span class="breakdown-value">${sent}</span>
                </div>
                <div class="breakdown-row">
                    <span class="breakdown-label">💬 Got Reply</span>
                    <span class="breakdown-value success">${replied}</span>
                </div>
                <div class="breakdown-row">
                    <span class="breakdown-label">🔥 Got Date</span>
                    <span class="breakdown-value success">${dates}</span>
                </div>
                <div class="breakdown-row">
                    <span class="breakdown-label">💀 Blocked</span>
                    <span class="breakdown-value fail">${blocked}</span>
                </div>
            </div>
            <div class="breakdown-section">
                <div class="breakdown-row">
                    <span class="breakdown-label">❓ No feedback yet</span>
                    <span class="breakdown-value muted">${noFeedback}</span>
                </div>
            </div>
            ${noFeedback > 0 ? '<div class="breakdown-hint">Tap Analytics to update missing feedback</div>' : ''}
        `;
    } catch (e) {
        console.error('Success breakdown error:', e);
        container.innerHTML = '<p>Failed to load</p>';
    }
}

// ===================
// FEEDBACK PROMPT
// ===================
let pendingFeedbackItems = [];
let currentFeedbackIndex = 0;
let skipFeedbackCheck = false;

async function showAnalytics() {
    if (!currentUser) {
        showToast('Sign in to see analytics');
        return;
    }

    // Check for unanswered feedback first (unless we just came from feedback prompt)
    if (!skipFeedbackCheck) {
        const hasUnanswered = await checkUnansweredFeedback();
        if (hasUnanswered) {
            showFeedbackPrompt();
            return;
        }
    }

    skipFeedbackCheck = false;
    const modal = document.getElementById('analytics-modal');
    modal.classList.remove('hidden');
    await loadAnalytics();
}

async function checkUnansweredFeedback() {
    if (!currentUser || !supabaseClient) return false;

    try {
        const { data } = await supabaseClient
            .from('generations')
            .select('id, match_name, openers, created_at')
            .eq('user_id', currentUser.id)
            .is('feedback', null)
            .order('created_at', { ascending: false })
            .limit(5);

        if (data && data.length > 0) {
            pendingFeedbackItems = data;
            return true;
        }
    } catch (e) {
        console.error('Check feedback error:', e);
    }
    return false;
}

function showFeedbackPrompt() {
    const modal = document.getElementById('feedback-prompt-modal');
    const container = document.getElementById('feedback-prompt-list');
    modal.classList.remove('hidden');
    currentFeedbackIndex = 0;
    renderFeedbackPrompt();
}

function renderFeedbackPrompt() {
    const container = document.getElementById('feedback-prompt-list');

    if (pendingFeedbackItems.length === 0 || currentFeedbackIndex >= pendingFeedbackItems.length) {
        // All done, show analytics (skip the feedback check since we just did it)
        skipFeedbackCheck = true;
        closeFeedbackPrompt();
        const modal = document.getElementById('analytics-modal');
        modal.classList.remove('hidden');
        loadAnalytics();
        return;
    }

    const item = pendingFeedbackItems[currentFeedbackIndex];
    const preview = item.openers?.[0]?.text?.slice(0, 60) + '...' || 'Opener';
    const timeAgo = getTimeAgo(new Date(item.created_at));

    container.innerHTML = `
        <div class="feedback-prompt-item">
            <div class="feedback-prompt-header">
                <span class="feedback-prompt-name">${item.match_name || 'Match'}</span>
                <span class="feedback-prompt-time">${timeAgo}</span>
            </div>
            <p class="feedback-prompt-preview">"${preview}"</p>
            <div class="feedback-prompt-buttons">
                <button class="feedback-prompt-btn" data-result="sent">📤 Sent</button>
                <button class="feedback-prompt-btn success" data-result="replied">💬 Reply</button>
                <button class="feedback-prompt-btn fire" data-result="date">🔥 Date</button>
                <button class="feedback-prompt-btn fail" data-result="blocked">💀 Blocked</button>
            </div>
            <button class="feedback-skip-btn" id="skip-feedback-btn">Didn't use it</button>
        </div>
        <div class="feedback-prompt-progress">${currentFeedbackIndex + 1} of ${pendingFeedbackItems.length}</div>
    `;

    // Add click handlers
    container.querySelectorAll('.feedback-prompt-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            submitPromptFeedback(item.id, btn.dataset.result);
        });
    });

    document.getElementById('skip-feedback-btn')?.addEventListener('click', skipCurrentFeedback);
}

async function submitPromptFeedback(generationId, result) {
    if (!supabaseClient || !generationId) {
        console.error('Missing supabase client or generation ID:', { supabaseClient: !!supabaseClient, generationId });
        currentFeedbackIndex++;
        renderFeedbackPrompt();
        return;
    }

    console.log('Saving feedback:', { generationId, result });

    try {
        const { data, error } = await supabaseClient
            .from('generations')
            .update({ feedback: result, feedback_at: new Date().toISOString() })
            .eq('id', generationId)
            .eq('user_id', currentUser.id)
            .select();

        console.log('Feedback save response:', { data, error });

        if (error) {
            console.error('Feedback save error:', error);
            showToast('Failed to save');
        } else if (!data || data.length === 0) {
            console.error('No rows updated - ID may not exist or RLS blocking');
            showToast('Failed to save');
            currentFeedbackIndex++;
        } else {
            const msgs = { sent: 'Saved!', replied: '💬 Nice!', date: '🔥 Legend!', blocked: 'Noted 💀' };
            showToast(msgs[result] || 'Saved!');

            // Invalidate analytics cache and update stats
            analyticsCache = null;
            await updateStats();

            // Move to next item
            currentFeedbackIndex++;
        }
    } catch (e) {
        console.error('Feedback save exception:', e);
        showToast('Failed to save');
        currentFeedbackIndex++;
    }

    renderFeedbackPrompt();
}

function skipCurrentFeedback() {
    currentFeedbackIndex++;
    renderFeedbackPrompt();
}

function closeFeedbackPrompt() {
    document.getElementById('feedback-prompt-modal').classList.add('hidden');
    pendingFeedbackItems = [];
    currentFeedbackIndex = 0;
    // Invalidate cache so analytics reloads fresh
    analyticsCache = null;
}

async function skipFeedbackPrompt() {
    skipFeedbackCheck = true;
    closeFeedbackPrompt();
    const modal = document.getElementById('analytics-modal');
    modal.classList.remove('hidden');
    await loadAnalytics();
}

// Check for payment success/cancel on page load
async function checkPaymentStatus() {
    const params = new URLSearchParams(window.location.search);
    const payment = params.get('payment');
    const paymentType = params.get('type');

    if (payment === 'success') {
        // Credits are added server-side via webhook - just reload balance
        await loadCredits();
        await loadSubscription();

        if (paymentType === 'subscription') {
            showToast(`🎉 Subscribed! Unlimited generations unlocked.`);
        } else {
            showToast(`🎉 Credits added to your account!`);
        }
        // Clean up URL
        window.history.replaceState({}, document.title, window.location.pathname);
    } else if (payment === 'cancelled') {
        showToast('Payment cancelled');
        window.history.replaceState({}, document.title, window.location.pathname);
    }
}

// ===================
// NAVIGATION
// ===================
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId)?.classList.add('active');
}

function showLogin() {
    showScreen('login-screen');
}

async function showHome() {
    updateUI();
    await updateStats();
    showScreen('home-screen');
}

async function showGenerate() {
    await updateGenerateUsage();
    await loadModeSuccessRates();
    showScreen('generate-screen');
}

function showLoading() {
    showScreen('loading-screen');
}

function showResults() {
    showScreen('results-screen');
}

function showHistory() {
    loadHistory();
    showScreen('history-screen');
}

let analysisFromResults = false;

function showAnalysis() {
    // Track where we came from
    const resultsScreen = document.getElementById('results-screen');
    analysisFromResults = resultsScreen.classList.contains('active');
    displayAnalysis();
    showScreen('analysis-screen');
}

function goBackFromAnalysis() {
    if (analysisFromResults && currentOpeners.length > 0) {
        showResults();
    } else {
        showHome();
    }
}

function updateAnalysisButton() {
    const btn = document.getElementById('view-insights-btn');
    if (btn) {
        btn.style.display = currentAnalysis ? 'block' : 'none';
    }
}

function displayAnalysis() {
    const container = document.getElementById('analysis-content');

    if (!currentAnalysis) {
        container.innerHTML = `
            <div class="empty-state">
                <span class="empty-icon">🧠</span>
                <p>No Analysis Yet</p>
                <span class="empty-hint">Generate openers to see match insights</span>
            </div>
        `;
        return;
    }

    const a = currentAnalysis;

    container.innerHTML = `
        <div class="analysis-section">
            <div class="analysis-vibe">
                <span class="vibe-label">Their Vibe</span>
                <span class="vibe-value">${a.vibe || 'Unknown'}</span>
            </div>
        </div>

        <div class="analysis-section">
            <h3>🔮 Personality Read</h3>
            <p class="analysis-text">${a.personality || 'No data'}</p>
        </div>

        <div class="analysis-section">
            <h3>💚 Green Flags</h3>
            <ul class="analysis-list green">
                ${(a.greenFlags || []).map(f => `<li>${f}</li>`).join('')}
            </ul>
        </div>

        <div class="analysis-section">
            <h3>🚩 Red Flags</h3>
            <ul class="analysis-list red">
                ${(a.redFlags || []).map(f => `<li>${f}</li>`).join('')}
            </ul>
        </div>

        <div class="analysis-section">
            <h3>💭 What They Want</h3>
            <p class="analysis-text">${a.lookingFor || 'No data'}</p>
        </div>

        <div class="analysis-section">
            <h3>📍 Date Ideas</h3>
            <ul class="analysis-list">
                ${(a.dateIdeas || []).map(d => `<li>${d}</li>`).join('')}
            </ul>
        </div>

        <div class="analysis-section">
            <h3>💬 Talk About</h3>
            <ul class="analysis-list">
                ${(a.talkAbout || []).map(t => `<li>${t}</li>`).join('')}
            </ul>
        </div>

        <div class="analysis-section">
            <h3>🚫 Avoid Early On</h3>
            <ul class="analysis-list warning">
                ${(a.avoid || []).map(av => `<li>${av}</li>`).join('')}
            </ul>
        </div>
    `;
}

function showSettings() {
    updateSettingsUI();

    // Sync notifications toggle
    const toggle = document.getElementById('notifications-toggle');
    if (toggle) {
        toggle.checked = notificationsEnabled && Notification.permission === 'granted';
    }

    document.getElementById('settings-modal').classList.remove('hidden');
}

function closeSettings() {
    document.getElementById('settings-modal').classList.add('hidden');
}

// ===================
// UI UPDATES
// ===================
function updateUI() {
    const greeting = document.getElementById('home-greeting');
    const statusEl = document.getElementById('home-status');

    if (currentUser) {
        // Use username if set, otherwise extract from email
        const displayName = currentUsername || currentUser.email?.split('@')[0] || 'there';
        greeting.textContent = `Hey ${displayName}!`;
        statusEl.textContent = currentUsername ? 'Signed in' : 'Tap settings to set username';
    } else {
        greeting.textContent = 'Hey there!';
        statusEl.textContent = 'Not signed in';
    }
}

async function updateStats() {
    let totalRemaining;

    // Subscribers see weekly cap remaining
    if (currentSubscription) {
        const weeklyUsage = getSubscriberWeeklyUsage();
        totalRemaining = Math.max(0, SUBSCRIBER_WEEKLY_CAP - weeklyUsage) + purchasedCredits;
    } else {
        const freeRemaining = await getRemainingFreeGenerations();
        totalRemaining = freeRemaining + purchasedCredits;
    }

    let total = getUsageData().total || 0;
    let successRate = '—';

    // If logged in, get stats from cloud
    if (currentUser && supabaseClient) {
        try {
            // Get total count
            const { count } = await supabaseClient
                .from('generations')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', currentUser.id);

            if (count !== null) {
                total = count;
            }

            // Get success stats (replied + date = success)
            const { data: feedbackData } = await supabaseClient
                .from('generations')
                .select('feedback')
                .eq('user_id', currentUser.id)
                .not('feedback', 'is', null);

            if (feedbackData && feedbackData.length > 0) {
                const successes = feedbackData.filter(f => f.feedback === 'replied' || f.feedback === 'date').length;
                const rate = Math.round((successes / feedbackData.length) * 100);
                successRate = `${rate}%`;
            }
        } catch (e) {
            console.error('Stats fetch failed:', e);
        }
    } else {
        // Use local stats for anonymous users
        const data = getUsageData();
        if (data.feedbackStats) {
            const totalFeedback = Object.values(data.feedbackStats).reduce((a, b) => a + b, 0);
            if (totalFeedback > 0) {
                const successes = (data.feedbackStats.replied || 0) + (data.feedbackStats.date || 0);
                const rate = Math.round((successes / totalFeedback) * 100);
                successRate = `${rate}%`;
            }
        }
    }

    document.getElementById('stat-remaining').textContent = totalRemaining;
    document.getElementById('stat-total').textContent = total;
    document.getElementById('stat-success').textContent = successRate;
}

async function updateGenerateUsage() {
    const el = document.getElementById('generate-usage');
    const packsSection = document.getElementById('buy-credits-section');

    if (el) {
        // Subscribers see their weekly usage
        if (currentSubscription) {
            const weeklyUsage = getSubscriberWeeklyUsage();
            const remaining = SUBSCRIBER_WEEKLY_CAP - weeklyUsage;
            if (remaining > 0) {
                el.textContent = `Unlimited (${remaining} left this week)`;
            } else {
                el.textContent = purchasedCredits > 0 ? `${purchasedCredits} bonus credits` : 'Weekly limit reached';
            }
        } else {
            const freeRemaining = await getRemainingFreeGenerations();
            const totalRemaining = freeRemaining + purchasedCredits;

            if (totalRemaining > 0) {
                if (freeRemaining > 0) {
                    el.textContent = `${freeRemaining} free${purchasedCredits > 0 ? ` + ${purchasedCredits} credits` : ''}`;
                } else {
                    el.textContent = `${purchasedCredits} credits`;
                }
            } else {
                const nextReset = getNextResetTime();
                const hoursUntil = Math.ceil((nextReset - new Date()) / (1000 * 60 * 60));
                el.textContent = `Resets in ${hoursUntil}h`;
            }
        }
    }

    // Show/hide buy credits section when running low (not for subscribers unless at cap)
    if (packsSection) {
        if (currentSubscription) {
            const weeklyUsage = getSubscriberWeeklyUsage();
            packsSection.style.display = (weeklyUsage >= SUBSCRIBER_WEEKLY_CAP - 10 && currentUser) ? 'block' : 'none';
        } else {
            const freeRemaining = await getRemainingFreeGenerations();
            packsSection.style.display = (freeRemaining <= 1 && currentUser) ? 'block' : 'none';
        }
    }
}

async function updateSettingsUI() {
    const emailEl = document.getElementById('settings-email');
    const usernameInput = document.getElementById('settings-username');
    const usernameSection = document.getElementById('username-section');
    const signoutBtn = document.getElementById('settings-signout-btn');
    const signinBtn = document.getElementById('settings-signin-btn');
    const creditsSection = document.getElementById('settings-credits-section');
    const subscriptionStatus = document.getElementById('subscription-status');
    const referralSection = document.getElementById('settings-referral');
    const referralLinkInput = document.getElementById('referral-link-input');
    const referralStats = document.getElementById('referral-stats');

    if (currentUser) {
        emailEl.textContent = currentUser.email;
        usernameInput.value = currentUsername || '';
        usernameSection.style.display = 'block';
        signoutBtn.style.display = 'block';
        signinBtn.style.display = 'none';
        creditsSection.style.display = 'block';

        // Load and show subscription status
        await loadSubscription();
        if (subscriptionStatus) {
            if (currentSubscription) {
                subscriptionStatus.innerHTML = `
                    <div class="sub-active">
                        <span class="sub-badge">✓ Active</span>
                        <span class="sub-plan">Weekly Unlimited - $9.99/week</span>
                    </div>
                    <button class="btn-cancel-sub" onclick="cancelSubscription()">Cancel Subscription</button>
                `;
            } else {
                subscriptionStatus.innerHTML = `
                    <button class="btn-subscribe" onclick="buySubscription('weekly')">
                        <span class="sub-offer">🔥 Weekly Unlimited</span>
                        <span class="sub-details">Unlimited generations - $9.99/week</span>
                    </button>
                `;
            }
        }

        // Show referral section
        referralSection.style.display = 'block';
        referralLinkInput.value = getReferralLink() || '';

        // Show delete account button
        document.getElementById('delete-account-btn').style.display = 'block';

        // Get referral stats
        const referralCount = await getReferralCount();
        if (referralCount > 0) {
            referralStats.textContent = `${referralCount} friend${referralCount > 1 ? 's' : ''} invited • ${referralCount * 3} credits earned`;
        } else {
            referralStats.textContent = '';
        }
    } else {
        emailEl.textContent = 'Not signed in';
        usernameSection.style.display = 'none';
        signoutBtn.style.display = 'none';
        signinBtn.style.display = 'block';
        creditsSection.style.display = 'none';
        referralSection.style.display = 'none';
        document.getElementById('delete-account-btn').style.display = 'none';
    }
}

async function getReferralCount() {
    if (!currentUser || !supabaseClient) return 0;

    try {
        const { count } = await supabaseClient
            .from('referrals')
            .select('*', { count: 'exact', head: true })
            .eq('referrer_id', currentUser.id);

        return count || 0;
    } catch (e) {
        console.error('Get referral count failed:', e);
        return 0;
    }
}

// ===================
// USAGE TRACKING (2-day cooldown system)
// ===================
function getUsageData() {
    try {
        return JSON.parse(localStorage.getItem('unhinged_usage') || '{}');
    } catch {
        return {};
    }
}

function saveUsageData(data) {
    localStorage.setItem('unhinged_usage', JSON.stringify(data));
}

function getCooldownPeriodStart() {
    const now = new Date();
    const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / (1000 * 60 * 60 * 24));
    const periodNumber = Math.floor(dayOfYear / COOLDOWN_DAYS);
    const periodStart = new Date(now.getFullYear(), 0, periodNumber * COOLDOWN_DAYS + 1);
    return periodStart.toISOString().split('T')[0];
}

function getNextResetTime() {
    const now = new Date();
    const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / (1000 * 60 * 60 * 24));
    const periodNumber = Math.floor(dayOfYear / COOLDOWN_DAYS);
    const nextPeriodStart = new Date(now.getFullYear(), 0, (periodNumber + 1) * COOLDOWN_DAYS + 1);
    return nextPeriodStart;
}

// Cache for cloud usage count
let cachedCloudUsage = null;
let cachedCloudUsagePeriod = null;

async function getFreeUsageCount() {
    // If logged in, get count from cloud
    if (currentUser && supabaseClient) {
        const periodStart = getCooldownPeriodStart();

        // Use cache if same period
        if (cachedCloudUsagePeriod === periodStart && cachedCloudUsage !== null) {
            return cachedCloudUsage;
        }

        try {
            const startTime = new Date(periodStart + 'T00:00:00Z').toISOString();
            const { count } = await supabaseClient
                .from('generations')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', currentUser.id)
                .gte('created_at', startTime);

            cachedCloudUsage = count || 0;
            cachedCloudUsagePeriod = periodStart;
            return cachedCloudUsage;
        } catch (e) {
            console.error('Cloud usage check failed:', e);
        }
    }

    // Fallback to localStorage for anonymous users
    const data = getUsageData();
    const currentPeriod = getCooldownPeriodStart();

    if (data.period !== currentPeriod) return 0;
    return data.count || 0;
}

async function incrementUsage() {
    // Increment local cache immediately
    if (cachedCloudUsage !== null) {
        cachedCloudUsage++;
    }

    // Also update localStorage as backup
    const data = getUsageData();
    const currentPeriod = getCooldownPeriodStart();

    if (data.period !== currentPeriod) {
        data.count = 0;
        data.period = currentPeriod;
    }

    data.count = (data.count || 0) + 1;
    data.total = (data.total || 0) + 1;
    saveUsageData(data);

    await updateStats();
    await updateGenerateUsage();
}

function getFreeLimit() {
    return currentUser ? FREE_LIMIT_AUTHENTICATED : FREE_LIMIT_ANONYMOUS;
}

async function getRemainingFreeGenerations() {
    const used = await getFreeUsageCount();
    return Math.max(0, getFreeLimit() - used);
}

async function getRemainingGenerations() {
    const freeRemaining = await getRemainingFreeGenerations();
    return freeRemaining + purchasedCredits;
}

const SUBSCRIBER_WEEKLY_CAP = 150;

// Cache for subscriber usage (synced to cloud)
let cachedSubWeeklyUsage = null;

function getSubscriberWeeklyUsage() {
    if (!currentSubscription) return 0;

    const thisMonday = getMondayOfWeek(new Date());
    const lastReset = currentSubscription.weekly_reset ? new Date(currentSubscription.weekly_reset) : null;

    // If new week, usage should be 0 (will be reset on next increment)
    if (!lastReset || lastReset < thisMonday) {
        cachedSubWeeklyUsage = 0;
        return 0;
    }

    // Use cached value if available, otherwise use subscription data
    if (cachedSubWeeklyUsage !== null) {
        return cachedSubWeeklyUsage;
    }

    cachedSubWeeklyUsage = currentSubscription.weekly_usage || 0;
    return cachedSubWeeklyUsage;
}

async function incrementSubscriberUsage() {
    if (!currentSubscription || !supabaseClient) return;

    const thisMonday = getMondayOfWeek(new Date());
    const lastReset = currentSubscription.weekly_reset ? new Date(currentSubscription.weekly_reset) : null;
    const isNewWeek = !lastReset || lastReset < thisMonday;

    // Calculate new usage
    const newUsage = isNewWeek ? 1 : (currentSubscription.weekly_usage || 0) + 1;

    // Update cache immediately for responsive UI
    cachedSubWeeklyUsage = newUsage;

    // Update local total
    const data = getUsageData();
    data.total = (data.total || 0) + 1;
    saveUsageData(data);

    // Sync to cloud
    try {
        const { error } = await supabaseClient
            .from('subscriptions')
            .update({
                weekly_usage: newUsage,
                weekly_reset: isNewWeek ? thisMonday.toISOString() : currentSubscription.weekly_reset,
                updated_at: new Date().toISOString()
            })
            .eq('id', currentSubscription.id);

        if (!error) {
            // Update local subscription object
            currentSubscription.weekly_usage = newUsage;
            if (isNewWeek) {
                currentSubscription.weekly_reset = thisMonday.toISOString();
            }
        } else {
            console.error('Failed to sync subscriber usage:', error);
        }
    } catch (e) {
        console.error('Failed to sync subscriber usage:', e);
    }
}

async function canGenerate() {
    // Subscribers get unlimited (capped at 150/week)
    if (currentSubscription) {
        const weeklyUsage = getSubscriberWeeklyUsage();
        if (weeklyUsage < SUBSCRIBER_WEEKLY_CAP) {
            return true;
        }
        // Subscriber hit cap, can still use purchased credits
    }

    const freeRemaining = await getRemainingFreeGenerations();
    return freeRemaining > 0 || purchasedCredits > 0;
}

async function consumeGeneration() {
    // Subscribers use their weekly allowance first
    if (currentSubscription) {
        const weeklyUsage = getSubscriberWeeklyUsage();
        if (weeklyUsage < SUBSCRIBER_WEEKLY_CAP) {
            incrementSubscriberUsage();
            await updateStats();
            await updateGenerateUsage();
            scheduleReminder();
            return;
        }
        // Subscriber hit cap, fall through to use credits
    }

    const freeRemaining = await getRemainingFreeGenerations();

    if (freeRemaining > 0) {
        // Use free generation
        await incrementUsage();
    } else if (purchasedCredits > 0) {
        // Use purchased credit
        await useCredit();
        // Still track in usage data for history
        const data = getUsageData();
        data.total = (data.total || 0) + 1;
        saveUsageData(data);
    }

    // Update activity for notifications
    scheduleReminder();

    await updateStats();
    await updateGenerateUsage();
}

// ===================
// HISTORY (Cloud Sync)
// ===================
async function saveToHistory(matchName, openers, mode, analysis = null) {
    // Reset last generation ID
    lastGenerationId = null;

    // Always save to localStorage as backup
    const data = getUsageData();
    if (!data.history) data.history = [];

    const newItem = {
        id: Date.now(),
        matchName,
        openers,
        mode,
        analysis,
        date: new Date().toISOString()
    };

    data.history.unshift(newItem);
    data.history = data.history.slice(0, 50);
    saveUsageData(data);

    // If logged in, also save to Supabase
    if (currentUser && supabaseClient) {
        try {
            const { data: inserted, error } = await supabaseClient
                .from('generations')
                .insert({
                    user_id: currentUser.id,
                    match_name: matchName,
                    openers: openers,
                    mode: mode,
                    analysis: analysis
                })
                .select('id')
                .single();

            if (!error && inserted) {
                lastGenerationId = inserted.id;
                console.log('Saved to cloud, ID:', lastGenerationId);
            }
        } catch (error) {
            console.error('Cloud save failed:', error);
        }
    }
}

async function loadHistory() {
    const list = document.getElementById('history-list');
    const empty = document.getElementById('history-empty');

    let historyItems = [];

    // If logged in, fetch from Supabase
    if (currentUser && supabaseClient) {
        try {
            const { data, error } = await supabaseClient
                .from('generations')
                .select('*')
                .eq('user_id', currentUser.id)
                .order('created_at', { ascending: false })
                .limit(50);

            if (!error && data) {
                historyItems = data.map(item => ({
                    id: item.id,
                    matchName: item.match_name,
                    openers: item.openers,
                    mode: item.mode,
                    analysis: item.analysis,
                    date: item.created_at
                }));
                console.log('Loaded from cloud:', historyItems.length);
            }
        } catch (error) {
            console.error('Cloud load failed:', error);
        }
    }

    // Fallback to localStorage if no cloud data
    if (historyItems.length === 0) {
        const data = getUsageData();
        historyItems = data.history || [];
    }

    if (historyItems.length === 0) {
        empty.style.display = 'block';
        list.innerHTML = '<div class="empty-state" id="history-empty"><span class="empty-icon">📜</span><p>No history yet</p><span class="empty-hint">Your generated openers will appear here</span></div>';
        return;
    }

    empty.style.display = 'none';
    list.innerHTML = '';

    historyItems.forEach(item => {
        const div = document.createElement('div');
        div.className = 'history-item';
        div.onclick = () => showHistoryItem(item);

        const date = new Date(item.date);
        const timeAgo = getTimeAgo(date);
        const preview = item.openers[0]?.text?.slice(0, 50) + '...' || '';
        const hasAnalysis = item.analysis ? '<span class="history-badge">🧠</span>' : '';

        div.innerHTML = `
            <div class="history-item-header">
                <span class="history-item-name">${item.matchName || 'Unknown'} ${hasAnalysis}</span>
                <span class="history-item-date">${timeAgo}</span>
            </div>
            <div class="history-item-preview">${preview}</div>
        `;

        list.appendChild(div);
    });
}

function showHistoryItem(item) {
    currentOpeners = item.openers;
    currentAnalysis = item.analysis || null;
    document.getElementById('match-name').textContent = item.matchName || 'Match';
    displayOpeners(currentOpeners);
    updateAnalysisButton();
    showResults();
}

function getTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

// Migrate local history to cloud on first sign in
async function migrateLocalHistoryToCloud() {
    if (!currentUser || !supabaseClient) return;

    const data = getUsageData();
    if (!data.history || data.history.length === 0) return;

    // Check if user already has cloud data
    const { data: existing } = await supabaseClient
        .from('generations')
        .select('id')
        .eq('user_id', currentUser.id)
        .limit(1);

    if (existing && existing.length > 0) {
        console.log('User already has cloud data, skipping migration');
        return;
    }

    // Migrate local history to cloud
    console.log('Migrating local history to cloud...');
    for (const item of data.history.slice(0, 20)) { // Migrate last 20
        try {
            await supabaseClient.from('generations').insert({
                user_id: currentUser.id,
                match_name: item.matchName,
                openers: item.openers,
                mode: item.mode,
                created_at: item.date
            });
        } catch (e) {
            console.error('Migration item failed:', e);
        }
    }
    console.log('Migration complete');
}

// ===================
// CONVERSATION COACH
// ===================
let convoFile = null;
let convoResults = null;

function showConvo() {
    updateConvoUsage();
    showScreen('convo-screen');
}

function showConvoResults() {
    showScreen('convo-results-screen');
}

function resetConvo() {
    convoFile = null;
    convoResults = null;

    const preview = document.getElementById('convo-preview-image');
    const content = document.getElementById('convo-upload-content');
    const zone = document.getElementById('convo-upload-zone');
    const generateSection = document.getElementById('convo-generate-section');

    preview.style.display = 'none';
    content.style.display = 'flex';
    zone.classList.remove('has-image');
    generateSection.style.display = 'none';

    showConvo();
}

async function updateConvoUsage() {
    const el = document.getElementById('convo-usage');
    if (el) {
        const remaining = await getRemainingGenerations();
        el.textContent = `${remaining} left`;
    }
}

function handleConvoFileSelect(event) {
    const file = event.target.files[0];
    if (file) processConvoFile(file);
}

function processConvoFile(file) {
    convoFile = file;

    const reader = new FileReader();
    reader.onload = (e) => {
        const preview = document.getElementById('convo-preview-image');
        const content = document.getElementById('convo-upload-content');
        const zone = document.getElementById('convo-upload-zone');

        preview.src = e.target.result;
        preview.style.display = 'block';
        content.style.display = 'none';
        zone.classList.add('has-image');

        document.getElementById('convo-generate-section').style.display = 'block';
    };
    reader.readAsDataURL(file);
}

// Drag and drop for convo
const convoUploadZone = document.getElementById('convo-upload-zone');
if (convoUploadZone) {
    convoUploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        convoUploadZone.style.borderColor = '#ff6b6b';
    });

    convoUploadZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        if (!convoFile) convoUploadZone.style.borderColor = 'rgba(255,255,255,0.15)';
    });

    convoUploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file?.type.startsWith('image/')) processConvoFile(file);
    });
}

async function analyzeConvo() {
    if (!convoFile) {
        showToast('Upload a screenshot first');
        return;
    }

    const canGen = await canGenerate();
    if (!canGen) {
        showToast('No credits left!');
        return;
    }

    // Show credit cost info once per account
    if (!hasCreditCostInfoBeenShown()) {
        pendingGenerationType = 'convo';
        showCreditCostInfo();
        return;
    }

    analyzeConvoAfterCreditInfo();
}

async function analyzeConvoAfterCreditInfo() {
    const goal = document.querySelector('input[name="convo-goal"]:checked').value;
    showLoading();

    const loadingInterval = startLoadingMessages();
    const base64 = await fileToBase64(convoFile);
    const mediaType = convoFile.type || 'image/png';

    try {
        const response = await fetch('/api/analyze-convo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: base64, goal, mediaType })
        });

        const data = await response.json();
        clearInterval(loadingInterval);

        if (!response.ok) {
            showToast(data.message || 'Failed to analyze');
            showConvo();
            return;
        }

        convoResults = data;
        await consumeGeneration();
        displayConvoResults(data);
        showConvoResults();

    } catch (error) {
        clearInterval(loadingInterval);
        console.error(error);
        showToast('Error analyzing');
        showConvo();
    }
}

function displayConvoResults(data) {
    // Vibe
    document.getElementById('convo-vibe').textContent = data.vibe || 'Unknown';
    document.getElementById('convo-vibe').className = `convo-vibe-value vibe-${(data.vibe || '').toLowerCase()}`;

    // Last message (what we're replying to)
    const lastMsgEl = document.getElementById('convo-last-message');
    if (data.lastMessage) {
        lastMsgEl.textContent = `"${data.lastMessage}"`;
        document.getElementById('convo-replying-to').style.display = 'block';
    } else {
        document.getElementById('convo-replying-to').style.display = 'none';
    }

    // Summary
    document.getElementById('convo-summary').textContent = data.summary || 'No summary available';

    // Suggested responses
    const suggestionsEl = document.getElementById('convo-suggestions');
    suggestionsEl.innerHTML = '';

    (data.responses || []).forEach(resp => {
        const div = document.createElement('div');
        div.className = 'convo-suggestion';
        div.onclick = () => copyConvoResponse(resp.text, div);
        div.innerHTML = `
            <div class="suggestion-header">
                <span class="suggestion-emoji">${resp.emoji || '💬'}</span>
                <span class="suggestion-style">${resp.style || 'Suggested'}</span>
            </div>
            <p class="suggestion-text">${resp.text}</p>
        `;
        suggestionsEl.appendChild(div);
    });

    // Tips
    const tipsEl = document.getElementById('convo-tips-list');
    tipsEl.innerHTML = '';
    (data.tips || []).forEach(tip => {
        const li = document.createElement('li');
        li.textContent = tip;
        tipsEl.appendChild(li);
    });

    // Add avoid tip if present
    if (data.avoid) {
        const li = document.createElement('li');
        li.className = 'avoid-tip';
        li.textContent = `🚫 Avoid: ${data.avoid}`;
        tipsEl.appendChild(li);
    }
}

function copyConvoResponse(text, element) {
    navigator.clipboard.writeText(text);
    document.querySelectorAll('.convo-suggestion').forEach(s => s.classList.remove('copied'));
    element.classList.add('copied');
    showToast('Copied!');
    setTimeout(() => element.classList.remove('copied'), 2000);
}

async function shareConvoResults() {
    if (!convoResults?.responses?.length) return;

    const text = `UNHINGED AI suggests:\n\n"${convoResults.responses[0].text}"\n\nunhingedai.app`;

    if (navigator.share) {
        try {
            await navigator.share({ title: 'Unhinged', text });
            return;
        } catch {}
    }

    navigator.clipboard.writeText(text);
    showToast('Copied!');
}


// ===================
// FILE UPLOAD
// ===================
function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) processFile(file);
}

function processFile(file) {
    selectedFile = file;

    const reader = new FileReader();
    reader.onload = (e) => {
        const preview = document.getElementById('preview-image');
        const content = document.querySelector('.upload-content');
        const zone = document.getElementById('upload-zone');

        preview.src = e.target.result;
        preview.style.display = 'block';
        content.style.display = 'none';
        zone.classList.add('has-image');

        document.getElementById('generate-section').style.display = 'block';
    };
    reader.readAsDataURL(file);
}

// Drag and drop
const uploadZone = document.getElementById('upload-zone');
if (uploadZone) {
    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.style.borderColor = '#ff6b6b';
    });

    uploadZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        if (!selectedFile) uploadZone.style.borderColor = 'rgba(255,255,255,0.15)';
    });

    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file?.type.startsWith('image/')) processFile(file);
    });
}

// ===================
// MODE SUCCESS RATES
// ===================
let modeSuccessRates = {};

async function loadModeSuccessRates() {
    if (!supabaseClient) return;

    try {
        // Get all generations with feedback (aggregate across all users for better data)
        const { data: generations } = await supabaseClient
            .from('generations')
            .select('mode, feedback')
            .not('feedback', 'is', null);

        if (!generations || generations.length === 0) return;

        // Calculate success rates per mode
        const modeStats = {};
        const modes = ['chaotic', 'flirty', 'unhinged', 'mysterious', 'dadjoke', 'poetic'];

        modes.forEach(mode => {
            modeStats[mode] = { total: 0, success: 0 };
        });

        generations.forEach(gen => {
            const mode = gen.mode || 'chaotic';
            if (modeStats[mode]) {
                modeStats[mode].total++;
                if (gen.feedback === 'replied' || gen.feedback === 'date') {
                    modeStats[mode].success++;
                }
            }
        });

        // Calculate rates and find best mode
        let bestMode = null;
        let bestRate = 0;

        modes.forEach(mode => {
            const stats = modeStats[mode];
            if (stats.total >= 3) { // Need at least 3 data points
                const rate = Math.round((stats.success / stats.total) * 100);
                modeSuccessRates[mode] = rate;

                if (rate > bestRate) {
                    bestRate = rate;
                    bestMode = mode;
                }
            }
        });

        // Update UI
        displayModeSuccessRates(bestMode);
    } catch (e) {
        console.error('Failed to load mode success rates:', e);
    }
}

function displayModeSuccessRates(bestMode) {
    const modes = ['chaotic', 'flirty', 'unhinged', 'mysterious', 'dadjoke', 'poetic'];

    modes.forEach(mode => {
        const el = document.getElementById(`rate-${mode}`);
        if (!el) return;

        const rate = modeSuccessRates[mode];
        if (rate !== undefined) {
            if (mode === bestMode && rate > 0) {
                el.textContent = `🏆 ${rate}%`;
                el.classList.add('best');
            } else {
                el.textContent = `${rate}%`;
                el.classList.remove('best');
            }
        } else {
            el.textContent = '';
        }
    });
}

// ===================
// PREDICTIVE SCORING
// ===================
let lastUsedMode = 'chaotic';

async function displayPredictions(currentMode) {
    lastUsedMode = currentMode;
    const section = document.getElementById('predictions-section');
    const vibeEl = document.getElementById('predictions-vibe');
    const cardsEl = document.getElementById('predictions-cards');

    // Get vibe and interests from current analysis/profile
    const vibe = currentAnalysis?.vibe?.toLowerCase();
    const interests = currentProfile?.interests || currentAnalysis?.interests || [];

    if (!vibe && interests.length === 0) {
        section.style.display = 'none';
        return;
    }

    const modeEmojis = {
        chaotic: '🌀', flirty: '😏', unhinged: '🔥',
        mysterious: '🎭', dadjoke: '👨', poetic: '🎨'
    };

    const modeNames = {
        chaotic: 'Chaotic', flirty: 'Flirty', unhinged: 'Unhinged',
        mysterious: 'Mysterious', dadjoke: 'Dad Joke', poetic: 'Poetic'
    };

    try {
        // Try interest-based recommendations first
        let recommendations = null;
        let insight = null;

        if (interests.length > 0) {
            try {
                const recResponse = await fetch('/api/recommendations', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ interests, vibe, currentMode })
                });
                const recData = await recResponse.json();

                if (recData.recommendations?.length > 0) {
                    recommendations = recData.recommendations
                        .filter(r => r.mode !== currentMode)
                        .slice(0, 3);
                }

                if (recData.insights?.length > 0) {
                    insight = recData.insights[0];
                }
            } catch (e) {
                console.log('Interest recommendations unavailable');
            }
        }

        // Fall back to vibe-based predictions
        if (!recommendations || recommendations.length === 0) {
            if (!vibe) {
                section.style.display = 'none';
                return;
            }

            const response = await fetch(`/api/predictions/${encodeURIComponent(vibe)}`);
            const data = await response.json();

            if (!data.predictions || Object.keys(data.predictions).length === 0) {
                section.style.display = 'none';
                return;
            }

            recommendations = Object.entries(data.predictions)
                .filter(([mode]) => mode !== currentMode)
                .sort((a, b) => b[1].rate - a[1].rate)
                .slice(0, 3)
                .map(([mode, pred]) => ({ mode, rate: pred.rate }));
        }

        if (recommendations.length === 0) {
            section.style.display = 'none';
            return;
        }

        // Display insight if available, otherwise show vibe-based message
        if (insight) {
            vibeEl.innerHTML = `<strong>💡 ${insight.text}</strong>`;
        } else if (vibe) {
            vibeEl.textContent = `For ${vibe} profiles like this:`;
        } else {
            vibeEl.textContent = 'Based on similar profiles:';
        }

        cardsEl.innerHTML = recommendations.map((rec, idx) => {
            const isRecommended = idx === 0;
            return `
                <div class="prediction-card ${isRecommended ? 'recommended' : ''}" onclick="regenerateWithMode('${rec.mode}')">
                    <span class="prediction-emoji">${modeEmojis[rec.mode] || '✨'}</span>
                    <span class="prediction-mode">${modeNames[rec.mode] || rec.mode}</span>
                    <span class="prediction-rate">${rec.rate}%</span>
                </div>
            `;
        }).join('');

        section.style.display = 'block';
    } catch (e) {
        console.error('Failed to load predictions:', e);
        section.style.display = 'none';
    }
}

async function regenerateWithMode(mode) {
    // Store the selected mode and regenerate
    const modeRadio = document.querySelector(`input[name="mode"][value="${mode}"]`);
    if (modeRadio) {
        modeRadio.checked = true;
    }

    // Check for unhinged disclaimer
    if (mode === 'unhinged' && !unhingedDisclaimerAccepted) {
        showUnhingedDisclaimer();
        return;
    }

    await generateOpenersAfterDisclaimer();
}

// ===================
// UNHINGED DISCLAIMER
// ===================
let unhingedDisclaimerAccepted = false;

function showUnhingedDisclaimer() {
    document.getElementById('unhinged-disclaimer-modal').classList.remove('hidden');
}

function acceptUnhingedDisclaimer() {
    unhingedDisclaimerAccepted = true;
    document.getElementById('unhinged-disclaimer-modal').classList.add('hidden');
    // Continue with generation
    generateOpenersAfterDisclaimer();
}

function cancelUnhingedMode() {
    document.getElementById('unhinged-disclaimer-modal').classList.add('hidden');
    // Select a different mode (default to chaotic)
    const chaoticRadio = document.querySelector('input[name="mode"][value="chaotic"]');
    if (chaoticRadio) chaoticRadio.checked = true;
}

// ===================
// CREDIT COST INFO (one-time popup)
// ===================
let creditCostInfoShown = false;

function hasCreditCostInfoBeenShown() {
    // Check localStorage first (for non-logged-in users or quick check)
    if (localStorage.getItem('creditCostInfoShown') === 'true') {
        creditCostInfoShown = true;
        return true;
    }
    return creditCostInfoShown;
}

function showCreditCostInfo() {
    document.getElementById('credit-cost-modal').classList.remove('hidden');
}

function acceptCreditCostInfo() {
    creditCostInfoShown = true;
    localStorage.setItem('creditCostInfoShown', 'true');
    document.getElementById('credit-cost-modal').classList.add('hidden');
    // Continue with the generation flow
    continueAfterCreditInfo();
}

let pendingGenerationType = null; // 'openers' or 'convo'

function continueAfterCreditInfo() {
    if (pendingGenerationType === 'openers') {
        checkUnhingedAndGenerate();
    } else if (pendingGenerationType === 'convo') {
        analyzeConvoAfterCreditInfo();
    }
    pendingGenerationType = null;
}

function checkUnhingedAndGenerate() {
    const mode = document.querySelector('input[name="mode"]:checked').value;

    // Check if unhinged mode and disclaimer not accepted
    if (mode === 'unhinged' && !unhingedDisclaimerAccepted) {
        showUnhingedDisclaimer();
        return;
    }

    generateOpenersAfterDisclaimer();
}

// ===================
// GENERATE
// ===================
async function generateOpeners() {
    if (!selectedFile) {
        showToast('Upload a screenshot first');
        return;
    }

    const canGen = await canGenerate();
    if (!canGen) {
        const nextReset = getNextResetTime();
        const hoursUntil = Math.ceil((nextReset - new Date()) / (1000 * 60 * 60));
        showToast(`No generations left. Resets in ${hoursUntil}h or buy credits!`);
        return;
    }

    // Show credit cost info once per account
    if (!hasCreditCostInfoBeenShown()) {
        pendingGenerationType = 'openers';
        showCreditCostInfo();
        return;
    }

    checkUnhingedAndGenerate();
}

async function generateOpenersAfterDisclaimer() {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    showLoading();

    const loadingInterval = startLoadingMessages();
    const base64 = await fileToBase64(selectedFile);
    const mediaType = selectedFile.type || 'image/png';

    try {
        const response = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: base64, mode, mediaType })
        });

        const data = await response.json();
        clearInterval(loadingInterval);

        if (!response.ok || !data.openers?.length) {
            showToast(data.message || 'Failed to generate');
            showGenerate();
            return;
        }

        currentOpeners = data.openers;
        currentAnalysis = data.analysis;
        currentProfile = data.profile;
        await consumeGeneration();
        saveToHistory(data.matchName, data.openers, mode, data.analysis);

        document.getElementById('match-name').textContent = data.matchName || 'Match';
        displayOpeners(currentOpeners);
        updateAnalysisButton();
        showResults();

        // Fetch and display predictions for other modes
        await displayPredictions(mode);

    } catch (error) {
        clearInterval(loadingInterval);
        console.error(error);
        showToast('Error generating');
        showGenerate();
    }
}

function displayOpeners(openers) {
    const list = document.getElementById('openers-list');
    list.innerHTML = '';

    openers.forEach(opener => {
        const card = document.createElement('div');
        card.className = 'opener-card';
        card.onclick = () => copyOpener(opener.text, card);
        card.innerHTML = `
            <div class="opener-label">
                <span class="opener-emoji">${opener.emoji}</span>
                <span class="opener-type">${opener.type}</span>
            </div>
            <p class="opener-text">${opener.text}</p>
        `;
        list.appendChild(card);
    });
}

function copyOpener(text, card) {
    navigator.clipboard.writeText(text);
    document.querySelectorAll('.opener-card').forEach(c => c.classList.remove('copied'));
    card.classList.add('copied');
    showToast('Copied!');
    setTimeout(() => card.classList.remove('copied'), 2000);
}

// ===================
// FEEDBACK & SHARE
// ===================
let lastGenerationId = null;

async function recordFeedback(result) {
    document.querySelectorAll('.feedback-btn').forEach(b => b.classList.remove('selected'));
    event.target.classList.add('selected');

    const msgs = { sent: 'Good luck! 🤞', replied: 'Nice! 🎉', date: 'LEGEND! 🔥', blocked: 'Their loss 💀' };
    showToast(msgs[result] || 'Saved!');

    // Save feedback to cloud if logged in
    if (currentUser && supabaseClient && lastGenerationId) {
        try {
            await supabaseClient
                .from('generations')
                .update({ feedback: result, feedback_at: new Date().toISOString() })
                .eq('id', lastGenerationId);
            console.log('Feedback saved:', result);
        } catch (e) {
            console.error('Failed to save feedback:', e);
        }
    }

    // Update local stats
    const data = getUsageData();
    if (!data.feedbackStats) data.feedbackStats = { sent: 0, replied: 0, date: 0, blocked: 0 };
    data.feedbackStats[result] = (data.feedbackStats[result] || 0) + 1;
    saveUsageData(data);

    // Update all stats across the app
    await updateStats();

    // Invalidate caches so next view is fresh
    analyticsCache = null;
    modeSuccessRates = {};
}

async function shareResults() {
    if (!currentOpeners.length) return;

    const text = `UNHINGED AI told me to send this:\n\n"${currentOpeners[0].text}"\n\nunhinged.app`;

    if (navigator.share) {
        try {
            await navigator.share({ title: 'Unhinged', text });
            return;
        } catch {}
    }

    navigator.clipboard.writeText(text);
    showToast('Copied!');
}

// ===================
// UTILITIES
// ===================
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

const loadingMessages = [
    "Stalking their Spotify...",
    "Reading their trauma...",
    "Consulting dating gods...",
    "Analyzing red flags...",
    "Channeling chaos...",
    "Summoning wingman spirits...",
    "Decoding their vibe...",
    "Activating rizz protocol..."
];

function startLoadingMessages() {
    let i = 0;
    const el = document.getElementById('loading-text');
    el.textContent = loadingMessages[0];

    return setInterval(() => {
        i = (i + 1) % loadingMessages.length;
        el.textContent = loadingMessages[i];
    }, 1500);
}

function showToast(msg) {
    document.querySelector('.toast')?.remove();
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
}

// ===================
// ADMIN PANEL
// ===================

let isAdmin = false;
let adminRole = null;
let canManageAdmins = false;
let allUsers = [];
let selectedUserId = null;

async function checkAdminStatus() {
    if (!currentUser || !supabaseClient) {
        isAdmin = false;
        adminRole = null;
        canManageAdmins = false;
        return;
    }

    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (!session?.access_token) {
            isAdmin = false;
            adminRole = null;
            canManageAdmins = false;
            return;
        }

        const response = await fetch('/api/admin/check', {
            headers: { 'Authorization': `Bearer ${session.access_token}` }
        });
        const data = await response.json();
        isAdmin = data.isAdmin;
        adminRole = data.role;
        canManageAdmins = data.canManageAdmins;

        // Show/hide admin button in settings
        const adminBtn = document.getElementById('settings-admin-btn');
        if (adminBtn) {
            adminBtn.classList.toggle('hidden', !isAdmin);
        }

        // Show/hide admin management tabs (only for super_admin and owner)
        const adminsTabBtn = document.getElementById('admins-tab-btn');
        const logsTabBtn = document.getElementById('logs-tab-btn');
        if (adminsTabBtn) adminsTabBtn.classList.toggle('hidden', !canManageAdmins);
        if (logsTabBtn) logsTabBtn.classList.toggle('hidden', !canManageAdmins);
    } catch (e) {
        console.error('Admin check failed:', e);
        isAdmin = false;
        adminRole = null;
        canManageAdmins = false;
    }
}

function showAdmin() {
    if (!isAdmin) {
        showToast('Unauthorized');
        return;
    }
    showScreen('admin-screen');
    switchAdminTab('dashboard');
}

function switchAdminTab(tab) {
    // Update tab buttons
    document.querySelectorAll('.admin-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    // Update tab content
    document.querySelectorAll('.admin-content').forEach(content => {
        content.classList.add('hidden');
    });
    document.getElementById(`admin-tab-${tab}`)?.classList.remove('hidden');

    // Load data for the tab
    switch(tab) {
        case 'dashboard':
            loadDashboardStats();
            break;
        case 'users':
            loadAdminUsers();
            break;
        case 'activity':
            loadActivity();
            break;
        case 'payments':
            loadPayments();
            break;
        case 'subs':
            loadSubscriptions();
            break;
        case 'admins':
            loadAdmins();
            break;
        case 'logs':
            loadAdminLogs();
            break;
    }
}

function refreshAdmin() {
    const activeTab = document.querySelector('.admin-tab.active')?.dataset.tab || 'dashboard';
    switchAdminTab(activeTab);
    showToast('Refreshed');
}

async function loadDashboardStats() {
    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const response = await fetch('/api/admin/stats', {
            headers: { 'Authorization': `Bearer ${session.access_token}` }
        });

        if (!response.ok) throw new Error('Failed to load stats');

        const stats = await response.json();

        document.getElementById('dash-users').textContent = stats.totalUsers || 0;
        document.getElementById('dash-active').textContent = stats.activeToday || 0;
        document.getElementById('dash-revenue').textContent = `$${(stats.totalRevenue || 0).toFixed(0)}`;
        document.getElementById('dash-subs').textContent = stats.activeSubscriptions || 0;
        document.getElementById('dash-gens').textContent = stats.totalGenerations || 0;
        document.getElementById('dash-credits').textContent = stats.totalCreditsInCirculation || 0;
    } catch (e) {
        console.error('Load dashboard stats error:', e);
    }
}

async function loadActivity() {
    const container = document.getElementById('admin-activity-list');
    container.innerHTML = '<div class="analytics-loading">Loading activity...</div>';

    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const response = await fetch('/api/admin/activity', {
            headers: { 'Authorization': `Bearer ${session.access_token}` }
        });

        if (!response.ok) throw new Error('Failed to load activity');

        const data = await response.json();
        const activity = data.activity || [];

        if (activity.length === 0) {
            container.innerHTML = '<p class="breakdown-empty">No recent activity</p>';
            return;
        }

        container.innerHTML = activity.map(item => {
            const time = new Date(item.created_at).toLocaleString();
            if (item.type === 'generation') {
                return `
                    <div class="admin-activity-item">
                        <div class="activity-icon">🎯</div>
                        <div class="activity-details">
                            <span class="activity-email">${item.email}</span>
                            <span class="activity-desc">Generated for "${item.match_name || 'Unknown'}"</span>
                            <span class="activity-time">${time}</span>
                        </div>
                    </div>
                `;
            } else if (item.type === 'payment') {
                return `
                    <div class="admin-activity-item payment">
                        <div class="activity-icon">💰</div>
                        <div class="activity-details">
                            <span class="activity-email">${item.email}</span>
                            <span class="activity-desc">Paid $${(item.amount / 100).toFixed(2)} for ${item.credits} credits</span>
                            <span class="activity-time">${time}</span>
                        </div>
                    </div>
                `;
            }
            return '';
        }).join('');
    } catch (e) {
        console.error('Load activity error:', e);
        container.innerHTML = '<p class="breakdown-empty">Failed to load activity</p>';
    }
}

async function loadPayments() {
    const container = document.getElementById('admin-payments-list');
    container.innerHTML = '<div class="analytics-loading">Loading payments...</div>';

    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const response = await fetch('/api/admin/payments', {
            headers: { 'Authorization': `Bearer ${session.access_token}` }
        });

        if (!response.ok) throw new Error('Failed to load payments');

        const data = await response.json();

        if (data.payments.length === 0) {
            container.innerHTML = '<p class="breakdown-empty">No payments yet</p>';
            return;
        }

        container.innerHTML = data.payments.map(payment => {
            const date = new Date(payment.created_at).toLocaleDateString();
            return `
                <div class="admin-payment-item">
                    <div class="payment-info">
                        <span class="payment-email">${payment.email}</span>
                        <span class="payment-date">${date}</span>
                    </div>
                    <div class="payment-details">
                        <span class="payment-amount">$${(payment.amount / 100).toFixed(2)}</span>
                        <span class="payment-credits">+${payment.credits} credits</span>
                        <span class="payment-type">${payment.type || 'one_time'}</span>
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error('Load payments error:', e);
        container.innerHTML = '<p class="breakdown-empty">Failed to load payments</p>';
    }
}

async function loadSubscriptions() {
    const container = document.getElementById('admin-subs-list');
    container.innerHTML = '<div class="analytics-loading">Loading subscriptions...</div>';

    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const response = await fetch('/api/admin/subscriptions', {
            headers: { 'Authorization': `Bearer ${session.access_token}` }
        });

        if (!response.ok) throw new Error('Failed to load subscriptions');

        const data = await response.json();

        if (data.subscriptions.length === 0) {
            container.innerHTML = '<p class="breakdown-empty">No subscriptions yet</p>';
            return;
        }

        container.innerHTML = data.subscriptions.map(sub => {
            const started = new Date(sub.created_at).toLocaleDateString();
            const statusClass = sub.status === 'active' ? 'active' : 'inactive';
            return `
                <div class="admin-sub-item">
                    <div class="sub-info">
                        <span class="sub-email">${sub.email}</span>
                        <span class="sub-started">Since ${started}</span>
                    </div>
                    <div class="sub-details">
                        <span class="sub-status ${statusClass}">${sub.status}</span>
                        <span class="sub-usage">${sub.weekly_usage || 0}/${sub.credits_per_period} used</span>
                        ${sub.status === 'active' ? `<button class="sub-cancel-btn" onclick="adminCancelSubscription('${sub.id}', '${sub.stripe_subscription_id}')">Cancel</button>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error('Load subscriptions error:', e);
        container.innerHTML = '<p class="breakdown-empty">Failed to load subscriptions</p>';
    }
}

async function adminCancelSubscription(subId, stripeSubId) {
    if (!confirm('Cancel this subscription? The user will lose their weekly credits.')) return;

    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const response = await fetch('/api/admin/cancel-subscription', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({ subscriptionId: stripeSubId })
        });

        if (!response.ok) throw new Error('Failed to cancel');

        showToast('Subscription cancelled');
        loadSubscriptions();
    } catch (e) {
        console.error('Cancel subscription error:', e);
        showToast('Failed to cancel subscription');
    }
}

// ===================
// ADMIN MANAGEMENT
// ===================

async function loadAdmins() {
    const container = document.getElementById('admin-admins-list');
    container.innerHTML = '<div class="analytics-loading">Loading admins...</div>';

    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const response = await fetch('/api/admin/admins', {
            headers: { 'Authorization': `Bearer ${session.access_token}` }
        });

        if (!response.ok) throw new Error('Failed to load admins');

        const data = await response.json();

        if (data.admins.length === 0) {
            container.innerHTML = '<p class="breakdown-empty">No admins found</p>';
            return;
        }

        container.innerHTML = data.admins.map(admin => {
            const roleColors = {
                'owner': '#ffd700',
                'super_admin': '#ff6b6b',
                'admin': '#4ade80',
                'moderator': '#60a5fa'
            };
            const roleLabels = {
                'owner': 'Owner',
                'super_admin': 'Super Admin',
                'admin': 'Admin',
                'moderator': 'Moderator'
            };
            const canModify = canManageAdmins && !admin.isOwner && (adminRole === 'owner' || admin.role !== 'super_admin');

            return `
                <div class="admin-admin-item">
                    <div class="admin-admin-info">
                        <span class="admin-admin-email">${admin.email}</span>
                        <span class="admin-admin-role" style="color: ${roleColors[admin.role]}">${roleLabels[admin.role]}</span>
                    </div>
                    <div class="admin-admin-actions">
                        ${canModify ? `
                            <select class="admin-role-select" onchange="updateAdminRole('${admin.id}', this.value)" ${admin.isOwner ? 'disabled' : ''}>
                                <option value="moderator" ${admin.role === 'moderator' ? 'selected' : ''}>Moderator</option>
                                <option value="admin" ${admin.role === 'admin' ? 'selected' : ''}>Admin</option>
                                ${adminRole === 'owner' ? `<option value="super_admin" ${admin.role === 'super_admin' ? 'selected' : ''}>Super Admin</option>` : ''}
                            </select>
                            <button class="admin-remove-btn" onclick="removeAdmin('${admin.id}', '${admin.email}')">Remove</button>
                        ` : `
                            <span class="admin-badge ${admin.isOwner ? 'owner' : ''}">${admin.isOwner ? 'Protected' : ''}</span>
                        `}
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error('Load admins error:', e);
        container.innerHTML = '<p class="breakdown-empty">Failed to load admins</p>';
    }
}

async function loadAdminLogs() {
    const container = document.getElementById('admin-logs-list');
    container.innerHTML = '<div class="analytics-loading">Loading logs...</div>';

    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const response = await fetch('/api/admin/logs', {
            headers: { 'Authorization': `Bearer ${session.access_token}` }
        });

        if (!response.ok) throw new Error('Failed to load logs');

        const data = await response.json();

        if (data.logs.length === 0) {
            container.innerHTML = '<p class="breakdown-empty">No admin activity yet</p>';
            return;
        }

        const actionLabels = {
            'add_admin': 'Added admin',
            'remove_admin': 'Removed admin',
            'update_admin_role': 'Changed role',
            'add_credits': 'Added credits',
            'remove_credits': 'Removed credits',
            'delete_user': 'Deleted user'
        };

        container.innerHTML = data.logs.map(log => {
            const time = new Date(log.created_at).toLocaleString();
            const action = actionLabels[log.action] || log.action;
            return `
                <div class="admin-log-item">
                    <div class="log-action">${action}</div>
                    <div class="log-details">
                        <span class="log-admin">${log.admin_email}</span>
                        <span class="log-target">${log.target_email}</span>
                        ${log.details ? `<span class="log-extra">${JSON.stringify(log.details)}</span>` : ''}
                    </div>
                    <div class="log-time">${time}</div>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error('Load admin logs error:', e);
        container.innerHTML = '<p class="breakdown-empty">Failed to load logs</p>';
    }
}

function showAddAdminModal() {
    document.getElementById('new-admin-email').value = '';
    document.getElementById('new-admin-role').value = 'admin';
    updateRoleDescription();
    document.getElementById('add-admin-modal').classList.remove('hidden');
}

function closeAddAdminModal() {
    document.getElementById('add-admin-modal').classList.add('hidden');
}

function updateRoleDescription() {
    const role = document.getElementById('new-admin-role').value;
    document.querySelectorAll('.role-desc').forEach(el => el.style.display = 'none');
    const desc = document.getElementById(`role-desc-${role}`);
    if (desc) desc.style.display = 'block';
}

async function submitNewAdmin() {
    const email = document.getElementById('new-admin-email').value.trim();
    const role = document.getElementById('new-admin-role').value;

    if (!email) {
        showToast('Enter an email address');
        return;
    }

    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const response = await fetch('/api/admin/admins', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({ email, role })
        });

        const data = await response.json();

        if (!response.ok) {
            showToast(data.error || 'Failed to add admin');
            return;
        }

        showToast(`Added ${email} as ${role}`);
        closeAddAdminModal();
        loadAdmins();
    } catch (e) {
        console.error('Add admin error:', e);
        showToast('Failed to add admin');
    }
}

async function updateAdminRole(userId, newRole) {
    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const response = await fetch(`/api/admin/admins/${userId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({ role: newRole })
        });

        const data = await response.json();

        if (!response.ok) {
            showToast(data.error || 'Failed to update role');
            loadAdmins(); // Refresh to reset select
            return;
        }

        showToast(`Role updated to ${newRole}`);
    } catch (e) {
        console.error('Update admin role error:', e);
        showToast('Failed to update role');
        loadAdmins();
    }
}

async function removeAdmin(userId, email) {
    if (!confirm(`Remove ${email} from admins? They will lose all admin access.`)) return;

    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const response = await fetch(`/api/admin/admins/${userId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${session.access_token}` }
        });

        const data = await response.json();

        if (!response.ok) {
            showToast(data.error || 'Failed to remove admin');
            return;
        }

        showToast('Admin removed');
        loadAdmins();
    } catch (e) {
        console.error('Remove admin error:', e);
        showToast('Failed to remove admin');
    }
}

async function loadAdminUsers() {
    const container = document.getElementById('admin-users-list');
    container.innerHTML = '<div class="analytics-loading">Loading users...</div>';

    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const response = await fetch('/api/admin/users', {
            headers: { 'Authorization': `Bearer ${session.access_token}` }
        });

        if (!response.ok) throw new Error('Failed to load');

        const data = await response.json();
        allUsers = data.users || [];

        renderAdminUsers(allUsers);
    } catch (e) {
        console.error('Load admin users error:', e);
        container.innerHTML = '<p class="breakdown-empty">Failed to load users</p>';
    }
}

function renderAdminUsers(users) {
    const container = document.getElementById('admin-users-list');

    if (users.length === 0) {
        container.innerHTML = '<p class="breakdown-empty">No users found</p>';
        return;
    }

    container.innerHTML = users.map(user => {
        const joined = new Date(user.created_at).toLocaleDateString();
        const provider = user.provider === 'google' ? '🔵' : '📧';
        return `
            <div class="admin-user-card" onclick="showUserDetails('${user.id}')">
                <div class="admin-user-info">
                    <span class="admin-user-email">${provider} ${user.email}</span>
                    <span class="admin-user-meta">Joined ${joined}</span>
                </div>
                <div class="admin-user-stats">
                    <div class="admin-user-stat credits">
                        <span class="admin-user-stat-value">${user.credits}</span>
                        <span class="admin-user-stat-label">Credits</span>
                    </div>
                    <div class="admin-user-stat">
                        <span class="admin-user-stat-value">${user.generations}</span>
                        <span class="admin-user-stat-label">Gens</span>
                    </div>
                    <button class="admin-add-btn" onclick="event.stopPropagation(); openAddCredits('${user.id}', '${user.email}')">+</button>
                </div>
            </div>
        `;
    }).join('');
}

function filterAdminUsers() {
    const search = document.getElementById('admin-search').value.toLowerCase().trim();
    if (!search) {
        renderAdminUsers(allUsers);
        return;
    }
    const filtered = allUsers.filter(u => u.email.toLowerCase().includes(search));
    renderAdminUsers(filtered);
}

function refreshAdminUsers() {
    loadAdminUsers();
    showToast('Refreshed');
}

function openAddCredits(userId, email) {
    selectedUserId = userId;
    document.getElementById('admin-credits-email').textContent = email;
    document.getElementById('admin-credits-amount').value = 5;
    document.getElementById('admin-credits-amount').removeAttribute('max');
    document.getElementById('admin-credits-reason').value = '';
    document.getElementById('admin-credits-modal').classList.remove('hidden');
    document.getElementById('admin-credits-modal').dataset.mode = 'add';
}

function closeAdminCreditsModal() {
    document.getElementById('admin-credits-modal').classList.add('hidden');
    document.getElementById('admin-credits-modal').dataset.mode = '';
    selectedUserId = null;
}

async function submitAdminCredits() {
    if (!selectedUserId) return;

    const modal = document.getElementById('admin-credits-modal');
    const isRemove = modal.dataset.mode === 'remove';
    const amount = parseInt(document.getElementById('admin-credits-amount').value);
    const reason = document.getElementById('admin-credits-reason').value.trim();

    if (!amount || amount < 1) {
        showToast('Enter a valid amount');
        return;
    }

    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const response = await fetch('/api/admin/modify-credits', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({
                userId: selectedUserId,
                amount: isRemove ? -amount : amount,
                reason: reason || (isRemove ? 'Admin removed credits' : 'Admin added credits')
            })
        });

        const data = await response.json();

        if (!response.ok) throw new Error(data.error);

        showToast(isRemove ? `Removed ${amount} credits` : `Added ${amount} credits!`);
        closeAdminCreditsModal();
        loadAdminUsers();

        // Also refresh user details modal if open
        const userModal = document.getElementById('admin-user-modal');
        if (!userModal.classList.contains('hidden')) {
            showUserDetails(selectedUserId);
        }
    } catch (e) {
        console.error('Modify credits error:', e);
        showToast(isRemove ? 'Failed to remove credits' : 'Failed to add credits');
    }
}

let currentUserProfile = null;

async function showUserDetails(userId) {
    const modal = document.getElementById('admin-user-modal');
    const container = document.getElementById('admin-user-details');

    modal.classList.remove('hidden');
    container.innerHTML = '<div class="analytics-loading">Loading user...</div>';

    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const response = await fetch(`/api/admin/user/${userId}`, {
            headers: { 'Authorization': `Bearer ${session.access_token}` }
        });

        if (!response.ok) throw new Error('Failed to load user');

        const data = await response.json();
        currentUserProfile = data;

        const user = data.user;
        const credits = data.credits || { balance: 0, total_purchased: 0 };
        const generations = data.generations || [];
        const payments = data.payments || [];
        const subscription = data.subscription;

        const joined = new Date(user.created_at).toLocaleDateString();
        const lastSeen = user.last_sign_in ? new Date(user.last_sign_in).toLocaleString() : 'Never';
        const provider = user.provider === 'google' ? '🔵 Google' : '📧 Email';
        const totalSpent = payments.reduce((sum, p) => sum + (p.amount || 0), 0) / 100;

        container.innerHTML = `
            <div class="profile-header">
                <div class="profile-avatar-large">${user.email.charAt(0).toUpperCase()}</div>
                <div class="profile-header-info">
                    <h2 class="profile-email">${user.email}</h2>
                    <span class="profile-provider">${provider}</span>
                    <span class="profile-joined">Joined ${joined}</span>
                </div>
            </div>

            <div class="profile-stats-grid">
                <div class="profile-stat">
                    <span class="profile-stat-value">${credits.balance}</span>
                    <span class="profile-stat-label">Credits</span>
                </div>
                <div class="profile-stat">
                    <span class="profile-stat-value">${generations.length}</span>
                    <span class="profile-stat-label">Generations</span>
                </div>
                <div class="profile-stat highlight">
                    <span class="profile-stat-value">$${totalSpent.toFixed(0)}</span>
                    <span class="profile-stat-label">Spent</span>
                </div>
                <div class="profile-stat">
                    <span class="profile-stat-value">${subscription ? '✓' : '✗'}</span>
                    <span class="profile-stat-label">Subscriber</span>
                </div>
            </div>

            <div class="profile-info-section">
                <div class="profile-info-row">
                    <span class="info-label">User ID</span>
                    <span class="info-value small">${user.id}</span>
                </div>
                <div class="profile-info-row">
                    <span class="info-label">Last Active</span>
                    <span class="info-value">${lastSeen}</span>
                </div>
                ${subscription ? `
                <div class="profile-info-row">
                    <span class="info-label">Subscription</span>
                    <span class="info-value">${subscription.status} (${subscription.weekly_usage || 0}/${subscription.credits_per_period} weekly)</span>
                </div>
                ` : ''}
            </div>

            <div class="profile-actions">
                <button class="profile-btn add" onclick="openAddCredits('${user.id}', '${user.email}')">+ Add Credits</button>
                <button class="profile-btn remove" onclick="openRemoveCredits('${user.id}', '${user.email}', ${credits.balance})">- Remove</button>
                <button class="profile-btn delete" onclick="adminDeleteUser('${user.id}', '${user.email}')">Delete</button>
            </div>

            <div class="profile-tabs">
                <button class="profile-tab active" onclick="switchProfileTab('generations')">Generations (${generations.length})</button>
                <button class="profile-tab" onclick="switchProfileTab('payments')">Payments (${payments.length})</button>
            </div>

            <div class="profile-tab-content" id="profile-tab-generations">
                ${generations.length === 0 ? '<p class="empty-state">No generations yet</p>' : `
                    <div class="generations-list">
                        ${generations.map((gen, idx) => {
                            const date = new Date(gen.created_at).toLocaleString();
                            const openers = gen.openers || [];
                            const modeLabel = gen.mode === 'unhinged' ? '🔥 Unhinged' : '💬 Normal';
                            return `
                                <div class="generation-card" onclick="toggleGeneration(${idx})">
                                    <div class="gen-header">
                                        <span class="gen-name">${gen.match_name || 'Unknown'}</span>
                                        <span class="gen-mode">${modeLabel}</span>
                                    </div>
                                    <div class="gen-date">${date}</div>
                                    <div class="gen-openers hidden" id="gen-openers-${idx}">
                                        ${openers.map((opener, i) => `
                                            <div class="gen-opener">
                                                <span class="opener-num">${i + 1}</span>
                                                <span class="opener-text">${opener}</span>
                                            </div>
                                        `).join('')}
                                        ${gen.feedback ? `<div class="gen-feedback">Feedback: ${gen.feedback}</div>` : ''}
                                    </div>
                                    <div class="gen-expand">Click to ${openers.length > 0 ? 'see openers' : 'expand'}</div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                `}
            </div>

            <div class="profile-tab-content hidden" id="profile-tab-payments">
                ${payments.length === 0 ? '<p class="empty-state">No payments yet</p>' : `
                    <div class="payments-list">
                        ${payments.map(payment => {
                            const date = new Date(payment.created_at).toLocaleString();
                            return `
                                <div class="payment-card">
                                    <div class="payment-amount">$${(payment.amount / 100).toFixed(2)}</div>
                                    <div class="payment-info">
                                        <span class="payment-credits">+${payment.credits} credits</span>
                                        <span class="payment-type">${payment.type || 'one_time'}</span>
                                    </div>
                                    <div class="payment-date">${date}</div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                `}
            </div>
        `;
    } catch (e) {
        console.error('Load user details error:', e);
        container.innerHTML = '<p class="breakdown-empty">Failed to load user details</p>';
    }
}

function switchProfileTab(tab) {
    document.querySelectorAll('.profile-tab').forEach(btn => {
        btn.classList.toggle('active', btn.textContent.toLowerCase().includes(tab));
    });
    document.querySelectorAll('.profile-tab-content').forEach(content => {
        content.classList.add('hidden');
    });
    document.getElementById(`profile-tab-${tab}`)?.classList.remove('hidden');
}

function toggleGeneration(idx) {
    const el = document.getElementById(`gen-openers-${idx}`);
    if (el) {
        el.classList.toggle('hidden');
    }
}

function closeUserDetailsModal() {
    document.getElementById('admin-user-modal').classList.add('hidden');
}

function openRemoveCredits(userId, email, currentBalance) {
    selectedUserId = userId;
    document.getElementById('admin-credits-email').textContent = `${email} (has ${currentBalance} credits)`;
    document.getElementById('admin-credits-amount').value = 1;
    document.getElementById('admin-credits-amount').max = currentBalance;
    document.getElementById('admin-credits-reason').value = '';
    document.getElementById('admin-credits-modal').classList.remove('hidden');
    document.getElementById('admin-credits-modal').dataset.mode = 'remove';
}

async function adminDeleteUser(userId, email) {
    if (!confirm(`DELETE user ${email}? This will remove ALL their data including generations, credits, and payment history. This cannot be undone!`)) return;

    if (!confirm(`Are you SURE? Type 'DELETE' in the next prompt to confirm.`)) return;

    const confirmation = prompt(`Type DELETE to permanently remove ${email}:`);
    if (confirmation !== 'DELETE') {
        showToast('Deletion cancelled');
        return;
    }

    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const response = await fetch(`/api/admin/user/${userId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${session.access_token}` }
        });

        if (!response.ok) throw new Error('Failed to delete');

        showToast('User deleted');
        closeUserDetailsModal();
        loadAdminUsers();
    } catch (e) {
        console.error('Delete user error:', e);
        showToast('Failed to delete user');
    }
}

// ===================
// EVENT LISTENERS
// ===================
function setupListeners() {
    // Login
    document.getElementById('google-signin-btn')?.addEventListener('click', signInWithGoogle);
    document.getElementById('email-signin-btn')?.addEventListener('click', showEmailAuth);

    // Settings
    document.getElementById('settings-btn')?.addEventListener('click', showSettings);
    document.getElementById('close-settings-modal')?.addEventListener('click', closeSettings);
    document.getElementById('settings-signout-btn')?.addEventListener('click', signOut);
    document.getElementById('settings-signin-btn')?.addEventListener('click', () => {
        closeSettings();
        showLogin();
    });
    document.getElementById('delete-account-btn')?.addEventListener('click', deleteAccount);

    // Username save
    document.getElementById('save-username-btn')?.addEventListener('click', async () => {
        const input = document.getElementById('settings-username');
        const username = input.value.trim();
        if (username) {
            await saveUsername(username);
        }
    });

    // Role description toggle in add admin modal
    document.getElementById('new-admin-role')?.addEventListener('change', updateRoleDescription);

    // Close modals when clicking outside (on backdrop)
    const modals = [
        { id: 'settings-modal', close: closeSettings },
        { id: 'analytics-modal', close: closeAnalytics },
        { id: 'credits-breakdown-modal', close: () => closeBreakdown('credits') },
        { id: 'generated-breakdown-modal', close: () => closeBreakdown('generated') },
        { id: 'success-breakdown-modal', close: () => closeBreakdown('success') },
        { id: 'feedback-prompt-modal', close: closeFeedbackPrompt },
        { id: 'unhinged-disclaimer-modal', close: cancelUnhingedMode },
        { id: 'admin-credits-modal', close: closeAdminCreditsModal },
        { id: 'admin-user-modal', close: closeUserDetailsModal },
        { id: 'add-admin-modal', close: closeAddAdminModal }
    ];

    modals.forEach(({ id, close }) => {
        const modal = document.getElementById(id);
        if (modal) {
            modal.addEventListener('click', (e) => {
                // Only close if clicking directly on backdrop, not on content
                if (e.target === modal) {
                    close();
                }
            });
        }
    });
}

// ===================
// INIT
// ===================
document.addEventListener('DOMContentLoaded', async () => {
    console.log('Unhinged loaded');
    setupListeners();

    // Check for referral code in URL first
    checkReferral();

    // Initialize notifications
    initNotifications();

    await initSupabase();

    // Check for payment success/cancel
    await checkPaymentStatus();

    if (currentUser) {
        showHome();
    } else {
        showLogin();
    }
});
