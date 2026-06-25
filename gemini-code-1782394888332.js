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
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'AppROVISIO <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL || '';

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY || !to) return;
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

async function notify(userId, type, title, body, approId, emailSubject, emailHtml) {
  try {
    await pool.query(
      'INSERT INTO notifications (user_id, type, title, body, appro_id) VALUES ($1,$2,$3,$4,$5)',
      [userId, type, title, body || null, approId || null]
    );
  } catch (e) {
    console.error('Erreur création notification:', e.message);
  }
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
  `);
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

    if (code === BOOTSTRAP_ADMIN_CODE) {
      const { rows } = await client.query("SELECT COUNT(*) FROM users WHERE role='admin'");
      if (parseInt(rows[0].count) === 0) {
        role = 'admin';
      } else {
        return res.status(400).json({ error: 'Le code admin par défaut a déjà été utilisé' });
      }
    } else {
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

// ── APPROS ────────────────────────────────────────────────────
app.get('/api/appros', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, data, created_by, created_at, updated_at FROM appros ORDER BY updated_at DESC');
    res.json(rows.map(r => ({ ...r.data, _id: r.id, _createdBy: r.created_by, _updatedAt: r.updated_at })));
  } catch (e) { res.status(500).json({ error: 'Erreur lecture' }); }
});

app.post('/api/appros', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'INSERT INTO appros (data, created_by) VALUES ($1,$2) RETURNING id, created_at',
      [req.body, req.user.id]
    );
    const approId = rows[0].id;
    res.json({ ...req.body, _id: approId });

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

app.put('/api/appros/:id', auth, async (req, res) => {
  try {
    const before = await pool.query('SELECT data, created_by FROM appros WHERE id = $1', [req.params.id]);
    const oldData = before.rows[0] ? before.rows[0].data : null;
    const createdBy = before.rows[0] ? before.rows[0].created_by : null;

    await pool.query('UPDATE appros SET data = $1, updated_at = NOW() WHERE id = $2', [req.body, req.params.id]);
    res.json({ ok: true });

    const oldModif = oldData ? oldData.modifPrep : false;
    const newModif = req.body ? req.body.modifPrep : false;
    if (newModif && !oldModif && req.user.role !== 'depot') {
      const chantierM = (req.body && req.body.nomChantier) ? req.body.nomChantier : 'Sans titre';
      const depotsM = await pool.query("SELECT id FROM users WHERE role = 'depot'");
      const mailHtmlM = emailTemplate('Ajout sur une appro déjà prête',
        'L\'appro <strong>' + chantierM + '</strong> était déjà prête mais ' + req.user.name + ' vient d\'y ajouter / modifier quelque chose. Un complément est à préparer.',
        'Voir l\'appro');
      for (const d of depotsM.rows) {
        notify(d.id, 'appro_creee', 'Complément à préparer', chantierM + ' \u2014 ajout de ' + req.user.name, req.params.id, 'AppROVISIO \u2014 Complément à préparer', mailHtmlM);
      }
    }

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
    const { rows } = await pool.query('SELECT created_by FROM appros WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Appro introuvable' });
    if (rows[0].created_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Vous ne pouvez supprimer que vos propres appros' });
    }
    await pool.query('DELETE FROM appros WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur suppression' }); }
});

// ── LISTES PARTAGÉES (Inclusion de company_fleet) ─────────────────────
const LIST_NAMES = ['types', 'catalogue', 'clients', 'company_fleet'];

app.get('/api/lists', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT name, data FROM app_lists');
    const out = {};
    LIST_NAMES.forEach(n => { out[n] = n === 'company_fleet' ? [] : []; });
    rows.forEach(r => { out[r.name] = r.data; });
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/lists/:name/seed', auth, async (req, res) => {
  try {
    const name = req.params.name;
    if (!LIST_NAMES.includes(name)) return res.status(400).json({ error: 'Liste inconnue' });
    const data = Array.isArray(req.body && req.body.data) ? req.body.data : [];
    
    if (name === 'company_fleet') {
      await pool.query(
        'INSERT INTO app_lists (name, data) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET data = $2',
        [name, JSON.stringify(data)]
      );
    } else {
      await pool.query(
        'INSERT INTO app_lists (name, data) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
        [name, JSON.stringify(data)]
      );
    }
    
    const { rows } = await pool.query('SELECT data FROM app_lists WHERE name = $1', [name]);
    res.json({ data: rows[0] ? rows[0].data : [] });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/lists/:name/add', auth, async (req, res) => {
  try {
    const name = req.params.name;
    if (!LIST_NAMES.includes(name)) return res.status(400).json({ error: 'Liste inconnue' });
    if (req.body.item === undefined) return res.status(400).json({ error: 'Élément manquant' });
    await pool.query(
      `INSERT INTO app_lists (name, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (name) DO UPDATE SET data = app_lists.data || $2::jsonb`,
      [name, JSON.stringify([req.body.item])]
    );
    const { rows } = await pool.query('SELECT data FROM app_lists WHERE name = $1', [name]);
    res.json({ data: rows[0] ? rows[0].data : [] });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

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

// ── CONDUCTEURS ──────────────────────────────────────────────
app.get('/api/users/conductors', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name FROM users WHERE role IN ('conducteur','admin') ORDER BY name"
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── NOUVEAUTÉS ────────────────────────────────────────────────
app.get('/api/news/seen', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT news_seen FROM users WHERE id = $1', [req.user.id]);
    res.json({ seen: rows[0] ? (rows[0].news_seen || 0) : 0 });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.put('/api/news/seen', auth, async (req, res) => {
  try {
    const v = parseInt(req.body && req.body.version, 10) || 0;
    await pool.query('UPDATE users SET news_seen = $1 WHERE id = $2', [req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── NOTIFICATIONS GLOBAL ──────────────────────────────────────
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

// ── ROUTE DÉDIÉE A LA FLOTTE ──────────────────────────────────
app.get('/flotte', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'flotte.html'));
});

// ── CATCH-ALL FRONTEND ────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AppROVISIO démarré sur le port ${PORT}`);
    console.log(`Code admin de démarrage : ${BOOTSTRAP_ADMIN_CODE}`);
  });
}).catch(err => {
  console.error('Erreur démarrage:', err.message);
  process.exit(1);
});