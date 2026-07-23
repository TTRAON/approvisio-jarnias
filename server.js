require('dotenv').config();
// rebuild 17/07 v2
const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');

// ── WEB PUSH (notifications type app, iOS 16.4+ / Android / desktop) ──
// Chargement défensif : si le module ou les clés manquent, le push est
// simplement désactivé, le reste de l'app continue de tourner normalement.
let webpush = null, PUSH_ENABLED = false;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contact@jarnias.fr';
try {
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush = require('web-push');
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    PUSH_ENABLED = true;
    console.log('Web push activé.');
  } else {
    console.log('Web push désactivé (clés VAPID absentes).');
  }
} catch (e) {
  console.log('Web push indisponible (module web-push non installé) :', e.message);
}

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

// Le réglage « notifications par email » vit dans app_lists.config (tableau [CONFIG]),
// écrit par le front via POST /api/lists/config/set. On le relit ici, avec un petit cache
// pour ne pas requêter la base à chaque email. mailNotifs === false => aucun email n'est envoyé.
let _mailCfgCache = { at: 0, on: true };
async function mailNotifsEnabled() {
  const now = Date.now();
  if (now - _mailCfgCache.at < 30000) return _mailCfgCache.on;
  let on = true; // par défaut : activé (comportement historique)
  try {
    const { rows } = await pool.query('SELECT data FROM app_lists WHERE name = $1', ['config']);
    const cfg = rows[0] && Array.isArray(rows[0].data) ? rows[0].data[0] : null;
    if (cfg && cfg.mailNotifs === false) on = false;
  } catch (e) {
    console.error('Lecture config mailNotifs:', e.message);
  }
  _mailCfgCache = { at: now, on };
  return on;
}
// Invalide le cache dès que la config change (voir POST /api/lists/:name/set)
function invalidateMailCfgCache() { _mailCfgCache.at = 0; }

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY || !to) return; // pas de clé ou pas d'email : on saute silencieusement
  if (!(await mailNotifsEnabled())) return; // emails désactivés dans le paramétrage
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
  // Push (type app) en parallèle — ne bloque jamais.
  sendPush(userId, { title: title, body: body || '', approId: approId || null, type: type });
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

// Envoie une notification push à tous les appareils abonnés d'un utilisateur.
async function sendPush(userId, payload) {
  if (!PUSH_ENABLED || !userId) return;
  try {
    const { rows } = await pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId]);
    if (!rows.length) return;
    const data = JSON.stringify({
      title: payload.title || 'AppROVISIO',
      body: payload.body || '',
      approId: payload.approId || null,
      type: payload.type || ''
    });
    for (const sub of rows) {
      const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
      try {
        await webpush.sendNotification(subscription, data);
      } catch (err) {
        // 404/410 = abonnement expiré ou révoqué → on le retire proprement.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]).catch(() => {});
        } else {
          console.error('Push échec:', err && err.statusCode, err && err.body);
        }
      }
    }
  } catch (e) {
    console.error('sendPush erreur:', e.message);
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

    CREATE TABLE IF NOT EXISTS appro_comments (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      appro_id    UUID NOT NULL,
      user_id     UUID,
      author_name VARCHAR(160) NOT NULL,
      author_role VARCHAR(30),
      body        VARCHAR(2000) NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS appro_signatures (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      appro_id    UUID NOT NULL,
      user_id     UUID,
      author_name VARCHAR(160) NOT NULL,   -- le nom du compte connecté
      signed_name VARCHAR(160) NOT NULL,   -- ce que la personne a tapé (doit correspondre)
      comment     VARCHAR(1000),
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
      endpoint    TEXT NOT NULL UNIQUE,
      p256dh      TEXT NOT NULL,
      auth        TEXT NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    /* Jusqu'où chacun a lu la discussion d'une appro.
       Permet de dire « c'est lu » SANS répondre : sinon, pour faire disparaître
       « en attente », il faudrait répondre — ce qui remettrait l'autre en attente,
       et ainsi de suite sans fin. */
    CREATE TABLE IF NOT EXISTS appro_reads (
      appro_id    UUID NOT NULL,
      user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
      read_at     TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (appro_id, user_id)
    );

    /* Articles que CET utilisateur tape souvent, même absents du catalogue.
       Alimente l'autocomplétion « redondance personnelle » : taper "SC" propose
       "Scellement chimique" si c'est un article que la personne saisit fréquemment,
       indépendamment de ce qui existe dans le catalogue partagé. */
    CREATE TABLE IF NOT EXISTS user_frequent_items (
      user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data        JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at  TIMESTAMP DEFAULT NOW()
    );

    /* Quantité que CET utilisateur choisit d'habitude pour un article du catalogue
       (ex. il prend toujours 2 mousquetons). Mémorisée par nom d'article, réutilisée
       comme quantité par défaut la prochaine fois qu'il le sélectionne. */
    CREATE TABLE IF NOT EXISTS user_qty_prefs (
      user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data        JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at  TIMESTAMP DEFAULT NOW()
    );

    /* Articles \u00e9pingl\u00e9s MANUELLEMENT par l'utilisateur (favoris), ind\u00e9pendants de la
       fr\u00e9quence d'usage automatique \u2014 ex. « je sais que je vais en avoir besoin sur
       ce chantier », m\u00eame si l'article n'a jamais \u00e9t\u00e9 utilis\u00e9 avant. */
    CREATE TABLE IF NOT EXISTS user_favorites (
      user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data        JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at  TIMESTAMP DEFAULT NOW()
    );

    /* Suggestions d'ajout au catalogue PARTAG\u00c9 : quand quelqu'un tape souvent un
       article absent du catalogue, on propose \u00e0 l'admin/d\u00e9p\u00f4t de l'y ajouter d'un
       clic, au lieu qu'il ait \u00e0 deviner ce qui manque. */
    CREATE TABLE IF NOT EXISTS catalogue_suggestions (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name              VARCHAR(160) NOT NULL,
      suggested_by_name VARCHAR(160),
      count             INT DEFAULT 1,
      status            VARCHAR(20) DEFAULT 'pending',
      created_at        TIMESTAMP DEFAULT NOW(),
      updated_at        TIMESTAMP DEFAULT NOW()
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

function adminOrDepot(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'depot') return res.status(403).json({ error: 'Accès administrateur ou dépôt requis' });
  next();
}

// Écriture des listes : admin/dépôt partout ; le conducteur peut aussi écrire la liste "commandes".
function listWriteAccess(req, res, next) {
  const role = req.user.role;
  if (role === 'admin' || role === 'depot') return next();
  if (role === 'conducteur' && req.params.name === 'commandes') return next();
  return res.status(403).json({ error: 'Accès administrateur ou dépôt requis' });
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
    if (!username || !password || !name || !email) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min.)' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Adresse email invalide' });
    }

    let role = null;
    // Sans code d'invitation -> role technicien (acces terrain limite)
    if (!code || !String(code).trim()) { role = 'technicien'; } else

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
    if (code && code !== BOOTSTRAP_ADMIN_CODE && role !== 'technicien') {
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
// ═══ MESSAGES EN ATTENTE ═══
// « En attente » = le DERNIER message d'une appro vient de l'autre bord et personne
// n'a répondu depuis. Dès qu'on répond, l'appro sort de la liste. Aucun « lu » à gérer :
// c'est un simple « la balle est dans mon camp », calculé sur le dernier message.
// Deux bords : {depot, admin} d'un côté, {conducteur, team_leader} de l'autre.
/* Une appro est « en attente » quand le DERNIER message n'est pas de moi.
   L'ancien découpage par « bord » (dépôt et admin comptés ensemble) faisait qu'un
   compte admin ne voyait jamais les messages du dépôt : sa liste restait vide. */
app.get('/api/appros/pending-messages', auth, async (req, res) => {
  try {
    // Le technicien ne voit que ses appros rattachées ; les autres voient tout.
    var appros;
    if (req.user.role === 'team_leader') {
      appros = await pool.query(
        `SELECT a.id, a.data FROM appros a
         JOIN appro_team_leaders tl ON tl.appro_id = a.id WHERE tl.user_id = $1`, [req.user.id]);
    } else {
      appros = await pool.query('SELECT id, data FROM appros');
    }
    if (!appros.rows.length) return res.json([]);
    const ids = appros.rows.map(r => r.id);
    // Le dernier message de chaque appro, en une requête (DISTINCT ON).
    const derniers = await pool.query(
      `SELECT DISTINCT ON (appro_id) appro_id, user_id, author_name, author_role, body, created_at
       FROM appro_comments WHERE appro_id = ANY($1)
       ORDER BY appro_id, created_at DESC`, [ids]);
    // Jusqu'où j'ai lu chaque discussion (bouton « J'ai lu »).
    const lus = await pool.query(
      `SELECT appro_id, read_at FROM appro_reads WHERE user_id = $1 AND appro_id = ANY($2)`,
      [req.user.id, ids]);
    const luLe = {};
    lus.rows.forEach(r => { luLe[r.appro_id] = r.read_at; });
    // Combien de messages des autres depuis ma dernière prise de parole OU ma dernière lecture.
    const compte = await pool.query(
      `SELECT c.appro_id, COUNT(*)::int AS n
         FROM appro_comments c
        WHERE c.appro_id = ANY($1)
          AND c.user_id IS DISTINCT FROM $2
          AND c.created_at > GREATEST(
                COALESCE((SELECT MAX(m.created_at) FROM appro_comments m
                           WHERE m.appro_id = c.appro_id AND m.user_id = $2),
                         '-infinity'::timestamp),
                COALESCE((SELECT r.read_at FROM appro_reads r
                           WHERE r.appro_id = c.appro_id AND r.user_id = $2),
                         '-infinity'::timestamp))
        GROUP BY c.appro_id`, [ids, req.user.id]);
    const nParAppro = {};
    compte.rows.forEach(r => { nParAppro[r.appro_id] = r.n; });
    const parAppro = {};
    derniers.rows.forEach(r => { parAppro[r.appro_id] = r; });
    const out = [];
    appros.rows.forEach(a => {
      const last = parAppro[a.id];
      if (!last) return;                                   // aucune discussion
      if (last.user_id && last.user_id === req.user.id) return; // j'ai le dernier mot
      // J'ai marqué comme lu après le dernier message : plus rien à traiter.
      const lu = luLe[a.id];
      if (lu && new Date(lu) >= new Date(last.created_at)) return;
      const d = a.data || {};
      out.push({
        _id: a.id,
        nomChantier: d.nomChantier || 'Sans titre',
        noAffaire: d.noAffaire || '',
        auteur: last.author_name,
        role: last.author_role,
        extrait: last.body.length > 120 ? last.body.slice(0, 120) + '\u2026' : last.body,
        at: last.created_at,
        nonLus: nParAppro[a.id] || 1
      });
    });
    // le plus récent d'abord
    out.sort((x, y) => new Date(y.at) - new Date(x.at));
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'Erreur', detail: e.message }); }
});

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

// ── FIL DE DISCUSSION PAR APPRO (conducteur ↔ dépôt) ──────────────
// Stocké dans sa propre table : jamais dans le JSON de l'appro, pour ne pas
// être écrasé quand les deux côtés enregistrent l'appro en même temps.
app.get('/api/appros/:id/comments', auth, async (req, res) => {
  try {
    if (req.user.role === 'team_leader') {
      const lk = await pool.query('SELECT 1 FROM appro_team_leaders WHERE appro_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      if (!lk.rows[0]) return res.status(403).json({ error: 'Accès refusé' });
    }
    const { rows } = await pool.query(
      `SELECT id, user_id, author_name, author_role, body, created_at
         FROM appro_comments WHERE appro_id = $1 ORDER BY created_at ASC`, [req.params.id]
    );
    // Qui a lu, et jusqu'à quand : sert à afficher « Lu par … » sous les messages.
    const lus = await pool.query(
      `SELECT r.user_id, u.name, u.role, r.read_at
         FROM appro_reads r LEFT JOIN users u ON u.id = r.user_id
        WHERE r.appro_id = $1`, [req.params.id]);
    const moi = await pool.query(
      'SELECT read_at FROM appro_reads WHERE appro_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({
      messages: rows,
      lectures: lus.rows,
      maLecture: moi.rows[0] ? moi.rows[0].read_at : null
    });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

/* « J'ai lu » — marque la discussion comme lue jusqu'à maintenant, SANS répondre.
   Indispensable : sans ça, le seul moyen de sortir de « Messages en attente »
   serait de répondre, ce qui mettrait l'autre en attente à son tour, sans fin. */
app.post('/api/appros/:id/read', auth, async (req, res) => {
  try {
    if (req.user.role === 'team_leader') {
      const lk = await pool.query('SELECT 1 FROM appro_team_leaders WHERE appro_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      if (!lk.rows[0]) return res.status(403).json({ error: 'Accès refusé' });
    }
    const { rows } = await pool.query(
      `INSERT INTO appro_reads (appro_id, user_id, read_at) VALUES ($1,$2,NOW())
       ON CONFLICT (appro_id, user_id) DO UPDATE SET read_at = NOW()
       RETURNING read_at`, [req.params.id, req.user.id]);
    res.json({ ok: true, read_at: rows[0] && rows[0].read_at });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── ARTICLES FRÉQUENTS PERSONNELS (autocomplétion « redondance ») ──
// Chaque compte a sa propre liste, alimentée par ce qu'il tape effectivement dans
// ses appros — même des articles absents du catalogue partagé.
app.get('/api/my/frequent-items', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM user_frequent_items WHERE user_id = $1', [req.user.id]);
    res.json(rows[0] ? rows[0].data : []);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
app.post('/api/my/frequent-items/bump', auth, async (req, res) => {
  try {
    const names = Array.isArray(req.body && req.body.names) ? req.body.names : [];
    if (!names.length) return res.json({ ok: true });
    const { rows } = await pool.query('SELECT data FROM user_frequent_items WHERE user_id = $1', [req.user.id]);
    let list = rows[0] ? rows[0].data : [];
    if (!Array.isArray(list)) list = [];
    const now = new Date().toISOString();
    names.slice(0, 60).forEach(raw => {
      // Accepte une simple chaîne (ancien format) ou {n, sec} pour retenir la
      // section d'origine (utile pour un ajout rapide direct plus tard).
      const isObj = raw && typeof raw === 'object';
      const n = ('' + (isObj ? raw.n : raw)).trim().slice(0, 120);
      const sec = isObj && ['consommables', 'fournitures', 'outillage'].includes(raw.sec) ? raw.sec : null;
      if (!n) return;
      const key = n.toLowerCase();
      const found = list.find(x => (x.n || '').toLowerCase() === key);
      if (found) { found.c = (found.c || 1) + 1; found.t = now; if (sec) found.sec = sec; }
      else list.push({ n, c: 1, t: now, sec: sec || 'consommables' });
    });
    // On garde les plus utilisés, plafonné pour rester léger.
    list.sort((a, b) => (b.c || 0) - (a.c || 0));
    list = list.slice(0, 150);
    await pool.query(
      `INSERT INTO user_frequent_items (user_id, data, updated_at) VALUES ($1,$2::jsonb,NOW())
       ON CONFLICT (user_id) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
      [req.user.id, JSON.stringify(list)]);
    res.json({ ok: true, data: list });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── QUANTITÉS PRÉFÉRÉES PERSONNELLES ──
// Ce que CET utilisateur choisit d'habitude pour un article donné (ex. toujours 2
// mousquetons) : réutilisé comme quantité par défaut à la prochaine sélection.
app.get('/api/my/qty-prefs', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM user_qty_prefs WHERE user_id = $1', [req.user.id]);
    res.json(rows[0] ? rows[0].data : []);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
app.post('/api/my/qty-prefs/set', auth, async (req, res) => {
  try {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!items.length) return res.json({ ok: true });
    const { rows } = await pool.query('SELECT data FROM user_qty_prefs WHERE user_id = $1', [req.user.id]);
    let list = rows[0] ? rows[0].data : [];
    if (!Array.isArray(list)) list = [];
    const now = new Date().toISOString();
    items.slice(0, 60).forEach(it => {
      const n = ('' + (it && it.n || '')).trim().slice(0, 120);
      const q = ('' + (it && it.q != null ? it.q : '')).trim().slice(0, 20);
      if (!n || !q) return;
      const key = n.toLowerCase();
      const found = list.find(x => (x.n || '').toLowerCase() === key);
      if (found) { found.q = q; found.t = now; }
      else list.push({ n, q, t: now });
    });
    list.sort((a, b) => new Date(b.t) - new Date(a.t));
    list = list.slice(0, 200);
    await pool.query(
      `INSERT INTO user_qty_prefs (user_id, data, updated_at) VALUES ($1,$2::jsonb,NOW())
       ON CONFLICT (user_id) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
      [req.user.id, JSON.stringify(list)]);
    res.json({ ok: true, data: list });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── FAVORIS PERSONNELS (épingle manuelle, indépendante de la fréquence) ──
app.get('/api/my/favorites', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM user_favorites WHERE user_id = $1', [req.user.id]);
    res.json(rows[0] ? rows[0].data : []);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
app.post('/api/my/favorites/toggle', auth, async (req, res) => {
  try {
    const name = ('' + (req.body && req.body.name || '')).trim().slice(0, 160);
    if (!name) return res.status(400).json({ error: 'Nom manquant' });
    const { rows } = await pool.query('SELECT data FROM user_favorites WHERE user_id = $1', [req.user.id]);
    let list = rows[0] ? rows[0].data : [];
    if (!Array.isArray(list)) list = [];
    const key = name.toLowerCase();
    const idx = list.findIndex(x => (x || '').toLowerCase() === key);
    let on;
    if (idx >= 0) { list.splice(idx, 1); on = false; }
    else { list.push(name); on = true; }
    await pool.query(
      `INSERT INTO user_favorites (user_id, data, updated_at) VALUES ($1,$2::jsonb,NOW())
       ON CONFLICT (user_id) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
      [req.user.id, JSON.stringify(list)]);
    res.json({ ok: true, on, data: list });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── SUGGESTIONS D'AJOUT AU CATALOGUE PARTAGÉ ──
// N'importe quel compte peut déclencher une suggestion (elle vient de son usage
// personnel) ; seuls admin/dépôt peuvent la consulter et l'approuver/rejeter.
app.post('/api/catalogue-suggestions', auth, async (req, res) => {
  try {
    const name = ('' + (req.body && req.body.name || '')).trim().slice(0, 160);
    if (!name) return res.status(400).json({ error: 'Nom manquant' });
    const key = name.toLowerCase();
    const existing = await pool.query('SELECT id, status, count FROM catalogue_suggestions WHERE lower(name) = $1', [key]);
    if (existing.rows[0]) {
      // Une suggestion déjà tranchée (approuvée/rejetée) reste telle quelle : on ne
      // la relance pas dans les jambes de l'admin à chaque nouvelle utilisation.
      if (existing.rows[0].status === 'pending') {
        await pool.query(
          'UPDATE catalogue_suggestions SET count = count + 1, suggested_by_name = $2, updated_at = NOW() WHERE id = $1',
          [existing.rows[0].id, req.user.name]);
      }
      return res.json({ ok: true });
    }
    await pool.query(
      `INSERT INTO catalogue_suggestions (name, suggested_by_name, count, status) VALUES ($1,$2,1,'pending')`,
      [name, req.user.name]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
app.get('/api/catalogue-suggestions', auth, adminOrDepot, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, suggested_by_name, count, created_at FROM catalogue_suggestions
        WHERE status = 'pending' ORDER BY count DESC, created_at ASC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
app.post('/api/catalogue-suggestions/:id/approve', auth, adminOrDepot, async (req, res) => {
  try {
    const sug = await pool.query('SELECT name FROM catalogue_suggestions WHERE id = $1', [req.params.id]);
    if (!sug.rows[0]) return res.status(404).json({ error: 'Suggestion introuvable' });
    const item = {
      cat: ('' + (req.body && req.body.cat || 'Divers')).trim().slice(0, 80),
      sec: ['consommables', 'fournitures', 'outillage'].includes(req.body && req.body.sec) ? req.body.sec : 'consommables',
      n: sug.rows[0].name,
      q: ('' + (req.body && req.body.q || '1')).trim().slice(0, 20) || '1'
    };
    await pool.query(
      `INSERT INTO app_lists (name, data) VALUES ('catalogue', $1::jsonb)
       ON CONFLICT (name) DO UPDATE SET data = app_lists.data || $1::jsonb`,
      [JSON.stringify([item])]);
    await pool.query("UPDATE catalogue_suggestions SET status = 'approved', updated_at = NOW() WHERE id = $1", [req.params.id]);
    const { rows } = await pool.query("SELECT data FROM app_lists WHERE name = 'catalogue'");
    res.json({ ok: true, catalogue: rows[0] ? rows[0].data : [] });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
app.post('/api/catalogue-suggestions/:id/reject', auth, adminOrDepot, async (req, res) => {
  try {
    await pool.query("UPDATE catalogue_suggestions SET status = 'rejected', updated_at = NOW() WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});



// ═══ SIGNATURE DE FIN DE VISITE (technicien) ═══
// Une seule fois par visite, quand le technicien quitte l'appro après y avoir
// changé quelque chose (ajout d'article, prise en charge...). Prouve que la
// personne qui a manipulé le matériel est bien celle qui l'assume.
app.post('/api/appros/:id/signatures', auth, async (req, res) => {
  try {
    const signedName = ('' + ((req.body && req.body.name) || '')).trim();
    const comment = ('' + ((req.body && req.body.comment) || '')).trim();
    if (!signedName) return res.status(400).json({ error: 'Signature vide' });
    if (signedName.length > 160) return res.status(400).json({ error: 'Nom trop long' });
    if (comment.length > 1000) return res.status(400).json({ error: 'Commentaire trop long (1000 caractères max)' });
    if (req.user.role === 'team_leader') {
      const lk = await pool.query('SELECT 1 FROM appro_team_leaders WHERE appro_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      if (!lk.rows[0]) return res.status(403).json({ error: 'Accès refusé' });
    }
    const ins = await pool.query(
      `INSERT INTO appro_signatures (appro_id, user_id, author_name, signed_name, comment)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, user_id, author_name, signed_name, comment, created_at`,
      [req.params.id, req.user.id, req.user.name, signedName, comment || null]
    );
    const sig = ins.rows[0];

    // Prévenir le conducteur et le dépôt : une signature avec commentaire
    // signale souvent qu'il manque quelque chose, ça mérite d'être vu vite.
    try {
      const ap = await pool.query('SELECT data, created_by FROM appros WHERE id = $1', [req.params.id]);
      const chantier = (ap.rows[0] && ap.rows[0].data && ap.rows[0].data.nomChantier) || 'une appro';
      const dest = new Set();
      if (ap.rows[0] && ap.rows[0].created_by) dest.add(ap.rows[0].created_by);
      const depots = await pool.query("SELECT id FROM users WHERE role = 'depot'");
      depots.rows.forEach(d => dest.add(d.id));
      dest.delete(req.user.id);
      const titre = (comment ? 'Signature avec commentaire — ' : 'Signature — ') + chantier;
      const corps = req.user.name + ' a signé' + (comment ? (' : ' + (comment.length > 100 ? comment.slice(0, 97) + '…' : comment)) : '.');
      const mailHtml = '<p><b>' + req.user.name + '</b> a signé son passage sur <b>' + chantier + '</b>.</p>' + (comment ? '<blockquote>' + comment + '</blockquote>' : '');
      dest.forEach(uid => notify(uid, 'appro_signature', titre, corps, req.params.id, 'AppROVISIO — ' + titre, mailHtml));
    } catch (e) { console.error('Notif signature:', e.message); }

    res.json(sig);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.get('/api/appros/:id/signatures', auth, async (req, res) => {
  try {
    if (req.user.role === 'team_leader') {
      const lk = await pool.query('SELECT 1 FROM appro_team_leaders WHERE appro_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      if (!lk.rows[0]) return res.status(403).json({ error: 'Accès refusé' });
    }
    const { rows } = await pool.query(
      `SELECT id, user_id, author_name, signed_name, comment, created_at
         FROM appro_signatures WHERE appro_id = $1 ORDER BY created_at DESC`, [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/appros/:id/comments', auth, async (req, res) => {
  try {
    const body = (req.body && req.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Message vide' });
    if (body.length > 2000) return res.status(400).json({ error: 'Message trop long' });
    if (req.user.role === 'team_leader') {
      const lk = await pool.query('SELECT 1 FROM appro_team_leaders WHERE appro_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      if (!lk.rows[0]) return res.status(403).json({ error: 'Accès refusé' });
    }
    const ins = await pool.query(
      `INSERT INTO appro_comments (appro_id, user_id, author_name, author_role, body)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, user_id, author_name, author_role, body, created_at`,
      [req.params.id, req.user.id, req.user.name, req.user.role, body]
    );
    const msg = ins.rows[0];

    // Répondre vaut lecture : on avance ma marque de lecture au même instant.
    try {
      await pool.query(
        `INSERT INTO appro_reads (appro_id, user_id, read_at) VALUES ($1,$2,NOW())
         ON CONFLICT (appro_id, user_id) DO UPDATE SET read_at = NOW()`,
        [req.params.id, req.user.id]);
    } catch (e) { console.error('Marque lecture:', e.message); }

    // Notifier les autres intervenants (jamais l'auteur lui-même).
    try {
      const ap = await pool.query('SELECT data, created_by FROM appros WHERE id = $1', [req.params.id]);
      const chantier = (ap.rows[0] && ap.rows[0].data && ap.rows[0].data.nomChantier) || 'une appro';
      const extrait = body.length > 120 ? body.slice(0, 117) + '…' : body;
      const dest = new Set();
      // le créateur de l'appro
      if (ap.rows[0] && ap.rows[0].created_by) dest.add(ap.rows[0].created_by);
      // tous les dépôts (sauf si l'auteur est lui-même dépôt)
      if (req.user.role !== 'depot') {
        const depots = await pool.query("SELECT id FROM users WHERE role = 'depot'");
        depots.rows.forEach(d => dest.add(d.id));
      }
      // si l'auteur est dépôt, on vise le(s) conducteur(s) via le créateur (déjà ajouté)
      dest.delete(req.user.id); // jamais soi-même
      const titre = 'Nouveau message — ' + chantier;
      const corps = req.user.name + ' : ' + extrait;
      const mailHtml = '<p><b>' + req.user.name + '</b> a écrit sur l\'appro <b>' + chantier + '</b> :</p><blockquote>' + extrait + '</blockquote>';
      dest.forEach(uid => notify(uid, 'appro_message', titre, corps, req.params.id, 'AppROVISIO — Nouveau message', mailHtml));
    } catch (e) { console.error('Notif message:', e.message); }

    res.json(msg);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.delete('/api/appros/:id/comments/:cid', auth, async (req, res) => {
  try {
    // Un auteur peut supprimer son message ; admin peut tout supprimer.
    const c = await pool.query('SELECT user_id FROM appro_comments WHERE id = $1 AND appro_id = $2', [req.params.cid, req.params.id]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Message introuvable' });
    if (req.user.role !== 'admin' && c.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Non autorisé' });
    await pool.query('DELETE FROM appro_comments WHERE id = $1', [req.params.cid]);
    res.json({ ok: true });
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
    if (q) {
      // La recherche portait UNIQUEMENT sur le nom, alors que le champ promet
      // « Nom de chantier ou N° d'affaire » : chercher une référence ne renvoyait rien.
      // On couvre désormais nom, référence, client et ville.
      const words = q.split(/\s+/).filter(Boolean);
      filtered = all.filter(function (s) {
        const hay = [s.name, s.nom, s.reference, s.ref, s.customer, s.city, s.zipCode]
          .filter(function (v) { return v != null && v !== ''; })
          .join(' ')
          .toLowerCase();
        // tous les mots doivent être présents : « dupont paris » trouve le bon chantier
        return words.every(function (w) { return hay.indexOf(w) >= 0; });
      });
    }
    const lim = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    res.json({ sites: filtered.slice(0, lim), shown: Math.min(filtered.length, lim), total: filtered.length, grandTotal: all.length });
  } catch (e) { res.status(502).json({ error: 'Erreur de connexion \u00e0 Alobees', detail: e.message }); }
});

// D\u00e9tail d'un chantier Alobees (proxy) \u2014 utile pour r\u00e9cup\u00e9rer client / n\u00b0 affaire / adresse
// Resolution des identifiants utilisateurs Alobees (supervisor_ids, foreman_ids) en noms
let _aloUsers = { at: 0, map: {} };
async function getAloUserMap() {
  if (Object.keys(_aloUsers.map).length && (Date.now() - _aloUsers.at) < ALO_TTL) return _aloUsers.map;
  const map = {};
  const paths = ['/user?limit=500', '/users?limit=500', '/member?limit=500', '/collaborator?limit=500'];
  for (const p of paths) {
    try {
      const r = await fetch(ALOBEES_BASE + p, { headers: { 'Authorization': 'APIKey ' + ALOBEES_API_KEY } });
      if (!r.ok) continue;
      const j = JSON.parse(await r.text());
      const list = Array.isArray(j) ? j : (j.data || []);
      if (!list.length) continue;
      for (const u of list) {
        const nm = u.name || ((u.firstName || u.firstname || u.first_name || '') + ' ' + (u.lastName || u.lastname || u.last_name || '')).trim() || u.fullName || u.email;
        if (u.id && nm) map[u.id] = nm;
      }
      if (Object.keys(map).length) break;
    } catch (e) {}
  }
  _aloUsers = { at: Date.now(), map };
  return map;
}

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
    try {
      if ((site.supervisor_ids && site.supervisor_ids.length) || (site.foreman_ids && site.foreman_ids.length)) {
        const umap = await getAloUserMap();
        site._supervisors = (site.supervisor_ids || []).map(function (id) { return umap[id]; }).filter(Boolean);
        site._foremen = (site.foreman_ids || []).map(function (id) { return umap[id]; }).filter(Boolean);
        site._usersResolved = Object.keys(umap).length;
      }
    } catch (e) { /* resolution non bloquante */ }
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
    if ((req.user.role === 'conducteur' || req.user.role === 'admin') && !(req.body && req.body.draft)) {
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
    // NOTIFICATION : passage brouillon \u2192 production \u2192 pr\u00e9venir le d\u00e9p\u00f4t
    const wasDraft = oldData ? oldData.draft : false;
    const nowDraft = req.body ? req.body.draft : false;
    if (wasDraft && !nowDraft) {
      const chantierP = (req.body && req.body.nomChantier) ? req.body.nomChantier : 'Sans titre';
      const depotsP = await pool.query("SELECT id FROM users WHERE role = 'depot'");
      const mailHtmlP = emailTemplate('Nouvelle appro à préparer',
        'Une appro vient d\'être envoyée en production :<br><br><strong>' + chantierP + '</strong><br>Par ' + req.user.name + '.',
        'Voir l\'appro');
      for (const d of depotsP.rows) {
        notify(d.id, 'appro_creee', 'Nouvelle appro à préparer', chantierP + ' \\u2014 par ' + req.user.name, req.params.id, 'AppROVISIO \\u2014 Nouvelle appro à préparer', mailHtmlP);
      }
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
    // Récupère le créateur ET les données (pour comparer au nom inscrit sur l'appro)
    const { rows } = await pool.query('SELECT created_by, data FROM appros WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Appro introuvable' });
    const d = rows[0].data || {};
    const norm = (x) => (x || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const me = norm(req.user.name);
    // Une appro est « la mienne » si mon compte l'a créée, si je suis admin/dépôt,
    // OU si mon NOM figure dessus (conducteur, chargé d'affaires, team leader) —
    // même si elle a été créée depuis un autre compte.
    const nameMatches = me && [d.conducteur, d.chargeAffaires, d.tlName].some((n) => norm(n) === me);
    const allowed = rows[0].created_by === req.user.id
      || req.user.role === 'admin'
      || req.user.role === 'depot'
      || nameMatches;
    if (!allowed) {
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
const LIST_NAMES = ['types', 'catalogue', 'clients', 'trucks', 'commandes', 'annonces', 'tickets', 'config'];
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
// Ajouter plusieurs \u00e9l\u00e9ments d'un coup (tout le monde)
app.post('/api/lists/:name/addmany', auth, async (req, res) => {
  try {
    const name = req.params.name;
    if (!LIST_NAMES.includes(name)) return res.status(400).json({ error: 'Liste inconnue' });
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
    if (!items || !items.length) return res.status(400).json({ error: 'Aucun \u00e9l\u00e9ment' });
    await pool.query(
      `INSERT INTO app_lists (name, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (name) DO UPDATE SET data = app_lists.data || $2::jsonb`,
      [name, JSON.stringify(items)]
    );
    const { rows } = await pool.query('SELECT data FROM app_lists WHERE name = $1', [name]);
    res.json({ data: rows[0] ? rows[0].data : [] });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
// Remplacer toute une liste (admin uniquement) \u2014 utilis\u00e9 pour les camions
app.post('/api/lists/:name/set', auth, listWriteAccess, async (req, res) => {
  try {
    const name = req.params.name;
    if (!LIST_NAMES.includes(name)) return res.status(400).json({ error: 'Liste inconnue' });
    const data = Array.isArray(req.body && req.body.data) ? req.body.data : [];
    await pool.query(
      'INSERT INTO app_lists (name, data) VALUES ($1, $2::jsonb) ON CONFLICT (name) DO UPDATE SET data = $2::jsonb',
      [name, JSON.stringify(data)]
    );
    if (name === 'config') invalidateMailCfgCache(); // le réglage email prend effet immédiatement
    res.json({ data: data });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
// Supprimer un \u00e9l\u00e9ment par index (admin uniquement)
app.post('/api/lists/:name/remove', auth, adminOrDepot, async (req, res) => {
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
app.post('/api/alobees/refresh', auth, adminOnly, (req, res) => {
  _aloCache = { at: 0, sites: [] };
  _aloUsers = { at: 0, map: {} };
  res.json({ ok: true });
});

app.get('/api/users/names', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, role FROM users ORDER BY name');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
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

// ── WEB PUSH : clé publique + abonnement/désabonnement ──
// Expose la clé publique VAPID (le client en a besoin pour s'abonner).
app.get('/api/push/key', (req, res) => {
  res.json({ enabled: PUSH_ENABLED, key: PUSH_ENABLED ? VAPID_PUBLIC_KEY : '' });
});
// Enregistre (ou met à jour) l'abonnement push de l'appareil courant.
app.post('/api/push/subscribe', auth, async (req, res) => {
  try {
    if (!PUSH_ENABLED) return res.status(503).json({ error: 'Push désactivé' });
    const sub = req.body && req.body.subscription;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ error: 'Abonnement invalide' });
    }
    // upsert par endpoint (un même appareil ne crée qu'une ligne, rattachée à l'utilisateur courant)
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
// Retire l'abonnement de cet appareil.
app.post('/api/push/unsubscribe', auth, async (req, res) => {
  try {
    const endpoint = req.body && req.body.endpoint;
    if (endpoint) await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── PWA : manifest + service worker servis en inline (pas de fichiers à déposer) ──
const PWA_ACCENT = '#6D28D9';
// Icône SVG simple (boîte d'appro) encodée — sert d'icône maskable toutes tailles.
const PWA_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="${PWA_ACCENT}"/><g fill="#fff"><path d="M256 96 96 176v160l160 80 160-80V176L256 96zm0 54 106 53-106 53-106-53 106-53zM136 236l100 50v108l-100-50V236zm140 158V286l100-50v108l-100 50z"/></g></svg>`;

app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').json({
    name: 'AppROVISIO',
    short_name: 'AppRO',
    description: "Gestion des approvisionnements de chantier — JARNIAS",
    start_url: '/',
    scope: '/',
    // Ouvrir les liens du domaine dans l'app installée plutôt que le navigateur (Android).
    handle_links: 'preferred',
    launch_handler: { client_mode: 'navigate-existing' },
    capture_links: 'existing-client-navigate',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#000000',
    theme_color: PWA_ACCENT,
    lang: 'fr',
    icons: [
      { src: '/pwa-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }
    ]
  });
});
app.get('/pwa-icon.svg', (req, res) => { res.type('image/svg+xml').send(PWA_ICON_SVG); });
// Vrais PNG (indispensables pour iOS : Safari n'accepte pas le SVG en icône d'écran d'accueil)
const PWA_PNG_192 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAACXBIWXMAAAPoAAAD6AG1e1JrAAANmElEQVR4nO2ceahV1RfHV4OlaaampaVlog1WlFlig81a5phlg5mROVDhkA2aNpdGpWEpWVp/qKBmZQOpEUgoohDhXElEg5aZomgqpg0rvgv25bz3e76eFb9Tns+Bzb33nHPP2e+8z/rutdde65qZOY1nYMV9Brl3gMYzcAwACBACYwQAAoTAcYGAACEw5gBAgBA4k2AgQAiMKBAQIAROGBQIEAJjHQAIEAJnIQwIEAJjJRgIEAInFQIIEAIjFwgIEAInGQ4IEAIjGxQIEAInHRoIEAKjHgAIEAKnIAYIEAKjIgwIEAKnJBIIEAKjJhgIjGdAUTwQeMGfQe4doPEMHAMAAoTAGAGAACFwXCAgQAiMOQAQIATOJBgIEAIjCgQECIETBgUChMBYBwAChMBZCAMChMBYCQYChMBJhQAChMDIBQIChMBJhgMChMDIBgUChMBJhwYChMCoBwAChMApiAEChMCoCAMChMApiQQChMCoCQYC4xlQFA8EXvBnkHsHaDwDxwCAACEwRgAgQAgcFwgIEAJjDgAECIEzCQYChMCIAgEBQuCEQYEAITDWAYAAIXAWwoAAITBWgoEAIXBSIYAAITBygYAAIXCS4YAAITCyQYEAIXDSoYEAITDqAYAAIXAKYoAAITAqwoAAIXBKIoEAITBqgoHAeAYUxQOBF/wZ5N4BGs/AMQAgQAiMEQAIEALHBQIChMCYAwABQuBMgoEAITCiQECAEDhhUCBACIx1gAMOgoMOOij3PlhxW+4d8KLDjwEYBlBU+PVap04dr1GjRu79sWK23DtQaPhPP/10X7RokZ966qnx+eCDD869b1aslnsHCgt/3bp1/emnn/aPP/7YmzdvHvswAMMAimIAl156qQ8fPtwnTJjgzZo1wwAsl/9H/kAU1QB69uzpQ4YM8YcffthPOOGEMsdohgEcqBAkN6dr164+fvx4Hzx4MAZguf0/8geiaC2p/JFHHunTp0/3559/3hs1alTmGM0wgCKMAi1atPAZM2bEa3Y/zTCAA3HBK9sOOeSQONauXTsfNWoUI4Dl8r/JH44it5o1a/oZZ5zhL730kj/wwAMYgWEAByTkRx99tNerV8+POeYYP/7448PladOmjXfo0ME7duzol1xyiU+ePDne6zu4Qvb/+v/kD8iB2tKEtkGDBn7DDTdEu+6660qvnTt39quuusqvvPLKMABFhe68804/9NBDc++7Fafl3oFCGIFUv1evXn7TTTf5tdde6126dAm1v/rqq8MALr/88jCCa665JqJD2e/SDAP4L0OQQJbb07t3b7/55ptjFLj++uvDGLp37+6dOnUKY2jZsmXu/bVitdw7UCgjUNKb/H4pvlIhLrjgAm/VqpWffPLJkRuE6hsGkDesNCvSM8i9A//qplh9itdXtL+8Yqf4fvlW/rgmuum7elXUR/uy5+7r3jpX+yuKFGXvX9l5NMMA/ioEf8VNqajy6+9Wg+3rmsBt+/MMUIN9AV6/fn1/5JFH/J577vHDDz+8TFxf+5544olSEltSauX1a79SnF955RUfPXp0THKPOOKIknor1KkMUF0/XVNrBNp33333xbUaNmzoTz75pN99992la6d+KYQ6btw4v+yyy0rXTMfUz759+/qsWbP8vffe84kTJ/oVV1yBURgGUGUIksugiIy27777zo866qjScUVu0iZIte+www6L1z59+sT+X3/9NV5/++23eJ07d26UPeraK1eujH3Tpk0rgXvKKaf4L7/84ps3b45rnXPOOXHO2rVryxifFtLWrVsXx5YuXVpaM0h9VnZpum/qw7x58xgdDAPYbwNIUH799ddeu3bt0vEPPvggwPr555/922+/jVXedExxfm0LFy6MCM/tt98e39cmZdY5K1asKBnQQw89VLrX7t27fcOGDV6tWjU/66yz4viaNWvCIJKhqH5A25YtW+JV4dN0b41G27dvj35pPaFx48Z+6623RrQp+3fRDBeoqgbw+++/h+KqcF37WrduHeC98847/sILL5QBO2sAckHSPqU4aHvqqafis6DWtmPHjri+FsC0UCbV/vHHH8MAzj777Djn888/L40A2r9q1aqAXzUE2ubMmVO6j9YZdu3aFUardYbs38PcwJgD/BMGoNx9bQLszDPPLKl98tO1yKVtyZIlkeZw7733+saNG2OfjumcTz/9ND7L39+5c6d/9tlnfv755we8mzZt+h8DSL8Y0b59+9j3+uuvB9BffPFFGM1pp51W6rvqC7Sp33KflGWq+QUTZMMAqgq/ANR7gSWQ1q9fH5NYuUGCWS0tWiV35qKLLorvyOVIcwB9N23PPfdcKSSZ5gBaFBswYEC8/+ijj2JEkAHI5ckaQPXq1ePamjNoUw6RPj/77LPxWZPnBLgm6HKT1K80B5CBJiNiJDCiQPszAkhhv//++/gs1df25Zdfhosj5ZaCa1O0Reco1UHb4sWLvX///r5t27b4rNEgTZaT0Zx33nmx7/333y8ZiuYAWQOQiusc+fNbt271vXv3+uzZs2OESfMAuUXJSLKAa8T44Ycfyty/onUFK3bLvQP/ulSFBKYmsNpWr14dn996661ShGXPnj1hAFJXbd98802co/webYJUn+WCaJPbkyJJy5cvL2MAijYp+qNN7pYMIE2CNQLoHBlTGll0f0WmFixYEHMGbSnUqXwizQUEutw2GYc2Jd/pOAZgGEBlBqBJpTYBpmiKNkEsBdbk8qeffoosTsXwNVJIeRNk2i/3RJti8LperVq1/JNPPol9+g2g7CQ4GYDa/fffXxoBNOktHwaVi5T6cuyxx4ark52TTJo0KdYONCLJSNR/uVTavvrqqziW/TtpxghQEQRyYT788MNQXsXZ9bs92t+2bVt/++23S1VbWVdJsX+5MT169AjXZf78+eGHZ12Rd999N2DVXELRoDfffNNPOumk0jmaXwjil19+OVT6xBNPjFFkzJgxEfvXsSlTpsT7rJIrke6NN96I9QhBLgORsaj/y5Yt81dffTV+fQ74DRfo77pHWfCrGlqsLN0he6yqyrw/965KH4zGQ8hCkE1wSwlqKVktC18WqGxym5reZ88rn5SWEtayn9N5WYPInpOukS2qL39e9t7ZY/j9VpmhYwDl1TILc2WjQflzqqq02d8FkqtTvnyyvL+u89LvBlW2movK218Z0TCALFgqVFdtrt5roqs0BymoktxSvo8ATT9prkmw/PqmTZsGqIJQKQm6nhagtHKsaJKuoXNSSoWOa7/upe+lhTatKmtRTPuOO+642NetW7dY+dV7TYhlNJoEpxVizQPSIluTJk2in2paz9Cr+pPKLGmGAVQEQXIT+vXrFzk8Aubxxx/3Z555JiatCkMKbsGmRS1lid5xxx0+cOBAv+222/zRRx/1u+66y2+88cZISBs2bFhMhEeMGOGPPfZYLHiNHDkyDEBqrhVipVIIeEWHdJ7ur+9oMq3r6f7ap+sq+1M1xWrqkya7yvHRBFv90/fVj7Fjx0Y2quqMFRodNGhQ3DdNnhklDAOoTAUFq5RVkZ0XX3wxSheVzqwwpY4LPiWwyRD0Xk1QXnjhhQH+zJkzI1tU0AlAQalyR8XmFdHRNWQMKouU8UydOtWHDh3q5557bqwuC3pFnpQfpPN0viJPup9+QU6Lcbq+7qVz9F19R2sJr732WqxDqH9KkpPRarU41RmTDGe4QJXBL/AFjMBUzr2UVGArvSGFQ6Xwei+FFWwKmwpiGY5CpcrvkTui78sdkXGodkCqLlDlNl188cWl++jaaWTQmoHy/6X4GmUEuBbPZIByzZRop3s/+OCDsU8jh66h+gKNXDIU3U8ulI6pLzJAXRfXx5gDVAUCTYAFo1wigSP/Xv55yg+Siup4KnCRO3PLLbeU1FU+t46nz+k6Ajmbj6N9KfKjYymvX+fLENP1y0d95PunSXoCW33Tfr3qWiknqKKSTZrhAlUFgn2VGmb3l4/H/1l8vqJr7E9J459FmfZ3TcFoRIH+CQgAzv7LxpR7B2g8A8cAgAAhMEYAIEAIHBcICBACYw4ABAiBMwkGAoTAiAIBAULghEGBACEw1gGAACFwFsKAACEwVoKBACFwUiGAACEwcoGAACFwkuGAACEwskGBACFw0qGBACEw6gGAACFwCmKAACEwKsKAACFwSiKBACEwaoKBwHgGFMUDgRf8GeTeARrPwDEAIEAIjBEACBACxwUCAoTAmAMAAULgTIKBACEwokBAgBA4YVAgQAiMdQAgQAichTAgQAiMlWAgQAicVAggQAiMXCAgQAicZDggQAiMbFAgQAicdGggQAiMegAgQAicghggQAiMijAgQAickkggQAiMmmAgMJ4BRfFA4AV/Brl3gMYzcAwACBACYwQAAoTAcYGAACEw5gBAgBA4k2AgQAiMKBAQIAROGBQIEAJjHQAIEAJnIQwIEAJjJRgIEAInFQIIEAIjFwgIEAInGQ4IEAIjGxQIEAInHRoIEAKjHgAIEAKnIAYIEAKjIgwIEAKnJBIIEAKjJhgIjGdAUTwQeMGfQe4doPEMHAMAAoTAGAGAACFwXCAgQAiMOQAQIATOJBgIEAIjCgQECIETBgUChMBYBwAChMBZCAMChMBYCQYChMD/zjP4A4mEgrcpa7wcAAAAAElFTkSuQmCC', 'base64');
const PWA_PNG_512 = Buffer.from('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29dNNtmknnDCCXW77bbTKfD36O9xdgyMXgFFDBgYsfHfdttt68c//vH6k5/8pO6+++5zfqeIAQNlJcdg9AooYsDASMP+u+66a73mmmtq/v3gBz+oO+ywgw6Av0d/j2VmYjB6BRQxYGCExn+33XarF198cb366qvrLbfcUm+77ba688476wD4e/T3WGYmBqNXQBEDBtZz4//whz+8vvnNb65vfetb60UXXVSvu+66+r3vfc8UgL9Ff4tlpmIwegUUMWBgPTb+G2+8cT3++OPriSeeWN/whjfU8847r1522WX1hhtu0AHwt+hvscxUDEavgCIGDKwHA31h35577lmPO+64euyxx9ZXv/rV9ayzzqrvfOc76xVXXNHWBAwfq4gBA2Ulx2D0CihiwMB6MnCnO92pHnbYYfWQQw6pL3vZy9pIwOmnn96mAi699NK2LkAHgEc5qcxKDEavgCIGDKyn4f8tttiiHnXUUa0DcMQRR9SXv/zl9eSTT65vfOMb6zve8Y42OqADwKOcVGYlBqNXQBEDBtZTB+CBD3xga/QPPfTQ1gE45phj6itf+cp66qmntrUAT33qU3UA/D36eywzE4PRK6CIAQPrqQOw9dZb11NOOaW+9KUvrUceeWQ9+uij21qAjAKcffbZdY899tAB8Pfo77HMTAxGr4AiBgyspw7ApptuWl/3ute1xX85+09JZyCXAX79619fn/a0p815vCIGDJSVHIPRK6CIAQPr0UAa+wsvvLAN/Wc3QDoBGQU47bTT6tOf/nQdAH+P/h7LzMRg9AooYsDAejDQt/Y94QlPaFv+/uAP/qBdC+AVr3hF2xGQdQA6ACzKR2WWYjB6BRQxYGA9GBgO62fB31e/+tV6zjnn1JNOOqmNBLzqVa+qe+211yqPVcSAgbJSYzB6BRQxYGCExYDXX399K29605vaKECmBPbee28dAH+P/h7LzMRg9AooYsDACFMBT3nKU9pNgK688srJwsBnP/vZOgD+Hv09zo6B0SugiAEDI3UC9t133/rtb3+7fuITn6hnnnmmDoC/RX+LZaZiMHoFFDFgYMROwG/8xm/Ub3zjG+1SwPvss0/7mTUATMpLZRZiMHoFFDFgYAQDaeR7JyBD/+kEHH744e37DTbYwGfi75KBsuJjMHoFFDFg4A7QCchiwOuuu67e7373a9+7IyCXclNZ6TEY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5Cc/aV/z7+STT26/X6yh7cfI1wsuuGBynKX+5XW+/e1v14997GPtuv25fO/0a/Vj/+qv/mr9+te/3p7X399tt91WDzzwwEXr159/1llnTerV6/b3f//3reOT32+wwQbt64Mf/OD63e9+d5XHvuIVr1h2HHL/gg996ENz4pl///3f/12f/vSnL3mc+Y6ZyyBfcskl9b/+678msZsvnv11rrvuunb745//+Z8f3akiBmX9xUCwxWD2OgA5G+yN4//8z/+0///xH//xsp6fs/y//du/nTw/DUlvZK+99tol75437AB84AMfmBynN6D5/3QZNoz932WXXdau+z9sIPuxM7KQBnt47Pz753/+53bnv+FzhqX/7E1vetPkuf29ffWrX223HR52AB70oAfVf/mXf1nlsccee+yCrzH9Whl5+cEPfjCnA9CPc+GFFy778+3H23777euNN944p1PSP+dh6XHpr/XJT36y3ulOd1r0s1PEoKysGIxeAUUM1nsH4KqrrlrtDkBvYHIW3c8ghyMA/Wvusjd8/EL1yNeLL754zll6P25v7Psxhx2E4Zn21Vdf3W7m04+3UAdg2KjmOVtsscW8dezf//Zv//ayOwAZlZh+bKYsFovBMA7nnHPOnHoO65oOyzbbbLPsY2WE4vOf/3x7bj7Xfrz5RgCmP//ldFoUMSgrKwajV0ARg9E6AMMzwD/5kz9Z8rkbbbRR/dSnPjV57nAouX//4Q9/eNEzyWEH4H3ve9+c5y71b9gx6PW+6KKLJkPXvfFKB2B4Ftz/9f9n/jvvZbqO0x2AYWfja1/72qIdgOFjl+oA9J9nCuGf/umfJs8fNtb9WK9//esXPdbwd6eddtoqHar+L1Mgea2bb765fu9735t0OPIvoxhZX7HU6yhiUFZWDEavgCIGd/gOQG8UsjDtRz/60ZzGuP+/f59559x2d6HGZKEOQG/wbrjhhnrQQQfVZz/72XW//fZrc9NvfetbWwM83QnIv//8z/9st/odNswLdQCG6xXe+MY3TurR67S+OwCnnnrqgh2g/rOMPNznPveZE7v54pmFfJnLH3Ym8i/TC1mzkdsfZ8pkq622qttuu23da6+92vu86aab6nvf+95VplEUMSgrPwajV0ARgzt0B2DYILznPe+Zc4aZzkCGqafPWt/+9rcv2JjM1wEYDp9/9KMfndMY9cen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', 'base64');
app.get('/pwa-icon-192.png', (req, res) => { res.type('image/png').set('Cache-Control','public, max-age=604800').send(PWA_PNG_192); });
app.get('/pwa-icon-512.png', (req, res) => { res.type('image/png').set('Cache-Control','public, max-age=604800').send(PWA_PNG_512); });
app.get('/apple-touch-icon.png', (req, res) => { res.type('image/png').send(PWA_PNG_192); });
app.get('/apple-touch-icon-precomposed.png', (req, res) => { res.type('image/png').send(PWA_PNG_192); });

// Service worker : cache uniquement le "shell" et les assets statiques.
// L'API (/api/...) n'est JAMAIS mise en cache (données toujours fraîches).
// La version du cache est liée au démarrage du serveur : chaque redéploiement
// génère une nouvelle version → mise à jour propre et automatique sur tous les appareils.
const SW_VERSION = 'apro-' + Date.now();
app.get('/sw.js', (req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-cache').send(`
const CACHE='${SW_VERSION}';
const SHELL=['/','/manifest.webmanifest','/pwa-icon.svg','https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/tabler-icons.min.css'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL.map(u=>new Request(u,{cache:'reload'}))).catch(()=>{})));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('message',e=>{if(e.data==='skipWaiting')self.skipWaiting();});
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET'){return;}
  const url=new URL(req.url);
  // Ne jamais mettre l'API en cache : réseau direct.
  if(url.pathname.startsWith('/api/')){return;}
  // Navigation (HTML) : réseau d'abord, repli sur le cache si hors-ligne.
  if(req.mode==='navigate'){
    e.respondWith(fetch(req).then(r=>{const cp=r.clone();caches.open(CACHE).then(c=>c.put('/',cp)).catch(()=>{});return r;}).catch(()=>caches.match('/')));
    return;
  }
  // Autres assets (icônes, CSS CDN) : stale-while-revalidate.
  e.respondWith(caches.match(req).then(cached=>{
    const net=fetch(req).then(r=>{const cp=r.clone();caches.open(CACHE).then(c=>c.put(req,cp)).catch(()=>{});return r;}).catch(()=>cached);
    return cached||net;
  }));
});
// ── PUSH : afficher la notification reçue ──
self.addEventListener('push',e=>{
  let d={};try{d=e.data?e.data.json():{};}catch(_){d={};}
  const title=d.title||'AppROVISIO';
  const opts={
    body:d.body||'',
    icon:'/pwa-icon-192.png',
    badge:'/pwa-icon-192.png',
    data:{approId:d.approId||null,type:d.type||''},
    tag:d.approId?('appro-'+d.approId):undefined,
    renotify:!!d.approId
  };
  e.waitUntil(self.registration.showNotification(title,opts));
});
// ── Clic sur la notification : ouvrir l'app (et l'appro visée si présente) ──
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const approId=e.notification.data&&e.notification.data.approId;
  const target=approId?('/?appro='+approId):'/';
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const c of list){ if('focus' in c){ c.navigate(target).catch(()=>{}); return c.focus(); } }
    if(clients.openWindow) return clients.openWindow(target);
  }));
});
`);
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
