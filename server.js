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

// Code admin par défaut (1er compte). Fourni dans le guide.
const BOOTSTRAP_ADMIN_CODE = process.env.ADMIN_CODE || 'JARNIAS-ADMIN-2026';

// ── EMAIL (Resend) ────────────────────────────────────────────
// Clé API Resend (optionnelle : si absente, seules les notifs cloche fonctionnent)
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
// Adresse expéditrice. Par défaut le domaine de test Resend (fonctionne sans config DNS).
const MAIL_FROM = process.env.MAIL_FROM || 'AppROVISIO <onboarding@resend.dev>';
// URL publique de l'app (pour les liens dans les mails)
const APP_URL = process.env.APP_URL || '';

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY || !to) return; // pas de clé ou pas d'email : on saute silencieusement
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error('Erreur envoi email:', res.status, t.slice(0, 200));
    }
  } catch (e) {
    console.error('Erreur envoi email:', e.message);
  }
}

function emailTemplate(title, message, ctaLabel) {
  const btn = APP_URL
    ? `<a href="${APP_URL}" style="display:inline-block;margin-top:18px;background:#0F172A;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-size:14px;font-weight:600">${ctaLabel || 'Ouvrir AppROVISIO'}</a>`
    : '';
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1E293B">
    <div style="font-size:18px;font-weight:700;color:#0F172A;margin-bottom:4px">JARNIAS <span style="font-weight:400;color:#64748B">AppROVISIO</span></div>
    <div style="height:2px;background:#0F172A;margin:8px 0 18px"></div>
    <div style="font-size:16px;font-weight:600;margin-bottom:8px">${title}</div>
    <div style="font-size:14px;color:#475569;line-height:1.6">${message}</div>
    ${btn}
    <div style="margin-top:24px;font-size:12px;color:#94A3B8">Notification automatique \u2014 AppROVISIO JARNIAS</div>
  </div>`;
}

// Crée une notification en base + envoie l'email correspondant
async function logEvent(approId, type, actorName) {
  try {
    await pool.query('INSERT INTO appro_events (appro_id, type, actor_name) VALUES ($1,$2,$3)', [approId, type, actorName || null]);
  } catch (e) { /* historique non bloquant */ }
}

async function notify(userId, type, title, body, approId, emailSubject, emailHtml) {
  try {
    await pool.query(
      'INSERT INTO notifications (user_id, type, title, body, appro_id) VALUES ($1,$2,$3,$4,$5)',
      [userId, type, title, body || null, approId || null]
    );
  } catch (e) {
    console.error('Erreur création notification:', e.message);
  }
  // Email en parallèle (ne bloque pas)
  if (emailSubject) {
    try {
      const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
      if (rows[0] && rows[0].email) {
        sendEmail(rows[0].email, emailSubject, emailHtml);
      }
    } catch (e) {
      console.error('Erreur lookup email:', e.message);
    }
  }
}

// ── DATABASE ──────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username      VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name          VARCHAR(100) NOT NULL,
      role          VARCHAR(20) NOT NULL DEFAULT 'conducteur',
      created_at    TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      code        VARCHAR(40) PRIMARY KEY,
      role        VARCHAR(20) NOT NULL,
      created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
      used_by     UUID REFERENCES users(id) ON DELETE SET NULL,
      used_at     TIMESTAMP,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS appros (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      data        JSONB NOT NULL,
      created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
      type        VARCHAR(30) NOT NULL,
      title       VARCHAR(160) NOT NULL,
      body        VARCHAR(400),
      appro_id    UUID,
      is_read     BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS app_lists (
      name        VARCHAR(40) PRIMARY KEY,
      data        JSONB NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS appro_events (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      appro_id    UUID,
      type        VARCHAR(30) NOT NULL,
      actor_name  VARCHAR(160),
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS appro_team_leaders (
      appro_id    UUID,
      user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
      created_at  TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (appro_id, user_id)
    );
  `);
  // Ajout de la colonne email si elle n'existe pas déjà (migration douce)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(160);`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS news_seen INT DEFAULT 0;`);
  console.log('Base de données prête.');
}

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Non authentifié' });
  try {
    req.user = jwt.verify(header.split(' ')[1], SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expirée' });
  }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès administrateur requis' });
  next();
}

function makeCode(role) {
  const prefix = role === 'admin' ? 'ADM' : role === 'depot' ? 'DEP' : 'CON';
  const rnd = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${rnd}`;
}

// ── AUTH ──────────────────────────────────────────────────────

// Inscription avec code d'invitation
app.post('/api/auth/register', async (req, res) => {
  const client = await pool.connect();
  try {
    const { username, password, name, email, code } = req.body;
    if (!username || !password || !name || !email || !code) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min.)' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Adresse email invalide' });
    }

    let role = null;

    // Cas spécial : code admin bootstrap (uniquement si aucun admin n'existe encore)
    if (code === BOOTSTRAP_ADMIN_CODE) {
      const { rows } = await client.query("SELECT COUNT(*) FROM users WHERE role='admin'");
      if (parseInt(rows[0].count) === 0) {
        role = 'admin';
      } else {
        return res.status(400).json({ error: 'Le code admin par défaut a déjà été utilisé' });
      }
    } else {
      // Code d'invitation classique (à usage unique)
      const { rows } = await client.query('SELECT * FROM invite_codes WHERE code = $1', [code]);
      const invite = rows[0];
      if (!invite) return res.status(400).json({ error: 'Code d\'invitation invalide' });
      if (invite.used_by) return res.status(400).json({ error: 'Ce code a déjà été utilisé' });
      role = invite.role;
    }

    await client.query('BEGIN');
    const hash = await bcrypt.hash(password, 10);
    let newUser;
    try {
      const ins = await client.query(
        'INSERT INTO users (username, password_hash, name, email, role) VALUES ($1,$2,$3,$4,$5) RETURNING id, username, name, role',
        [username, hash, name, email, role]
      );
      newUser = ins.rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') return res.status(400).json({ error: 'Cet identifiant est déjà pris' });
      throw e;
    }

    // Marquer le code comme utilisé (sauf bootstrap admin)
    if (code !== BOOTSTRAP_ADMIN_CODE) {
      await client.query(
        'UPDATE invite_codes SET used_by = $1, used_at = NOW() WHERE code = $2',
        [newUser.id, code]
      );
    }
    await client.query('COMMIT');

    const payload = { id: newUser.id, username: newUser.username, role: newUser.role, name: newUser.name };
    const token = jwt.sign(payload, SECRET, { expiresIn: '7d' });
    res.json({ token, user: payload });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// Connexion
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Identifiants requis' });
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user || !await bcrypt.compare(password, user.password_hash)) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }
    const payload = { id: user.id, username: user.username, role: user.role, name: user.name };
    const token = jwt.sign(payload, SECRET, { expiresIn: '7d' });
    res.json({ token, user: payload });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Rafraîchir le token
app.post('/api/auth/refresh', auth, (req, res) => {
  const token = jwt.sign(
    { id: req.user.id, username: req.user.username, role: req.user.role, name: req.user.name },
    SECRET, { expiresIn: '7d' }
  );
  res.json({ token, user: { id: req.user.id, username: req.user.username, role: req.user.role, name: req.user.name } });
});

// ── INVITE CODES (admin) ──────────────────────────────────────
app.get('/api/invites', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ic.code, ic.role, ic.used_at, ic.created_at,
             u.name AS used_by_name
      FROM invite_codes ic
      LEFT JOIN users u ON ic.used_by = u.id
      ORDER BY ic.created_at DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/invites', auth, adminOnly, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['admin', 'conducteur', 'depot'].includes(role)) {
      return res.status(400).json({ error: 'Rôle invalide' });
    }
    let code, ok = false, tries = 0;
    while (!ok && tries < 5) {
      code = makeCode(role);
      try {
        await pool.query('INSERT INTO invite_codes (code, role, created_by) VALUES ($1,$2,$3)', [code, role, req.user.id]);
        ok = true;
      } catch (e) { tries++; }
    }
    if (!ok) return res.status(500).json({ error: 'Impossible de générer le code' });
    res.json({ code, role });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.delete('/api/invites/:code', auth, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM invite_codes WHERE code = $1 AND used_by IS NULL', [req.params.code]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── USERS (admin) ─────────────────────────────────────────────
app.get('/api/users', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, username, name, email, role, created_at FROM users ORDER BY created_at');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.put('/api/users/:id/password', auth, adminOnly, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court' });
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.put('/api/users/:id/email', auth, adminOnly, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Adresse email invalide' });
    }
    await pool.query('UPDATE users SET email = $1 WHERE id = $2', [email, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Impossible de vous supprimer vous-même' });
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── APPROS (partagées, tous rôles connectés) ──────────────────
app.get('/api/appros', auth, async (req, res) => {
  try {
    if (req.user.role === 'team_leader') {
      const { rows } = await pool.query(
        `SELECT a.id, a.data, a.created_by, a.created_at, a.updated_at
         FROM appros a JOIN appro_team_leaders tl ON tl.appro_id = a.id
         WHERE tl.user_id = $1
         ORDER BY a.updated_at DESC`, [req.user.id]
      );
      return res.json(rows.map(r => ({ ...r.data, _id: r.id, _createdBy: r.created_by, _updatedAt: r.updated_at })));
    }
    const { rows } = await pool.query('SELECT id, data, created_by, created_at, updated_at FROM appros ORDER BY updated_at DESC');
    res.json(rows.map(r => ({ ...r.data, _id: r.id, _createdBy: r.created_by, _updatedAt: r.updated_at })));
  } catch (e) { res.status(500).json({ error: 'Erreur lecture' }); }
});

// ── ACC\u00c8S PAR LIEN / QR (Team Leaders) ─────────────────────────
// Un visiteur non connect\u00e9 rejoint une appro en donnant son nom \u2192 devient Team Leader
app.post('/api/tl/join', async (req, res) => {
  const client = await pool.connect();
  try {
    const name = (req.body && req.body.name || '').trim();
    const approId = req.body && req.body.approId;
    if (!name) return res.status(400).json({ error: 'Nom requis' });
    if (!approId) return res.status(400).json({ error: 'Appro manquante' });
    const ap = await client.query('SELECT id FROM appros WHERE id = $1', [approId]);
    if (!ap.rows[0]) return res.status(404).json({ error: 'Appro introuvable' });
    await client.query('BEGIN');
    // Cr\u00e9er un compte Team Leader l\u00e9ger (pseudo unique, pas de mot de passe utilisable)
    const uname = 'tl_' + crypto.randomBytes(4).toString('hex');
    const randomHash = await bcrypt.hash(crypto.randomBytes(8).toString('hex'), 10);
    const ins = await client.query(
      "INSERT INTO users (username, password_hash, name, role) VALUES ($1,$2,$3,'team_leader') RETURNING id, username, name, role",
      [uname, randomHash, name]
    );
    const u = ins.rows[0];
    await client.query(
      'INSERT INTO appro_team_leaders (appro_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [approId, u.id]
    );
    await client.query('COMMIT');
    logEvent(approId, 'tl_acces', name);
    const payload = { id: u.id, username: u.username, role: u.role, name: u.name };
    const token = jwt.sign(payload, SECRET, { expiresIn: '90d' });
    res.json({ token, user: payload, approId: approId });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Erreur' });
  } finally { client.release(); }
});
// Un Team Leader d\u00e9j\u00e0 connect\u00e9 rejoint une nouvelle appro (via un autre lien/QR)
app.post('/api/tl/link', auth, async (req, res) => {
  try {
    if (req.user.role !== 'team_leader') return res.status(403).json({ error: 'R\u00e9serv\u00e9 aux Team Leaders' });
    const approId = req.body && req.body.approId;
    if (!approId) return res.status(400).json({ error: 'Appro manquante' });
    const ap = await pool.query('SELECT id FROM appros WHERE id = $1', [approId]);
    if (!ap.rows[0]) return res.status(404).json({ error: 'Appro introuvable' });
    await pool.query('INSERT INTO appro_team_leaders (appro_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [approId, req.user.id]);
    logEvent(approId, 'tl_acces', req.user.name);
    res.json({ ok: true, approId: approId });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
// R\u00e9cup\u00e9rer une seule appro (pour ouvrir un lien direct quand on est conducteur/d\u00e9p\u00f4t/admin)
app.get('/api/appros/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, data, created_by, updated_at FROM appros WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Appro introuvable' });
    if (req.user.role === 'team_leader') {
      const lk = await pool.query('SELECT 1 FROM appro_team_leaders WHERE appro_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      if (!lk.rows[0]) return res.status(403).json({ error: 'Acc\u00e8s refus\u00e9' });
    }
    res.json({ ...rows[0].data, _id: rows[0].id, _createdBy: rows[0].created_by, _updatedAt: rows[0].updated_at });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
// Liste des Team Leaders li\u00e9s \u00e0 une appro (visible par les comptes internes)
app.get('/api/appros/:id/team-leaders', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.name, tl.created_at FROM appro_team_leaders tl JOIN users u ON u.id = tl.user_id
       WHERE tl.appro_id = $1 ORDER BY tl.created_at ASC`, [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── INT\u00c9GRATION ALOBEES (lecture seule) ─────────────────────────
// La cl\u00e9 API reste c\u00f4t\u00e9 serveur (variable d'environnement), jamais expos\u00e9e au navigateur.
const ALOBEES_API_KEY = process.env.ALOBEES_API_KEY || '';
const ALOBEES_BASE = process.env.ALOBEES_BASE || 'https://api.alobees.com/api';

// Le navigateur demande si Alobees est configur\u00e9 (pour afficher ou non le bouton)
app.get('/api/alobees/status', auth, (req, res) => {
  res.json({ configured: !!ALOBEES_API_KEY });
});

// Liste des chantiers Alobees (proxy avec cache + recherche c\u00f4t\u00e9 serveur)
let _aloCache = { at: 0, sites: [] };
const ALO_TTL = 10 * 60 * 1000; // 10 minutes

async function alobeesFetchAll() {
  const all = [];
  let skip = 0;
  const pageSize = 500;
  for (let i = 0; i < 60; i++) { // garde-fou : max 30000 chantiers
    const r = await fetch(ALOBEES_BASE + '/site?limit=' + pageSize + '&skip=' + skip, {
      headers: { 'Authorization': 'APIKey ' + ALOBEES_API_KEY }
    });
    const txt = await r.text();
    if (!r.ok) throw new Error('Alobees ' + r.status + ': ' + txt.slice(0, 200));
    let j; try { j = JSON.parse(txt); } catch (e) { throw new Error('R\u00e9ponse Alobees illisible'); }
    const list = Array.isArray(j) ? j : (j.data || []);
    for (const s of list) all.push(s);
    const total = (j && j.total != null) ? j.total : all.length;
    skip += pageSize;
    if (list.length < pageSize || all.length >= total) break;
  }
  return all;
}

async function getAlobeesSites() {
  if (_aloCache.sites.length && (Date.now() - _aloCache.at) < ALO_TTL) return _aloCache.sites;
  const sites = await alobeesFetchAll();
  _aloCache = { at: Date.now(), sites };
  return sites;
}

app.get('/api/alobees/sites', auth, async (req, res) => {
  if (!ALOBEES_API_KEY) return res.status(400).json({ error: 'Cl\u00e9 API Alobees non configur\u00e9e (variable ALOBEES_API_KEY)' });
  try {
    const all = await getAlobeesSites();
    const q = ('' + (req.query.q || '')).toLowerCase().trim();
    let filtered = all;
    if (q) filtered = all.filter(function (s) { return ('' + (s.name || s.nom || '')).toLowerCase().indexOf(q) >= 0; });
    const lim = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    res.json({ sites: filtered.slice(0, lim), shown: Math.min(filtered.length, lim), total: filtered.length, grandTotal: all.length });
  } catch (e) { res.status(502).json({ error: 'Erreur de connexion \u00e0 Alobees', detail: e.message }); }
});

// D\u00e9tail d'un chantier Alobees (proxy) \u2014 utile pour r\u00e9cup\u00e9rer client / n\u00b0 affaire / adresse
app.get('/api/alobees/sites/:id', auth, async (req, res) => {
  if (!ALOBEES_API_KEY) return res.status(400).json({ error: 'Cl\u00e9 API Alobees non configur\u00e9e' });
  try {
    const r = await fetch(ALOBEES_BASE + '/site/' + encodeURIComponent(req.params.id), {
      headers: { 'Authorization': 'APIKey ' + ALOBEES_API_KEY }
    });
    const txt = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: 'Alobees a r\u00e9pondu ' + r.status, detail: txt.slice(0, 300) });
    let j; try { j = JSON.parse(txt); } catch (e) { return res.status(502).json({ error: 'R\u00e9ponse Alobees illisible', detail: txt.slice(0, 300) }); }
    const site = Array.isArray(j.data) ? j.data[0] : (j.data || j);
    res.json({ site: site });
  } catch (e) { res.status(500).json({ error: 'Erreur de connexion \u00e0 Alobees', detail: e.message }); }
});

app.post('/api/appros', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'INSERT INTO appros (data, created_by) VALUES ($1,$2) RETURNING id, created_at',
      [req.body, req.user.id]
    );
    const approId = rows[0].id;
    res.json({ ...req.body, _id: approId });
    logEvent(approId, 'creee', req.user.name);

    // NOTIFICATION : un conducteur a lancé une appro → prévenir les chefs dépôt
    // (uniquement si l'appro est réellement soumise, pas un brouillon vide)
    const chantier = (req.body && req.body.nomChantier) ? req.body.nomChantier : 'Sans titre';
    if (req.user.role === 'conducteur' || req.user.role === 'admin') {
      const depots = await pool.query("SELECT id FROM users WHERE role = 'depot'");
      const titre = 'Nouvelle appro à préparer';
      const corps = chantier + ' \u2014 demandée par ' + req.user.name;
      const mailHtml = emailTemplate(
        'Nouvelle appro à préparer',
        'Une nouvelle feuille d\'approvisionnement vient d\'être lancée :<br><br><strong>' + chantier + '</strong><br>Demandée par ' + req.user.name + '.',
        'Voir l\'appro'
      );
      for (const d of depots.rows) {
        notify(d.id, 'appro_creee', titre, corps, approId, 'AppROVISIO \u2014 Nouvelle appro à préparer', mailHtml);
      }
    }
  } catch (e) { res.status(500).json({ error: 'Erreur création' }); }
});

app.get('/api/appros/:id/history', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT type, actor_name, created_at FROM appro_events WHERE appro_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.put('/api/appros/:id', auth, async (req, res) => {
  try {
    // Récupérer l'ancien état pour détecter ce qui change
    const before = await pool.query('SELECT data, created_by FROM appros WHERE id = $1', [req.params.id]);
    const oldData = before.rows[0] ? before.rows[0].data : null;
    const createdBy = before.rows[0] ? before.rows[0].created_by : null;

    // Garde-fou Team Leader : doit \u00eatre li\u00e9 \u00e0 l'appro, et ne peut pas la marquer "rendue"
    if (req.user.role === 'team_leader') {
      const lk = await pool.query('SELECT 1 FROM appro_team_leaders WHERE appro_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      if (!lk.rows[0]) return res.status(403).json({ error: 'Acc\u00e8s refus\u00e9' });
      if (req.body && req.body.statut === 'sortie') return res.status(403).json({ error: 'Un Team Leader ne peut pas marquer une appro rendue' });
    }

    await pool.query('UPDATE appros SET data = $1, updated_at = NOW() WHERE id = $2', [req.body, req.params.id]);
    res.json({ ok: true });

    // HISTORIQUE : enregistrer les \u00e9tapes cl\u00e9s
    {
      const oS = oldData ? oldData.statut : null;
      const nS = req.body ? req.body.statut : null;
      const oM = oldData ? oldData.modifPrep : false;
      const nM = req.body ? req.body.modifPrep : false;
      if (nS === 'prete' && oS !== 'prete') logEvent(req.params.id, 'preparee', req.user.name);
      else if (nS === 'sortie' && oS !== 'sortie') logEvent(req.params.id, 'sortie', req.user.name);
      if (nS === 'sur_chantier' && oS !== 'sur_chantier') logEvent(req.params.id, 'tl_pris', req.user.name);
      if (nS === 'rendu' && oS !== 'rendu') logEvent(req.params.id, 'tl_rendu', req.user.name);
      if (nM && !oM) logEvent(req.params.id, 'modifiee', req.user.name);
      // Un Team Leader a modifi\u00e9 l'appro depuis le terrain
      if (req.user.role === 'team_leader') logEvent(req.params.id, 'tl_modif', req.user.name);
    }
    // NOTIFICATION : appro d\u00e9j\u00e0 pr\u00eate modifi\u00e9e par le conducteur \u2192 pr\u00e9venir le d\u00e9p\u00f4t
    const oldModif = oldData ? oldData.modifPrep : false;
    const newModif = req.body ? req.body.modifPrep : false;
    if (newModif && !oldModif && req.user.role !== 'depot') {
      const chantierM = (req.body && req.body.nomChantier) ? req.body.nomChantier : 'Sans titre';
      const depotsM = await pool.query("SELECT id FROM users WHERE role = 'depot'");
      const mailHtmlM = emailTemplate('Ajout sur une appro d\u00e9j\u00e0 pr\u00eate',
        'L\'appro <strong>' + chantierM + '</strong> \u00e9tait d\u00e9j\u00e0 pr\u00eate mais ' + req.user.name + ' vient d\'y ajouter / modifier quelque chose. Un compl\u00e9ment est \u00e0 pr\u00e9parer.',
        'Voir l\'appro');
      for (const d of depotsM.rows) {
        notify(d.id, 'appro_creee', 'Compl\u00e9ment \u00e0 pr\u00e9parer', chantierM + ' \u2014 ajout de ' + req.user.name, req.params.id, 'AppROVISIO \u2014 Compl\u00e9ment \u00e0 pr\u00e9parer', mailHtmlM);
      }
    }

    // NOTIFICATIONS vers le conducteur créateur (sauf si c'est lui-même qui agit)
    if (createdBy && createdBy !== req.user.id) {
      const chantier = (req.body && req.body.nomChantier) ? req.body.nomChantier : 'Sans titre';
      const oldStatut = oldData ? oldData.statut : null;
      const newStatut = req.body ? req.body.statut : null;

      if (newStatut === 'prete' && oldStatut !== 'prete') {
        const mailHtml = emailTemplate('Votre appro est prête au dépôt',
          'Votre appro <strong>' + chantier + '</strong> a été préparée par ' + req.user.name + '. Elle est prête au dépôt.',
          'Voir l\'appro');
        notify(createdBy, 'appro_prete', 'Appro prête au dépôt', chantier + ' \u2014 préparée par ' + req.user.name, req.params.id, 'AppROVISIO \u2014 Votre appro est prête', mailHtml);
      } else if (newStatut === 'sortie' && oldStatut !== 'sortie') {
        const mailHtml = emailTemplate('Appro complètement rendue',
          'Votre appro <strong>' + chantier + '</strong> a été marquée comme complètement rendue par ' + req.user.name + '.',
          'Voir l\'appro');
        notify(createdBy, 'appro_rendue', 'Appro complètement rendue', chantier + ' \u2014 par ' + req.user.name, req.params.id, 'AppROVISIO \u2014 Appro rendue', mailHtml);
      } else if (req.user.role === 'depot') {
        // Le chef dépôt a modifié l'appro (sans changement de statut majeur)
        const mailHtml = emailTemplate('Modification sur votre appro',
          'Le chef dépôt ' + req.user.name + ' a modifié votre appro <strong>' + chantier + '</strong>.',
          'Voir les changements');
        notify(createdBy, 'appro_modifiee', 'Appro modifiée par le dépôt', chantier + ' \u2014 par ' + req.user.name, req.params.id, 'AppROVISIO \u2014 Modification sur votre appro', mailHtml);
      }
    }
  } catch (e) { res.status(500).json({ error: 'Erreur mise à jour' }); }
});

app.delete('/api/appros/:id', auth, async (req, res) => {
  try {
    // Vérifier que l'utilisateur est le créateur (ou admin)
    const { rows } = await pool.query('SELECT created_by FROM appros WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Appro introuvable' });
    if (rows[0].created_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Vous ne pouvez supprimer que vos propres appros' });
    }
    await pool.query('DELETE FROM appros WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur suppression' }); }
});

// ── NOTIFICATIONS ─────────────────────────────────────────────
// Liste mes notifications (les 50 plus récentes)
// ── TABLEAU DE BORD (statistiques admin) ──────────────────────
app.get('/api/stats', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT a.data AS data, u.name AS creator FROM appros a LEFT JOIN users u ON a.created_by = u.id'
    );
    const byConductor = {}, byType = {}, materials = {};
    let totalArticles = 0;
    rows.forEach(r => {
      const d = r.data || {};
      const who = (d.conducteur && d.conducteur.trim()) ? d.conducteur.trim() : (r.creator || 'Inconnu');
      byConductor[who] = (byConductor[who] || 0) + 1;
      const types = Array.isArray(d.typeChantiers) ? d.typeChantiers : (d.typeChantier ? [d.typeChantier] : []);
      types.forEach(t => { if (t) byType[t] = (byType[t] || 0) + 1; });
      ['consommables', 'fournitures', 'outillage'].forEach(sec => {
        (Array.isArray(d[sec]) ? d[sec] : []).forEach(it => {
          if (it && it.designation && it.designation.trim()) {
            const k = it.designation.trim();
            materials[k] = (materials[k] || 0) + 1;
            totalArticles++;
          }
        });
      });
    });
    const sortObj = o => Object.keys(o).map(k => ({ name: k, count: o[k] })).sort((a, b) => b.count - a.count);
    res.json({
      totalAppros: rows.length,
      totalArticles: totalArticles,
      byConductor: sortObj(byConductor),
      byType: sortObj(byType),
      topMaterials: sortObj(materials).slice(0, 15)
    });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── LISTES PARTAG\u00c9ES (types / catalogue / clients) ─────────────
const LIST_NAMES = ['types', 'catalogue', 'clients'];
app.get('/api/lists', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT name, data FROM app_lists');
    const out = {};
    rows.forEach(r => { out[r.name] = r.data; });
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
// Initialiser une liste avec les valeurs par d\u00e9faut (seulement si absente)
app.post('/api/lists/:name/seed', auth, async (req, res) => {
  try {
    const name = req.params.name;
    if (!LIST_NAMES.includes(name)) return res.status(400).json({ error: 'Liste inconnue' });
    const data = Array.isArray(req.body && req.body.data) ? req.body.data : [];
    await pool.query(
      'INSERT INTO app_lists (name, data) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
      [name, JSON.stringify(data)]
    );
    const { rows } = await pool.query('SELECT data FROM app_lists WHERE name = $1', [name]);
    res.json({ data: rows[0] ? rows[0].data : [] });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
// Ajouter un \u00e9l\u00e9ment (tout le monde)
app.post('/api/lists/:name/add', auth, async (req, res) => {
  try {
    const name = req.params.name;
    if (!LIST_NAMES.includes(name)) return res.status(400).json({ error: 'Liste inconnue' });
    if (req.body.item === undefined) return res.status(400).json({ error: '\u00c9l\u00e9ment manquant' });
    await pool.query(
      `INSERT INTO app_lists (name, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (name) DO UPDATE SET data = app_lists.data || $2::jsonb`,
      [name, JSON.stringify([req.body.item])]
    );
    const { rows } = await pool.query('SELECT data FROM app_lists WHERE name = $1', [name]);
    res.json({ data: rows[0] ? rows[0].data : [] });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
// Supprimer un \u00e9l\u00e9ment par index (admin uniquement)
app.post('/api/lists/:name/remove', auth, adminOnly, async (req, res) => {
  try {
    const name = req.params.name;
    if (!LIST_NAMES.includes(name)) return res.status(400).json({ error: 'Liste inconnue' });
    const idx = parseInt(req.body && req.body.index, 10);
    if (isNaN(idx) || idx < 0) return res.status(400).json({ error: 'Index invalide' });
    await pool.query('UPDATE app_lists SET data = data - $1::int WHERE name = $2', [idx, name]);
    const { rows } = await pool.query('SELECT data FROM app_lists WHERE name = $1', [name]);
    res.json({ data: rows[0] ? rows[0].data : [] });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── CONDUCTEURS (liste pour menu d\u00e9roulant) ──────────────────
app.get('/api/users/conductors', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name FROM users WHERE role IN ('conducteur','admin') ORDER BY name"
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── NOUVEAUT\u00c9S (journal des mises \u00e0 jour) ─────────────────────
app.get('/api/news/seen', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT news_seen FROM users WHERE id = $1', [req.user.id]);
    res.json({ seen: rows[0] ? (rows[0].news_seen || 0) : 0 });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
app.put('/api/news/seen', auth, async (req, res) => {
  try {
    const v = parseInt(req.body && req.body.version, 10) || 0;
    await pool.query('UPDATE users SET news_seen = $1 WHERE id = $2', [v, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.get('/api/notifications', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, type, title, body, appro_id, is_read, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// Marquer une notification comme lue
app.put('/api/notifications/:id/read', auth, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// Marquer toutes mes notifications comme lues
app.put('/api/notifications/read-all', auth, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── FRONTEND ──────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────
async function initWithRetry(maxTries) {
  for (let i = 1; i <= maxTries; i++) {
    try {
      await initDB();
      return;
    } catch (e) {
      console.error(`Base pas encore prête (tentative ${i}/${maxTries}) : ${e.message}`);
      if (i === maxTries) throw e;
      await new Promise(function (r) { setTimeout(r, 3000); });
    }
  }
}
initWithRetry(15).then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AppROVISIO démarré sur le port ${PORT}`);
    console.log(`Code admin de démarrage : ${BOOTSTRAP_ADMIN_CODE}`);
  });
}).catch(err => {
  console.error('Erreur démarrage:', err.message);
  process.exit(1);
});
