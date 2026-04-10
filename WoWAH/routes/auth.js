const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const db = require('../db');

async function sendVerificationEmail(email, token, port) {
  const verifyUrl = `https://localhost:${port}/api/auth/verify/${token}`;

  if (process.env.SMTP_HOST) {
    console.log(`[Auth] Sending verification email to ${email} via SMTP (${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587})`);
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || 'noreply@wowah.local',
      to: email,
      subject: 'Verify your WoW AH account',
      text: `Click to verify your account: ${verifyUrl}`,
      html: `<p>Click the link to verify your account:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`,
    });
    console.log(`[Auth] Verification email sent to ${email}`);
  } else {
    console.log(`\n[Auth] No SMTP configured — click this link to verify ${email}:\n  ${verifyUrl}\n`);
  }
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password } = req.body;
  console.log(`[Auth] Register attempt: ${email}`);

  if (!email || !password) {
    console.log(`[Auth] Register rejected: missing email or password`);
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (password.length < 6) {
    console.log(`[Auth] Register rejected for ${email}: password too short`);
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    const password_hash = await bcrypt.hash(password, 12);
    const verification_token = uuidv4();

    db.prepare(`
      INSERT INTO users (email, password_hash, verification_token)
      VALUES (?, ?, ?)
    `).run(email, password_hash, verification_token);

    console.log(`[Auth] User registered: ${email} — sending verification email`);
    const port = process.env.PORT || 3000;
    await sendVerificationEmail(email, verification_token, port);

    console.log(`[Auth] Registration complete for ${email}`);
    res.json({ message: 'Registration successful. Check your email (or the server console) for the verification link.' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      console.log(`[Auth] Register rejected for ${email}: email already exists`);
      return res.status(400).json({ error: 'This email is already registered.' });
    }
    console.error(`[Auth] Register error for ${email}:`, err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// GET /api/auth/verify/:token
router.get('/verify/:token', (req, res) => {
  const token = req.params.token;
  console.log(`[Auth] Email verification attempt, token: ${token.substring(0, 8)}…`);

  const user = db.prepare('SELECT id, email FROM users WHERE verification_token = ?').get(token);
  if (!user) {
    console.log(`[Auth] Verification failed: token not found`);
    return res.status(400).send('Invalid or expired verification link.');
  }

  db.prepare('UPDATE users SET is_verified = 1, verification_token = NULL WHERE id = ?').run(user.id);
  console.log(`[Auth] Email verified for user ${user.id} (${user.email})`);
  res.redirect('/login.html?verified=1');
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  console.log(`[Auth] Login attempt: ${email}`);

  if (!email || !password) {
    console.log(`[Auth] Login rejected: missing email or password`);
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    console.log(`[Auth] Login failed for ${email}: user not found`);
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    console.log(`[Auth] Login failed for ${email}: wrong password`);
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  if (!user.is_verified) {
    console.log(`[Auth] Login rejected for ${email}: email not verified`);
    return res.status(403).json({ error: 'Please verify your email before logging in.' });
  }

  req.session.userId = user.id;
  req.session.email = user.email;
  console.log(`[Auth] Login successful: user ${user.id} (${email}), session ${req.session.id}`);
  res.json({ message: 'Logged in successfully.' });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  const userId = req.session.userId;
  const email  = req.session.email;
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    console.log(`[Auth] Logged out: user ${userId} (${email})`);
    res.json({ message: 'Logged out.' });
  });
});

// GET /api/auth/me  — returns current session user info
router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare('SELECT id, email, is_verified, blizzard_access_token FROM users WHERE id = ?').get(req.session.userId);
  res.json(user);
});

module.exports = router;
