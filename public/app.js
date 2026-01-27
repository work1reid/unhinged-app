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
const FREE_LIMIT_ANONYMOUS = 3;
const FREE_LIMIT_AUTHENTICATED = 10;
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
            await loadSubscription();
        }

        supabaseClient.auth.onAuthStateChange(async (event, session) => {
            console.log('Auth:', event);
            currentUser = session?.user || null;

            if (event === 'SIGNED_IN') {
                // Load username, credits, subscription and migrate history
                await loadUsername();
                await loadCredits();
                await loadSubscription();
                await migrateLocalHistoryToCloud();
                await processReferralOnSignup();
                showHome();
                showToast('Signed in!');
            } else if (event === 'SIGNED_OUT') {
                currentUsername = null;
                purchasedCredits = 0;
                currentSubscription = null;
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

async function signOut() {
    if (!supabaseClient) return;
    await supabaseClient.auth.signOut();
    currentUser = null;
    currentUsername = null;
    showLogin();
    showToast('Signed out');
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
            return data;
        }
    } catch (e) {
        console.log('No active subscription');
    }
    currentSubscription = null;
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
async function showAnalytics() {
    if (!currentUser) {
        showToast('Sign in to see analytics');
        return;
    }

    const modal = document.getElementById('analytics-modal');
    modal.classList.remove('hidden');

    await loadAnalytics();
}

function closeAnalytics() {
    document.getElementById('analytics-modal').classList.add('hidden');
}

async function loadAnalytics() {
    const container = document.getElementById('analytics-content');
    container.innerHTML = '<div class="analytics-loading">Loading stats...</div>';

    if (!currentUser || !supabaseClient) {
        container.innerHTML = '<p>Sign in to see analytics</p>';
        return;
    }

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
            showToast(`🎉 Subscribed! 25 credits added weekly.`);
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
    const freeRemaining = await getRemainingFreeGenerations();
    const totalRemaining = freeRemaining + purchasedCredits;
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

    // Show/hide buy credits section when running low
    if (packsSection) {
        const freeRemaining = await getRemainingFreeGenerations();
        packsSection.style.display = (freeRemaining <= 3 && currentUser) ? 'block' : 'none';
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
                        <span class="sub-plan">Weekly Pro - 25 credits/week</span>
                    </div>
                    <button class="btn-cancel-sub" onclick="cancelSubscription()">Cancel Subscription</button>
                `;
            } else {
                subscriptionStatus.innerHTML = `
                    <button class="btn-subscribe" onclick="buySubscription('weekly')">
                        <span class="sub-offer">🔥 Weekly Pro</span>
                        <span class="sub-details">25 credits every week</span>
                    </button>
                `;
            }
        }

        // Show referral section
        referralSection.style.display = 'block';
        referralLinkInput.value = getReferralLink() || '';

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

async function canGenerate() {
    const freeRemaining = await getRemainingFreeGenerations();
    return freeRemaining > 0 || purchasedCredits > 0;
}

async function consumeGeneration() {
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

    // Invalidate analytics cache so next view is fresh
    analyticsCache = null;
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
// EVENT LISTENERS
// ===================
function setupListeners() {
    // Login
    document.getElementById('google-signin-btn')?.addEventListener('click', signInWithGoogle);
    document.getElementById('skip-login-btn')?.addEventListener('click', showHome);

    // Settings
    document.getElementById('settings-btn')?.addEventListener('click', showSettings);
    document.getElementById('close-settings-modal')?.addEventListener('click', closeSettings);
    document.getElementById('settings-signout-btn')?.addEventListener('click', signOut);
    document.getElementById('settings-signin-btn')?.addEventListener('click', () => {
        closeSettings();
        showLogin();
    });

    // Username save
    document.getElementById('save-username-btn')?.addEventListener('click', async () => {
        const input = document.getElementById('settings-username');
        const username = input.value.trim();
        if (username) {
            await saveUsername(username);
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
