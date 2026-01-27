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

// ===================
// CONSTANTS
// ===================
const FREE_LIMIT_ANONYMOUS = 5;
const FREE_LIMIT_AUTHENTICATED = 10;
const COOLDOWN_DAYS = 2; // Days until free generations reset
const CREDIT_PACK_SIZE = 25;
const CREDIT_PACK_PRICE = 2.99;

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
        }

        supabaseClient.auth.onAuthStateChange(async (event, session) => {
            console.log('Auth:', event);
            currentUser = session?.user || null;

            if (event === 'SIGNED_IN') {
                // Load username, credits and migrate history
                await loadUsername();
                await loadCredits();
                await migrateLocalHistoryToCloud();
                showHome();
                showToast('Signed in!');
            } else if (event === 'SIGNED_OUT') {
                currentUsername = null;
                purchasedCredits = 0;
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

async function signInWithEmail(email, password) {
    if (!supabaseClient) return;

    try {
        // Try sign in
        const { error: signInError } = await supabaseClient.auth.signInWithPassword({ email, password });

        if (signInError) {
            if (signInError.message.includes('Invalid login credentials')) {
                // Sign up
                const { data, error: signUpError } = await supabaseClient.auth.signUp({ email, password });
                if (signUpError) throw signUpError;

                if (data.user && !data.session) {
                    showAuthMessage('Check email to confirm account', 'success');
                }
            } else {
                throw signInError;
            }
        }
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

async function buyCredits() {
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
                email: currentUser.email
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

// Check for payment success/cancel on page load
async function checkPaymentStatus() {
    const params = new URLSearchParams(window.location.search);
    const payment = params.get('payment');

    if (payment === 'success') {
        // Add credits to the user's account
        await addCredits(CREDIT_PACK_SIZE);
        showToast(`🎉 ${CREDIT_PACK_SIZE} credits added!`);
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

    // If logged in, get total from cloud
    if (currentUser && supabaseClient) {
        try {
            const { count } = await supabaseClient
                .from('generations')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', currentUser.id);

            if (count !== null) {
                total = count;
            }
        } catch (e) {
            console.error('Stats fetch failed:', e);
        }
    }

    document.getElementById('stat-remaining').textContent = totalRemaining;
    document.getElementById('stat-total').textContent = total;

    // Show credits count if user has any
    const creditsEl = document.getElementById('stat-credits');
    if (creditsEl) {
        creditsEl.textContent = purchasedCredits;
    }
}

async function updateGenerateUsage() {
    const el = document.getElementById('generate-usage');
    const buyBtn = document.getElementById('buy-credits-btn');

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

    // Show/hide buy credits button
    if (buyBtn) {
        const freeRemaining = await getRemainingFreeGenerations();
        buyBtn.style.display = (freeRemaining <= 2 && currentUser) ? 'block' : 'none';
    }
}

function updateSettingsUI() {
    const emailEl = document.getElementById('settings-email');
    const usernameInput = document.getElementById('settings-username');
    const usernameSection = document.getElementById('username-section');
    const signoutBtn = document.getElementById('settings-signout-btn');
    const signinBtn = document.getElementById('settings-signin-btn');
    const buyCreditsBtn = document.getElementById('settings-buy-credits-btn');
    const creditsInfo = document.getElementById('settings-credits-info');
    const creditsValue = document.getElementById('settings-credits-value');

    if (currentUser) {
        emailEl.textContent = currentUser.email;
        usernameInput.value = currentUsername || '';
        usernameSection.style.display = 'block';
        signoutBtn.style.display = 'block';
        signinBtn.style.display = 'none';
        buyCreditsBtn.style.display = 'block';
        creditsInfo.style.display = 'flex';
        creditsValue.textContent = purchasedCredits;
    } else {
        emailEl.textContent = 'Not signed in';
        usernameSection.style.display = 'none';
        signoutBtn.style.display = 'none';
        signinBtn.style.display = 'block';
        buyCreditsBtn.style.display = 'none';
        creditsInfo.style.display = 'none';
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

    await updateStats();
    await updateGenerateUsage();
}

// ===================
// HISTORY (Cloud Sync)
// ===================
async function saveToHistory(matchName, openers, mode, analysis = null) {
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
            await supabaseClient.from('generations').insert({
                user_id: currentUser.id,
                match_name: matchName,
                openers: openers,
                mode: mode,
                analysis: analysis
            });
            console.log('Saved to cloud');
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
// AGE VERIFICATION
// ===================
function checkAgeVerification() {
    if (localStorage.getItem('ageVerified') === 'true') {
        document.getElementById('age-modal').classList.add('hidden');
        return true;
    }
    document.getElementById('age-modal').classList.remove('hidden');
    return false;
}

function verifyAge() {
    const age = document.getElementById('age-confirm').checked;
    const terms = document.getElementById('terms-confirm').checked;
    const harassment = document.getElementById('harassment-confirm').checked;

    if (!age || !terms || !harassment) {
        alert('Please check all boxes');
        return;
    }

    localStorage.setItem('ageVerified', 'true');
    document.getElementById('age-modal').classList.add('hidden');

    // Show login or home based on auth state
    if (currentUser) {
        showHome();
    } else {
        showLogin();
    }
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
function recordFeedback(result) {
    document.querySelectorAll('.feedback-btn').forEach(b => b.classList.remove('selected'));
    event.target.classList.add('selected');

    const msgs = { sent: 'Good luck!', replied: 'Nice!', date: 'LEGEND!', blocked: 'Their loss' };
    showToast(msgs[result] || 'Noted');
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
    // Age verification
    document.getElementById('age-verify-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        verifyAge();
    });

    // Login
    document.getElementById('google-signin-btn')?.addEventListener('click', signInWithGoogle);

    document.getElementById('auth-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const email = document.getElementById('auth-email').value;
        const password = document.getElementById('auth-password').value;
        signInWithEmail(email, password);
    });

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

    await initSupabase();

    // Check for payment success/cancel
    await checkPaymentStatus();

    if (!checkAgeVerification()) return;

    if (currentUser) {
        showHome();
    } else {
        showLogin();
    }
});
