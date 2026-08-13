require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');
const session = require('express-session');
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
  apiVersion: '2026-06-24.dahlia',
});
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = 'info@e-servicesbymel.com';
const APP_URL = process.env.APP_URL || 'https://financial-forecaster-console-3.onrender.com';
const TRIAL_DAYS = 4;
const FOUNDING_MEMBER_LIMIT = 50;

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

if (!process.env.DATABASE_URL) { console.error('Missing DATABASE_URL'); process.exit(1); }
if (!process.env.SESSION_SECRET) { console.error('Missing SESSION_SECRET'); process.exit(1); }

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;

const PRICES = {
  monthly:  process.env.STRIPE_PRICE_MONTHLY,
  annual:   process.env.STRIPE_PRICE_ANNUAL,
  lifetime: process.env.STRIPE_PRICE_LIFETIME,
  founding: process.env.STRIPE_PRICE_FOUNDING,
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function ensureTablesExist() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(), last_login TIMESTAMP, tools_used TEXT[] DEFAULT '{}',
    trial_ends_at TIMESTAMP, subscription_status TEXT DEFAULT 'trial', subscription_plan TEXT,
    stripe_customer_id TEXT, stripe_subscription_id TEXT, access_expires_at TIMESTAMP
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_data (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMP DEFAULT NOW()
  );`);
  const cols = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS tools_used TEXT[] DEFAULT '{}'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_plan TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMP`,
  ];
  for (const col of cols) await pool.query(col).catch(() => {});
  console.log('Database tables verified/created successfully.');
}

function hasAccess(user) {
  if (!user) return false;
  const s = user.subscription_status;
  if (s === 'trial' && user.trial_ends_at && new Date(user.trial_ends_at) > new Date()) return true;
  if (s === 'active') { if (!user.access_expires_at) return true; return new Date(user.access_expires_at) > new Date(); }
  if (s === 'lifetime') return true;
  return false;
}

function daysLeftInTrial(user) {
  if (!user.trial_ends_at) return 0;
  return Math.max(0, Math.ceil((new Date(user.trial_ends_at) - new Date()) / (1000*60*60*24)));
}

// ---------- EMAIL ----------

async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) { console.log('Email skipped — no RESEND_API_KEY'); return; }
  try {
    const result = await resend.emails.send({ from: `E-SERVICES BY MEL <${FROM_EMAIL}>`, to, subject, html });
    console.log(`Email sent to ${to}:`, JSON.stringify(result));
  } catch (err) { console.error(`Email error to ${to}:`, err.message); }
}

function welcomeEmailHtml() {
  return '<html><body style="margin:0;background:#f7f4ee;font-family:Arial,sans-serif;">'
    + '<div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;">'
    + '<div style="background:#1f3148;padding:28px 32px;">'
    + '<div style="font-family:Georgia,serif;font-size:22px;color:#fff;font-weight:700;">The Clarity Console</div>'
    + '<div style="font-size:12px;color:rgba(255,255,255,0.5);margin-top:4px;">E-SERVICES BY MEL</div>'
    + '</div><div style="padding:32px;">'
    + '<h2 style="font-family:Georgia,serif;color:#1f3148;font-size:24px;margin:0 0 12px;">Welcome! Your 4-day free trial starts now.</h2>'
    + '<p style="color:#4a5568;font-size:15px;line-height:1.6;margin:0 0 20px;">You now have full access to The Clarity Console — 8 financial clarity tools that translate your business numbers into plain English.</p>'
    + '<div style="background:#f7f4ee;border-radius:10px;padding:20px;margin-bottom:24px;">'
    + '<div style="font-weight:700;color:#1f3148;font-size:14px;margin-bottom:12px;">Start here:</div>'
    + '<p style="color:#4a5568;font-size:14px;margin:0 0 8px;"><strong>If you use QuickBooks</strong> - click Import from QuickBooks in the sidebar, export any report as CSV, and upload it.</p>'
    + '<p style="color:#4a5568;font-size:14px;margin:0;"><strong>If you do not use QuickBooks</strong> - start with Tool 1: Cash Truth Check. Just 5 numbers and you will see where your cash is going.</p>'
    + '</div>'
    + '<a href="' + APP_URL + '" style="display:block;background:#1f3148;color:#fff;text-align:center;padding:15px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;margin-bottom:20px;">Go to My Dashboard</a>'
    + '<p style="color:#9a9080;font-size:12px;text-align:center;margin:0;">Your trial ends in 4 days. Questions? Reply to this email.</p>'
    + '</div><div style="background:#f7f4ee;padding:16px 32px;text-align:center;font-size:11px;color:#b5a99a;">'
    + '2026 E-SERVICES BY MEL | The Clarity Console | All rights reserved.'
    + '</div></div></body></html>';
}

function trialReminderHtml(daysLeft) {
  const urgent = daysLeft <= 1;
  const color = urgent ? '#a8503e' : '#c8862b';
  const when = urgent ? 'TODAY' : 'TOMORROW';
  return '<html><body style="margin:0;background:#f7f4ee;font-family:Arial,sans-serif;">'
    + '<div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;">'
    + '<div style="background:#1f3148;padding:28px 32px;"><div style="font-family:Georgia,serif;font-size:22px;color:#fff;font-weight:700;">The Clarity Console</div></div>'
    + '<div style="padding:32px;">'
    + '<div style="background:' + color + ';color:#fff;padding:12px 16px;border-radius:8px;font-weight:700;font-size:14px;margin-bottom:24px;">Your free trial expires ' + when + '</div>'
    + '<h2 style="font-family:Georgia,serif;color:#1f3148;font-size:22px;margin:0 0 12px;">Do not lose your financial clarity.</h2>'
    + '<p style="color:#4a5568;font-size:15px;line-height:1.6;margin:0 0 24px;">Your 4-day free trial expires ' + when + '. Upgrade now to keep full access.</p>'
    + '<a href="' + APP_URL + '/paywall.html" style="display:block;background:#1f3148;color:#fff;text-align:center;padding:15px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;margin-bottom:20px;">Choose My Plan</a>'
    + '<p style="color:#9a9080;font-size:12px;text-align:center;">Plans from $47/month. Questions? Reply to this email.</p>'
    + '</div></div></body></html>';
}

function subscriptionReminderHtml(plan, daysLeft) {
  return '<html><body style="margin:0;background:#f7f4ee;font-family:Arial,sans-serif;">'
    + '<div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;">'
    + '<div style="background:#1f3148;padding:28px 32px;"><div style="font-family:Georgia,serif;font-size:22px;color:#fff;font-weight:700;">The Clarity Console</div></div>'
    + '<div style="padding:32px;">'
    + '<div style="background:#c8862b;color:#fff;padding:12px 16px;border-radius:8px;font-weight:700;font-size:14px;margin-bottom:24px;">Your ' + plan + ' subscription expires in ' + daysLeft + ' days</div>'
    + '<h2 style="font-family:Georgia,serif;color:#1f3148;font-size:22px;margin:0 0 12px;">Time to renew your access.</h2>'
    + '<p style="color:#4a5568;font-size:15px;line-height:1.6;margin:0 0 24px;">Renew now to keep uninterrupted access to all your tools and saved data.</p>'
    + '<a href="' + APP_URL + '/paywall.html" style="display:block;background:#1f3148;color:#fff;text-align:center;padding:15px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;">Renew My Access</a>'
    + '</div></div></body></html>';
}

async function sendExpiryReminders() {
  console.log('Running daily expiry reminder check...');
  try {
    const t1 = await pool.query(`SELECT id,email FROM users WHERE subscription_status='trial' AND trial_ends_at BETWEEN NOW() AND NOW() + INTERVAL '25 hours' AND trial_ends_at > NOW()`);
    for (const u of t1.rows) await sendEmail(u.email, 'Your Clarity Console trial expires today', trialReminderHtml(1));

    const t2 = await pool.query(`SELECT id,email FROM users WHERE subscription_status='trial' AND trial_ends_at BETWEEN NOW() + INTERVAL '25 hours' AND NOW() + INTERVAL '49 hours'`);
    for (const u of t2.rows) await sendEmail(u.email, 'Your Clarity Console trial expires tomorrow', trialReminderHtml(2));

    const p3 = await pool.query(`SELECT id,email,subscription_plan FROM users WHERE subscription_status='active' AND access_expires_at BETWEEN NOW() + INTERVAL '2 days' AND NOW() + INTERVAL '4 days'`);
    for (const u of p3.rows) await sendEmail(u.email, 'Your Clarity Console subscription expires in 3 days', subscriptionReminderHtml(u.subscription_plan, 3));

    console.log('Reminders sent:', t1.rows.length + t2.rows.length + p3.rows.length, 'emails');
  } catch (err) { console.error('Expiry reminder error:', err); }
}

setInterval(sendExpiryReminders, 24*60*60*1000);
setTimeout(sendExpiryReminders, 5*60*1000);

// ---------- MIDDLEWARE ----------

app.use(express.json());
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use('/api/gumroad/webhook', express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, secure: true, sameSite: 'none', maxAge: 30*24*60*60*1000 },
}));

function requireAuth(req, res, next) { if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' }); next(); }
function requireAdmin(req, res, next) { if (!req.session.isAdmin) return res.status(401).json({ error: 'Admin access required' }); next(); }

// ---------- AUTH ----------

app.post('/api/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password || password.length < 8) return res.status(400).json({ error: 'Email and a password of at least 8 characters are required.' });
    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'An account with this email already exists. Try logging in instead.' });
    const passwordHash = await bcrypt.hash(password, 12);
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS*24*60*60*1000);
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, last_login, trial_ends_at, subscription_status) VALUES ($1, $2, NOW(), $3, 'trial') RETURNING id`,
      [normalizedEmail, passwordHash, trialEndsAt]
    );
    const userId = result.rows[0].id;
    await pool.query('INSERT INTO user_data (user_id, data) VALUES ($1, $2)', [userId, JSON.stringify({})]);
    req.session.userId = userId;
    req.session.email = normalizedEmail;
    // Send welcome email immediately (non-blocking)
    console.log('Sending welcome email to:', normalizedEmail);
    sendEmail(normalizedEmail, 'Welcome to The Clarity Console - your 4-day trial starts now!', welcomeEmailHtml());
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: 'Account created but session failed. Please log in.' });
      res.json({ ok: true, email: normalizedEmail, trialDays: TRIAL_DAYS });
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    const normalizedEmail = String(email).trim().toLowerCase();
    const result = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [normalizedEmail]);
    if (!result.rows.length) return res.status(401).json({ error: 'Incorrect email or password.' });
    const match = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect email or password.' });
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [result.rows[0].id]);
    req.session.userId = result.rows[0].id;
    req.session.email = normalizedEmail;
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: 'Login failed. Please try again.' });
      res.json({ ok: true, email: normalizedEmail });
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  try {
    const result = await pool.query('SELECT id,email,subscription_status,subscription_plan,trial_ends_at,access_expires_at FROM users WHERE id=$1', [req.session.userId]);
    if (!result.rows.length) return res.json({ loggedIn: false });
    const user = result.rows[0];
    res.json({ loggedIn: true, email: req.session.email, hasAccess: hasAccess(user), status: user.subscription_status, plan: user.subscription_plan, trialDaysLeft: daysLeftInTrial(user) });
  } catch (err) { res.json({ loggedIn: true, email: req.session.email, hasAccess: true }); }
});

// ---------- DATA ----------

app.get('/api/data', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT data FROM user_data WHERE user_id=$1', [req.session.userId]);
    res.json({ data: result.rows[0] ? result.rows[0].data : {} });
  } catch (err) { res.status(500).json({ error: 'Could not load data.' }); }
});

app.put('/api/data', requireAuth, async (req, res) => {
  try {
    const { data } = req.body;
    if (typeof data !== 'object' || data === null) return res.status(400).json({ error: 'Invalid data.' });
    const toolsUsed = Object.keys(data).filter(k => data[k] && Object.keys(data[k]).length > 0);
    if (toolsUsed.length > 0) {
      await pool.query(
        'UPDATE users SET tools_used = (SELECT ARRAY(SELECT DISTINCT unnest(tools_used || $2::text[]))) WHERE id=$1',
        [req.session.userId, toolsUsed]
      );
    }
    await pool.query(
      'INSERT INTO user_data (user_id, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (user_id) DO UPDATE SET data=$2, updated_at=NOW()',
      [req.session.userId, JSON.stringify(data)]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Could not save data.' }); }
});

// ---------- STRIPE ----------

app.get('/api/founding-count', async (req, res) => {
  try {
    const result = await pool.query("SELECT COUNT(*) FROM users WHERE subscription_plan='founding'");
    const count = parseInt(result.rows[0].count);
    res.json({ count, limit: FOUNDING_MEMBER_LIMIT, available: count < FOUNDING_MEMBER_LIMIT });
  } catch (err) { res.json({ count: 0, limit: FOUNDING_MEMBER_LIMIT, available: true }); }
});

app.post('/api/stripe/checkout', requireAuth, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!PRICES[plan]) return res.status(400).json({ error: 'Invalid plan.' });
    if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY === 'sk_test_placeholder') return res.status(503).json({ error: 'Payment system not configured yet.' });
    if (plan === 'founding') {
      const c = await pool.query("SELECT COUNT(*) FROM users WHERE subscription_plan='founding'");
      if (parseInt(c.rows[0].count) >= FOUNDING_MEMBER_LIMIT) return res.status(400).json({ error: 'Founding member spots are sold out.' });
    }
    const userResult = await pool.query('SELECT stripe_customer_id,email FROM users WHERE id=$1', [req.session.userId]);
    const user = userResult.rows[0];
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email });
      customerId = customer.id;
      await pool.query('UPDATE users SET stripe_customer_id=$1 WHERE id=$2', [customerId, req.session.userId]);
    }
    const isRecurring = plan === 'monthly' || plan === 'annual';
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      line_items: [{ price: PRICES[plan], quantity: 1 }],
      mode: isRecurring ? 'subscription' : 'payment',
      success_url: APP_URL + '/payment-success.html?plan=' + plan,
      cancel_url: APP_URL + '/paywall.html',
      metadata: { userId: req.session.userId.toString(), plan },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', { message: err.message, type: err.type, code: err.code, statusCode: err.statusCode });
    res.status(500).json({ error: 'Could not create checkout session.' });
  }
});

async function grantSubscriptionAccess(userId, plan) {
  if (plan === 'monthly') {
    const exp = new Date(Date.now() + 32*24*60*60*1000);
    await pool.query("UPDATE users SET subscription_status='active', subscription_plan='monthly', access_expires_at=$1 WHERE id=$2", [exp, userId]);
  } else if (plan === 'annual') {
    const exp = new Date(Date.now() + 366*24*60*60*1000);
    await pool.query("UPDATE users SET subscription_status='active', subscription_plan='annual', access_expires_at=$1 WHERE id=$2", [exp, userId]);
  } else {
    await pool.query("UPDATE users SET subscription_status='lifetime', subscription_plan=$1, access_expires_at=NULL WHERE id=$2", [plan, userId]);
  }
}

app.post('/api/stripe/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
  catch (err) { console.error('Webhook error:', err.message); return res.status(400).send('Webhook Error: ' + err.message); }
  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      await grantSubscriptionAccess(parseInt(s.metadata.userId), s.metadata.plan);
    }
    if (event.type === 'customer.subscription.deleted') {
      await pool.query("UPDATE users SET subscription_status='expired' WHERE stripe_subscription_id=$1", [event.data.object.id]);
    }
  } catch (err) { console.error('Webhook processing error:', err); }
  res.json({ received: true });
});

// ---------- GUMROAD WEBHOOK ----------

app.post('/api/gumroad/webhook', async (req, res) => {
  try {
    const { email, product_name, sale_id } = req.body;
    if (!email) return res.status(400).json({ error: 'No email provided' });
    const normalizedEmail = String(email).trim().toLowerCase();
    let plan = 'monthly';
    const name = (product_name || '').toLowerCase();
    if (name.includes('founding')) plan = 'founding';
    else if (name.includes('lifetime')) plan = 'lifetime';
    else if (name.includes('annual') || name.includes('yearly')) plan = 'annual';
    let userResult = await pool.query('SELECT id FROM users WHERE email=$1', [normalizedEmail]);
    if (userResult.rows.length === 0) {
      const tempPassword = await bcrypt.hash(sale_id || Math.random().toString(36), 12);
      const result = await pool.query(
        "INSERT INTO users (email,password_hash,created_at,subscription_status,subscription_plan) VALUES ($1,$2,NOW(),'pending',$3) RETURNING id",
        [normalizedEmail, tempPassword, plan]
      );
      await pool.query('INSERT INTO user_data (user_id,data) VALUES ($1,$2)', [result.rows[0].id, JSON.stringify({})]);
      userResult = { rows: [{ id: result.rows[0].id }] };
    }
    await grantSubscriptionAccess(userResult.rows[0].id, plan);
    console.log('Gumroad: Access granted to', normalizedEmail, 'plan:', plan);
    res.json({ ok: true });
  } catch (err) { console.error('Gumroad webhook error:', err); res.status(500).json({ error: 'Webhook processing failed' }); }
});

// ---------- ADMIN ----------

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin not configured. Set ADMIN_PASSWORD in Render.' });
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    req.session.save((err) => { if (err) return res.status(500).json({ error: 'Session error' }); res.json({ ok: true }); });
  } else { res.status(401).json({ error: 'Invalid admin credentials' }); }
});

app.post('/api/admin/logout', (req, res) => { req.session.isAdmin = false; req.session.save(() => res.json({ ok: true })); });

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT u.id,u.email,u.created_at,u.last_login,u.tools_used,u.subscription_status,u.subscription_plan,u.trial_ends_at,u.access_expires_at,ud.updated_at as last_saved FROM users u LEFT JOIN user_data ud ON u.id=ud.user_id ORDER BY u.created_at DESC`);
    res.json({ users: result.rows });
  } catch (err) { res.status(500).json({ error: 'Could not load users.' }); }
});

app.post('/api/admin/grant-access', requireAdmin, async (req, res) => {
  const { userId, plan } = req.body;
  try { await grantSubscriptionAccess(userId, plan || 'lifetime'); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: 'Could not grant access.' }); }
});

app.post('/api/admin/extend-trial', requireAdmin, async (req, res) => {
  const { userId, days } = req.body;
  try {
    await pool.query("UPDATE users SET trial_ends_at = GREATEST(trial_ends_at, NOW()) + ($1 || ' days')::interval WHERE id=$2", [days||7, userId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Could not extend trial.' }); }
});

app.get('/api/admin/test-email', requireAdmin, async (req, res) => {
  const testTo = req.query.to || 'info@e-servicesbymel.com';
  try {
    const result = await resend.emails.send({ from: `E-SERVICES BY MEL <${FROM_EMAIL}>`, to: testTo, subject: 'Test email from Clarity Console', html: '<p>Email sending is working correctly!</p>' });
    console.log('Test email result:', JSON.stringify(result));
    res.json({ ok: true, result });
  } catch (err) { console.error('Test email error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/paywall', (req, res) => res.sendFile(path.join(__dirname, 'public', 'paywall.html')));
app.get('/payment-success', (req, res) => res.sendFile(path.join(__dirname, 'public', 'payment-success.html')));

// ============================================================
// QUICKBOOKS OAUTH INTEGRATION
// ============================================================

const https = require('https');
const QB_CLIENT_ID = process.env.QB_CLIENT_ID;
const QB_CLIENT_SECRET = process.env.QB_CLIENT_SECRET;
const QB_ENVIRONMENT = process.env.QB_ENVIRONMENT || 'sandbox';
const QB_REDIRECT_URI = (process.env.APP_URL || 'https://financial-forecaster-console-3.onrender.com') + '/api/qb/callback';
const QB_SCOPES = 'com.intuit.quickbooks.accounting';
const QB_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QB_BASE_URL = QB_ENVIRONMENT === 'sandbox'
  ? 'https://sandbox-quickbooks.api.intuit.com'
  : 'https://quickbooks.api.intuit.com';

// Store QB tokens in database
async function saveQBTokens(userId, tokens) {
  await pool.query(
    `UPDATE users SET
      qb_access_token = $1,
      qb_refresh_token = $2,
      qb_realm_id = $3,
      qb_token_expires_at = $4
    WHERE id = $5`,
    [tokens.access_token, tokens.refresh_token, tokens.realm_id,
     new Date(Date.now() + tokens.expires_in * 1000), userId]
  ).catch(() => {
    // Columns might not exist yet — add them
    return pool.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS qb_access_token TEXT,
        ADD COLUMN IF NOT EXISTS qb_refresh_token TEXT,
        ADD COLUMN IF NOT EXISTS qb_realm_id TEXT,
        ADD COLUMN IF NOT EXISTS qb_token_expires_at TIMESTAMP
    `).then(() => pool.query(
      `UPDATE users SET qb_access_token=$1, qb_refresh_token=$2, qb_realm_id=$3, qb_token_expires_at=$4 WHERE id=$5`,
      [tokens.access_token, tokens.refresh_token, tokens.realm_id,
       new Date(Date.now() + tokens.expires_in * 1000), userId]
    ));
  });
}

async function getQBTokens(userId) {
  try {
    const result = await pool.query(
      'SELECT qb_access_token, qb_refresh_token, qb_realm_id, qb_token_expires_at FROM users WHERE id=$1',
      [userId]
    );
    return result.rows[0] || null;
  } catch { return null; }
}

async function refreshQBToken(userId, refreshToken) {
  return new Promise((resolve, reject) => {
    const credentials = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
    const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
    const req = https.request({
      hostname: 'oauth.platform.intuit.com',
      path: '/oauth2/v1/tokens/bearer',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
        'Content-Length': Buffer.byteLength(body),
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', async () => {
        try {
          const tokens = JSON.parse(data);
          if (tokens.access_token) {
            await saveQBTokens(userId, { ...tokens, realm_id: (await getQBTokens(userId)).qb_realm_id });
            resolve(tokens.access_token);
          } else { reject(new Error('Token refresh failed: ' + data)); }
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getValidQBToken(userId) {
  const tokens = await getQBTokens(userId);
  if (!tokens || !tokens.qb_access_token) return null;
  if (tokens.qb_token_expires_at && new Date(tokens.qb_token_expires_at) > new Date(Date.now() + 60000)) {
    return { accessToken: tokens.qb_access_token, realmId: tokens.qb_realm_id };
  }
  if (tokens.qb_refresh_token) {
    const newToken = await refreshQBToken(userId, tokens.qb_refresh_token);
    return { accessToken: newToken, realmId: tokens.qb_realm_id };
  }
  return null;
}

function qbApiCall(accessToken, realmId, path) {
  return new Promise((resolve, reject) => {
    const hostname = QB_ENVIRONMENT === 'sandbox'
      ? 'sandbox-quickbooks.api.intuit.com'
      : 'quickbooks.api.intuit.com';
    const req = https.request({
      hostname,
      path: `/v3/company/${realmId}${path}?minorversion=65`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Step 1: Redirect user to Intuit authorization page
app.get('/api/qb/connect', requireAuth, (req, res) => {
  if (!QB_CLIENT_ID) return res.status(503).json({ error: 'QuickBooks not configured' });
  const state = req.session.userId + '_' + Date.now();
  req.session.qbState = state;
  const params = new URLSearchParams({
    client_id: QB_CLIENT_ID,
    redirect_uri: QB_REDIRECT_URI,
    response_type: 'code',
    scope: QB_SCOPES,
    state,
  });
  res.redirect(`${QB_AUTH_URL}?${params.toString()}`);
});

// Step 2: Handle OAuth callback from Intuit
app.get('/api/qb/callback', async (req, res) => {
  const { code, state, realmId, error } = req.query;
  if (error) return res.redirect('/?qb_error=' + encodeURIComponent(error));
  if (!req.session.userId) return res.redirect('/');

  try {
    const credentials = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
    const body = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(QB_REDIRECT_URI)}`;

    const tokens = await new Promise((resolve, reject) => {
      const postReq = https.request({
        hostname: 'oauth.platform.intuit.com',
        path: '/oauth2/v1/tokens/bearer',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`,
          'Content-Length': Buffer.byteLength(body),
        }
      }, postRes => {
        let data = '';
        postRes.on('data', chunk => data += chunk);
        postRes.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch(e) { reject(e); }
        });
      });
      postReq.on('error', reject);
      postReq.write(body);
      postReq.end();
    });

    await saveQBTokens(req.session.userId, { ...tokens, realm_id: realmId });
    console.log(`QB connected for userId=${req.session.userId} realmId=${realmId}`);
    res.redirect('/?qb_connected=1');
  } catch (err) {
    console.error('QB callback error:', err);
    res.redirect('/?qb_error=callback_failed');
  }
});

// Step 3: Get QB connection status
app.get('/api/qb/status', requireAuth, async (req, res) => {
  const tokens = await getQBTokens(req.session.userId);
  res.json({
    connected: !!(tokens && tokens.qb_access_token && tokens.qb_realm_id),
    realmId: tokens ? tokens.qb_realm_id : null,
  });
});

// Step 4: Import data from QuickBooks
app.get('/api/qb/import', requireAuth, async (req, res) => {
  try {
    const tokenData = await getValidQBToken(req.session.userId);
    if (!tokenData) return res.status(401).json({ error: 'QuickBooks not connected. Please connect first.' });

    const { accessToken, realmId } = tokenData;

    // Fetch P&L, Balance Sheet, Cash Flow in parallel
    const [pnlData, bsData, cfData] = await Promise.allSettled([
      qbApiCall(accessToken, realmId, '/reports/ProfitAndLoss'),
      qbApiCall(accessToken, realmId, '/reports/BalanceSheet'),
      qbApiCall(accessToken, realmId, '/reports/CashFlow'),
    ]);

    const extracted = {};

    // Parse P&L
    if (pnlData.status === 'fulfilled' && pnlData.value.Rows) {
      const rows = pnlData.value.Rows.Row || [];
      const findValue = (rows, label) => {
        for (const row of rows) {
          if (row.Summary && row.Summary.ColData) {
            const lbl = (row.Summary.ColData[0] && row.Summary.ColData[0].value || '').toLowerCase();
            if (lbl.includes(label)) {
              const val = parseFloat((row.Summary.ColData[1] && row.Summary.ColData[1].value) || '0');
              return isNaN(val) ? 0 : Math.abs(val);
            }
          }
          if (row.Rows) {
            const found = findValue(row.Rows.Row || [], label);
            if (found) return found;
          }
        }
        return 0;
      };
      extracted.revenue = findValue(rows, 'total income') || findValue(rows, 'total revenue');
      extracted.cogs = findValue(rows, 'total cost of goods') || findValue(rows, 'total cogs');
      extracted.opex = findValue(rows, 'total expenses') || findValue(rows, 'total operating');
      extracted.netIncome = findValue(rows, 'net income') || findValue(rows, 'net profit');
    }

    // Parse Balance Sheet
    if (bsData.status === 'fulfilled' && bsData.value.Rows) {
      const rows = bsData.value.Rows.Row || [];
      const findValue = (rows, label) => {
        for (const row of rows) {
          if (row.Summary && row.Summary.ColData) {
            const lbl = (row.Summary.ColData[0] && row.Summary.ColData[0].value || '').toLowerCase();
            if (lbl.includes(label)) {
              const val = parseFloat((row.Summary.ColData[1] && row.Summary.ColData[1].value) || '0');
              return isNaN(val) ? 0 : Math.abs(val);
            }
          }
          if (row.Rows) {
            const found = findValue(row.Rows.Row || [], label);
            if (found) return found;
          }
        }
        return 0;
      };
      extracted.bank = findValue(rows, 'checking') || findValue(rows, 'cash and cash');
      extracted.ar = findValue(rows, 'accounts receivable');
      extracted.ap = findValue(rows, 'accounts payable');
      extracted.totalAssets = findValue(rows, 'total assets');
      extracted.totalLiabilities = findValue(rows, 'total liabilities');
    }

    res.json({ ok: true, data: extracted });
  } catch (err) {
    console.error('QB import error:', err);
    res.status(500).json({ error: 'Could not import from QuickBooks: ' + err.message });
  }
});

// Step 5: Disconnect QuickBooks
app.post('/api/qb/disconnect', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE users SET qb_access_token=NULL, qb_refresh_token=NULL, qb_realm_id=NULL, qb_token_expires_at=NULL WHERE id=$1',
      [req.session.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not disconnect.' });
  }
});

app.get('/*splat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, async () => {
  console.log('Clarity Console running on port', PORT);
  try { await ensureTablesExist(); } catch (err) { console.error('DB setup error:', err); }
});
