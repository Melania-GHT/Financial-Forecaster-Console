require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');
const session = require('express-session');
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL environment variable. Set it in your Render dashboard.');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.error('Missing SESSION_SECRET environment variable. Set it in your Render dashboard.');
  process.exit(1);
}

// Admin credentials — set ADMIN_PASSWORD in Render environment variables
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;

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
      tools_used TEXT[] DEFAULT '{}'
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_data (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Add new columns if they don't exist (for existing installs)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tools_used TEXT[] DEFAULT '{}';`);
  console.log('Database tables verified/created successfully.');
}

app.use(express.json());
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
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: 'Admin access required' });
  }
  next();
}

// ---------- AUTH ROUTES ----------

app.post('/api/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password || password.length < 8) {
      return res.status(400).json({ error: 'Email and a password of at least 8 characters are required.' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists. Try logging in instead.' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, last_login) VALUES ($1, $2, NOW()) RETURNING id',
      [normalizedEmail, passwordHash]
    );
    const userId = result.rows[0].id;
    await pool.query('INSERT INTO user_data (user_id, data) VALUES ($1, $2)', [userId, JSON.stringify({})]);
    req.session.userId = userId;
    req.session.email = normalizedEmail;
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: 'Account created, but session failed. Please log in.' });
      res.json({ ok: true, email: normalizedEmail });
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Something went wrong creating your account. Please try again.' });
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
    // Update last login
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
    req.session.userId = user.id;
    req.session.email = normalizedEmail;
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: 'Logged in but session failed. Please try again.' });
      res.json({ ok: true, email: normalizedEmail });
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong logging in. Please try again.' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, email: req.session.email });
});

// ---------- DATA ROUTES ----------

app.get('/api/data', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT data FROM user_data WHERE user_id = $1', [req.session.userId]);
    res.json({ data: result.rows[0] ? result.rows[0].data : {} });
  } catch (err) {
    console.error('Get data error:', err);
    res.status(500).json({ error: 'Could not load your saved data.' });
  }
});

app.put('/api/data', requireAuth, async (req, res) => {
  try {
    const { data } = req.body;
    if (typeof data !== 'object' || data === null) return res.status(400).json({ error: 'Invalid data format.' });

    // Track which tools have been used based on what keys exist in data
    const toolsUsed = Object.keys(data).filter(k => data[k] && Object.keys(data[k]).length > 0);
    if (toolsUsed.length > 0) {
      await pool.query(
        `UPDATE users SET tools_used = (
          SELECT ARRAY(SELECT DISTINCT unnest(tools_used || $2::text[]))
        ) WHERE id = $1`,
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
    console.error('Save data error:', err);
    res.status(500).json({ error: 'Could not save your data.' });
  }
});

// ---------- ADMIN ROUTES ----------

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Admin not configured. Set ADMIN_PASSWORD environment variable in Render.' });
  }
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
      SELECT 
        u.id,
        u.email,
        u.created_at,
        u.last_login,
        u.tools_used,
        ud.updated_at as last_saved
      FROM users u
      LEFT JOIN user_data ud ON u.id = ud.user_id
      ORDER BY u.created_at DESC
    `);
    res.json({ users: result.rows });
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).json({ error: 'Could not load users.' });
  }
});

// Admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Fallback to index.html for the SPA
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, async () => {
  console.log(`Clarity Console running on port ${PORT}`);
  try {
    await ensureTablesExist();
  } catch (err) {
    console.error('Failed to set up database tables on startup:', err);
  }
});
