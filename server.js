require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');
const session = require('express-session');
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL environment variable.');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.error('Missing SESSION_SECRET environment variable.');
  process.exit(1);
}

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;

// Stripe price IDs — set these in Render after creating products in Stripe
const PRICES = {
  monthly:  process.env.STRIPE_PRICE_MONTHLY,   // $47/month
  annual:   process.env.STRIPE_PRICE_ANNUAL,    // $249/year
  lifetime: process.env.STRIPE_PRICE_LIFETIME,  // $497 one-time
  founding: process.env.STRIPE_PRICE_FOUNDING,  // $297 one-time (limited)
};

const TRIAL_DAYS = 7;
const FOUNDING_MEMBER_LIMIT = 50;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function ensureTablesExist() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      last_login TIMESTAMP,
      tools_used TEXT[] DEFAULT '{}',
      trial_ends_at TIMESTAMP,
      subscription_status TEXT DEFAULT 'trial',
      subscription_plan TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      access_expires_at TIMESTAMP
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_data (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Add new columns for existing installs
  const newCols = [
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS tools_used TEXT[] DEFAULT \'{}\'',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT \'trial\'',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_plan TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMP',
  ];
  for (const col of newCols) {
    await pool.query(col).catch(() => {});
  }
  console.log('Database tables verified/created successfully.');
}

// Check if user has active access
function hasAccess(user) {
  if (!user) return false;
  const status = user.subscription_status;
  // Trial period
  if (status === 'trial' && user.trial_ends_at && new Date(user.trial_ends_at) > new Date()) return true;
  // Active subscription
  if (status === 'active') {
    if (!user.access_expires_at) return true; // lifetime
    return new Date(user.access_expires_at) > new Date();
  }
  // Lifetime
  if (status === 'lifetime') return true;
  return false;
}

function daysLeftInTrial(user) {
  if (!user.trial_ends_at) return 0;
  const diff = new Date(user.trial_ends_at) - new Date();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

app.use(express.json());

// Stripe webhook needs raw body
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Admin access required' });
  next();
}

// ---------- AUTH ----------

app.post('/api/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password || password.length < 8) {
      return res.status(400).json({ error: 'Email and a password of at least 8 characters are required.' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();

    // Check user limit
    const maxUsers = parseInt(process.env.MAX_USERS || '0');
    if (maxUsers > 0) {
      const countResult = await pool.query('SELECT COUNT(*) FROM users');
      if (parseInt(countResult.rows[0].count) >= maxUsers) {
        return res.status(403).json({ error: `We're currently in a closed beta. All spots have been filled. Check back soon!` });
      }
    }

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists. Try logging in instead.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, last_login, trial_ends_at, subscription_status)
       VALUES ($1, $2, NOW(), $3, 'trial') RETURNING id`,
      [normalizedEmail, passwordHash, trialEndsAt]
    );
    const userId = result.rows[0].id;
    await pool.query('INSERT INTO user_data (user_id, data) VALUES ($1, $2)', [userId, JSON.stringify({})]);
    req.session.userId = userId;
    req.session.email = normalizedEmail;
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
    if (result.rows.length === 0) return res.status(401).json({ error: 'Incorrect email or password.' });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect email or password.' });
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
    req.session.userId = user.id;
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

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  try {
    const result = await pool.query(
      'SELECT id, email, subscription_status, subscription_plan, trial_ends_at, access_expires_at FROM users WHERE id = $1',
      [req.session.userId]
    );
    if (!result.rows.length) return res.json({ loggedIn: false });
    const user = result.rows[0];
    const active = hasAccess(user);
    const trialDays = daysLeftInTrial(user);
    res.json({
      loggedIn: true,
      email: req.session.email,
      hasAccess: active,
      status: user.subscription_status,
      plan: user.subscription_plan,
      trialDaysLeft: trialDays,
    });
  } catch (err) {
    res.json({ loggedIn: true, email: req.session.email, hasAccess: true });
  }
});

// ---------- DATA ----------

app.get('/api/data', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT data FROM user_data WHERE user_id = $1', [req.session.userId]);
    res.json({ data: result.rows[0] ? result.rows[0].data : {} });
  } catch (err) {
    res.status(500).json({ error: 'Could not load data.' });
  }
});

app.put('/api/data', requireAuth, async (req, res) => {
  try {
    const { data } = req.body;
    if (typeof data !== 'object' || data === null) return res.status(400).json({ error: 'Invalid data.' });
    const toolsUsed = Object.keys(data).filter(k => data[k] && Object.keys(data[k]).length > 0);
    if (toolsUsed.length > 0) {
      await pool.query(
        `UPDATE users SET tools_used = (SELECT ARRAY(SELECT DISTINCT unnest(tools_used || $2::text[]))) WHERE id = $1`,
        [req.session.userId, toolsUsed]
      );
    }
    await pool.query(
      `INSERT INTO user_data (user_id, data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [req.session.userId, JSON.stringify(data)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not save data.' });
  }
});

// ---------- STRIPE ----------

// Get founding member count
app.get('/api/founding-count', async (req, res) => {
  try {
    const result = await pool.query(`SELECT COUNT(*) FROM users WHERE subscription_plan = 'founding'`);
    const count = parseInt(result.rows[0].count);
    res.json({ count, limit: FOUNDING_MEMBER_LIMIT, available: count < FOUNDING_MEMBER_LIMIT });
  } catch (err) {
    res.json({ count: 0, limit: FOUNDING_MEMBER_LIMIT, available: true });
  }
});

// Create Stripe checkout session
app.post('/api/stripe/checkout', requireAuth, async (req, res) => {
  try {
    const { plan } = req.body; // 'monthly', 'annual', 'lifetime', 'founding'
    if (!PRICES[plan]) return res.status(400).json({ error: 'Invalid plan.' });
    if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY === 'sk_test_placeholder') {
      return res.status(503).json({ error: 'Payment system not configured yet. Please check back soon.' });
    }

    // Check founding member limit
    if (plan === 'founding') {
      const countResult = await pool.query(`SELECT COUNT(*) FROM users WHERE subscription_plan = 'founding'`);
      if (parseInt(countResult.rows[0].count) >= FOUNDING_MEMBER_LIMIT) {
        return res.status(400).json({ error: 'Founding member spots are sold out. Please choose another plan.' });
      }
    }

    // Get or create Stripe customer
    const userResult = await pool.query('SELECT stripe_customer_id, email FROM users WHERE id = $1', [req.session.userId]);
    const user = userResult.rows[0];
    let customerId = user.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email });
      customerId = customer.id;
      await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, req.session.userId]);
    }

    const isRecurring = plan === 'monthly' || plan === 'annual';
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      line_items: [{ price: PRICES[plan], quantity: 1 }],
      mode: isRecurring ? 'subscription' : 'payment',
      success_url: `${process.env.APP_URL || 'https://financial-forecaster-console-1.onrender.com'}/payment-success.html?plan=${plan}`,
      cancel_url: `${process.env.APP_URL || 'https://financial-forecaster-console-1.onrender.com'}/paywall.html`,
      metadata: { userId: req.session.userId.toString(), plan },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error full details:', {
      message: err.message,
      type: err.type,
      code: err.code,
      param: err.param,
      statusCode: err.statusCode,
      rawType: err.rawType,
    });
    res.status(500).json({ error: 'Could not create checkout session.' });
  }
});

// Stripe webhook — handles payment confirmation
app.post('/api/stripe/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = parseInt(session.metadata.userId);
      const plan = session.metadata.plan;

      if (plan === 'monthly' || plan === 'annual') {
        const accessDays = plan === 'monthly' ? 31 : 366;
        const accessExpiresAt = new Date(Date.now() + accessDays * 24 * 60 * 60 * 1000);
        await pool.query(
          `UPDATE users SET subscription_status='active', subscription_plan=$1,
           stripe_subscription_id=$2, access_expires_at=$3 WHERE id=$4`,
          [plan, session.subscription, accessExpiresAt, userId]
        );
      } else {
        // Lifetime or founding
        await pool.query(
          `UPDATE users SET subscription_status='lifetime', subscription_plan=$1,
           access_expires_at=NULL WHERE id=$2`,
          [plan, userId]
        );
      }
    }

    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      if (invoice.subscription) {
        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        const userId = parseInt(sub.metadata.userId || '0');
        if (userId) {
          const plan = sub.metadata.plan;
          const accessDays = plan === 'monthly' ? 31 : 366;
          const accessExpiresAt = new Date(Date.now() + accessDays * 24 * 60 * 60 * 1000);
          await pool.query(
            `UPDATE users SET subscription_status='active', access_expires_at=$1 WHERE id=$2`,
            [accessExpiresAt, userId]
          );
        }
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      await pool.query(
        `UPDATE users SET subscription_status='expired' WHERE stripe_subscription_id=$1`,
        [sub.id]
      );
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
  }

  res.json({ received: true });
});

// ---------- ADMIN ----------

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin not configured. Set ADMIN_PASSWORD in Render.' });
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: 'Session error' });
      res.json({ ok: true });
    });
  } else {
    res.status(401).json({ error: 'Invalid admin credentials' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  req.session.save(() => res.json({ ok: true }));
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.email, u.created_at, u.last_login, u.tools_used,
             u.subscription_status, u.subscription_plan, u.trial_ends_at,
             u.access_expires_at, ud.updated_at as last_saved
      FROM users u
      LEFT JOIN user_data ud ON u.id = ud.user_id
      ORDER BY u.created_at DESC
    `);
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load users.' });
  }
});

// Grant manual access (admin can override for beta testers)
app.post('/api/admin/grant-access', requireAdmin, async (req, res) => {
  const { userId, plan } = req.body;
  try {
    await pool.query(
      `UPDATE users SET subscription_status='lifetime', subscription_plan=$1 WHERE id=$2`,
      [plan || 'beta', userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not grant access.' });
  }
});

// Extend trial (admin)
app.post('/api/admin/extend-trial', requireAdmin, async (req, res) => {
  const { userId, days } = req.body;
  try {
    await pool.query(
      `UPDATE users SET trial_ends_at = GREATEST(trial_ends_at, NOW()) + ($1 || ' days')::interval WHERE id=$2`,
      [days || 7, userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not extend trial.' });
  }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/paywall', (req, res) => res.sendFile(path.join(__dirname, 'public', 'paywall.html')));
app.get('/payment-success', (req, res) => res.sendFile(path.join(__dirname, 'public', 'payment-success.html')));

app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, async () => {
  console.log(`Clarity Console running on port ${PORT}`);
  try { await ensureTablesExist(); } catch (err) { console.error('DB setup error:', err); }
});
