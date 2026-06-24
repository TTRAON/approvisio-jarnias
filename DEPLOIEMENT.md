# 🚀 Guide de déploiement — AppROVISIO JARNIAS

Ce guide vous accompagne pas à pas pour mettre votre application en ligne.
Comptez environ **20 minutes**. Aucune compétence technique requise.

---

## Ce dont vous avez besoin

- Un compte **GitHub** (gratuit) — pour stocker le code
- Un compte **Railway** (gratuit au départ) — pour héberger l'application

---

## ÉTAPE 1 — Créer un compte GitHub

1. Allez sur **https://github.com**
2. Cliquez sur **Sign up** (s'inscrire)
3. Suivez les étapes (email, mot de passe, nom d'utilisateur)
4. Validez votre adresse email

---

## ÉTAPE 2 — Mettre le code sur GitHub

1. Une fois connecté, cliquez sur le bouton vert **New** (ou le **+** en haut à droite → *New repository*)
2. Donnez un nom : `approvisio-jarnias`
3. Laissez sur **Public**
4. Cliquez **Create repository**
5. Sur la page suivante, cliquez sur le lien **uploading an existing file**
6. **Glissez-déposez** tout le contenu du dossier (sauf `node_modules` s'il existe) :
   - le dossier `public` (avec `index.html` dedans)
   - `server.js`
   - `package.json`
   - `.gitignore`
   - `.env.example`
   - `DEPLOIEMENT.md`
7. En bas, cliquez **Commit changes**

> 💡 Ne mettez **jamais** le fichier `.env` en ligne (il contient vos secrets). Le `.gitignore` l'exclut automatiquement.

---

## ÉTAPE 3 — Créer un compte Railway

1. Allez sur **https://railway.app**
2. Cliquez **Login** puis **Login with GitHub**
3. Autorisez Railway à accéder à votre compte GitHub

---

## ÉTAPE 4 — Déployer l'application

1. Sur Railway, cliquez **New Project**
2. Choisissez **Deploy from GitHub repo**
3. Sélectionnez votre dépôt **approvisio-jarnias**
4. Railway détecte automatiquement que c'est une application Node.js et lance le déploiement

---

## ÉTAPE 5 — Ajouter la base de données

1. Dans votre projet Railway, cliquez sur **+ Create** (ou **+ New**)
2. Choisissez **Database** → **Add PostgreSQL**
3. Railway crée la base de données. La variable `DATABASE_URL` est créée automatiquement.

---

## ÉTAPE 6 — Configurer les variables secrètes

1. Cliquez sur votre **service applicatif** (la carte avec le nom de votre dépôt, pas la base de données)
2. Allez dans l'onglet **Variables**
3. Vérifiez que **DATABASE_URL** est bien là (sinon, cliquez *New Variable* → *Add Reference* → choisissez la base Postgres)
4. Ajoutez ces deux variables (bouton **New Variable**) :

   | Nom | Valeur |
   |-----|--------|
   | `JWT_SECRET` | une longue phrase secrète de votre choix, ex : `JarniasHauteur2026SecretXYZ` |
   | `ADMIN_CODE` | le code pour créer votre compte admin, ex : `JARNIAS-ADMIN-2026` |

5. Railway redéploie automatiquement.

---

## ÉTAPE 7 — Obtenir votre adresse web

1. Cliquez sur votre service applicatif
2. Onglet **Settings** → section **Networking** (ou **Domains**)
3. Cliquez **Generate Domain**
4. Railway vous donne une adresse du type :
   **`https://approvisio-jarnias-production.up.railway.app`**

**C'est cette adresse que vous partagez à toute votre équipe !** 🎉

---

## ÉTAPE 8 — Créer votre compte administrateur

1. Ouvrez votre adresse web
2. Cliquez sur l'onglet **Inscription**
3. Remplissez :
   - Votre nom complet
   - Un identifiant (ex : `tanguy`)
   - Un mot de passe
   - Dans **Code d'invitation**, mettez votre `ADMIN_CODE` (ex : `JARNIAS-ADMIN-2026`)
4. Cliquez **Créer mon compte**

Vous êtes maintenant **administrateur** ! 🛡️

> ⚠️ Le code admin de démarrage ne fonctionne **qu'une seule fois**. Après, seuls les codes d'invitation que vous générez fonctionnent.

---

## ÉTAPE 9 — Inviter votre équipe

1. Connecté en admin, cliquez sur **Administration** (dans la barre de gauche)
2. Cliquez sur le bouton du rôle voulu : **Conducteur**, **Chef dépôt** ou **Admin**
3. Un code unique est généré (ex : `CON-A1B2C3`)
4. Cliquez sur l'icône **copier** et envoyez ce code à la personne (SMS, mail, oral...)
5. La personne va sur l'adresse web → **Inscription** → entre ses infos + le code
6. Le code est alors **consommé** (utilisable une seule fois)

Chaque personne aura automatiquement l'interface correspondant à son rôle.

---

## 💰 À propos des coûts

- Railway offre un **crédit gratuit** pour démarrer
- Pour une petite équipe, l'usage reste faible
- Si besoin de garantir le fonctionnement continu : le plan **Hobby à 5$/mois** suffit largement

---

## 🆘 En cas de souci

Si quelque chose ne fonctionne pas :
1. Sur Railway, cliquez sur votre service → onglet **Deployments** → regardez les **logs** (messages d'erreur)
2. Vérifiez que les 3 variables (`DATABASE_URL`, `JWT_SECRET`, `ADMIN_CODE`) sont bien présentes
3. Revenez vers Claude avec le message d'erreur, on résoudra ensemble

---

## 🔄 Pour mettre à jour l'application plus tard

Quand on améliore l'affichage (sur la version locale), il suffira de :
1. Remplacer le fichier `public/index.html` sur GitHub par la nouvelle version
2. Railway redéploie automatiquement en quelques secondes

C'est tout ! Vos données (comptes, appros) sont dans la base PostgreSQL et ne sont jamais touchées par les mises à jour de l'affichage.
