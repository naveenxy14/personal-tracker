'use strict';

/* ============================================================
   SUPABASE SETUP — credentials are loaded from config.js
   Do not hardcode keys here. See config.example.js for setup.
   ============================================================ */
const SUPABASE_URL      = window.FINTRACK_CONFIG?.supabaseUrl      || '';
const SUPABASE_ANON_KEY = window.FINTRACK_CONFIG?.supabaseAnonKey  || '';

let sb = null;          // Supabase client
let currentUser = null; // Logged-in auth.users record

/* ============================================================
   IN-MEMORY STATE  (populated from Supabase on login)
   ============================================================ */
const DEFAULT_PAYMENT_METHODS = ['Cash','UPI','Google Pay','PhonePe','Credit Card','Debit Card','Net Banking','Bank Transfer','UPI Lite'];

let financeData = {
    metadata: { version: '1.0', createdDate: '', lastUpdated: '' },
    settings:  { theme: 'dark', currency: 'INR', monthlyBudget: 50000, finMonthStartDay: 22, paymentMethods: [...DEFAULT_PAYMENT_METHODS] },
    budgets:        [],
    paymentBudgets: [],
    incomes:        [],
    expenses:       []
};

/* ============================================================
   SUPABASE INITIALISATION & AUTH
   ============================================================ */
function initSupabase() {
    if (!SUPABASE_URL || SUPABASE_URL === 'YOUR_SUPABASE_PROJECT_URL') {
        document.getElementById('authMessage').textContent =
            '⚠ Add your Supabase URL and ANON KEY in app.js to get started.';
        document.getElementById('authMessage').style.color = 'var(--warning-color)';
        return false;
    }
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return true;
}

let _loginInProgress = false;
let _loadAbortController = null;

async function onLogin(user) {
    if (_loginInProgress) return;
    if (currentUser?.id === user.id) return;
    _loginInProgress = true;
    currentUser = user;
    updateUserUI(user);
    hideAuthScreen();

    // Stagger simultaneous tab starts — if another tab just started loading
    // (within 1.5s), wait 2s so queries don't all hit Supabase at once.
    const lastStart = parseInt(localStorage.getItem('fintrack_tab_start') || '0');
    if (Date.now() - lastStart < 1500) await new Promise(r => setTimeout(r, 2000));
    localStorage.setItem('fintrack_tab_start', Date.now().toString());

    // Per-load AbortController: cancel all in-flight queries after 12s
    if (_loadAbortController) _loadAbortController.abort();
    _loadAbortController = new AbortController();
    const signal = _loadAbortController.signal;

    showLoader('Loading your data…');
    try {
        await loadAllData(user.id, signal);
    } catch(e) {
        if (e.name === 'AbortError' || e.message?.includes('aborted') || e.message?.includes('timed out')) {
            showLoaderError('Connection too slow — tap to retry', () => {
                _loginInProgress = false;
                onLogin(user);
            });
            return;
        }
        console.error('onLogin error:', e);
        showToast('Error loading data: ' + (e.message || String(e)), 'error');
    } finally {
        hideLoader();
        _loginInProgress = false;
    }
    populateFMPickers();
    applyTheme(financeData.settings.theme || 'dark');
    navigate('dashboard');
}

function showLoaderError(msg, onRetry) {
    const ol = document.getElementById('loadingOverlay');
    const lt = document.getElementById('loadingText');
    if (lt) lt.innerHTML = `<span style="color:var(--expense-color,#ef4444)">${msg}</span>
        <br><button class="btn btn-primary btn-sm" style="margin-top:12px" id="loaderRetryBtn">Retry</button>`;
    document.getElementById('loaderRetryBtn')?.addEventListener('click', () => { hideLoader(); onRetry(); });
}

function usernameToEmail(username) {
    return `${username.toLowerCase().trim()}@fintrack.app`;
}

function emailToUsername(email) {
    return email.replace('@fintrack.app', '');
}

function derivePassword(username) {
    // Password is derived silently — user never sees or types it
    const u = username.toLowerCase().trim();
    return `FT_${u}_${u.split('').reverse().join('')}_2024`;
}

async function signIn(username) {
    setAuthMessage('');
    username = username.trim();
    if (!username) { setAuthMessage('✕ Enter your username'); return; }
    const { error } = await sb.auth.signInWithPassword({
        email:    usernameToEmail(username),
        password: derivePassword(username)
    });
    if (error) {
        const msg = error.message.includes('Invalid login')
            ? 'Username not found — did you mean to create an account?'
            : error.message;
        setAuthMessage('✕ ' + msg);
    }
}

async function signUp(username) {
    setAuthMessage('');
    username = username.trim();
    if (!username) { setAuthMessage('✕ Choose a username'); return; }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) { setAuthMessage('✕ Only letters, numbers and _ allowed'); return; }
    if (username.length < 3) { setAuthMessage('✕ Username must be at least 3 characters'); return; }
    const { error } = await sb.auth.signUp({
        email:    usernameToEmail(username),
        password: derivePassword(username)
    });
    if (error) {
        const msg = error.message.includes('already registered')
            ? 'Username already taken — choose another or sign in'
            : error.message;
        setAuthMessage('✕ ' + msg);
        return;
    }
    setAuthMessage('✓ Account created! Click Sign In to continue.', 'success');
}

async function signOut() {
    _loadAbortController?.abort();
    _loginInProgress = false;
    await sb.auth.signOut();
    currentUser = null;
    financeData.incomes        = [];
    financeData.expenses       = [];
    financeData.budgets        = [];
    financeData.paymentBudgets = [];
    showAuthScreen();
    showToast('Signed out', 'info');
}

function updateUserUI(user) {
    const pill    = document.getElementById('userPill');
    const emailEl = document.getElementById('userEmail');
    const avatar  = document.getElementById('userAvatar');
    const username = emailToUsername(user.email);
    if (pill)    pill.style.display = 'flex';
    if (emailEl) emailEl.textContent = '@' + username;
    if (avatar)  avatar.textContent  = username[0].toUpperCase();
}

/* ============================================================
   AUTH SCREEN UI
   ============================================================ */
function showAuthScreen() {
    document.getElementById('authOverlay').style.display = 'flex';
    const pill = document.getElementById('userPill');
    if (pill) pill.style.display = 'none';
}
function hideAuthScreen() {
    document.getElementById('authOverlay').style.display = 'none';
}
let _loaderTimer = null;
function showLoader(msg = 'Loading…') {
    clearTimeout(_loaderTimer);
    const ol = document.getElementById('loadingOverlay');
    const lt = document.getElementById('loadingText');
    if (ol) ol.classList.remove('hidden');
    if (lt) lt.textContent = msg;
    // Safety fallback: abort all in-flight queries and show retry after 12s
    _loaderTimer = setTimeout(() => {
        _loadAbortController?.abort();
    }, 12000);
}
function hideLoader() {
    clearTimeout(_loaderTimer);
    document.getElementById('loadingOverlay')?.classList.add('hidden');
}
function setAuthMessage(msg, type = 'error') {
    const el = document.getElementById('authMessage');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('success', type === 'success');
}

/* ============================================================
   SUPABASE DATA LAYER
   ============================================================ */
async function loadAllData(userId, signal) {
    const abortOpt = signal ? { signal } : {};

    // Throw immediately if already aborted before we start
    if (signal?.aborted) throw new DOMException('Load aborted', 'AbortError');

    // Profile / settings
    const { data: profile, error: profileErr } = await sb.from('profiles').select('*').eq('id', userId).single().abortSignal(signal);
    if (profileErr) {
        console.warn('profiles query error:', profileErr);
        if (profileErr.code !== 'PGRST116') {
            // Surface in connection diagnostic but keep loading — don't throw
            const el = document.getElementById('dbStatus');
            if (el) { el.style.background='rgba(239,68,68,0.12)'; el.style.color='var(--expense-color,#ef4444)'; el.textContent='✕ DB error: '+profileErr.message; }
        }
    }
    if (profile) {
        financeData.settings = {
            theme:             profile.theme            || 'dark',
            currency:          profile.currency         || 'INR',
            monthlyBudget:     profile.monthly_budget   || 50000,
            finMonthStartDay:  profile.fin_month_start_day || 22,
            paymentMethods:    Array.isArray(profile.payment_methods) ? profile.payment_methods : [...DEFAULT_PAYMENT_METHODS]
        };
    } else if (!profileErr) {
        // No profile yet — create one (first login)
        const { error: pInsErr } = await sb.from('profiles').insert({ id: userId, payment_methods: DEFAULT_PAYMENT_METHODS });
        if (pInsErr) console.warn('profile insert error:', pInsErr);
    }

    // Incomes
    const { data: incomes, error: incErr } = await sb.from('incomes').select('*').eq('user_id', userId).order('date', { ascending: false }).abortSignal(signal);
    if (incErr) console.warn('incomes query error:', incErr);
    financeData.incomes = (incomes || []).map(dbToIncome);

    // Expenses
    const { data: expenses, error: expErr } = await sb.from('expenses').select('*').eq('user_id', userId).order('date', { ascending: false }).abortSignal(signal);
    if (expErr) console.warn('expenses query error:', expErr);
    financeData.expenses = (expenses || []).map(dbToExpense);

    // Budgets
    const { data: budgets, error: budErr } = await sb.from('budgets').select('*').eq('user_id', userId).abortSignal(signal);
    if (budErr) console.warn('budgets query error:', budErr);
    financeData.budgets = (budgets || []).map(r => ({ id: r.id, category: r.category, amount: r.amount }));

    // Payment budgets
    const { data: paymentBudgets, error: pbErr } = await sb.from('payment_budgets').select('*').eq('user_id', userId).abortSignal(signal);
    if (pbErr) console.warn('payment_budgets query error:', pbErr);
    financeData.paymentBudgets = (paymentBudgets || []).map(r => ({ id: r.id, method: r.method, amount: parseFloat(r.amount) }));

    financeData.metadata.lastUpdated = new Date().toISOString();

    // Seed sample data only for truly new users (check localStorage + DB flag)
    const seedKey = `fintrack_seeded_${userId}`;
    const alreadySeeded = localStorage.getItem(seedKey) || profile?.has_seeded;
    const anyQueryFailed = incErr || expErr || budErr;
    if (!anyQueryFailed && !alreadySeeded && financeData.incomes.length === 0 && financeData.expenses.length === 0) {
        showLoader('Setting up sample data for you…');
        await generateSampleDataForUser(userId);
    }
}

function dbToIncome(r) {
    return { id: r.id, amount: parseFloat(r.amount), date: r.date, source: r.source, category: r.category, notes: r.notes || '' };
}
function dbToExpense(r) {
    return { id: r.id, amount: parseFloat(r.amount), date: r.date, time: r.time || '', category: r.category, description: r.description, comments: r.comments || '', paid_using: r.paid_using || 'Cash' };
}

async function syncProfile() {
    if (!currentUser) return;
    await sb.from('profiles').upsert({
        id:                   currentUser.id,
        theme:                financeData.settings.theme,
        currency:             financeData.settings.currency,
        monthly_budget:       financeData.settings.monthlyBudget,
        fin_month_start_day:  financeData.settings.finMonthStartDay,
        payment_methods:      financeData.settings.paymentMethods,
        updated_at:           new Date().toISOString()
    });
}

async function checkDbConnection() {
    const el = document.getElementById('dbStatus');
    if (!el) return;
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 6000);
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?limit=0`, {
            signal: controller.signal,
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            }
        });
        clearTimeout(tid);
        if (res.ok || res.status === 401 || res.status === 403) {
            el.style.background = 'rgba(34,197,94,0.12)';
            el.style.color = 'var(--income-color, #22c55e)';
            el.textContent = '✓ Database connected';
        } else {
            const txt = await res.text().catch(()=>'');
            el.style.background = 'rgba(239,68,68,0.12)';
            el.style.color = 'var(--expense-color, #ef4444)';
            el.textContent = `✕ DB error ${res.status}: ${txt.slice(0,120)}`;
        }
    } catch(e) {
        clearTimeout(tid);
        const msg = e.name === 'AbortError' ? 'Timed out — project may be paused at supabase.com/dashboard' : e.message;
        el.style.background = 'rgba(239,68,68,0.12)';
        el.style.color = 'var(--expense-color, #ef4444)';
        el.textContent = `✕ Cannot reach database: ${msg}`;
    }
}

function dbErr(error) {
    const msg = error?.message || error?.hint || error?.details || JSON.stringify(error);
    const e = new Error(msg || 'Unknown database error');
    e.supabaseError = error;
    return e;
}

async function dbInsertIncome(rec) {
    if (!currentUser) throw new Error('Not signed in');
    const { data, error } = await sb.from('incomes').insert({
        user_id:  currentUser.id,
        amount:   rec.amount,
        date:     rec.date,
        source:   rec.source,
        category: rec.category,
        notes:    rec.notes
    }).select().single();
    if (error) throw dbErr(error);
    if (!data) throw new Error('No data returned — check RLS policies');
    return data.id;
}

async function dbUpdateIncome(id, rec) {
    if (!currentUser) throw new Error('Not signed in');
    const { error } = await sb.from('incomes').update({
        amount: rec.amount, date: rec.date, source: rec.source,
        category: rec.category, notes: rec.notes
    }).eq('id', id).eq('user_id', currentUser.id);
    if (error) throw dbErr(error);
}

async function dbDeleteIncome(id) {
    if (!currentUser) throw new Error('Not signed in');
    const { error } = await sb.from('incomes').delete().eq('id', id).eq('user_id', currentUser.id);
    if (error) throw dbErr(error);
}

async function dbInsertExpense(rec) {
    if (!currentUser) throw new Error('Not signed in');
    const { data, error } = await sb.from('expenses').insert({
        user_id:     currentUser.id,
        amount:      rec.amount,
        date:        rec.date,
        time:        rec.time,
        category:    rec.category,
        description: rec.description,
        comments:    rec.comments,
        paid_using:  rec.paid_using || 'Cash'
    }).select().single();
    if (error) throw dbErr(error);
    if (!data) throw new Error('No data returned — check RLS policies');
    return data.id;
}

async function dbUpdateExpense(id, rec) {
    if (!currentUser) throw new Error('Not signed in');
    const { error } = await sb.from('expenses').update({
        amount: rec.amount, date: rec.date, time: rec.time,
        category: rec.category, description: rec.description, comments: rec.comments,
        paid_using: rec.paid_using || 'Cash'
    }).eq('id', id).eq('user_id', currentUser.id);
    if (error) throw dbErr(error);
}

async function dbDeleteExpense(id) {
    if (!currentUser) throw new Error('Not signed in');
    const { error } = await sb.from('expenses').delete().eq('id', id).eq('user_id', currentUser.id);
    if (error) throw dbErr(error);
}

async function dbUpsertBudget(category, amount) {
    if (!currentUser) throw new Error('Not signed in');
    const { data, error } = await sb.from('budgets').upsert(
        { user_id: currentUser.id, category, amount },
        { onConflict: 'user_id,category' }
    ).select().single();
    if (error) throw dbErr(error);
    if (!data) throw new Error('No data returned — check RLS policies');
    return data.id;
}

async function dbDeleteBudget(id) {
    if (!currentUser) throw new Error('Not signed in');
    const { error } = await sb.from('budgets').delete().eq('id', id).eq('user_id', currentUser.id);
    if (error) throw dbErr(error);
}

async function dbUpsertPaymentBudget(method, amount) {
    if (!currentUser) throw new Error('Not signed in');
    const { data, error } = await sb.from('payment_budgets').upsert(
        { user_id: currentUser.id, method, amount },
        { onConflict: 'user_id,method' }
    ).select().single();
    if (error) throw dbErr(error);
    if (!data) throw new Error('No data returned — check RLS policies');
    return data.id;
}

async function dbDeletePaymentBudget(id) {
    if (!currentUser) throw new Error('Not signed in');
    const { error } = await sb.from('payment_budgets').delete().eq('id', id).eq('user_id', currentUser.id);
    if (error) throw dbErr(error);
}

/* ============================================================
   SAMPLE DATA (inserted to Supabase on first login)
   ============================================================ */
async function generateSampleDataForUser(userId) {
    const rnd    = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const today  = new Date();
    const rDate  = (mBack) => {
        const d = new Date(today); d.setDate(rnd(1, 28)); d.setMonth(d.getMonth() - mBack);
        return d.toISOString().split('T')[0];
    };
    const rTime = () => `${String(rnd(8,22)).padStart(2,'0')}:${String(rnd(0,59)).padStart(2,'0')}`;

    const incomeRows = [], expenseRows = [], budgetRows = [];

    // 6 months of salary + occasional freelance
    for (let m = 0; m < 6; m++) {
        incomeRows.push({ user_id: userId, amount: rnd(55000,75000), date: rDate(m), source: 'TechCorp Pvt Ltd', category: 'Salary',    notes: 'Monthly salary' });
        if (m % 2 === 0) incomeRows.push({ user_id: userId, amount: rnd(8000,20000), date: rDate(m), source: 'Upwork Client', category: 'Freelance', notes: 'Project payment' });
    }

    const expDescs = { Food:['Swiggy Order','Zomato Dinner','Grocery Shopping','McDonald\'s'], Shopping:['Amazon Purchase','Myntra Clothes','Flipkart Order'], Travel:['Ola/Uber Cab','IRCTC Train','Auto Rickshaw'], Fuel:['Petrol Refill','CNG Fill'], Rent:['Monthly House Rent'], EMI:['Car EMI','Home Loan EMI'], Utilities:['Electricity Bill','WiFi Bill','Mobile Recharge'], Entertainment:['Netflix','Movie Tickets','BookMyShow'], Medical:['Pharmacy','Doctor Visit'], Subscription:['Spotify','iCloud'] };
    const expCats  = ['Food','Shopping','Travel','Fuel','Utilities','Entertainment','Medical','Subscription'];
    const amtMap   = { Food:[200,1800], Shopping:[500,5000], Travel:[150,3000], Fuel:[500,2000], Utilities:[200,2000], Entertainment:[200,1500], Medical:[300,3000], Subscription:[99,999] };
    const pmMethods = ['Cash','UPI','Google Pay','PhonePe','Credit Card','Debit Card','Bank Transfer'];
    const rPM = () => pmMethods[rnd(0, pmMethods.length-1)];

    for (let m = 0; m < 6; m++) {
        expenseRows.push({ user_id: userId, amount: rnd(15000,18000), date: rDate(m), time: '09:00', category: 'Rent', description: 'Monthly House Rent', comments: '', paid_using: 'Bank Transfer' });
        expenseRows.push({ user_id: userId, amount: rnd(8000,12000),  date: rDate(m), time: '10:00', category: 'EMI',  description: 'Car EMI', comments: '', paid_using: 'Bank Transfer' });
        for (let i = 0; i < 8; i++) {
            const cat  = expCats[rnd(0, expCats.length-1)];
            const desc = expDescs[cat][rnd(0, expDescs[cat].length-1)];
            const [mn, mx] = amtMap[cat] || [100,1000];
            expenseRows.push({ user_id: userId, amount: rnd(mn,mx), date: rDate(m), time: rTime(), category: cat, description: desc, comments: '', paid_using: rPM() });
        }
    }

    budgetRows.push(...[
        { user_id: userId, category: 'Food',          amount: 8000  },
        { user_id: userId, category: 'Shopping',      amount: 6000  },
        { user_id: userId, category: 'Travel',        amount: 5000  },
        { user_id: userId, category: 'Fuel',          amount: 3000  },
        { user_id: userId, category: 'Entertainment', amount: 2000  },
        { user_id: userId, category: 'Utilities',     amount: 3000  }
    ]);

    // Batch insert — throw on error so login doesn't loop on silent failures
    const { error: incErr } = await sb.from('incomes').insert(incomeRows);
    if (incErr) throw dbErr(incErr);
    const { error: expErr } = await sb.from('expenses').insert(expenseRows);
    if (expErr) throw dbErr(expErr);
    const { error: budErr } = await sb.from('budgets').insert(budgetRows);
    if (budErr) throw dbErr(budErr);

    // Mark seeded so we don't loop on next login
    localStorage.setItem(`fintrack_seeded_${userId}`, '1');
    await sb.from('profiles').update({ has_seeded: true }).eq('id', userId);

    // Reload fresh from DB so IDs are correct
    const { data: inc } = await sb.from('incomes').select('*').eq('user_id', userId).order('date', { ascending: false });
    const { data: exp } = await sb.from('expenses').select('*').eq('user_id', userId).order('date', { ascending: false });
    const { data: bud } = await sb.from('budgets').select('*').eq('user_id', userId);
    financeData.incomes  = (inc  || []).map(dbToIncome);
    financeData.expenses = (exp  || []).map(dbToExpense);
    financeData.budgets  = (bud  || []).map(r => ({ id: r.id, category: r.category, amount: r.amount }));
    financeData.metadata.createdDate = new Date().toISOString();
}

/* ============================================================
   FINANCIAL MONTH UTILITIES
   ============================================================ */
function getFinancialMonth(date) {
    const startDay = financeData.settings.finMonthStartDay || 22;
    const d = new Date(date);
    const day = d.getDate(), month = d.getMonth(), year = d.getFullYear();
    if (day >= startDay) {
        return { month: (month + 1) % 12, year: month === 11 ? year + 1 : year };
    }
    return { month, year };
}

function financialMonthStart(fmMonth, fmYear) {
    const sd  = financeData.settings.finMonthStartDay || 22;
    const pm  = fmMonth === 0 ? 11 : fmMonth - 1;
    const py  = fmMonth === 0 ? fmYear - 1 : fmYear;
    return new Date(py, pm, sd, 0, 0, 0, 0);
}

function financialMonthEnd(fmMonth, fmYear) {
    const sd = financeData.settings.finMonthStartDay || 22;
    return new Date(fmYear, fmMonth, sd - 1, 23, 59, 59, 999);
}

function currentFinancialMonth() { return getFinancialMonth(new Date()); }

function prevFinancialMonth() {
    const { month, year } = currentFinancialMonth();
    return { month: month === 0 ? 11 : month - 1, year: month === 0 ? year - 1 : year };
}

function finMonthName(m, y) {
    const MN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return `${MN[m]} ${y}`;
}

function finMonthRangeLabel(fmMonth, fmYear) {
    const sd = financeData.settings.finMonthStartDay || 22;
    const SH = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const pm = fmMonth === 0 ? 11 : fmMonth - 1;
    return `${SH[pm]} ${sd} – ${SH[fmMonth]} ${sd - 1}`;
}

function getFinancialMonthsList(count = 12) {
    const list = [], seen = new Set();
    const now  = new Date();
    for (let i = 0; i < count + 3; i++) {
        const d  = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const fm = getFinancialMonth(d);
        const key = `${fm.year}-${fm.month}`;
        if (!seen.has(key)) { seen.add(key); list.push({ key, month: fm.month, year: fm.year }); }
        if (list.length >= count) break;
    }
    return list;
}

function isInFinancialMonth(dateStr, fmMonth, fmYear) {
    const d = new Date(dateStr);
    return d >= financialMonthStart(fmMonth, fmYear) && d <= financialMonthEnd(fmMonth, fmYear);
}

/* ============================================================
   DATE FILTER UTILITIES
   ============================================================ */
function getDateRange(filterVal, dateFrom, dateTo) {
    const now   = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    switch (filterVal) {
        case 'today':        return { start: today, end: new Date(today.getTime() + 86399999) };
        case 'yesterday': {  const y = new Date(today); y.setDate(y.getDate()-1); return { start: y, end: new Date(y.getTime()+86399999) }; }
        case 'last7':     {  const s = new Date(today); s.setDate(s.getDate()-6); return { start: s, end: new Date(today.getTime()+86399999) }; }
        case 'last30':    {  const s = new Date(today); s.setDate(s.getDate()-29); return { start: s, end: new Date(today.getTime()+86399999) }; }
        case 'thisFinMonth': { const fm=currentFinancialMonth(); return { start: financialMonthStart(fm.month,fm.year), end: financialMonthEnd(fm.month,fm.year) }; }
        case 'lastFinMonth': { const fm=prevFinancialMonth();    return { start: financialMonthStart(fm.month,fm.year), end: financialMonthEnd(fm.month,fm.year) }; }
        case 'last3months':  { const s=new Date(today); s.setMonth(s.getMonth()-3); return { start: s, end: new Date(today.getTime()+86399999) }; }
        case 'last6months':  { const s=new Date(today); s.setMonth(s.getMonth()-6); return { start: s, end: new Date(today.getTime()+86399999) }; }
        case 'thisYear':     { return { start: new Date(now.getFullYear(),0,1), end: new Date(now.getFullYear(),11,31,23,59,59) }; }
        case 'custom':    if (dateFrom && dateTo) return { start: new Date(dateFrom), end: new Date(dateTo+'T23:59:59') }; return null;
        default:          return null;
    }
}

function inRange(dateStr, range) {
    if (!range) return true;
    const d = new Date(dateStr);
    return d >= range.start && d <= range.end;
}

function fmPickerRange(pickerId) {
    const v = document.getElementById(pickerId)?.value;
    if (!v) return null;
    const [y, m] = v.split('-').map(Number);
    return { start: financialMonthStart(m, y), end: financialMonthEnd(m, y) };
}

/* ============================================================
   FORMATTING UTILITIES
   ============================================================ */
function currencySymbol() { return { INR:'₹', USD:'$', EUR:'€', GBP:'£' }[financeData.settings.currency] || '₹'; }

function fmt(amount) {
    return `${currencySymbol()}${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function fmtDate(ds)   { return ds ? new Date(ds).toLocaleDateString('en-IN',{ day:'2-digit', month:'short', year:'numeric' }) : '—'; }
function fmtTime(ts)   { if (!ts) return '—'; const [h,m]=ts.split(':'); const hr=parseInt(h); return `${hr%12||12}:${m} ${hr>=12?'PM':'AM'}`; }
function catClass(cat) { return 'cat-'+(cat||'other').toLowerCase().replace(/\s+/g,''); }
function catIcon(cat)  {
    const i={Food:'🍔',Shopping:'🛍️',Travel:'✈️',Fuel:'⛽',Rent:'🏠',EMI:'💳',Utilities:'💡',Entertainment:'🎬',Medical:'💊',Education:'📚',Investment:'📈',Family:'👨‍👩‍👧',Gifts:'🎁',Subscription:'📱',Other:'📦',Salary:'💼',Freelance:'💻',Bonus:'🎯',Business:'🏢',Refund:'↩️',Gift:'🎁'};
    return i[cat]||'💰';
}
function setText(id,v) { const e=document.getElementById(id); if(e) e.textContent=v; }

/* ============================================================
   FILTER HELPERS
   ============================================================ */
function getFilteredIncomes() {
    const search = document.getElementById('incomeSearch')?.value.toLowerCase()||'';
    const cat    = document.getElementById('incomeCategoryFilter')?.value||'';
    const df     = document.getElementById('incomeDateFilter')?.value||'all';
    const range  = df === 'selectFinMonth' ? fmPickerRange('incomeFMPicker') : getDateRange(df);
    return financeData.incomes.filter(r =>
        (!cat || r.category===cat) && inRange(r.date,range) &&
        (!search || [r.source,r.category,r.notes].join(' ').toLowerCase().includes(search))
    );
}

function getFilteredExpenses() {
    const search = document.getElementById('expenseSearch')?.value.toLowerCase()||'';
    const cat    = document.getElementById('expenseCategoryFilter')?.value||'';
    const df     = document.getElementById('expenseDateFilter')?.value||'all';
    const range  = df === 'selectFinMonth' ? fmPickerRange('expenseFMPicker') : getDateRange(df);
    return financeData.expenses.filter(r =>
        (!cat || r.category===cat) && inRange(r.date,range) &&
        (!search || [r.description,r.category,r.comments].join(' ').toLowerCase().includes(search))
    );
}

function getFilteredTransactions() {
    const search = document.getElementById('txSearch')?.value.toLowerCase()||'';
    const type   = document.getElementById('txTypeFilter')?.value||'all';
    const cat    = document.getElementById('txCategoryFilter')?.value||'';
    const df     = document.getElementById('txDateFilter')?.value||'all';
    const from   = document.getElementById('txDateFrom')?.value;
    const to     = document.getElementById('txDateTo')?.value;
    const range  = df === 'selectFinMonth' ? fmPickerRange('txFMPicker') : getDateRange(df, from, to);
    const minAmt = parseFloat(document.getElementById('txMinAmount')?.value)||0;
    const maxAmt = parseFloat(document.getElementById('txMaxAmount')?.value)||Infinity;

    const all = [
        ...financeData.incomes.map(r=>({...r,type:'income'})),
        ...financeData.expenses.map(r=>({...r,type:'expense',source:r.description}))
    ];
    return all.filter(r =>
        (type==='all'||r.type===type) && (!cat||r.category===cat) &&
        inRange(r.date,range) && r.amount>=minAmt && r.amount<=maxAmt &&
        (!search || [r.source||'',r.category,r.notes||'',r.comments||'',r.description||''].join(' ').toLowerCase().includes(search))
    );
}

/* ============================================================
   SORT & PAGINATION
   ============================================================ */
const paginationState = {
    income:  { page:1, perPage:15, sort:'date', dir:'desc' },
    expense: { page:1, perPage:15, sort:'date', dir:'desc' },
    tx:      { page:1, perPage:20, sort:'date', dir:'desc' }
};

function sortRecords(recs, sort, dir) {
    return [...recs].sort((a,b) => {
        let va=a[sort], vb=b[sort];
        if (sort==='date')   { va=new Date(va+(a.time?`T${a.time}`:'')); vb=new Date(vb+(b.time?`T${b.time}`:'')); }
        else if (sort==='amount') { va=Number(va); vb=Number(vb); }
        else { va=String(va||'').toLowerCase(); vb=String(vb||'').toLowerCase(); }
        return dir==='asc' ? (va>vb?1:-1) : (va<vb?1:-1);
    });
}

function renderPagination(containerId, totalItems, state, onPageChange) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const totalPages = Math.max(1, Math.ceil(totalItems/state.perPage));
    if (state.page>totalPages) state.page=totalPages;
    let html = `<span class="page-info">Page ${state.page} of ${totalPages} (${totalItems} records)</span>`;
    if (totalPages>1) {
        html += `<button class="page-btn" ${state.page===1?'disabled':''} data-page="1">«</button>`;
        html += `<button class="page-btn" ${state.page===1?'disabled':''} data-page="${state.page-1}">‹</button>`;
        for (let p=Math.max(1,state.page-2); p<=Math.min(totalPages,state.page+2); p++) {
            html += `<button class="page-btn ${p===state.page?'active':''}" data-page="${p}">${p}</button>`;
        }
        html += `<button class="page-btn" ${state.page===totalPages?'disabled':''} data-page="${state.page+1}">›</button>`;
        html += `<button class="page-btn" ${state.page===totalPages?'disabled':''} data-page="${totalPages}">»</button>`;
    }
    container.innerHTML = html;
    container.querySelectorAll('.page-btn:not([disabled])').forEach(btn => {
        btn.addEventListener('click', () => { state.page=parseInt(btn.dataset.page); onPageChange(); });
    });
}

function updateSortHeaders(tableId, state) {
    const t = document.getElementById(tableId);
    if (!t) return;
    t.querySelectorAll('th[data-sort]').forEach(th => {
        th.classList.remove('sort-asc','sort-desc');
        if (th.dataset.sort===state.sort) th.classList.add(state.dir==='asc'?'sort-asc':'sort-desc');
    });
}

function initSortHeaders(tableId, state, renderFn) {
    const t = document.getElementById(tableId);
    if (!t) return;
    t.querySelectorAll('th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.sort;
            if (state.sort===col) state.dir=state.dir==='asc'?'desc':'asc';
            else { state.sort=col; state.dir='desc'; }
            state.page=1; renderFn();
        });
    });
}

/* ============================================================
   NAVIGATION
   ============================================================ */
const PAGE_TITLES = {
    dashboard:    ['Dashboard','Financial overview'],
    income:       ['Income','Manage your income records'],
    expenses:     ['Expenses','Track your spending'],
    transactions: ['Transactions','All transactions'],
    analytics:    ['Analytics','Charts & insights'],
    reports:      ['Reports','Financial reports'],
    budget:       ['Budget','Manage budgets'],
    settings:     ['Settings & Data','App settings and data management'],
    help:         ['Help & Guide','Learn how to use FinTrack'],
    terms:        ['Terms of Use','Rules and conditions for using FinTrack']
};

function navigate(section) {
    document.querySelectorAll('.nav-item').forEach(el=>el.classList.remove('active'));
    document.querySelector(`.nav-item[data-section="${section}"]`)?.classList.add('active');
    document.querySelectorAll('.mobile-nav-item').forEach(el=>el.classList.remove('active'));
    document.querySelector(`.mobile-nav-item[data-section="${section}"]`)?.classList.add('active');
    document.querySelectorAll('.content-section').forEach(el=>el.classList.remove('active'));
    document.getElementById(`section-${section}`)?.classList.add('active');
    const [title,sub] = PAGE_TITLES[section]||[section,''];
    setText('pageTitle',title); setText('pageSubtitle',sub);

    if (section==='dashboard')    renderDashboard();
    if (section==='income')       renderIncomeTable();
    if (section==='expenses')     renderExpenseTable();
    if (section==='transactions') renderTransactionTable();
    if (section==='analytics')    renderAnalytics();
    if (section==='reports')      renderReports();
    if (section==='budget')       renderBudgetPage();
    if (section==='settings')     renderSettingsPage();

    document.getElementById('sidebar')?.classList.remove('mobile-open');
}

/* ============================================================
   INCOME TABLE
   ============================================================ */
function renderIncomeTable() {
    const state = paginationState.income;
    const filtered = getFilteredIncomes();
    const sorted   = sortRecords(filtered, state.sort, state.dir);
    const page     = sorted.slice((state.page-1)*state.perPage, state.page*state.perPage);
    const tbody    = document.getElementById('incomeTableBody');
    if (!tbody) return;
    if (!page.length) {
        tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">💰</div><div class="empty-title">No income records</div></div></td></tr>`;
        renderPagination('incomePagination', 0, state, renderIncomeTable);
        return;
    }
    tbody.innerHTML = page.map(r=>`<tr>
        <td>${fmtDate(r.date)}</td>
        <td>${r.source||'—'}${r.category==='Opening Balance'&&r.notes?` <span class="pm-badge">${r.notes}</span>`:''}</td>
        <td><span class="cat-badge ${catClass(r.category)}">${catIcon(r.category)} ${r.category}</span></td>
        <td class="amount-income">${fmt(r.amount)}</td>
        <td>${r.category==='Opening Balance'?'—':r.notes||'—'}</td>
        <td>
            <button class="action-btn edit-btn" onclick="openEditIncome(${r.id})">Edit</button>
            <button class="action-btn delete-btn" onclick="confirmDelete('income',${r.id})">Delete</button>
        </td>
    </tr>`).join('');
    updateSortHeaders('incomeTable', state);
    renderPagination('incomePagination', filtered.length, state, renderIncomeTable);
}

/* ============================================================
   EXPENSE TABLE
   ============================================================ */
function renderExpenseTable() {
    const state = paginationState.expense;
    const filtered = getFilteredExpenses();
    const sorted   = sortRecords(filtered, state.sort, state.dir);
    const page     = sorted.slice((state.page-1)*state.perPage, state.page*state.perPage);
    const tbody    = document.getElementById('expenseTableBody');
    if (!tbody) return;
    if (!page.length) {
        tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">💸</div><div class="empty-title">No expense records</div></div></td></tr>`;
        renderPagination('expensePagination', 0, state, renderExpenseTable);
        return;
    }
    tbody.innerHTML = page.map(r=>`<tr>
        <td>${fmtDate(r.date)}</td>
        <td>${fmtTime(r.time)}</td>
        <td><span class="cat-badge ${catClass(r.category)}">${catIcon(r.category)} ${r.category}</span></td>
        <td>${r.description||'—'}</td>
        <td class="amount-expense">${fmt(r.amount)}</td>
        <td><span class="pm-badge">${r.paid_using||'Cash'}</span></td>
        <td>${r.comments||'—'}</td>
        <td>
            <button class="action-btn edit-btn" onclick="openEditExpense(${r.id})">Edit</button>
            <button class="action-btn delete-btn" onclick="confirmDelete('expense',${r.id})">Delete</button>
        </td>
    </tr>`).join('');
    updateSortHeaders('expenseTable', state);
    renderPagination('expensePagination', filtered.length, state, renderExpenseTable);
}

/* ============================================================
   TRANSACTION TABLE
   ============================================================ */
function renderTransactionTable() {
    const state    = paginationState.tx;
    const filtered = getFilteredTransactions();
    const sorted   = sortRecords(filtered, state.sort, state.dir);

    const totalInc = filtered.filter(r=>r.type==='income').reduce((s,r)=>s+r.amount,0);
    const totalExp = filtered.filter(r=>r.type==='expense').reduce((s,r)=>s+r.amount,0);
    const bar = document.getElementById('txSummaryBar');
    if (bar) bar.innerHTML = `
        <div class="tx-summary-item"><span class="tx-summary-label">Records</span><span class="tx-summary-value">${filtered.length}</span></div>
        <div class="tx-summary-item"><span class="tx-summary-label">Total Income</span><span class="tx-summary-value amount-income">${fmt(totalInc)}</span></div>
        <div class="tx-summary-item"><span class="tx-summary-label">Total Expense</span><span class="tx-summary-value amount-expense">${fmt(totalExp)}</span></div>
        <div class="tx-summary-item"><span class="tx-summary-label">Net</span><span class="tx-summary-value ${totalInc-totalExp>=0?'amount-income':'amount-expense'}">${fmt(totalInc-totalExp)}</span></div>`;

    const page  = sorted.slice((state.page-1)*state.perPage, state.page*state.perPage);
    const tbody = document.getElementById('txTableBody');
    if (!tbody) return;
    if (!page.length) {
        tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><div class="empty-icon">📊</div><div class="empty-title">No transactions</div></div></td></tr>`;
        renderPagination('txPagination',0,state,renderTransactionTable);
        return;
    }
    tbody.innerHTML = page.map(r=>`<tr>
        <td>${fmtDate(r.date)}</td>
        <td>${fmtTime(r.time||'')}</td>
        <td><span class="type-badge type-${r.type}">${r.type==='income'?'↑ Income':'↓ Expense'}</span></td>
        <td><span class="cat-badge ${catClass(r.category)}">${catIcon(r.category)} ${r.category}</span></td>
        <td>${r.source||r.description||'—'}</td>
        <td class="${r.type==='income'?'amount-income':'amount-expense'}">${r.type==='income'?'+':'-'}${fmt(r.amount)}</td>
        <td>${r.type==='expense'?`<span class="pm-badge">${r.paid_using||'Cash'}</span>`:'—'}</td>
        <td>${r.notes||r.comments||'—'}</td>
        <td>
            <button class="action-btn edit-btn" onclick="${r.type==='income'?'openEditIncome':'openEditExpense'}(${r.id})">Edit</button>
            <button class="action-btn delete-btn" onclick="confirmDelete('${r.type}',${r.id})">Delete</button>
        </td>
    </tr>`).join('');
    updateSortHeaders('txTable', state);
    renderPagination('txPagination', filtered.length, state, renderTransactionTable);

    // Populate category filter once
    const catFilter = document.getElementById('txCategoryFilter');
    if (catFilter && catFilter.options.length<=1) {
        [...new Set([...financeData.incomes.map(r=>r.category),...financeData.expenses.map(r=>r.category)])].sort().forEach(c=>{
            const o=document.createElement('option'); o.value=c; o.textContent=c; catFilter.appendChild(o);
        });
    }
}

/* ============================================================
   DASHBOARD
   ============================================================ */
let dashPieChart=null, dashTrendChart=null;
let dashActiveFM=null;

function selectDashFM(month, year) {
    const cur=currentFinancialMonth();
    dashActiveFM = (month===cur.month && year===cur.year) ? null : { month, year };
    renderDashboard();
}

function renderDashFMSelector() {
    const container = document.getElementById('dashFMSelector');
    if (!container) return;
    const months   = getFinancialMonthsList(6);
    const activeFM = dashActiveFM || currentFinancialMonth();
    container.innerHTML = months.map(fm=>{
        const isActive = fm.month===activeFM.month && fm.year===activeFM.year;
        return `<button class="fm-chip ${isActive?'fm-chip-active':''}"
            onclick="selectDashFM(${fm.month},${fm.year})" title="${finMonthRangeLabel(fm.month,fm.year)}">
            ${finMonthName(fm.month,fm.year)}
        </button>`;
    }).join('');
}

function renderDashboard() {
    const allIncome  = financeData.incomes;
    const allExpense = financeData.expenses;
    const totalInc   = allIncome.reduce((s,r)=>s+r.amount,0);
    const totalExp   = allExpense.reduce((s,r)=>s+r.amount,0);
    const balance    = totalInc - totalExp;
    const savingRate = totalInc>0 ? ((totalInc-totalExp)/totalInc*100).toFixed(1) : 0;

    const fm    = dashActiveFM || currentFinancialMonth();
    const fmInc = allIncome.filter(r=>isInFinancialMonth(r.date,fm.month,fm.year)).reduce((s,r)=>s+r.amount,0);
    const fmExp = allExpense.filter(r=>isInFinancialMonth(r.date,fm.month,fm.year)).reduce((s,r)=>s+r.amount,0);
    const monthBudget  = financeData.settings.monthlyBudget||50000;
    const budgetUtil   = monthBudget>0 ? Math.min((fmExp/monthBudget)*100,999).toFixed(1) : 0;
    const budgetRemain = Math.max(monthBudget-fmExp,0);

    setText('totalIncome',     fmt(totalInc));
    setText('totalExpenses',   fmt(totalExp));
    setText('currentBalance',  fmt(balance));
    setText('savingsRate',     `${savingRate}%`);
    setText('fmIncome',        fmt(fmInc));
    setText('fmExpense',       fmt(fmExp));
    setText('budgetUtil',      `${budgetUtil}%`);
    setText('budgetRemaining', fmt(budgetRemain));

    const fmBadge = document.getElementById('finMonthBadge');
    if (fmBadge) fmBadge.textContent = `${finMonthName(fm.month,fm.year)} FM`;

    renderDashFMSelector();

    setText('incomeTrend',    `All time • ${allIncome.length} records`);
    setText('expenseTrend',   `All time • ${allExpense.length} records`);
    setText('balanceTrend',   balance>=0 ? '✓ Positive balance' : '⚠ Negative balance');
    setText('savingsTrend',   parseFloat(savingRate)>=20 ? '✓ Good savings rate' : 'Aim for 20%+');
    setText('fmIncomeTrend',  `${finMonthName(fm.month,fm.year)} • ${finMonthRangeLabel(fm.month,fm.year)}`);
    setText('fmExpenseTrend', `${finMonthName(fm.month,fm.year)} • ${finMonthRangeLabel(fm.month,fm.year)}`);
    setText('budgetTrend',    budgetUtil>100 ? '⚠ Over budget!' : `${(100-budgetUtil).toFixed(1)}% remaining`);
    setText('remainingTrend', `Budget: ${fmt(monthBudget)}`);

    renderRecentTransactions();
    renderBudgetOverviewWidget();
    renderPaymentMethodWidget();
    renderDashPieChart();
    renderDashTrendChart();
}

function renderRecentTransactions() {
    const container = document.getElementById('recentTransactions');
    if (!container) return;
    const activeFM = dashActiveFM;
    let incomes  = financeData.incomes.map(r=>({...r,type:'income'}));
    let expenses = financeData.expenses.map(r=>({...r,type:'expense'}));
    if (activeFM) {
        incomes  = incomes.filter(r=>isInFinancialMonth(r.date,activeFM.month,activeFM.year));
        expenses = expenses.filter(r=>isInFinancialMonth(r.date,activeFM.month,activeFM.year));
    }
    const all = [...incomes,...expenses].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,10);
    if (!all.length) { container.innerHTML='<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-title">No transactions</div></div>'; return; }
    container.innerHTML = all.map(r=>`
        <div class="recent-item">
            <div class="recent-left">
                <div class="recent-icon ${r.type==='income'?'income-icon':'expense-icon'}">${catIcon(r.category)}</div>
                <div class="recent-info">
                    <p>${r.type==='income'?r.source:r.description}</p>
                    <span>${fmtDate(r.date)} • ${r.category}</span>
                </div>
            </div>
            <span class="recent-amount ${r.type==='income'?'amount-income':'amount-expense'}">${r.type==='income'?'+':'-'}${fmt(r.amount)}</span>
        </div>`).join('');
}

function renderBudgetOverviewWidget() {
    const container = document.getElementById('budgetOverview');
    const label     = document.getElementById('budgetMonthLabel');
    if (!container) return;
    const fm = dashActiveFM || currentFinancialMonth();
    if (label) label.textContent = finMonthName(fm.month,fm.year);
    const catSpend = {};
    financeData.expenses.filter(r=>isInFinancialMonth(r.date,fm.month,fm.year)).forEach(r=>{ catSpend[r.category]=(catSpend[r.category]||0)+r.amount; });
    if (!financeData.budgets.length) { container.innerHTML='<div class="empty-state"><div class="empty-icon">🎯</div><div class="empty-title">No budgets set</div></div>'; return; }
    container.innerHTML = financeData.budgets.map(b=>{
        const spent=catSpend[b.category]||0, pct=b.amount>0?Math.min((spent/b.amount)*100,100):0;
        const cls=pct>=100?'progress-critical':pct>=75?'progress-warning':'progress-safe';
        return `<div class="budget-overview-item">
            <div class="budget-item-header">
                <span class="budget-item-name">${catIcon(b.category)} ${b.category}</span>
                <span class="budget-item-pct" style="color:${pct>=100?'var(--expense-color)':pct>=75?'var(--warning-color)':'var(--income-color)'}">${pct.toFixed(0)}%</span>
            </div>
            <div class="progress-bar"><div class="progress-fill ${cls}" style="width:${pct}%"></div></div>
            <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-top:3px"><span>${fmt(spent)} spent</span><span>${fmt(b.amount)} budget</span></div>
        </div>`;
    }).join('');
}

function renderDashPieChart() {
    const ctx=document.getElementById('dashPieChart'); if(!ctx) return;
    const fm=dashActiveFM||currentFinancialMonth();
    const catSpend={};
    financeData.expenses.filter(r=>isInFinancialMonth(r.date,fm.month,fm.year)).forEach(r=>{catSpend[r.category]=(catSpend[r.category]||0)+r.amount;});
    const labels=Object.keys(catSpend), data=Object.values(catSpend);
    const colors=['#7c6fe0','#22c55e','#ef4444','#f59e0b','#3b82f6','#ec4899','#14b8a6','#f97316','#8b5cf6','#06b6d4'];
    if (dashPieChart) dashPieChart.destroy();
    if (!labels.length) return;
    dashPieChart=new Chart(ctx,{type:'doughnut',data:{labels,datasets:[{data,backgroundColor:colors,borderWidth:2,borderColor:getComputedStyle(document.documentElement).getPropertyValue('--bg-card')}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{color:getChartTextColor(),font:{size:11},padding:12}},tooltip:{callbacks:{label:c=>` ${c.label}: ${fmt(c.raw)} (${(c.raw/data.reduce((a,b)=>a+b,0)*100).toFixed(1)}%)`}}}}});
}

function renderDashTrendChart() {
    const ctx=document.getElementById('dashTrendChart'); if(!ctx) return;
    const months=[],incData=[],expData=[],balData=[];
    for(let i=5;i>=0;i--){const d=new Date();d.setMonth(d.getMonth()-i);const fm=getFinancialMonth(new Date(d.getFullYear(),d.getMonth(),1));months.push(finMonthName(fm.month,fm.year).substring(0,3)+" '"+String(fm.year).slice(-2));const inc=financeData.incomes.filter(r=>isInFinancialMonth(r.date,fm.month,fm.year)).reduce((s,r)=>s+r.amount,0);const exp=financeData.expenses.filter(r=>isInFinancialMonth(r.date,fm.month,fm.year)).reduce((s,r)=>s+r.amount,0);incData.push(inc);expData.push(exp);balData.push(inc-exp);}
    if(dashTrendChart) dashTrendChart.destroy();
    dashTrendChart=new Chart(ctx,{type:'line',data:{labels:months,datasets:[{label:'Income',data:incData,borderColor:'#22c55e',backgroundColor:'rgba(34,197,94,0.1)',fill:true,tension:0.4},{label:'Expense',data:expData,borderColor:'#ef4444',backgroundColor:'rgba(239,68,68,0.1)',fill:true,tension:0.4},{label:'Balance',data:balData,borderColor:'#7c6fe0',backgroundColor:'transparent',tension:0.4,borderDash:[5,5]}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:getChartTextColor(),font:{size:11}}},tooltip:{callbacks:{label:c=>` ${c.dataset.label}: ${fmt(c.raw)}`}}},scales:{x:{grid:{color:getChartGridColor()},ticks:{color:getChartTextColor(),font:{size:10}}},y:{grid:{color:getChartGridColor()},ticks:{color:getChartTextColor(),font:{size:10},callback:v=>fmt(v)}}}}});
}

function getChartTextColor() { return financeData.settings.theme==='dark' ? '#9e9eb8' : '#4a4a6a'; }
function getChartGridColor() { return financeData.settings.theme==='dark' ? '#2e3250' : '#d1d5e8'; }

function renderPaymentMethodWidget() {
    const container = document.getElementById('paymentMethodWidget');
    const label = document.getElementById('pmWidgetMonthLabel');
    if (!container) return;
    const fm = dashActiveFM || currentFinancialMonth();
    if (label) label.textContent = finMonthName(fm.month, fm.year);
    const fmExp = financeData.expenses.filter(r => isInFinancialMonth(r.date, fm.month, fm.year));
    const pmSpend = {};
    fmExp.forEach(r => { const m = r.paid_using || 'Cash'; pmSpend[m] = (pmSpend[m] || 0) + r.amount; });
    const sorted = Object.entries(pmSpend).sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((s, [, v]) => s + v, 0);
    if (!sorted.length) {
        container.innerHTML = '<div class="empty-state"><div class="empty-icon">💳</div><div class="empty-title">No expenses this month</div></div>';
        return;
    }
    container.innerHTML = sorted.map(([method, amount]) => {
        const pct = total > 0 ? (amount / total * 100).toFixed(1) : 0;
        return `<div class="pm-widget-row">
            <div class="pm-widget-left"><span class="pm-badge">${method}</span></div>
            <div class="pm-widget-bar-wrap"><div class="pm-widget-bar" style="width:${pct}%"></div></div>
            <div class="pm-widget-right"><span class="amount-expense">${fmt(amount)}</span><span class="pm-pct">${pct}%</span></div>
        </div>`;
    }).join('');
}

/* ============================================================
   ANALYTICS
   ============================================================ */
let pieChart=null, trendChart=null, barChart=null, budgetChart=null;

function renderAnalytics() {
    const filterVal = document.getElementById('analyticsDateFilter')?.value||'thisFinMonth';
    const range     = getDateRange(filterVal);
    const expenses  = financeData.expenses.filter(r=>inRange(r.date,range));
    const catSpend  = {};
    expenses.forEach(r=>{catSpend[r.category]=(catSpend[r.category]||0)+r.amount;});
    const sorted  = Object.entries(catSpend).sort((a,b)=>b[1]-a[1]);
    const colors  = ['#7c6fe0','#22c55e','#ef4444','#f59e0b','#3b82f6','#ec4899','#14b8a6','#f97316','#8b5cf6','#06b6d4','#a855f7','#10b981','#f43f5e','#0ea5e9','#84cc16'];
    const total   = sorted.reduce((s,e)=>s+e[1],0);

    // Pie
    if(pieChart) pieChart.destroy();
    const pc=document.getElementById('pieChart');
    if(pc && sorted.length) pieChart=new Chart(pc,{type:'doughnut',data:{labels:sorted.map(e=>e[0]),datasets:[{data:sorted.map(e=>e[1]),backgroundColor:colors,borderWidth:2,borderColor:getComputedStyle(document.documentElement).getPropertyValue('--bg-card')}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{color:getChartTextColor(),font:{size:11},padding:10}},tooltip:{callbacks:{label:c=>` ${c.label}: ${fmt(c.raw)} (${(c.raw/total*100).toFixed(1)}%)`}}}}});

    // Trend
    const months=[],incArr=[],expArr=[],balArr=[];
    for(let i=5;i>=0;i--){const d=new Date();d.setMonth(d.getMonth()-i);const fm=getFinancialMonth(new Date(d.getFullYear(),d.getMonth(),1));months.push(finMonthName(fm.month,fm.year).substring(0,3)+" '"+String(fm.year).slice(-2));const inc=financeData.incomes.filter(r=>isInFinancialMonth(r.date,fm.month,fm.year)).reduce((s,r)=>s+r.amount,0);const exp=financeData.expenses.filter(r=>isInFinancialMonth(r.date,fm.month,fm.year)).reduce((s,r)=>s+r.amount,0);incArr.push(inc);expArr.push(exp);balArr.push(inc-exp);}
    if(trendChart) trendChart.destroy();
    const tc=document.getElementById('trendChart');
    if(tc) trendChart=new Chart(tc,{type:'line',data:{labels:months,datasets:[{label:'Income',data:incArr,borderColor:'#22c55e',backgroundColor:'rgba(34,197,94,0.08)',fill:true,tension:0.4},{label:'Expense',data:expArr,borderColor:'#ef4444',backgroundColor:'rgba(239,68,68,0.08)',fill:true,tension:0.4},{label:'Balance',data:balArr,borderColor:'#7c6fe0',backgroundColor:'transparent',tension:0.4,borderDash:[6,3]}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:getChartTextColor(),font:{size:11}}},tooltip:{callbacks:{label:c=>` ${c.dataset.label}: ${fmt(c.raw)}`}}},scales:{x:{grid:{color:getChartGridColor()},ticks:{color:getChartTextColor(),font:{size:10}}},y:{grid:{color:getChartGridColor()},ticks:{color:getChartTextColor(),font:{size:10},callback:v=>fmt(v)}}}}});

    // Bar
    if(barChart) barChart.destroy();
    const bc=document.getElementById('barChart');
    if(bc && sorted.length) barChart=new Chart(bc,{type:'bar',data:{labels:sorted.map(e=>e[0]),datasets:[{label:'Amount',data:sorted.map(e=>e[1]),backgroundColor:colors,borderRadius:6}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>` ${fmt(c.raw)}`}}},scales:{x:{grid:{color:getChartGridColor()},ticks:{color:getChartTextColor(),font:{size:10},callback:v=>fmt(v)}},y:{grid:{color:'transparent'},ticks:{color:getChartTextColor(),font:{size:11}}}}}});

    // Budget vs Actual
    if(budgetChart) budgetChart.destroy();
    const bca=document.getElementById('budgetChart');
    if(bca && financeData.budgets.length) budgetChart=new Chart(bca,{type:'bar',data:{labels:financeData.budgets.map(b=>b.category),datasets:[{label:'Budget',data:financeData.budgets.map(b=>b.amount),backgroundColor:'rgba(124,111,224,0.4)',borderColor:'#7c6fe0',borderWidth:1,borderRadius:4},{label:'Actual',data:financeData.budgets.map(b=>catSpend[b.category]||0),backgroundColor:'rgba(239,68,68,0.5)',borderColor:'#ef4444',borderWidth:1,borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:getChartTextColor(),font:{size:11}}},tooltip:{callbacks:{label:c=>` ${c.dataset.label}: ${fmt(c.raw)}`}}},scales:{x:{grid:{color:getChartGridColor()},ticks:{color:getChartTextColor(),font:{size:10}}},y:{grid:{color:getChartGridColor()},ticks:{color:getChartTextColor(),font:{size:10},callback:v=>fmt(v)}}}}});

    // Payment method charts
    renderPaymentCharts(expenses);
}

/* ============================================================
   ANALYTICS — PAYMENT METHOD CHARTS
   ============================================================ */
let paymentPieChart = null, paymentBarChart = null;

function renderPaymentCharts(expenses) {
    const pmSpend = {};
    expenses.forEach(r => { const m = r.paid_using || 'Cash'; pmSpend[m] = (pmSpend[m] || 0) + r.amount; });
    const sorted = Object.entries(pmSpend).sort((a, b) => b[1] - a[1]);
    const total  = sorted.reduce((s, [, v]) => s + v, 0);
    const colors = ['#7c6fe0','#22c55e','#ef4444','#f59e0b','#3b82f6','#ec4899','#14b8a6','#f97316','#8b5cf6','#06b6d4','#a855f7','#10b981'];

    if (paymentPieChart) paymentPieChart.destroy();
    const ppc = document.getElementById('paymentPieChart');
    if (ppc && sorted.length) {
        paymentPieChart = new Chart(ppc, { type:'doughnut', data:{ labels:sorted.map(e=>e[0]), datasets:[{ data:sorted.map(e=>e[1]), backgroundColor:colors, borderWidth:2, borderColor:getComputedStyle(document.documentElement).getPropertyValue('--bg-card') }] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position:'right', labels:{ color:getChartTextColor(), font:{ size:11 }, padding:10 } }, tooltip:{ callbacks:{ label:c=>` ${c.label}: ${fmt(c.raw)} (${(c.raw/total*100).toFixed(1)}%)` } } } } });
    }

    if (paymentBarChart) paymentBarChart.destroy();
    const pbc = document.getElementById('paymentBarChart');
    if (pbc && sorted.length) {
        paymentBarChart = new Chart(pbc, { type:'bar', data:{ labels:sorted.map(e=>e[0]), datasets:[{ label:'Amount', data:sorted.map(e=>e[1]), backgroundColor:colors, borderRadius:6 }] }, options:{ indexAxis:'y', responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false }, tooltip:{ callbacks:{ label:c=>` ${fmt(c.raw)}` } } }, scales:{ x:{ grid:{ color:getChartGridColor() }, ticks:{ color:getChartTextColor(), font:{ size:10 }, callback:v=>fmt(v) } }, y:{ grid:{ color:'transparent' }, ticks:{ color:getChartTextColor(), font:{ size:11 } } } } } });
    }
}

/* ============================================================
   REPORTS
   ============================================================ */
function renderReports() {
    populateReportYears();
    generateReport();
}

function populateReportYears() {
    const sel = document.getElementById('reportYear');
    if (!sel || sel.options.length>1) return;
    const years = new Set([...financeData.incomes.map(r=>new Date(r.date).getFullYear()), ...financeData.expenses.map(r=>new Date(r.date).getFullYear()), new Date().getFullYear()]);
    [...years].sort((a,b)=>b-a).forEach(y=>{ const o=document.createElement('option'); o.value=y; o.textContent=y; sel.appendChild(o); });
}

function generateReport() {
    const type = document.getElementById('reportType')?.value||'finMonth';
    const year = parseInt(document.getElementById('reportYear')?.value)||new Date().getFullYear();
    const container = document.getElementById('reportContent');
    if (!container) return;
    if (type==='finMonth')  renderFinMonthReport(container);
    else if (type==='yearly') renderYearlyReport(container,year);
    else if (type==='payment') renderPaymentMethodReport(container);
    else renderCategoryReport(container);
}

function renderFinMonthReport(container) {
    const rows=[];
    for(let i=0;i<6;i++){
        const d=new Date(); d.setMonth(d.getMonth()-i);
        const fm=getFinancialMonth(new Date(d.getFullYear(),d.getMonth(),1));
        const inc=financeData.incomes.filter(r=>isInFinancialMonth(r.date,fm.month,fm.year)).reduce((s,r)=>s+r.amount,0);
        const exp=financeData.expenses.filter(r=>isInFinancialMonth(r.date,fm.month,fm.year)).reduce((s,r)=>s+r.amount,0);
        const fmExp=financeData.expenses.filter(r=>isInFinancialMonth(r.date,fm.month,fm.year));
        const cs={}; fmExp.forEach(r=>{cs[r.category]=(cs[r.category]||0)+r.amount;});
        const topCat=Object.entries(cs).sort((a,b)=>b[1]-a[1])[0];
        const topExp=fmExp.sort((a,b)=>b.amount-a.amount)[0];
        rows.push({name:finMonthName(fm.month,fm.year),range:finMonthRangeLabel(fm.month,fm.year),inc,exp,savings:inc-exp,savingsPct:inc>0?(((inc-exp)/inc)*100).toFixed(1):0,topCat:topCat?topCat[0]:'—',topExp:topExp?fmt(topExp.amount):'—',txCount:financeData.incomes.filter(r=>isInFinancialMonth(r.date,fm.month,fm.year)).length+fmExp.length});
    }
    container.innerHTML=`<div class="card"><div class="card-header"><h3>Financial Month Report</h3><span class="card-badge">Last 6 Months</span></div>
    <table class="data-table"><thead><tr><th>Month</th><th>Period</th><th>Income</th><th>Expenses</th><th>Savings</th><th>Savings %</th><th>Top Category</th><th>Transactions</th></tr></thead>
    <tbody>${rows.map(r=>`<tr><td><strong>${r.name}</strong></td><td style="font-size:11px;color:var(--text-muted)">${r.range}</td><td class="amount-income">${fmt(r.inc)}</td><td class="amount-expense">${fmt(r.exp)}</td><td class="${r.savings>=0?'amount-income':'amount-expense'}">${fmt(r.savings)}</td><td>${r.savingsPct}%</td><td><span class="cat-badge ${catClass(r.topCat)}">${r.topCat}</span></td><td>${r.txCount}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderYearlyReport(container, year) {
    const yInc=financeData.incomes.filter(r=>new Date(r.date).getFullYear()===year);
    const yExp=financeData.expenses.filter(r=>new Date(r.date).getFullYear()===year);
    const tI=yInc.reduce((s,r)=>s+r.amount,0), tE=yExp.reduce((s,r)=>s+r.amount,0);
    const mI=Array(12).fill(0), mE=Array(12).fill(0);
    yInc.forEach(r=>{mI[new Date(r.date).getMonth()]+=r.amount;});
    yExp.forEach(r=>{mE[new Date(r.date).getMonth()]+=r.amount;});
    const avgI=(mI.filter(v=>v>0).reduce((s,v)=>s+v,0)/(mI.filter(v=>v>0).length||1)).toFixed(0);
    const avgE=(mE.filter(v=>v>0).reduce((s,v)=>s+v,0)/(mE.filter(v=>v>0).length||1)).toFixed(0);
    const SH=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    container.innerHTML=`<div class="report-grid">
        <div class="report-stat"><div class="report-stat-label">Annual Income</div><div class="report-stat-value income">${fmt(tI)}</div></div>
        <div class="report-stat"><div class="report-stat-label">Annual Expenses</div><div class="report-stat-value expense">${fmt(tE)}</div></div>
        <div class="report-stat"><div class="report-stat-label">Net Savings</div><div class="report-stat-value savings">${fmt(tI-tE)}</div></div>
        <div class="report-stat"><div class="report-stat-label">Savings Rate</div><div class="report-stat-value">${tI>0?((tI-tE)/tI*100).toFixed(1):0}%</div></div>
        <div class="report-stat"><div class="report-stat-label">Avg Monthly Income</div><div class="report-stat-value">${fmt(avgI)}</div></div>
        <div class="report-stat"><div class="report-stat-label">Avg Monthly Spend</div><div class="report-stat-value">${fmt(avgE)}</div></div>
        <div class="report-stat"><div class="report-stat-label">Total Transactions</div><div class="report-stat-value">${yInc.length+yExp.length}</div></div>
        <div class="report-stat"><div class="report-stat-label">Year</div><div class="report-stat-value">${year}</div></div>
    </div>
    <div class="card"><div class="card-header"><h3>Monthly Breakdown — ${year}</h3></div>
    <table class="data-table"><thead><tr><th>Month</th><th>Income</th><th>Expenses</th><th>Savings</th><th>Savings %</th></tr></thead>
    <tbody>${SH.map((m,i)=>{const inc=mI[i],exp=mE[i],sav=inc-exp,pct=inc>0?((sav/inc)*100).toFixed(1):'—';return `<tr><td><strong>${m} ${year}</strong></td><td class="amount-income">${fmt(inc)}</td><td class="amount-expense">${fmt(exp)}</td><td class="${sav>=0?'amount-income':'amount-expense'}">${fmt(sav)}</td><td>${pct}${pct!=='—'?'%':''}</td></tr>`;}).join('')}</tbody></table></div>`;
}

function renderCategoryReport(container) {
    const catSpend={}, catCount={};
    financeData.expenses.forEach(r=>{catSpend[r.category]=(catSpend[r.category]||0)+r.amount;catCount[r.category]=(catCount[r.category]||0)+1;});
    const rows=Object.entries(catSpend).sort((a,b)=>b[1]-a[1]).map(([cat,total])=>({cat,total,count:catCount[cat],avg:total/catCount[cat]}));
    const grand=rows.reduce((s,r)=>s+r.total,0);
    container.innerHTML=`<div class="card"><div class="card-header"><h3>Category Report</h3><span class="card-badge">All Time</span></div>
    <table class="data-table"><thead><tr><th>Category</th><th>Total Spent</th><th>Transactions</th><th>Avg Transaction</th><th>% of Total</th></tr></thead>
    <tbody>${rows.map(r=>`<tr><td><span class="cat-badge ${catClass(r.cat)}">${catIcon(r.cat)} ${r.cat}</span></td><td class="amount-expense">${fmt(r.total)}</td><td>${r.count}</td><td>${fmt(r.avg.toFixed(0))}</td><td>${grand>0?(r.total/grand*100).toFixed(1):0}%</td></tr>`).join('')}</tbody></table></div>`;
}

function renderPaymentMethodReport(container) {
    const pmSpend={}, pmCount={};
    financeData.expenses.forEach(r=>{ const m=r.paid_using||'Cash'; pmSpend[m]=(pmSpend[m]||0)+r.amount; pmCount[m]=(pmCount[m]||0)+1; });
    const rows=Object.entries(pmSpend).sort((a,b)=>b[1]-a[1]).map(([m,total])=>({m,total,count:pmCount[m],avg:total/pmCount[m]}));
    const grand=rows.reduce((s,r)=>s+r.total,0);
    if (!rows.length) { container.innerHTML='<div class="card"><div style="padding:32px;text-align:center;color:var(--text-muted)">No expenses found.</div></div>'; return; }
    container.innerHTML=`<div class="card"><div class="card-header"><h3>Payment Method Report</h3><span class="card-badge">All Time</span></div>
    <table class="data-table"><thead><tr><th>Payment Method</th><th>Total Spent</th><th>Transactions</th><th>Avg Transaction</th><th>% of Total</th></tr></thead>
    <tbody>${rows.map(r=>`<tr><td><span class="pm-badge">${r.m}</span></td><td class="amount-expense">${fmt(r.total)}</td><td>${r.count}</td><td>${fmt(r.avg.toFixed(0))}</td><td>${grand>0?(r.total/grand*100).toFixed(1):0}%</td></tr>`).join('')}</tbody></table></div>`;
}

/* ============================================================
   BUDGET PAGE
   ============================================================ */
function renderBudgetPage() {
    const inp = document.getElementById('monthlyBudgetInput');
    if (inp) inp.value = financeData.settings.monthlyBudget||'';
    const fm = dashActiveFM||currentFinancialMonth();
    setText('budgetUtilMonthLabel', finMonthName(fm.month,fm.year));
    const fmExp = financeData.expenses.filter(r=>isInFinancialMonth(r.date,fm.month,fm.year));
    const catSpend={};
    fmExp.forEach(r=>{catSpend[r.category]=(catSpend[r.category]||0)+r.amount;});
    const totalFmExp=fmExp.reduce((s,r)=>s+r.amount,0);
    const monthBudget=financeData.settings.monthlyBudget||0;
    const statusCard=document.getElementById('monthlyBudgetStatus');
    if (statusCard && monthBudget>0) {
        const pct=Math.min((totalFmExp/monthBudget)*100,999).toFixed(1);
        const cls=pct>=90?'progress-critical':pct>=75?'progress-warning':'progress-safe';
        statusCard.innerHTML=`<div style="display:flex;justify-content:space-between;margin-bottom:8px"><span>Spent: <strong class="amount-expense">${fmt(totalFmExp)}</strong></span><span>Budget: <strong>${fmt(monthBudget)}</strong></span></div><div class="progress-bar" style="height:10px;border-radius:5px"><div class="progress-fill ${cls}" style="width:${Math.min(pct,100)}%"></div></div><div style="margin-top:8px;font-size:12px;color:var(--text-muted)">${pct}% used • ${monthBudget-totalFmExp>=0?fmt(monthBudget-totalFmExp)+' remaining':fmt(Math.abs(monthBudget-totalFmExp))+' over budget'}</div>`;
    }
    const container=document.getElementById('budgetProgressList');
    if (container) {
        if (!financeData.budgets.length) {
            container.innerHTML='<div class="empty-state"><div class="empty-icon">🎯</div><div class="empty-title">No category budgets</div></div>';
        } else {
            container.innerHTML=financeData.budgets.map(b=>{
                const spent=catSpend[b.category]||0, pct=b.amount>0?Math.min((spent/b.amount)*100,100):0;
                const over=spent-b.amount, cls=pct>=100?'progress-critical':pct>=90?'progress-critical':pct>=75?'progress-warning':'progress-safe';
                const pctCol=pct>=100?'var(--expense-color)':pct>=75?'var(--warning-color)':'var(--income-color)';
                let badge='';
                if(pct>=100) badge=`<span class="budget-warning-badge warning-100">⚠ Over Budget by ${fmt(over)}</span>`;
                else if(pct>=90) badge=`<span class="budget-warning-badge warning-90">⚡ Critical — ${(100-pct).toFixed(0)}% left</span>`;
                else if(pct>=75) badge=`<span class="budget-warning-badge warning-75">⚠ Warning — ${(100-pct).toFixed(0)}% left</span>`;
                return `<div class="budget-progress-item">
                    <div class="budget-progress-header">
                        <div><div class="budget-progress-name">${catIcon(b.category)} ${b.category}</div><div class="budget-progress-amounts">${fmt(spent)} of ${fmt(b.amount)}</div></div>
                        <div style="text-align:right"><div class="budget-progress-pct" style="color:${pctCol}">${pct.toFixed(1)}%</div>
                        <button class="action-btn delete-btn" style="font-size:11px;margin-top:4px" onclick="removeBudget(${b.id})">Remove</button></div>
                    </div>
                    <div class="budget-progress-bar"><div class="progress-fill ${cls}" style="width:${pct}%"></div></div>${badge}
                </div>`;
            }).join('');
        }
    }

    // Payment method budget section
    renderPaymentBudgetSection(fm, fmExp);
}

function renderPaymentBudgetSection(fm, fmExpenses) {
    setText('pmBudgetMonthLabel', finMonthName(fm.month, fm.year));

    // Populate method select
    const methodSel = document.getElementById('paymentBudgetMethodSelect');
    if (methodSel) {
        const prev = methodSel.value;
        const methods = financeData.settings.paymentMethods || DEFAULT_PAYMENT_METHODS;
        methodSel.innerHTML = '<option value="">Select Method</option>' +
            methods.map(m => `<option value="${m}"${m===prev?' selected':''}>${m}</option>`).join('');
    }

    // Render progress
    const container = document.getElementById('paymentBudgetProgressList');
    if (!container) return;
    const pmSpend = {};
    fmExpenses.forEach(r => { const m = r.paid_using||'Cash'; pmSpend[m]=(pmSpend[m]||0)+r.amount; });
    if (!financeData.paymentBudgets.length) {
        container.innerHTML = '<div class="empty-state"><div class="empty-icon">💳</div><div class="empty-title">No payment method budgets set</div></div>';
        return;
    }
    container.innerHTML = financeData.paymentBudgets.map(b => {
        const spent=pmSpend[b.method]||0, pct=b.amount>0?Math.min((spent/b.amount)*100,100):0;
        const over=spent-b.amount, cls=pct>=100?'progress-critical':pct>=75?'progress-warning':'progress-safe';
        const pctCol=pct>=100?'var(--expense-color)':pct>=75?'var(--warning-color)':'var(--income-color)';
        let badge='';
        if(pct>=100) badge=`<span class="budget-warning-badge warning-100">⚠ Over by ${fmt(over)}</span>`;
        else if(pct>=75) badge=`<span class="budget-warning-badge warning-75">⚠ ${(100-pct).toFixed(0)}% left</span>`;
        return `<div class="budget-progress-item">
            <div class="budget-progress-header">
                <div><div class="budget-progress-name">💳 ${b.method}</div><div class="budget-progress-amounts">${fmt(spent)} of ${fmt(b.amount)}</div></div>
                <div style="text-align:right"><div class="budget-progress-pct" style="color:${pctCol}">${pct.toFixed(1)}%</div>
                <button class="action-btn delete-btn" style="font-size:11px;margin-top:4px" onclick="removePaymentBudget(${b.id})">Remove</button></div>
            </div>
            <div class="budget-progress-bar"><div class="progress-fill ${cls}" style="width:${pct}%"></div></div>${badge}
        </div>`;
    }).join('');
}

async function removeBudget(id) {
    try {
        await dbDeleteBudget(id);
        financeData.budgets = financeData.budgets.filter(b=>b.id!==id);
        renderBudgetPage();
        showToast('Budget removed','success');
    } catch(e) { console.error('removeBudget error:', e); showToast('Failed to remove budget: '+(e.message||String(e)),'error'); }
}

async function removePaymentBudget(id) {
    try {
        await dbDeletePaymentBudget(id);
        financeData.paymentBudgets = financeData.paymentBudgets.filter(b=>b.id!==id);
        renderBudgetPage();
        showToast('Budget removed','success');
    } catch(e) { console.error('removePaymentBudget error:', e); showToast('Failed to remove: '+(e.message||String(e)),'error'); }
}

/* ============================================================
   SETTINGS PAGE
   ============================================================ */
function renderSettingsPage() {
    const cs = document.getElementById('currencySetting');
    const ts = document.getElementById('themeSetting');
    const sd = document.getElementById('finMonthStartDay');
    if (cs) cs.value = financeData.settings.currency||'INR';
    if (ts) ts.value = financeData.settings.theme||'dark';
    if (sd) sd.value = financeData.settings.finMonthStartDay||22;
    updateFMPreview();
    renderPaymentMethodsSettings();
}

function renderPaymentMethodsSettings() {
    const list = document.getElementById('paymentMethodsList');
    if (!list) return;
    const methods = financeData.settings.paymentMethods || DEFAULT_PAYMENT_METHODS;
    list.innerHTML = methods.map(m => `
        <div class="setting-item">
            <span class="pm-badge">${m}</span>
            <button class="action-btn delete-btn" style="font-size:11px" onclick="removePaymentMethod('${m.replace(/'/g,"\\'")}')">Remove</button>
        </div>`).join('');
}

async function removePaymentMethod(method) {
    financeData.settings.paymentMethods = (financeData.settings.paymentMethods || []).filter(m => m !== method);
    await syncProfile();
    renderPaymentMethodsSettings();
    renderPaymentBudgetSection(dashActiveFM || currentFinancialMonth(), financeData.expenses.filter(r => isInFinancialMonth(r.date, (dashActiveFM||currentFinancialMonth()).month, (dashActiveFM||currentFinancialMonth()).year)));
    showToast('Payment method removed','success');
}

function updateFMPreview() {
    const preview  = document.getElementById('fmRangePreview');
    if (!preview) return;
    const sd  = parseInt(document.getElementById('finMonthStartDay')?.value)||financeData.settings.finMonthStartDay||22;
    const SH  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const fm  = getFinancialMonth(new Date());
    const pm  = fm.month===0?11:fm.month-1;
    preview.textContent = `Current FM: ${SH[pm]} ${sd} → ${SH[fm.month]} ${sd-1}, ${fm.year}`;
}

function populateFMPickers() {
    const months = getFinancialMonthsList(12);
    ['incomeFMPicker','expenseFMPicker','txFMPicker'].forEach(id=>{
        const sel=document.getElementById(id); if(!sel) return;
        const prev=sel.value;
        sel.innerHTML='<option value="">Select Month…</option>';
        months.forEach(fm=>{ const o=document.createElement('option'); o.value=`${fm.year}-${fm.month}`; o.textContent=`${finMonthName(fm.month,fm.year)} (${finMonthRangeLabel(fm.month,fm.year)})`; sel.appendChild(o); });
        if(prev) sel.value=prev;
    });
}

/* ============================================================
   OPENING BALANCE
   ============================================================ */
function getFMStartDate(fmMonth, fmYear) {
    const startDay = financeData.settings.finMonthStartDay || 22;
    // FM "July 2026" (month=6) starts on June 22 2026 → prev calendar month
    const calMonth = fmMonth === 0 ? 11 : fmMonth - 1;
    const calYear  = fmMonth === 0 ? fmYear - 1 : fmYear;
    return `${calYear}-${String(calMonth + 1).padStart(2,'0')}-${String(startDay).padStart(2,'0')}`;
}

function openOpeningBalanceModal() {
    const fm    = dashActiveFM || currentFinancialMonth();
    const label = document.getElementById('obMonthLabel');
    if (label) label.textContent = `${finMonthName(fm.month, fm.year)} FM`;

    const list    = document.getElementById('obMethodsList');
    const methods = financeData.settings.paymentMethods || DEFAULT_PAYMENT_METHODS;
    if (list) {
        list.innerHTML = methods.map(m => `
            <div style="display:flex;align-items:center;gap:12px">
                <span class="pm-badge" style="min-width:110px;text-align:center">${m}</span>
                <input type="number" class="form-input ob-amount-input" data-method="${m}"
                    placeholder="0.00" step="0.01" min="0" style="flex:1" />
            </div>`).join('');

        // Pre-fill existing opening balance entries for this FM
        const existing = financeData.incomes.filter(r =>
            r.category === 'Opening Balance' && isInFinancialMonth(r.date, fm.month, fm.year));
        existing.forEach(r => {
            const inp = list.querySelector(`[data-method="${r.notes}"]`);
            if (inp) inp.value = r.amount;
        });
    }

    showFormError('obFormError', '');
    openModal('openingBalanceModal');
}

async function saveOpeningBalance() {
    showFormError('obFormError', '');
    if (!currentUser) { showFormError('obFormError', 'Not signed in — please refresh.'); return; }

    const fm      = dashActiveFM || currentFinancialMonth();
    const fmStart = getFMStartDate(fm.month, fm.year);
    const inputs  = document.querySelectorAll('.ob-amount-input');

    const entries = [];
    inputs.forEach(inp => {
        const amount = parseFloat(inp.value);
        if (amount > 0) entries.push({ amount, method: inp.dataset.method });
    });
    if (!entries.length) { showFormError('obFormError', 'Enter at least one balance amount'); return; }

    const btn = document.getElementById('saveOpeningBalanceBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        // Remove existing opening balance entries for this FM
        const existing = financeData.incomes.filter(r =>
            r.category === 'Opening Balance' && isInFinancialMonth(r.date, fm.month, fm.year));
        for (const r of existing) await dbDeleteIncome(r.id);
        financeData.incomes = financeData.incomes.filter(r =>
            !(r.category === 'Opening Balance' && isInFinancialMonth(r.date, fm.month, fm.year)));

        // Insert new entries (one per payment method)
        for (const { amount, method } of entries) {
            const newId = await dbInsertIncome({
                amount, date: fmStart,
                source:   'Opening Balance',
                category: 'Opening Balance',
                notes:    method
            });
            financeData.incomes.unshift({ id: newId, amount, date: fmStart, source: 'Opening Balance', category: 'Opening Balance', notes: method });
        }

        closeModal('openingBalanceModal');
        renderIncomeTable();
        renderDashboard();
        showToast(`Opening balance saved for ${finMonthName(fm.month, fm.year)} FM`, 'success');
    } catch(err) {
        console.error('saveOpeningBalance error:', err);
        showFormError('obFormError', 'Save failed: ' + (err.message || String(err)));
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Save Opening Balance'; }
    }
}

/* ============================================================
   INCOME CRUD
   ============================================================ */
function openAddIncome() {
    document.getElementById('incomeEditId').value='';
    document.getElementById('incomeModalTitle').textContent='Add Income';
    document.getElementById('incomeForm').reset();
    document.getElementById('incomeDate').value=new Date().toISOString().split('T')[0];
    showFormError('incomeFormError', '');
    openModal('incomeModal');
}

function openEditIncome(id) {
    const rec=financeData.incomes.find(r=>r.id===id); if(!rec) return;
    document.getElementById('incomeEditId').value=id;
    document.getElementById('incomeModalTitle').textContent='Edit Income';
    document.getElementById('incomeAmount').value=rec.amount;
    document.getElementById('incomeDate').value=rec.date;
    document.getElementById('incomeSource').value=rec.source;
    document.getElementById('incomeCategory').value=rec.category;
    document.getElementById('incomeNotes').value=rec.notes||'';
    showFormError('incomeFormError', '');
    openModal('incomeModal');
}

function showFormError(id, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
}

async function saveIncome(e) {
    e.preventDefault();
    showFormError('incomeFormError', '');
    if (!currentUser) { showFormError('incomeFormError', 'Not signed in — please refresh the page.'); return; }
    if (!sb)          { showFormError('incomeFormError', 'App not connected — please refresh the page.'); return; }
    const amount   = parseFloat(document.getElementById('incomeAmount').value);
    const date     = document.getElementById('incomeDate').value;
    const source   = document.getElementById('incomeSource').value.trim();
    const category = document.getElementById('incomeCategory').value;
    const notes    = document.getElementById('incomeNotes').value.trim();

    if (!amount||amount<=0) { showFormError('incomeFormError','Amount must be greater than 0'); return; }
    if (!date)     { showFormError('incomeFormError','Date is required'); return; }
    if (!source)   { showFormError('incomeFormError','Source is required'); return; }
    if (!category) { showFormError('incomeFormError','Category is required'); return; }

    const editId = parseInt(document.getElementById('incomeEditId').value);
    try {
        if (editId) {
            await dbUpdateIncome(editId, { amount, date, source, category, notes });
            const idx=financeData.incomes.findIndex(r=>r.id===editId);
            if (idx>=0) financeData.incomes[idx]={...financeData.incomes[idx],amount,date,source,category,notes};
            showToast('Income updated','success');
        } else {
            const newId = await dbInsertIncome({ amount, date, source, category, notes });
            financeData.incomes.unshift({ id:newId, amount, date, source, category, notes });
            showToast('Income added','success');
        }
    } catch(err) {
        console.error('saveIncome error:', err);
        showFormError('incomeFormError', 'Save failed: ' + (err.message || String(err)));
        return;
    }

    showFormError('incomeFormError', '');
    closeModal('incomeModal');
    renderIncomeTable();
    renderDashboard();
}

/* ============================================================
   EXPENSE CRUD
   ============================================================ */
function populatePaidUsingSelect(selectedValue) {
    const sel = document.getElementById('expensePaidUsing');
    if (!sel) return;
    const methods = financeData.settings.paymentMethods || DEFAULT_PAYMENT_METHODS;
    sel.innerHTML = methods.map(m => `<option value="${m}"${m===selectedValue?' selected':''}>${m}</option>`).join('');
}

function openAddExpense() {
    document.getElementById('expenseEditId').value='';
    document.getElementById('expenseModalTitle').textContent='Add Expense';
    document.getElementById('expenseForm').reset();
    document.getElementById('expenseDate').value=new Date().toISOString().split('T')[0];
    document.getElementById('expenseTime').value=new Date().toTimeString().slice(0,5);
    populatePaidUsingSelect('Cash');
    showFormError('expenseFormError', '');
    openModal('expenseModal');
}

function openEditExpense(id) {
    const rec=financeData.expenses.find(r=>r.id===id); if(!rec) return;
    document.getElementById('expenseEditId').value=id;
    document.getElementById('expenseModalTitle').textContent='Edit Expense';
    document.getElementById('expenseAmount').value=rec.amount;
    document.getElementById('expenseDate').value=rec.date;
    document.getElementById('expenseTime').value=rec.time||'';
    document.getElementById('expenseCategory').value=rec.category;
    document.getElementById('expenseDescription').value=rec.description;
    document.getElementById('expenseComments').value=rec.comments||'';
    populatePaidUsingSelect(rec.paid_using||'Cash');
    showFormError('expenseFormError', '');
    openModal('expenseModal');
}

async function saveExpense(e) {
    e.preventDefault();
    showFormError('expenseFormError', '');
    if (!currentUser) { showFormError('expenseFormError', 'Not signed in — please refresh the page.'); return; }
    if (!sb)          { showFormError('expenseFormError', 'App not connected — please refresh the page.'); return; }
    const amount      = parseFloat(document.getElementById('expenseAmount').value);
    const date        = document.getElementById('expenseDate').value;
    const time        = document.getElementById('expenseTime').value;
    const category    = document.getElementById('expenseCategory').value;
    const description = document.getElementById('expenseDescription').value.trim();
    const comments    = document.getElementById('expenseComments').value.trim();
    const paid_using  = document.getElementById('expensePaidUsing').value || 'Cash';

    if (!amount||amount<=0)  { showFormError('expenseFormError','Amount must be greater than 0'); return; }
    if (!date)               { showFormError('expenseFormError','Date is required'); return; }
    if (!category)           { showFormError('expenseFormError','Category is required'); return; }
    if (!description)        { showFormError('expenseFormError','Description is required'); return; }

    const editId = parseInt(document.getElementById('expenseEditId').value);
    try {
        if (editId) {
            await dbUpdateExpense(editId, { amount, date, time, category, description, comments, paid_using });
            const idx=financeData.expenses.findIndex(r=>r.id===editId);
            if (idx>=0) financeData.expenses[idx]={...financeData.expenses[idx],amount,date,time,category,description,comments,paid_using};
            showToast('Expense updated','success');
        } else {
            const newId = await dbInsertExpense({ amount, date, time, category, description, comments, paid_using });
            financeData.expenses.unshift({ id:newId, amount, date, time, category, description, comments, paid_using });
            showToast('Expense added','success');
        }
    } catch(err) {
        console.error('saveExpense error:', err);
        showFormError('expenseFormError', 'Save failed: ' + (err.message || String(err)));
        return;
    }

    showFormError('expenseFormError', '');
    closeModal('expenseModal');
    renderExpenseTable();
    renderDashboard();
}

/* ============================================================
   DELETE
   ============================================================ */
let pendingDelete=null;

function confirmDelete(type, id) {
    pendingDelete={type,id};
    const rec  = type==='income' ? financeData.incomes.find(r=>r.id===id) : financeData.expenses.find(r=>r.id===id);
    const label= type==='income' ? (rec?.source||'income record') : (rec?.description||'expense record');
    document.getElementById('confirmMessage').textContent=`Delete "${label}"? This cannot be undone.`;
    document.getElementById('confirmActionBtn').onclick = executeDelete;
    openModal('confirmModal');
}

async function executeDelete() {
    if (!pendingDelete) return;
    const { type, id } = pendingDelete;
    try {
        if (type==='income') {
            await dbDeleteIncome(id);
            financeData.incomes=financeData.incomes.filter(r=>r.id!==id);
        } else {
            await dbDeleteExpense(id);
            financeData.expenses=financeData.expenses.filter(r=>r.id!==id);
        }
        closeModal('confirmModal');
        pendingDelete=null;
        renderIncomeTable(); renderExpenseTable(); renderTransactionTable(); renderDashboard();
        showToast('Record deleted','success');
    } catch(err) { console.error('delete error:', err); showToast('Delete failed: '+(err.message||String(err)),'error'); }
}

/* ============================================================
   MODALS & TOAST
   ============================================================ */
function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

function showToast(message, type='info') {
    const icons={success:'✓',error:'✕',warning:'⚠',info:'ℹ'};
    const toast=document.createElement('div');
    toast.className=`toast toast-${type}`;
    toast.innerHTML=`<span class="toast-icon">${icons[type]}</span><span>${message}</span>`;
    document.getElementById('toastContainer').appendChild(toast);
    setTimeout(()=>{ toast.classList.add('out'); setTimeout(()=>toast.remove(),300); },3000);
}

/* ============================================================
   EXPORT
   ============================================================ */
function getAllTransactionsForExport() {
    return [
        ...financeData.incomes.map(r=>({Date:r.date,Time:'',Type:'Income',Category:r.category,Description:r.source,Amount:r.amount,Notes:r.notes||''})),
        ...financeData.expenses.map(r=>({Date:r.date,Time:r.time||'',Type:'Expense',Category:r.category,Description:r.description,Amount:-r.amount,'Paid Using':r.paid_using||'Cash',Notes:r.comments||''}))
    ].sort((a,b)=>new Date(b.Date)-new Date(a.Date));
}

function exportCsv() {
    const rows=getAllTransactionsForExport();
    if (!rows.length) { showToast('No data to export','warning'); return; }
    const headers=Object.keys(rows[0]);
    const csv=[headers.join(','),...rows.map(r=>headers.map(h=>`"${String(r[h]).replace(/"/g,'""')}"`).join(','))].join('\n');
    downloadFile('fintrack-export.csv','text/csv',csv);
    showToast('CSV exported','success');
}

function exportExcel() {
    if (typeof XLSX==='undefined') { showToast('SheetJS not loaded','error'); return; }
    const rows=getAllTransactionsForExport(); if(!rows.length){ showToast('No data','warning'); return; }
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),'Transactions');
    const fm=currentFinancialMonth();
    XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet([
        {Metric:'Total Income',Value:financeData.incomes.reduce((s,r)=>s+r.amount,0)},
        {Metric:'Total Expenses',Value:financeData.expenses.reduce((s,r)=>s+r.amount,0)},
        {Metric:'This FM Income',Value:financeData.incomes.filter(r=>isInFinancialMonth(r.date,fm.month,fm.year)).reduce((s,r)=>s+r.amount,0)},
        {Metric:'Monthly Budget',Value:financeData.settings.monthlyBudget}
    ]),'Summary');
    XLSX.writeFile(wb,'fintrack-export.xlsx');
    showToast('Excel exported','success');
}

function exportPdf() {
    const {jsPDF}=window.jspdf||{}; if(!jsPDF){ showToast('jsPDF not loaded','error'); return; }
    const doc=new jsPDF();
    doc.setFontSize(18); doc.text('FinTrack — Transaction Report',14,18);
    doc.setFontSize(10); doc.text(`Generated: ${new Date().toLocaleString()}  |  User: ${currentUser?.email||''}`,14,26);
    doc.autoTable({head:[['Date','Type','Category','Description','Amount','Notes']],body:getAllTransactionsForExport().slice(0,200).map(r=>[r.Date,r.Type,r.Category,r.Description,`${currencySymbol()}${Math.abs(r.Amount).toLocaleString()}`,r.Notes]),startY:32,styles:{fontSize:8},headStyles:{fillColor:[124,111,224]}});
    doc.save('fintrack-report.pdf');
    showToast('PDF exported','success');
}

function exportJson() {
    downloadFile(`fintrack-backup-${new Date().toISOString().split('T')[0]}.json`,'application/json',JSON.stringify(financeData,null,2));
    showToast('JSON exported','success');
}

function downloadFile(filename, mimeType, content) {
    const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(new Blob([content],{type:mimeType})),download:filename});
    a.click(); URL.revokeObjectURL(a.href);
}

/* ============================================================
   IMPORT / RESTORE  (pushes to Supabase)
   ============================================================ */
async function restoreFromFile(file) {
    if (!file || !currentUser) return;
    const reader=new FileReader();
    reader.onload=async e=>{
        try {
            const parsed=JSON.parse(e.target.result);
            if (!parsed.incomes||!parsed.expenses) throw new Error('Invalid structure');
            showLoader('Restoring data to cloud…');
            // Delete all existing records
            await sb.from('incomes').delete().eq('user_id',currentUser.id);
            await sb.from('expenses').delete().eq('user_id',currentUser.id);
            await sb.from('budgets').delete().eq('user_id',currentUser.id);
            // Insert restored records (strip old IDs so Supabase generates new ones)
            if (parsed.incomes.length)  await sb.from('incomes').insert(parsed.incomes.map(r=>({user_id:currentUser.id,amount:r.amount,date:r.date,source:r.source,category:r.category,notes:r.notes||''})));
            if (parsed.expenses.length) await sb.from('expenses').insert(parsed.expenses.map(r=>({user_id:currentUser.id,amount:r.amount,date:r.date,time:r.time||'',category:r.category,description:r.description,comments:r.comments||''})));
            if (parsed.budgets?.length) await sb.from('budgets').insert(parsed.budgets.map(b=>({user_id:currentUser.id,category:b.category,amount:b.amount})));
            if (parsed.settings) { financeData.settings={...financeData.settings,...parsed.settings}; await syncProfile(); }
            // Reload from DB
            await loadAllData(currentUser.id);
            hideLoader();
            renderDashboard();
            showToast('Data restored successfully','success');
        } catch(err) { hideLoader(); showToast('Restore failed: '+err.message,'error'); }
    };
    reader.readAsText(file);
}

/* ============================================================
   JSON VIEWER
   ============================================================ */
function openJsonViewer() {
    const v=document.getElementById('jsonViewer');
    if (v) v.innerHTML=syntaxHighlight(JSON.stringify(financeData,null,2));
    openModal('jsonViewerModal');
}

function syntaxHighlight(json) {
    return json.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,m=>{
            let c='json-number';
            if(/^"/.test(m)) c=/:$/.test(m)?'json-key':'json-string';
            else if(/true|false/.test(m)) c='json-bool';
            else if(/null/.test(m)) c='json-null';
            return `<span class="${c}">${m}</span>`;
        });
}

/* ============================================================
   THEME
   ============================================================ */
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme',theme);
    financeData.settings.theme=theme;
    const icon=document.getElementById('themeIcon'), label=document.getElementById('themeLabel'), sel=document.getElementById('themeSetting');
    if(icon)  icon.textContent  = theme==='dark' ? '☀' : '🌙';
    if(label) label.textContent = theme==='dark' ? 'Light Mode' : 'Dark Mode';
    if(sel)   sel.value         = theme;
    if (currentUser) syncProfile(); // persist to Supabase
}

function toggleTheme() {
    applyTheme(financeData.settings.theme==='dark'?'light':'dark');
    renderDashboard();
}

/* ============================================================
   RESET DATA
   ============================================================ */
function resetAllData() {
    document.getElementById('confirmMessage').textContent='This will DELETE ALL your data from the cloud permanently. Cannot be undone. Are you sure?';
    document.getElementById('confirmActionBtn').onclick=async ()=>{
        try {
            showLoader('Deleting all data…');
            await sb.from('incomes').delete().eq('user_id',currentUser.id);
            await sb.from('expenses').delete().eq('user_id',currentUser.id);
            await sb.from('budgets').delete().eq('user_id',currentUser.id);
            financeData.incomes=[]; financeData.expenses=[]; financeData.budgets=[];
            hideLoader(); closeModal('confirmModal');
            renderDashboard();
            showToast('All data has been reset','warning');
        } catch(err) { hideLoader(); showToast('Reset failed: '+err.message,'error'); }
    };
    openModal('confirmModal');
}

/* ============================================================
   EVENT LISTENERS
   ============================================================ */
function initEventListeners() {
    // Auth
    document.getElementById('signInForm')?.addEventListener('submit', e=>{ e.preventDefault(); signIn(document.getElementById('signInUsername').value); });
    document.getElementById('signUpForm')?.addEventListener('submit', e=>{ e.preventDefault(); signUp(document.getElementById('signUpUsername').value); });
    document.querySelectorAll('.auth-tab').forEach(tab=>{
        tab.addEventListener('click',()=>{
            document.querySelectorAll('.auth-tab').forEach(t=>t.classList.remove('active'));
            tab.classList.add('active');
            const which=tab.dataset.authTab;
            document.getElementById('signInForm').classList.toggle('hidden', which!=='signin');
            document.getElementById('signUpForm').classList.toggle('hidden', which!=='signup');
            setAuthMessage('');
        });
    });
    document.getElementById('logoutBtn')?.addEventListener('click', signOut);

    // Navigation
    document.querySelectorAll('.nav-item[data-section]').forEach(el=>{
        el.addEventListener('click',e=>{ e.preventDefault(); navigate(el.dataset.section); });
    });
    document.querySelectorAll('.mobile-nav-item[data-section]').forEach(el=>{
        el.addEventListener('click',e=>{ e.preventDefault(); navigate(el.dataset.section); });
    });

    // Sidebar
    document.getElementById('sidebarToggle')?.addEventListener('click',()=>{
        document.getElementById('sidebar').classList.toggle('collapsed');
        document.getElementById('mainContent').classList.toggle('expanded');
    });
    document.getElementById('mobileMenuBtn')?.addEventListener('click',()=>{
        document.getElementById('sidebar').classList.toggle('mobile-open');
    });
    document.getElementById('themeToggle')?.addEventListener('click', toggleTheme);

    // Quick add
    ['quickAddExpenseBtn','quickAddExpenseBtn2'].forEach(id=>document.getElementById(id)?.addEventListener('click',openAddExpense));
    ['quickAddIncomeBtn','quickAddIncomeBtn2'].forEach(id=>document.getElementById(id)?.addEventListener('click',openAddIncome));

    // Income
    document.getElementById('addIncomeBtn')?.addEventListener('click',openAddIncome);
    document.getElementById('openingBalanceBtn')?.addEventListener('click',openOpeningBalanceModal);
    document.getElementById('saveOpeningBalanceBtn')?.addEventListener('click',saveOpeningBalance);
    document.getElementById('incomeForm')?.addEventListener('submit',saveIncome);
    document.getElementById('incomeSearch')?.addEventListener('input',()=>{ paginationState.income.page=1; renderIncomeTable(); });
    document.getElementById('incomeCategoryFilter')?.addEventListener('change',()=>{ paginationState.income.page=1; renderIncomeTable(); });
    document.getElementById('incomeDateFilter')?.addEventListener('change',e=>{
        document.getElementById('incomeFMPicker')?.classList.toggle('hidden', e.target.value!=='selectFinMonth');
        paginationState.income.page=1; renderIncomeTable();
    });
    document.getElementById('incomeFMPicker')?.addEventListener('change',()=>{ paginationState.income.page=1; renderIncomeTable(); });

    // Expense
    document.getElementById('addExpenseBtn')?.addEventListener('click',openAddExpense);
    document.getElementById('expenseForm')?.addEventListener('submit',saveExpense);
    document.getElementById('expenseSearch')?.addEventListener('input',()=>{ paginationState.expense.page=1; renderExpenseTable(); });
    document.getElementById('expenseCategoryFilter')?.addEventListener('change',()=>{ paginationState.expense.page=1; renderExpenseTable(); });
    document.getElementById('expenseDateFilter')?.addEventListener('change',e=>{
        document.getElementById('expenseFMPicker')?.classList.toggle('hidden', e.target.value!=='selectFinMonth');
        paginationState.expense.page=1; renderExpenseTable();
    });
    document.getElementById('expenseFMPicker')?.addEventListener('change',()=>{ paginationState.expense.page=1; renderExpenseTable(); });

    // Transactions
    ['txSearch','txTypeFilter','txCategoryFilter','txMinAmount','txMaxAmount'].forEach(id=>{
        document.getElementById(id)?.addEventListener('input',()=>{ paginationState.tx.page=1; renderTransactionTable(); });
        document.getElementById(id)?.addEventListener('change',()=>{ paginationState.tx.page=1; renderTransactionTable(); });
    });
    document.getElementById('txDateFilter')?.addEventListener('change',e=>{
        document.getElementById('txCustomRange')?.classList.toggle('hidden', e.target.value!=='custom');
        document.getElementById('txFMPicker')?.classList.toggle('hidden', e.target.value!=='selectFinMonth');
        paginationState.tx.page=1; renderTransactionTable();
    });
    document.getElementById('txFMPicker')?.addEventListener('change',()=>{ paginationState.tx.page=1; renderTransactionTable(); });
    document.getElementById('txDateFrom')?.addEventListener('change',()=>{ paginationState.tx.page=1; renderTransactionTable(); });
    document.getElementById('txDateTo')?.addEventListener('change',()=>{ paginationState.tx.page=1; renderTransactionTable(); });
    document.getElementById('txExportCsv')?.addEventListener('click',exportCsv);
    document.getElementById('txExportExcel')?.addEventListener('click',exportExcel);
    document.getElementById('txExportPdf')?.addEventListener('click',exportPdf);

    // Analytics & Reports
    document.getElementById('analyticsDateFilter')?.addEventListener('change',renderAnalytics);
    document.getElementById('reportType')?.addEventListener('change',generateReport);
    document.getElementById('reportYear')?.addEventListener('change',generateReport);
    document.getElementById('reportExportPdf')?.addEventListener('click',exportPdf);
    document.getElementById('reportExportExcel')?.addEventListener('click',exportExcel);

    // Budget
    document.getElementById('saveMonthlyBudget')?.addEventListener('click',async()=>{
        const val=parseFloat(document.getElementById('monthlyBudgetInput').value);
        if(!val||val<=0){ showToast('Enter a valid amount','error'); return; }
        financeData.settings.monthlyBudget=val;
        await syncProfile();
        renderBudgetPage(); renderDashboard();
        showToast('Monthly budget updated','success');
    });
    document.getElementById('saveCategoryBudget')?.addEventListener('click',async()=>{
        showFormError('budgetFormError','');
        const cat=document.getElementById('budgetCategorySelect').value;
        const amt=parseFloat(document.getElementById('budgetAmountInput').value);
        if(!cat){ showFormError('budgetFormError','Select a category'); return; }
        if(!amt||amt<=0){ showFormError('budgetFormError','Enter a valid amount'); return; }
        if(!currentUser){ showFormError('budgetFormError','Not signed in — please refresh the page.'); return; }
        try {
            const newId=await dbUpsertBudget(cat,amt);
            const idx=financeData.budgets.findIndex(b=>b.category===cat);
            if(idx>=0) financeData.budgets[idx].amount=amt;
            else financeData.budgets.push({id:newId,category:cat,amount:amt});
            showFormError('budgetFormError','');
            renderBudgetPage();
            showToast(`Budget set for ${cat}`,'success');
        } catch(err){ console.error('saveBudget error:', err); showFormError('budgetFormError','Failed: '+(err.message||String(err))); }
    });

    // Payment method budget
    document.getElementById('savePaymentBudget')?.addEventListener('click', async () => {
        showFormError('paymentBudgetFormError','');
        const method = document.getElementById('paymentBudgetMethodSelect').value;
        const amt    = parseFloat(document.getElementById('paymentBudgetAmountInput').value);
        if (!method) { showFormError('paymentBudgetFormError','Select a payment method'); return; }
        if (!amt||amt<=0) { showFormError('paymentBudgetFormError','Enter a valid amount'); return; }
        if (!currentUser) { showFormError('paymentBudgetFormError','Not signed in — please refresh the page.'); return; }
        try {
            const newId = await dbUpsertPaymentBudget(method, amt);
            const idx = financeData.paymentBudgets.findIndex(b=>b.method===method);
            if (idx>=0) financeData.paymentBudgets[idx].amount=amt;
            else financeData.paymentBudgets.push({ id:newId, method, amount:amt });
            showFormError('paymentBudgetFormError','');
            renderBudgetPage();
            showToast(`Budget set for ${method}`,'success');
        } catch(err) { console.error('savePaymentBudget error:', err); showFormError('paymentBudgetFormError','Failed: '+(err.message||String(err))); }
    });

    // Payment methods management
    document.getElementById('addPaymentMethodBtn')?.addEventListener('click', async () => {
        const inp = document.getElementById('newPaymentMethodInput');
        const val = inp?.value.trim();
        if (!val) { showToast('Enter a method name','warning'); return; }
        const methods = financeData.settings.paymentMethods || DEFAULT_PAYMENT_METHODS;
        if (methods.includes(val)) { showToast('Method already exists','warning'); return; }
        financeData.settings.paymentMethods = [...methods, val];
        await syncProfile();
        if (inp) inp.value = '';
        renderPaymentMethodsSettings();
        showToast(`"${val}" added`,'success');
    });

    // Settings
    document.getElementById('finMonthStartDay')?.addEventListener('input',updateFMPreview);
    document.getElementById('saveFinMonthStartDay')?.addEventListener('click',async()=>{
        const val=parseInt(document.getElementById('finMonthStartDay')?.value);
        if(!val||val<1||val>28){ showToast('Start day must be 1–28','error'); return; }
        financeData.settings.finMonthStartDay=val;
        dashActiveFM=null;
        await syncProfile();
        populateFMPickers(); updateFMPreview(); renderDashboard();
        showToast(`Financial month starts on day ${val}`,'success');
    });
    document.getElementById('currencySetting')?.addEventListener('change',async e=>{
        financeData.settings.currency=e.target.value;
        await syncProfile(); renderDashboard();
        showToast('Currency updated','success');
    });
    document.getElementById('themeSetting')?.addEventListener('change',e=>applyTheme(e.target.value));

    // Data management
    document.getElementById('exportJsonBtn')?.addEventListener('click',exportJson);
    document.getElementById('exportCsvBtn')?.addEventListener('click',exportCsv);
    document.getElementById('exportExcelBtn')?.addEventListener('click',exportExcel);
    document.getElementById('exportPdfBtn')?.addEventListener('click',exportPdf);
    document.getElementById('backupDataBtn')?.addEventListener('click',exportJson);
    document.getElementById('restoreDataBtn')?.addEventListener('click',()=>document.getElementById('restoreFileInput').click());
    document.getElementById('restoreFileInput')?.addEventListener('change',e=>restoreFromFile(e.target.files[0]));
    document.getElementById('resetDataBtn')?.addEventListener('click',resetAllData);

    // JSON Viewer
    document.getElementById('openJsonViewerBtn')?.addEventListener('click',openJsonViewer);
    document.getElementById('copyJsonBtn')?.addEventListener('click',()=>{ navigator.clipboard?.writeText(JSON.stringify(financeData,null,2)); showToast('JSON copied','success'); });
    document.getElementById('downloadJsonBtn')?.addEventListener('click',exportJson);
    document.getElementById('importJsonFile')?.addEventListener('change',e=>restoreFromFile(e.target.files[0]));

    // Modals
    document.querySelectorAll('[data-modal]').forEach(el=>el.addEventListener('click',()=>closeModal(el.dataset.modal)));
    document.querySelectorAll('.modal-overlay').forEach(o=>o.addEventListener('click',e=>{ if(e.target===o) closeModal(o.id); }));

    // Sort headers
    initSortHeaders('incomeTable',  paginationState.income,  renderIncomeTable);
    initSortHeaders('expenseTable', paginationState.expense, renderExpenseTable);
    initSortHeaders('txTable',      paginationState.tx,      renderTransactionTable);
}

/* ============================================================
   APP INIT
   ============================================================ */
async function init() {
    initEventListeners();

    window.addEventListener('unhandledrejection', e => {
        const msg = e.reason?.message || String(e.reason);
        console.error('Unhandled async error:', e.reason);
        showToast('Unexpected error: ' + msg, 'error');
    });

    // Hide user pill until logged in
    const pill=document.getElementById('userPill');
    if(pill) pill.style.display='none';

    if (!initSupabase()) {
        // No Supabase config — show auth screen with warning
        showAuthScreen();
        return;
    }

    checkDbConnection(); // non-blocking — updates #dbStatus banner

    // INITIAL_SESSION fires synchronously on subscribe with the current auth state.
    // SIGNED_IN fires when user logs in. TOKEN_REFRESHED fires on token refresh.
    // We handle all three the same way — load the user's data.
    sb.auth.onAuthStateChange(async (event, session) => {
        if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) {
            await onLogin(session.user);
        } else if (!session && (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION')) {
            currentUser = null;
            _loginInProgress = false;
            hideLoader();
            showAuthScreen();
        }
    });
}

document.addEventListener('DOMContentLoaded', init);
