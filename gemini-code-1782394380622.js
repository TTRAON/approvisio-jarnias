require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'jarnias-approvisio-change-me';

const BOOTSTRAP_ADMIN_CODE = process.env.ADMIN_CODE || 'JARNIAS-ADMIN-2026';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'AppROVISIO <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL || '';

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY || !to) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html })
    });
  } catch (e) { console.error("Email error:", e); }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS invites (
      id SERIAL PRIMARY KEY,
      code VARCHAR(50) UNIQUE NOT NULL,
      role VARCHAR(50) NOT NULL,
      consumed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS app_lists (
      name VARCHAR(100) PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      body TEXT NOT NULL,
      appro_id VARCHAR(50),
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
initDB().catch(console.error);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const head = req.headers['authorization'];
  const token = head && head.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Non authentifié' });
  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Session expirée' });
    req.user = user;
    next();
  });
}

// ── ENDPOINTS AUTHENTIFICATION ──
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, code } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'Champs manquants' });

    let finalRole = null;
    if (code === BOOTSTRAP_ADMIN_CODE) {
      const { rowCount } = await pool.query('SELECT id FROM users WHERE role = $1', ['admin']);
      if (rowCount > 0) return res.status(400).json({ error: 'Le code admin initial a déjà été utilisé' });
      finalRole = 'admin';
    } else {
      const { rows } = await pool.query('SELECT id, role FROM invites WHERE code = $1 AND consumed = FALSE', [code]);
      if (rows.length === 0) return res.status(400).json({ error: 'Code d\'invitation invalide ou déjà utilisé' });
      finalRole = rows[0].role;
      await pool.query('UPDATE invites SET consumed = TRUE WHERE id = $1', [rows[0].id]);
    }

    const hashed = await bcrypt.hash(password, 10);
    const { rows: u } = await pool.query(
      'INSERT INTO users (email, password, name, role) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role',
      [email.toLowerCase().trim(), hashed, name.trim(), finalRole]
    );

    const token = jwt.sign({ id: u[0].id, role: u[0].role, name: u[0].name }, SECRET, { expiresIn: '30d' });
    res.json({ token, user: u[0] });
  } catch (e) {
    if (e.constraint === 'users_email_key') return res.status(400).json({ error: 'Cet email est déjà utilisé' });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (rows.length === 0) return res.status(400).json({ error: 'Identifiants incorrects' });
    
    const ok = await bcrypt.compare(password, rows[0].password);
    if (!ok) return res.status(400).json({ error: 'Identifiants incorrects' });

    const token = jwt.sign({ id: rows[0].id, role: rows[0].role, name: rows[0].name }, SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: rows[0].id, email: rows[0].email, name: rows[0].name, role: rows[0].role } });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/auth/refresh', auth, async (req, res) => {
  res.json({ token: jwt.sign({ id: req.user.id, role: req.user.role, name: req.user.name }, SECRET, { expiresIn: '30d' }), user: req.user });
});

// ── ENDPOINTS UTILISATEURS / INVITES ──
app.get('/api/users', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(430).json({ error: 'Interdit' });
  try {
    const { rows } = await pool.query('SELECT id, email, name, role FROM users ORDER BY name ASC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.put('/api/users/:id/password', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(430).json({ error: 'Interdit' });
  try {
    const hashed = await bcrypt.hash(req.body.password, 10);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.delete('/api/users/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(430).json({ error: 'Interdit' });
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Impossible de vous supprimer' });
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/invites', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(430).json({ error: 'Interdit' });
  try {
    const code = `${req.body.role.substring(0,3).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    await pool.query('INSERT INTO invites (code, role) VALUES ($1, $2)', [code, req.body.role]);
    res.json({ code });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── ENDPOINTS BASES DE DONNÉES ET LISTES GÉNÉRIQUES ──
const LIST_NAMES = ["categories", "articles", "suppliers", "depots", "appro_orders", "company_fleet"];

app.get('/api/lists', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT name, data FROM app_lists');
    const out = {};
    LIST_NAMES.forEach(n => out[n] = n === "appro_orders" || n === "company_fleet" ? [] : {});
    rows.forEach(r => { out[r.name] = r.data; });
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/lists/:name/seed', auth, async (req, res) => {
  if (!LIST_NAMES.includes(req.params.name)) return res.status(400).json({ error: 'Nom invalide' });
  try {
    await pool.query(
      'INSERT INTO app_lists (name, data, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP) ON CONFLICT (name) DO UPDATE SET data = $2, updated_at = CURRENT_TIMESTAMP',
      [req.params.name, JSON.stringify(req.body.data)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── ENDPOINTS NOTIFICATIONS ──
app.get('/api/notifications', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, type, title, body, appro_id, is_read, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.put('/api/notifications/:id/read', auth, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.put('/api/notifications/read-all', auth, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── ROUTE POUR LA DEUXIÈME APPLICATION (FLOTTE VÉHICULES) ──
app.get('/flotte', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'flotte.html'));
});

// ── FRONTEND PRINCIPAL (APPROVISIONNEMENTS) ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => { console.log(`Serveur JARNIAS actif sur le port ${PORT}`); });