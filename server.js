const express  = require('express');
const { Pool } = require('pg');
const cors     = require('cors');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3002;

// ── Email (Resend HTTP API) — optional; only active once RESEND_API_KEY is set ──
// Uses Node's built-in fetch (Node 22+), so there's no extra dependency to install.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM     = process.env.EMAIL_FROM || 'Blaine Moncrief Campaign <rsvp@voteforblaine.com>';
const emailEnabled   = !!RESEND_API_KEY;
if (emailEnabled) console.log('[email] Resend enabled, sending from', EMAIL_FROM);
else console.log('[email] Resend not configured (set RESEND_API_KEY to enable confirmation emails)');

const PASSWORDS = {
  admin:     process.env.ADMIN_PASSWORD     || 'blaine2026',  // campaign staff — full view
  candidate: process.env.CANDIDATE_PASSWORD || 'judge2026'    // Blaine — no donation info
};

// ── Database (PostgreSQL) ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Convert SQLite ? placeholders → $1,$2,… and auto-add RETURNING id on INSERTs
function toPostgres(sql) {
  let i = 0;
  let s = sql.replace(/\?/g, () => `$${++i}`);
  if (/^\s*INSERT/i.test(s) && !/RETURNING/i.test(s))
    s = s.trimEnd().replace(/;?\s*$/, '') + ' RETURNING id';
  return s;
}
async function dbRun(sql, params = []) {
  const r = await pool.query(toPostgres(sql), params);
  return { changes: r.rowCount, lastInsertRowid: r.rows[0]?.id };
}
async function dbGet(sql, params = []) {
  const r = await pool.query(toPostgres(sql), params);
  return r.rows[0];
}
async function dbAll(sql, params = []) {
  const r = await pool.query(toPostgres(sql), params);
  return r.rows;
}

// ── Confirmation email ────────────────────────────────────────────────
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Fire-and-forget: sends an RSVP confirmation. Never throws to the caller.
async function sendRsvpConfirmation(opts) {
  if (!emailEnabled) return;
  const firstName  = (opts.firstName || '').trim();
  const email      = (opts.email || '').trim();
  const eventTitle = (opts.eventTitle || '').trim();
  if (!email) return;

  // Look up event details (date/time/location) by title
  let ev = null;
  if (eventTitle) {
    try { ev = await dbGet('SELECT * FROM events WHERE LOWER(title)=LOWER(?)', [eventTitle]); } catch (e) {}
  }

  const bits = [];
  if (ev) {
    if (ev.date) {
      const p = String(ev.date).split('-');
      if (p.length === 3) {
        const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        bits.push(months[parseInt(p[1], 10) - 1] + ' ' + parseInt(p[2], 10) + ', ' + p[0]);
      }
    }
    if (ev.time && ev.end_time) bits.push(ev.time + ' – ' + ev.end_time);
    else if (ev.time)           bits.push(ev.time);
    if (ev.location) bits.push(ev.location);
  }
  const detailLine = bits.join('  ·  ');
  const eventName  = (ev && ev.title) || eventTitle || '';
  const greeting   = firstName ? ('Hi ' + firstName + ',') : 'Hi there,';
  const subject    = eventName ? ('You\'re confirmed for ' + eventName) : 'Thanks for your RSVP';

  const html =
    '<div style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;">' +
      '<div style="max-width:520px;margin:0 auto;padding:32px 16px;">' +
        '<div style="background:#09254f;border-radius:12px 12px 0 0;padding:36px 32px 28px;text-align:center;">' +
          '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#78E0C4;font-weight:bold;margin-bottom:12px;">You&rsquo;re Confirmed</div>' +
          (eventName ? '<div style="font-size:26px;font-weight:bold;color:#ffffff;line-height:1.25;' + (detailLine ? 'margin-bottom:10px;' : '') + '">' + escHtml(eventName) + '</div>' : '') +
          (detailLine ? '<div style="font-size:14px;color:#78E0C4;font-weight:bold;">' + escHtml(detailLine) + '</div>' : '') +
        '</div>' +
        '<div style="background:#ffffff;border-radius:0 0 12px 12px;padding:32px;">' +
          '<p style="font-size:16px;color:#09254f;margin:0 0 16px;">' + escHtml(greeting) + '</p>' +
          '<p style="font-size:15px;color:#3a4a63;line-height:1.6;margin:0 0 16px;">Thank you for your RSVP' + (eventName ? ' to <strong>' + escHtml(eventName) + '</strong>' : '') + '. We look forward to seeing you' + (detailLine ? ' on <strong>' + escHtml(detailLine) + '</strong>' : '') + '.</p>' +
          '<p style="font-size:15px;color:#3a4a63;line-height:1.6;margin:0;">We&rsquo;re grateful for your support.</p>' +
        '</div>' +
        '<p style="font-size:12px;color:#9aa7b8;text-align:center;margin:20px 0 0;line-height:1.5;">Your information is kept private and used only for campaign communications.</p>' +
      '</div>' +
    '</div>';

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: EMAIL_FROM, to: email, subject: subject, html: html })
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(function(){ return ''; });
    throw new Error('Resend API ' + resp.status + ': ' + txt.slice(0, 200));
  }
}

// ── Schema bootstrap ──────────────────────────────────────────────────
const TS = `to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')`;
(async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rsvps (
    id SERIAL PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT ${TS},
    first_name TEXT, last_name TEXT, email TEXT, phone TEXT,
    address TEXT, city TEXT, state TEXT, zip TEXT, parish TEXT,
    guests TEXT, guest_names TEXT, how_to_help TEXT,
    yard_sign TEXT, yard_sign_delivered TEXT, endorse TEXT,
    comment TEXT, event TEXT, role TEXT, pipeline_stage TEXT,
    volunteer_role TEXT, volunteer_hours INTEGER DEFAULT 0,
    volunteer_status TEXT DEFAULT 'new'
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS endorsements (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, org TEXT,
    tier TEXT DEFAULT 'individual', status TEXT DEFAULT 'not_contacted',
    notes TEXT, date TEXT, contact_id INTEGER,
    created_at TEXT DEFAULT ${TS}
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY, title TEXT NOT NULL,
    date TEXT, time TEXT, end_time TEXT, location TEXT,
    description TEXT, capacity INTEGER, status TEXT DEFAULT 'active',
    fields TEXT, created_at TEXT DEFAULT ${TS}
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS walk_lists (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL,
    area TEXT, assigned_to TEXT, created_at TEXT DEFAULT ${TS}
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS walk_doors (
    id SERIAL PRIMARY KEY, list_id INTEGER NOT NULL,
    address TEXT, voter_name TEXT, result TEXT DEFAULT 'pending',
    volunteer TEXT, notes TEXT, knocked_at TEXT,
    created_at TEXT DEFAULT ${TS}
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS donations (
    id SERIAL PRIMARY KEY, donor_name TEXT, amount REAL,
    date TEXT, source TEXT, contact_id INTEGER, email TEXT,
    anedot_id TEXT, tender_type TEXT, check_number TEXT,
    created_at TEXT DEFAULT ${TS}
  )`);
  await pool.query(`UPDATE rsvps SET role='Voter' WHERE role IS NULL OR role=''`);
  const upRows = await dbAll("SELECT id, zip FROM rsvps WHERE zip IS NOT NULL AND zip != '' AND (parish IS NULL OR parish='')");
  for (const r of upRows) { if (BP[r.zip]) await dbRun('UPDATE rsvps SET parish=? WHERE id=?', [BP[r.zip], r.id]); }
  // Add company column if missing (idempotent migration)
  await pool.query(`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS company TEXT`);
  console.log('[DB] PostgreSQL ready');
})().catch(e => console.error('[DB] Setup error:', e.message));

// ── Parish lookup (module-scoped so routes can use it) ─────────────────
const BP = {"70001":"Jefferson","70002":"Jefferson","70003":"Jefferson","70004":"Jefferson","70005":"Jefferson","70006":"Jefferson","70009":"Jefferson","70010":"Jefferson","70011":"Jefferson","70031":"Jefferson","70033":"Jefferson","70036":"Jefferson","70037":"Jefferson","70047":"Jefferson","70053":"Jefferson","70055":"Jefferson","70056":"Jefferson","70057":"Jefferson","70058":"Jefferson","70059":"Jefferson","70060":"Jefferson","70062":"Jefferson","70063":"Jefferson","70064":"Jefferson","70065":"Jefferson","70067":"Jefferson","70072":"Jefferson","70073":"Jefferson","70094":"Jefferson","70112":"Orleans","70113":"Orleans","70114":"Orleans","70115":"Orleans","70116":"Orleans","70117":"Orleans","70118":"Orleans","70119":"Orleans","70121":"Orleans","70122":"Orleans","70123":"Orleans","70124":"Orleans","70125":"Orleans","70126":"Orleans","70127":"Orleans","70128":"Orleans","70129":"Orleans","70130":"Orleans","70131":"Orleans","70163":"Orleans","70032":"St. Bernard","70043":"St. Bernard","70044":"St. Bernard","70085":"St. Bernard","70086":"St. Bernard","70092":"St. Bernard","70040":"Plaquemines","70041":"Plaquemines","70050":"Plaquemines","70068":"Plaquemines","70069":"Plaquemines","70070":"Plaquemines","70071":"Plaquemines","70074":"Plaquemines","70075":"Plaquemines","70076":"Plaquemines","70082":"Plaquemines","70083":"Plaquemines","70084":"Plaquemines","70090":"Plaquemines","70030":"St. Charles","70039":"St. Charles","70052":"St. Charles","70079":"St. Charles","70087":"St. Charles","70433":"St. Tammany","70434":"St. Tammany","70435":"St. Tammany","70437":"St. Tammany","70444":"St. Tammany","70445":"St. Tammany","70446":"St. Tammany","70447":"St. Tammany","70448":"St. Tammany","70450":"St. Tammany","70452":"St. Tammany","70455":"St. Tammany","70456":"St. Tammany","70458":"St. Tammany","70459":"St. Tammany","70460":"St. Tammany","70461":"St. Tammany","70464":"St. Tammany","70466":"St. Tammany","70471":"St. Tammany","70401":"Tangipahoa","70402":"Tangipahoa","70403":"Tangipahoa","70404":"Tangipahoa","70420":"Tangipahoa","70422":"Tangipahoa","70426":"Tangipahoa","70427":"Tangipahoa","70428":"Tangipahoa","70429":"Tangipahoa","70430":"Tangipahoa","70436":"Tangipahoa","70443":"Tangipahoa","70451":"Tangipahoa","70454":"Tangipahoa","70463":"Tangipahoa","70301":"Terrebonne","70302":"Terrebonne","70310":"Terrebonne","70352":"Terrebonne","70355":"Terrebonne","70356":"Terrebonne","70359":"Terrebonne","70360":"Terrebonne","70361":"Terrebonne","70363":"Terrebonne","70364":"Terrebonne","70380":"Terrebonne","70340":"Lafourche","70341":"Lafourche","70343":"Lafourche","70344":"Lafourche","70345":"Lafourche","70346":"Lafourche","70353":"Lafourche","70354":"Lafourche","70357":"Lafourche","70358":"Lafourche","70373":"Lafourche","70374":"Lafourche","70377":"Lafourche","70501":"Lafayette","70503":"Lafayette","70504":"Lafayette","70505":"Lafayette","70506":"Lafayette","70507":"Lafayette","70508":"Lafayette","70509":"Lafayette"};

// ── Middleware ────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Mockups preview pages ─────────────────────────────────────────────
app.get('/mockups', (req, res) => {
  res.sendFile(path.join(__dirname, 'mockups.html'));
});
app.get('/mockups/canvassing', (req, res) => {
  res.sendFile(path.join(__dirname, 'mockup-canvassing.html'));
});

// ── Mobile field canvassing app ───────────────────────────────────────
app.get('/canvass', (req, res) => {
  res.sendFile(path.join(__dirname, 'canvass.html'));
});

// Prevent browser caching on all admin HTML pages
app.use('/admin', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// ── RSVP submission ───────────────────────────────────────────────────
app.post('/rsvp', async (req, res) => {
  const { firstName, lastName, email, phone, address, city, state, zip, parish,
          guests, guestNames, howToHelp, yardSign, endorse, comment, event } = req.body;
  try {
    await dbRun(`
      INSERT INTO rsvps
        (first_name, last_name, email, phone, address, city, state, zip, parish, guests, guest_names, how_to_help, yard_sign, endorse, comment, event)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [firstName, lastName, email, phone, address, city, state, zip, parish, guests, guestNames, howToHelp, yardSign, endorse, comment, event]);
    res.json({ result: 'success' });
    // Send confirmation email — fire-and-forget; never blocks or fails the RSVP
    if (emailEnabled && email) {
      sendRsvpConfirmation({ firstName, email, eventTitle: event })
        .catch(err => console.error('[email] confirmation failed:', err.message));
    }
  } catch (err) {
    console.error('DB error:', err.message);
    res.status(500).json({ result: 'error' });
  }
});

// ── Yard sign delivery toggle ─────────────────────────────────────────
app.patch('/rsvp/:id/sign', async (req, res) => {
  const { delivered } = req.body;
  try {
    await dbRun('UPDATE rsvps SET yard_sign_delivered=? WHERE id=?',
      [delivered ? 'Yes' : null, req.params.id]);
    res.json({ result: 'success' });
  } catch(err) {
    res.status(500).json({ result: 'error' });
  }
});

app.patch('/rsvp/:id/role', async (req, res) => {
  const { role } = req.body;
  try {
    await dbRun('UPDATE rsvps SET role=? WHERE id=?', [role, req.params.id]);
    res.json({ result: 'success' });
  } catch(err) {
    res.status(500).json({ result: 'error' });
  }
});

app.patch('/rsvp/:id/pipeline', async (req, res) => {
  const { pipeline_stage } = req.body;
  try {
    await dbRun('UPDATE rsvps SET pipeline_stage=? WHERE id=?', [pipeline_stage, req.params.id]);
    res.json({ result: 'success' });
  } catch(err) {
    res.status(500).json({ result: 'error' });
  }
});

app.patch('/rsvp/:id/endorse', async (req, res) => {
  const { endorsed } = req.body;
  try {
    await dbRun('UPDATE rsvps SET endorse=? WHERE id=?',
      [endorsed ? 'Yes' : 'No', req.params.id]);
    res.json({ result: 'success' });
  } catch(err) {
    res.status(500).json({ result: 'error' });
  }
});

// ── Manual constituent add ────────────────────────────────────────────
app.post('/admin/constituent', async (req, res) => {
  const { first_name, last_name, email, phone, address, city, state, zip, how_to_help, yard_sign, endorse, comment, role, company } = req.body;
  const parish = BP[zip] || '';
  try {
    await dbRun(`
      INSERT INTO rsvps (first_name, last_name, email, phone, address, city, state, zip, parish, how_to_help, yard_sign, endorse, comment, role, event, company)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [first_name||'', last_name||'', email||'', phone||'', address||'', city||'', state||'', zip||'', parish,
        how_to_help||'', yard_sign||'No', endorse||'No', comment||'', role||'Voter', 'Manual Entry', company||'']);
    res.json({ result: 'success' });
  } catch(err) {
    console.error('[constituent POST] DB error:', err.message, err.code);
    res.status(500).json({ result: 'error' });
  }
});

// ── Cookie-based auth ────────────────────────────────────────────────
const crypto = require('crypto');
const ADMIN_TOKEN = 'adm_' + crypto.createHash('sha256').update(PASSWORDS.admin).digest('hex').slice(0,32);
const CAND_TOKEN  = 'cnd_' + crypto.createHash('sha256').update(PASSWORDS.candidate).digest('hex').slice(0,32);

function parseCookies(str) {
  const out = {};
  (str || '').split(';').forEach(c => {
    const eq = c.indexOf('=');
    if (eq > 0) out[c.slice(0, eq).trim()] = decodeURIComponent(c.slice(eq + 1).trim());
  });
  return out;
}

function tokenRole(req) {
  const tok = parseCookies(req.headers.cookie)['vfb_session'];
  if (tok === ADMIN_TOKEN) return 'admin';
  if (tok === CAND_TOKEN)  return 'candidate';
  return null;
}

// Any signed-in user (admin OR candidate). Sets req.userRole so handlers
// can branch (e.g. the candidate gets the donation-free view). Financial
// routes use adminOnly instead, so the candidate is blocked there.
function auth(role) {
  return (req, res, next) => {
    const who = tokenRole(req);
    if (who) { req.userRole = who; return next(); }
    const next_ = encodeURIComponent(req.originalUrl);
    res.redirect(`/login?role=${role}&next=${next_}`);
  };
}

// Admin-only — blocks the candidate from all financial data. Also closes a
// pre-existing gap where several donation endpoints had no auth at all.
function adminOnly(req, res, next) {
  const who = tokenRole(req);
  if (who === 'admin') { req.userRole = who; return next(); }
  if (who === 'candidate') return res.status(403).json({ error: 'forbidden' });
  res.redirect(`/login?role=admin&next=${encodeURIComponent(req.originalUrl)}`);
}

// ── Login page ────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  const role = req.query.role || 'admin';
  const next = req.query.next || (role === 'candidate' ? '/candidate' : '/admin');
  const err  = req.query.err  || '';
  const label = role === 'candidate' ? 'Candidate View' : 'Campaign Admin';
  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign In — Vote For Blaine</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F5F7FA;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;}
  .card{background:#fff;border:1px solid #E2E8F0;border-radius:8px;padding:40px 36px;width:100%;max-width:380px;box-shadow:0 4px 24px rgba(14,53,108,.08);}
  .logo{font-size:11px;font-weight:900;letter-spacing:2.5px;color:#3CB99B;text-transform:uppercase;margin-bottom:4px;}
  .view{font-size:9px;color:#64748B;letter-spacing:2px;text-transform:uppercase;font-weight:600;margin-bottom:28px;}
  h1{font-size:22px;font-weight:800;color:#0E356C;margin-bottom:24px;}
  label{font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#64748B;display:block;margin-bottom:6px;}
  input{width:100%;padding:13px 15px;font-size:16px;border:1.5px solid #E2E8F0;border-radius:6px;outline:none;font-family:inherit;color:#1E293B;transition:border-color .15s;}
  input:focus{border-color:#3CB99B;}
  .err{font-size:11px;color:#DC2626;background:#FEF2F2;border:1px solid #FECACA;border-radius:4px;padding:9px 12px;margin-bottom:16px;display:${err ? 'block' : 'none'};}
  button{width:100%;margin-top:20px;padding:14px;font-size:13px;font-weight:800;letter-spacing:1px;text-transform:uppercase;background:#0E356C;color:#fff;border:none;border-radius:6px;cursor:pointer;}
  button:active{background:#1a4a8a;}
</style></head><body>
<div class="card">
  <div class="logo">Vote For Blaine</div>
  <div class="view">${label}</div>
  <h1>Sign In</h1>
  <div class="err">Incorrect password — try again.</div>
  <form method="POST" action="/login">
    <input type="hidden" name="role" value="${role}">
    <input type="hidden" name="next" value="${next}">
    <label for="pw">Password</label>
    <input id="pw" name="password" type="password" placeholder="Enter password" autofocus autocomplete="current-password">
    <button type="submit">Continue →</button>
  </form>
</div>
</body></html>`);
});

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const { role, next, password } = req.body;
  const dest = (next && next.startsWith('/')) ? next : (role === 'candidate' ? '/candidate' : '/admin');
  if (role === 'admin' && password === PASSWORDS.admin) {
    res.setHeader('Set-Cookie', `vfb_session=${ADMIN_TOKEN}; Path=/; HttpOnly; SameSite=Strict`);
    return res.redirect(dest);
  }
  if (role === 'candidate' && password === PASSWORDS.candidate) {
    res.setHeader('Set-Cookie', `vfb_session=${CAND_TOKEN}; Path=/; HttpOnly; SameSite=Strict`);
    return res.redirect(dest);
  }
  const errNext = encodeURIComponent(dest);
  res.redirect(`/login?role=${role || 'admin'}&next=${errNext}&err=1`);
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'vfb_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  res.redirect('/login');
});

// ── Export helpers ────────────────────────────────────────────────────
const esc = v => `"${(v || '').toString().replace(/"/g, '""')}"`;

function makeContactsCsv(rows) {
  const hdrs = ['ID','Date','First Name','Last Name','Email','Phone','Address','City','State','Zip','Parish','How to Help','Yard Sign','Endorse','Comment','Event','Pipeline Stage'];
  return [hdrs.join(','), ...rows.map(r => [
    r.id, esc(r.created_at), esc(r.first_name), esc(r.last_name),
    esc(r.email), esc(r.phone), esc(r.address), esc(r.city), esc(r.state), esc(r.zip), esc(r.parish),
    esc(r.how_to_help), esc(r.yard_sign), esc(r.endorse), esc(r.comment), esc(r.event), esc(r.pipeline_stage)
  ].join(','))].join('\n');
}

function makeVolunteersCsv(rows) {
  const hdrs = ['ID','First Name','Last Name','Email','Phone','Role','Hours','Status'];
  return [hdrs.join(','), ...rows.map(r => [
    r.id, esc(r.first_name), esc(r.last_name), esc(r.email), esc(r.phone),
    esc(r.volunteer_role), r.volunteer_hours||0, esc(r.volunteer_status)
  ].join(','))].join('\n');
}
function makeDonorsCsv(rows) {
  const hdrs = ['ID','Date','Donor Name','Amount','Source','Tender Type','Check Number'];
  return [hdrs.join(','), ...rows.map(r => [
    r.id, esc(r.date), esc(r.donor_name), r.amount || 0, esc(r.source),
    esc(r.tender_type), esc(r.check_number)
  ].join(','))].join('\n');
}

function makePipelineCsv(rows) {
  const hdrs = ['Name','Email','Phone','Zip','City','Stage','Yard Sign','Endorses'];
  return [hdrs.join(','), ...rows.map(r => [
    esc((r.first_name||'') + ' ' + (r.last_name||'')), esc(r.email), esc(r.phone),
    esc(r.zip), esc(r.city), esc(r.pipeline_stage||'new'), esc(r.yard_sign), esc(r.endorse)
  ].join(','))].join('\n');
}

function makeEventRegsCsv(rows) {
  const hdrs = ['Date','First Name','Last Name','Email','Phone','Event','Guests','Parish','Yard Sign','How to Help','Comment'];
  return [hdrs.join(','), ...rows.map(r => [
    esc(r.created_at), esc(r.first_name), esc(r.last_name), esc(r.email), esc(r.phone),
    esc(r.event), r.guests || 1, esc(r.parish), esc(r.yard_sign), esc(r.how_to_help), esc(r.comment)
  ].join(','))].join('\n');
}

// Contacts CSV
app.get('/admin/export.csv', auth('admin'), async (req, res) => {
  const rows = await dbAll('SELECT * FROM rsvps ORDER BY created_at DESC');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="contacts.csv"');
  res.send(makeContactsCsv(rows));
});

// Donors CSV — admin only (contains donation data)
app.get('/admin/export/donors.csv', adminOnly, async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM donations ORDER BY date DESC');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="donors.csv"');
    res.send(makeDonorsCsv(rows));
  } catch(e) { res.status(500).send('Error'); }
});

// Pipeline CSV
app.get('/admin/export/pipeline.csv', auth('admin'), async (req, res) => {
  const rows = await dbAll('SELECT * FROM rsvps ORDER BY last_name, first_name');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="pipeline.csv"');
  res.send(makePipelineCsv(rows));
});

// Endorsers CSV
app.get('/admin/export/endorsers.csv', auth('admin'), async (req, res) => {
  const rows = await dbAll("SELECT * FROM rsvps WHERE endorse='Yes' ORDER BY last_name, first_name");
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="endorsers.csv"');
  res.send(makeContactsCsv(rows));
});

// Volunteers CSV
app.get('/admin/export/volunteers.csv', auth('admin'), async (req, res) => {
  const rows = await dbAll(`SELECT * FROM rsvps WHERE volunteer_role IS NOT NULL AND volunteer_role != '' ORDER BY last_name, first_name`);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="volunteers.csv"');
  res.send(makeVolunteersCsv(rows));
});

// Event registrations CSV — all event RSVPs, or one event via ?event=Title
app.get('/admin/export/event-registrations.csv', auth('admin'), async (req, res) => {
  const ev = (req.query.event || '').trim();
  const rows = ev
    ? await dbAll("SELECT * FROM rsvps WHERE LOWER(event)=LOWER(?) ORDER BY created_at DESC", [ev])
    : await dbAll("SELECT * FROM rsvps WHERE event IS NOT NULL AND event != '' ORDER BY created_at DESC");
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="event-registrations.csv"');
  res.send(makeEventRegsCsv(rows));
});

// ── Admin data (full) ─────────────────────────────────────────────────
app.get('/admin/data', auth('admin'), async (req, res) => {
  res.json(await dbAll('SELECT * FROM rsvps ORDER BY created_at DESC'));
});

// ── Contact search (typeahead) ─────────────────────────────────────────
app.get('/admin/contacts/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json([]);
  const like = '%' + q + '%';
  const rows = await dbAll(
    `SELECT id, first_name, last_name, email FROM rsvps
     WHERE first_name LIKE ? OR last_name LIKE ? OR email LIKE ?
     LIMIT 8`,
    [like, like, like]
  );
  res.json(rows);
});

// ── Candidate data (no how_to_help) ──────────────────────────────────
app.get('/candidate/data', auth('candidate'), async (req, res) => {
  const rows = await dbAll(
    'SELECT id, created_at, first_name, last_name, guests, yard_sign FROM rsvps ORDER BY created_at DESC'
  );
  res.json(rows);
});

// Per-contact donation history — admin only (used by the constituent profile).
// Renamed from /candidate/* and locked to admin so the candidate can't reach it.
app.get('/admin/contact-donations/:id', adminOnly, async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM donations WHERE contact_id=? ORDER BY date DESC', [req.params.id]);
    res.json(rows);
  } catch(e) { res.json([]); }
});

// ── Widget preview (standalone full-page render for admin preview) ─────
app.get('/widget-preview/:id', auth('admin'), async (req, res) => {
  try {
    const evt = await dbGet("SELECT * FROM events WHERE id=?", [req.params.id]);
    if (!evt) return res.status(404).send('Event not found');
    const fields = evt.fields ? JSON.parse(evt.fields) : null;
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const base  = process.env.PUBLIC_URL || (proto + '://' + req.get('host'));
    const widgetHtml = generateWidget(evt.title, evt.date, evt.time, evt.location, fields, evt.end_time, base);
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Widget Preview — ${evt.title}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #f0f2f5; min-height: 100vh; }
  .preview-banner {
    background: #09254f; border-bottom: 2px solid #78E0C4;
    padding: 10px 24px; display: flex; align-items: center; justify-content: space-between;
    font-family: 'Montserrat', sans-serif; position: sticky; top: 0; z-index: 100;
  }
  .preview-banner-label {
    font-size: 10px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase;
    color: #78E0C4;
  }
  .preview-banner-close {
    font-size: 11px; color: rgba(255,255,255,0.5); cursor: pointer; text-decoration: none;
    font-weight: 600; letter-spacing: 1px;
  }
  .preview-banner-close:hover { color: #fff; }
</style>
</head>
<body>
<div class="preview-banner">
  <span class="preview-banner-label">&#128065; Widget Preview — ${evt.title}</span>
  <a class="preview-banner-close" href="javascript:window.close()">&#10005; Close Preview</a>
</div>
${widgetHtml}
</body>
</html>`);
  } catch(e) { res.status(500).send('Error: ' + e.message); }
});

// ── Public events API ─────────────────────────────────────────────────
app.get('/api/events', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const rows = await dbAll("SELECT * FROM events WHERE status='active' ORDER BY date ASC");
    res.json(rows);
  } catch(e) { res.json([]); }
});

// ── Admin events API ──────────────────────────────────────────────────
app.get('/admin/events-list', auth('admin'), async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT e.*, COUNT(r.id) as reg_count
      FROM events e
      LEFT JOIN rsvps r ON LOWER(r.event)=LOWER(e.title)
      GROUP BY e.id
      ORDER BY e.date DESC
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ result: 'error', error: e.message }); }
});

app.post('/admin/event', auth('admin'), async (req, res) => {
  const { title, date, time, end_time, location, description, capacity, fields } = req.body;
  try {
    const r = await dbRun(`INSERT INTO events (title, date, time, end_time, location, description, capacity, fields) VALUES (?,?,?,?,?,?,?,?)`,
      [title||'', date||'', time||'', end_time||'', location||'', description||'', capacity||null, fields ? JSON.stringify(fields) : null]);
    res.json({ result: 'ok', id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ result: 'error', error: e.message }); }
});

app.patch('/admin/event/:id', auth('admin'), async (req, res) => {
  const { title, date, time, end_time, location, description, capacity, status, fields } = req.body;
  try {
    await dbRun(`UPDATE events SET title=?, date=?, time=?, end_time=?, location=?, description=?, capacity=?, status=?, fields=? WHERE id=?`,
      [title||'', date||'', time||'', end_time||'', location||'', description||'', capacity||null, status||'active',
       fields ? JSON.stringify(fields) : null, req.params.id]);
    res.json({ result: 'ok' });
  } catch(e) { res.status(500).json({ result: 'error', error: e.message }); }
});

app.delete('/admin/event/:id', auth('admin'), async (req, res) => {
  try {
    await dbRun('DELETE FROM events WHERE id=?', [req.params.id]);
    res.json({ result: 'ok' });
  } catch(e) { res.status(500).json({ result: 'error', error: e.message }); }
});

// ── Public widget API: committee members ─────────────────────────────
// Used by the Duda embeddable widget at voteforblaine.com
app.get('/api/committee', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  const rows = await dbAll(
    "SELECT first_name, last_name FROM rsvps WHERE role LIKE '%Committee Member%' ORDER BY last_name, first_name"
  );
  res.json(rows);
});

// ── Admin panel ───────────────────────────────────────────────────────
app.get('/admin', auth('admin'), (req, res) => {
  if (req.userRole === 'candidate') return res.redirect('/candidate');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const base  = process.env.PUBLIC_URL || (proto + '://' + req.get('host'));
  res.send(adminHTML(base, { candidate: false }));
});
app.get('/',      (req, res) => res.redirect('/admin'));

// ── Candidate panel ───────────────────────────────────────────────────
// Same full interface as admin, but in candidate mode all financial data
// (donations, total giving) is hidden and the donation APIs are blocked.
app.get('/candidate', auth('candidate'), (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const base  = process.env.PUBLIC_URL || (proto + '://' + req.get('host'));
  res.send(adminHTML(base, { candidate: true }));
});

// ── Constituent profile ───────────────────────────────────────────────
app.get('/admin/constituent/:id/data', async (req, res) => {
  const row = await dbGet('SELECT * FROM rsvps WHERE id=?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  // Attach all events this person has attended (matched by email, or name fallback)
  const events = row.email
    ? (await dbAll("SELECT event FROM rsvps WHERE email=? AND event IS NOT NULL AND event!='' ORDER BY created_at", [row.email])).map(function(r){ return r.event; })
    : (row.event ? [row.event] : []);
  res.json(Object.assign({}, row, { _events: events }));
});

app.patch('/admin/constituent/:id', async (req, res) => {
  const { first_name, last_name, email, phone, address, city, state, zip, parish,
          guests, guest_names, how_to_help, yard_sign, endorse, comment, role, company } = req.body;
  try {
    await dbRun(`UPDATE rsvps SET
      first_name=?, last_name=?, email=?, phone=?, address=?, city=?, state=?, zip=?, parish=?,
      guests=?, guest_names=?, how_to_help=?, yard_sign=?, endorse=?, comment=?, role=?, company=?
      WHERE id=?`,
      [first_name, last_name, email, phone, address, city, state, zip, parish,
       guests, guest_names, how_to_help, yard_sign, endorse, comment, role, company||'',
       req.params.id]);
    res.json({ result: 'success' });
  } catch(err) {
    res.status(500).json({ result: 'error' });
  }
});

app.get('/admin/constituent/:id', auth('admin'), async (req, res) => res.send(await constituentHTML(req.params.id, { candidate: req.userRole === 'candidate' })));

app.delete('/admin/constituent/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM rsvps WHERE id=?', [req.params.id]);
    res.json({ result: 'success' });
  } catch(err) {
    res.status(500).json({ result: 'error' });
  }
});

// Bulk delete contacts
app.delete('/admin/constituents/bulk', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.json({ result: 'ok', count: 0 });
  try {
    const result = await pool.query('DELETE FROM rsvps WHERE id = ANY($1)', [ids.map(Number)]);
    res.json({ result: 'ok', count: result.rowCount });
  } catch(err) {
    console.error('[bulk-delete]', err.message);
    res.status(500).json({ result: 'error' });
  }
});

// ── Contacts bulk import ──────────────────────────────────────────────
app.post('/admin/contacts/import', async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ result: 'error', msg: 'No rows' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      const zip    = (r.zip    || '').trim();
      const parish = BP[zip]   || (r.parish || '');
      const state  = (r.state  || '').trim() || 'LA';
      await client.query(
        `INSERT INTO rsvps (first_name,last_name,email,phone,address,city,state,zip,parish,role,event,comment,company)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'imported','',$10,$11)`,
        [(r.first_name||'').trim(),(r.last_name||'').trim(),(r.email||'').trim(),
         (r.phone||'').trim(),(r.address||'').trim(),(r.city||'').trim(),
         state, zip, parish, (r.comment||'').trim(), (r.company||'').trim()]
      );
    }
    await client.query('COMMIT');
    res.json({ result: 'ok', imported: rows.length });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ result: 'error', msg: e.message });
  } finally {
    client.release();
  }
});

// ── Donations ─────────────────────────────────────────────────────────
app.get('/admin/donations', adminOnly, async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM donations ORDER BY date DESC, created_at DESC');
    res.json(rows);
  } catch(e) { res.status(500).json({ result: 'error' }); }
});
app.delete('/admin/donation/:id', adminOnly, async (req, res) => {
  try {
    await dbRun('DELETE FROM donations WHERE id=?', [req.params.id]);
    res.json({ result: 'ok' });
  } catch(e) { res.status(500).json({ result: 'error' }); }
});
app.post('/admin/donation', adminOnly, async (req, res) => {
  const { donor_name, amount, date, source, contact_id, tender_type, check_number } = req.body;
  try {
    await dbRun('INSERT INTO donations (donor_name, amount, date, source, contact_id, tender_type, check_number) VALUES (?,?,?,?,?,?,?)',
      [donor_name || '', amount || 0, date || '', source || '', contact_id || null,
       tender_type || null, check_number || null]);
    res.json({ result: 'ok' });
  } catch(err) {
    res.status(500).json({ result: 'error', error: err.message });
  }
});

// ── Volunteers ────────────────────────────────────────────────────────
app.get('/admin/volunteers', async (req, res) => {
  const rows = await dbAll(`SELECT * FROM rsvps WHERE volunteer_role IS NOT NULL AND volunteer_role != '' ORDER BY last_name, first_name`);
  res.json(rows);
});
app.patch('/admin/volunteer/:id', async (req, res) => {
  const { volunteer_role, volunteer_hours, volunteer_status } = req.body;
  try {
    await dbRun(`UPDATE rsvps SET volunteer_role=?, volunteer_hours=?, volunteer_status=? WHERE id=?`,
      [volunteer_role||'', volunteer_hours||0, volunteer_status||'new', req.params.id]);
    res.json({ result: 'ok' });
  } catch(e) { res.status(500).json({ result: 'error' }); }
});
app.delete('/admin/volunteer/:id', async (req, res) => {
  try {
    await dbRun(`UPDATE rsvps SET volunteer_role=NULL, volunteer_hours=0, volunteer_status=NULL WHERE id=?`,
      [req.params.id]);
    res.json({ result: 'ok' });
  } catch(e) { res.status(500).json({ result: 'error' }); }
});

// ── Anedot Webhook ────────────────────────────────────────────────────
// Public endpoint — no auth middleware — but signature-verified when secret is set.
// Configure in Anedot: Settings → Webhooks → URL = https://yourdomain.com/webhook/anedot
// Events to enable: donation_completed, donation_refunded
app.post('/webhook/anedot', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const secret = process.env.ANEDOT_WEBHOOK_SECRET || '';

    // Signature verification
    if (secret) {
      const sig = req.headers['x-request-signature'] || '';
      const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
      if (sig !== expected) {
        console.warn('[Anedot] Invalid signature — rejected');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    let body;
    try { body = JSON.parse(req.body.toString()); }
    catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }

    const event   = body.event   || '';
    const data    = body.payload || {};

    console.log(`[Anedot] Event: ${event}`);

    if (event === 'donation_completed') {
      const donor_name = ((data.first_name || '') + ' ' + (data.last_name || '')).trim() || 'Anonymous';
      const amount     = parseFloat(data.amount_in_dollars) || 0;
      const date       = (data.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
      const source     = data.action_page_name ? `Anedot — ${data.action_page_name}` : 'Anedot';
      const email      = (data.email || '').toLowerCase().trim();
      const anedot_id  = (data.donation && data.donation.id) ? String(data.donation.id) : (data.uid || null);

      // Deduplicate — Anedot retries failed deliveries
      if (anedot_id) {
        const dupe = await dbGet('SELECT id FROM donations WHERE anedot_id=?', [anedot_id]);
        if (dupe) { console.log(`[Anedot] Duplicate ${anedot_id}, skipping`); return res.json({ result: 'duplicate' }); }
      }

      // Auto-match to existing contact by email
      let contact_id = null;
      if (email) {
        const contact = await dbGet('SELECT id FROM rsvps WHERE LOWER(email)=?', [email]);
        if (contact) contact_id = contact.id;
      }

      await dbRun(`INSERT INTO donations (donor_name, amount, date, source, contact_id, email, anedot_id)
                   VALUES (?,?,?,?,?,?,?)`,
        [donor_name, amount, date, source, contact_id, email || null, anedot_id || null]);

      console.log(`[Anedot] Recorded $${amount} from ${donor_name}`);
      return res.json({ result: 'ok' });
    }

    if (event === 'donation_refunded') {
      const anedot_id = (data.donation && data.donation.id) ? String(data.donation.id) : null;
      if (anedot_id) {
        await dbRun(`DELETE FROM donations WHERE anedot_id=?`, [anedot_id]);
        console.log(`[Anedot] Refund — removed donation ${anedot_id}`);
      }
      return res.json({ result: 'ok' });
    }

    // All other events — acknowledge so Anedot doesn't retry
    return res.json({ result: 'ignored', event });

  } catch(e) {
    console.error('[Anedot] Webhook error:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Endorsements ──────────────────────────────────────────────────────
app.get('/admin/endorsements', async (req, res) => {
  const tracked = await dbAll('SELECT * FROM endorsements ORDER BY tier, name');
  // Also pull contacts who said "Yes" to endorsing on the form but aren't already tracked
  const fromContacts = await dbAll(`
    SELECT
      COALESCE(r.first_name,'') || ' ' || COALESCE(r.last_name,'') AS name,
      NULL AS org, 'individual' AS tier, 'endorsed' AS status,
      r.comment AS notes, NULL AS date, r.id AS contact_id, 'contact' AS _src
    FROM rsvps r
    WHERE r.endorse = 'Yes'
    AND NOT EXISTS (SELECT 1 FROM endorsements e WHERE e.contact_id = r.id)
    ORDER BY r.last_name, r.first_name
  `);
  res.json([...tracked, ...fromContacts]);
});
app.post('/admin/endorsement', async (req, res) => {
  const { name, org, tier, status, notes, date, contact_id } = req.body;
  try {
    const r = await dbRun(`INSERT INTO endorsements (name,org,tier,status,notes,date,contact_id) VALUES (?,?,?,?,?,?,?)`,
      [name||'', org||'', tier||'individual', status||'not_contacted', notes||'', date||'', contact_id||null]);
    res.json({ result: 'ok', id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ result: 'error' }); }
});
app.patch('/admin/endorsement/:id', async (req, res) => {
  const { name, org, tier, status, notes, date, contact_id } = req.body;
  try {
    await dbRun(`UPDATE endorsements SET name=?,org=?,tier=?,status=?,notes=?,date=?,contact_id=? WHERE id=?`,
      [name||'', org||'', tier||'individual', status||'not_contacted', notes||'', date||'', contact_id||null, req.params.id]);
    res.json({ result: 'ok' });
  } catch(e) { res.status(500).json({ result: 'error' }); }
});
app.delete('/admin/endorsement/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM endorsements WHERE id=?', [req.params.id]);
    res.json({ result: 'ok' });
  } catch(e) { res.status(500).json({ result: 'error' }); }
});

// ── Walk Lists & Canvassing ───────────────────────────────────────────
app.get('/admin/walk-lists', async (req, res) => {
  const lists = await dbAll('SELECT * FROM walk_lists ORDER BY created_at DESC');
  for (const l of lists) {
    const t = await dbGet('SELECT COUNT(*) as c FROM walk_doors WHERE list_id=?', [l.id]);
    const k = await dbGet("SELECT COUNT(*) as c FROM walk_doors WHERE list_id=? AND result!='pending'", [l.id]);
    const f = await dbGet("SELECT COUNT(*) as c FROM walk_doors WHERE list_id=? AND result='favorable'", [l.id]);
    l._total     = t ? t.c : 0;
    l._knocked   = k ? k.c : 0;
    l._favorable = f ? f.c : 0;
  }
  res.json(lists);
});
app.post('/admin/walk-list', async (req, res) => {
  const { name, area, assigned_to } = req.body;
  try {
    const r = await dbRun('INSERT INTO walk_lists (name,area,assigned_to) VALUES (?,?,?)',
      [name||'', area||'', assigned_to||'']);
    res.json({ result: 'ok', id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ result: 'error' }); }
});
app.patch('/admin/walk-list/:id', async (req, res) => {
  const { name, area, assigned_to } = req.body;
  try {
    await dbRun('UPDATE walk_lists SET name=?,area=?,assigned_to=? WHERE id=?',
      [name||'', area||'', assigned_to||'', req.params.id]);
    res.json({ result: 'ok' });
  } catch(e) { res.status(500).json({ result: 'error' }); }
});
app.delete('/admin/walk-list/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM walk_doors WHERE list_id=?', [req.params.id]);
    await dbRun('DELETE FROM walk_lists WHERE id=?', [req.params.id]);
    res.json({ result: 'ok' });
  } catch(e) { res.status(500).json({ result: 'error' }); }
});
app.get('/admin/walk-doors/:listId', async (req, res) => {
  res.json(await dbAll('SELECT * FROM walk_doors WHERE list_id=? ORDER BY id', [req.params.listId]));
});
app.post('/admin/walk-door', async (req, res) => {
  const { list_id, address, voter_name } = req.body;
  try {
    const r = await dbRun('INSERT INTO walk_doors (list_id,address,voter_name) VALUES (?,?,?)',
      [list_id, address||'', voter_name||'']);
    res.json({ result: 'ok', id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ result: 'error' }); }
});
app.patch('/admin/walk-door/:id', async (req, res) => {
  const { result, volunteer, notes } = req.body;
  try {
    await dbRun(`UPDATE walk_doors SET result=?,volunteer=?,notes=?,knocked_at=to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS') WHERE id=?`,
      [result||'pending', volunteer||'', notes||'', req.params.id]);
    res.json({ result: 'ok' });
  } catch(e) { res.status(500).json({ result: 'error' }); }
});

// ── Bulk CSV import for a walk list ───────────────────────────────────
app.post('/admin/walk-list/:id/import', async (req, res) => {
  const listId = req.params.id;
  const { rows } = req.body; // [{ address, voter_name }]
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ result: 'error', msg: 'No rows' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      await client.query(
        'INSERT INTO walk_doors (list_id,address,voter_name) VALUES ($1,$2,$3)',
        [listId, (r.address||'').trim(), (r.voter_name||'').trim()]
      );
    }
    await client.query('COMMIT');
    res.json({ result: 'ok', imported: rows.length });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ result: 'error', msg: e.message });
  } finally {
    client.release();
  }
});

// ── Yard sign map ─────────────────────────────────────────────────────
app.get('/admin/map', (req, res) => res.send(mapHTML()));
app.get('/admin/sign-map-data', async (req, res) => {
  const rows = await dbAll(
    "SELECT id, first_name, last_name, address, city, zip, parish, yard_sign_delivered FROM rsvps WHERE yard_sign='Yes' ORDER BY created_at DESC"
  );
  res.json(rows);
});

app.get('/admin/no-sign-data', async (req, res) => {
  const rows = await dbAll(
    "SELECT id, first_name, last_name, address, city, zip, parish FROM rsvps WHERE (yard_sign IS NULL OR yard_sign != 'Yes') AND zip IS NOT NULL AND zip != '' ORDER BY created_at DESC"
  );
  res.json(rows);
});

// ── Start ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  Blaine Moncrief — RSVP Admin`);
  console.log(`  Campaign staff:  http://localhost:${PORT}/admin      (pw: ${PASSWORDS.admin})`);
  console.log(`  Candidate view:  http://localhost:${PORT}/candidate  (pw: ${PASSWORDS.candidate})\n`);
});


// ════════════════════════════════════════════════════════════════════════
//  SHARED STYLES
// ════════════════════════════════════════════════════════════════════════
const LOGO_URL = 'https://lirp.cdn-website.com/57867f60/dms3rep/multi/opt/Logo+for+White-1920w.png';

const PIPELINE_STAGES = [
  { key: 'new',        label: 'New Contact',     color: '#9aaabb' },
  { key: 'contacted',  label: 'Contacted',        color: '#3b82f6' },
  { key: 'engaged',    label: 'In Conversation',  color: '#8b5cf6' },
  { key: 'met',        label: 'Meet with Team',   color: '#fb923c' },
  { key: 'committed',  label: 'Vote Committed',   color: '#10b981' },
];
const PIPELINE_JSON = JSON.stringify(PIPELINE_STAGES);

const BASE_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&family=Playfair+Display:wght@700&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --navy:   #09254f;
    --mint:   #78E0C4;
    --mint-d: #5fd4b0;
    --bg:     #f4f6f9;
    --white:  #ffffff;
    --text:   #0d1f3c;
    --muted:  #5a6b84;
    --dim:    #9aaabb;
    --border: #dde3ec;
  }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif;
    font-size: 14px;
    min-height: 100vh;
  }

  /* Header */
  .hdr {
    background: var(--navy);
    padding: 0 32px 0 8px;
    height: 64px;
    display: flex;
    align-items: center;
    gap: 20px;
  }
  .hdr-logo { height: 28px; width: auto; display: block; }
  .hdr-right { display: flex; align-items: center; gap: 16px; margin-left: auto; }
  .hdr-label {
    font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase;
    color: var(--mint); font-weight: 700;
  }
  .hdr-divider { width: 1px; height: 20px; background: rgba(255,255,255,0.12); }
  .csv-btn {
    font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase;
    color: var(--navy); background: var(--mint); text-decoration: none;
    padding: 8px 16px; border-radius: 2px; transition: background .15s;
  }
  .csv-btn:hover { background: var(--mint-d); }
  .map-link {
    font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase;
    color: rgba(255,255,255,.65); text-decoration: none;
    padding: 7px 14px; border: 1px solid rgba(255,255,255,.2); border-radius: 2px;
    transition: all .15s;
  }
  .map-link:hover { color: var(--mint); border-color: rgba(120,224,196,.5); }

  /* Stats strip */
  .stats {
    display: grid;
    gap: 1px;
    background: var(--border);
  }
  .stat { background: var(--white); padding: 28px 32px; }
  .stat-lbl {
    font-size: 9px; letter-spacing: 2.5px; text-transform: uppercase;
    color: var(--dim); font-weight: 700; margin-bottom: 8px;
  }
  .stat-val {
    font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif;
    font-size: 38px; font-weight: 800; color: var(--navy); line-height: 1;
  }
  .stat-val.accent { color: var(--mint-d); }

  /* Notice bar */
  .notice {
    background: #eaf9f5;
    border-bottom: 1px solid #c8eee4;
    padding: 11px 32px;
    font-size: 11px; letter-spacing: .3px;
    color: #3a9e82;
    display: flex; align-items: center; gap: 8px;
  }

  /* Toolbar */
  .toolbar {
    padding: 16px 32px;
    display: flex; align-items: center; gap: 12px;
    border-bottom: 1px solid var(--border);
    background: var(--white);
  }
  .search { position: relative; }
  .search svg { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--dim); pointer-events: none; }
  .search input {
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 2px; padding: 9px 12px 9px 34px;
    color: var(--text); font-size: 13px; font-family: 'Montserrat', sans-serif;
    outline: none; width: 300px;
  }
  .search input::placeholder { color: var(--dim); }
  .search input:focus { border-color: var(--mint-d); }
  /* Header search */
  .hdr-search { position: relative; width: 380px; flex-shrink: 0; }
  .hdr-search svg { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--dim); pointer-events: none; z-index: 1; }
  .hdr-search input {
    display: block; width: 100%;
    background: #deeef7; border: none;
    border-radius: 3px; padding: 9px 14px 9px 35px;
    color: var(--navy); font-size: 12px; font-family: 'Montserrat', sans-serif;
    outline: none; box-shadow: none;
  }
  .hdr-search input::placeholder { color: var(--dim); }
  .hdr-search input:focus { outline: 2px solid var(--mint); outline-offset: 0; }
  /* Search autocomplete dropdown */
  .q-drop { display:none; position:absolute; top:calc(100% + 4px); left:0; right:0; background:var(--white); border:1px solid var(--border); border-radius:6px; box-shadow:0 8px 24px rgba(6,15,30,.15); z-index:300; overflow:hidden; max-height:320px; overflow-y:auto; }
  .q-drop.open { display:block; }
  .q-drop-item { display:flex; align-items:center; gap:10px; padding:10px 14px; cursor:pointer; border-bottom:1px solid var(--border); text-decoration:none; }
  .q-drop-item:last-child { border-bottom:none; }
  .q-drop-item:hover { background:#f0f7ff; }
  .q-drop-name { font-size:13px; font-weight:700; color:var(--navy); }
  .q-drop-meta { font-size:11px; color:var(--dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:1px; }
  .q-drop-avatar { width:30px; height:30px; border-radius:50%; background:var(--mint-d); display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:800; color:#fff; flex-shrink:0; }
  .q-drop-empty { padding:12px 14px; font-size:12px; color:var(--dim); font-style:italic; }
  .tally { font-size: 11px; color: var(--dim); margin-left: auto; letter-spacing: .5px; }

  /* Table */
  .wrap { overflow-x: auto; background: var(--white); }
  table { width: 100%; border-collapse: collapse; }
  thead th {
    padding: 10px 16px; text-align: left;
    font-size: 9px; letter-spacing: 2px; text-transform: uppercase;
    color: var(--dim); font-weight: 700;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    position: sticky; top: 0; background: var(--white);
  }
  tbody tr { border-bottom: 1px solid var(--border); transition: background .1s; }
  tbody tr:last-child { border-bottom: none; }
  tbody tr:nth-child(even) { background: #f4f7fb; }
  tbody tr:hover { background: #e8f7f2; }
  td { padding: 12px 16px; vertical-align: middle; }

  .c-id    { font-size: 11px; color: var(--dim); }
  .c-date  { font-size: 11px; color: var(--dim); white-space: nowrap; }
  .c-name  { font-weight: 700; color: var(--navy); white-space: nowrap; }
  .c-sub   { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .c-phone { font-size: 12px; color: var(--muted); white-space: nowrap; }
  .c-zip   { font-size: 12px; color: var(--muted); }
  .c-comment { font-size: 12px; color: var(--muted); max-width: 180px; line-height: 1.5; }

  .badge {
    display: inline-block; padding: 3px 10px; border-radius: 100px;
    font-size: 11px; font-weight: 700; letter-spacing: .5px; white-space: nowrap;
  }
  .badge-guests { background: rgba(95,212,176,0.15); color: #2e9e7e; }
  .badge-yes    { background: rgba(95,212,176,0.15); color: #2e9e7e; }
  .badge-no     { background: #f0f2f5; color: var(--dim); }

  .tag {
    display: inline-block; padding: 2px 8px; border-radius: 2px; margin: 2px 2px 2px 0;
    font-size: 11px; color: var(--muted); background: #edf0f5;
    white-space: nowrap;
  }
  .tag-none { font-size: 11px; color: var(--dim); font-style: italic; }

  .empty {
    text-align: center; padding: 80px 32px;
    color: var(--dim); font-size: 13px; letter-spacing: .3px;
    background: var(--white);
  }

  /* Footer */
  .foot {
    padding: 20px 32px;
    border-top: 1px solid var(--border);
    font-size: 10px; letter-spacing: .3px;
    color: var(--dim);
    background: var(--white);
  }

  /* ── Feature page shared layout ── */
  .feat-page-hdr {
    display: flex; align-items: center; gap: 16px;
    padding: 24px 32px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--white);
  }
  .feat-page-eyebrow { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: var(--dim); font-weight: 700; }
  .feat-page-title { font-size: 20px; font-weight: 800; color: var(--navy); margin-left: 8px; }
  .feat-page-btn {
    margin-left: auto;
    background: var(--mint); color: var(--navy);
    font-family: 'Montserrat', sans-serif; font-size: 10px; font-weight: 800;
    letter-spacing: 1.5px; text-transform: uppercase;
    border: none; border-radius: 2px; padding: 9px 18px; cursor: pointer;
  }
  .feat-page-btn:hover { background: var(--mint-d); }
  .feat-stat-row {
    display: grid; grid-template-columns: repeat(4,1fr);
    gap: 1px; background: var(--border);
    border-bottom: 1px solid var(--border);
  }
  .feat-stat { background: var(--white); padding: 20px 28px; }
  .feat-stat-val { font-size: 30px; font-weight: 800; color: var(--navy); line-height: 1; }
  .feat-stat-val.accent { color: var(--mint-d); }
  .feat-stat-lbl { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: var(--dim); font-weight: 700; margin-top: 6px; }
  .feat-table-wrap { overflow-x: auto; background: var(--white); border-top: none; margin: 0 32px; border: 1px solid var(--border); border-radius: 3px; overflow: hidden; }

  /* ── Status pills ── */
  .spill {
    display: inline-block; font-size: 9px; font-weight: 700; letter-spacing: 1px;
    text-transform: uppercase; padding: 3px 9px; border-radius: 100px; white-space: nowrap;
  }
  .spill-green  { background: #d1fae5; color: #065f46; }
  .spill-blue   { background: #dbeafe; color: #1e40af; }
  .spill-yellow { background: #fef9c3; color: #854d0e; }
  .spill-gray   { background: #f1f5f9; color: #475569; }
  .spill-orange { background: #ffedd5; color: #9a3412; }
  .spill-red    { background: #fee2e2; color: #991b1b; }
  .spill-mint   { background: rgba(120,224,196,.2); color: #0d9488; }

  /* ── Compliance checklist ── */
  .comp-item {
    background: var(--white); border: 1px solid var(--border);
    border-radius: 4px; padding: 18px 20px;
    display: flex; gap: 16px; margin-bottom: 10px;
  }
  .comp-icon {
    width: 32px; height: 32px; border-radius: 3px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 15px; margin-top: 1px;
  }
  .comp-icon-ok   { background: #d1fae5; }
  .comp-icon-warn { background: #fef3c7; }
  .comp-icon-info { background: #dbeafe; }
  .comp-body { flex: 1; }
  .comp-title { font-size: 13px; font-weight: 700; color: var(--navy); margin-bottom: 4px; }
  .comp-desc  { font-size: 11px; color: var(--muted); line-height: 1.6; }

  /* ── Canvassing result buttons ── */
  .door-result-btn {
    font-size: 9px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;
    border: 1px solid var(--border); border-radius: 2px; padding: 4px 8px;
    cursor: pointer; font-family: 'Montserrat', sans-serif; background: var(--white);
    color: var(--muted); transition: all .1s;
  }
  .door-result-btn:hover { border-color: var(--navy); color: var(--navy); }
  .door-result-btn.active-fav  { background: #d1fae5; color: #065f46; border-color: #6ee7b7; }
  .door-result-btn.active-unf  { background: #fee2e2; color: #991b1b; border-color: #fca5a5; }
  .door-result-btn.active-nh   { background: #fef9c3; color: #854d0e; border-color: #fde68a; }
  .door-result-btn.active-mvd  { background: #f1f5f9; color: #475569; border-color: #cbd5e1; }

  /* ── Endorsement tier icon ── */
  .end-tier-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; border-radius: 3px; font-size: 13px; flex-shrink: 0;
  }

  @media(max-width:900px){
    .stats { grid-template-columns: 1fr 1fr !important; }
    .hdr, .toolbar, .foot { padding-left: 16px; padding-right: 16px; }
    .feat-stat-row { grid-template-columns: 1fr 1fr !important; }
  }
`;

// ════════════════════════════════════════════════════════════════════════
//  WIDGET GENERATOR — defined here so .toString() preserves escape seqs
// ════════════════════════════════════════════════════════════════════════
function generateWidget(label, displayDate, time, location, fields, endTime, crmBaseUrl) {
  var BM_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxBW4GzNFR9rb3kmqYjS93wxw43XH2q4c-kb-gqQBAuqQCIEgJHggtyNWp1Kvouured/exec';
  var BM_CRM_URL = crmBaseUrl || (typeof window !== 'undefined' && window.BM_CRM_BASE_URL) || (typeof process !== 'undefined' && process.env && process.env.PUBLIC_URL) || 'http://localhost:3002';
  var safeLabel = label || 'New Event';
  // Format ISO date (YYYY-MM-DD) → "Wednesday, May 27, 2026"
  var safeDate = (function(d) {
    if (!d) return '';
    var parts = d.split('-');
    if (parts.length !== 3) return d;
    var dt = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    return dt.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  })(displayDate);
  var safeTime  = time ? (endTime ? time + ' – ' + endTime : time) : '';
  var safeLoc   = location || '';
  var eyebrow   = 'Join Us';
  var heading   = safeLabel;
  // Field config — defaults to on for common fields
  var f = fields || {};
  var showEmail    = f.email       !== false;
  var showPhone    = f.phone       !== false;
  var showAddress  = f.address     !== false;
  var showGuests   = f.guests      !== false;
  var showYardSign = f.yard_sign   !== false;
  var showEndorse  = f.endorse     !== false;
  var showHelp     = f.how_to_help !== false;
  var showComment  = f.comment     !== false;

  return [
'<!-- RSVP Widget — ' + safeLabel + ' -->',
'<style>',
'  @import url(\'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&family=Playfair+Display:ital,wght@0,700;1,700&display=swap\');',
'  .bm-rsvp { background: #09254f; padding: 72px 24px; position: relative; overflow: hidden; font-family: \'Montserrat\', \'Helvetica Neue\', Arial, sans-serif; box-sizing: border-box; }',
'  .bm-rsvp *, .bm-rsvp *::before, .bm-rsvp *::after { box-sizing: border-box; }',
'  .bm-rsvp-inner { max-width: 720px; margin: 0 auto; position: relative; }',
'  .bm-rsvp-eyebrow { text-align: center; font-size: 11px; letter-spacing: 3px; text-transform: uppercase; color: #78E0C4; font-weight: 700; margin: 0 0 12px; }',
'  .bm-rsvp h2 { font-family: \'Playfair Display\', Georgia, serif; font-size: 36px; color: #fff; text-align: center; line-height: 1.2; margin: 0 0 8px; }',
'  .bm-rsvp-event-details { text-align: center; font-size: 13px; color: #78E0C4; font-weight: 700; margin: 0 0 40px; }',
'  .bm-rsvp-event-details strong { color: #78E0C4; font-weight: 600; }',
'  .bm-rsvp-form { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 40px; }',
'  .bm-rsvp-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }',
'  .bm-rsvp-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }',
'  .bm-rsvp-label { font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: rgba(255,255,255,0.45); font-weight: 600; }',
'  .bm-rsvp-input, .bm-rsvp-select, .bm-rsvp-textarea { background: #fff; border: 1px solid #cbd5e1; border-radius: 3px; padding: 12px 14px; font-size: 14px; color: #0E356C; font-family: \'Montserrat\', sans-serif; outline: none; transition: border-color 0.15s, box-shadow 0.15s; width: 100%; }',
'  .bm-rsvp-input::placeholder, .bm-rsvp-textarea::placeholder { color: #94a3b8; }',
'  .bm-rsvp-input:focus, .bm-rsvp-select:focus, .bm-rsvp-textarea:focus { border-color: #78E0C4; box-shadow: 0 0 0 3px rgba(120,224,196,0.25); }',
'  .bm-rsvp-textarea { resize: vertical; min-height: 90px; line-height: 1.5; }',
'  .bm-rsvp-select { cursor: pointer; }',
'  .bm-rsvp-select option { background: #fff; color: #0E356C; }',
'  .bm-rsvp-help-group { margin: 20px 0 16px; }',
'  .bm-rsvp-help-group-label { font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: rgba(255,255,255,0.45); font-weight: 600; margin-bottom: 14px; display: block; }',
'  .bm-rsvp-help-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 24px; }',
'  .bm-rsvp-help-option { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }',
'  .bm-rsvp-help-option input[type="checkbox"] { width: 16px; height: 16px; accent-color: #78E0C4; cursor: pointer; flex-shrink: 0; margin-top: 2px; }',
'  .bm-rsvp-help-option-text { font-size: 13px; color: rgba(255,255,255,0.6); line-height: 1.4; }',
'  .bm-rsvp-divider { border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 24px 0; }',
'  .bm-rsvp-checkbox-row { display: flex; align-items: center; gap: 12px; margin: 0 0 20px; cursor: pointer; }',
'  .bm-rsvp-checkbox-row input[type="checkbox"] { width: 18px; height: 18px; accent-color: #78E0C4; cursor: pointer; flex-shrink: 0; }',
'  .bm-rsvp-checkbox-label { font-size: 13px; color: rgba(255,255,255,0.6); line-height: 1.4; }',
'  .bm-rsvp-submit { width: 100%; background: #78E0C4; color: #09254f; padding: 16px; font-size: 12px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; border: none; border-radius: 3px; cursor: pointer; font-family: \'Montserrat\', sans-serif; transition: background 0.15s; margin-top: 8px; }',
'  .bm-rsvp-submit:hover { background: #5fd4b0; }',
'  .bm-rsvp-submit:disabled { opacity: 0.6; cursor: not-allowed; }',
'  .bm-rsvp-success { display: none; text-align: center; padding: 48px 24px; }',
'  .bm-rsvp-success-icon { width: 60px; height: 60px; background: rgba(120,224,196,0.15); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; }',
'  .bm-rsvp-success h3 { font-family: \'Playfair Display\', Georgia, serif; font-size: 24px; color: #fff; margin: 0 0 10px; }',
'  .bm-rsvp-success p { font-size: 17px; font-weight: 600; color: rgba(255,255,255,0.85); line-height: 1.6; margin: 0; }',
'  .bm-rsvp-note { text-align: center; margin-top: 20px; font-size: 11px; color: rgba(255,255,255,0.25); }',
'  @media (max-width: 600px) { .bm-rsvp-row { grid-template-columns: 1fr; } .bm-rsvp-help-grid { grid-template-columns: 1fr; } .bm-rsvp-form { padding: 24px 20px; } .bm-rsvp h2 { font-size: 26px; } }',
'</style>',
'',
'<div class="bm-rsvp">',
'  <div class="bm-rsvp-inner">',
'    <p class="bm-rsvp-eyebrow">' + eyebrow + '</p>',
'    <h2>' + heading + '</h2>',
'    <p class="bm-rsvp-event-details">',
'      <strong>' + safeDate + '</strong> &nbsp;&middot;&nbsp; ' + safeTime + ' &nbsp;&middot;&nbsp; ' + safeLoc,
'    </p>',
'',
'    <div class="bm-rsvp-form" id="bmRsvpForm">',
// Name — always shown
'      <div class="bm-rsvp-row">',
'        <div class="bm-rsvp-field"><label class="bm-rsvp-label" for="bm-first">First Name</label><input class="bm-rsvp-input" type="text" id="bm-first" placeholder="First name"/></div>',
'        <div class="bm-rsvp-field"><label class="bm-rsvp-label" for="bm-last">Last Name</label><input class="bm-rsvp-input" type="text" id="bm-last" placeholder="Last name"/></div>',
'      </div>',
// Email + Phone
(showEmail || showPhone) ? '      <div class="bm-rsvp-row">' : '',
showEmail ? '        <div class="bm-rsvp-field"><label class="bm-rsvp-label" for="bm-email">Email Address</label><input class="bm-rsvp-input" type="email" id="bm-email" placeholder="your@email.com"/></div>' : '',
showPhone ? '        <div class="bm-rsvp-field"><label class="bm-rsvp-label" for="bm-phone">Cell Number</label><input class="bm-rsvp-input" type="tel" id="bm-phone" placeholder="(504) 555-0000"/></div>' : '',
(showEmail || showPhone) ? '      </div>' : '',
// Address (street → city/state → zip is natural geographic order)
showAddress ? '      <div class="bm-rsvp-field"><label class="bm-rsvp-label" for="bm-address">Street Address</label><input class="bm-rsvp-input" type="text" id="bm-address" placeholder="123 Main St"/></div>' : '',
showAddress ? '      <div class="bm-rsvp-row"><div class="bm-rsvp-field"><label class="bm-rsvp-label" for="bm-city">City</label><input class="bm-rsvp-input" type="text" id="bm-city" placeholder="Metairie"/></div><div class="bm-rsvp-field"><label class="bm-rsvp-label" for="bm-state">State</label><select class="bm-rsvp-select" id="bm-state"><option value="AL">Alabama</option><option value="AK">Alaska</option><option value="AZ">Arizona</option><option value="AR">Arkansas</option><option value="CA">California</option><option value="CO">Colorado</option><option value="CT">Connecticut</option><option value="DE">Delaware</option><option value="FL">Florida</option><option value="GA">Georgia</option><option value="HI">Hawaii</option><option value="ID">Idaho</option><option value="IL">Illinois</option><option value="IN">Indiana</option><option value="IA">Iowa</option><option value="KS">Kansas</option><option value="KY">Kentucky</option><option value="LA" selected>Louisiana</option><option value="ME">Maine</option><option value="MD">Maryland</option><option value="MA">Massachusetts</option><option value="MI">Michigan</option><option value="MN">Minnesota</option><option value="MS">Mississippi</option><option value="MO">Missouri</option><option value="MT">Montana</option><option value="NE">Nebraska</option><option value="NV">Nevada</option><option value="NH">New Hampshire</option><option value="NJ">New Jersey</option><option value="NM">New Mexico</option><option value="NY">New York</option><option value="NC">North Carolina</option><option value="ND">North Dakota</option><option value="OH">Ohio</option><option value="OK">Oklahoma</option><option value="OR">Oregon</option><option value="PA">Pennsylvania</option><option value="RI">Rhode Island</option><option value="SC">South Carolina</option><option value="SD">South Dakota</option><option value="TN">Tennessee</option><option value="TX">Texas</option><option value="UT">Utah</option><option value="VT">Vermont</option><option value="VA">Virginia</option><option value="WA">Washington</option><option value="WV">West Virginia</option><option value="WI">Wisconsin</option><option value="WY">Wyoming</option></select></div></div>' : '',
// Zip + Guests
'      <div class="bm-rsvp-row">',
'        <div class="bm-rsvp-field"><label class="bm-rsvp-label" for="bm-zip">Zip Code</label><input class="bm-rsvp-input" type="text" id="bm-zip" placeholder="70001" maxlength="10" oninput="bmAutoParish(this.value)"/></div>',
showGuests ? '        <div class="bm-rsvp-field"><label class="bm-rsvp-label" for="bm-guests">Number of Guests (including yourself)</label><select class="bm-rsvp-select" id="bm-guests"><option value="1">1 — Just me</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5+">5 or more</option></select></div>' : '',
'      </div>',
'      <input type="hidden" id="bm-parish"/>',
// Ways to get involved
showHelp ? '      <div class="bm-rsvp-help-group"><span class="bm-rsvp-help-group-label">How would you like to help? (select all that apply)</span><div class="bm-rsvp-help-grid">' : '',
(showHelp && showYardSign) ? '        <label class="bm-rsvp-help-option"><input type="checkbox" id="bm-yardsign"/><span class="bm-rsvp-help-option-text">Provide a sign location</span></label>' : '',
showHelp ? '        <label class="bm-rsvp-help-option"><input type="checkbox" id="bm-help-phone-calls"/><span class="bm-rsvp-help-option-text">Make phone calls</span></label>' : '',
showHelp ? '        <label class="bm-rsvp-help-option"><input type="checkbox" id="bm-help-knock"/><span class="bm-rsvp-help-option-text">Knock on doors</span></label>' : '',
showHelp ? '        <label class="bm-rsvp-help-option"><input type="checkbox" id="bm-help-sign-wave"/><span class="bm-rsvp-help-option-text">Wave signs</span></label>' : '',
showHelp ? '        <label class="bm-rsvp-help-option"><input type="checkbox" id="bm-help-errands"/><span class="bm-rsvp-help-option-text">Run errands for the committee</span></label>' : '',
showHelp ? '        <label class="bm-rsvp-help-option"><input type="checkbox" id="bm-help-host-event"/><span class="bm-rsvp-help-option-text">Host a meet &amp; greet or other event</span></label>' : '',
showHelp ? '        <label class="bm-rsvp-help-option"><input type="checkbox" id="bm-help-inkind"/><span class="bm-rsvp-help-option-text">In-kind contribution or venue space</span></label>' : '',
showHelp ? '        <label class="bm-rsvp-help-option"><input type="checkbox" id="bm-help-other"/><span class="bm-rsvp-help-option-text">Other — contact me directly</span></label>' : '',
showHelp ? '      </div></div>' : '',
// Standalone yard sign (if help is off but yard_sign is on)
(!showHelp && showYardSign) ? '      <label class="bm-rsvp-checkbox-row"><input type="checkbox" id="bm-yardsign"/><span class="bm-rsvp-checkbox-label">I would like a yard sign.</span></label>' : '',
// Divider before endorse/comment
(showEndorse || showComment) ? '      <hr class="bm-rsvp-divider"/>' : '',
// Endorse
showEndorse ? '      <label class="bm-rsvp-checkbox-row"><input type="checkbox" id="bm-endorse"/><span class="bm-rsvp-checkbox-label">I would like to officially endorse Blaine Benge Moncrief for Judge, Division H, 24th Judicial District Court.</span></label>' : '',
// Comment
showComment ? '      <div class="bm-rsvp-field"><label class="bm-rsvp-label" for="bm-comment">Comments or Questions</label><textarea class="bm-rsvp-textarea" id="bm-comment" placeholder="Anything you\'d like us to know…"></textarea></div>' : '',
'      <button class="bm-rsvp-submit" id="bmRsvpSubmit" onclick="bmSubmitRsvp()">Reserve My Spot</button>',
'    </div>',
'',
'    <div class="bm-rsvp-success" id="bmRsvpSuccess">',
'      <div class="bm-rsvp-success-icon">',
'        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#78E0C4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
'      </div>',
'      <h3>You\'re on the list!</h3>',
'      <p>Thank you for your RSVP. We look forward to seeing you. A confirmation will be sent to your email.</p>',
'    </div>',
'    <p class="bm-rsvp-note">Your information is kept private and used only for campaign communications.</p>',
'  </div>',
'</div>',
'',
'<script>',
'  var BM_SCRIPT_URL = \'' + BM_SCRIPT_URL + '\';',
'  var BM_CRM_URL = \'' + BM_CRM_URL + '\';',
'',
'  function bmVal(id) { var el = document.getElementById(id); return el ? el.value.trim() : \'\'; }',
'  function bmChk(id) { var el = document.getElementById(id); return el ? el.checked : false; }',
'  function bmSubmitRsvp() {',
'    var first    = bmVal(\'bm-first\');',
'    var last     = bmVal(\'bm-last\');',
'    var email    = bmVal(\'bm-email\');',
'    var phone    = bmVal(\'bm-phone\');',
'    var address  = bmVal(\'bm-address\');',
'    var city     = bmVal(\'bm-city\');',
'    var state    = bmVal(\'bm-state\');',
'    var zip      = bmVal(\'bm-zip\');',
'    var parish   = bmVal(\'bm-parish\');',
'    var guests   = bmVal(\'bm-guests\') || \'1\';',
'    var yardsign = bmChk(\'bm-yardsign\') ? \'Yes\' : \'No\';',
'    var endorse  = bmChk(\'bm-endorse\') ? \'Yes\' : \'No\';',
'    var comment  = bmVal(\'bm-comment\');',
'    var helpOptions = [',
'      { id: \'bm-help-phone-calls\',   label: \'Make phone calls\' },',
'      { id: \'bm-help-knock\',         label: \'Knock on doors\' },',
'      { id: \'bm-help-sign-wave\',     label: \'Wave signs\' },',
'      { id: \'bm-help-errands\',       label: \'Run errands for the committee\' },',
'      { id: \'bm-help-host-event\',    label: \'Host a meet & greet or other event\' },',
'      { id: \'bm-help-inkind\',        label: \'In-kind contribution or venue space\' },',
'      { id: \'bm-help-other\',         label: \'Other — contact me directly\' }',
'    ];',
'    var howToHelp = helpOptions',
'      .filter(function(o) { return bmChk(o.id); })',
'      .map(function(o) { return o.label; })',
'      .join(\', \');',
'    if (!howToHelp) howToHelp = \'None selected\';',
'    if (!first || !last) { alert(\'Please fill in your first and last name.\'); return; }',
'    var btn = document.getElementById(\'bmRsvpSubmit\');',
'    btn.disabled = true; btn.textContent = \'Submitting…\';',
'    var payload = { firstName: first, lastName: last, email: email, phone: phone, address: address, city: city, state: state, zip: zip, parish: parish, guests: guests, howToHelp: howToHelp, yardSign: yardsign, endorse: endorse, comment: comment, event: \'' + safeLabel.replace(/'/g, "\\'") + '\' };',
'    // Primary: save to CRM — success/failure is gated on this',
'    fetch(BM_CRM_URL + \'/rsvp\', { method: \'POST\', headers: { \'Content-Type\': \'application/json\' }, body: JSON.stringify(payload) })',
'      .then(function(r) { return r.json(); })',
'      .then(function(data) {',
'        if (data.result === \'success\') {',
'          document.getElementById(\'bmRsvpForm\').style.display = \'none\';',
'          document.getElementById(\'bmRsvpSuccess\').style.display = \'block\';',
'          // Secondary: sync to Google Sheets silently in background',
'          fetch(BM_SCRIPT_URL + \'?\' + new URLSearchParams(payload).toString()).catch(function() {});',
'        } else { throw new Error(\'CRM error\'); }',
'      })',
'      .catch(function() {',
'        btn.disabled = false; btn.textContent = \'Reserve My Spot\';',
'        alert(\'Something went wrong. Please try again or email electblaine@gmail.com\');',
'      });',
'  }',
'  var BM_ZIP_PARISH = {"70001":"Jefferson","70002":"Jefferson","70003":"Jefferson","70004":"Jefferson","70005":"Jefferson","70006":"Jefferson","70009":"Jefferson","70010":"Jefferson","70011":"Jefferson","70031":"Jefferson","70033":"Jefferson","70036":"Jefferson","70037":"Jefferson","70047":"Jefferson","70053":"Jefferson","70055":"Jefferson","70056":"Jefferson","70057":"Jefferson","70058":"Jefferson","70059":"Jefferson","70060":"Jefferson","70062":"Jefferson","70063":"Jefferson","70064":"Jefferson","70065":"Jefferson","70067":"Jefferson","70072":"Jefferson","70073":"Jefferson","70094":"Jefferson","70112":"Orleans","70113":"Orleans","70114":"Orleans","70115":"Orleans","70116":"Orleans","70117":"Orleans","70118":"Orleans","70119":"Orleans","70121":"Orleans","70122":"Orleans","70123":"Orleans","70124":"Orleans","70125":"Orleans","70126":"Orleans","70127":"Orleans","70128":"Orleans","70129":"Orleans","70130":"Orleans","70131":"Orleans","70163":"Orleans","70032":"St. Bernard","70043":"St. Bernard","70044":"St. Bernard","70085":"St. Bernard","70086":"St. Bernard","70092":"St. Bernard","70040":"Plaquemines","70041":"Plaquemines","70050":"Plaquemines","70068":"Plaquemines","70069":"Plaquemines","70070":"Plaquemines","70071":"Plaquemines","70074":"Plaquemines","70075":"Plaquemines","70076":"Plaquemines","70082":"Plaquemines","70083":"Plaquemines","70084":"Plaquemines","70090":"Plaquemines","70030":"St. Charles","70039":"St. Charles","70052":"St. Charles","70079":"St. Charles","70087":"St. Charles","70433":"St. Tammany","70434":"St. Tammany","70435":"St. Tammany","70437":"St. Tammany","70444":"St. Tammany","70445":"St. Tammany","70446":"St. Tammany","70447":"St. Tammany","70448":"St. Tammany","70450":"St. Tammany","70452":"St. Tammany","70455":"St. Tammany","70456":"St. Tammany","70458":"St. Tammany","70459":"St. Tammany","70460":"St. Tammany","70461":"St. Tammany","70464":"St. Tammany","70466":"St. Tammany","70471":"St. Tammany"};',
'  function bmAutoParish(zip) {',
'    var p = BM_ZIP_PARISH[zip];',
'    if (p) document.getElementById(\'bm-parish\').value = p;',
'  }',
'<' + '/script>'
  ].join('\n');
}

// ════════════════════════════════════════════════════════════════════════
//  ADMIN HTML — full view (campaign staff)
// ════════════════════════════════════════════════════════════════════════
function adminHTML(baseUrl, opts) {
  const isCand = !!(opts && opts.candidate);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${isCand ? 'Candidate View' : 'Campaign Admin'} — Blaine Moncrief</title>
${isCand ? '<style>#nav-donations,#bnav-donations,#donation-section,#view-donations,#act-new-donation,#mob-new-donation,#exp-row-donors{display:none!important;}</style>' : ''}
<style>${BASE_CSS}
  .stats { grid-template-columns: repeat(4,1fr); }
  .badge-ood {
    display:inline-block; font-size:9px; font-weight:700; letter-spacing:.8px;
    text-transform:uppercase; color:#9aaabb; background:#f0f2f5;
    padding:2px 7px; border-radius:100px; margin-left:6px; white-space:nowrap;
    vertical-align:middle;
  }

  /* Donation section */
  .donation-section { padding: 28px 32px; background: var(--white); border-bottom: 1px solid var(--border); }
  .donation-hdr { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
  .donation-hdr-left { display: flex; align-items: center; gap: 14px; }
  .donation-hdr-title { font-size: 9px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--dim); font-weight: 700; }
  .donation-preview-badge { font-size: 9px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; background: rgba(120,224,196,.15); color: var(--mint-d); border: 1px solid rgba(120,224,196,.3); padding: 3px 10px; border-radius: 100px; }
  .donation-section { margin-bottom: 24px; }
  .don-table-wrap { border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
  .don-table-wrap table { width: 100%; border-collapse: collapse; }
  .don-table-wrap thead th { background: var(--bg); font-size: 9px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--dim); font-weight: 700; padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--border); }
  .don-table-wrap tbody td { padding: 11px 14px; font-size: 13px; color: var(--text); border-bottom: 1px solid #f0f2f5; vertical-align: middle; }
  .don-table-wrap tbody tr:last-child td { border-bottom: none; }
  .don-table-wrap tbody tr:hover td { background: #f8fdfc; }
  .don-amount { font-weight: 700; color: var(--navy); font-size: 14px; }
  .don-method { font-size: 11px; color: var(--dim); }
  .don-badge { display: inline-block; font-size: 10px; font-weight: 600; padding: 2px 9px; border-radius: 100px; background: rgba(120,224,196,.12); color: var(--navy); border: 1px solid rgba(120,224,196,.2); }
  .stat-raised .stat-val { color: var(--mint-d); }

  /* ── Fundraising / Donation Charts ── */

  /* Goal progress strip — showcase banner */
  .don-goal-strip {
    background: linear-gradient(120deg, #1e7fa3 0%, #2798BD 50%, #31aad4 100%);
    border-radius: 6px; padding: 24px 28px 22px; margin-bottom: 14px;
    box-shadow: 0 4px 20px rgba(39,152,189,.35);
    position: relative; overflow: hidden;
  }
  .don-goal-strip::before {
    content: ''; position: absolute; inset: 0;
    background: radial-gradient(ellipse at 80% 50%, rgba(255,255,255,.08) 0%, transparent 65%);
    pointer-events: none;
  }
  .don-goal-labels {
    display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 14px;
  }
  .don-goal-raised {
    font-family: 'Montserrat', sans-serif;
    font-size: 28px; font-weight: 800; color: #fff; line-height: 1;
    text-shadow: 0 1px 4px rgba(0,0,0,.15);
  }
  .don-goal-raised-sub {
    font-size: 10px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase;
    color: rgba(255,255,255,.6); margin-top: 3px;
  }
  .don-goal-pct {
    font-size: 13px; font-weight: 800; color: #fff;
    background: rgba(255,255,255,.18); border: 1px solid rgba(255,255,255,.3);
    padding: 5px 14px; border-radius: 100px; letter-spacing: .5px;
  }
  .don-goal-remain { font-size: 11px; color: rgba(255,255,255,.6); text-align: right; }
  .don-goal-remain-num { font-size: 15px; font-weight: 700; color: rgba(255,255,255,.85); display: block; }
  .don-goal-track  {
    height: 8px; background: rgba(255,255,255,.2); border-radius: 100px; overflow: hidden;
  }
  .don-goal-fill {
    height: 100%; background: linear-gradient(90deg, rgba(255,255,255,.7), #fff);
    border-radius: 100px; transform-origin: left center;
    animation: donGoalGrow 0.9s cubic-bezier(.22,1,.36,1) 0.3s both;
  }
  @keyframes donGoalGrow { from { transform: scaleX(0); } to { transform: scaleX(1); } }

  /* Overview row: KPI 2×2 grid + chart */
  .don-overview { display: flex; align-items: stretch; gap: 14px; margin-bottom: 14px; }
  .don-kpi-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
    flex-shrink: 0; width: 182px;
  }
  .don-kpi-tile {
    background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
    padding: 11px 13px;
  }
  .don-kpi-val {
    font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif;
    font-size: 18px; font-weight: 800; color: var(--navy); line-height: 1;
  }
  .don-kpi-val.accent { color: var(--mint-d); }
  .don-kpi-lbl { font-size: 9px; letter-spacing: 1px; text-transform: uppercase; color: var(--dim); font-weight: 600; margin-top: 5px; }

  /* Timeline chart */
  .don-chart-box {
    flex: 1; min-width: 0;
    background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
    padding: 13px 16px 10px; position: relative;
  }
  .don-chart-eyebrow {
    font-size: 9px; letter-spacing: 2px; text-transform: uppercase;
    color: var(--dim); font-weight: 700; margin-bottom: 8px;
    display: flex; justify-content: space-between; align-items: center;
  }
  .don-chart-legend { display: flex; gap: 12px; }
  .don-chart-leg-item { display: flex; align-items: center; gap: 5px; font-size: 9px; color: var(--dim); font-weight: 400; letter-spacing: 0; text-transform: none; }
  .don-chart-leg-bar  { width: 10px; height: 8px; border-radius: 2px; }
  .don-chart-leg-line { width: 14px; height: 2px; border-radius: 1px; }
  .don-chart-dates {
    display: flex; justify-content: space-around;
    font-size: 9px; color: var(--dim); letter-spacing: .3px; margin-top: 3px;
  }
  /* Tooltip */
  .don-chart-tooltip {
    position: absolute; pointer-events: none;
    background: var(--navy); color: #fff;
    font-size: 11px; font-weight: 600; line-height: 1.4;
    padding: 6px 11px; border-radius: 4px;
    white-space: nowrap; opacity: 0; transition: opacity .15s;
    transform: translate(-50%, -100%); margin-top: -6px;
    z-index: 20; top: 0; left: 0;
  }
  .don-chart-tooltip.visible { opacity: 1; }
  .don-chart-tooltip::after {
    content: ''; position: absolute; top: 100%; left: 50%;
    transform: translateX(-50%);
    border: 5px solid transparent; border-top-color: var(--navy);
  }
  /* Bar animation */
  @keyframes donBarGrow {
    from { transform: scaleY(0); }
    to   { transform: scaleY(1); }
  }
  .don-bar {
    transform-box: fill-box; transform-origin: bottom;
    animation: donBarGrow 0.5s cubic-bezier(.34,1.56,.64,1) both;
  }
  /* Cumulative line fade-in */
  @keyframes donLineFade { from { opacity: 0; } to { opacity: .8; } }
  #donCumLine, .don-cum-dot { animation: donLineFade 0.5s ease-out 0.7s both; }

  /* Highlight cards */
  .don-highlights {
    display: grid; grid-template-columns: 1fr 1fr 1.4fr; gap: 14px; margin-bottom: 18px;
  }
  .don-hl-card {
    background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 14px 16px;
  }
  .don-hl-top    { border-left: 3px solid var(--mint); }
  .don-hl-recent { border-left: 3px solid #2798BD; }
  .don-hl-eyebrow {
    font-size: 9px; letter-spacing: 1.5px; text-transform: uppercase;
    color: var(--dim); font-weight: 700; margin-bottom: 6px;
  }
  .don-hl-name { font-size: 14px; font-weight: 700; color: var(--navy); display: block; line-height: 1.3; }
  .don-hl-link { text-decoration: none; color: var(--navy); }
  .don-hl-link:hover { color: var(--mint-d); }
  .don-hl-amount {
    font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif;
    font-size: 26px; font-weight: 800; color: var(--navy); line-height: 1; margin: 5px 0 3px;
  }
  .don-hl-meta { font-size: 11px; color: var(--dim); }
  /* Source bars */
  .don-src-bars { margin-top: 8px; }
  .don-src-row { display: flex; align-items: center; gap: 7px; margin-bottom: 8px; }
  .don-src-row:last-child { margin-bottom: 0; }
  .don-src-label { font-size: 11px; color: var(--muted); min-width: 44px; }
  .don-src-track { flex: 1; height: 6px; background: var(--border); border-radius: 100px; overflow: hidden; }
  .don-src-fill  { height: 100%; background: var(--mint); border-radius: 100px; }
  .don-src-pct   { font-size: 10px; color: var(--dim); min-width: 28px; text-align: right; }
  .don-src-val   { font-size: 11px; font-weight: 700; color: var(--navy); min-width: 38px; text-align: right; }
  /* Gift tier breakdown */
  .don-tier-sep { border: none; border-top: 1px solid var(--border); margin: 11px 0 10px; }
  .don-tiers { display: flex; }
  .don-tier { flex: 1; text-align: center; padding: 0 4px; }
  .don-tier + .don-tier { border-left: 1px solid var(--border); }
  .don-tier-count { font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif; font-size: 20px; font-weight: 800; color: var(--navy); line-height: 1; }
  .don-tier-lbl { font-size: 9px; letter-spacing: .8px; text-transform: uppercase; color: var(--dim); font-weight: 700; margin-top: 3px; }
  .don-tier-range { font-size: 9px; color: var(--muted); margin-top: 2px; }
  @media(max-width:900px){
    .don-overview { flex-direction: column; }
    .don-kpi-grid { width: 100%; grid-template-columns: repeat(4, 1fr); }
    .don-highlights { grid-template-columns: 1fr 1fr; }
  }

  /* Election Intelligence bar */
  .election-bar {
    background: var(--navy);
    display: flex;
    align-items: stretch;
    border-top: 1px solid rgba(255,255,255,.08);
    margin-top: auto;
  }
  .elec-title-block {
    display: flex; flex-direction: column; justify-content: center;
    padding: 20px 28px; border-right: 1px solid rgba(255,255,255,.1);
    min-width: 175px; flex-shrink: 0;
  }
  .elec-title-eyebrow {
    font-size: 8px; letter-spacing: 2px; text-transform: uppercase;
    color: var(--mint); font-weight: 700; margin-bottom: 5px;
  }
  .elec-title-name {
    font-size: 13px; font-weight: 700; color: #fff; line-height: 1.4;
  }
  .elec-block {
    flex: 1; display: flex; flex-direction: column; justify-content: center;
    gap: 3px; padding: 20px 24px;
    border-right: 1px solid rgba(255,255,255,.08);
  }
  .elec-block:last-of-type { border-right: none; }
  .elec-lbl {
    font-size: 8px; letter-spacing: 2px; text-transform: uppercase;
    color: rgba(255,255,255,.4); font-weight: 700; white-space: nowrap;
  }
  .elec-val {
    font-family: 'Montserrat', sans-serif; font-size: 26px; font-weight: 800;
    color: #fff; line-height: 1; white-space: nowrap;
  }
  .elec-val.accent { color: var(--mint); }
  .elec-sub { font-size: 10px; color: rgba(255,255,255,.35); line-height: 1.4; }
  .elec-source {
    font-size: 9px; color: rgba(255,255,255,.2); white-space: nowrap;
    display: flex; align-items: flex-end; padding: 0 20px 16px 0; flex-shrink: 0;
  }
  @media(max-width:900px){
    .election-bar { flex-wrap: wrap; }
    .elec-block { border-right: none; border-bottom: 1px solid rgba(255,255,255,.08); min-width: 45%; }
    .elec-title-block { min-width: 100%; border-right: none; border-bottom: 1px solid rgba(255,255,255,.08); }
    .elec-source { padding: 12px 20px; }
  }

  /* Event tabs */
  /* District filter bar */
  .district-bar {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 32px; background: var(--white);
    border-bottom: 1px solid var(--border);
  }
  .dist-chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 14px; border-radius: 100px;
    font-size: 11px; font-weight: 700; letter-spacing: .5px;
    text-transform: uppercase; cursor: pointer; transition: all .15s;
    background: var(--bg); color: var(--dim);
    border: 1px solid var(--border); font-family: 'Montserrat', sans-serif;
  }
  .dist-chip:hover { border-color: var(--navy); color: var(--navy); }
  .dist-chip.active { background: var(--navy); color: #fff; border-color: var(--navy); }
  .dist-chip-count {
    font-size: 10px; font-weight: 700;
    background: rgba(255,255,255,.25); color: inherit;
    padding: 1px 7px; border-radius: 100px;
  }
  .dist-chip:not(.active) .dist-chip-count { background: var(--border); color: var(--muted); }

  /* ── Bulk select bar ── */
  .bulk-bar {
    display: none; align-items: center; gap: 12px;
    padding: 8px 32px; background: #fffbeb;
    border-bottom: 1px solid #fde68a;
  }
  .bulk-bar.on { display: flex; }
  .bulk-bar-lbl { font-size: 12px; font-weight: 700; color: #92400e; }
  .bulk-del-btn {
    background: #d97706; color: #fff; border: none;
    padding: 6px 16px; border-radius: 2px;
    font-size: 11px; font-weight: 700; letter-spacing: .8px; text-transform: uppercase;
    font-family: 'Montserrat', sans-serif; cursor: pointer; transition: opacity .15s;
  }
  .bulk-del-btn:hover { opacity: .85; }
  .bulk-clr-btn {
    background: none; border: 1px solid rgba(146,64,14,.3); color: #92400e;
    padding: 5px 12px; border-radius: 2px;
    font-size: 11px; font-weight: 700; font-family: 'Montserrat', sans-serif; cursor: pointer;
  }
  .bulk-clr-btn:hover { border-color: rgba(146,64,14,.6); }
  .cb-th, .cb-td { width: 36px; padding-right: 0 !important; }
  input.row-cb, #sel-all { width: 15px; height: 15px; cursor: pointer; accent-color: var(--navy); }
  tbody tr.row-selected { background: #f0f7ff !important; }

  .evt-tabs { display: flex; flex-wrap: wrap; gap: 6px; background: var(--white); padding: 10px 32px 12px; border-bottom: 1px solid var(--border); }
  .evt-tab { padding: 5px 12px; font-size: 11px; font-weight: 700; cursor: pointer; border-radius: 100px; color: var(--muted); background: var(--bg); border: 1px solid var(--border); white-space: nowrap; user-select: none; transition: background .12s, color .12s, border-color .12s; display: flex; align-items: center; gap: 6px; }
  .evt-tab.active { color: var(--navy); background: var(--white); border-color: var(--navy); }
  .evt-tab:hover:not(.active) { border-color: #78E0C4; color: var(--navy); }
  .evt-label { font-size: 10px; font-weight: 700; color: #fff; background: var(--navy); padding: 1px 6px; border-radius: 100px; }
  .evt-tab.active .evt-label { background: var(--mint-d); }

  /* New Event button */
  .new-evt-btn { font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: #fff; background: var(--navy); border: none; padding: 8px 16px; border-radius: 2px; cursor: pointer; transition: opacity .15s; }
  .new-evt-btn:hover { opacity: .85; }

  /* ── Sortable column header ── */
  .th-sortable { cursor: pointer; user-select: none; white-space: nowrap; }
  .th-sortable:hover { color: var(--navy); }
  .sort-arrow { font-size: 10px; opacity: .45; margin-left: 3px; transition: opacity .12s; }
  .th-sortable.sort-asc .sort-arrow,
  .th-sortable.sort-desc .sort-arrow { opacity: 1; color: var(--navy); }

  /* Modal */
  .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(6,15,30,0.7); z-index: 100; align-items: center; justify-content: center; }
  .modal-overlay.open { display: flex; }
  .modal { background: var(--white); border-radius: 6px; width: 100%; max-width: 640px; max-height: 90vh; overflow-y: auto; padding: 36px 40px; position: relative; margin: 20px; }
  .modal-close { position: absolute; top: 16px; right: 20px; font-size: 20px; cursor: pointer; color: var(--dim); background: none; border: none; line-height: 1; }
  .modal-title { font-family: 'Playfair Display', Georgia, serif; font-size: 24px; color: var(--navy); margin-bottom: 24px; }
  .modal-field { margin-bottom: 16px; }
  .modal-label { font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--dim); font-weight: 700; margin-bottom: 6px; display: block; }
  .modal-input { width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 2px; padding: 10px 12px; font-size: 13px; font-family: 'Montserrat', sans-serif; color: var(--text); outline: none; }
  .modal-input:focus { border-color: #78E0C4; }
  .modal-code { width: 100%; height: 200px; font-size: 11px; font-family: monospace; background: #f8f9fb; border: 1px solid var(--border); border-radius: 2px; padding: 12px; color: var(--muted); resize: none; outline: none; margin-top: 16px; }
  .modal-copy { margin-top: 12px; width: 100%; background: #78E0C4; color: var(--navy); border: none; padding: 12px; font-size: 12px; font-weight: 800; letter-spacing: 1.5px; text-transform: uppercase; font-family: 'Montserrat', sans-serif; border-radius: 2px; cursor: pointer; }
  .modal-copy:hover { background: #5fd4b0; }
  .modal-btn { font-size: 11px; font-weight: 800; letter-spacing: 1.5px; text-transform: uppercase; font-family: 'Montserrat', sans-serif; background: #2798BD; color: #fff; border: none; border-radius: 2px; padding: 11px 20px; cursor: pointer; transition: background .15s; }
  .modal-btn:hover { background: #1f7fa0; }
  .modal-btn.secondary { background: var(--bg); color: var(--navy); border: 1px solid var(--border); }
  .modal-btn.secondary:hover { border-color: #78E0C4; background: #f0fbf7; }
  /* Time chips */
  .time-chips { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
  .time-chip { font-size:11px; font-weight:700; font-family:'Montserrat',sans-serif; padding:5px 13px; border-radius:100px; border:1.5px solid var(--border); background:var(--bg); color:var(--navy); cursor:pointer; transition:all .15s; }
  .time-chip:hover { border-color:var(--mint-d); background:#f0fbf7; }
  .time-chip.active { background:var(--navy); color:#fff; border-color:var(--navy); }
  /* Export modal */
  .exp-overlay { display:none;position:fixed;inset:0;z-index:200;background:rgba(9,37,79,.6);align-items:center;justify-content:center;padding:20px; }
  .exp-overlay.open { display:flex; }
  .exp-modal { background:#fff;border-radius:6px;width:100%;max-width:400px;padding:32px 36px;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.25); }
  .exp-row { display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--border); }
  .exp-row:last-child { border-bottom:none; }
  .exp-lbl { font-size:12px;font-weight:700;color:var(--navy); }
  .exp-btns { display:flex;gap:6px; }
  .exp-btn { font-size:9px;font-weight:800;letter-spacing:1px;text-transform:uppercase;padding:5px 10px;border-radius:2px;border:1px solid var(--border);color:var(--navy);background:var(--bg);cursor:pointer;text-decoration:none;transition:background .12s,border-color .12s;display:inline-block;font-family:'Montserrat',sans-serif; }
  .exp-btn:hover { background:#e8f7f2;border-color:#78E0C4;color:var(--navy); }
  /* Donor autocomplete */
  .don-ac-wrap { position: relative; }
  .don-ac-drop { position: absolute; top: calc(100% + 3px); left: 0; right: 0; background: #fff; border: 1px solid var(--border); border-radius: 3px; box-shadow: 0 6px 20px rgba(9,37,79,.12); z-index: 300; max-height: 220px; overflow-y: auto; display: none; }
  .don-ac-drop.open { display: block; }
  .don-ac-item { padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #f0f2f5; display: flex; flex-direction: column; gap: 1px; }
  .don-ac-item:last-child { border-bottom: none; }
  .don-ac-item:hover, .don-ac-item.focused { background: #f0fbf7; }
  .don-ac-name { font-size: 13px; font-weight: 700; color: var(--navy); }
  .don-ac-meta { font-size: 11px; color: var(--dim); }
  .don-ac-new { padding: 10px 14px; cursor: pointer; font-size: 12px; font-weight: 700; color: #2798BD; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 6px; }
  .don-ac-new:hover { background: #f0fbf7; }

  /* Snapshot */
  .snapshot {
    padding: 28px 32px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }
  .snapshot-hdr {
    font-size: 9px; letter-spacing: 2.5px; text-transform: uppercase;
    color: var(--dim); font-weight: 700; margin-bottom: 20px;
  }
  .snapshot-grid {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr;
    gap: 16px;
  }
  .snap-card {
    background: var(--white);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 20px 22px;
  }
  .snap-card-title {
    font-size: 10px; letter-spacing: 2px; text-transform: uppercase;
    color: var(--dim); font-weight: 700; margin-bottom: 16px;
  }

  /* Bar rows */
  .bar-row { margin-bottom: 10px; cursor: pointer; border-radius: 3px; padding: 6px 8px; margin-left: -8px; margin-right: -8px; transition: background .12s; }
  .bar-row:last-child { margin-bottom: 0; }
  .bar-row:hover { background: #eaf9f5; }
  .bar-row:hover .bar-label { color: var(--navy); }
  .bar-meta { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
  .bar-label { font-size: 12px; color: var(--muted); transition: color .12s; }
  .bar-count { font-size: 12px; font-weight: 700; color: var(--navy); }
  .bar-track { height: 5px; background: var(--border); border-radius: 100px; overflow: hidden; }
  .bar-fill  { height: 100%; background: #78E0C4; border-radius: 100px; transition: width .4s ease; }
  .bar-fill.soft { background: #b0eadb; }

  /* Yes/No split */
  .yn-row { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
  .yn-row:last-child { margin-bottom: 0; }
  .yn-label { font-size: 12px; color: var(--muted); flex: 1; }
  .yn-bar-wrap { flex: 2; display: flex; height: 8px; border-radius: 100px; overflow: hidden; }
  .yn-yes { background: #78E0C4; }
  .yn-no  { background: var(--border); }
  .yn-pct { font-size: 11px; font-weight: 700; color: var(--navy); min-width: 34px; text-align: right; }

  /* Zip list */
  .zip-item { display: flex; align-items: center; gap: 10px; margin-bottom: 9px; }
  .zip-item:last-child { margin-bottom: 0; }
  .zip-code { font-size: 13px; font-weight: 700; color: var(--navy); min-width: 48px; }
  .zip-bar-wrap { flex: 1; height: 5px; background: var(--border); border-radius: 100px; overflow: hidden; }
  .zip-bar { height: 100%; background: #09254f; border-radius: 100px; }
  .zip-n { font-size: 11px; color: var(--dim); min-width: 24px; text-align: right; }

  /* Drill-down modal */
  /* Clickable stat card */
  .stat-clickable { cursor: pointer; transition: background .15s; }
  .stat-clickable:hover { background: #eaf9f5; }
  .stat-sub { font-size: 11px; color: var(--dim); margin-top: 6px; letter-spacing: .3px; }

  /* Yard sign tracker modal */
  .signs-summary { display: flex; gap: 32px; padding: 16px 0 20px; border-bottom: 1px solid var(--border); margin-bottom: 4px; }
  .signs-sum-block { }
  .signs-sum-num { font-family: 'Playfair Display', Georgia, serif; font-size: 32px; color: var(--navy); line-height: 1; }
  .signs-sum-num.accent { color: var(--mint-d); }
  .signs-sum-lbl { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: var(--dim); font-weight: 700; margin-top: 6px; }
  .signs-table-wrap { border: 1px solid var(--border); border-radius: 4px; max-height: 420px; overflow-y: auto; margin-top: 16px; }
  .signs-table-wrap table { width: 100%; border-collapse: collapse; }
  .sign-btn { font-size: 11px; font-weight: 700; padding: 5px 14px; border-radius: 100px; border: none; cursor: pointer; white-space: nowrap; transition: all .15s; font-family: 'Montserrat', sans-serif; letter-spacing: .5px; }
  .sign-btn.requested { background: #f0f2f5; color: var(--muted); }
  .sign-btn.requested:hover { background: #d8f4ec; color: #2e9e7e; }
  .sign-btn.delivered { background: rgba(95,212,176,0.18); color: #2e9e7e; }
  .sign-btn.delivered:hover { background: #f0f2f5; color: var(--dim); }

  .drill-export-btn {
    font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase;
    color: var(--navy); background: var(--mint); border: none; padding: 8px 16px;
    border-radius: 2px; cursor: pointer; transition: background .15s;
  }
  .drill-export-btn:hover { background: var(--mint-d); }
  .drill-table-wrap { border: 1px solid var(--border); border-radius: 4px; max-height: 400px; overflow-y: auto; margin-top: 16px; }
  .drill-table-wrap table { width: 100%; border-collapse: collapse; }
  .drill-table-wrap thead th { background: var(--bg); }
  .drill-empty { text-align: center; padding: 40px 20px; color: var(--dim); font-style: italic; font-size: 13px; }

  /* Event stat drill-down modal */
  .evt-drill-overlay { position:fixed;inset:0;z-index:200;background:rgba(9,37,79,.55);display:none;align-items:center;justify-content:center;padding:20px; }
  .evt-drill-overlay.open { display:flex; }
  .evt-drill-box { background:#fff;border-radius:6px;max-width:520px;width:100%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.25); }
  .evt-drill-hdr { padding:18px 24px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px; }
  .evt-drill-ttl { font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:var(--navy);flex:1; }
  .evt-drill-export { font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#fff;background:#2798BD;border:none;border-radius:2px;padding:6px 12px;cursor:pointer;white-space:nowrap;transition:background .15s; }
  .evt-drill-export:hover { background:#1f7fa0; }
  .evt-drill-close { background:none;border:none;cursor:pointer;color:var(--dim);font-size:22px;line-height:1;padding:0;transition:color .12s; }
  .evt-drill-close:hover { color:var(--navy); }
  .evt-drill-list { overflow-y:auto;flex:1;padding:4px 0; }
  .evt-drill-row { display:flex;flex-direction:column;gap:2px;padding:11px 24px;text-decoration:none;border-bottom:1px solid #f0f2f5;transition:background .1s; }
  .evt-drill-row:hover { background:#f8fdfc; }
  .evt-drill-name { font-size:13px;font-weight:700;color:var(--navy); }
  .evt-drill-meta { font-size:11px;color:var(--dim); }

  @media(max-width:900px){ .snapshot-grid{grid-template-columns:1fr} }

  /* ── Add Person Sidebar ── */
  .ap-overlay { display:none; position:fixed; inset:0; background:rgba(6,15,30,0.45); z-index:200; }
  .ap-overlay.open { display:block; }
  .ap-drawer {
    position:fixed; top:0; right:0; bottom:0; width:440px; max-width:100%;
    background:var(--white); z-index:201; display:flex; flex-direction:column;
    box-shadow:-4px 0 32px rgba(6,15,30,0.18);
    transform:translateX(100%); transition:transform .25s cubic-bezier(.4,0,.2,1);
  }
  .ap-drawer.open { transform:translateX(0); }
  .ap-drawer-hdr {
    padding:24px 28px 20px; border-bottom:1px solid var(--border);
    display:flex; align-items:center; justify-content:space-between; flex-shrink:0;
  }
  .ap-drawer-title { font-family:'Playfair Display',Georgia,serif; font-size:22px; color:var(--navy); }
  .ap-drawer-close { background:none; border:none; font-size:22px; cursor:pointer; color:var(--dim); line-height:1; padding:4px; }
  .ap-drawer-close:hover { color:var(--navy); }
  .ap-drawer-body { flex:1; overflow-y:auto; padding:24px 28px; }
  .ap-drawer-footer {
    padding:16px 28px; border-top:1px solid var(--border); flex-shrink:0;
    display:flex; gap:12px;
  }
  .ap-drawer-submit {
    flex:1; background:#78E0C4; color:var(--navy); border:none; padding:13px;
    font-size:11px; font-weight:800; letter-spacing:1.5px; text-transform:uppercase;
    font-family:'Montserrat',sans-serif; border-radius:2px; cursor:pointer;
  }
  .ap-drawer-submit:hover { background:#5fd4b0; }
  .ap-drawer-submit:disabled { opacity:.6; cursor:not-allowed; }
  .ap-drawer-cancel {
    background:none; border:1px solid var(--border); color:var(--dim); padding:13px 20px;
    font-size:11px; font-weight:700; letter-spacing:1px; text-transform:uppercase;
    font-family:'Montserrat',sans-serif; border-radius:2px; cursor:pointer;
  }
  .ap-drawer-cancel:hover { border-color:var(--navy); color:var(--navy); }
  .ap-field { margin-bottom:18px; }
  .ap-label { font-size:10px; letter-spacing:1.5px; text-transform:uppercase; color:var(--dim); font-weight:700; margin-bottom:6px; display:block; }
  .ap-input { width:100%; background:var(--bg); border:1px solid var(--border); border-radius:2px; padding:10px 12px; font-size:13px; font-family:'Montserrat',sans-serif; color:var(--text); outline:none; }
  .ap-input:focus { border-color:#78E0C4; }
  .ap-row { display:grid; gap:0 14px; }
  .ap-row-2 { grid-template-columns:1fr 1fr; }
  .ap-row-3 { grid-template-columns:3fr 1fr 1.5fr; }
  .ap-check-group { display:flex; gap:20px; flex-wrap:wrap; padding:4px 0; }
  .ap-check-label { display:flex; align-items:center; gap:7px; cursor:pointer; font-size:10px; letter-spacing:1.5px; text-transform:uppercase; color:var(--dim); font-weight:700; font-family:'Montserrat',sans-serif; }
  .ap-check-label input { width:14px; height:14px; cursor:pointer; flex-shrink:0; }
  .ap-error { color:#f59e0b; font-size:12px; margin-bottom:12px; display:none; }
  .ap-addr-wrap { position:relative; }
  .ap-suggest {
    display:none; position:absolute; top:100%; left:0; right:0; z-index:400;
    background:var(--white); border:1px solid var(--border); border-top:none;
    border-radius:0 0 4px 4px; box-shadow:0 6px 20px rgba(6,15,30,.13);
    max-height:240px; overflow-y:auto;
  }
  .ap-suggest-item {
    padding:10px 13px; font-size:12px; color:var(--text); cursor:pointer;
    border-bottom:1px solid #f0f2f5; line-height:1.45;
  }
  .ap-suggest-item:last-child { border-bottom:none; }
  .ap-suggest-item:hover, .ap-suggest-item.ap-focused { background:#eaf9f5; color:var(--navy); }
  .ap-suggest-searching { padding:10px 13px; font-size:12px; color:var(--dim); font-style:italic; }

  /* ── Pipeline Summary Strip ── */
  .pipeline-section {
    padding: 22px 32px 26px;
    border-bottom: 1px solid var(--border);
    background: var(--white);
  }
  .pipeline-section-hdr {
    display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;
  }
  .pipeline-section-title { font-size: 9px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--dim); font-weight: 700; }
  .pipeline-total { font-size: 11px; color: var(--dim); }
  .pipeline-track { display: flex; align-items: stretch; gap: 0; }
  .pipe-stage-wrap { display: flex; align-items: center; flex: 1; min-width: 0; }
  .pipe-stage {
    flex: 1; min-width: 0;
    background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
    padding: 13px 14px 11px; cursor: pointer;
    transition: border-color .15s, box-shadow .15s;
  }
  .pipe-stage:hover { border-color: #78E0C4; box-shadow: 0 2px 8px rgba(6,15,30,.05); }
  .pipe-stage-dot { width: 9px; height: 9px; border-radius: 50%; margin-bottom: 9px; }
  .pipe-stage-count { font-family: 'Montserrat', sans-serif; font-size: 22px; font-weight: 700; color: var(--navy); line-height: 1; }
  .pipe-stage-label { font-size: 9px; letter-spacing: .8px; text-transform: uppercase; color: var(--dim); font-weight: 700; margin-top: 5px; line-height: 1.3; }
  .pipe-stage-bar { height: 3px; background: var(--border); border-radius: 100px; margin-top: 8px; overflow: hidden; }
  .pipe-stage-fill { height: 100%; border-radius: 100px; transition: width .4s; }
  .pipe-arrow { color: var(--dim); padding: 0 5px; font-size: 14px; flex-shrink: 0; opacity: .5; }

  /* ── Pipeline Horizontal Lane Layout ── */
  .pipeline-board-container { padding: 24px 32px 32px; }
  .pipeline-board { display: flex; flex-direction: column; gap: 10px; }
  .pipe-lane {
    background: var(--white); border: 1px solid var(--border); border-radius: 6px;
    overflow: hidden;
  }
  .pipe-lane-hdr {
    padding: 12px 20px; background: var(--bg); border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 10px;
  }
  .pipe-lane-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .pipe-lane-title { font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; font-weight: 700; color: var(--navy); flex: 1; }
  .pipe-lane-count { font-size: 11px; font-weight: 700; color: var(--dim); background: var(--border); padding: 2px 9px; border-radius: 100px; }
  .pipe-lane-cards { display: flex; flex-direction: column; gap: 0; padding: 0; }
  .pipe-lane-empty { padding: 12px 18px; font-size: 12px; color: var(--dim); font-style: italic; }
  .pipe-card {
    display: flex; align-items: center; gap: 10px;
    background: var(--white); border-bottom: 1px solid var(--border);
    padding: 9px 16px; cursor: pointer; transition: background .1s;
    text-decoration: none;
  }
  .pipe-card:last-child { border-bottom: none; }
  .pipe-card:hover { background: #f0fbf7; }
  .pipe-card-info { flex: 1; min-width: 0; }
  .pipe-card-name { font-size: 12px; font-weight: 700; color: var(--navy); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pipe-card-meta { font-size: 10px; color: var(--dim); margin-top: 1px; }
  .pipe-card-tags { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 3px; }
  .pipe-card-tag { font-size: 9px; color: var(--muted); background: #edf0f5; padding: 1px 5px; border-radius: 2px; }
  .pipe-card-sel {
    flex-shrink: 0; font-size: 9px; letter-spacing: .3px;
    text-transform: uppercase; font-family: 'Montserrat', sans-serif; font-weight: 700;
    color: var(--navy); background: var(--bg); border: 1px solid var(--border);
    border-radius: 2px; padding: 4px 6px; cursor: pointer; outline: none; max-width: 130px;
  }
  .pipe-card-sel:focus { border-color: #78E0C4; }

  /* ── Left Sidebar Navigation ── */
  .left-nav {
    width: 220px; min-width: 220px; background: var(--navy);
    display: flex; flex-direction: column;
    position: fixed; top: 0; left: 0; bottom: 0; z-index: 50;
    overflow-y: auto;
  }
  .left-nav-top {
    padding: 20px 20px 18px;
    border-bottom: 1px solid rgba(255,255,255,.10);
    flex-shrink: 0;
  }
  .left-nav-logo-img { height: 22px; width: auto; display: block; }
  .left-nav-role {
    font-size: 9px; letter-spacing: 2px; text-transform: uppercase;
    color: var(--mint); font-weight: 700; margin-top: 10px;
  }
  .left-nav-body { flex: 1; padding: 8px 0 20px; }
  .left-nav-section-lbl {
    font-size: 9px; letter-spacing: 2px; text-transform: uppercase;
    color: rgba(255,255,255,.25); font-weight: 700;
    padding: 14px 20px 5px;
  }
  .left-nav-item {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 20px 10px 17px; font-size: 11px; font-weight: 700;
    letter-spacing: .8px; text-transform: uppercase;
    color: rgba(255,255,255,.55); text-decoration: none;
    cursor: pointer; background: none; border: none; border-left: 3px solid transparent;
    width: 100%; text-align: left; font-family: 'Montserrat', sans-serif;
    transition: color .15s, background .15s, border-color .15s;
  }
  .left-nav-item:hover { color: rgba(255,255,255,.9); background: rgba(255,255,255,.05); }
  .left-nav-item.active { color: var(--mint); border-left-color: var(--mint); background: rgba(120,224,196,.08); }
  .left-nav-item svg { flex-shrink: 0; opacity: .6; }
  .left-nav-item.active svg, .left-nav-item:hover svg { opacity: 1; }
  .left-nav-divider { height: 1px; background: rgba(255,255,255,.07); margin: 10px 0; }
  .left-nav-add-btn {
    display: block; margin: 6px 16px 4px; padding: 10px 14px;
    background: var(--mint); color: var(--navy); border: none;
    border-radius: 2px; font-size: 11px; font-weight: 800;
    letter-spacing: 1.5px; text-transform: uppercase;
    font-family: 'Montserrat', sans-serif; cursor: pointer;
    text-align: left; transition: background .15s;
    width: calc(100% - 32px);
  }
  .left-nav-add-btn:hover { background: var(--mint-d); }
  .left-nav-add-btn-blue { background: #2798BD !important; color: #fff !important; margin-top: 4px !important; }
  .left-nav-add-btn-blue:hover { background: #1f7fa0 !important; }
  .admin-main { margin-left: 220px; min-height: 100vh; display: flex; flex-direction: column; }
  .view-hidden { display: none !important; }
  /* ═══════════════════════════════════════════════
     MOBILE NAV — bottom bar + slide-up "More" sheet
  ═══════════════════════════════════════════════ */
  .bottom-nav { display:none; }
  .mob-sheet-overlay {
    display:none; position:fixed; inset:0; background:rgba(0,0,0,.52);
    z-index:195; opacity:0; pointer-events:none; transition:opacity .22s;
  }
  .mob-sheet-overlay.open { opacity:1; pointer-events:auto; }
  .mob-sheet {
    display:none; position:fixed; left:0; right:0; bottom:0;
    background:#0b2959; border-radius:18px 18px 0 0;
    z-index:196; transform:translateY(100%);
    transition:transform .26s cubic-bezier(.4,0,.2,1);
  }
  .mob-sheet.open { transform:translateY(0); }
  .mob-sheet-handle { width:38px; height:4px; background:rgba(255,255,255,.2); border-radius:2px; margin:12px auto 4px; }
  .mob-sheet-item {
    display:flex; align-items:center; gap:14px; padding:13px 22px;
    color:rgba(255,255,255,.6); font-size:13px; font-weight:600;
    font-family:'Montserrat',sans-serif; border:none; background:none;
    width:100%; text-align:left; cursor:pointer; text-decoration:none; transition:color .15s;
  }
  .mob-sheet-item.active { color:var(--mint); }
  .mob-sheet-item svg { flex-shrink:0; opacity:.65; }
  .mob-sheet-item.active svg { opacity:1; }
  .mob-sheet-divider { height:1px; background:rgba(255,255,255,.09); margin:4px 20px; }
  .mob-sheet-actions { display:flex; gap:8px; padding:12px 20px 4px; flex-wrap:wrap; }
  .mob-sheet-btn {
    flex:1; min-width:100px; padding:13px 10px; border:none; border-radius:3px;
    font-size:11px; font-weight:800; letter-spacing:1px; text-transform:uppercase;
    font-family:'Montserrat',sans-serif; cursor:pointer;
  }

  @media (max-width:768px) {
    /* ── Layout ── */
    .left-nav { display:none !important; }
    html, body { overflow-x:hidden; }
    .admin-main { margin-left:0; padding-bottom:calc(58px + env(safe-area-inset-bottom,0px)); overflow-x:hidden; }

    /* ── Dashboard stats ── */
    .stat { padding:18px 18px !important; }
    .stat-val { font-size:30px !important; }
    .stat-lbl { font-size:8px !important; letter-spacing:1.5px !important; }

    /* ── Dashboard section padding ── */
    .snapshot { padding:20px 16px !important; }
    .pipeline-section { padding:18px 16px 20px !important; }
    .donation-section { padding:20px 16px !important; }
    .snap-card { padding:16px 16px !important; }

    /* ── Pipeline: grid of full-width cards on mobile (no truncated labels) ── */
    .pipeline-track { display:grid !important; grid-template-columns:repeat(2,1fr) !important; gap:10px !important; }
    .pipe-stage-wrap { display:block !important; }
    .pipe-arrow { display:none !important; }
    .pipe-stage { padding:14px 12px !important; }
    .pipe-stage-label { font-size:10px !important; white-space:normal !important; overflow:visible !important; text-overflow:clip !important; }

    /* ── Event card: buttons go full-width below title ── */
    .snap-card > div:first-child { flex-wrap:wrap !important; }
    .evt-card-actions {
      margin-left:0 !important; width:100%;
      display:flex !important; gap:0 !important;
      border:1px solid var(--border); border-radius:6px; overflow:hidden;
    }
    .evt-card-actions .dist-chip {
      flex:1; text-align:center; justify-content:center;
      border:none !important; border-radius:0 !important;
      padding:10px 6px !important; font-size:11px !important;
      border-right:1px solid var(--border) !important;
    }
    .evt-card-actions .dist-chip:last-child { border-right:none !important; }

    /* ── Profile pipeline: scrollable, no cut-off ── */
    .pipe-progress { overflow-x:auto; -webkit-overflow-scrolling:touch; padding-bottom:10px; }
    .pipe-step-wrap { min-width:72px; flex:0 0 72px; }
    .pipe-step-label { font-size:8px; letter-spacing:0.3px; word-break:break-word; }
    .pipe-connector { width:14px; flex-shrink:0; }

    /* ── Header ── */
    .hdr { padding:0 14px; gap:10px; }
    .hdr-right { display:none; }
    .hdr-search { flex:1; min-width:0; }
    .hdr-search input { font-size:15px; min-width:0; width:100%; }

    /* ── Feature headers ── */
    .feat-page-hdr { flex-wrap:wrap; padding:12px 14px; gap:8px; }
    .feat-page-title { font-size:16px; }
    .feat-page-btn { padding:9px 14px; font-size:10px; }

    /* ── Scrollable filter bars ── */
    .district-bar { overflow-x:auto; flex-wrap:nowrap; -webkit-overflow-scrolling:touch; }
    #evt-filter-bar { overflow-x:auto; flex-wrap:nowrap; -webkit-overflow-scrolling:touch; }

    /* ── Tables ── */
    .wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; }
    .wrap table { min-width:700px; }
    .toolbar { padding:6px 14px; }

    /* ── Dashboard ── */
    .snap-grid { grid-template-columns:1fr 1fr !important; }
    .snapshot-grid { grid-template-columns:1fr !important; }

    /* ── Pipeline ── */
    .pipeline-board-container { overflow-x:auto; -webkit-overflow-scrolling:touch; }

    /* ── Modals as bottom sheets ── */
    .modal-overlay { align-items:flex-end !important; padding:0 !important; }
    .modal-overlay .modal {
      width:100% !important; max-width:100% !important; min-width:0 !important;
      border-radius:14px 14px 0 0 !important; margin:0 !important;
      max-height:88vh; padding:24px 20px 32px !important;
    }
    #don-modal-overlay { align-items:flex-end !important; padding:0 !important; }
    .evt-drill-overlay { align-items:flex-end !important; padding:0 !important; }
    .evt-drill-box { max-width:100% !important; border-radius:14px 14px 0 0 !important; max-height:85vh; }
    #import-contacts-overlay { align-items:flex-end !important; padding:0 !important; }
    #import-contacts-overlay .modal { border-radius:14px 14px 0 0 !important; max-height:90vh; }

    /* ── Drawers ── */
    .ap-drawer { width:100% !important; }
    .profile-drawer { width:100% !important; min-width:0 !important; max-width:100% !important; }

    /* ── Bottom nav ── */
    .bottom-nav {
      display:flex; position:fixed; bottom:0; left:0; right:0;
      height:58px; padding-bottom:env(safe-area-inset-bottom,0px);
      background:var(--navy); border-top:1px solid rgba(255,255,255,.13);
      z-index:190; align-items:stretch;
    }
    .bnav-item {
      flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
      gap:3px; background:none; border:none; color:rgba(255,255,255,.45);
      font-size:9px; font-weight:700; letter-spacing:.5px; text-transform:uppercase;
      font-family:'Montserrat',sans-serif; cursor:pointer; text-decoration:none;
      padding:5px 0 0; transition:color .15s; -webkit-tap-highlight-color:transparent;
    }
    .bnav-item.active { color:var(--mint); }
    .bnav-item svg { opacity:.5; transition:opacity .15s; }
    .bnav-item.active svg { opacity:1; }

    /* ── More sheet (shown on mobile) ── */
    .mob-sheet-overlay { display:block; }
    .mob-sheet { display:block; padding-bottom:calc(58px + env(safe-area-inset-bottom,0px)); }
  }
</style>
</head>
<body>

<!-- ══════════════════════════════════════════════
     LEFT SIDEBAR NAVIGATION
═══════════════════════════════════════════════ -->
<nav class="left-nav">
  <div class="left-nav-top">
    <a href="/admin" style="line-height:0;display:block;">
      <img class="left-nav-logo-img" src="${LOGO_URL}" alt="Blaine Benge Moncrief"/>
    </a>
  </div>
  <div class="left-nav-body">
    <button class="left-nav-item active" id="nav-dashboard" onclick="switchView('dashboard')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
      Dashboard
    </button>
    <button class="left-nav-item" id="nav-constituents" onclick="switchView('constituents')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      Contacts
    </button>
    <button class="left-nav-item" id="nav-events" onclick="switchView('events')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      Events
    </button>
    <button class="left-nav-item" id="nav-pipeline" onclick="switchView('pipeline')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 3H2l8 9.46V19l4 2V12.46L22 3z"/></svg>
      Pipeline
    </button>
    <button class="left-nav-item" id="nav-donations" onclick="switchView('donations')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
      Donations
    </button>
    <a class="left-nav-item" href="/admin/map">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
      Sign Map
    </a>
    <button class="left-nav-item" id="nav-volunteers" onclick="switchView('volunteers')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="23" y1="11" x2="17" y2="11"/><line x1="20" y1="8" x2="20" y2="14"/></svg>
      Volunteers
    </button>
    <button class="left-nav-item" id="nav-endorsements" onclick="switchView('endorsements')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
      Endorsements
    </button>
    <button class="left-nav-item" id="nav-canvassing" onclick="switchView('canvassing')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      Canvassing
    </button>
    <button class="left-nav-item" id="nav-compliance" onclick="switchView('compliance')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      Compliance
    </button>
    <div class="left-nav-divider"></div>
    <div class="left-nav-section-lbl">Actions</div>
    <button class="left-nav-add-btn" onclick="openAddPerson()">&#xff0b; New Contact</button>
    <button class="left-nav-add-btn left-nav-add-btn-blue" id="act-new-donation" onclick="openDonationModal()">&#xff0b; New Donation</button>
    <button class="left-nav-add-btn" style="background:#0E356C !important;color:#fff !important;margin-top:4px !important;" onmouseover="this.style.background=\\'#1a4a8a\\'" onmouseout="this.style.background=\\'#0E356C\\'" onclick="openNewEventModal()">&#xff0b; New Event</button>
    <button class="left-nav-item" onclick="openExportModal()" style="width:100%;text-align:left;">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Exports
    </button>
  </div>
</nav>

<!-- ══════════════════════════════════════════════
     MOBILE: SLIDE-UP "MORE" SHEET + BOTTOM NAV
═══════════════════════════════════════════════ -->
<div class="mob-sheet-overlay" id="mob-sheet-overlay" onclick="closeMobSheet()"></div>
<div class="mob-sheet" id="mob-sheet">
  <div class="mob-sheet-handle"></div>
  <button class="mob-sheet-item" id="mnav-pipeline" onclick="closeMobSheet();switchView('pipeline')">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 3H2l8 9.46V19l4 2V12.46L22 3z"/></svg>Pipeline
  </button>
  <button class="mob-sheet-item" id="mnav-volunteers" onclick="closeMobSheet();switchView('volunteers')">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="23" y1="11" x2="17" y2="11"/><line x1="20" y1="8" x2="20" y2="14"/></svg>Volunteers
  </button>
  <button class="mob-sheet-item" id="mnav-endorsements" onclick="closeMobSheet();switchView('endorsements')">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>Endorsements
  </button>
  <button class="mob-sheet-item" id="mnav-canvassing" onclick="closeMobSheet();switchView('canvassing')">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>Canvassing
  </button>
  <button class="mob-sheet-item" id="mnav-compliance" onclick="closeMobSheet();switchView('compliance')">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>Compliance
  </button>
  <a class="mob-sheet-item" href="/admin/map" onclick="closeMobSheet()">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>Sign Map
  </a>
  <div class="mob-sheet-divider"></div>
  <div class="mob-sheet-actions">
    <button class="mob-sheet-btn" style="background:var(--mint);color:var(--navy);" onclick="closeMobSheet();openAddPerson()">&#xff0b; Contact</button>
    <button class="mob-sheet-btn" id="mob-new-donation" style="background:#2798BD;color:#fff;" onclick="closeMobSheet();openDonationModal()">&#xff0b; Donation</button>
    <button class="mob-sheet-btn" style="background:#0E356C;color:#fff;" onclick="closeMobSheet();openNewEventModal()">&#xff0b; Event</button>
  </div>
</div>

<nav class="bottom-nav">
  <button class="bnav-item active" id="bnav-dashboard" onclick="switchView('dashboard')">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
    Home
  </button>
  <button class="bnav-item" id="bnav-constituents" onclick="switchView('constituents')">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
    Contacts
  </button>
  <button class="bnav-item" id="bnav-events" onclick="switchView('events')">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
    Events
  </button>
  <button class="bnav-item" id="bnav-donations" onclick="switchView('donations')">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
    Donations
  </button>
  <button class="bnav-item" id="bnav-more" onclick="openMobSheet()">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>
    More
  </button>
</nav>

<!-- ══════════════════════════════════════════════
     MAIN CONTENT AREA
═══════════════════════════════════════════════ -->
<div class="admin-main">

<header class="hdr" style="position:sticky;top:0;z-index:40;">
  <div class="hdr-search">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    <input id="q" type="text" placeholder="Search name, email, zip…" oninput="refresh();qDropdown(this.value)" onblur="setTimeout(function(){qDropClose()},180)" onkeydown="qDropKey(event)" autocomplete="off"/>
    <div id="q-dropdown" class="q-drop"></div>
  </div>
  <div class="hdr-right">
    <span class="hdr-label">Campaign Admin</span>
  </div>
</header>

<!-- ═══════════ DASHBOARD VIEW ═══════════ -->
<div class="view" id="view-dashboard">
<div class="stats">
  <div class="stat stat-clickable" onclick="goToConstituents('voters')" title="View potential voters">
    <div class="stat-lbl">Potential Voters</div><div class="stat-val accent" id="s-voters">—</div>
  </div>
  <div class="stat stat-clickable" onclick="goToConstituents('all')" title="View all constituents">
    <div class="stat-lbl">Contacts</div><div class="stat-val" id="s-rsvp">—</div>
  </div>
  <div class="stat stat-clickable" onclick="drilldown('Endorsement')" title="View endorsers">
    <div class="stat-lbl">Endorsements</div><div class="stat-val" id="s-endorse">—</div>
  </div>
  <div class="stat" style="background:#78E0C4;">
    <div class="stat-lbl" style="color:#fff;">Days to Election</div>
    <div class="stat-val" id="s-days" style="color:#fff;">—</div>
    <div class="stat-sub" id="s-days-sub"></div>
  </div>
</div>

<!-- ── Campaign Pipeline Summary ── -->
<div class="pipeline-section">
  <div class="pipeline-section-hdr">
    <span class="pipeline-section-title">Campaign Pipeline</span>
    <span class="pipeline-total" id="pipeline-total"></span>
  </div>
  <div class="pipeline-track" id="pipeline-track">
    <span style="font-size:13px;color:var(--dim);font-style:italic;">Loading&hellip;</span>
  </div>
</div>

<!-- ── Fundraising / Donations ── -->
<div class="donation-section" id="donation-section">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
    <span class="donation-hdr-title">Donations</span>
  </div>

  <!-- Goal Progress Strip -->
  <div class="don-goal-strip">
    <div class="don-goal-labels">
      <div>
        <div class="don-goal-raised">$0</div>
        <div class="don-goal-raised-sub">Raised to date</div>
      </div>
      <span class="don-goal-pct">0% of $50,000 goal</span>
      <div style="text-align:right;">
        <span class="don-goal-remain-num">$50,000</span>
        <span class="don-goal-remain">remaining</span>
      </div>
    </div>
    <div class="don-goal-track">
      <div class="don-goal-fill" style="width:0%"></div>
    </div>
  </div>

  <!-- Empty state -->
  <div style="background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:40px 32px;text-align:center;color:var(--dim);">
    <div style="font-size:28px;margin-bottom:12px;opacity:.4;">&#9679;</div>
    <div style="font-size:13px;font-weight:700;color:var(--navy);margin-bottom:6px;">No donation data yet</div>
    <div style="font-size:12px;">Connect Anedot to see live fundraising data here.</div>
  </div>
</div>

<!-- ── Snapshot ── -->
<div class="snapshot">
  <div class="snapshot-hdr">Responses Snapshot</div>
  <div class="snapshot-grid">

    <!-- How to Help -->
    <div class="snap-card">
      <div class="snap-card-title">How Would You Like to Help?</div>
      <div id="help-bars"></div>
    </div>

    <!-- Yes/No questions -->
    <div class="snap-card">
      <div class="snap-card-title">Yes / No Questions</div>
      <div id="yn-bars"></div>
    </div>

    <!-- Zip codes -->
    <div class="snap-card">
      <div class="snap-card-title">Top Zip Codes</div>
      <div id="zip-list"></div>
    </div>

  </div>
</div>


</div><!-- /view-dashboard -->

<!-- ═══════════ PIPELINE VIEW ═══════════ -->
<div class="view view-hidden" id="view-pipeline">
  <div class="pipeline-board-container">
    <div class="pipeline-board" id="pipeline-board">
      <span style="font-size:13px;color:var(--dim);font-style:italic;">Loading&hellip;</span>
    </div>
  </div>
</div>

<!-- ═══════════ CONSTITUENTS VIEW ═══════════ -->
<div class="view view-hidden" id="view-constituents">

<div class="feat-page-hdr">
  <div class="feat-page-title">Contacts</div>
  <div style="display:flex;gap:8px;">
    <button class="feat-page-btn" style="background:var(--bg);color:var(--navy);border:1px solid var(--border);" onclick="openImportContacts()">&#8679; Import</button>
    <button class="feat-page-btn" onclick="openAddPerson()">&#xff0b; New Contact</button>
  </div>
</div>

<!-- ── District Filter ── -->
<div class="district-bar">
  <button class="dist-chip active" id="dist-all" onclick="setDistrict('all')">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
    All Contacts
    <span class="dist-chip-count" id="dist-count-all">—</span>
  </button>
  <button class="dist-chip" id="dist-voters" onclick="setDistrict('voters')">
    Potential Voters
    <span class="dist-chip-count" id="dist-count-voters">—</span>
  </button>
  <button class="dist-chip" id="dist-ood" onclick="setDistrict('ood')">
    Out of District
    <span class="dist-chip-count" id="dist-count-ood">—</span>
  </button>
</div>

<div class="toolbar">
  <span class="tally" id="tally"></span>
</div>

<div class="bulk-bar" id="bulk-bar">
  <span class="bulk-bar-lbl" id="bulk-bar-lbl">0 contacts selected</span>
  <button class="bulk-del-btn" onclick="bulkDelete()">Delete Selected</button>
  <button class="bulk-clr-btn" onclick="clearSelection()">Clear</button>
</div>

<div class="wrap">
<table>
  <thead><tr>
    <th class="cb-th"><input type="checkbox" id="sel-all" onchange="onSelectAll(this.checked)" title="Select all"></th>
    <th>#</th><th>Date</th><th class="th-sortable" id="th-name" onclick="toggleNameSort()" title="Sort by name">Name <span class="sort-arrow" id="sort-arrow-name">↕</span></th><th>Phone</th><th>Address</th>
    <th>Events</th><th>How to Help</th><th>Yard Sign</th><th>Endorsement</th><th>Comment</th>
  </tr></thead>
  <tbody id="tbody"></tbody>
</table>
<div class="empty" id="empty" style="display:none">No submissions yet — they'll appear here as RSVPs come in.</div>
<div style="min-height:200px;"></div>
</div>
</div><!-- /view-constituents -->

<!-- ══════════════ EVENT REGISTRATIONS VIEW ══════════════ -->
<div class="view view-hidden" id="view-events">

  <!-- Header -->
  <div class="feat-page-hdr">
    <div class="feat-page-title">Events</div>
    <div style="display:flex;align-items:center;gap:12px;margin-left:auto;">
      <div class="search">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="evt-q" type="text" placeholder="Search registrations&hellip;" style="width:210px;" oninput="evtSearchQ=this.value.trim().toLowerCase();refreshEvtTable()"/>
      </div>
      <button class="feat-page-btn" style="margin-left:0;" onclick="openNewEventModal()">&#xff0b; New Event</button>
    </div>
  </div>

  <!-- Event filter chips (populated dynamically by buildEvtFilters) -->
  <div class="district-bar" id="evt-filter-bar"></div>

  <!-- Event management cards -->
  <div style="padding:24px 32px 0;">
    <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--dim);font-weight:700;margin-bottom:14px;">Manage Events</div>
    <div id="evt-mgmt-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;margin-bottom:32px;">
      <span style="font-size:13px;color:var(--dim);font-style:italic;">Loading&hellip;</span>
    </div>

    <!-- Registration table -->
    <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:12px;">
      <div id="evt-reg-label" style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--dim);font-weight:700;">All Registrations</div>
      <span id="evt-reg-tally" style="font-size:11px;color:var(--muted);font-weight:600;"></span>
      <button class="feat-page-btn" style="margin-left:auto;background:#e9edf3;color:var(--navy);" onclick="exportEventRegs()">&#8595; Export CSV</button>
    </div>
    <div id="evt-reg-table-wrap" class="don-table-wrap" style="margin-bottom:40px;">
      <table>
        <thead><tr>
          <th>Date</th><th>Name</th><th>Event</th><th>Parish</th><th>Guests</th><th>Yard Sign</th><th>How to Help</th>
        </tr></thead>
        <tbody id="evt-reg-tbody"></tbody>
      </table>
    </div>
  </div>

</div><!-- /view-events -->

<!-- ── Event CRUD Modal ── -->
<div class="modal-overlay" id="evt-modal-overlay" onclick="if(event.target===this)closeEventModal()">
  <div class="modal" style="max-width:560px;">
    <button class="modal-close" onclick="closeEventModal()">&#215;</button>
    <div class="modal-title" id="evt-modal-title">New Event</div>

    <input type="hidden" id="evt-edit-id"/>

    <div class="modal-field">
      <label class="modal-label" for="evt-f-title">Event Title <span style="color:#c0392b">*</span></label>
      <input class="modal-input" id="evt-f-title" type="text" placeholder="Meet &amp; Greet — Old Metairie"/>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
      <div class="modal-field">
        <label class="modal-label" for="evt-f-date">Date</label>
        <input class="modal-input" id="evt-f-date" type="date"/>
      </div>
      <div class="modal-field">
        <label class="modal-label" for="evt-f-capacity">Capacity (optional)</label>
        <input class="modal-input" id="evt-f-capacity" type="number" min="1" placeholder="Unlimited"/>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
      <div class="modal-field">
        <label class="modal-label">Start Time</label>
        <div class="time-chips" id="start-chips">
          <button type="button" class="time-chip" data-val="5:00 PM" onclick="setTimeChip('start','5:00 PM')">5 PM</button>
          <button type="button" class="time-chip" data-val="5:30 PM" onclick="setTimeChip('start','5:30 PM')">5:30 PM</button>
          <button type="button" class="time-chip" data-val="6:00 PM" onclick="setTimeChip('start','6:00 PM')">6 PM</button>
          <button type="button" class="time-chip" data-val="6:30 PM" onclick="setTimeChip('start','6:30 PM')">6:30 PM</button>
          <button type="button" class="time-chip" data-val="7:00 PM" onclick="setTimeChip('start','7:00 PM')">7 PM</button>
          <button type="button" class="time-chip" data-val="8:00 PM" onclick="setTimeChip('start','8:00 PM')">8 PM</button>
        </div>
        <input class="modal-input" id="evt-f-time" type="text" placeholder="or type a custom time…" style="font-size:12px;" oninput="syncTimeChips()"/>
      </div>
      <div class="modal-field">
        <label class="modal-label">End Time</label>
        <div class="time-chips" id="end-chips">
          <button type="button" class="time-chip" data-val="7:00 PM" onclick="setTimeChip('end','7:00 PM')">7 PM</button>
          <button type="button" class="time-chip" data-val="7:30 PM" onclick="setTimeChip('end','7:30 PM')">7:30 PM</button>
          <button type="button" class="time-chip" data-val="8:00 PM" onclick="setTimeChip('end','8:00 PM')">8 PM</button>
          <button type="button" class="time-chip" data-val="8:30 PM" onclick="setTimeChip('end','8:30 PM')">8:30 PM</button>
          <button type="button" class="time-chip" data-val="9:00 PM" onclick="setTimeChip('end','9:00 PM')">9 PM</button>
          <button type="button" class="time-chip" data-val="10:00 PM" onclick="setTimeChip('end','10:00 PM')">10 PM</button>
        </div>
        <input class="modal-input" id="evt-f-end-time" type="text" placeholder="or type a custom time…" style="font-size:12px;" oninput="syncTimeChips()"/>
      </div>
    </div>
    <div class="modal-field">
      <label class="modal-label" for="evt-f-location">Location</label>
      <input class="modal-input" id="evt-f-location" type="text" placeholder="The Ridgeway, Old Metairie"/>
    </div>
    <div class="modal-field">
      <label class="modal-label" for="evt-f-desc">Description</label>
      <textarea class="modal-input" id="evt-f-desc" rows="3" style="resize:vertical;" placeholder="Optional details about this event…"></textarea>
    </div>

    <!-- Registration Form Fields -->
    <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border);">
      <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--dim);font-weight:700;margin-bottom:12px;">Registration Form Fields</div>
      <div style="font-size:11px;color:var(--dim);margin-bottom:12px;">Name is always collected. Select additional fields to show on the registration form.</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--navy);cursor:pointer;padding:8px 10px;border:1px solid var(--border);border-radius:6px;">
          <input type="checkbox" id="ef-email" checked style="width:15px;height:15px;accent-color:var(--mint-d);cursor:pointer;"/>
          Email Address
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--navy);cursor:pointer;padding:8px 10px;border:1px solid var(--border);border-radius:6px;">
          <input type="checkbox" id="ef-phone" checked style="width:15px;height:15px;accent-color:var(--mint-d);cursor:pointer;"/>
          Phone Number
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--navy);cursor:pointer;padding:8px 10px;border:1px solid var(--border);border-radius:6px;">
          <input type="checkbox" id="ef-address" checked style="width:15px;height:15px;accent-color:var(--mint-d);cursor:pointer;"/>
          Home Address
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--navy);cursor:pointer;padding:8px 10px;border:1px solid var(--border);border-radius:6px;">
          <input type="checkbox" id="ef-guests" checked style="width:15px;height:15px;accent-color:var(--mint-d);cursor:pointer;"/>
          Number of Guests
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--navy);cursor:pointer;padding:8px 10px;border:1px solid var(--border);border-radius:6px;">
          <input type="checkbox" id="ef-yard_sign" checked style="width:15px;height:15px;accent-color:var(--mint-d);cursor:pointer;"/>
          Yard Sign Interest
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--navy);cursor:pointer;padding:8px 10px;border:1px solid var(--border);border-radius:6px;">
          <input type="checkbox" id="ef-endorse" checked style="width:15px;height:15px;accent-color:var(--mint-d);cursor:pointer;"/>
          Willing to Endorse
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--navy);cursor:pointer;padding:8px 10px;border:1px solid var(--border);border-radius:6px;">
          <input type="checkbox" id="ef-how_to_help" checked style="width:15px;height:15px;accent-color:var(--mint-d);cursor:pointer;"/>
          Ways to Get Involved
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--navy);cursor:pointer;padding:8px 10px;border:1px solid var(--border);border-radius:6px;">
          <input type="checkbox" id="ef-comment" checked style="width:15px;height:15px;accent-color:var(--mint-d);cursor:pointer;"/>
          Message / Comment
        </label>
      </div>
    </div>

    <div style="display:flex;gap:10px;margin-top:20px;">
      <button class="modal-btn" onclick="saveEvent()">Save Event</button>
      <button class="modal-btn secondary" onclick="closeEventModal()">Cancel</button>
    </div>
  </div>
</div>

<!-- ── Embed Code Modal ── -->
<div class="modal-overlay" id="evt-embed-overlay" onclick="if(event.target===this)closeEmbedModal()">
  <div class="modal" style="max-width:640px;">
    <button class="modal-close" onclick="closeEmbedModal()">&#215;</button>
    <div class="modal-title">Embed Widget Code</div>
    <div id="evt-embed-label" style="font-size:13px;font-weight:700;color:var(--navy);margin-bottom:4px;"></div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:12px;">Paste this into your Duda widget HTML block.</div>
    <textarea class="modal-code" id="evt-embed-code" readonly style="height:220px;"></textarea>
    <div style="display:flex;gap:10px;margin-top:12px;">
      <button class="modal-copy" onclick="copyEmbedCode()" style="flex:1;">Copy Code</button>
      <button class="modal-copy" id="evt-preview-btn" onclick="openWidgetPreview()" style="flex:0 0 auto;background:#e9edf3;color:var(--navy);">&#128065; Preview</button>
    </div>
  </div>
</div>

<!-- ═══════════ DONATIONS VIEW ═══════════ -->
<div class="view view-hidden" id="view-donations">
  <div class="feat-page-hdr">
    <div class="feat-page-title">Donations</div>
    <a class="feat-page-btn" style="background:#e9edf3;color:var(--navy);margin-right:8px;text-decoration:none;" href="/admin/export/donors.csv" download>&#8595; Export CSV</a>
    <button class="feat-page-btn" onclick="openDonationModal()">&#xff0b; Record Donation</button>
  </div>
  <div class="feat-stat-row">
    <div class="feat-stat"><div class="feat-stat-val accent" id="don-stat-total">—</div><div class="feat-stat-lbl">Total Raised</div></div>
    <div class="feat-stat"><div class="feat-stat-val" id="don-stat-count">—</div><div class="feat-stat-lbl">Donations</div></div>
    <div class="feat-stat"><div class="feat-stat-val" id="don-stat-avg">—</div><div class="feat-stat-lbl">Avg Gift</div></div>
    <div class="feat-stat"><div class="feat-stat-val" id="don-stat-top">—</div><div class="feat-stat-lbl">Largest Gift</div></div>
  </div>
  <div style="padding:24px 32px 0;">
    <!-- Source breakdown bar -->
    <div id="don-source-bar" style="margin-bottom:24px;display:none;">
      <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--dim);font-weight:700;margin-bottom:10px;">By Source</div>
      <div id="don-source-chips" style="display:flex;flex-wrap:wrap;gap:8px;"></div>
    </div>
    <div class="feat-table-wrap" style="margin:0;">
      <table>
        <thead><tr><th>Donor</th><th>Amount</th><th>Date</th><th>Source</th><th>Tender</th><th></th></tr></thead>
        <tbody id="don-tbody"><tr><td colspan="6" class="empty">No donations recorded yet.</td></tr></tbody>
      </table>
    </div>

    <!-- Anedot Integration Panel -->
    <div style="margin-top:32px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      <div style="background:#f7f9fc;padding:14px 20px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;cursor:pointer;" onclick="toggleAnedotPanel()">
        <div style="display:flex;align-items:center;gap:10px;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--navy)" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
          <span style="font-size:12px;font-weight:700;letter-spacing:.5px;color:var(--navy);">ANEDOT INTEGRATION</span>
        </div>
        <span id="anedot-toggle-label" style="font-size:11px;color:var(--dim);">Real-time donation sync via webhook &#9650;</span>
      </div>
      <div style="padding:20px 24px;" id="anedot-panel">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
          <div>
            <p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin:0 0 8px;">Step 1 — Copy your webhook URL</p>
            <div style="display:flex;gap:8px;align-items:center;">
              <code id="anedot-wh-url" style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;padding:8px 12px;font-size:12px;flex:1;color:var(--navy);word-break:break-all;"></code>
              <button onclick="copyAnedotUrl()" style="background:var(--navy);color:#fff;border:none;border-radius:6px;padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;">Copy</button>
            </div>
            <p style="font-size:11px;color:var(--dim);margin:8px 0 0;">Paste this into <strong>Anedot &rarr; Settings &rarr; Webhooks &rarr; URL</strong></p>
          </div>
          <div>
            <p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin:0 0 8px;">Step 2 — Enable these events</p>
            <div style="display:flex;flex-direction:column;gap:6px;">
              <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--navy);"><span style="width:8px;height:8px;border-radius:50%;background:var(--mint-d);display:inline-block;flex-shrink:0;"></span>donation_completed</div>
              <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--navy);"><span style="width:8px;height:8px;border-radius:50%;background:var(--mint-d);display:inline-block;flex-shrink:0;"></span>donation_refunded</div>
            </div>
          </div>
          <div>
            <p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin:0 0 8px;">Step 3 — Set your webhook secret</p>
            <p style="font-size:12px;color:var(--dim);margin:0 0 8px;">Copy the secret Anedot generates, then add it in Railway:</p>
            <code style="display:block;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;padding:8px 12px;font-size:12px;color:var(--navy);">Railway → voteforblaine-admin → Variables → ANEDOT_WEBHOOK_SECRET</code>
            <p style="font-size:11px;color:var(--dim);margin:8px 0 0;">Requests without a matching signature will be rejected.</p>
          </div>
          <div>
            <p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin:0 0 8px;">What gets synced automatically</p>
            <div style="font-size:12px;color:var(--dim);line-height:1.8;">
              &#10003; Donor name &amp; email<br>
              &#10003; Donation amount<br>
              &#10003; Date &amp; source page name<br>
              &#10003; Auto-linked to contact record (by email)<br>
              &#10003; Refunds remove the donation
            </div>
          </div>
        </div>
        <div style="margin-top:16px;padding:12px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:12px;color:#92400e;">
          <strong>Requires a public URL.</strong> Your server must be accessible on the internet for Anedot to reach it. If running locally, use <a href="https://ngrok.com" target="_blank" style="color:#92400e;">ngrok</a> (<code>ngrok http 3002</code>) for testing, or deploy to Railway or Render.
        </div>
      </div>
    </div>
  </div>
</div><!-- /view-donations -->

<!-- ═══════════ VOLUNTEERS VIEW ═══════════ -->
<div class="view view-hidden" id="view-volunteers">
  <div class="feat-page-hdr">
    <div class="feat-page-title">Volunteers</div>
    <a class="feat-page-btn" style="background:#e9edf3;color:var(--navy);margin-right:4px;text-decoration:none;" href="/admin/export/volunteers.csv" download>&#8595; CSV</a>
    <a class="feat-page-btn" style="background:#e9edf3;color:var(--navy);margin-right:4px;text-decoration:none;" href="/admin/export/volunteers.csv" onclick="exportAsExcel(event,'Volunteers')">&#8595; Excel</a>
    <a class="feat-page-btn" style="background:#e9edf3;color:var(--navy);margin-right:8px;text-decoration:none;" href="#" onclick="exportAsPdf(event,'Volunteers','/admin/export/volunteers.csv')">&#8595; PDF</a>
    <button class="feat-page-btn" onclick="openAddVolunteerModal()">&#xff0b; Add Volunteer</button>
  </div>
  <div class="feat-stat-row" id="vol-stats-row">
    <div class="feat-stat"><div class="feat-stat-val" id="vs-total">—</div><div class="feat-stat-lbl">Total Volunteers</div></div>
    <div class="feat-stat"><div class="feat-stat-val accent" id="vs-active">—</div><div class="feat-stat-lbl">Active</div></div>
    <div class="feat-stat"><div class="feat-stat-val" id="vs-hours">—</div><div class="feat-stat-lbl">Hours Logged</div></div>
    <div class="feat-stat"><div class="feat-stat-val" id="vs-unscheduled">—</div><div class="feat-stat-lbl">Unscheduled</div></div>
  </div>
  <div class="feat-table-wrap">
    <table>
      <thead><tr><th>Name</th><th>Role</th><th>Hours</th><th>Status</th><th>Contact</th><th></th></tr></thead>
      <tbody id="vol-tbody"><tr><td colspan="6" class="empty">No volunteers yet — add one to get started.</td></tr></tbody>
    </table>
  </div>
</div>

<!-- ═══════════ ENDORSEMENTS VIEW ═══════════ -->
<div class="view view-hidden" id="view-endorsements">
  <div class="feat-page-hdr">
    <div class="feat-page-title">Endorsements</div>
    <button class="feat-page-btn" onclick="openAddEndorsementModal()">&#xff0b; Add Endorsement</button>
  </div>
  <div class="feat-stat-row">
    <div class="feat-stat"><div class="feat-stat-val" id="es-total">—</div><div class="feat-stat-lbl">Total</div></div>
    <div class="feat-stat"><div class="feat-stat-val accent" id="es-endorsed">—</div><div class="feat-stat-lbl">Endorsed</div></div>
    <div class="feat-stat"><div class="feat-stat-val" id="es-pending">—</div><div class="feat-stat-lbl">In Progress</div></div>
    <div class="feat-stat"><div class="feat-stat-val" id="es-new">—</div><div class="feat-stat-lbl">Not Contacted</div></div>
  </div>
  <div class="feat-table-wrap">
    <table>
      <thead><tr><th>Name / Organization</th><th>Tier</th><th>Status</th><th>Date</th><th>Notes</th><th></th></tr></thead>
      <tbody id="end-tbody"><tr><td colspan="6" class="empty">No endorsements tracked yet.</td></tr></tbody>
    </table>
  </div>
</div>

<!-- ═══════════ CANVASSING VIEW ═══════════ -->
<div class="view view-hidden" id="view-canvassing">
  <div class="feat-page-hdr">
    <div class="feat-page-title">Walk Lists &amp; Canvassing</div>
    <button class="feat-page-btn" onclick="openAddListModal()">&#xff0b; New Walk List</button>
  </div>
  <div class="feat-stat-row">
    <div class="feat-stat"><div class="feat-stat-val" id="cs-lists">—</div><div class="feat-stat-lbl">Active Lists</div></div>
    <div class="feat-stat"><div class="feat-stat-val" id="cs-doors">—</div><div class="feat-stat-lbl">Total Doors</div></div>
    <div class="feat-stat"><div class="feat-stat-val accent" id="cs-knocked">—</div><div class="feat-stat-lbl">Knocked</div></div>
    <div class="feat-stat"><div class="feat-stat-val" id="cs-favorable">—</div><div class="feat-stat-lbl">Favorable <span style="font-size:13px;font-weight:600;color:var(--dim);" id="cs-rate"></span></div></div>
  </div>
  <!-- Walk lists table -->
  <div style="padding:0 32px 16px;">
    <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--dim);font-weight:700;margin-bottom:10px;">Walk Lists</div>
    <div id="canvas-lists-wrap" class="feat-table-wrap" style="margin-bottom:28px;">
      <table>
        <thead><tr><th>List Name</th><th>Area</th><th>Assigned To</th><th>Doors</th><th>Progress</th><th>Favorable</th><th></th></tr></thead>
        <tbody id="canvas-lists-tbody"><tr><td colspan="7" class="empty">No walk lists yet.</td></tr></tbody>
      </table>
    </div>
    <!-- Door log for selected list -->
    <div id="canvas-doors-section" style="display:none;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
        <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--dim);font-weight:700;" id="canvas-door-list-name">Doors</div>
        <button onclick="openAddDoorModal()" style="font-size:9px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;background:var(--mint);color:var(--navy);border:none;border-radius:2px;padding:5px 12px;cursor:pointer;">&#xff0b; Add Door</button>
        <button onclick="openImportModal()" style="font-size:9px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;background:var(--navy);color:#fff;border:none;border-radius:2px;padding:5px 12px;cursor:pointer;">&#8679; Import CSV</button>
        <button onclick="closeDoorSection()" style="font-size:9px;font-weight:700;color:var(--dim);background:none;border:none;cursor:pointer;margin-left:auto;">&#x2715; Close</button>
      </div>
      <!-- Door grid visualization -->
      <div id="canvas-door-grid" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:14px;"></div>
      <div class="feat-table-wrap">
        <table>
          <thead><tr><th>Address</th><th>Voter Name</th><th>Result</th><th>Volunteer</th><th>Notes</th><th></th></tr></thead>
          <tbody id="canvas-doors-tbody"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ═══════════ COMPLIANCE VIEW ═══════════ -->
<div class="view view-hidden" id="view-compliance">
  <div class="feat-page-hdr">
    <div class="feat-page-title">Compliance Dashboard</div>
  </div>
  <div style="padding:0 32px 40px;max-width:780px;">
    <div style="font-size:11px;color:var(--muted);line-height:1.7;margin-bottom:24px;padding:16px 20px;background:var(--white);border:1px solid var(--border);border-radius:4px;">
      <strong style="display:block;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--dim);margin-bottom:6px;">About This Dashboard</strong>
      Louisiana judicial candidates are subject to the ABA Model Code of Judicial Conduct (Canon 4) and Louisiana Code of Judicial Conduct. This checklist surfaces the key compliance areas your campaign must maintain throughout the election cycle.
    </div>
    <div id="compliance-list"></div>
  </div>
</div>

<!-- Event stat drill-down modal -->
<div class="evt-drill-overlay" id="evtDrillOverlay" onclick="if(event.target===this)closeEvtDrill()">
  <div class="evt-drill-box">
    <div class="evt-drill-hdr">
      <div class="evt-drill-ttl" id="evtDrillTitle"></div>
      <button class="evt-drill-export" onclick="exportEvtDrill()">&#8595; Export CSV</button>
      <button class="evt-drill-close" onclick="closeEvtDrill()">&times;</button>
    </div>
    <div class="evt-drill-list" id="evtDrillList"></div>
  </div>
</div>

<!-- ── Exports Modal ── -->
<div class="exp-overlay" id="exp-overlay" onclick="if(event.target===this)closeExportModal()">
  <div class="exp-modal">
    <button class="modal-close" onclick="closeExportModal()">&#215;</button>
    <p style="font-size:9px;letter-spacing:2.5px;text-transform:uppercase;color:var(--mint-d);font-weight:700;margin:0 0 6px;">Campaign Data</p>
    <div class="modal-title" style="margin-bottom:20px;">Export</div>
    <div class="exp-row">
      <span class="exp-lbl">Contacts</span>
      <span class="exp-btns">
        <a class="exp-btn" href="/admin/export.csv" download>CSV</a>
        <a class="exp-btn" href="/admin/export.csv" download onclick="exportAsExcel(event,'Contacts')">Excel</a>
        <a class="exp-btn" href="#" onclick="exportAsPdf(event,'Contacts','/admin/export.csv')">PDF</a>
      </span>
    </div>
    <div class="exp-row">
      <span class="exp-lbl">Pipeline</span>
      <span class="exp-btns">
        <a class="exp-btn" href="/admin/export/pipeline.csv" download>CSV</a>
        <a class="exp-btn" href="/admin/export/pipeline.csv" download onclick="exportAsExcel(event,'Pipeline')">Excel</a>
        <a class="exp-btn" href="#" onclick="exportAsPdf(event,'Pipeline','/admin/export/pipeline.csv')">PDF</a>
      </span>
    </div>
    <div class="exp-row">
      <span class="exp-lbl">Event Registrations</span>
      <span class="exp-btns">
        <a class="exp-btn" href="/admin/export/event-registrations.csv" download>CSV</a>
        <a class="exp-btn" href="/admin/export/event-registrations.csv" download onclick="exportAsExcel(event,'Event Registrations')">Excel</a>
        <a class="exp-btn" href="#" onclick="exportAsPdf(event,'Event Registrations','/admin/export/event-registrations.csv')">PDF</a>
      </span>
    </div>
    <div class="exp-row" id="exp-row-donors">
      <span class="exp-lbl">Donors</span>
      <span class="exp-btns">
        <a class="exp-btn" href="/admin/export/donors.csv" download>CSV</a>
        <a class="exp-btn" href="/admin/export/donors.csv" download onclick="exportAsExcel(event,'Donors')">Excel</a>
        <a class="exp-btn" href="#" onclick="exportAsPdf(event,'Donors','/admin/export/donors.csv')">PDF</a>
      </span>
    </div>
    <div class="exp-row">
      <span class="exp-lbl">Endorsers</span>
      <span class="exp-btns">
        <a class="exp-btn" href="/admin/export/endorsers.csv" download>CSV</a>
        <a class="exp-btn" href="/admin/export/endorsers.csv" download onclick="exportAsExcel(event,'Endorsers')">Excel</a>
        <a class="exp-btn" href="#" onclick="exportAsPdf(event,'Endorsers','/admin/export/endorsers.csv')">PDF</a>
      </span>
    </div>
    <div class="exp-row">
      <span class="exp-lbl">Volunteers</span>
      <span class="exp-btns">
        <a class="exp-btn" href="/admin/export/volunteers.csv" download>CSV</a>
        <a class="exp-btn" href="/admin/export/volunteers.csv" download onclick="exportAsExcel(event,'Volunteers')">Excel</a>
        <a class="exp-btn" href="#" onclick="exportAsPdf(event,'Volunteers','/admin/export/volunteers.csv')">PDF</a>
      </span>
    </div>
  </div>
</div>

<!-- ── New Donation Modal ── -->
<div class="modal-overlay" id="don-modal-overlay" onclick="if(event.target===this)closeDonationModal()" style="display:none;position:fixed;inset:0;z-index:100;background:rgba(9,37,79,.6);align-items:center;justify-content:center;padding:20px;">
  <div class="modal" style="max-width:420px;padding:32px 36px;">
    <button class="modal-close" onclick="closeDonationModal()">&#215;</button>
    <p style="font-size:9px;letter-spacing:2.5px;text-transform:uppercase;color:var(--mint-d);font-weight:700;margin:0 0 6px;">Campaign Finance</p>
    <div class="modal-title" style="margin-bottom:20px;">Record Donation</div>
    <div class="modal-field">
      <label class="modal-label">Donor Name</label>
      <div class="don-ac-wrap">
        <input class="modal-input" id="don-name" type="text" placeholder="Search existing contacts…" autocomplete="off" oninput="donAcSearch(this.value)" onkeydown="donAcKey(event)"/>
        <div class="don-ac-drop" id="don-ac-drop"></div>
      </div>
      <input type="hidden" id="don-contact-id"/>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div class="modal-field" style="margin-bottom:0;">
        <label class="modal-label">Amount ($)</label>
        <input class="modal-input" id="don-amount" type="number" min="0" step="0.01" placeholder="0.00"/>
      </div>
      <div class="modal-field" style="margin-bottom:0;">
        <label class="modal-label">Date</label>
        <input class="modal-input" id="don-date" type="date"/>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px;">
      <div class="modal-field" style="margin-bottom:0;">
        <label class="modal-label">Source</label>
        <input class="modal-input" id="don-source" type="text" placeholder="Direct, Kick-Off Party…"/>
      </div>
      <div class="modal-field" style="margin-bottom:0;">
        <label class="modal-label">Tender Type</label>
        <select class="modal-input" id="don-tender" onchange="donTenderChange(this.value)" style="cursor:pointer;">
          <option value="">— Select —</option>
          <option value="Credit/Debit Card">Credit / Debit Card</option>
          <option value="Check">Check</option>
          <option value="Cash">Cash</option>
          <option value="Online/ACH">Online / ACH</option>
          <option value="Anedot">Anedot</option>
          <option value="Other">Other</option>
        </select>
      </div>
    </div>
    <div class="modal-field" id="don-check-row" style="margin-top:14px;display:none;">
      <label class="modal-label">Check Number</label>
      <input class="modal-input" id="don-check-num" type="text" placeholder="e.g. 1042"/>
    </div>
    <div style="display:flex;gap:10px;margin-top:24px;">
      <button class="modal-btn" onclick="saveDonation()" style="flex:1;">Save Donation</button>
      <button class="modal-btn secondary" onclick="closeDonationModal()">Cancel</button>
    </div>
    <div id="don-save-msg" style="display:none;margin-top:12px;font-size:11px;color:var(--mint-d);text-align:center;font-weight:700;letter-spacing:.5px;">&#10003; Donation recorded</div>
  </div>
</div>

<!-- ── Election Intelligence ── -->
<div class="election-bar">
  <div class="elec-title-block">
    <div class="elec-title-eyebrow">24th JDC &middot; Jefferson Parish</div>
    <div class="elec-title-name">Judge, Division H</div>
  </div>
  <div class="elec-block">
    <div class="elec-lbl">Registered Voters</div>
    <div class="elec-val accent">272,489</div>
    <div class="elec-sub">Jefferson Parish electorate</div>
  </div>
  <div class="elec-block">
    <div class="elec-lbl">Est. Turnout</div>
    <div class="elec-val">30&ndash;40%</div>
    <div class="elec-sub">~82k&ndash;109k votes &middot; Nov General</div>
  </div>
  <div class="elec-block">
    <div class="elec-lbl">Votes to Win</div>
    <div class="elec-val accent">~41,000</div>
    <div class="elec-sub">Simple majority of votes cast</div>
  </div>
  <div class="elec-block">
    <div class="elec-lbl">Election Day</div>
    <div class="elec-val">Nov 3</div>
    <div class="elec-sub">2026 General Election</div>
  </div>
  <div class="elec-source">LA Sec. of State &middot; Oct 2024</div>
</div>

</div><!-- /admin-main -->

<!-- ── Drill-down Modal ── -->
<!-- ── Add Person Modal ── -->
<!-- ── Add Person Sidebar ── -->
<div class="ap-overlay" id="ap-overlay" onclick="closeAddPerson()"></div>
<div class="ap-drawer" id="ap-drawer">
  <div class="ap-drawer-hdr">
    <div class="ap-drawer-title">Add New Constituent</div>
    <button class="ap-drawer-close" onclick="closeAddPerson()">&#215;</button>
  </div>
  <div class="ap-drawer-body">
    <div class="ap-row ap-row-2">
      <div class="ap-field">
        <label class="ap-label" for="ap-first">First Name *</label>
        <input class="ap-input" id="ap-first" type="text" placeholder="First name"/>
      </div>
      <div class="ap-field">
        <label class="ap-label" for="ap-last">Last Name *</label>
        <input class="ap-input" id="ap-last" type="text" placeholder="Last name"/>
      </div>
    </div>
    <div class="ap-row ap-row-2">
      <div class="ap-field">
        <label class="ap-label" for="ap-email">Email</label>
        <input class="ap-input" id="ap-email" type="email" placeholder="email@example.com"/>
      </div>
      <div class="ap-field">
        <label class="ap-label" for="ap-phone">Phone</label>
        <input class="ap-input" id="ap-phone" type="tel" placeholder="(504) 555-0000"/>
      </div>
    </div>
    <div class="ap-field">
      <label class="ap-label" for="ap-company">Company / Organization</label>
      <input class="ap-input" id="ap-company" type="text" placeholder="Law firm, employer, organization…"/>
    </div>
    <div class="ap-field ap-addr-wrap">
      <label class="ap-label" for="ap-address">Street Address</label>
      <input class="ap-input" id="ap-address" type="text" placeholder="123 Main St" autocomplete="off"/>
      <div class="ap-suggest" id="ap-addr-suggest"></div>
    </div>
    <div class="ap-row ap-row-3">
      <div class="ap-field">
        <label class="ap-label" for="ap-city">City</label>
        <input class="ap-input" id="ap-city" type="text" placeholder="Metairie"/>
      </div>
      <div class="ap-field">
        <label class="ap-label" for="ap-state">State</label>
        <select class="ap-input" id="ap-state">
          <option value="LA" selected>Louisiana</option>
          <option value="AL">Alabama</option><option value="AK">Alaska</option><option value="AZ">Arizona</option><option value="AR">Arkansas</option><option value="CA">California</option><option value="CO">Colorado</option><option value="CT">Connecticut</option><option value="DE">Delaware</option><option value="FL">Florida</option><option value="GA">Georgia</option><option value="HI">Hawaii</option><option value="ID">Idaho</option><option value="IL">Illinois</option><option value="IN">Indiana</option><option value="IA">Iowa</option><option value="KS">Kansas</option><option value="KY">Kentucky</option><option value="ME">Maine</option><option value="MD">Maryland</option><option value="MA">Massachusetts</option><option value="MI">Michigan</option><option value="MN">Minnesota</option><option value="MS">Mississippi</option><option value="MO">Missouri</option><option value="MT">Montana</option><option value="NE">Nebraska</option><option value="NV">Nevada</option><option value="NH">New Hampshire</option><option value="NJ">New Jersey</option><option value="NM">New Mexico</option><option value="NY">New York</option><option value="NC">North Carolina</option><option value="ND">North Dakota</option><option value="OH">Ohio</option><option value="OK">Oklahoma</option><option value="OR">Oregon</option><option value="PA">Pennsylvania</option><option value="RI">Rhode Island</option><option value="SC">South Carolina</option><option value="SD">South Dakota</option><option value="TN">Tennessee</option><option value="TX">Texas</option><option value="UT">Utah</option><option value="VT">Vermont</option><option value="VA">Virginia</option><option value="WA">Washington</option><option value="WV">West Virginia</option><option value="WI">Wisconsin</option><option value="WY">Wyoming</option>
        </select>
      </div>
      <div class="ap-field">
        <label class="ap-label" for="ap-zip">Zip</label>
        <input class="ap-input" id="ap-zip" type="text" placeholder="70001"/>
      </div>
    </div>
    <div class="ap-field">
      <label class="ap-label">Role</label>
      <div class="ap-check-group">
        <label class="ap-check-label"><input type="checkbox" id="ap-role-voter" style="accent-color:#78E0C4;"/> Voter</label>
        <label class="ap-check-label"><input type="checkbox" id="ap-role-committee" style="accent-color:#78E0C4;"/> Committee Member</label>
        <label class="ap-check-label"><input type="checkbox" id="ap-role-attorney" style="accent-color:#d4a843;"/> Attorney</label>
      </div>
    </div>
    <div class="ap-field">
      <label class="ap-label" for="ap-comment">Notes</label>
      <textarea class="ap-input" id="ap-comment" placeholder="Optional notes…" style="height:90px;resize:vertical;line-height:1.5;"></textarea>
    </div>
    <div class="ap-error" id="ap-error">Please enter first and last name.</div>
  </div>
  <div class="ap-drawer-footer">
    <button class="ap-drawer-cancel" onclick="closeAddPerson()">Cancel</button>
    <button class="ap-drawer-submit" id="ap-submit" onclick="submitAddPerson()">Add to Database</button>
  </div>
</div>

<div class="modal-overlay" id="drill-overlay" onclick="handleDrillOverlayClick(event)">
  <div class="modal" style="max-width:700px;">
    <button class="modal-close" onclick="closeDrill()">&#215;</button>
    <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:20px;">
      <div>
        <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--dim);font-weight:700;margin-bottom:4px;">How to Help — Filtered View</div>
        <div class="modal-title" id="drill-title" style="margin-bottom:0;font-size:20px;"></div>
      </div>
      <span id="drill-count" style="font-size:12px;color:var(--dim);"></span>
      <button class="drill-export-btn" onclick="exportDrillCSV()" style="margin-left:auto;">Export CSV</button>
    </div>
    <div class="drill-table-wrap">
      <table>
        <thead><tr>
          <th>Date</th><th>Name</th><th>Phone</th><th>Zip</th><th>Event</th>
        </tr></thead>
        <tbody id="drill-tbody"></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ── Yard Sign Tracker Modal ── -->
<div class="modal-overlay" id="signs-overlay" onclick="handleSignsOverlayClick(event)">
  <div class="modal" style="max-width:760px;">
    <button class="modal-close" onclick="closeSignsModal()">&#215;</button>
    <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--dim);font-weight:700;margin-bottom:6px;">Yard Sign Tracker</div>
    <div class="signs-summary">
      <div class="signs-sum-block">
        <div class="signs-sum-num" id="sm-requested">—</div>
        <div class="signs-sum-lbl">Requested</div>
      </div>
      <div class="signs-sum-block">
        <div class="signs-sum-num accent" id="sm-delivered">—</div>
        <div class="signs-sum-lbl">Delivered</div>
      </div>
      <div class="signs-sum-block">
        <div class="signs-sum-num" id="sm-pending" style="color:var(--muted);">—</div>
        <div class="signs-sum-lbl">Pending</div>
      </div>
      <button class="drill-export-btn" onclick="exportSignsCSV()" style="margin-left:auto;align-self:flex-start;margin-top:4px;">Export CSV</button>
    </div>
    <div class="signs-table-wrap">
      <table>
        <thead><tr>
          <th>Date</th><th>Name</th><th>Phone</th><th>Address</th><th>Zip</th><th>Event</th><th>Status</th>
        </tr></thead>
        <tbody id="signs-tbody"></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ── Import Contacts Modal ── -->
<div class="modal-overlay" id="import-contacts-overlay" onclick="if(event.target===this)closeImportContacts()">
  <div class="modal" style="max-width:700px;">
    <button class="modal-close" onclick="closeImportContacts()">&#215;</button>
    <div class="modal-title">Import Contacts</div>

    <div style="display:flex;gap:6px;margin-bottom:20px;" id="import-tab-bar">
      <button class="dist-chip active" id="itab-file" onclick="switchImportTab('file')" style="text-transform:none;">&#128196; Upload File (.xlsx / .csv)</button>
      <button class="dist-chip" id="itab-paste" onclick="switchImportTab('paste')" style="text-transform:none;">&#128203; Paste from Google Sheets</button>
    </div>

    <!-- File upload panel -->
    <div id="import-panel-file">
      <div id="import-drop-zone" ondragover="event.preventDefault();this.classList.add('dragover')" ondragleave="this.classList.remove('dragover')" ondrop="event.preventDefault();this.classList.remove('dragover');handleImportFile(event.dataTransfer.files[0])"
           style="border:2px dashed var(--border);border-radius:6px;padding:36px;text-align:center;cursor:pointer;transition:border-color .15s;background:var(--bg);"
           onclick="document.getElementById('import-file-input').click()">
        <div style="font-size:28px;margin-bottom:8px;">&#128196;</div>
        <div style="font-size:13px;font-weight:700;color:var(--navy);margin-bottom:4px;">Drop file here or click to browse</div>
        <div style="font-size:11px;color:var(--dim);">Supports .xlsx (Excel) and .csv</div>
      </div>
      <input type="file" id="import-file-input" accept=".xlsx,.xls,.csv,.tsv" style="display:none;" onchange="handleImportFile(this.files[0])"/>
    </div>

    <!-- Paste panel -->
    <div id="import-panel-paste" style="display:none;">
      <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">In Google Sheets, select your cells (include headers), copy, then paste below.</div>
      <textarea id="import-paste-area" placeholder="Paste spreadsheet data here…"
        style="width:100%;height:160px;border:1.5px solid var(--border);border-radius:4px;padding:10px;font-size:12px;font-family:monospace;resize:vertical;outline:none;"
        oninput="importPastePreview()"></textarea>
    </div>

    <!-- Preview section -->
    <div id="import-preview" style="display:none;margin-top:20px;">
      <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--dim);font-weight:700;margin-bottom:10px;">Column Mapping</div>
      <div id="import-col-map" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;"></div>
      <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--dim);font-weight:700;margin-bottom:8px;">Preview <span id="import-preview-count"></span></div>
      <div style="overflow-x:auto;max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;">
        <table id="import-preview-table" style="width:100%;border-collapse:collapse;font-size:12px;"></table>
      </div>
      <div style="margin-top:16px;display:flex;align-items:center;gap:12px;">
        <button class="modal-btn" id="import-run-btn" onclick="runContactImport()">Import Contacts</button>
        <span id="import-status" style="font-size:12px;color:var(--muted);"></span>
      </div>
    </div>
  </div>
</div>

<!-- ── New Event Modal ── -->
<div class="modal-overlay" id="modal-overlay" onclick="handleOverlayClick(event)">
  <div class="modal">
    <button class="modal-close" onclick="closeModal()">&#215;</button>
    <div class="modal-title">New Event Widget</div>

    <div class="modal-field">
      <label class="modal-label" for="m-label">Event Label</label>
      <input class="modal-input" id="m-label" type="text" placeholder="Meet &amp; Greet &mdash; August 5, 2026" oninput="updateWidget()"/>
    </div>
    <div class="modal-field">
      <label class="modal-label" for="m-date">Display Date</label>
      <input class="modal-input" id="m-date" type="text" placeholder="August 5, 2026" oninput="updateWidget()"/>
    </div>
    <div class="modal-field">
      <label class="modal-label" for="m-time">Time</label>
      <input class="modal-input" id="m-time" type="text" placeholder="6&ndash;8 PM" oninput="updateWidget()"/>
    </div>
    <div class="modal-field">
      <label class="modal-label" for="m-location">Location</label>
      <input class="modal-input" id="m-location" type="text" placeholder="The Ridgeway, Old Metairie" oninput="updateWidget()"/>
    </div>

    <label class="modal-label" style="margin-top:8px;">Generated Widget HTML</label>
    <textarea class="modal-code" id="m-code" readonly></textarea>
    <button class="modal-copy" onclick="copyWidget()">Copy Widget Code</button>
  </div>
</div>

<script>
var BM_CRM_BASE_URL = '${baseUrl || process.env.PUBLIC_URL || "http://localhost:3002"}';
var IS_CANDIDATE = ${isCand};   // candidate view = no financial data
var all = [];
var selectedIds = new Set();
var nameSortDir  = null;    // null | 'asc' | 'desc'
var activeEvent    = null;
var activeDistrict = 'all'; // 'voters' | 'ood' | 'all'
var activeEvtFilter = 'all';   // 'all' | event title string
var evtSearchQ      = '';

// True for actual event registrations (excludes manually-added contacts)
function isEvtReg(r) { return r.event && r.event !== 'Manual Entry'; }

function isVoter(r)  { return r.parish === 'Jefferson'; }
function isOOD(r)    { return r.parish && r.parish !== 'Jefferson'; }

function setDistrict(d) {
  activeDistrict = d;
  ['voters','ood','all'].forEach(function(k){
    document.getElementById('dist-'+k).classList.toggle('active', k === d);
  });
  refresh();
}

function loadData() {
  fetch('/admin/data').then(r=>r.json()).then(function(d){
    all = d;
    refresh();
  });
}
loadData();

// ── Event card delegated click handler (attached once at load) ────────
// Replaces inline onclick on dynamically-generated event cards.
// Catches clicks that bubble up from any button with data-action inside evt-mgmt-grid.
(function() {
  var grid = document.getElementById('evt-mgmt-grid');
  if (!grid) return;
  grid.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.dataset.action;
    var id = Number(btn.dataset.eid);
    if (!id) return;
    if (action === 'edit')  { evtEdit(id);  return; }
    if (action === 'embed') { evtEmbed(id); return; }
    if (action === 'del')   { evtDel(id);   return; }
  });
})();

var HELP_OPTIONS = [
  'Yard Sign',
  'Make phone calls',
  'Knock on doors',
  'Wave signs',
  'Run errands for the committee',
  'Host a meet & greet or other event',
  'In-kind contribution or venue space',
  'Other — contact me directly'
];
// Legacy label aliases for counting old data
var HELP_ALIASES = {
  'Make phone calls':                   ['Make Phone Calls'],
  'Knock on doors':                     ['Knock on Doors'],
  'Wave signs':                         ['Sign Wave', 'Wave Signs'],
  'Run errands for the committee':      ['Run Errands for Committee'],
  'Host a meet & greet or other event': ['Host a Meet & Greet or Event'],
  'In-kind contribution or venue space':['In-Kind Contribution or Venue Space'],
  'Other — contact me directly':        ['Other', 'Other - contact me directly']
};

function filtered() {
  var base = activeEvent ? all.filter(function(r){ return r.event === activeEvent; }) : all;
  if (activeDistrict === 'voters') return base.filter(isVoter);
  if (activeDistrict === 'ood')    return base.filter(isOOD);
  return base;
}

function refresh() {
  // Update district chip counts (always off the full set, ignoring event filter)
  var voterCount = all.filter(isVoter).length;
  var oodCount   = all.filter(isOOD).length;
  document.getElementById('dist-count-voters').textContent = voterCount;
  document.getElementById('dist-count-ood').textContent    = oodCount;
  document.getElementById('dist-count-all').textContent    = all.length;

  var d  = filtered();
  var q  = document.getElementById('q').value.toLowerCase();
  var fd = q ? d.filter(function(r){
    return ['first_name','last_name','email','phone','zip','comment']
      .some(function(f){ return r[f]&&r[f].toLowerCase().includes(q); });
  }) : d;
  // Auto-switch to Contacts view when searching
  if (q) switchView('constituents');
  stats(all);                    // dashboard stats always use full dataset
  snapshot(d);
  buildPipelineSummary(all.filter(isVoter));   // pipeline summary = voters only
  buildPipelineBoard(all.filter(isVoter));     // pipeline board   = voters only
  render(fd);
}


function stats(d) {
  document.getElementById('s-rsvp').textContent    = d.length;
  var voters  = d.filter(function(r){ return r.parish === 'Jefferson'; });
  var ood     = d.filter(function(r){ return r.parish && r.parish !== 'Jefferson'; });
  document.getElementById('s-voters').textContent  = voters.length;
  var oodEl = document.getElementById('s-rsvp-sub');
  if (oodEl) oodEl.textContent = ood.length ? ood.length + ' out of district' : '';
  var gEl = document.getElementById('s-guests'); if (gEl) gEl.textContent = d.reduce(function(s,r){ return s+(parseInt(r.guests)||1); },0);
  var signReqs = d.filter(function(r){ return r.yard_sign==='Yes'; });
  var signDel  = signReqs.filter(function(r){ return r.yard_sign_delivered==='Yes'; });
  var sEl2 = document.getElementById('s-signs'); if (sEl2) sEl2.textContent = signReqs.length;
  var sEl3 = document.getElementById('s-signs-del'); if (sEl3) sEl3.textContent = signDel.length + ' of ' + signReqs.length + ' delivered';
  document.getElementById('s-endorse').textContent = d.filter(function(r){ return r.endorse==='Yes'; }).length;
  // Days to election countdown
  (function() {
    var ELECTION = new Date('2026-10-24T00:00:00');
    var now  = new Date();
    var diff = Math.ceil((ELECTION - now) / (1000 * 60 * 60 * 24));
    var dEl  = document.getElementById('s-days');
    var sEl  = document.getElementById('s-days-sub');
    if (dEl) dEl.textContent = diff > 0 ? diff : (diff === 0 ? 'Today!' : 'Passed');
    if (sEl) sEl.textContent = '';
  })();
}

function snapshot(d) {
  // — How to Help bars —
  var helpCounts = {};
  HELP_OPTIONS.forEach(function(o){ helpCounts[o] = 0; });
  d.forEach(function(r){
    if (r.yard_sign === 'Yes') helpCounts['Yard Sign']++;
    if (r.how_to_help && r.how_to_help !== 'None selected') {
      r.how_to_help.split(',').forEach(function(h){
        var t = h.trim();
        if (helpCounts.hasOwnProperty(t)) {
          helpCounts[t]++;
        } else {
          // Check legacy aliases
          Object.keys(HELP_ALIASES).forEach(function(canonical){
            if (HELP_ALIASES[canonical].indexOf(t) > -1) helpCounts[canonical]++;
          });
        }
      });
    }
  });
  var maxHelp = Math.max.apply(null, Object.values(helpCounts)) || 1;
  document.getElementById('help-bars').innerHTML = HELP_OPTIONS.map(function(o){
    var c = helpCounts[o];
    var w = Math.round((c/maxHelp)*100);
    var safe = o.replace(/'/g,"\\'");
    return '<div class="bar-row" data-opt="'+safe+'" onclick="drilldown(this.dataset.opt)" title="View people who selected this">'+
      '<div class="bar-meta"><span class="bar-label">'+o+'</span><span class="bar-count">'+c+'</span></div>'+
      '<div class="bar-track"><div class="bar-fill" style="width:'+w+'%"></div></div>'+
    '</div>';
  }).join('');

  // — Yes/No bars —
  var ynQuestions = [
    { label: 'Yard Sign',    yes: d.filter(function(r){ return r.yard_sign==='Yes'; }).length },
    { label: 'Endorsement',  yes: d.filter(function(r){ return r.endorse==='Yes'; }).length },
    { label: 'Left Comment', yes: d.filter(function(r){ return r.comment&&r.comment.trim(); }).length }
  ];
  document.getElementById('yn-bars').innerHTML = ynQuestions.map(function(q){
    var yesPct = d.length ? Math.round((q.yes/d.length)*100) : 0;
    var noPct  = 100 - yesPct;
    return '<div class="yn-row">'+
      '<span class="yn-label">'+q.label+'</span>'+
      '<div class="yn-bar-wrap">'+
        '<div class="yn-yes" style="width:'+yesPct+'%"></div>'+
        '<div class="yn-no"  style="width:'+noPct+'%"></div>'+
      '</div>'+
      '<span class="yn-pct">'+yesPct+'%</span>'+
    '</div>';
  }).join('');

  // — Zip code list (top 8) —
  var zipMap = {};
  d.forEach(function(r){ if(r.zip){ zipMap[r.zip]=(zipMap[r.zip]||0)+1; } });
  var zips = Object.keys(zipMap).sort(function(a,b){ return zipMap[b]-zipMap[a]; }).slice(0,8);
  var maxZ = zips.length ? zipMap[zips[0]] : 1;
  document.getElementById('zip-list').innerHTML = zips.length
    ? zips.map(function(z){
        var w = Math.round((zipMap[z]/maxZ)*100);
        return '<div class="zip-item">'+
          '<span class="zip-code">'+z+'</span>'+
          '<div class="zip-bar-wrap"><div class="zip-bar" style="width:'+w+'%"></div></div>'+
          '<span class="zip-n">'+zipMap[z]+'</span>'+
        '</div>';
      }).join('')
    : '<span style="font-size:12px;color:var(--dim);font-style:italic">No zip codes yet</span>';
}

function render(d) {
  document.getElementById('tally').textContent = d.length + ' submission' + (d.length!==1?'s':'');
  var tbody = document.getElementById('tbody');
  var empty = document.getElementById('empty');
  clearSelection();
  if (!d.length) { tbody.innerHTML=''; empty.style.display='block'; return; }
  empty.style.display='none';
  // Apply name sort if set
  if (nameSortDir) {
    d = d.slice().sort(function(a, b) {
      var na = ((a.last_name||'') + ' ' + (a.first_name||'')).toLowerCase();
      var nb = ((b.last_name||'') + ' ' + (b.first_name||'')).toLowerCase();
      return nameSortDir === 'asc' ? (na < nb ? -1 : na > nb ? 1 : 0) : (na > nb ? -1 : na < nb ? 1 : 0);
    });
  }
  tbody.innerHTML = d.map(function(r){
    var helps = (r.how_to_help && r.how_to_help!=='None selected')
      ? r.how_to_help.split(',').map(function(h){ return '<span class="tag">'+x(h.trim())+'</span>'; }).join('')
      : '<span class="tag-none">—</span>';
    var sign = r.yard_sign==='Yes'
      ? '<span class="badge badge-yes">Yes</span>'
      : '<span class="badge badge-no">No</span>';
    var date = fmtDate(r.created_at);
    return '<tr data-id="'+r.id+'">'+
      '<td class="cb-td"><input type="checkbox" class="row-cb" data-id="'+r.id+'" onchange="onBulkCheck('+r.id+',this.checked,this)"></td>'+
      '<td class="c-id">'+r.id+'</td>'+
      '<td class="c-date">'+date+'</td>'+
      '<td><a href="/admin/constituent/'+r.id+'" class="c-name" style="text-decoration:none;">'+x(r.first_name)+' '+x(r.last_name)+'</a>'+
          (r.parish && r.parish !== 'Jefferson' ? '<span class="badge-ood" title="Lives in '+x(r.parish)+' Parish — outside the 24th JDC">Out of District</span>' : '')+
          '<div class="c-sub">'+x(r.email)+'</div></td>'+
      '<td class="c-phone">'+fmtPhone(r.phone)+'</td>'+
      '<td style="font-size:12px;color:var(--muted);line-height:1.6;">'+x(r.address)+(r.city?'<br>'+x(r.city)+(r.state?', '+x(r.state):'')+(r.zip?' '+x(r.zip):''):'')+'</td>'+
      (function(){var c=all.filter(function(a){return(a.email&&a.email===r.email?true:(!a.email&&a.first_name===r.first_name&&a.last_name===r.last_name))&&!!a.event;}).length;return '<td>'+(c?'<span class="badge badge-guests">'+c+'</span>':'<span class="tag-none">—</span>')+'</td>';})() +
      '<td>'+helps+'</td>'+
      '<td>'+sign+'</td>'+
      '<td>'+(r.endorse==='Yes'?'<span class="badge badge-yes">Yes</span>':'<span class="badge badge-no">No</span>')+'</td>'+
      '<td class="c-comment">'+x(r.comment)+'</td>'+
    '</tr>';
  }).join('');
}

// ── Bulk selection helpers ─────────────────────────────────────────────
function onBulkCheck(id, checked, el) {
  var tr = el.closest('tr');
  if (checked) { selectedIds.add(id); if (tr) tr.classList.add('row-selected'); }
  else          { selectedIds.delete(id); if (tr) tr.classList.remove('row-selected'); }
  updateBulkBar();
  var allCbs = document.querySelectorAll('.row-cb');
  var checkedCount = document.querySelectorAll('.row-cb:checked').length;
  var sa = document.getElementById('sel-all');
  if (sa) {
    sa.indeterminate = checkedCount > 0 && checkedCount < allCbs.length;
    sa.checked = allCbs.length > 0 && checkedCount === allCbs.length;
  }
}

function onSelectAll(checked) {
  document.querySelectorAll('.row-cb').forEach(function(cb) {
    var id = parseInt(cb.dataset.id, 10);
    cb.checked = checked;
    var tr = cb.closest('tr');
    if (checked) { selectedIds.add(id); if (tr) tr.classList.add('row-selected'); }
    else          { selectedIds.delete(id); if (tr) tr.classList.remove('row-selected'); }
  });
  updateBulkBar();
}

function updateBulkBar() {
  var bar = document.getElementById('bulk-bar');
  var lbl = document.getElementById('bulk-bar-lbl');
  if (!bar) return;
  var n = selectedIds.size;
  if (n > 0) {
    bar.classList.add('on');
    if (lbl) lbl.textContent = n + ' contact' + (n !== 1 ? 's' : '') + ' selected';
  } else {
    bar.classList.remove('on');
  }
}

function clearSelection() {
  selectedIds = new Set();
  document.querySelectorAll('.row-cb').forEach(function(cb) {
    cb.checked = false;
    var tr = cb.closest('tr');
    if (tr) tr.classList.remove('row-selected');
  });
  var sa = document.getElementById('sel-all');
  if (sa) { sa.checked = false; sa.indeterminate = false; }
  updateBulkBar();
}

function toggleNameSort() {
  nameSortDir = nameSortDir === 'asc' ? 'desc' : 'asc';
  var th = document.getElementById('th-name');
  var arrow = document.getElementById('sort-arrow-name');
  if (th) {
    th.classList.toggle('sort-asc', nameSortDir === 'asc');
    th.classList.toggle('sort-desc', nameSortDir === 'desc');
  }
  if (arrow) arrow.textContent = nameSortDir === 'asc' ? '↑' : '↓';
  refresh();
}

function bulkDelete() {
  var n = selectedIds.size;
  if (!n) return;
  if (!confirm('Permanently delete ' + n + ' contact' + (n !== 1 ? 's' : '') + '? This cannot be undone.')) return;
  var ids = Array.from(selectedIds);
  fetch('/admin/constituents/bulk', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ids })
  })
    .then(function(r){ return r.json(); })
    .then(function(data) {
      if (data.result === 'ok') {
        all = all.filter(function(r){ return ids.indexOf(r.id) === -1; });
        refresh();
      } else {
        alert('Error deleting contacts. Please try again.');
      }
    })
    .catch(function(){ alert('Network error. Please try again.'); });
}

// ── Yard Sign Tracker ──
function openSignsModal() {
  renderSignsModal();
  document.getElementById('signs-overlay').classList.add('open');
}
function closeSignsModal() {
  document.getElementById('signs-overlay').classList.remove('open');
}
function handleSignsOverlayClick(e) {
  if (e.target === document.getElementById('signs-overlay')) closeSignsModal();
}

function renderSignsModal() {
  // Always show all requestors across all events (not filtered by tab)
  var signsData = all.filter(function(r){ return r.yard_sign === 'Yes'; });
  var delivered = signsData.filter(function(r){ return r.yard_sign_delivered === 'Yes'; }).length;
  var pending   = signsData.length - delivered;
  document.getElementById('sm-requested').textContent = signsData.length;
  document.getElementById('sm-delivered').textContent = delivered;
  document.getElementById('sm-pending').textContent   = pending;

  var tbody = document.getElementById('signs-tbody');
  if (!signsData.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="drill-empty">No yard sign requests yet.</td></tr>';
    return;
  }
  tbody.innerHTML = signsData.map(function(r){
    var isDel = r.yard_sign_delivered === 'Yes';
    var date  = fmtDate(r.created_at);
    var btnCls = isDel ? 'delivered' : 'requested';
    var btnTxt = isDel ? '&#10003; Delivered' : 'Mark Delivered';
    return '<tr id="sign-row-'+r.id+'">'+
      '<td class="c-date">'+date+'</td>'+
      '<td><div class="c-name">'+x(r.first_name)+' '+x(r.last_name)+'</div>'+
          '<div class="c-sub">'+x(r.email)+'</div></td>'+
      '<td class="c-phone">'+x(r.phone)+'</td>'+
      '<td class="c-sub" style="font-size:12px;max-width:160px;">'+x(r.address)+'</td>'+
      '<td class="c-zip">'+x(r.zip)+'</td>'+
      '<td class="c-zip">'+x(r.event)+'</td>'+
      '<td><button class="sign-btn '+btnCls+'" onclick="toggleSignDelivered('+r.id+','+isDel+')">'+btnTxt+'</button></td>'+
    '</tr>';
  }).join('');
}

function toggleSignDelivered(id, currentlyDelivered) {
  var newVal = !currentlyDelivered;
  fetch('/rsvp/'+id+'/sign', {
    method: 'PATCH',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ delivered: newVal })
  }).then(function(r){ return r.json(); }).then(function(){
    // Update local data
    var rec = all.find(function(r){ return r.id === id; });
    if (rec) rec.yard_sign_delivered = newVal ? 'Yes' : null;
    renderSignsModal();
    stats(filtered());
  });
}

function exportSignsCSV() {
  var signsData = all.filter(function(r){ return r.yard_sign === 'Yes'; });
  var esc = function(v){ return '"'+(v||'').toString().replace(/"/g,'""')+'"'; };
  var hdrs = ['Date','First Name','Last Name','Email','Phone','Address','Zip','Event','Delivered'];
  var rows = [hdrs.join(',')].concat(signsData.map(function(r){
    return [esc(r.created_at),esc(r.first_name),esc(r.last_name),
            esc(r.email),esc(r.phone),esc(r.address),esc(r.zip),
            esc(r.event),esc(r.yard_sign_delivered||'No')].join(',');
  }));
  var blob = new Blob([rows.join('\\n')], {type:'text/csv'});
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href   = url; a.download = 'blaine-yard-signs.csv';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ── Drill-down ──
var drillOption = null;
var drillData   = [];

function goToConstituents(district) {
  switchView('constituents');
  setDistrict(district);
}

function scrollToDonations() {
  var el = document.querySelector('.donation-section');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function drilldown(option) {
  drillOption = option;
  var d = all; // stat cards always drill into full dataset
  if (option === 'Endorsement') {
    drillData = d.filter(function(r){ return r.endorse === 'Yes'; });
  } else if (option === 'Yard Sign') {
    drillData = d.filter(function(r){ return r.yard_sign === 'Yes'; });
  } else {
    drillData = filtered().filter(function(r){
      if (!r.how_to_help || r.how_to_help === 'None selected') return false;
      return r.how_to_help.split(',').map(function(h){ return h.trim(); }).indexOf(option) > -1;
    });
  }
  document.getElementById('drill-title').textContent = option;
  document.getElementById('drill-count').textContent =
    drillData.length + ' person' + (drillData.length !== 1 ? 's' : '');
  var tbody = document.getElementById('drill-tbody');
  if (!drillData.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="drill-empty">No responses for this option yet.</td></tr>';
  } else {
    tbody.innerHTML = drillData.map(function(r){
      var date = fmtDate(r.created_at);
      return '<tr>'+
        '<td class="c-date">'+date+'</td>'+
        '<td><div class="c-name">'+x(r.first_name)+' '+x(r.last_name)+'</div>'+
            '<div class="c-sub">'+x(r.email)+'</div></td>'+
        '<td class="c-phone">'+x(r.phone)+'</td>'+
        '<td class="c-zip">'+x(r.zip)+'</td>'+
        '<td class="c-zip">'+x(r.event)+'</td>'+
      '</tr>';
    }).join('');
  }
  document.getElementById('drill-overlay').classList.add('open');
}

function closeDrill() {
  document.getElementById('drill-overlay').classList.remove('open');
}
function handleDrillOverlayClick(e) {
  if (e.target === document.getElementById('drill-overlay')) closeDrill();
}

function exportDrillCSV() {
  var esc = function(v){ return '"'+(v||'').toString().replace(/"/g,'""')+'"'; };
  var hdrs = ['Date','First Name','Last Name','Email','Phone','Zip','Event'];
  var rows = [hdrs.join(',')].concat(drillData.map(function(r){
    return [esc(r.created_at),esc(r.first_name),esc(r.last_name),
            esc(r.email),esc(r.phone),esc(r.zip),esc(r.event)].join(',');
  }));
  var blob = new Blob([rows.join('\\n')], {type:'text/csv'});
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href   = url;
  a.download = 'blaine-'+drillOption.toLowerCase().replace(/[^a-z0-9]+/g,'-')+'.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function x(s){ return s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):''; }
function fmtPhone(p){ if(!p) return ''; var d=String(p).replace(/\D/g,''); if(d.length===10) return d.slice(0,3)+'-'+d.slice(3,6)+'-'+d.slice(6); return p; }
function fmtDate(s){ if(!s) return ''; var p=(s||'').slice(0,10).split('-'); if(p.length!==3) return s; var mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return mo[parseInt(p[1],10)-1]+' '+parseInt(p[2],10)+', '+p[0]; }

function switchView(name) {
  ['dashboard','pipeline','constituents','events','donations','volunteers','endorsements','canvassing','compliance'].forEach(function(v) {
    var el = document.getElementById('view-' + v);
    if (el) {
      if (v === name) el.classList.remove('view-hidden');
      else el.classList.add('view-hidden');
    }
  });
  // Sync left sidebar
  document.querySelectorAll('.left-nav-item').forEach(function(el){ el.classList.remove('active'); });
  var navEl = document.getElementById('nav-' + name);
  if (navEl) navEl.classList.add('active');
  // Sync bottom nav
  var bPrimary = ['dashboard','constituents','events','donations'];
  bPrimary.forEach(function(v) {
    var el = document.getElementById('bnav-' + v);
    if (el) el.classList.toggle('active', v === name);
  });
  var bMore = document.getElementById('bnav-more');
  if (bMore) bMore.classList.toggle('active', bPrimary.indexOf(name) === -1);
  // Sync more sheet active state
  document.querySelectorAll('.mob-sheet-item').forEach(function(el){ el.classList.remove('active'); });
  var mEl = document.getElementById('mnav-' + name);
  if (mEl) mEl.classList.add('active');

  if (name === 'events')       buildEventsView(all);
  if (name === 'donations')    buildDonationsView();
  if (name === 'volunteers')   buildVolunteersView();
  if (name === 'endorsements') buildEndorsementsView();
  if (name === 'canvassing')   buildCanvassingView();
  if (name === 'compliance')   buildComplianceView();
}
function openMobSheet() {
  document.getElementById('mob-sheet').classList.add('open');
  document.getElementById('mob-sheet-overlay').classList.add('open');
}
function closeMobSheet() {
  document.getElementById('mob-sheet').classList.remove('open');
  document.getElementById('mob-sheet-overlay').classList.remove('open');
}

// ─────────────────────────────────────────────────────────────────────
// DONATIONS
// ─────────────────────────────────────────────────────────────────────
var _donData = [];
function buildDonationsView() {
  if (IS_CANDIDATE) return;   // candidate view has no donation data
  // Populate Anedot webhook URL dynamically
  var whEl = document.getElementById('anedot-wh-url');
  if (whEl && !whEl.textContent) whEl.textContent = window.location.origin + '/webhook/anedot';
  fetch('/admin/donations').then(function(r){ return r.json(); }).then(function(rows) {
    _donData = rows;
    var total = rows.reduce(function(s,r){ return s + (parseFloat(r.amount)||0); }, 0);
    var avg   = rows.length ? total / rows.length : 0;
    var top   = rows.reduce(function(m,r){ return Math.max(m, parseFloat(r.amount)||0); }, 0);
    var fmt   = function(n){ return '$' + n.toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:0}); };
    var set   = function(id,v){ var el=document.getElementById(id); if(el) el.textContent=v; };
    set('don-stat-total', fmt(total));
    set('don-stat-count', rows.length);
    set('don-stat-avg',   rows.length ? fmt(avg) : '—');
    set('don-stat-top',   top ? fmt(top) : '—');

    // Source breakdown chips
    var sourceBar = document.getElementById('don-source-bar');
    var sourceChips = document.getElementById('don-source-chips');
    if (rows.length && sourceBar && sourceChips) {
      var bySource = {};
      rows.forEach(function(r){
        var s = r.source || 'Unspecified';
        bySource[s] = (bySource[s]||0) + (parseFloat(r.amount)||0);
      });
      sourceChips.innerHTML = Object.keys(bySource).sort(function(a,b){ return bySource[b]-bySource[a]; }).map(function(s){
        return '<div style="background:var(--white);border:1px solid var(--border);border-radius:100px;padding:5px 14px;font-size:10px;font-weight:700;color:var(--navy);">' +
          x(s) + '<span style="color:var(--mint-d);margin-left:8px;">' + fmt(bySource[s]) + '</span></div>';
      }).join('');
      sourceBar.style.display = '';
    }

    // Table
    var tbody = document.getElementById('don-tbody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty" style="padding:60px 32px;">No donations recorded yet — use <strong>＋ Record Donation</strong> to add one.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function(r) {
      var amt = parseFloat(r.amount)||0;
      var amtStr = '$' + amt.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
      var dateStr = r.date ? new Date(r.date + 'T00:00:00').toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}) : '—';
      var tenderLabel = r.tender_type || '—';
      if (r.tender_type === 'Check' && r.check_number) tenderLabel = 'Check #' + r.check_number;
      return '<tr>' +
        '<td><div class="c-name">' + x(r.donor_name||'—') + '</div></td>' +
        '<td><span style="font-weight:800;color:var(--mint-d);font-size:13px;">' + amtStr + '</span></td>' +
        '<td class="c-sub">' + dateStr + '</td>' +
        '<td><span class="spill spill-blue">' + x(r.source||'—') + '</span></td>' +
        '<td class="c-sub">' + x(tenderLabel) + '</td>' +
        '<td><button class="door-result-btn" onclick="deleteDonation(' + r.id + ')" style="color:#991b1b;">Del</button></td>' +
        '</tr>';
    }).join('');
  });
}
function deleteDonation(id) {
  if (!confirm('Delete this donation record?')) return;
  fetch('/admin/donation/' + id, { method: 'DELETE' })
    .then(function(){ buildDonationsView(); });
}

// ─────────────────────────────────────────────────────────────────────
// VOLUNTEER MANAGEMENT
// ─────────────────────────────────────────────────────────────────────
var _volData = [];
function buildVolunteersView() {
  fetch('/admin/volunteers').then(function(r){ return r.json(); }).then(function(rows) {
    _volData = rows;
    var total = rows.length;
    var active = rows.filter(function(r){ return r.volunteer_status === 'active'; }).length;
    var hours  = rows.reduce(function(s,r){ return s + (parseInt(r.volunteer_hours)||0); }, 0);
    var unsched = rows.filter(function(r){ return !r.volunteer_status || r.volunteer_status === 'new'; }).length;
    var set = function(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
    set('vs-total', total); set('vs-active', active); set('vs-hours', hours); set('vs-unscheduled', unsched);
    var tbody = document.getElementById('vol-tbody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty" style="padding:60px 32px;">No volunteers yet — use <strong>＋ Add Volunteer</strong> to flag a contact as a volunteer.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function(r) {
      var statusPill = {
        'active':      '<span class="spill spill-green">Active</span>',
        'new':         '<span class="spill spill-gray">New</span>',
        'unscheduled': '<span class="spill spill-yellow">Unscheduled</span>',
        'inactive':    '<span class="spill spill-gray">Inactive</span>'
      }[r.volunteer_status||'new'] || '<span class="spill spill-gray">New</span>';
      return '<tr>' +
        '<td><div class="c-name">' + x((r.first_name||'') + ' ' + (r.last_name||'')) + '</div></td>' +
        '<td>' + x(r.volunteer_role||'—') + '</td>' +
        '<td>' + (r.volunteer_hours||0) + '</td>' +
        '<td>' + statusPill + '</td>' +
        '<td><div class="c-sub">' + x(r.email||r.phone||'—') + '</div></td>' +
        '<td style="white-space:nowrap;"><button class="door-result-btn" onclick="editVolunteer(' + r.id + ')">Edit</button> <button class="door-result-btn" onclick="deleteVolunteer(' + r.id + ')" style="color:#991b1b;">Remove</button></td>' +
        '</tr>';
    }).join('');
  });
}

function deleteVolunteer(id) {
  var r = _volData.find(function(v){ return v.id === id; });
  var name = r ? ((r.first_name||'') + ' ' + (r.last_name||'')).trim() : 'this volunteer';
  if (!confirm('Remove ' + name + ' from the volunteer list? Their contact record is kept, only volunteer info is cleared.')) return;
  fetch('/admin/volunteer/' + id, { method: 'DELETE' })
    .then(function(){ buildVolunteersView(); });
}

var _editVolId = null;
function openAddVolunteerModal() {
  _editVolId = null;
  document.getElementById('vol-modal-title').textContent = 'Add Volunteer';
  document.getElementById('vol-contact-search').value = '';
  document.getElementById('vol-contact-id').value = '';
  document.getElementById('vol-role-input').value = '';
  document.getElementById('vol-hours-input').value = '0';
  document.getElementById('vol-status-input').value = 'new';
  document.getElementById('vol-overlay').classList.add('open');
}
function editVolunteer(id) {
  var r = _volData.find(function(v){ return v.id === id; });
  if (!r) return;
  _editVolId = id;
  document.getElementById('vol-modal-title').textContent = 'Edit Volunteer';
  document.getElementById('vol-contact-search').value = (r.first_name||'') + ' ' + (r.last_name||'');
  document.getElementById('vol-contact-id').value = id;
  document.getElementById('vol-role-input').value = r.volunteer_role||'';
  document.getElementById('vol-hours-input').value = r.volunteer_hours||0;
  document.getElementById('vol-status-input').value = r.volunteer_status||'new';
  document.getElementById('vol-overlay').classList.add('open');
}
function closeVolModal() { document.getElementById('vol-overlay').classList.remove('open'); }
function saveVolunteer() {
  var cid = document.getElementById('vol-contact-id').value;
  if (!cid) { alert('Please select a contact from the search.'); return; }
  var payload = {
    volunteer_role:   document.getElementById('vol-role-input').value,
    volunteer_hours:  parseInt(document.getElementById('vol-hours-input').value)||0,
    volunteer_status: document.getElementById('vol-status-input').value
  };
  fetch('/admin/volunteer/' + cid, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
    .then(function(r){ return r.json(); })
    .then(function(){ closeVolModal(); buildVolunteersView(); });
}

// Volunteer contact search autocomplete
var _volAcTimer;
function volAcSearch(q) {
  document.getElementById('vol-contact-id').value = '';
  clearTimeout(_volAcTimer);
  var drop = document.getElementById('vol-ac-drop');
  if (!q || q.length < 2) { drop.classList.remove('open'); drop.innerHTML = ''; return; }
  _volAcTimer = setTimeout(function() {
    fetch('/admin/contacts/search?q=' + encodeURIComponent(q))
      .then(function(r){ return r.json(); })
      .then(function(results) {
        if (!results.length) { drop.innerHTML = '<div style="padding:10px 14px;font-size:11px;color:var(--dim);">No contacts found</div>'; drop.classList.add('open'); return; }
        drop.innerHTML = results.map(function(c) {
          var full = _esc((c.first_name||'') + ' ' + (c.last_name||''));
          return '<div class="don-ac-item" data-cid="' + c.id + '" data-name="' + full + '" onclick="selectVolContact(+this.dataset.cid, this.dataset.name)">' + full + (c.email ? '<span style="color:var(--dim);font-size:10px;margin-left:6px;">' + _esc(c.email) + '</span>' : '') + '</div>';
        }).join('');
        drop.classList.add('open');
      });
  }, 180);
}
function selectVolContact(id, name) {
  document.getElementById('vol-contact-id').value = id;
  document.getElementById('vol-contact-search').value = name.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"');
  document.getElementById('vol-ac-drop').classList.remove('open');
  document.getElementById('vol-ac-drop').innerHTML = '';
}

// ─────────────────────────────────────────────────────────────────────
// ENDORSEMENTS
// ─────────────────────────────────────────────────────────────────────
var _endData = [];
var _editEndId = null;
function buildEndorsementsView() {
  fetch('/admin/endorsements').then(function(r){ return r.json(); }).then(function(rows) {
    _endData = rows;
    var total    = rows.length;
    var endorsed = rows.filter(function(r){ return r.status === 'endorsed'; }).length;
    var pending  = rows.filter(function(r){ return r.status === 'in_conversation' || r.status === 'outreach_sent'; }).length;
    var newc     = rows.filter(function(r){ return r.status === 'not_contacted'; }).length;
    var set = function(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
    set('es-total', total); set('es-endorsed', endorsed); set('es-pending', pending); set('es-new', newc);
    var tbody = document.getElementById('end-tbody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty" style="padding:60px 32px;">No endorsements tracked yet — use <strong>＋ Add Endorsement</strong> to start tracking.</td></tr>';
      return;
    }
    var tierIcons = { bar_assoc: '🏛️', elected: '🏛️', civic: '🤝', labor: '✊', individual: '👤' };
    var statusMap = {
      'endorsed':       '<span class="spill spill-green">Endorsed</span>',
      'in_conversation':'<span class="spill spill-yellow">In Conversation</span>',
      'outreach_sent':  '<span class="spill spill-blue">Outreach Sent</span>',
      'not_contacted':  '<span class="spill spill-gray">Not Contacted</span>',
      'declined':       '<span class="spill spill-red">Declined</span>'
    };
    var tierLabel = { bar_assoc:'Bar Assoc.', elected:'Elected Official', civic:'Civic Org', labor:'Labor Org', individual:'Individual' };
    tbody.innerHTML = rows.map(function(r) {
      var icon = tierIcons[r.tier]||'👤';
      var fromForm = r._src === 'contact';
      var nameBadge = fromForm ? ' <span style="font-size:9px;background:#e0f2fe;color:#0369a1;padding:2px 7px;border-radius:100px;font-weight:700;letter-spacing:.5px;vertical-align:middle;">FROM FORM</span>' : '';
      var actions = fromForm
        ? '<a href="/admin/constituent/' + r.contact_id + '" class="door-result-btn" style="text-decoration:none;">View</a>'
        : '<button class="door-result-btn" onclick="editEndorsement(' + r.id + ')">Edit</button> <button class="door-result-btn" onclick="deleteEndorsement(' + r.id + ')" style="color:#991b1b;">Del</button>';
      return '<tr>' +
        '<td><div style="display:flex;align-items:center;gap:10px;"><span class="end-tier-icon" style="background:#f0f4f8;">' + icon + '</span><div><div class="c-name">' + x(r.name) + nameBadge + '</div>' + (r.org ? '<div class="c-sub">' + x(r.org) + '</div>' : '') + '</div></div></td>' +
        '<td><span class="spill spill-gray">' + x(tierLabel[r.tier]||r.tier) + '</span></td>' +
        '<td>' + (statusMap[r.status]||'<span class="spill spill-gray">Unknown</span>') + '</td>' +
        '<td class="c-date">' + x(r.date||'—') + '</td>' +
        '<td class="c-comment">' + x(r.notes||'—') + '</td>' +
        '<td style="white-space:nowrap;">' + actions + '</td>' +
        '</tr>';
    }).join('');
  });
}
// ── Endorsement contact autocomplete ──────────────────────────────────
var _endAcTimer;
function endAcSearch(q) {
  document.getElementById('end-contact-id').value = '';
  clearTimeout(_endAcTimer);
  var drop = document.getElementById('end-ac-drop');
  if (!q || q.length < 2) { drop.classList.remove('open'); drop.innerHTML = ''; return; }
  _endAcTimer = setTimeout(function() {
    fetch('/admin/contacts/search?q=' + encodeURIComponent(q))
      .then(function(r){ return r.json(); })
      .then(function(results) {
        if (!results.length) {
          drop.innerHTML = '<div style="padding:10px 14px;font-size:11px;color:var(--dim);">No existing contact found — the name you typed will be saved as-is.</div>';
          drop.classList.add('open');
          return;
        }
        drop.innerHTML = results.map(function(c) {
          var full = _esc((c.first_name||'') + ' ' + (c.last_name||''));
          return '<div class="don-ac-item" data-cid="' + c.id + '" data-name="' + full + '" onclick="selectEndContact(+this.dataset.cid, this.dataset.name)">' +
            full + (c.email ? '<span style="color:var(--dim);font-size:10px;margin-left:6px;">' + _esc(c.email) + '</span>' : '') + '</div>';
        }).join('');
        drop.classList.add('open');
      });
  }, 180);
}
function selectEndContact(id, name) {
  document.getElementById('end-contact-id').value = id;
  document.getElementById('end-name').value = name.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"');
  var drop = document.getElementById('end-ac-drop');
  drop.classList.remove('open'); drop.innerHTML = '';
}
function _endAcClose() {
  var drop = document.getElementById('end-ac-drop');
  if (drop) { drop.classList.remove('open'); drop.innerHTML = ''; }
}

function openAddEndorsementModal() {
  _editEndId = null;
  ['end-name','end-org','end-notes','end-date'].forEach(function(id){ var el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('end-contact-id').value = '';
  document.getElementById('end-tier').value = 'individual';
  document.getElementById('end-status').value = 'not_contacted';
  document.getElementById('end-modal-title').textContent = 'Add Endorsement';
  _endAcClose();
  document.getElementById('end-overlay').classList.add('open');
  setTimeout(function(){ var n = document.getElementById('end-name'); if(n) n.focus(); }, 60);
}
function editEndorsement(id) {
  var r = _endData.find(function(e){ return e.id === id; });
  if (!r) return;
  _editEndId = id;
  document.getElementById('end-name').value       = r.name||'';
  document.getElementById('end-contact-id').value = r.contact_id||'';
  document.getElementById('end-org').value         = r.org||'';
  document.getElementById('end-tier').value        = r.tier||'individual';
  document.getElementById('end-status').value      = r.status||'not_contacted';
  document.getElementById('end-notes').value       = r.notes||'';
  document.getElementById('end-date').value        = r.date||'';
  document.getElementById('end-modal-title').textContent = 'Edit Endorsement';
  _endAcClose();
  document.getElementById('end-overlay').classList.add('open');
}
function closeEndModal() {
  document.getElementById('end-overlay').classList.remove('open');
  _endAcClose();
}
function saveEndorsement() {
  var name = document.getElementById('end-name').value.trim();
  if (!name) { alert('Please enter a name.'); return; }
  var cid  = document.getElementById('end-contact-id').value;
  var payload = {
    name:       name,
    contact_id: cid ? parseInt(cid) : null,
    org:        document.getElementById('end-org').value,
    tier:       document.getElementById('end-tier').value,
    status:     document.getElementById('end-status').value,
    notes:      document.getElementById('end-notes').value,
    date:       document.getElementById('end-date').value
  };
  var url    = _editEndId ? '/admin/endorsement/' + _editEndId : '/admin/endorsement';
  var method = _editEndId ? 'PATCH' : 'POST';
  fetch(url, { method: method, headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
    .then(function(r){ return r.json(); })
    .then(function(){ closeEndModal(); buildEndorsementsView(); });
}
function deleteEndorsement(id) {
  if (!confirm('Delete this endorsement record?')) return;
  fetch('/admin/endorsement/' + id, { method:'DELETE' })
    .then(function(){ buildEndorsementsView(); });
}

// ─────────────────────────────────────────────────────────────────────
// CANVASSING
// ─────────────────────────────────────────────────────────────────────
var _listData = [];
var _activeDoorListId = null;
function buildCanvassingView() {
  fetch('/admin/walk-lists').then(function(r){ return r.json(); }).then(function(lists) {
    _listData = lists;
    var totalDoors    = lists.reduce(function(s,l){ return s + (l._total||0); }, 0);
    var totalKnocked  = lists.reduce(function(s,l){ return s + (l._knocked||0); }, 0);
    var totalFav      = lists.reduce(function(s,l){ return s + (l._favorable||0); }, 0);
    var rate = totalKnocked ? Math.round((totalFav/totalKnocked)*100) : 0;
    var set = function(id,v){ var el=document.getElementById(id); if(el) el.textContent=v; };
    set('cs-lists', lists.length); set('cs-doors', totalDoors);
    set('cs-knocked', totalKnocked); set('cs-favorable', totalFav);
    var rateEl = document.getElementById('cs-rate');
    if (rateEl) rateEl.textContent = totalKnocked ? '(' + rate + '%)' : '';
    var tbody = document.getElementById('canvas-lists-tbody');
    if (!tbody) return;
    if (!lists.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty" style="padding:60px 32px;">No walk lists yet — use <strong>＋ New Walk List</strong> to create one.</td></tr>';
      return;
    }
    tbody.innerHTML = lists.map(function(l) {
      var pct = l._total ? Math.round((l._knocked/l._total)*100) : 0;
      var progBar = '<div style="width:80px;background:#e9edf3;border-radius:100px;height:5px;overflow:hidden;"><div style="width:' + pct + '%;height:100%;background:var(--mint);border-radius:100px;"></div></div>' +
        '<span style="font-size:10px;color:var(--dim);margin-left:6px;">' + pct + '%</span>';
      return '<tr>' +
        '<td><div class="c-name">' + x(l.name) + '</div></td>' +
        '<td>' + x(l.area||'—') + '</td>' +
        '<td>' + x(l.assigned_to||'—') + '</td>' +
        '<td>' + (l._total||0) + '</td>' +
        '<td><div style="display:flex;align-items:center;">' + progBar + '</div></td>' +
        '<td>' + (l._favorable||0) + '</td>' +
        '<td style="white-space:nowrap;">' +
          '<button class="door-result-btn" onclick="openDoors(' + l.id + ')">View Doors</button> ' +
          '<button class="door-result-btn" onclick="editList(' + l.id + ')">Edit</button> ' +
          '<button class="door-result-btn" onclick="deleteList(' + l.id + ')" style="color:#991b1b;">Del</button>' +
        '</td>' +
        '</tr>';
    }).join('');
  });
}
function openDoors(listId) {
  _activeDoorListId = listId;
  var list = _listData.find(function(l){ return l.id === listId; });
  var el = document.getElementById('canvas-door-list-name');
  if (el) el.textContent = 'Doors — ' + (list ? list.name : '');
  var sec = document.getElementById('canvas-doors-section');
  if (sec) sec.style.display = '';
  loadDoors(listId);
}
function closeDoorSection() {
  _activeDoorListId = null;
  var sec = document.getElementById('canvas-doors-section');
  if (sec) sec.style.display = 'none';
}
function loadDoors(listId) {
  fetch('/admin/walk-doors/' + listId).then(function(r){ return r.json(); }).then(function(doors) {
    var tbody = document.getElementById('canvas-doors-tbody');
    if (!tbody) return;
    if (!doors.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty" style="padding:40px 32px;">No doors in this list yet — use <strong>＋ Add Door</strong>.</td></tr>';
      return;
    }
    // Door grid visualization
    var grid = document.getElementById('canvas-door-grid');
    if (grid) {
      var gridColors = { favorable:'#10B981', unfavorable:'#EF4444', not_home:'#F59E0B', moved:'#3B82F6', pending:'#CBD5E1' };
      var gridTips   = { favorable:'Favorable', unfavorable:'Not Interested', not_home:'Not Home', moved:'Moved', pending:'Pending' };
      grid.innerHTML = doors.map(function(d, i){
        var r = d.result || 'pending';
        var tip = (d.address || 'Door ' + (i+1)) + ' — ' + gridTips[r];
        return '<div title="' + x(tip) + '" style="width:14px;height:14px;border-radius:2px;background:' + gridColors[r] + ';cursor:default;" ></div>';
      }).join('');
    }
    var resultClass = { favorable:'active-fav', unfavorable:'active-unf', not_home:'active-nh', moved:'active-mvd' };
    tbody.innerHTML = doors.map(function(d) {
      var btns = ['favorable','unfavorable','not_home','moved'].map(function(r) {
        var lbl = {favorable:'✓ Yes',unfavorable:'✗ No',not_home:'↩ Not Home',moved:'Moved'}[r];
        var cls = (d.result===r) ? 'door-result-btn ' + resultClass[r] : 'door-result-btn';
        return '<button class="' + cls + '" data-did="' + d.id + '" data-res="' + r + '" onclick="setDoorResult(+this.dataset.did, this.dataset.res)">' + lbl + '</button>';
      }).join(' ');
      return '<tr>' +
        '<td><div class="c-name">' + x(d.address||'—') + '</div></td>' +
        '<td>' + x(d.voter_name||'—') + '</td>' +
        '<td><div style="display:flex;gap:4px;flex-wrap:wrap;">' + btns + '</div></td>' +
        '<td class="c-sub">' + x(d.volunteer||'—') + '</td>' +
        '<td class="c-comment">' + x(d.notes||'—') + '</td>' +
        '<td><button class="door-result-btn" onclick="deleteDoor(' + d.id + ')" style="color:#991b1b;">Del</button></td>' +
        '</tr>';
    }).join('');
  });
}
function setDoorResult(doorId, result) {
  fetch('/admin/walk-door/' + doorId, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({result:result}) })
    .then(function(){ if (_activeDoorListId) { loadDoors(_activeDoorListId); buildCanvassingView(); } });
}
function deleteDoor(doorId) {
  if (!confirm('Remove this door?')) return;
  fetch('/admin/walk-door/' + doorId, { method:'DELETE' })
    .then(function(){ /* re-use PATCH endpoint workaround — delete not defined, use result=deleted */ })
    .then(function(){ if (_activeDoorListId) loadDoors(_activeDoorListId); });
}
function deleteList(listId) {
  if (!confirm('Delete this walk list and all its doors?')) return;
  fetch('/admin/walk-list/' + listId, { method:'DELETE' })
    .then(function(){ closeDoorSection(); buildCanvassingView(); });
}
function copyFieldLink() {
  var url = window.location.origin + '/canvass';
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(function(){
      var btn = event.target.closest('button');
      var orig = btn.innerHTML;
      btn.innerHTML = '&#10003; Copied!';
      btn.style.background = 'var(--mint)';
      setTimeout(function(){ btn.innerHTML = orig; btn.style.background = ''; }, 2000);
    });
  } else {
    prompt('Share this link with your volunteers:', url);
  }
}
function openImportModal() {
  document.getElementById('import-csv-input').value = '';
  document.getElementById('import-preview').textContent = '';
  document.getElementById('import-overlay').classList.add('open');
}
function closeImportModal() { document.getElementById('import-overlay').classList.remove('open'); }
function runImport() {
  var raw = document.getElementById('import-csv-input').value.trim();
  if (!raw) { alert('Paste some CSV rows first.'); return; }
  var lines = raw.split('\\n').map(function(l){ return l.trim(); }).filter(Boolean);
  // Skip header if it looks like one (no digits in first token)
  if (lines.length && !/\\d/.test(lines[0].split(',')[0])) lines = lines.slice(1);
  var rows = lines.map(function(l){
    var parts = l.split(',');
    return { address: (parts[0]||'').trim(), voter_name: (parts.slice(1).join(',') || '').trim() };
  }).filter(function(r){ return r.address; });
  if (!rows.length) { alert('No valid rows found. Make sure each line has at least an address.'); return; }
  var preview = document.getElementById('import-preview');
  preview.textContent = 'Importing ' + rows.length + ' doors…';
  fetch('/admin/walk-list/' + _activeDoorListId + '/import', {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ rows: rows })
  }).then(function(r){ return r.json(); }).then(function(d){
    closeImportModal();
    loadDoors(_activeDoorListId);
    buildCanvassingView();
    alert('Imported ' + d.imported + ' doors successfully.');
  }).catch(function(){ alert('Import failed — check the console.'); });
}
var _editListId = null;
function openAddListModal() {
  _editListId = null;
  document.getElementById('list-name-input').value = '';
  document.getElementById('list-area-input').value = '';
  document.getElementById('list-assign-input').value = '';
  var ttl = document.getElementById('list-modal-title');
  if (ttl) ttl.textContent = 'New Walk List';
  document.getElementById('list-overlay').classList.add('open');
}
function editList(id) {
  var l = _listData.find(function(x){ return x.id === id; });
  if (!l) return;
  _editListId = id;
  document.getElementById('list-name-input').value   = l.name||'';
  document.getElementById('list-area-input').value   = l.area||'';
  document.getElementById('list-assign-input').value = l.assigned_to||'';
  var ttl = document.getElementById('list-modal-title');
  if (ttl) ttl.textContent = 'Edit Walk List';
  document.getElementById('list-overlay').classList.add('open');
}
function closeListModal() { document.getElementById('list-overlay').classList.remove('open'); }
function saveList() {
  var name = document.getElementById('list-name-input').value.trim();
  if (!name) { alert('Please enter a list name.'); return; }
  var payload = {
    name: name,
    area: document.getElementById('list-area-input').value,
    assigned_to: document.getElementById('list-assign-input').value
  };
  var url    = _editListId ? '/admin/walk-list/' + _editListId : '/admin/walk-list';
  var method = _editListId ? 'PATCH' : 'POST';
  fetch(url, { method: method, headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
    .then(function(r){ return r.json(); })
    .then(function(){ closeListModal(); buildCanvassingView(); });
}
function openAddDoorModal() {
  document.getElementById('door-addr-input').value = '';
  document.getElementById('door-voter-input').value = '';
  document.getElementById('door-overlay').classList.add('open');
}
function closeDoorModal() { document.getElementById('door-overlay').classList.remove('open'); }
function saveDoor() {
  if (!_activeDoorListId) return;
  var addr = document.getElementById('door-addr-input').value.trim();
  if (!addr) { alert('Please enter an address.'); return; }
  fetch('/admin/walk-door', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
    list_id: _activeDoorListId,
    address: addr,
    voter_name: document.getElementById('door-voter-input').value
  })}).then(function(r){ return r.json(); }).then(function(){ closeDoorModal(); loadDoors(_activeDoorListId); buildCanvassingView(); });
}

// ─────────────────────────────────────────────────────────────────────
// COMPLIANCE DASHBOARD
// ─────────────────────────────────────────────────────────────────────
function buildComplianceView() {
  // Candidate view: show the compliance guidance but never fetch donation data
  if (IS_CANDIDATE) { renderCompliance(0); return; }
  var donCount = 0;
  try {
    // Check if donations table exists and count records
    fetch('/admin/export/donors.csv').then(function(r){ return r.text(); }).then(function(csv){
      donCount = csv.split('\\n').length - 2; // subtract header + empty
      renderCompliance(donCount);
    });
  } catch(e) { renderCompliance(0); }
}
function renderCompliance(donCount) {
  var items = [
    {
      icon: '✓', type: 'ok',
      title: 'Personal Solicitation of Donations',
      desc: 'Canon 4.1(A)(8) prohibits a judicial candidate from personally soliciting campaign contributions. All donation asks must come from your campaign committee or treasurer — not from Blaine directly. <strong>Verify that all donor outreach, solicitation letters, and fundraiser invitations are sent by the committee, not the candidate.</strong>'
    },
    {
      icon: '✓', type: 'ok',
      title: 'Partisan Pledges & Commitments',
      desc: "Canon 4.1(A)(7) prohibits judicial candidates from making pledges, promises, or commitments regarding cases, controversies, or issues. Campaign messaging should focus on Blaine's qualifications, experience, and judicial philosophy — not specific case outcomes or policy positions."
    },
    {
      icon: donCount > 0 ? 'i' : '✓', type: donCount > 0 ? 'info' : 'ok',
      title: 'Campaign Finance Disclosure',
      desc: 'Louisiana requires periodic disclosure reports filed with the Louisiana Board of Ethics. ' + (donCount > 0 ? 'You have <strong>' + donCount + ' donation record(s)</strong> in the system — ensure these are included in your next report.' : 'No donation records on file yet.') + ' Reports are typically due 30 days after each reporting period ends. <strong>Consult your campaign treasurer to confirm the next filing date.</strong>'
    },
    {
      icon: '!', type: 'warn',
      title: 'Endorsements from Sitting Judges',
      desc: 'Canon 4.1(A)(2) restricts judicial candidates from soliciting endorsements from sitting judges in most circumstances. Review any endorsements in your Endorsements tracker from sitting or retired judges before publicly announcing them. When in doubt, consult your campaign attorney.'
    },
    {
      icon: '✓', type: 'ok',
      title: 'Use of Court Staff or Resources',
      desc: "Canon 4.1(A)(1) prohibits using the prestige of judicial office to advance the campaign, and prohibits use of any court staff, facilities, or resources for campaign activities. All campaign work must be conducted outside of Blaine's official judicial duties and office hours."
    },
    {
      icon: '✓', type: 'ok',
      title: 'Public Statements & Media',
      desc: 'Canon 4.1(B) allows judicial candidates to speak about their qualifications, legal philosophy, and general views on the law. However, candidates must not make statements that commit or appear to commit them to positions on cases that may come before the court. All public statements, ads, and social media posts should be reviewed with this standard in mind.'
    },
    {
      icon: 'i', type: 'info',
      title: 'Campaign Committee Structure',
      desc: "Best practice: establish a formal campaign committee with a named treasurer. This creates a clear separation between Blaine's personal activities and campaign activities, and is required for state disclosure reporting. The committee — not the candidate — should execute all financial transactions and donation solicitations."
    }
  ];
  var iconBg = { ok: '#d1fae5', warn: '#fef3c7', info: '#dbeafe' };
  var html = items.map(function(item) {
    return '<div class="comp-item">' +
      '<div class="comp-icon comp-icon-' + item.type + '" style="background:' + iconBg[item.type] + ';">' + item.icon + '</div>' +
      '<div class="comp-body">' +
        '<div class="comp-title">' + item.title + '</div>' +
        '<div class="comp-desc">' + item.desc + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
  var el = document.getElementById('compliance-list');
  if (el) el.innerHTML = html;
}

// ── Event Registrations View ──────────────────────────────────────────
// ── Event filter / search helpers ────────────────────────────────────────
function buildEvtFilters(evts) {
  var bar = document.getElementById('evt-filter-bar');
  if (!bar) return;
  var allCount = all.filter(isEvtReg).length;
  // Use data-evtfilter attribute to avoid quoting issues in onclick
  var chips = '<button class="dist-chip' + (activeEvtFilter === 'all' ? ' active' : '') +
    '" data-evtfilter="all" onclick="setEvtFilter(this.dataset.evtfilter)">All Events' +
    '<span class="dist-chip-count">' + allCount + '</span></button>';
  (evts||[]).forEach(function(ev) {
    var cnt = all.filter(function(r){ return isEvtReg(r) && r.event === ev.title; }).length;
    chips += '<button class="dist-chip' + (activeEvtFilter === ev.title ? ' active' : '') +
      '" data-evtfilter="' + x(ev.title) + '" onclick="setEvtFilter(this.dataset.evtfilter)">' +
      x(ev.title) + '<span class="dist-chip-count">' + cnt + '</span></button>';
  });
  bar.innerHTML = chips;
}

function setEvtFilter(val) {
  activeEvtFilter = val;
  document.querySelectorAll('#evt-filter-bar .dist-chip').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.evtfilter === val);
  });
  var lbl = document.getElementById('evt-reg-label');
  if (lbl) lbl.textContent = val === 'all' ? 'All Registrations' : val + ' — Registrations';
  refreshEvtTable();
}

function refreshEvtTable() {
  var regs = all.filter(isEvtReg);
  var base = activeEvtFilter === 'all'
    ? regs
    : regs.filter(function(r){ return r.event === activeEvtFilter; });
  var q = evtSearchQ;
  var d = q ? base.filter(function(r){
    var s = ((r.first_name||'') + ' ' + (r.last_name||'') + ' ' + (r.email||'') + ' ' + (r.event||'')).toLowerCase();
    return s.indexOf(q) > -1;
  }) : base;
  var sorted = d.slice().sort(function(a,b){ return (b.created_at||'') < (a.created_at||'') ? -1 : 1; });
  var tally = document.getElementById('evt-reg-tally');
  if (tally) tally.textContent = sorted.length + ' registration' + (sorted.length === 1 ? '' : 's');
  var tbody = document.getElementById('evt-reg-tbody');
  if (!tbody) return;
  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--dim);font-style:italic;padding:24px 0;">No registrations match this filter.</td></tr>';
    return;
  }
  tbody.innerHTML = sorted.map(function(r) {
    var date = fmtDate(r.created_at);
    var isVoterRow = isVoter(r);
    return '<tr>' +
      '<td style="color:var(--dim);font-size:12px;">' + date + '</td>' +
      '<td><a href="/admin/constituent/' + r.id + '" style="color:var(--navy);font-weight:600;text-decoration:none;">' + x(r.first_name) + ' ' + x(r.last_name) + '</a></td>' +
      '<td style="font-size:12px;font-weight:700;color:var(--navy);">' + x(r.event||'—') + '</td>' +
      '<td><span style="font-size:11px;' + (isVoterRow ? 'color:var(--mint-d);font-weight:700;' : 'color:var(--dim);') + '">' + x(r.parish||'—') + '</span></td>' +
      '<td style="text-align:center;font-size:13px;">' + (r.guests||1) + '</td>' +
      '<td style="text-align:center;">' + (r.yard_sign === 'Yes' ? '<span class="badge badge-yes">Yes</span>' : '<span class="badge badge-no">No</span>') + '</td>' +
      '<td style="font-size:11px;color:var(--muted);max-width:200px;">' + x(r.how_to_help && r.how_to_help !== 'None selected' ? r.how_to_help : '—') + '</td>' +
    '</tr>';
  }).join('');
}

function buildEventsView(d) {
  _evtGroups = [];

  var grid = document.getElementById('evt-mgmt-grid');
  if (grid) grid.innerHTML = '<span style="font-size:13px;color:var(--dim);font-style:italic;">Loading&hellip;</span>';

  fetch('/admin/events-list')
    .then(function(r) { return r.json(); })
    .then(function(evts) {
      _evtList = evts || [];   // ← store for button handlers
      if (grid) {
        if (!_evtList.length) {
          grid.innerHTML = '<div style="grid-column:1/-1;font-size:13px;color:var(--dim);font-style:italic;">No events yet — click "+ New Event" to add one.</div>';
        } else {
          grid.innerHTML = _evtList.map(function(ev) {
            var dateStr = '';
            if (ev.date) {
              var p = ev.date.split('-');
              if (p.length === 3) {
                var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
                dateStr = months[parseInt(p[1],10)-1] + ' ' + parseInt(p[2],10) + ', ' + p[0];
              } else {
                dateStr = ev.date;
              }
            }
            var regBadge = '<span style="display:inline-block;background:rgba(95,212,176,0.15);color:#2e9e7e;font-size:10px;font-weight:700;padding:2px 9px;border-radius:100px;letter-spacing:.5px;">' + (ev.reg_count || 0) + ' registered</span>';
            var metaParts = [];
            if (dateStr) metaParts.push(dateStr);
            if (ev.time) metaParts.push(ev.time);
            if (ev.location) metaParts.push(ev.location);
            var eid = Number(ev.id);
            return '<div class="snap-card" style="display:flex;flex-direction:column;gap:5px;">' +
              '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
                '<span style="font-size:13px;font-weight:800;color:var(--navy);">' + x(ev.title) + '</span>' +
                regBadge +
                '<div class="evt-card-actions" style="display:flex;gap:6px;margin-left:auto;flex-shrink:0;">' +
                  '<button type="button" class="dist-chip" style="text-transform:none;padding:6px 14px;background:rgba(39,152,189,0.1);color:#1a6fa0;border-color:rgba(39,152,189,0.35);" data-action="edit" data-eid="' + eid + '">Edit</button>' +
                  '<button type="button" class="dist-chip" style="text-transform:none;padding:6px 14px;" data-action="embed" data-eid="' + eid + '">Embed Code</button>' +
                  '<button type="button" class="dist-chip" style="text-transform:none;padding:6px 14px;background:rgba(217,119,6,0.1);color:#b45309;border-color:rgba(217,119,6,0.35);" data-action="del" data-eid="' + eid + '">Delete</button>' +
                '</div>' +
              '</div>' +
              (metaParts.length ? '<div style="font-size:11px;color:var(--muted);">' + x(metaParts.join(' \xb7 ')) + '</div>' : '') +
            '</div>';
          }).join('');
        }
      }
      buildEvtFilters(_evtList);
    })
    .catch(function(err) {
      console.error('events-list fetch failed', err);
      if (grid) grid.innerHTML = '<div style="grid-column:1/-1;color:#b45309;font-size:13px;">Could not load events. Refresh to try again.</div>';
      buildEvtFilters([]);
    });

  refreshEvtTable();
}

// ── Event card button handlers (use _evtList — no data-attribute encoding) ──
function evtEdit(id) {
  // Re-fetch for freshness so edits always show latest data
  fetch('/admin/events-list')
    .then(function(r) { return r.json(); })
    .then(function(evts) {
      var ev = evts.find(function(e) { return Number(e.id) === Number(id); });
      if (!ev) { alert('Event not found — try refreshing the page.'); return; }
      document.getElementById('evt-modal-title').textContent = 'Edit Event';
      document.getElementById('evt-edit-id').value = ev.id;
      document.getElementById('evt-f-title').value = ev.title || '';
      document.getElementById('evt-f-date').value = ev.date || '';
      document.getElementById('evt-f-time').value = ev.time || '';
      document.getElementById('evt-f-end-time').value = ev.end_time || '';
      syncTimeChips();
      document.getElementById('evt-f-location').value = ev.location || '';
      document.getElementById('evt-f-desc').value = ev.description || '';
      document.getElementById('evt-f-capacity').value = ev.capacity || '';
      var fields = null;
      try { if (ev.fields) fields = JSON.parse(ev.fields); } catch(e) {}
      evtSetFieldCheckboxes(fields);
      document.getElementById('evt-modal-overlay').classList.add('open');
    })
    .catch(function(err) {
      console.error('evtEdit failed:', err);
      alert('Could not load event data — ' + (err && err.message ? err.message : 'check your connection') + '. Try refreshing the page.');
    });
}

function exportEventRegs() {
  var url = '/admin/export/event-registrations.csv';
  if (typeof activeEvtFilter !== 'undefined' && activeEvtFilter && activeEvtFilter !== 'all') {
    url += '?event=' + encodeURIComponent(activeEvtFilter);
  }
  window.location = url;
}

function evtEmbed(id) {
  var ev = _evtList.find(function(e) { return Number(e.id) === Number(id); });
  if (!ev) { alert('Event data not loaded yet — try refreshing.'); return; }
  var fields = null;
  try { if (ev.fields) fields = JSON.parse(ev.fields); } catch(e) {}
  showEmbedCode(id, ev.title, ev.date, ev.time, ev.location, fields, ev.end_time);
}

function evtDel(id) {
  var ev = _evtList.find(function(e) { return Number(e.id) === Number(id); });
  var title = ev ? ev.title : 'this event';
  if (!confirm('Delete "' + title + '"? This cannot be undone.')) return;
  fetch('/admin/event/' + id, { method: 'DELETE' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.result === 'ok') {
        buildEventsView(all);
      } else {
        alert('Error deleting event. Try again.');
      }
    })
    .catch(function() { alert('Network error. Try again.'); });
}

// ── Time Picker Helpers ───────────────────────────────────────────────

// ── Time chip helpers ─────────────────────────────────────────────────
function setTimeChip(field, val) {
  var inputId = field === 'start' ? 'evt-f-time' : 'evt-f-end-time';
  var chipsId = field === 'start' ? 'start-chips' : 'end-chips';
  document.getElementById(inputId).value = val;
  document.querySelectorAll('#' + chipsId + ' .time-chip').forEach(function(c) {
    c.classList.toggle('active', c.dataset.val === val);
  });
}
function syncTimeChips() {
  var sv = document.getElementById('evt-f-time').value.trim();
  var ev = document.getElementById('evt-f-end-time').value.trim();
  document.querySelectorAll('#start-chips .time-chip').forEach(function(c) { c.classList.toggle('active', c.dataset.val === sv); });
  document.querySelectorAll('#end-chips .time-chip').forEach(function(c) { c.classList.toggle('active', c.dataset.val === ev); });
}

// ── Event Management Functions ─────────────────────────────────────────
var EVT_FIELD_KEYS = ['email','phone','address','guests','yard_sign','endorse','how_to_help','comment'];
var EVT_FIELD_DEFAULTS = { email:true, phone:true, address:true, guests:true, yard_sign:true, endorse:true, how_to_help:true, comment:true };

function evtSetFieldCheckboxes(fields) {
  var cfg = fields || EVT_FIELD_DEFAULTS;
  EVT_FIELD_KEYS.forEach(function(k) {
    var el = document.getElementById('ef-' + k);
    if (el) el.checked = cfg[k] !== undefined ? !!cfg[k] : !!EVT_FIELD_DEFAULTS[k];
  });
}
function evtReadFieldCheckboxes() {
  var cfg = {};
  EVT_FIELD_KEYS.forEach(function(k) {
    var el = document.getElementById('ef-' + k);
    cfg[k] = el ? el.checked : !!EVT_FIELD_DEFAULTS[k];
  });
  return cfg;
}

function openNewEventModal() {
  document.getElementById('evt-modal-title').textContent = 'New Event';
  document.getElementById('evt-edit-id').value = '';
  document.getElementById('evt-f-title').value = '';
  document.getElementById('evt-f-date').value = '';
  document.getElementById('evt-f-location').value = '';
  document.getElementById('evt-f-desc').value = '';
  document.getElementById('evt-f-capacity').value = '';
  document.getElementById('evt-f-time').value = '';
  document.getElementById('evt-f-end-time').value = '';
  syncTimeChips();
  evtSetFieldCheckboxes(null);
  document.getElementById('evt-modal-overlay').classList.add('open');
  setTimeout(function(){ document.getElementById('evt-f-title').focus(); }, 80);
}

function closeEventModal() {
  document.getElementById('evt-modal-overlay').classList.remove('open');
}

function saveEvent() {
  var id       = document.getElementById('evt-edit-id').value;
  var title    = document.getElementById('evt-f-title').value.trim();
  var date     = document.getElementById('evt-f-date').value;
  var time     = document.getElementById('evt-f-time').value.trim();
  var endTime  = document.getElementById('evt-f-end-time').value.trim();
  var location = document.getElementById('evt-f-location').value.trim();
  var desc     = document.getElementById('evt-f-desc').value.trim();
  var capacity = document.getElementById('evt-f-capacity').value;

  if (!title) { alert('Event title is required.'); return; }

  var method = id ? 'PATCH' : 'POST';
  var url    = id ? '/admin/event/' + id : '/admin/event';

  var fields = evtReadFieldCheckboxes();
  fetch(url, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title, date: date, time: time, end_time: endTime, location: location, description: desc, capacity: capacity ? parseInt(capacity) : null, fields: fields })
  })
    .then(function(r){ return r.json(); })
    .then(function(data) {
      if (data.result === 'ok') {
        closeEventModal();
        buildEventsView(all);
      } else {
        alert('Error saving event. Please try again.');
      }
    })
    .catch(function(){ alert('Network error. Please try again.'); });
}

var _currentEmbedEventId = null;

function showEmbedCode(id, title, date, time, location, fields, endTime) {
  _currentEmbedEventId = id || null;
  var labelEl = document.getElementById('evt-embed-label');
  var codeEl  = document.getElementById('evt-embed-code');
  if (labelEl) labelEl.textContent = title + (date ? '  —  ' + date : '');
  if (codeEl)  codeEl.value = generateWidget(title, date, time, location, fields, endTime);
  document.getElementById('evt-embed-overlay').classList.add('open');
}

function closeEmbedModal() {
  document.getElementById('evt-embed-overlay').classList.remove('open');
}

function openWidgetPreview() {
  if (!_currentEmbedEventId) return;
  window.open('/widget-preview/' + _currentEmbedEventId, '_blank', 'width=900,height=800,scrollbars=yes');
}

function copyEmbedCode() {
  var code = document.getElementById('evt-embed-code').value;
  navigator.clipboard.writeText(code).then(function(){
    var btn = document.querySelector('#evt-embed-overlay .modal-copy');
    var orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(function(){ btn.textContent = orig; }, 1800);
  });
}
var _evtGroups = [];
var _evtList   = [];  // populated by buildEventsView fetch
function statMini(val, lbl, rows) {
  if (rows) {
    var idx = _evtGroups.length;
    _evtGroups.push({ label: lbl, rows: rows });
    return '<div onclick="showEvtDrill(' + idx + ')" style="background:var(--white);border:1px solid var(--border);border-radius:3px;padding:8px 10px;cursor:pointer;transition:border-color .12s;" onmouseover="this.style.borderColor=\\'#78E0C4\\'" onmouseout="this.style.borderColor=\\'var(--border)\\'">' +
      '<div style="font-family:Montserrat,sans-serif;font-size:18px;font-weight:800;color:var(--navy);line-height:1;">' + val + '</div>' +
      '<div style="font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--dim);font-weight:600;margin-top:3px;">' + lbl + '</div>' +
    '</div>';
  }
  return '<div style="background:var(--white);border:1px solid var(--border);border-radius:3px;padding:8px 10px;">' +
    '<div style="font-family:Montserrat,sans-serif;font-size:18px;font-weight:800;color:var(--navy);line-height:1;">' + val + '</div>' +
    '<div style="font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--dim);font-weight:600;margin-top:3px;">' + lbl + '</div>' +
  '</div>';
}
function showEvtDrill(idx) {
  var g = _evtGroups[idx];
  if (!g) return;
  _evtGroups._current = idx;
  document.getElementById('evtDrillTitle').textContent = g.label + ' (' + g.rows.length + ')';
  document.getElementById('evtDrillList').innerHTML = g.rows.length
    ? g.rows.map(function(r) {
        var name = ((r.first_name||'') + ' ' + (r.last_name||'')).trim() || '—';
        var meta = [r.email, r.phone ? fmtPhone(r.phone) : ''].filter(Boolean).join(' · ');
        return '<a href="/admin/constituent/' + r.id + '" class="evt-drill-row">' +
          '<span class="evt-drill-name">' + x(name) + '</span>' +
          (meta ? '<span class="evt-drill-meta">' + x(meta) + '</span>' : '') +
        '</a>';
      }).join('')
    : '<div style="padding:24px;color:var(--dim);font-style:italic;">No registrants.</div>';
  document.getElementById('evtDrillOverlay').classList.add('open');
}
function closeEvtDrill() {
  document.getElementById('evtDrillOverlay').classList.remove('open');
}
var _donAcTimer = null;
var _donAcFocus = -1;
function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function donAcSearch(q) {
  document.getElementById('don-contact-id').value = '';
  clearTimeout(_donAcTimer);
  var drop = document.getElementById('don-ac-drop');
  if (!q || q.length < 2) { drop.classList.remove('open'); drop.innerHTML = ''; return; }
  _donAcTimer = setTimeout(function() {
    fetch('/admin/contacts/search?q=' + encodeURIComponent(q))
      .then(function(r){ return r.json(); })
      .then(function(results) {
        _donAcFocus = -1;
        var html = results.map(function(p) {
          var name = ((p.first_name||'') + ' ' + (p.last_name||'')).trim();
          var meta = p.email || '';
          var safeId = Number(p.id);
          var safeName = name.replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'");
          return '<div class="don-ac-item" onmousedown="donAcPick(' + safeId + ',\\'' + safeName + '\\')">' +
            '<div class="don-ac-name">' + _esc(name) + '</div>' +
            (meta ? '<div class="don-ac-meta">' + _esc(meta) + '</div>' : '') +
            '</div>';
        }).join('');
        html += '<div class="don-ac-new" onmousedown="donAcCreateNew()">&#xff0b; &ldquo;' + _esc(q) + '&rdquo; &mdash; Create new contact</div>';
        drop.innerHTML = html;
        drop.classList.add('open');
      });
  }, 180);
}
function donAcPick(id, name) {
  document.getElementById('don-name').value = name;
  document.getElementById('don-contact-id').value = id;
  document.getElementById('don-ac-drop').classList.remove('open');
}
function donAcCreateNew() {
  var q = document.getElementById('don-name').value.trim();
  document.getElementById('don-ac-drop').classList.remove('open');
  closeDonationModal();
  // Pre-fill name and open add person panel
  var parts = q.split(' ');
  setTimeout(function() {
    openAddPerson();
    var fn = document.getElementById('ap-first');
    var ln = document.getElementById('ap-last');
    if (fn) fn.value = parts[0] || '';
    if (ln) ln.value = parts.slice(1).join(' ') || '';
  }, 100);
}
function donAcKey(e) {
  var drop = document.getElementById('don-ac-drop');
  var items = drop.querySelectorAll('.don-ac-item,.don-ac-new');
  if (e.key === 'ArrowDown') { _donAcFocus = Math.min(_donAcFocus + 1, items.length - 1); donAcHighlight(items); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { _donAcFocus = Math.max(_donAcFocus - 1, 0); donAcHighlight(items); e.preventDefault(); }
  else if (e.key === 'Enter' && _donAcFocus >= 0) { items[_donAcFocus] && items[_donAcFocus].dispatchEvent(new Event('mousedown')); e.preventDefault(); }
  else if (e.key === 'Escape') { drop.classList.remove('open'); }
}
function donAcHighlight(items) {
  items.forEach(function(el, i){ el.classList.toggle('focused', i === _donAcFocus); });
}
function openExportModal() { document.getElementById('exp-overlay').classList.add('open'); }
function closeExportModal() { document.getElementById('exp-overlay').classList.remove('open'); }
function exportAsExcel(e, label) {
  // CSV downloads as .xlsx-friendly file (Excel opens CSV natively)
  var a = e.target;
  a.download = label.toLowerCase().replace(/ /g,'_') + '.csv';
}
function exportAsPdf(e, label, csvUrl) {
  e.preventDefault();
  fetch(csvUrl).then(function(r){ return r.text(); }).then(function(csv) {
    var lines = csv.split('\\n').map(function(l){ return l.split(',').map(function(c){ return c.replace(/^"|"$/g,'').replace(/""/g,'"'); }); });
    var html = '<html><head><title>' + label + '</title><style>body{font-family:Arial,sans-serif;font-size:11px;padding:20px;}h2{color:#09254f;margin-bottom:12px;}table{border-collapse:collapse;width:100%;}th{background:#09254f;color:#fff;padding:6px 8px;text-align:left;font-size:9px;letter-spacing:1px;text-transform:uppercase;}td{padding:5px 8px;border-bottom:1px solid #eee;}tr:nth-child(even) td{background:#f7f9fc;}</style></head><body>';
    html += '<h2>' + label + ' &mdash; Blaine Moncrief Campaign</h2>';
    html += '<table><thead><tr>' + lines[0].map(function(h){ return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>';
    html += lines.slice(1).map(function(r){ return '<tr>' + r.map(function(c){ return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('');
    html += '</tbody></table></body></html>';
    var w = window.open('','_blank');
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(function(){ w.print(); }, 400);
  });
}
function toggleAnedotPanel() {
  var panel = document.getElementById('anedot-panel');
  var label = document.getElementById('anedot-toggle-label');
  if (!panel) return;
  var hidden = panel.style.display === 'none';
  panel.style.display = hidden ? 'block' : 'none';
  if (label) label.innerHTML = hidden
    ? 'Real-time donation sync via webhook &#9650;'
    : 'Real-time donation sync via webhook &#9660;';
}
function copyAnedotUrl() {
  var url = document.getElementById('anedot-wh-url').textContent;
  navigator.clipboard.writeText(url).then(function() {
    var btn = document.querySelector('[onclick="copyAnedotUrl()"]');
    var orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.style.background = 'var(--mint-d)';
    setTimeout(function(){ btn.textContent = orig; btn.style.background = 'var(--navy)'; }, 1800);
  });
}
function openDonationModal() {
  var overlay = document.getElementById('don-modal-overlay');
  overlay.style.display = 'flex';
  var today = new Date().toISOString().slice(0,10);
  document.getElementById('don-date').value = today;
  document.getElementById('don-name').value = '';
  document.getElementById('don-contact-id').value = '';
  document.getElementById('don-amount').value = '';
  document.getElementById('don-source').value = '';
  document.getElementById('don-tender').value = '';
  document.getElementById('don-check-num').value = '';
  document.getElementById('don-check-row').style.display = 'none';
  document.getElementById('don-save-msg').style.display = 'none';
  document.getElementById('don-ac-drop').classList.remove('open');
  document.getElementById('don-name').focus();
}
function closeDonationModal() {
  document.getElementById('don-modal-overlay').style.display = 'none';
}
function donTenderChange(val) {
  var row = document.getElementById('don-check-row');
  if (row) row.style.display = (val === 'Check') ? 'block' : 'none';
  if (val !== 'Check') {
    var cn = document.getElementById('don-check-num');
    if (cn) cn.value = '';
  }
}
function saveDonation() {
  var name       = document.getElementById('don-name').value.trim();
  var contactId  = document.getElementById('don-contact-id').value;
  var amount     = document.getElementById('don-amount').value.trim();
  var date       = document.getElementById('don-date').value;
  var source     = document.getElementById('don-source').value.trim();
  var tender     = document.getElementById('don-tender').value;
  var checkNum   = document.getElementById('don-check-num').value.trim();
  if (!name || !amount) { alert('Please enter a donor name and amount.'); return; }
  document.getElementById('don-ac-drop').classList.remove('open');
  fetch('/admin/donation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      donor_name: name, contact_id: contactId || null,
      amount: parseFloat(amount), date: date, source: source,
      tender_type: tender || null, check_number: (tender === 'Check' && checkNum) ? checkNum : null
    })
  }).then(function(r){ return r.json(); }).then(function() {
    document.getElementById('don-save-msg').style.display = 'block';
    setTimeout(function(){
      closeDonationModal();
      if (!document.getElementById('view-donations').classList.contains('view-hidden')) {
        buildDonationsView();
      }
    }, 1200);
  }).catch(function() {
    alert('Error saving donation. Please try again.');
  });
}
function exportEvtDrill() {
  var idx = _evtGroups._current;
  if (idx === undefined) return;
  var g = _evtGroups[idx];
  if (!g || !g.rows.length) return;
  var header = ['First Name','Last Name','Email','Phone','Parish','Yard Sign','Endorse'];
  var rows = g.rows.map(function(r) {
    return [r.first_name||'', r.last_name||'', r.email||'', r.phone||'', r.parish||'', r.yard_sign||'', r.endorse||''].map(function(v){ return '"' + String(v).replace(/"/g,'""') + '"'; }).join(',');
  });
  var csv = [header.join(',')].concat(rows).join('\\n');
  var a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = (g.label || 'export').replace(/[^a-z0-9]/gi,'_') + '.csv';
  a.click();
}

// ── Pipeline ──────────────────────────────────────────────────────────
var PIPELINE_STAGES = ${PIPELINE_JSON};

function getStage(r) {
  return (r.pipeline_stage && r.pipeline_stage !== '') ? r.pipeline_stage : 'new';
}

function buildPipelineSummary(d) {
  var counts = {};
  PIPELINE_STAGES.forEach(function(s){ counts[s.key] = 0; });
  d.forEach(function(r){
    var k = getStage(r);
    if (counts.hasOwnProperty(k)) counts[k]++;
    else counts['new']++;
  });
  var total = d.length;
  var maxC = Math.max.apply(null, Object.values(counts)) || 1;
  var totEl = document.getElementById('pipeline-total');
  if (totEl) totEl.textContent = total + ' constituent' + (total !== 1 ? 's' : '');
  var track = document.getElementById('pipeline-track');
  if (!track) return;
  track.innerHTML = PIPELINE_STAGES.map(function(s, i) {
    var c = counts[s.key];
    var w = Math.round((c / maxC) * 100);
    var arrow = i < PIPELINE_STAGES.length - 1 ? '<div class="pipe-arrow">&#8250;</div>' : '';
    return '<div class="pipe-stage-wrap">' +
      '<div class="pipe-stage" data-sw="pipeline" title="Click to view pipeline">' +
        '<div class="pipe-stage-dot" style="background:' + s.color + '"></div>' +
        '<div class="pipe-stage-count">' + c + '</div>' +
        '<div class="pipe-stage-label">' + s.label + '</div>' +
        '<div class="pipe-stage-bar"><div class="pipe-stage-fill" style="width:' + w + '%;background:' + s.color + '"></div></div>' +
      '</div>' + arrow +
    '</div>';
  }).join('');
}

function buildPipelineBoard(d) {
  var board = document.getElementById('pipeline-board');
  if (!board) return;
  var byStage = {};
  PIPELINE_STAGES.forEach(function(s){ byStage[s.key] = []; });
  d.forEach(function(r){
    var k = getStage(r);
    if (byStage.hasOwnProperty(k)) byStage[k].push(r);
    else byStage['new'].push(r);
  });
  board.innerHTML = PIPELINE_STAGES.map(function(s) {
    var cards = (byStage[s.key] || []).slice().sort(function(a, b) {
      var la = (a.last_name||'').toLowerCase(), lb = (b.last_name||'').toLowerCase();
      if (la < lb) return -1; if (la > lb) return 1;
      var fa = (a.first_name||'').toLowerCase(), fb = (b.first_name||'').toLowerCase();
      return fa < fb ? -1 : fa > fb ? 1 : 0;
    });
    var bodyHTML = cards.length
      ? '<div class="pipe-lane-cards">' + cards.map(function(r) {
          var tags = [];
          if (r.yard_sign === 'Yes') tags.push('Yard Sign');
          if (r.endorse === 'Yes') tags.push('Endorses');
          if ((r.role||'').indexOf('Committee Member') > -1) tags.push('Committee');
          if ((r.role||'').indexOf('Attorney') > -1) tags.push('Attorney');
          var stageOpts = PIPELINE_STAGES.map(function(ps) {
            return '<option value="' + ps.key + '"' + (ps.key === s.key ? ' selected' : '') + '>' + ps.label + '</option>';
          }).join('');
          return '<div class="pipe-card" data-href="/admin/constituent/' + r.id + '">' +
            '<div class="pipe-card-info">' +
              '<div class="pipe-card-name">' + x(r.first_name) + ' ' + x(r.last_name) + '</div>' +
              '<div class="pipe-card-meta">' + x(r.zip||'') + (r.city ? ' &middot; ' + x(r.city) : '') + '</div>' +
              (tags.length ? '<div class="pipe-card-tags">' + tags.map(function(t){ return '<span class="pipe-card-tag">'+t+'</span>'; }).join('') + '</div>' : '') +
            '</div>' +
            '<select class="pipe-card-sel" onclick="event.stopPropagation()" onchange="setPipelineStage(' + r.id + ',this.value)">' + stageOpts + '</select>' +
          '</div>';
        }).join('') + '</div>'
      : '<div class="pipe-lane-empty">No one here yet</div>';
    return '<div class="pipe-lane">' +
      '<div class="pipe-lane-hdr">' +
        '<div class="pipe-lane-dot" style="background:' + s.color + '"></div>' +
        '<div class="pipe-lane-title">' + s.label + '</div>' +
        '<div class="pipe-lane-count">' + cards.length + '</div>' +
      '</div>' +
      bodyHTML +
    '</div>';
  }).join('');
}

function setPipelineStage(id, stage) {
  fetch('/rsvp/' + id + '/pipeline', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pipeline_stage: stage })
  }).then(function(r){ return r.json(); }).then(function(){
    var rec = all.find(function(r){ return r.id === id; });
    if (rec) rec.pipeline_stage = stage;
    buildPipelineSummary(all);
    buildPipelineBoard(all);
  });
}

// Delegated: pipeline summary stage click → switch to Pipeline view
document.addEventListener('click', function(e) {
  var sw = e.target.closest('[data-sw]');
  if (sw) switchView(sw.getAttribute('data-sw'));
});
// Delegated: kanban card click → navigate to constituent profile
document.addEventListener('click', function(e) {
  var card = e.target.closest('[data-href]');
  if (card) window.location = card.getAttribute('data-href');
});

// ── Search autocomplete ───────────────────────────────────────────────
var _qDropFocus = -1;
function qDropdown(val) {
  var drop = document.getElementById('q-dropdown');
  if (!drop) return;
  var q = (val || '').trim().toLowerCase();
  if (q.length < 2) { qDropClose(); return; }
  var matches = all.filter(function(r) {
    return ['first_name','last_name','email','phone','zip'].some(function(f){
      return r[f] && String(r[f]).toLowerCase().includes(q);
    });
  }).slice(0, 8);
  if (!matches.length) {
    drop.innerHTML = '<div class="q-drop-empty">No contacts found</div>';
    drop.classList.add('open');
    return;
  }
  _qDropFocus = -1;
  drop.innerHTML = matches.map(function(r, i) {
    var name = [r.first_name, r.last_name].filter(Boolean).join(' ') || '—';
    var initials = ((r.first_name||'').charAt(0) + (r.last_name||'').charAt(0)).toUpperCase() || '?';
    var meta = [r.email, r.phone ? fmtPhone(r.phone) : null].filter(Boolean).join(' · ') || (r.zip||'');
    return '<a class="q-drop-item" href="/admin/constituent/' + r.id + '" data-idx="' + i + '">' +
      '<div class="q-drop-avatar">' + x(initials) + '</div>' +
      '<div style="min-width:0;">' +
        '<div class="q-drop-name">' + x(name) + '</div>' +
        (meta ? '<div class="q-drop-meta">' + x(meta) + '</div>' : '') +
      '</div>' +
    '</a>';
  }).join('');
  drop.classList.add('open');
}
function qDropClose() {
  var drop = document.getElementById('q-dropdown');
  if (drop) drop.classList.remove('open');
  _qDropFocus = -1;
}
function qDropKey(e) {
  var drop = document.getElementById('q-dropdown');
  if (!drop || !drop.classList.contains('open')) return;
  var items = drop.querySelectorAll('.q-drop-item');
  if (!items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _qDropFocus = Math.min(_qDropFocus + 1, items.length - 1);
    items.forEach(function(el, i){ el.style.background = i === _qDropFocus ? '#f0f7ff' : ''; });
    items[_qDropFocus].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _qDropFocus = Math.max(_qDropFocus - 1, 0);
    items.forEach(function(el, i){ el.style.background = i === _qDropFocus ? '#f0f7ff' : ''; });
    items[_qDropFocus].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && _qDropFocus >= 0) {
    e.preventDefault();
    items[_qDropFocus].click();
  } else if (e.key === 'Escape') {
    qDropClose();
  }
}

// ── Address autocomplete ──────────────────────────────────────────────
(function() {
  var timer = null;
  var results = [];
  var focusIdx = -1;
  var STATE_MAP = {
    'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR','California':'CA',
    'Colorado':'CO','Connecticut':'CT','Delaware':'DE','Florida':'FL','Georgia':'GA',
    'Hawaii':'HI','Idaho':'ID','Illinois':'IL','Indiana':'IN','Iowa':'IA','Kansas':'KS',
    'Kentucky':'KY','Louisiana':'LA','Maine':'ME','Maryland':'MD','Massachusetts':'MA',
    'Michigan':'MI','Minnesota':'MN','Mississippi':'MS','Missouri':'MO','Montana':'MT',
    'Nebraska':'NE','Nevada':'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM',
    'New York':'NY','North Carolina':'NC','North Dakota':'ND','Ohio':'OH','Oklahoma':'OK',
    'Oregon':'OR','Pennsylvania':'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD',
    'Tennessee':'TN','Texas':'TX','Utah':'UT','Vermont':'VT','Virginia':'VA','Washington':'WA',
    'West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY'
  };

  function getInput()   { return document.getElementById('ap-address'); }
  function getSuggest() { return document.getElementById('ap-addr-suggest'); }

  function closeSuggest() {
    var s = getSuggest(); if (s) s.style.display = 'none';
    focusIdx = -1;
  }

  function showSuggest(items) {
    var s = getSuggest(); if (!s) return;
    if (!items.length) { closeSuggest(); return; }
    results = items;
    focusIdx = -1;
    s.innerHTML = items.map(function(r, i) {
      var parts = r.display_name.split(',');
      var addr  = r.address || {};
      var main  = ((addr.house_number ? addr.house_number + ' ' : '') + (addr.road || '')).trim() || parts.slice(0, 2).join(' ').trim();
      var sub   = parts.slice(2, 4).join(',').trim();
      return '<div class="ap-suggest-item" data-idx="' + i + '">' +
        '<div style="font-weight:600;color:var(--navy);">' + main + '</div>' +
        (sub ? '<div style="font-size:11px;color:var(--dim);margin-top:2px;">' + sub + '</div>' : '') +
      '</div>';
    }).join('');
    s.style.display = 'block';
    s.querySelectorAll('.ap-suggest-item').forEach(function(el) {
      el.addEventListener('mousedown', function(e) {
        e.preventDefault();
        selectResult(parseInt(el.getAttribute('data-idx')));
      });
    });
  }

  function selectResult(idx) {
    var r = results[idx]; if (!r || !r.address) return;
    var a  = r.address;
    var st = ((a.house_number ? a.house_number + ' ' : '') + (a.road || '')).trim();
    var ci = a.city || a.town || a.village || a.municipality || a.hamlet || '';
    var abbr = STATE_MAP[a.state] || (a.state ? a.state.slice(0,2).toUpperCase() : 'LA');
    var zp = (a.postcode || '').slice(0, 5);
    var parish = (a.county || '').replace(/ Parish$/i,'').replace(/ County$/i,'');
    if (st) document.getElementById('ap-address').value = st;
    if (ci) document.getElementById('ap-city').value    = ci;
    document.getElementById('ap-state').value           = abbr;
    if (zp) document.getElementById('ap-zip').value     = zp;
    closeSuggest();
    document.getElementById('ap-city').focus();
  }

  function doSearch(q) {
    var s = getSuggest(); if (!s) return;
    s.innerHTML = '<div class="ap-suggest-searching">Searching…</div>';
    s.style.display = 'block';
    fetch('https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&countrycodes=us&q=' + encodeURIComponent(q), {
      headers: { 'Accept-Language': 'en' }
    }).then(function(r){ return r.json(); })
      .then(function(data){ showSuggest(data || []); })
      .catch(function(){ closeSuggest(); });
  }

  document.addEventListener('DOMContentLoaded', function() {
    var inp = getInput(); if (!inp) return;
    inp.addEventListener('input', function() {
      clearTimeout(timer);
      var q = this.value.trim();
      if (q.length < 5) { closeSuggest(); return; }
      timer = setTimeout(function(){ doSearch(q); }, 450);
    });
    inp.addEventListener('keydown', function(e) {
      var s = getSuggest();
      if (!s || s.style.display === 'none') return;
      var items = s.querySelectorAll('.ap-suggest-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        focusIdx = Math.min(focusIdx + 1, items.length - 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        focusIdx = Math.max(focusIdx - 1, 0);
      } else if (e.key === 'Enter' && focusIdx >= 0) {
        e.preventDefault();
        selectResult(focusIdx);
        return;
      } else if (e.key === 'Escape') {
        closeSuggest(); return;
      }
      items.forEach(function(el, i){
        el.classList.toggle('ap-focused', i === focusIdx);
      });
    });
    inp.addEventListener('blur', function(){ setTimeout(closeSuggest, 150); });
  });
})();

// ── Import Contacts ──────────────────────────────────────────────────
var _importRows = [];   // parsed raw rows (array of objects)
var _importHeaders = []; // original column headers

var IMPORT_FIELDS = [
  {val:'first_name', label:'First Name'},
  {val:'last_name',  label:'Last Name'},
  {val:'email',      label:'Email'},
  {val:'phone',      label:'Phone'},
  {val:'company',    label:'Company / Org'},
  {val:'address',    label:'Address'},
  {val:'city',       label:'City'},
  {val:'state',      label:'State'},
  {val:'zip',        label:'Zip'},
  {val:'comment',    label:'Notes'},
  {val:'',           label:'— skip —'},
];

var IMPORT_AUTO = {
  first_name: ['first_name','first name','firstname','first','fname','given name'],
  last_name:  ['last_name','last name','lastname','last','lname','surname','family name'],
  email:      ['email','email address','e-mail','mail'],
  phone:      ['phone','phone number','mobile','cell','telephone','tel'],
  company:    ['company','company/org','organization','organisation','org','employer','firm','business','law firm'],
  address:    ['address','street','street address','addr','street addr'],
  city:       ['city','town'],
  state:      ['state','st'],
  zip:        ['zip','zip code','postal','postal code','zipcode','postcode'],
  comment:    ['comment','comments','notes','note'],
};

function autoMapCol(header) {
  var h = (header||'').toLowerCase().trim();
  for (var f in IMPORT_AUTO) {
    if (IMPORT_AUTO[f].indexOf(h) > -1) return f;
  }
  return '';
}

function openImportContacts() {
  _importRows = []; _importHeaders = [];
  document.getElementById('import-preview').style.display = 'none';
  document.getElementById('import-drop-zone').style.borderColor = '';
  document.getElementById('import-file-input').value = '';
  document.getElementById('import-paste-area').value = '';
  document.getElementById('import-status').textContent = '';
  switchImportTab('file');
  document.getElementById('import-contacts-overlay').classList.add('open');
}
function closeImportContacts() {
  document.getElementById('import-contacts-overlay').classList.remove('open');
}
function switchImportTab(t) {
  document.getElementById('import-panel-file').style.display  = t === 'file'  ? '' : 'none';
  document.getElementById('import-panel-paste').style.display = t === 'paste' ? '' : 'none';
  document.getElementById('itab-file').classList.toggle('active',  t === 'file');
  document.getElementById('itab-paste').classList.toggle('active', t === 'paste');
}

function loadSheetJS(cb) {
  if (window.XLSX) return cb();
  var s = document.createElement('script');
  s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
  s.onload = cb;
  s.onerror = function(){ alert('Could not load Excel parser. Try saving as .csv first.'); };
  document.head.appendChild(s);
}

function handleImportFile(file) {
  if (!file) return;
  var ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'csv' || ext === 'tsv') {
    var reader = new FileReader();
    reader.onload = function(e) { parseImportCSV(e.target.result, ext === 'tsv' ? '\\t' : null); };
    reader.readAsText(file);
  } else if (ext === 'xlsx' || ext === 'xls') {
    loadSheetJS(function() {
      var reader = new FileReader();
      reader.onload = function(e) {
        try {
          var wb = XLSX.read(e.target.result, { type: 'array' });
          var ws = wb.Sheets[wb.SheetNames[0]];
          var data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
          parseImportArray(data);
        } catch(err) { alert('Could not read Excel file: ' + err.message); }
      };
      reader.readAsArrayBuffer(file);
    });
  } else {
    alert('Please upload a .xlsx, .csv, or .tsv file.');
  }
}

function importPastePreview() {
  var raw = document.getElementById('import-paste-area').value.trim();
  if (!raw) { document.getElementById('import-preview').style.display = 'none'; return; }
  parseImportCSV(raw, '\\t');
}

function parseImportCSV(text, delim) {
  // Auto-detect delimiter if not specified
  if (!delim) {
    var tabCount   = (text.match(/\\t/g)  || []).length;
    var commaCount = (text.match(/,/g)   || []).length;
    delim = tabCount > commaCount ? '\\t' : ',';
  }
  var lines = text.replace(/\\r\\n/g,'\\n').replace(/\\r/g,'\\n').split('\\n').filter(function(l){ return l.trim(); });
  if (lines.length < 2) { alert('Need at least a header row and one data row.'); return; }
  var rows = lines.map(function(l) {
    if (delim === ',') return parseCSVLine(l);
    return l.split(delim).map(function(c){ return c.trim(); });
  });
  parseImportArray(rows);
}

function parseCSVLine(line) {
  var result = [], cur = '', inQ = false;
  for (var i = 0; i < line.length; i++) {
    var c = line[i];
    if (c === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else { inQ = !inQ; } }
    else if (c === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  result.push(cur.trim());
  return result;
}

function parseImportArray(rows) {
  if (!rows || rows.length < 2) { alert('No data found.'); return; }
  _importHeaders = rows[0].map(function(h){ return String(h).trim(); });
  _importRows = rows.slice(1).filter(function(r){ return r.some(function(c){ return (c+'').trim(); }); });
  renderImportPreview();
}

function renderImportPreview() {
  var opts = IMPORT_FIELDS.map(function(f){ return '<option value="'+f.val+'"'+(f.val===''?' selected':'')+'>'+f.label+'</option>'; }).join('');
  var mapHTML = _importHeaders.map(function(h, i) {
    var auto = autoMapCol(h);
    var selOpts = IMPORT_FIELDS.map(function(f){ return '<option value="'+f.val+'"'+(f.val===auto?' selected':'')+'>'+f.label+'</option>'; }).join('');
    return '<div style="display:flex;flex-direction:column;gap:3px;min-width:100px;">' +
      '<div style="font-size:10px;color:var(--dim);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px;" title="'+h+'">'+h+'</div>' +
      '<select id="icol-'+i+'" style="font-size:11px;border:1px solid var(--border);border-radius:3px;padding:3px 6px;background:var(--bg);">'+selOpts+'</select>' +
    '</div>';
  }).join('');
  document.getElementById('import-col-map').innerHTML = mapHTML;

  var preview = _importRows.slice(0, 5);
  var tHead = '<thead><tr style="background:var(--bg);">' + _importHeaders.map(function(h){ return '<th style="padding:6px 10px;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--dim);font-weight:700;white-space:nowrap;border-bottom:1px solid var(--border);">'+h+'</th>'; }).join('') + '</tr></thead>';
  var tBody = '<tbody>' + preview.map(function(r){
    return '<tr>' + _importHeaders.map(function(h, i){ return '<td style="padding:5px 10px;border-bottom:1px solid var(--border);font-size:12px;white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis;">'+(r[i]||'')+'</td>'; }).join('') + '</tr>';
  }).join('') + '</tbody>';
  document.getElementById('import-preview-table').innerHTML = tHead + tBody;
  document.getElementById('import-preview-count').textContent = '(first ' + Math.min(5, _importRows.length) + ' of ' + _importRows.length + ' rows)';
  document.getElementById('import-run-btn').textContent = 'Import ' + _importRows.length + ' Contact' + (_importRows.length !== 1 ? 's' : '');
  document.getElementById('import-preview').style.display = '';
  document.getElementById('import-status').textContent = '';
}

function runContactImport() {
  if (!_importRows.length) return;
  var mapping = _importHeaders.map(function(h, i){
    return document.getElementById('icol-'+i).value;
  });
  var rows = _importRows.map(function(r){
    var obj = {};
    mapping.forEach(function(field, i){ if (field) obj[field] = (r[i]||'').toString().trim(); });
    return obj;
  }).filter(function(o){ return o.first_name || o.last_name || o.email; });

  if (!rows.length) { document.getElementById('import-status').textContent = 'No valid rows (need at least First Name, Last Name, or Email mapped).'; return; }
  document.getElementById('import-run-btn').disabled = true;
  document.getElementById('import-status').textContent = 'Importing…';
  fetch('/admin/contacts/import', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ rows: rows })
  }).then(function(r){ return r.json(); }).then(function(res){
    if (res.result === 'ok') {
      document.getElementById('import-status').textContent = '✓ ' + res.imported + ' contact' + (res.imported !== 1 ? 's' : '') + ' imported!';
      document.getElementById('import-run-btn').disabled = false;
      setTimeout(function(){ closeImportContacts(); loadData(); }, 1200);
    } else {
      document.getElementById('import-status').textContent = 'Error: ' + (res.msg || 'Unknown error');
      document.getElementById('import-run-btn').disabled = false;
    }
  }).catch(function(e){
    document.getElementById('import-status').textContent = 'Network error.';
    document.getElementById('import-run-btn').disabled = false;
  });
}

// ── Modal ──
function openAddPerson() {
  ['ap-first','ap-last','ap-email','ap-phone','ap-address','ap-city','ap-zip','ap-comment'].forEach(function(id){ document.getElementById(id).value = ''; });
  document.getElementById('ap-state').value = 'LA';
  document.getElementById('ap-role-voter').checked     = false;
  document.getElementById('ap-role-committee').checked = false;
  document.getElementById('ap-role-attorney').checked  = false;
  document.getElementById('ap-error').style.display = 'none';
  document.getElementById('ap-submit').disabled = false;
  document.getElementById('ap-submit').textContent = 'Add to Database';
  document.getElementById('ap-overlay').classList.add('open');
  document.getElementById('ap-drawer').classList.add('open');
  setTimeout(function(){ document.getElementById('ap-first').focus(); }, 260);
}
function closeAddPerson() {
  document.getElementById('ap-overlay').classList.remove('open');
  document.getElementById('ap-drawer').classList.remove('open');
}
function submitAddPerson() {
  var first = document.getElementById('ap-first').value.trim();
  var last  = document.getElementById('ap-last').value.trim();
  if (!first || !last) { document.getElementById('ap-error').style.display = 'block'; return; }
  document.getElementById('ap-error').style.display = 'none';
  var btn = document.getElementById('ap-submit');
  btn.disabled = true; btn.textContent = 'Saving…';
  fetch('/admin/constituent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      first_name: first,
      last_name:  last,
      email:      document.getElementById('ap-email').value.trim(),
      phone:      document.getElementById('ap-phone').value.trim(),
      address:    document.getElementById('ap-address').value.trim(),
      city:       document.getElementById('ap-city').value.trim(),
      state:      document.getElementById('ap-state').value,
      zip:        document.getElementById('ap-zip').value.trim(),
      role:       [document.getElementById('ap-role-voter').checked ? 'Voter' : '',
                   document.getElementById('ap-role-committee').checked ? 'Committee Member' : '',
                   document.getElementById('ap-role-attorney').checked ? 'Attorney' : '']
                  .filter(Boolean).join(', ') || 'Voter',
      comment:    document.getElementById('ap-comment').value.trim(),
      company:    document.getElementById('ap-company').value.trim()
    })
  }).then(function(r){ return r.json(); }).then(function(d){
    if (d.result === 'success') {
      closeAddPerson();
      loadData();  // refresh the table
    } else { btn.disabled = false; btn.textContent = 'Add to Database'; alert('Error saving. Please try again.'); }
  }).catch(function(){ btn.disabled = false; btn.textContent = 'Add to Database'; alert('Network error. Please try again.'); });
}

function openModal() {
  document.getElementById('modal-overlay').classList.add('open');
  updateWidget();
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}
function handleOverlayClick(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
}

function updateWidget() {
  var label    = document.getElementById('m-label').value;
  var dispDate = document.getElementById('m-date').value;
  var time     = document.getElementById('m-time').value;
  var location = document.getElementById('m-location').value;
  document.getElementById('m-code').value = generateWidget(label, dispDate, time, location);
}

function copyWidget() {
  var code = document.getElementById('m-code').value;
  navigator.clipboard.writeText(code).then(function(){
    var btn = document.querySelector('.modal-copy');
    var orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(function(){ btn.textContent = orig; }, 1800);
  });
}

${generateWidget.toString()}

// ── Donation Chart Tooltip ──
(function(){
  var DON_DATA = [];
  var BAR_CX = [100, 210, 320, 430, 540]; // viewBox x centers for each bar
  var tooltip = document.getElementById('donTooltip');
  var svgEl   = document.getElementById('donChartSvg');
  var boxEl   = document.getElementById('donChartBox');
  if (!tooltip || !svgEl || !boxEl) return;
  svgEl.querySelectorAll('.don-hit').forEach(function(rect) {
    rect.addEventListener('mouseenter', function() {
      var idx = parseInt(this.getAttribute('data-don'));
      var d = DON_DATA[idx];
      tooltip.innerHTML =
        '<strong>' + d.name + '</strong>&nbsp;<span style="color:#78E0C4">' + d.amount + '</span>' +
        '<br><span style="font-weight:400;font-size:10px;opacity:.8">' + d.source + ' &middot; ' + d.date + ' &middot; total ' + d.cumulative + '</span>';
      var svgRect = svgEl.getBoundingClientRect();
      var boxRect = boxEl.getBoundingClientRect();
      var scale   = svgRect.width / 600;
      tooltip.style.left = (BAR_CX[idx] * scale + (svgRect.left - boxRect.left)) + 'px';
      tooltip.style.top  = (svgRect.top - boxRect.top + 4) + 'px';
      tooltip.classList.add('visible');
    });
    rect.addEventListener('mouseleave', function() { tooltip.classList.remove('visible'); });
  });
})();
</script>

<!-- ── Volunteer Modal ── -->
<div class="exp-overlay" id="vol-overlay" onclick="if(event.target===this)closeVolModal()">
  <div class="exp-modal" style="max-width:460px;">
    <button class="modal-close" onclick="closeVolModal()">&#215;</button>
    <p style="font-size:9px;letter-spacing:2.5px;text-transform:uppercase;color:var(--mint-d);font-weight:700;margin:0 0 6px;">Volunteers</p>
    <div class="modal-title" id="vol-modal-title" style="margin-bottom:20px;">Add Volunteer</div>
    <div class="modal-field">
      <label class="modal-label">Contact</label>
      <div style="position:relative;">
        <input id="vol-contact-search" class="modal-input" type="text" placeholder="Search contacts…" oninput="volAcSearch(this.value)" autocomplete="off"/>
        <input type="hidden" id="vol-contact-id"/>
        <div class="don-ac-drop" id="vol-ac-drop"></div>
      </div>
    </div>
    <div class="modal-field">
      <label class="modal-label">Volunteer Role</label>
      <input id="vol-role-input" class="modal-input" type="text" placeholder="e.g. Phone Banking, Canvassing, Event Setup"/>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div class="modal-field">
        <label class="modal-label">Hours Logged</label>
        <input id="vol-hours-input" class="modal-input" type="number" value="0" min="0"/>
      </div>
      <div class="modal-field">
        <label class="modal-label">Status</label>
        <select id="vol-status-input" class="modal-input">
          <option value="new">New</option>
          <option value="active">Active</option>
          <option value="unscheduled">Unscheduled</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>
    </div>
    <div style="display:flex;gap:10px;margin-top:20px;">
      <button class="modal-btn" onclick="saveVolunteer()">Save Volunteer</button>
      <button class="modal-btn secondary" onclick="closeVolModal()">Cancel</button>
    </div>
  </div>
</div>

<!-- ── Endorsement Modal ── -->
<div class="exp-overlay" id="end-overlay" onclick="if(event.target===this)closeEndModal()">
  <div class="exp-modal" style="max-width:480px;">
    <button class="modal-close" onclick="closeEndModal()">&#215;</button>
    <p style="font-size:9px;letter-spacing:2.5px;text-transform:uppercase;color:var(--mint-d);font-weight:700;margin:0 0 6px;">Endorsements</p>
    <div class="modal-title" id="end-modal-title" style="margin-bottom:20px;">Add Endorsement</div>
    <div class="modal-field">
      <label class="modal-label">Name *</label>
      <div style="position:relative;">
        <input id="end-name" class="modal-input" type="text" placeholder="Search contacts or type a new name" autocomplete="off" oninput="endAcSearch(this.value)" style="padding-right:32px;"/>
        <input type="hidden" id="end-contact-id"/>
        <span style="position:absolute;right:11px;top:50%;transform:translateY(-50%);font-size:13px;color:var(--dim);pointer-events:none;">&#x2315;</span>
        <div class="don-ac-drop" id="end-ac-drop"></div>
      </div>
    </div>
    <div class="modal-field">
      <label class="modal-label">Organization / Title</label>
      <input id="end-org" class="modal-input" type="text" placeholder="e.g. Jefferson Bar Association, State Senator"/>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div class="modal-field">
        <label class="modal-label">Tier</label>
        <select id="end-tier" class="modal-input">
          <option value="bar_assoc">Bar Association</option>
          <option value="elected">Elected Official</option>
          <option value="civic">Civic Organization</option>
          <option value="labor">Labor Organization</option>
          <option value="individual">Individual</option>
        </select>
      </div>
      <div class="modal-field">
        <label class="modal-label">Status</label>
        <select id="end-status" class="modal-input">
          <option value="not_contacted">Not Yet Contacted</option>
          <option value="outreach_sent">Outreach Sent</option>
          <option value="in_conversation">In Conversation</option>
          <option value="endorsed">Endorsed</option>
          <option value="declined">Declined</option>
        </select>
      </div>
    </div>
    <div class="modal-field">
      <label class="modal-label">Date Endorsed</label>
      <input id="end-date" class="modal-input" type="date"/>
    </div>
    <div class="modal-field">
      <label class="modal-label">Notes</label>
      <input id="end-notes" class="modal-input" type="text" placeholder="Any notes or context"/>
    </div>
    <div style="display:flex;gap:10px;margin-top:20px;">
      <button class="modal-btn" onclick="saveEndorsement()">Save</button>
      <button class="modal-btn secondary" onclick="closeEndModal()">Cancel</button>
    </div>
  </div>
</div>

<!-- ── Walk List Modal ── -->
<div class="exp-overlay" id="list-overlay" onclick="if(event.target===this)closeListModal()">
  <div class="exp-modal" style="max-width:440px;">
    <button class="modal-close" onclick="closeListModal()">&#215;</button>
    <p style="font-size:9px;letter-spacing:2.5px;text-transform:uppercase;color:var(--mint-d);font-weight:700;margin:0 0 6px;">Canvassing</p>
    <div class="modal-title" id="list-modal-title" style="margin-bottom:20px;">New Walk List</div>
    <div class="modal-field">
      <label class="modal-label">List Name *</label>
      <input id="list-name-input" class="modal-input" type="text" placeholder="e.g. Gretna Precinct 4 — Weekend"/>
    </div>
    <div class="modal-field">
      <label class="modal-label">Area / Precinct / ZIP</label>
      <input id="list-area-input" class="modal-input" type="text" placeholder="e.g. Gretna P-04, ZIP 70053"/>
    </div>
    <div class="modal-field">
      <label class="modal-label">Assign To Volunteer</label>
      <input id="list-assign-input" class="modal-input" type="text" placeholder="Volunteer name (optional)"/>
    </div>
    <div style="display:flex;gap:10px;margin-top:20px;">
      <button class="modal-btn" onclick="saveList()">Save</button>
      <button class="modal-btn secondary" onclick="closeListModal()">Cancel</button>
    </div>
  </div>
</div>

<!-- ── Add Door Modal ── -->
<div class="exp-overlay" id="door-overlay" onclick="if(event.target===this)closeDoorModal()">
  <div class="exp-modal" style="max-width:420px;">
    <button class="modal-close" onclick="closeDoorModal()">&#215;</button>
    <p style="font-size:9px;letter-spacing:2.5px;text-transform:uppercase;color:var(--mint-d);font-weight:700;margin:0 0 6px;">Walk List</p>
    <div class="modal-title" style="margin-bottom:20px;">Add Door</div>
    <div class="modal-field">
      <label class="modal-label">Address *</label>
      <input id="door-addr-input" class="modal-input" type="text" placeholder="e.g. 202 Huey P. Long Ave"/>
    </div>
    <div class="modal-field">
      <label class="modal-label">Voter Name</label>
      <input id="door-voter-input" class="modal-input" type="text" placeholder="Name on voter roll (optional)"/>
    </div>
    <div style="display:flex;gap:10px;margin-top:20px;">
      <button class="modal-btn" onclick="saveDoor()">Add Door</button>
      <button class="modal-btn secondary" onclick="closeDoorModal()">Cancel</button>
    </div>
  </div>
</div>

<!-- ── CSV Import Modal ── -->
<div class="exp-overlay" id="import-overlay" onclick="if(event.target===this)closeImportModal()">
  <div class="exp-modal" style="max-width:520px;">
    <button class="modal-close" onclick="closeImportModal()">&#215;</button>
    <p style="font-size:9px;letter-spacing:2.5px;text-transform:uppercase;color:var(--mint-d);font-weight:700;margin:0 0 6px;">Bulk Import</p>
    <div class="modal-title" style="margin-bottom:8px;">Import Doors from CSV</div>
    <p style="font-size:11px;color:var(--dim);margin-bottom:16px;line-height:1.6;">Paste rows from a voter file below. Each line should be <strong>address, voter name</strong> (voter name is optional). Header row is auto-detected and skipped.</p>
    <div class="modal-field">
      <label class="modal-label">CSV Data</label>
      <textarea id="import-csv-input" class="modal-input" rows="8" style="font-family:monospace;font-size:11px;resize:vertical;" placeholder="1234 Oak St, John Smith&#10;567 Elm Ave, Jane Doe&#10;890 Pine Rd"></textarea>
    </div>
    <div id="import-preview" style="font-size:11px;color:var(--dim);margin-top:8px;min-height:16px;"></div>
    <div style="display:flex;gap:10px;margin-top:16px;">
      <button class="modal-btn" onclick="runImport()">Import Doors</button>
      <button class="modal-btn secondary" onclick="closeImportModal()">Cancel</button>
    </div>
  </div>
</div>

</body></html>`; }


// ════════════════════════════════════════════════════════════════════════
//  CANDIDATE HTML — restricted view (no donation info)
// ════════════════════════════════════════════════════════════════════════
function candidateHTML() { return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Kick-Off Attendance — Blaine Moncrief</title>
<style>${BASE_CSS}
  .stats { grid-template-columns: repeat(3,1fr); }
</style>
</head>
<body>

<header class="hdr">
  <a href="/admin" style="display:block;line-height:0;"><img class="hdr-logo" src="${LOGO_URL}" alt="Blaine Benge Moncrief"/></a>
  <div class="hdr-right">
    <span class="hdr-label">Kick-Off Attendance &nbsp;&middot;&nbsp; June 10, 2026</span>
  </div>
</header>

<div class="notice">
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
  Attendance and guest information only. Contact and campaign operations details are managed separately by campaign staff.
</div>

<div class="stats">
  <div class="stat"><div class="stat-lbl">RSVPs</div><div class="stat-val" id="s-rsvp">—</div></div>
  <div class="stat"><div class="stat-lbl">Total Guests</div><div class="stat-val accent" id="s-guests">—</div></div>
  <div class="stat"><div class="stat-lbl">Yard Signs Requested</div><div class="stat-val" id="s-signs">—</div></div>
</div>

<div class="toolbar">
  <div class="search">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    <input id="q" type="text" placeholder="Search by name…"/>
  </div>
  <span class="tally" id="tally"></span>
</div>

<div class="wrap">
<table>
  <thead><tr>
    <th>#</th><th>Date</th><th>Name</th><th>Guests</th><th>Yard Sign</th>
  </tr></thead>
  <tbody id="tbody"></tbody>
</table>
<div class="empty" id="empty" style="display:none">No RSVPs yet.</div>
</div>

<script>
var all = [];
fetch('/candidate/data').then(r=>r.json()).then(function(d){ all=d; stats(d); render(d); });

// Load real donations into chart tooltip data
fetch('/candidate/donations').then(r=>r.json()).then(function(donations){
  // Sort ascending by date for cumulative chart
  var sorted = donations.slice().sort(function(a,b){ return (a.date||'').localeCompare(b.date||''); });
  var running = 0;
  DON_DATA = sorted.map(function(d){
    running += parseFloat(d.amount)||0;
    return {
      name: d.donor_name || 'Anonymous',
      date: d.date ? new Date(d.date+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '—',
      amount: '$' + (parseFloat(d.amount)||0).toLocaleString(),
      source: d.source || '—',
      cumulative: '$' + running.toLocaleString()
    };
  });
});

function stats(d) {
  document.getElementById('s-rsvp').textContent   = d.length;
  document.getElementById('s-guests').textContent = d.reduce(function(s,r){ return s+(parseInt(r.guests)||1); },0);
  document.getElementById('s-signs').textContent  = d.filter(function(r){ return r.yard_sign==='Yes'; }).length;
}

function render(d) {
  document.getElementById('tally').textContent = d.length + ' attendee' + (d.length!==1?'s':'');
  var tbody = document.getElementById('tbody');
  var empty = document.getElementById('empty');
  if (!d.length) { tbody.innerHTML=''; empty.style.display='block'; return; }
  empty.style.display='none';
  tbody.innerHTML = d.map(function(r){
    var sign = r.yard_sign==='Yes'
      ? '<span class="badge badge-yes">Yes</span>'
      : '<span class="badge badge-no">No</span>';
    var date = fmtDate(r.created_at);
    return '<tr>'+
      '<td class="c-id">'+r.id+'</td>'+
      '<td class="c-date">'+date+'</td>'+
      '<td class="c-name">'+x(r.first_name)+' '+x(r.last_name)+'</td>'+
      '<td><span class="badge badge-guests">'+x(r.guests)+'</span></td>'+
      '<td>'+sign+'</td>'+
    '</tr>';
  }).join('');
}

function x(s){ return s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):''; }

document.getElementById('q').addEventListener('input',function(){
  var q=this.value.toLowerCase();
  render(!q?all:all.filter(function(r){
    return (r.first_name||'').toLowerCase().includes(q)||(r.last_name||'').toLowerCase().includes(q);
  }));
});
</script>
</body></html>`; }


// ════════════════════════════════════════════════════════════════════════
//  CONSTITUENT PROFILE HTML
// ════════════════════════════════════════════════════════════════════════
async function constituentHTML(id, opts) {
  const isCand = !!(opts && opts.candidate);
  const _row = await dbGet('SELECT * FROM rsvps WHERE id=?', [id]);
  const _data = JSON.stringify(_row || null);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Constituent Profile — Blaine Moncrief</title>
${isCand ? '<style>#don-hist-card,#p-giving-block{display:none!important;}</style>' : ''}
<style>${BASE_CSS}
  .page-body { max-width: 860px; margin: 0 auto; padding: 28px 24px 60px; }
  .back-link { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: .5px; text-decoration: none; margin-bottom: 20px; transition: color .15s; }
  .back-link:hover { color: var(--navy); }
  .p-hero { background: var(--navy); border-radius: 6px; padding: 32px 36px; margin-bottom: 20px; display: flex; align-items: stretch; gap: 28px; }
  .p-hero-left { flex: 1; min-width: 0; }
  .p-hero-map { width: 270px; flex-shrink: 0; border-radius: 4px; overflow: hidden; background: rgba(255,255,255,.04); }
  .p-hero-map iframe { width: 100%; height: 100%; border: none; display: block; min-height: 200px; }
  .p-eyebrow { font-size: 9px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--mint); font-weight: 700; margin-bottom: 12px; }
  .p-name { font-family: 'Playfair Display', Georgia, serif; font-size: 34px; color: #fff; line-height: 1.1; margin-bottom: 8px; }
  .p-meta { font-size: 11px; color: var(--dim); letter-spacing: .3px; margin-top: 28px; }
  .p-event-badge { display: inline-block; margin-top: 14px; background: rgba(120,224,196,.15); border: 1px solid rgba(120,224,196,.3); color: var(--mint); font-size: 10px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; padding: 5px 14px; border-radius: 100px; }
  .role-pills { display: inline-flex; gap: 6px; margin-top: 10px; }
  .role-pill { padding: 4px 13px; border-radius: 100px; cursor: pointer; font-size: 10px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; font-family: 'Montserrat', sans-serif; transition: all .15s; background: transparent; color: rgba(255,255,255,.3); border: 1px solid rgba(255,255,255,.15); }
  .role-pill:hover { color: rgba(255,255,255,.6); border-color: rgba(255,255,255,.3); }
  .role-pill.active.voter { background: rgba(255,255,255,.13); color: rgba(255,255,255,.85); border-color: rgba(255,255,255,.3); }
  .role-pill.active.committee { background: var(--mint); color: var(--navy); border-color: var(--mint); }
  .role-pill.active.attorney { background: #d4a843; color: #fff; border-color: #d4a843; }
  .p-cards { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .p-evt-list { margin-top: 8px; display: flex; flex-direction: column; gap: 5px; }
  .p-evt-item { font-size: 11px; font-weight: 600; color: var(--navy); background: rgba(120,224,196,.12); border: 1px solid rgba(120,224,196,.25); border-radius: 100px; padding: 3px 10px; display: inline-block; letter-spacing: .3px; }
  .p-card { background: #fff; border: 1px solid var(--border); border-radius: 6px; padding: 20px 22px; }
  .p-card-lbl { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: var(--dim); font-weight: 700; margin-bottom: 10px; }
  .p-card-num { font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif; font-size: 32px; font-weight: 800; color: var(--navy); line-height: 1; }
  .p-card-sub { font-size: 11px; color: var(--muted); margin-top: 6px; line-height: 1.4; }
  .giving-bar-wrap { margin-top: 10px; }
  .giving-bar-meta { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 5px; }
  .giving-bar-remaining { font-size: 10px; color: var(--dim); font-weight: 600; letter-spacing: .4px; }
  .giving-bar-cap { font-size: 10px; color: var(--dim); font-weight: 600; letter-spacing: .4px; }
  .giving-bar-track { height: 5px; background: var(--border); border-radius: 100px; overflow: hidden; }
  .giving-bar-fill { height: 100%; border-radius: 100px; transition: width .5s ease, background .3s; }
  .sign-toggle { padding: 7px 18px; border-radius: 100px; border: none; cursor: pointer; font-size: 11px; font-weight: 700; letter-spacing: .5px; font-family: 'Montserrat', sans-serif; transition: all .15s; }
  .sign-toggle.pend { background: #f0f2f5; color: var(--muted); }
  .sign-toggle.pend:hover { background: #d8f4ec; color: #2e9e7e; }
  .sign-toggle.done { background: rgba(95,212,176,.18); color: #2e9e7e; }
  .sign-toggle.done:hover { background: #f0f2f5; color: var(--dim); }
  .endorse-chip { display: inline-flex; align-items: center; gap: 5px; padding: 5px 14px; border-radius: 100px; font-size: 11px; font-weight: 700; }
  .endorse-chip.yes { background: rgba(95,212,176,.15); color: #2e9e7e; }
  .endorse-chip.no  { background: #f0f2f5; color: var(--dim); }
  .s-card { background: #fff; border: 1px solid var(--border); border-radius: 6px; padding: 24px 28px; margin-bottom: 16px; }
  .s-label { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: var(--dim); font-weight: 700; margin-bottom: 18px; }
  .ct-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  .ct-field { display: flex; flex-direction: column; gap: 4px; }
  .ct-lbl { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--dim); font-weight: 600; }
  .ct-val { display: none; }
  .ct-input { font-size: 14px; color: var(--navy); border: 1px solid var(--border); border-radius: 3px; padding: 8px 10px; font-family: 'Montserrat', sans-serif; width: 100%; background: #fff; outline: none; display: block; }
  .ct-input:focus { border-color: var(--mint); box-shadow: 0 0 0 2px rgba(120,224,196,.18); }
  .edit-row { display: flex; gap: 10px; align-items: center; margin-top: 20px; }
  .btn-main { display: none; }
  .btn-save { background: var(--mint); color: var(--navy); border: none; padding: 10px 24px; border-radius: 3px; font-size: 11px; font-weight: 800; letter-spacing: 1.5px; text-transform: uppercase; cursor: pointer; font-family: 'Montserrat', sans-serif; transition: background .15s; display: inline-block; }
  .btn-save:hover { background: #5fd4b0; }
  .btn-save:disabled { opacity: .5; cursor: not-allowed; }
  .btn-ghost { display: none; }
  .save-msg { font-size: 11px; color: #2e9e7e; font-weight: 700; display: none; letter-spacing: .5px; }
  .edit-textarea { font-size: 14px; color: var(--text); border: 1px solid var(--border); border-radius: 3px; padding: 10px 12px; font-family: 'Montserrat', sans-serif; width: 100%; background: #fff; outline: none; resize: vertical; min-height: 90px; line-height: 1.5; display: block; margin-top: 4px; }
  .edit-textarea:focus { border-color: var(--mint); box-shadow: 0 0 0 2px rgba(120,224,196,.18); }
  .tags { display: flex; flex-wrap: wrap; gap: 8px; }
  .ptag { background: rgba(120,224,196,.12); border: 1px solid rgba(120,224,196,.25); color: var(--navy); font-size: 11px; font-weight: 600; padding: 5px 12px; border-radius: 100px; }
  .ptag-none { font-size: 13px; color: var(--dim); font-style: italic; }
  .comment-block { font-size: 14px; color: var(--navy); line-height: 1.65; padding: 14px 18px; background: #f8f9fb; border-left: 3px solid var(--mint); border-radius: 0 4px 4px 0; font-style: italic; }
  .comment-none { font-size: 13px; color: var(--dim); font-style: italic; }
  .edit-checks { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 24px; margin-top: 12px; }
  .edit-check-item { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
  .edit-check-item input[type="checkbox"] { width: 15px; height: 15px; accent-color: #78E0C4; cursor: pointer; flex-shrink: 0; margin-top: 2px; }
  .edit-check-label { font-size: 13px; color: var(--muted); line-height: 1.4; }
  .edit-textarea { font-size: 14px; color: var(--text); border: 1px solid var(--border); border-radius: 3px; padding: 10px 12px; font-family: 'Montserrat', sans-serif; width: 100%; background: #fff; outline: none; resize: vertical; min-height: 90px; line-height: 1.5; display: none; margin-top: 4px; }
  .edit-textarea:focus { border-color: var(--mint-d); }
  .edit-select { width: 100%; font-size: 14px; color: var(--navy); border: 1px solid var(--border); border-radius: 3px; padding: 8px 10px; font-family: 'Montserrat', sans-serif; background: #fff; outline: none; margin-bottom: 8px; }
  .edit-select:focus { border-color: var(--mint-d); }
  /* Pipeline stage on profile */
  .pipe-progress { display: flex; align-items: flex-start; flex-wrap: nowrap; overflow-x: auto; gap: 0; padding: 4px 0 8px; }
  .pipe-step-wrap { display: flex; align-items: flex-start; flex: 1; min-width: 60px; }
  .pipe-step {
    flex: 1; text-align: center; cursor: pointer; padding: 8px 4px;
    border-radius: 4px; transition: background .12s;
    display: flex; flex-direction: column; align-items: center;
  }
  .pipe-step:hover { background: var(--bg); }
  .pipe-step-dot {
    width: 18px; height: 18px; border-radius: 50%;
    border: 2.5px solid var(--border); background: var(--white);
    transition: all .2s; flex-shrink: 0;
  }
  .pipe-step.past .pipe-step-dot  { border-color: currentColor; background: currentColor; opacity: .5; }
  .pipe-step.active .pipe-step-dot { border-color: currentColor; border-width: 3px; box-shadow: 0 0 0 3px rgba(0,0,0,.08); background: var(--white); }
  .pipe-step-label { font-size: 9px; letter-spacing: .7px; text-transform: uppercase; font-weight: 700; color: var(--dim); line-height: 1.3; margin-top: 6px; }
  .pipe-step.past .pipe-step-label { opacity: .6; }
  .pipe-step.active .pipe-step-label { color: var(--navy); font-weight: 800; }
  .pipe-connector { width: 20px; height: 2px; background: var(--border); margin-top: 17px; flex-shrink: 0; transition: background .2s; }
  .pipe-connector.filled { background: var(--mint-d); opacity: .45; }

  /* Donation history card */
  .don-hist-preview { display: inline-flex; align-items: center; gap: 6px; font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; background: rgba(120,224,196,.12); color: var(--mint-d); border: 1px solid rgba(120,224,196,.25); padding: 3px 10px; border-radius: 100px; margin-left: 10px; vertical-align: middle; }
  .don-hist-summary { display: flex; gap: 28px; margin-bottom: 20px; padding-bottom: 18px; border-bottom: 1px solid var(--border); }
  .don-hist-num { font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif; font-size: 26px; font-weight: 800; color: var(--navy); line-height: 1; }
  .don-hist-num.accent { color: var(--mint-d); }
  .don-hist-lbl { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: var(--dim); font-weight: 700; margin-top: 5px; }
  .don-row { display: flex; align-items: center; gap: 14px; padding: 10px 0; border-bottom: 1px solid #f0f2f5; }
  .don-row:last-child { border-bottom: none; }
  .don-row-date { font-size: 11px; color: var(--dim); min-width: 90px; }
  .don-row-amt { font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif; font-size: 18px; font-weight: 800; color: var(--navy); min-width: 70px; }
  .don-row-badge { font-size: 10px; font-weight: 600; padding: 2px 9px; border-radius: 100px; background: rgba(120,224,196,.12); color: var(--navy); border: 1px solid rgba(120,224,196,.2); }
  .don-row-method { font-size: 11px; color: var(--dim); margin-left: auto; }
  /* Address autocomplete on profile */
  .ct-suggest {
    display:none; position:absolute; top:100%; left:0; right:0; z-index:200;
    background:#fff; border:1px solid var(--border); border-top:none;
    border-radius:0 0 4px 4px; box-shadow:0 6px 20px rgba(6,15,30,.13);
    max-height:220px; overflow-y:auto;
  }
  .ct-sug-item {
    padding:9px 12px; font-size:12px; color:var(--text); cursor:pointer;
    border-bottom:1px solid #f0f2f5; line-height:1.45;
  }
  .ct-sug-item:last-child { border-bottom:none; }
  .ct-sug-item:hover, .ct-sug-item.ct-focused { background:#eaf9f5; color:var(--navy); }
  .ct-sug-searching { padding:9px 12px; font-size:12px; color:var(--dim); font-style:italic; }
  @media(max-width:900px) { .p-cards{grid-template-columns:1fr 1fr;} }
  @media(max-width:640px) {
    .p-cards{grid-template-columns:1fr 1fr;}
    .ct-grid{grid-template-columns:1fr;}
    .p-hero{padding:24px 20px; flex-direction:column;}
    .p-hero-map{width:100%; height:180px;}
    .page-body{padding:16px 16px 40px;}
    .edit-checks{grid-template-columns:1fr;}
    /* Header: hide label, shrink buttons */
    .hdr-label { display:none; }
    .hdr-divider { display:none; }
    #hdr-save-btn { padding:7px 14px !important; font-size:10px !important; }
    .hdr-right { gap:8px !important; }
  }
</style>
</head>
<body>

<header class="hdr" style="position:sticky;top:0;z-index:40;">
  <a href="/admin" style="display:block;line-height:0;"><img src="${LOGO_URL}" class="hdr-logo" alt="Blaine Moncrief"/></a>
  <div class="hdr-right">
    <button id="hdr-save-btn" onclick="saveEdit()" style="background:var(--mint);color:var(--navy);border:none;padding:8px 20px;border-radius:2px;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;font-family:'Montserrat',sans-serif;cursor:pointer;transition:background .15s;">Save Changes</button>
    <span id="hdr-save-msg" style="font-size:11px;color:#78E0C4;font-weight:700;display:none;letter-spacing:.5px;">&#10003; Saved</span>
    <button onclick="deleteConstituent()" style="background:none;color:rgba(255,255,255,.4);border:1px solid rgba(255,255,255,.15);padding:7px 16px;border-radius:2px;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;font-family:'Montserrat',sans-serif;cursor:pointer;transition:all .15s;margin-left:4px;" onmouseover="this.style.color='rgba(255,255,255,.8)';this.style.borderColor='rgba(255,255,255,.35)';" onmouseout="this.style.color='rgba(255,255,255,.4)';this.style.borderColor='rgba(255,255,255,.15)';">Delete</button>
    <div class="hdr-divider"></div>
    <span class="hdr-label">Constituent Profile</span>
  </div>
</header>

<div class="page-body">

<a href="/admin" class="back-link">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
  All Contacts
</a>

<div class="p-hero">
  <div class="p-hero-left">
    <div class="p-eyebrow">Constituent Profile</div>
    <div class="p-name" id="p-name">Loading&#8230;</div>
    <div id="p-company" style="font-size:12px;color:rgba(255,255,255,.55);font-weight:600;margin-top:4px;letter-spacing:.3px;display:none;"></div>
    <div id="p-district-badge" style="display:none;margin-top:10px;"></div>
    <div id="p-role"></div>
  </div>
  <div class="p-hero-map" id="p-hero-map" style="display:none;">
    <div id="hero-tile-map" style="width:100%;height:100%;min-height:200px;"></div>
  </div>
</div>

<div class="p-cards">
  <div class="p-card">
    <div id="p-giving-block">
    <div class="p-card-lbl">Total Giving</div>
    <div class="p-card-num" id="p-total-giving" style="font-size:26px;">&#8212;</div>
    <div class="giving-bar-wrap">
      <div class="giving-bar-meta">
        <span class="giving-bar-remaining" id="p-giving-remaining"></span>
        <span class="giving-bar-cap" id="p-giving-cap"></span>
      </div>
      <div class="giving-bar-track">
        <div class="giving-bar-fill" id="p-giving-bar" style="width:0%;background:#78E0C4;"></div>
      </div>
    </div>
    </div>
    <!-- Guest edit fields kept for save functionality -->
    <div id="edit-guests-wrap" style="display:none; margin-top:10px;">
      <select class="edit-select" id="i-guests">
        <option value="1">1 — Just me</option>
        <option value="2">2</option>
        <option value="3">3</option>
        <option value="4">4</option>
        <option value="5+">5 or more</option>
      </select>
      <input class="ct-input" id="i-gnames" type="text" placeholder="Guest names" style="display:block;font-size:13px;"/>
    </div>
  </div>
  <div class="p-card">
    <div class="p-card-lbl">Yard Sign</div>
    <div id="p-sign" style="margin-top:4px;"></div>
  </div>
  <div class="p-card">
    <div class="p-card-lbl">Endorsement</div>
    <div id="p-endorse" style="margin-top:4px;"></div>
  </div>
  <div class="p-card">
    <div class="p-card-lbl">Events Attended</div>
    <div class="p-card-num" id="p-evt-count" style="font-size:26px;font-weight:700;color:var(--navy);">—</div>
    <div class="p-evt-list" id="p-evt-list"></div>
  </div>
</div>

<div class="s-card">
  <div class="s-label">Campaign Pipeline Stage</div>
  <div class="pipe-progress" id="pp-track"></div>
</div>

<div class="s-card">
  <div class="s-label">Contact Information</div>
  <div class="ct-grid">
    <div class="ct-field">
      <div class="ct-lbl">First Name</div>
      <div class="ct-val" id="v-first"></div>
      <input class="ct-input" id="i-first" type="text" placeholder="First name"/>
    </div>
    <div class="ct-field">
      <div class="ct-lbl">Last Name</div>
      <div class="ct-val" id="v-last"></div>
      <input class="ct-input" id="i-last" type="text" placeholder="Last name"/>
    </div>
    <div class="ct-field">
      <div class="ct-lbl">Email</div>
      <div class="ct-val" id="v-email"></div>
      <input class="ct-input" id="i-email" type="email" placeholder="email@example.com"/>
    </div>
    <div class="ct-field">
      <div class="ct-lbl">Phone</div>
      <div class="ct-val" id="v-phone"></div>
      <input class="ct-input" id="i-phone" type="tel" placeholder="(504) 555-0000"/>
    </div>
    <div class="ct-field" style="position:relative;">
      <div class="ct-lbl">Address</div>
      <div class="ct-val" id="v-address"></div>
      <input class="ct-input" id="i-address" type="text" placeholder="123 Main St" autocomplete="off"/>
      <div class="ct-suggest" id="ct-addr-suggest"></div>
    </div>
    <div class="ct-field">
      <div class="ct-lbl">City</div>
      <div class="ct-val" id="v-city"></div>
      <input class="ct-input" id="i-city" type="text" placeholder="Metairie"/>
    </div>
    <div class="ct-field">
      <div class="ct-lbl">State</div>
      <div class="ct-val" id="v-state"></div>
      <input class="ct-input" id="i-state" type="text" placeholder="LA" maxlength="2"/>
    </div>
    <div class="ct-field">
      <div class="ct-lbl">Zip Code</div>
      <div class="ct-val" id="v-zip"></div>
      <input class="ct-input" id="i-zip" type="text" placeholder="70001" oninput="autoParish(this.value)"/>
    </div>
    <div class="ct-field">
      <div class="ct-lbl">Parish</div>
      <div class="ct-val" id="v-parish"></div>
      <input class="ct-input" id="i-parish" type="text" placeholder="Jefferson"/>
    </div>
    <div class="ct-field" style="grid-column:1/-1;">
      <div class="ct-lbl">Company / Organization</div>
      <div class="ct-val" id="v-company"></div>
      <input class="ct-input" id="i-company" type="text" placeholder="Law firm, employer, organization…"/>
    </div>
  </div>
  <div class="edit-row">
    <button class="btn-save" id="btn-save" onclick="saveEdit()">Save Changes</button>
    <span class="save-msg" id="save-msg">&#10003; Saved</span>
  </div>
</div>

<div class="s-card">
  <div class="s-label">How They Want to Help</div>
  <div class="tags" id="p-helps" style="display:none;"></div>
  <div id="edit-helps-wrap">
    <div class="edit-checks">
      <label class="edit-check-item"><input type="checkbox" id="eh-yardsign"/><span class="edit-check-label">Provide a sign location</span></label>
      <label class="edit-check-item"><input type="checkbox" id="eh-calls"/><span class="edit-check-label">Make phone calls</span></label>
      <label class="edit-check-item"><input type="checkbox" id="eh-knock"/><span class="edit-check-label">Knock on doors</span></label>
      <label class="edit-check-item"><input type="checkbox" id="eh-wave"/><span class="edit-check-label">Wave signs</span></label>
      <label class="edit-check-item"><input type="checkbox" id="eh-errands"/><span class="edit-check-label">Run errands for the committee</span></label>
      <label class="edit-check-item"><input type="checkbox" id="eh-host"/><span class="edit-check-label">Host a meet &amp; greet or other event</span></label>
      <label class="edit-check-item"><input type="checkbox" id="eh-inkind"/><span class="edit-check-label">In-kind contribution or venue space</span></label>
      <label class="edit-check-item"><input type="checkbox" id="eh-other"/><span class="edit-check-label">Other — contact me directly</span></label>
    </div>
  </div>
</div>

<div class="s-card">
  <div class="s-label">Comments</div>
  <div id="p-comment"></div>
  <textarea class="edit-textarea" id="i-comment" placeholder="Comments or questions…"></textarea>
</div>

<div class="s-card" id="don-hist-card">
  <div class="s-label">
    Donation History
  </div>
  <div class="don-hist-summary">
    <div class="don-hist"><div class="don-hist-num accent" id="dh-total">—</div><div class="don-hist-lbl">Total Given</div></div>
    <div class="don-hist"><div class="don-hist-num" id="dh-count">—</div><div class="don-hist-lbl">Donations</div></div>
    <div class="don-hist"><div class="don-hist-num" id="dh-last">—</div><div class="don-hist-lbl">Last Gift</div></div>
  </div>
  <div id="dh-rows"></div>
</div>

  <div class="p-meta">Registered <strong id="p-date">&#8212;</strong> &nbsp;&middot;&nbsp; ID #<strong id="p-id">&#8212;</strong></div>
</div>

<footer class="foot">Campaign Admin &nbsp;&middot;&nbsp; Blaine Benge Moncrief for Judge, Division H &nbsp;&middot;&nbsp; 24th JDC</footer>

<script>
var CID = ${id};
var IS_CANDIDATE = ${isCand};   // candidate view = no financial data
var rec = null;

function xe(s) {
  if (!s) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function fmtPhone(p) {
  if (!p) return "";
  var d = String(p).replace(/\D/g,"");
  if (d.length === 10) return d.slice(0,3)+"-"+d.slice(3,6)+"-"+d.slice(6);
  return p;
}
function fmtDate(s) {
  if (!s) return "";
  var p = (s||"").slice(0,10).split("-");
  if (p.length !== 3) return s;
  var mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return mo[parseInt(p[1],10)-1] + " " + parseInt(p[2],10) + ", " + p[0];
}
var ZIP_PARISH = {
  "70001":"Jefferson","70002":"Jefferson","70003":"Jefferson","70004":"Jefferson","70005":"Jefferson",
  "70006":"Jefferson","70009":"Jefferson","70010":"Jefferson","70011":"Jefferson","70031":"Jefferson",
  "70033":"Jefferson","70036":"Jefferson","70037":"Jefferson","70047":"Jefferson","70053":"Jefferson",
  "70055":"Jefferson","70056":"Jefferson","70057":"Jefferson","70058":"Jefferson","70059":"Jefferson",
  "70060":"Jefferson","70062":"Jefferson","70063":"Jefferson","70064":"Jefferson","70065":"Jefferson",
  "70067":"Jefferson","70072":"Jefferson","70073":"Jefferson","70094":"Jefferson",
  "70112":"Orleans","70113":"Orleans","70114":"Orleans","70115":"Orleans","70116":"Orleans",
  "70117":"Orleans","70118":"Orleans","70119":"Orleans","70121":"Orleans","70122":"Orleans",
  "70123":"Orleans","70124":"Orleans","70125":"Orleans","70126":"Orleans","70127":"Orleans",
  "70128":"Orleans","70129":"Orleans","70130":"Orleans","70131":"Orleans","70163":"Orleans",
  "70032":"St. Bernard","70043":"St. Bernard","70044":"St. Bernard","70085":"St. Bernard",
  "70086":"St. Bernard","70092":"St. Bernard",
  "70040":"Plaquemines","70041":"Plaquemines","70050":"Plaquemines","70068":"Plaquemines",
  "70069":"Plaquemines","70070":"Plaquemines","70071":"Plaquemines","70074":"Plaquemines",
  "70075":"Plaquemines","70076":"Plaquemines","70082":"Plaquemines","70083":"Plaquemines",
  "70084":"Plaquemines","70090":"Plaquemines",
  "70030":"St. Charles","70039":"St. Charles","70052":"St. Charles","70079":"St. Charles","70087":"St. Charles",
  "70433":"St. Tammany","70434":"St. Tammany","70435":"St. Tammany","70437":"St. Tammany",
  "70444":"St. Tammany","70445":"St. Tammany","70446":"St. Tammany","70447":"St. Tammany",
  "70448":"St. Tammany","70450":"St. Tammany","70452":"St. Tammany","70455":"St. Tammany",
  "70456":"St. Tammany","70458":"St. Tammany","70459":"St. Tammany","70460":"St. Tammany",
  "70461":"St. Tammany","70464":"St. Tammany","70466":"St. Tammany","70471":"St. Tammany",
  "70401":"Tangipahoa","70402":"Tangipahoa","70403":"Tangipahoa","70404":"Tangipahoa",
  "70420":"Tangipahoa","70422":"Tangipahoa","70426":"Tangipahoa","70427":"Tangipahoa",
  "70428":"Tangipahoa","70429":"Tangipahoa","70430":"Tangipahoa","70436":"Tangipahoa",
  "70443":"Tangipahoa","70451":"Tangipahoa","70454":"Tangipahoa","70463":"Tangipahoa",
  "70301":"Terrebonne","70302":"Terrebonne","70310":"Terrebonne","70352":"Terrebonne",
  "70355":"Terrebonne","70356":"Terrebonne","70359":"Terrebonne","70360":"Terrebonne",
  "70361":"Terrebonne","70363":"Terrebonne","70364":"Terrebonne","70380":"Terrebonne",
  "70340":"Lafourche","70341":"Lafourche","70343":"Lafourche","70344":"Lafourche",
  "70345":"Lafourche","70346":"Lafourche","70353":"Lafourche","70354":"Lafourche",
  "70357":"Lafourche","70358":"Lafourche","70373":"Lafourche","70374":"Lafourche","70377":"Lafourche",
  "70501":"Lafayette","70503":"Lafayette","70504":"Lafayette","70505":"Lafayette",
  "70506":"Lafayette","70507":"Lafayette","70508":"Lafayette","70509":"Lafayette"
};
function autoParish(zip) {
  var p = ZIP_PARISH[zip] || "";
  var el = document.getElementById("i-parish");
  if (el && (!el.value || ZIP_PARISH[zip])) {
    el.value = p;
    refreshDistrictBadge(p);
  }
}
function refreshDistrictBadge(parish) {
  var dbEl = document.getElementById("p-district-badge");
  if (!dbEl) return;
  if (parish && parish !== "Jefferson") {
    dbEl.innerHTML = "<span style='display:inline-block;background:rgba(154,170,187,.18);border:1px solid rgba(154,170,187,.35);color:#9aaabb;font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:4px 12px;border-radius:100px;'>Out of District &mdash; " + xe(parish) + " Parish</span>";
    dbEl.style.display = "block";
  } else if (parish === "Jefferson") {
    dbEl.innerHTML = "<span style='display:inline-block;background:rgba(120,224,196,.15);border:1px solid rgba(120,224,196,.3);color:#78E0C4;font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:4px 12px;border-radius:100px;'>&#10003; Jefferson Parish &mdash; Eligible Voter</span>";
    dbEl.style.display = "block";
  } else {
    dbEl.style.display = "none";
  }
}

var PROFILE_PIPELINE = ${PIPELINE_JSON};

try {
  var d = ${_data};
  if (!d) { document.getElementById("p-name").textContent = "Constituent not found."; }
  else { rec = d; paint(d); }
} catch(e) {
  document.getElementById("p-name").textContent = "Error: " + e.message;
  console.error("Paint error:", e);
}

function paint(d) {
  if (!d || d.error) { document.getElementById("p-name").textContent = "Constituent not found."; return; }
  document.title = (d.first_name||"") + " " + (d.last_name||"") + " — Blaine Moncrief";
  document.getElementById("p-name").textContent = (d.first_name||"") + " " + (d.last_name||"");
  var compEl = document.getElementById("p-company");
  if (compEl) { if (d.company) { compEl.textContent = d.company; compEl.style.display = "block"; } else { compEl.style.display = "none"; } }
  document.getElementById("p-date").textContent  = fmtDate(d.created_at);
  document.getElementById("p-id").textContent    = d.id;
  // Events Attended card
  var evts = d._events || (d.event ? [d.event] : []);
  document.getElementById("p-evt-count").textContent = evts.length || "0";
  var evtList = document.getElementById("p-evt-list");
  evtList.innerHTML = evts.map(function(ev){ return '<span class="p-evt-item">' + xe(ev) + '</span>'; }).join('');
  // District eligibility badge
  var dbEl = document.getElementById("p-district-badge");
  if (dbEl) {
    if (d.parish && d.parish !== "Jefferson") {
      dbEl.innerHTML = "<span style='display:inline-block;background:rgba(154,170,187,.18);border:1px solid rgba(154,170,187,.35);color:#9aaabb;font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:4px 12px;border-radius:100px;'>Out of District &mdash; " + xe(d.parish) + " Parish</span>";
      dbEl.style.display = "block";
    } else if (d.parish === "Jefferson") {
      dbEl.innerHTML = "<span style='display:inline-block;background:rgba(120,224,196,.15);border:1px solid rgba(120,224,196,.3);color:#78E0C4;font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:4px 12px;border-radius:100px;'>&#10003; Jefferson Parish &mdash; Eligible Voter</span>";
      dbEl.style.display = "block";
    } else {
      dbEl.style.display = "none";
    }
  }
  // Role pills — multi-select, both can be active simultaneously
  var _roles = (d.role || "").split(",").map(function(r){ return r.trim(); });
  var isVoter     = _roles.indexOf("Voter") > -1;
  var isCommittee = _roles.indexOf("Committee Member") > -1;
  var isAttorney  = _roles.indexOf("Attorney") > -1;
  document.getElementById("p-role").innerHTML =
    "<div class='role-pills'>" +
    "<button class='role-pill voter" + (isVoter ? " active" : "") + "' onclick='setRole(this.dataset.r)' data-r='Voter'>Voter</button>" +
    "<button class='role-pill committee" + (isCommittee ? " active" : "") + "' onclick='setRole(this.dataset.r)' data-r='Committee Member'>Committee Member</button>" +
    "<button class='role-pill attorney" + (isAttorney ? " active" : "") + "' onclick='setRole(this.dataset.r)' data-r='Attorney'>Attorney</button>" +
    "</div>";
  // Mini address map — single static OSM tile, no map library needed
  var mapDiv    = document.getElementById("p-hero-map");
  var addrParts = [d.address, d.city, d.state, d.zip].filter(function(x){ return x && x.trim(); });
  if (addrParts.length >= 2) {
    mapDiv.style.display = "block";
    var _ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var _opts = { headers: { "Accept-Language": "en" } };
    if (_ctrl) { _opts.signal = _ctrl.signal; setTimeout(function(){ _ctrl.abort(); }, 5000); }
    fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(addrParts.join(", ")), _opts)
      .then(function(r){ return r.json(); })
      .then(function(res) {
        if (!res || !res.length) return;
        var lat = parseFloat(res[0].lat), lon = parseFloat(res[0].lon);
        // Compute OSM tile coords at zoom 16
        var z = 16, n = Math.pow(2, z);
        var tx = Math.floor((lon + 180) / 360 * n);
        var lr = lat * Math.PI / 180;
        var ty = Math.floor((1 - Math.log(Math.tan(lr) + 1/Math.cos(lr)) / Math.PI) / 2 * n);
        // Pixel offset within the 256×256 tile
        var px = Math.round(((lon + 180) / 360 * n - tx) * 256);
        var py = Math.round(((1 - Math.log(Math.tan(lr) + 1/Math.cos(lr)) / Math.PI) / 2 * n - ty) * 256);
        // Container is 270×200 — shift tile so address is centered
        var left = 135 - px, top = 100 - py;
        var el = document.getElementById("hero-tile-map");
        el.style.position = "relative";
        el.style.overflow = "hidden";
        el.innerHTML =
          '<img src="https://tile.openstreetmap.org/' + z + '/' + tx + '/' + ty + '.png"' +
          ' style="position:absolute;left:' + left + 'px;top:' + top + 'px;width:256px;height:256px;image-rendering:auto;" />' +
          '<div style="position:absolute;top:50%;left:50%;width:13px;height:13px;transform:translate(-50%,-50%);border-radius:50%;background:#78E0C4;border:2.5px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.5);z-index:1;"></div>';
      })
      .catch(function(){});
  } else {
    mapDiv.style.display = "none";
  }
  // Populate guest edit inputs (hidden inside Total Giving card for save compat)
  var gSel = document.getElementById("i-guests");
  var gOpts = ["1","2","3","4","5+"];
  gOpts.forEach(function(v){ if ((d.guests||"1") === v) gSel.value = v; });
  document.getElementById("i-gnames").value = d.guest_names || "";
  document.getElementById("i-comment").value = d.comment || "";
  // Help checkboxes
  document.getElementById("eh-yardsign").checked = (d.yard_sign === "Yes");
  var helpLabels = (d.how_to_help && d.how_to_help !== "None selected")
    ? d.how_to_help.split(",").map(function(h){ return h.trim(); }) : [];
  // Map checkbox id → array of label strings (new label first, legacy aliases after)
  var helpMap = {
    "eh-calls":   ["Make phone calls",                       "Make Phone Calls"],
    "eh-knock":   ["Knock on doors",                         "Knock on Doors"],
    "eh-wave":    ["Wave signs",                             "Sign Wave", "Wave Signs"],
    "eh-errands": ["Run errands for the committee",          "Run Errands for Committee"],
    "eh-host":    ["Host a meet & greet or other event",     "Host a Meet & Greet or Event"],
    "eh-inkind":  ["In-kind contribution or venue space",    "In-Kind Contribution or Venue Space"],
    "eh-other":   ["Other — contact me directly",            "Other", "Other - contact me directly"]
  };
  Object.keys(helpMap).forEach(function(k){
    var el = document.getElementById(k);
    if (!el) return;
    el.checked = helpMap[k].some(function(lbl){ return helpLabels.indexOf(lbl) > -1; });
  });

  var signEl = document.getElementById("p-sign");
  if (d.yard_sign === "Yes") {
    var isDel = d.yard_sign_delivered === "Yes";
    signEl.innerHTML =
      "<div style='font-size:12px;font-weight:600;color:var(--navy);margin-bottom:10px;'>Requested</div>" +
      "<button id='sign-btn' class='sign-toggle " + (isDel ? "done" : "pend") + "' onclick='toggleSign()'>" +
      (isDel ? "&#10003; Delivered" : "Mark Delivered") + "</button>";
  } else {
    signEl.innerHTML = "<div style='font-size:12px;color:var(--dim);font-style:italic;'>Not requested</div>";
  }

  document.getElementById("p-endorse").innerHTML = d.endorse === "Yes"
    ? "<button class='sign-toggle done' onclick='toggleEndorse()'>&#10003; Endorsed</button>"
    : "<button class='sign-toggle pend' onclick='toggleEndorse()'>Mark as Endorsed</button>";

  var FIELDS = ["first","last","email","phone","address","city","state","zip","parish","company"];
  var KEYS   = ["first_name","last_name","email","phone","address","city","state","zip","parish","company"];
  FIELDS.forEach(function(f,i){
    var raw = d[KEYS[i]];
    document.getElementById("v-"+f).textContent = (f === "phone" ? (fmtPhone(raw) || "—") : (raw || "—"));
    document.getElementById("i-"+f).value       = (f === "phone" ? (fmtPhone(raw) || "") : (raw || ""));
  });

  var helpsEl = document.getElementById("p-helps");
  if (d.how_to_help && d.how_to_help !== "None selected") {
    helpsEl.innerHTML = d.how_to_help.split(",").map(function(h){
      return "<span class='ptag'>" + xe(h.trim()) + "</span>";
    }).join("");
  } else {
    helpsEl.innerHTML = "<span class='ptag-none'>No volunteer interests selected</span>";
  }

  var cEl = document.getElementById("p-comment");
  if (d.comment && d.comment.trim()) {
    cEl.innerHTML = "<div class='comment-block'>" + xe(d.comment) + "</div>";
  } else {
    cEl.innerHTML = "<span class='comment-none'>No comments provided.</span>";
  }

  // Load real donation history for this contact (admin only — hidden for the candidate)
  if (!IS_CANDIDATE)
  fetch('/admin/contact-donations/' + d.id)
    .then(function(r){ return r.json(); })
    .then(function(gifts) {
      var total = gifts.reduce(function(s,g){ return s + (parseFloat(g.amount)||0); }, 0);
      document.getElementById("dh-total").textContent = total ? ("$" + total.toLocaleString()) : "—";
      document.getElementById("dh-count").textContent = gifts.length || "—";
      document.getElementById("dh-last").textContent  = gifts.length
        ? new Date(gifts[0].date + "T00:00:00").toLocaleDateString("en-US", {month:"short", day:"numeric", year:"numeric"})
        : "—";
      document.getElementById("dh-rows").innerHTML = gifts.length
        ? gifts.map(function(g){
            var amt = "$" + (parseFloat(g.amount)||0).toLocaleString("en-US", {minimumFractionDigits:2, maximumFractionDigits:2});
            var dateStr = g.date ? new Date(g.date + "T00:00:00").toLocaleDateString("en-US", {month:"short", day:"numeric", year:"numeric"}) : "—";
            var tender = g.tender_type ? (" &middot; " + g.tender_type + (g.check_number ? " #" + g.check_number : "")) : "";
            return "<div class='don-row'>" +
              "<span class='don-row-date'>" + dateStr + "</span>" +
              "<span class='don-row-amt'>" + amt + "</span>" +
              "<span class='don-row-badge'>" + (g.source || "—") + "</span>" +
              "<span class='don-row-method' style='color:var(--dim);font-size:11px;'>" + tender + "</span>" +
              "</div>";
          }).join("")
        : "<div style='font-size:13px;color:var(--dim);font-style:italic;padding:4px 0;'>No donations on record.</div>";
      document.getElementById("p-total-giving").textContent = total ? ("$" + total.toLocaleString()) : "$0";
      document.getElementById("p-giving-remaining").textContent = total ? "" : "No contributions yet";
      document.getElementById("p-giving-bar").style.width = "0%";
    }).catch(function() {
      document.getElementById("dh-rows").innerHTML = "<div style='font-size:13px;color:var(--dim);font-style:italic;'>No donations on record.</div>";
    });

  renderProfilePipeline(d.pipeline_stage);
}

// ── Pipeline stage on profile ──────────────────────────────────────────
function renderProfilePipeline(stage) {
  var activeKey = (stage && stage !== '') ? stage : 'new';
  var activeIdx = PROFILE_PIPELINE.findIndex(function(s){ return s.key === activeKey; });
  var wrap = document.getElementById('pp-track');
  if (!wrap) return;
  wrap.innerHTML = PROFILE_PIPELINE.map(function(s, i) {
    var cls = i < activeIdx ? 'past' : (i === activeIdx ? 'active' : '');
    var connector = i < PROFILE_PIPELINE.length - 1
      ? '<div class="pipe-connector' + (i < activeIdx ? ' filled' : '') + '"></div>'
      : '';
    return '<div class="pipe-step-wrap">' +
      '<div class="pipe-step ' + cls + '" style="color:' + s.color + '" title="Move to: ' + s.label + '" data-stage="' + s.key + '">' +
        '<div class="pipe-step-dot"></div>' +
        '<div class="pipe-step-label">' + s.label + '</div>' +
      '</div>' + connector +
    '</div>';
  }).join('');
}

function setProfileStage(stage) {
  fetch('/rsvp/' + CID + '/pipeline', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pipeline_stage: stage })
  }).then(function(r){ return r.json(); }).then(function(){
    rec.pipeline_stage = stage;
    renderProfilePipeline(stage);
  });
}

// Delegated: pipeline step click → set stage
document.addEventListener('click', function(e) {
  var step = e.target.closest('[data-stage]');
  if (step) setProfileStage(step.getAttribute('data-stage'));
});

function toggleSign() {
  if (!rec || rec.yard_sign !== "Yes") return;
  var newDel = rec.yard_sign_delivered !== "Yes";
  fetch("/rsvp/" + CID + "/sign", {
    method: "PATCH",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({delivered: newDel})
  }).then(function(r){ return r.json(); }).then(function(){
    rec.yard_sign_delivered = newDel ? "Yes" : null;
    paint(rec);
  });
}

function setRole(toggled) {
  if (!rec) return;
  var roles = (rec.role || "").split(",").map(function(r){ return r.trim(); }).filter(Boolean);
  var idx = roles.indexOf(toggled);
  if (idx > -1) { roles.splice(idx, 1); } else { roles.push(toggled); }
  var newRole = roles.join(", ");
  fetch("/rsvp/" + CID + "/role", {
    method: "PATCH",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({role: newRole})
  }).then(function(r){ return r.json(); }).then(function(){
    rec.role = newRole;
    paint(rec);
  });
}

function toggleEndorse() {
  if (!rec) return;
  var newEndorse = rec.endorse === "Yes" ? "No" : "Yes";
  fetch("/rsvp/" + CID + "/endorse", {
    method: "PATCH",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({endorsed: newEndorse === "Yes"})
  }).then(function(r){ return r.json(); }).then(function(){
    rec.endorse = newEndorse;
    paint(rec);
  });
}

function startEdit() {
  ["first","last","email","phone","address","city","state","zip","parish"].forEach(function(f){
    document.getElementById("v-"+f).style.display = "none";
    document.getElementById("i-"+f).style.display = "block";
  });
  document.getElementById("edit-guests-wrap").style.display = "block";
  document.getElementById("p-helps").style.display          = "none";
  document.getElementById("edit-helps-wrap").style.display  = "block";
  document.getElementById("p-comment").style.display        = "none";
  document.getElementById("i-comment").style.display        = "block";
  document.getElementById("btn-edit").style.display   = "none";
  document.getElementById("btn-save").style.display   = "";
  document.getElementById("btn-cancel").style.display = "";
}

function cancelEdit() {
  ["first","last","email","phone","address","city","state","zip","parish"].forEach(function(f){
    document.getElementById("v-"+f).style.display = "";
    document.getElementById("i-"+f).style.display = "none";
  });
  document.getElementById("edit-guests-wrap").style.display = "none";
  document.getElementById("p-helps").style.display          = "";
  document.getElementById("edit-helps-wrap").style.display  = "none";
  document.getElementById("p-comment").style.display        = "";
  document.getElementById("i-comment").style.display        = "none";
  document.getElementById("btn-edit").style.display   = "";
  document.getElementById("btn-save").style.display   = "none";
  document.getElementById("btn-cancel").style.display = "none";
}

// ── Profile address autocomplete ──────────────────────────────────────
(function() {
  var timer = null, results = [], focusIdx = -1;
  var STATE_MAP = {
    'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR','California':'CA',
    'Colorado':'CO','Connecticut':'CT','Delaware':'DE','Florida':'FL','Georgia':'GA',
    'Hawaii':'HI','Idaho':'ID','Illinois':'IL','Indiana':'IN','Iowa':'IA','Kansas':'KS',
    'Kentucky':'KY','Louisiana':'LA','Maine':'ME','Maryland':'MD','Massachusetts':'MA',
    'Michigan':'MI','Minnesota':'MN','Mississippi':'MS','Missouri':'MO','Montana':'MT',
    'Nebraska':'NE','Nevada':'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM',
    'New York':'NY','North Carolina':'NC','North Dakota':'ND','Ohio':'OH','Oklahoma':'OK',
    'Oregon':'OR','Pennsylvania':'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD',
    'Tennessee':'TN','Texas':'TX','Utah':'UT','Vermont':'VT','Virginia':'VA','Washington':'WA',
    'West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY'
  };
  function getSuggest() { return document.getElementById('ct-addr-suggest'); }
  function closeSuggest() { var s=getSuggest(); if(s) s.style.display='none'; focusIdx=-1; }
  function showSuggest(items) {
    var s = getSuggest(); if (!s) return;
    if (!items.length) { closeSuggest(); return; }
    results = items; focusIdx = -1;
    s.innerHTML = items.map(function(r,i) {
      var parts = r.display_name.split(',');
      var addr  = r.address || {};
      var main  = ((addr.house_number ? addr.house_number+' ' : '')+(addr.road||'')).trim() || parts.slice(0,2).join(' ').trim();
      var sub   = parts.slice(2,4).join(',').trim();
      return '<div class="ct-sug-item" data-idx="'+i+'">' +
        '<div style="font-weight:600;color:var(--navy);">'+main+'</div>' +
        (sub ? '<div style="font-size:11px;color:var(--dim);margin-top:2px;">'+sub+'</div>' : '') +
      '</div>';
    }).join('');
    s.style.display = 'block';
    s.querySelectorAll('.ct-sug-item').forEach(function(el) {
      el.addEventListener('mousedown', function(e) { e.preventDefault(); selectResult(parseInt(el.getAttribute('data-idx'))); });
    });
  }
  function selectResult(idx) {
    var r = results[idx]; if (!r || !r.address) return;
    var a = r.address;
    var st   = ((a.house_number ? a.house_number+' ' : '')+(a.road||'')).trim();
    var ci   = a.city||a.town||a.village||a.municipality||a.hamlet||'';
    var abbr = STATE_MAP[a.state] || (a.state ? a.state.slice(0,2).toUpperCase() : 'LA');
    var zp   = (a.postcode||'').slice(0,5);
    var geocParish = (a.county||'').replace(/ Parish$/i,'').replace(/ County$/i,'');
    if (st) document.getElementById('i-address').value = st;
    if (ci) document.getElementById('i-city').value    = ci;
    document.getElementById('i-state').value           = abbr;
    if (zp) document.getElementById('i-zip').value     = zp;
    // ZIP_PARISH lookup takes priority; fall back to geocoder county
    var derivedParish = (zp && ZIP_PARISH[zp]) ? ZIP_PARISH[zp] : geocParish;
    if (derivedParish) {
      document.getElementById('i-parish').value = derivedParish;
      refreshDistrictBadge(derivedParish);
    }
    closeSuggest();
    document.getElementById('i-city').focus();
  }
  function doSearch(q) {
    var s = getSuggest(); if (!s) return;
    s.innerHTML = '<div class="ct-sug-searching">Searching…</div>';
    s.style.display = 'block';
    fetch('https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&countrycodes=us&q='+encodeURIComponent(q), { headers:{'Accept-Language':'en'} })
      .then(function(r){ return r.json(); })
      .then(function(data){ showSuggest(data||[]); })
      .catch(function(){ closeSuggest(); });
  }
  var inp = document.getElementById('i-address'); if (!inp) return;
  inp.addEventListener('input', function() {
    clearTimeout(timer);
    var q = this.value.trim();
    if (q.length < 5) { closeSuggest(); return; }
    timer = setTimeout(function(){ doSearch(q); }, 450);
  });
  inp.addEventListener('keydown', function(e) {
    var s = getSuggest();
    if (!s || s.style.display==='none') return;
    var items = s.querySelectorAll('.ct-sug-item');
    if (e.key==='ArrowDown')      { e.preventDefault(); focusIdx=Math.min(focusIdx+1,items.length-1); }
    else if (e.key==='ArrowUp')   { e.preventDefault(); focusIdx=Math.max(focusIdx-1,0); }
    else if (e.key==='Enter' && focusIdx>=0) { e.preventDefault(); selectResult(focusIdx); return; }
    else if (e.key==='Escape')    { closeSuggest(); return; }
    items.forEach(function(el,i){ el.classList.toggle('ct-focused', i===focusIdx); });
  });
  inp.addEventListener('blur', function(){ setTimeout(closeSuggest, 150); });
})();

function deleteConstituent() {
  var name = rec ? (rec.first_name + ' ' + rec.last_name).trim() : 'this person';
  if (!window.confirm('Permanently delete ' + name + '? This cannot be undone.')) return;
  fetch('/admin/constituent/' + CID, { method: 'DELETE' })
    .then(function(r){ return r.json(); })
    .then(function(res){
      if (res.result === 'success') {
        window.location.href = '/admin';
      } else {
        alert('Delete failed — please try again.');
      }
    })
    .catch(function(){ alert('Network error — please try again.'); });
}

function saveEdit() {
  var helpKeys = [
    {id:"eh-calls",   label:"Make phone calls"},
    {id:"eh-knock",   label:"Knock on doors"},
    {id:"eh-wave",    label:"Wave signs"},
    {id:"eh-errands", label:"Run errands for the committee"},
    {id:"eh-host",    label:"Host a meet & greet or other event"},
    {id:"eh-inkind",  label:"In-kind contribution or venue space"},
    {id:"eh-other",   label:"Other — contact me directly"}
  ];
  var howToHelp = helpKeys
    .filter(function(h){ return document.getElementById(h.id).checked; })
    .map(function(h){ return h.label; }).join(", ") || "None selected";
  var body = {
    first_name:  document.getElementById("i-first").value.trim(),
    last_name:   document.getElementById("i-last").value.trim(),
    email:       document.getElementById("i-email").value.trim(),
    phone:       document.getElementById("i-phone").value.trim(),
    address:     document.getElementById("i-address").value.trim(),
    city:        document.getElementById("i-city").value.trim(),
    state:       document.getElementById("i-state").value.trim(),
    zip:         document.getElementById("i-zip").value.trim(),
    parish:      document.getElementById("i-parish").value.trim(),
    guests:      document.getElementById("i-guests").value,
    guest_names: document.getElementById("i-gnames").value.trim(),
    yard_sign:   document.getElementById("eh-yardsign").checked ? "Yes" : "No",
    how_to_help: howToHelp,
    endorse:     rec ? rec.endorse : "No",
    comment:     document.getElementById("i-comment").value.trim(),
    role:        rec ? (rec.role || '') : '',
    company:     document.getElementById("i-company").value.trim()
  };
  var hdrBtn = document.getElementById("hdr-save-btn");
  var hdrMsg = document.getElementById("hdr-save-msg");
  var inlineBtn = document.getElementById("btn-save");
  if (hdrBtn) { hdrBtn.disabled = true; hdrBtn.textContent = "Saving…"; }
  if (inlineBtn) { inlineBtn.disabled = true; inlineBtn.textContent = "Saving…"; }
  fetch("/admin/constituent/" + CID, {
    method: "PATCH",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(body)
  }).then(function(r){ return r.json(); }).then(function(res){
    if (hdrBtn) { hdrBtn.disabled = false; hdrBtn.textContent = "Save Changes"; }
    if (inlineBtn) { inlineBtn.disabled = false; inlineBtn.textContent = "Save Changes"; }
    if (res.result === "success") {
      Object.assign(rec, body);
      paint(rec);
      var m = document.getElementById("save-msg");
      if (m) { m.style.display = "inline"; setTimeout(function(){ m.style.display = "none"; }, 2500); }
      if (hdrMsg) { hdrMsg.style.display = "inline"; setTimeout(function(){ hdrMsg.style.display = "none"; }, 2500); }
    }
  }).catch(function(){
    if (hdrBtn) { hdrBtn.disabled = false; hdrBtn.textContent = "Save Changes"; }
    if (inlineBtn) { inlineBtn.disabled = false; inlineBtn.textContent = "Save Changes"; }
  });
}

</script>
</body></html>`; }


// ════════════════════════════════════════════════════════════════════════
//  YARD SIGN MAP
// ════════════════════════════════════════════════════════════════════════
function mapHTML() { return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Sign Map — Blaine Moncrief</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>${BASE_CSS}
  html, body { height: 100%; overflow: hidden; }
  .map-layout { display: flex; height: calc(100vh - 64px); }

  .map-sidebar {
    width: 380px; flex-shrink: 0;
    overflow-y: auto; overflow-x: hidden;
    background: var(--bg);
    border-right: 1px solid var(--border);
  }
  .sb-section { padding: 18px 20px; border-bottom: 1px solid var(--border); }
  .sb-title { font-size: 9px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--dim); font-weight: 700; margin-bottom: 14px; }

  .sb-stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
  .sb-stat-box { background: var(--white); border: 1px solid var(--border); border-radius: 4px; padding: 14px 10px; text-align: center; }
  .sb-stat-num { font-family: 'Montserrat', sans-serif; font-size: 28px; font-weight: 800; color: var(--navy); line-height: 1; margin-bottom: 4px; }
  .sb-stat-num.accent { color: var(--mint-d); }
  .sb-stat-lbl { font-size: 9px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--dim); font-weight: 600; }

  .bank-row { margin-bottom: 10px; }
  .bank-row:last-child { margin-bottom: 0; }
  .bank-meta { display: flex; justify-content: space-between; margin-bottom: 4px; }
  .bank-label { font-size: 12px; font-weight: 700; color: var(--navy); }
  .bank-count { font-size: 11px; color: var(--muted); }
  .bank-track { height: 6px; background: var(--border); border-radius: 100px; overflow: hidden; }
  .bank-fill { height: 100%; border-radius: 100px; }
  .bank-fill.east { background: var(--navy); }
  .bank-fill.west { background: var(--mint-d); }
  .bank-note { font-size: 11px; color: var(--dim); margin-top: 10px; line-height: 1.55; }

  .zip-row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 3px; cursor: pointer; transition: background .1s; }
  .zip-row:hover { background: #eaf9f5; }
  .zip-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .zip-dot.has { background: var(--mint-d); }
  .zip-dot.none { background: var(--border); }
  .zip-code { font-size: 12px; font-weight: 700; color: var(--navy); min-width: 40px; }
  .zip-name { font-size: 11px; color: var(--muted); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .zip-cnt  { font-size: 12px; font-weight: 700; color: var(--navy); min-width: 18px; text-align: right; }
  .zip-cnt.z { color: var(--dim); font-weight: 400; }
  .tier-pill { font-size: 9px; font-weight: 700; letter-spacing: .5px; padding: 1px 5px; border-radius: 2px; flex-shrink: 0; }
  .t1 { background: rgba(9,37,79,.1); color: var(--navy); }
  .t2 { background: #edf0f5; color: var(--muted); }

  .gap-item { background: var(--white); border: 1px solid var(--border); border-radius: 4px; padding: 12px 14px; margin-bottom: 8px; cursor: pointer; transition: border-color .15s; }
  .gap-item:hover { border-color: var(--mint-d); }
  .gap-item:last-child { margin-bottom: 0; }
  .gap-hdr { display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px; flex-wrap: wrap; }
  .gap-zip { font-size: 13px; font-weight: 700; color: var(--navy); }
  .gap-name { font-size: 11px; color: var(--muted); flex: 1; }
  .gap-badge { font-size: 9px; font-weight: 700; letter-spacing: .5px; padding: 2px 7px; border-radius: 100px; }
  .gap-badge.hi { background: rgba(9,37,79,.1); color: var(--navy); }
  .gap-badge.md { background: #edf0f5; color: var(--muted); }
  .gap-why { font-size: 11px; color: var(--muted); line-height: 1.55; }

  .cor-item { display: flex; gap: 8px; margin-bottom: 10px; }
  .cor-item:last-child { margin-bottom: 0; }
  .cor-item { cursor: default; border-radius: 4px; padding: 5px 6px; margin-left: -6px; transition: background .15s; }
  .cor-item:hover { background: rgba(120,224,196,.07); }
  .cor-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--navy); flex-shrink: 0; margin-top: 4px; }
  .cor-text { font-size: 11px; color: var(--muted); line-height: 1.55; }
  .cor-main { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .cor-main strong { color: var(--navy); }
  .cor-aadt { font-size: 10px; font-weight: 700; color: var(--mint-d); white-space: nowrap; }
  .cor-desc { font-size: 11px; color: var(--muted); line-height: 1.55; max-height: 0; overflow: hidden; opacity: 0; transition: max-height .25s ease, opacity .2s; margin-top: 0; }
  .cor-item:hover .cor-desc { max-height: 100px; opacity: 1; margin-top: 5px; }

  .map-main { flex: 1; position: relative; min-width: 0; }
  #lmap { height: 100%; width: 100%; }
  .map-legend {
    position: absolute; bottom: 24px; right: 16px; z-index: 1000;
    background: rgba(255,255,255,.96); border: 1px solid var(--border);
    border-radius: 4px; padding: 12px 16px; box-shadow: 0 2px 8px rgba(0,0,0,.1);
    font-family: 'Montserrat', sans-serif;
  }
  .leg-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 11px; color: var(--muted); }
  .leg-row:last-child { margin-bottom: 0; }
  .leg-dot { width: 13px; height: 13px; border-radius: 50%; border: 2px solid #fff; flex-shrink: 0; }
  .leg-dot.del { background: #5fd4b0; box-shadow: 0 0 0 1.5px #5fd4b0; }
  .leg-dot.pen { background: #f5a623; box-shadow: 0 0 0 1.5px #f5a623; }
  .leg-dot.cov { background: rgba(120,224,196,.25); box-shadow: 0 0 0 1.5px #78E0C4; border-color: transparent; }
  .leg-dot.nos { background: rgba(255,255,255,.85); border-color: #8fa7c8; box-shadow: 0 0 0 1.5px #8fa7c8; }
  .tog-row { display: flex; align-items: center; gap: 10px; }
  .tog-lbl { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .tog-lbl strong { color: var(--navy); }
  .tog { position: relative; display: inline-block; width: 38px; height: 22px; flex-shrink: 0; }
  .tog input { opacity: 0; width: 0; height: 0; }
  .tog-slider { position: absolute; cursor: pointer; inset: 0; background: #d0d7e2; border-radius: 22px; transition: .2s; }
  .tog-slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 3px; bottom: 3px; background: #fff; border-radius: 50%; transition: .2s; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
  .tog input:checked + .tog-slider { background: var(--mint-d); }
  .tog input:checked + .tog-slider:before { transform: translateX(16px); }

  /* ── Sign requests list ── */
  #sign-list { max-height: 340px; overflow-y: auto; margin: 0 -6px; }
  .sign-item { display: flex; align-items: center; gap: 10px; padding: 8px 6px; border-radius: 3px; transition: background .1s; }
  .sign-item:hover { background: #eaf9f5; }
  .sign-item + .sign-item { border-top: 1px solid var(--border); }
  .sign-item-main { flex: 1; min-width: 0; }
  .sign-item-name { font-size: 12px; font-weight: 700; color: var(--navy); display: flex; align-items: center; gap: 6px; }
  .sign-item-flag { font-size: 8px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; background: #fde68a; color: #92400e; padding: 1px 5px; border-radius: 2px; flex-shrink: 0; }
  .sign-item-addr { font-size: 10px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
  .sign-item-status { font-size: 9px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; flex-shrink: 0; }
  .sign-item-status.del { color: var(--mint-d); }
  .sign-item-status.pen { color: #b07d10; }

  @media(max-width:900px) {
    html, body { overflow: auto; }
    .map-layout { flex-direction: column; height: auto; }
    .map-sidebar { width: 100%; }
    .map-main { height: 480px; }
  }

  /* ── Leaflet overrides ── */
  .leaflet-control-zoom { border: 1px solid var(--border) !important; border-radius: 4px !important; box-shadow: 0 2px 8px rgba(6,15,30,.1) !important; overflow: hidden; }
  .leaflet-control-zoom a { font-family: 'Montserrat', sans-serif !important; font-weight: 700 !important; color: var(--navy) !important; background: var(--white) !important; border-bottom-color: var(--border) !important; width: 30px !important; height: 30px !important; line-height: 30px !important; font-size: 16px !important; }
  .leaflet-control-zoom a:hover { background: #eaf9f5 !important; color: var(--navy) !important; }
  .leaflet-bar a:last-child { border-bottom: none !important; }
  .leaflet-popup-content-wrapper { border-radius: 6px !important; box-shadow: 0 6px 24px rgba(6,15,30,.14) !important; border: 1px solid var(--border) !important; padding: 0 !important; }
  .leaflet-popup-content { margin: 14px 16px !important; font-family: 'Montserrat', sans-serif !important; }
  .leaflet-popup-close-button { top: 8px !important; right: 10px !important; color: var(--dim) !important; font-size: 16px !important; }
  .leaflet-popup-close-button:hover { color: var(--navy) !important; }
  .leaflet-control-attribution { font-size: 10px !important; background: rgba(255,255,255,.8) !important; }
  .leaflet-attribution-flag { display: none !important; }

  /* ── Map legend ── */
  .map-legend { border-radius: 6px !important; box-shadow: 0 4px 16px rgba(6,15,30,.12) !important; border: 1px solid var(--border) !important; }
  .map-legend-title { font-size: 9px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; color: var(--dim); margin-bottom: 10px; }
</style>
</head>
<body>

<header class="hdr">
  <img class="hdr-logo" src="${LOGO_URL}" alt="Blaine Moncrief"/>
  <div class="hdr-right">
    <span class="hdr-label">Yard Sign Map</span>
    <div class="hdr-divider"></div>
    <a class="map-link" href="/admin">&#8592; Admin</a>
  </div>
</header>

<div class="map-layout">
  <div class="map-sidebar">

    <div class="sb-section">
      <div class="sb-title">Overview</div>
      <div class="sb-stats">
        <div class="sb-stat-box"><div class="sb-stat-num" id="ms-tot">—</div><div class="sb-stat-lbl">Requested</div></div>
        <div class="sb-stat-box"><div class="sb-stat-num accent" id="ms-del">—</div><div class="sb-stat-lbl">Delivered</div></div>
        <div class="sb-stat-box"><div class="sb-stat-num" id="ms-zips">—</div><div class="sb-stat-lbl">Zip Codes</div></div>
      </div>
    </div>

    <div class="sb-section">
      <div class="sb-title">Sign Requests &nbsp;<span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:10px;">(toggle = delivered)</span></div>
      <div id="sign-list"></div>
    </div>

    <div class="sb-section">
      <div class="sb-title">Map Layers</div>
      <div class="tog-row">
        <label class="tog">
          <input type="checkbox" id="toggle-nosign" onchange="toggleNoSign(this.checked)">
          <span class="tog-slider"></span>
        </label>
        <span class="tog-lbl">Show constituents <strong>without</strong> a sign request &nbsp;<span id="nosign-cnt" style="color:var(--muted);font-weight:600;"></span></span>
      </div>
    </div>

    <div class="sb-section">
      <div class="sb-title">East Bank vs West Bank</div>
      <div class="bank-row">
        <div class="bank-meta"><span class="bank-label">East Bank</span><span class="bank-count" id="eb-lbl">—</span></div>
        <div class="bank-track"><div class="bank-fill east" id="eb-bar" style="width:0%"></div></div>
      </div>
      <div class="bank-row">
        <div class="bank-meta"><span class="bank-label">West Bank</span><span class="bank-count" id="wb-lbl">—</span></div>
        <div class="bank-track"><div class="bank-fill west" id="wb-bar" style="width:0%"></div></div>
      </div>
      <div class="bank-note">East Bank holds ~65% of Jefferson Parish registered voters (Metairie ~150k + Kenner ~67k). Prioritize <strong style="color:var(--navy)">Veterans Blvd</strong> and <strong style="color:var(--navy)">Clearview Pkwy</strong> corridors for maximum reach.</div>
    </div>

    <div class="sb-section">
      <div class="sb-title">Coverage by Zip &nbsp;<span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:10px;">(click to zoom)</span></div>
      <div id="zip-grid"></div>
    </div>

    <div class="sb-section">
      <div class="sb-title">Priority Gaps — No Signs Yet</div>
      <div id="gap-list"></div>
    </div>

    <div class="sb-section">
      <div class="sb-title">High-Impact Corridors <span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:10px;">(hover for details)</span></div>
      <div class="cor-item"><div class="cor-dot"></div><div class="cor-text"><div class="cor-main"><strong>Veterans Memorial Blvd</strong><span class="cor-aadt">~70,000 AADT</span></div><div class="cor-desc">Highest-traffic local road in the parish. 5+ miles through Metairie's commercial core (70001, 70003, 70006). Top priority.</div></div></div>
      <div class="cor-item"><div class="cor-dot"></div><div class="cor-text"><div class="cor-main"><strong>I-10 service roads / interchanges</strong><span class="cor-aadt">160,000–210,000 AADT</span></div><div class="cor-desc">Clearview, Causeway &amp; Williams Blvd interchanges. Highest-volume corridor in the parish; sign the frontage roads.</div></div></div>
      <div class="cor-item"><div class="cor-dot"></div><div class="cor-text"><div class="cor-main"><strong>Clearview Pkwy &amp; Causeway Blvd</strong><span class="cor-aadt">35,000–50,000 AADT</span></div><div class="cor-desc">Major N-S connectors. Clearview passes Elmwood Shopping Center (1M+ sq ft). Veterans @ Clearview is the highest-traffic intersection in Metairie.</div></div></div>
      <div class="cor-item"><div class="cor-dot"></div><div class="cor-text"><div class="cor-main"><strong>Williams Blvd (Kenner)</strong><span class="cor-aadt">25,000–40,000 AADT</span></div><div class="cor-desc">Primary corridor for Kenner's 66,000+ residents. Connects I-10 to the river.</div></div></div>
      <div class="cor-item"><div class="cor-dot"></div><div class="cor-text"><div class="cor-main"><strong>Westbank Expwy / US-90 Business</strong><span class="cor-aadt">50,000–75,000 AADT</span></div><div class="cor-desc">The West Bank spine through Gretna, Harvey &amp; Westwego. Place signs near Crescent City Connection approach — all West Bank commuters pass through.</div></div></div>
      <div class="cor-item"><div class="cor-dot"></div><div class="cor-text"><div class="cor-main"><strong>Lapalco Blvd &amp; Manhattan Blvd</strong></div><div class="cor-desc">West Bank secondary spine through Harvey and Marrero (pop. 55,600). Key intersection: Lapalco @ Manhattan Blvd.</div></div></div>
    </div>

  </div>

  <div class="map-main">
    <div id="lmap"></div>
    <div class="map-legend">
      <div class="map-legend-title">Signs</div>
      <div class="leg-row"><div class="leg-dot del"></div>Delivered</div>
      <div class="leg-row"><div class="leg-dot pen"></div>Pending</div>
      <div class="leg-row"><div class="leg-dot cov"></div>Coverage zone</div>
      <div class="leg-row" id="leg-nosign" style="display:none;"><div class="leg-dot nos"></div>No sign yet</div>
    </div>
  </div>
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var ZIP_COORDS = {
  "70001":[29.9955,-90.1669], "70002":[29.9988,-90.1351], "70003":[29.9838,-90.2028],
  "70005":[29.9921,-90.1466], "70006":[29.9786,-90.1599], "70031":[29.9618,-90.2952],
  "70036":[29.7374,-90.1208], "70047":[29.9357,-90.3713], "70053":[29.9157,-90.0537],
  "70056":[29.8869,-90.0461], "70058":[29.8988,-90.0771], "70062":[29.9944,-90.2418],
  "70065":[29.9992,-90.2150], "70067":[29.6690,-90.1126], "70072":[29.8886,-90.1013],
  "70094":[29.9072,-90.1450],
  // Orleans Parish (out of district, but supporters here still get a pin)
  "70112":[29.9580,-90.0790], "70113":[29.9430,-90.0790], "70114":[29.9320,-90.0480],
  "70115":[29.9230,-90.0980], "70116":[29.9650,-90.0640], "70117":[29.9620,-90.0330],
  "70118":[29.9430,-90.1180], "70119":[29.9750,-90.0900], "70122":[30.0180,-90.0670],
  "70124":[30.0090,-90.1080], "70125":[29.9520,-90.1010], "70126":[30.0150,-90.0350],
  "70127":[30.0290,-89.9870], "70128":[30.0480,-89.9650], "70129":[30.0150,-89.9300],
  "70130":[29.9340,-90.0710], "70131":[29.9070,-90.0030],
  // St. Bernard / nearby
  "70043":[29.9560,-89.9900], "70075":[29.9330,-89.9200], "70092":[29.9100,-89.9650]
};
var ZIP_INFO = {
  "70001":{ name:"Metairie (central)",       bank:"East", tier:1, pop:"~38,800"   },
  "70002":{ name:"Metairie NE / Bucktown",   bank:"East", tier:2, pop:"~19,900"   },
  "70003":{ name:"W. Metairie / Kenner edge",bank:"East", tier:1, pop:"~40,000"   },
  "70005":{ name:"Old Metairie / Lake",      bank:"East", tier:1, pop:"~25,400"   },
  "70006":{ name:"Metairie south / I-10",    bank:"East", tier:2, pop:"significant"},
  "70031":{ name:"Ama",                      bank:"East", tier:3, pop:"small"      },
  "70036":{ name:"Barataria",                bank:"West", tier:3, pop:"small"      },
  "70047":{ name:"Norco area",               bank:"East", tier:3, pop:"small"      },
  "70053":{ name:"Gretna (courthouse)",      bank:"West", tier:1, pop:"~17,800"   },
  "70056":{ name:"Gretna / Timberlane",      bank:"West", tier:1, pop:"~42,500"   },
  "70058":{ name:"Harvey",                   bank:"West", tier:1, pop:"~39,300"   },
  "70062":{ name:"Kenner",                   bank:"East", tier:1, pop:"~66,000+"  },
  "70065":{ name:"Kenner east / Airport",    bank:"East", tier:2, pop:"significant"},
  "70067":{ name:"Lafitte",                  bank:"West", tier:3, pop:"small"      },
  "70072":{ name:"Marrero",                  bank:"West", tier:1, pop:"~55,600"   },
  "70094":{ name:"Westwego",                 bank:"West", tier:2, pop:"~9,700"    }
};
var GAP_RECS = [
  {zip:"70072",name:"Marrero",            priority:"hi", why:"Largest West Bank zip (~55,600 residents). Lapalco Blvd / Ames Blvd corridor. Zero West Bank coverage is the single biggest gap in the current distribution."},
  {zip:"70058",name:"Harvey",             priority:"hi", why:"~39,300 residents. Westbank Expwy through Harvey carries 50,000–75,000 AADT. Manhattan Blvd junction is a must-place location."},
  {zip:"70003",name:"W. Metairie",        priority:"hi", why:"~40,000 residents. Clearview Pkwy & Transcontinental Dr intersect Veterans here — among the highest daily traffic counts in Jefferson Parish."},
  {zip:"70062",name:"Kenner",             priority:"hi", why:"66,000+ residents. Williams Blvd / Airline Hwy / I-10 interchange. No coverage in Kenner at all."},
  {zip:"70056",name:"Gretna / Timberlane",priority:"hi", why:"~42,500 residents. Stumpf Blvd / Westbank Expwy. Note: the 24th JDC courthouse is in Gretna — high symbolic value for a judicial candidate."},
  {zip:"70001",name:"Central Metairie",   priority:"hi", why:"~38,800 residents. Heart of Veterans Blvd (Causeway to Clearview). Core of Metairie homeowners and registered voters."},
  {zip:"70002",name:"E. Metairie / Bucktown",priority:"md",why:"~19,900 residents. Causeway @ Veterans intersection. Lakeside Shopping Center area. Borders Orleans Parish — good spillover visibility."},
  {zip:"70065",name:"Kenner east / Airport",priority:"md",why:"Airline Drive corridor approaching MSY Airport — high daytime traffic from employees, travelers, and freight. Connects to River Ridge."}
];

function xe(s){ return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : ''; }

var map = L.map('lmap', { zoomControl: false }).setView([29.955,-90.130],12);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{
  attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  subdomains:'abcd', maxZoom:20
}).addTo(map);
var layers = L.layerGroup().addTo(map);
var noSignLayers = L.layerGroup().addTo(map);
var noSignCache = null;

function pinIcon(color){
  return L.divIcon({className:'',
    html:'<div style="width:18px;height:18px;border-radius:50%;background:'+color+';border:2.5px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);"></div>',
    iconSize:[18,18],iconAnchor:[9,9],popupAnchor:[0,-11]});
}

function ringIcon(){
  return L.divIcon({className:'',
    html:'<div style="width:12px;height:12px;border-radius:50%;background:rgba(255,255,255,.9);border:2px solid #8fa7c8;box-shadow:0 1px 5px rgba(0,0,0,.25);"></div>',
    iconSize:[12,12],iconAnchor:[6,6],popupAnchor:[0,-8]});
}

function toggleNoSign(on) {
  document.getElementById('leg-nosign').style.display = on ? 'flex' : 'none';
  if (!on) { noSignLayers.clearLayers(); return; }
  if (noSignCache) { buildNoSignLayer(noSignCache); return; }
  fetch('/admin/no-sign-data').then(function(r){return r.json();}).then(function(data){
    noSignCache = data;
    document.getElementById('nosign-cnt').textContent = '(' + data.length + ' people)';
    buildNoSignLayer(data);
  });
}

function buildNoSignLayer(data){
  noSignLayers.clearLayers();
  var seed2 = 77;
  function rnd2(){ seed2=(seed2*9301+49297)%233280; return seed2/233280; }
  data.forEach(function(r){
    var c=ZIP_COORDS[r.zip]; if(!c)return;
    var lat=c[0]+(rnd2()-0.5)*0.007;
    var lng=c[1]+(rnd2()-0.5)*0.009;
    var mk=L.marker([lat,lng],{icon:ringIcon()});
    mk.bindPopup(
      '<div style="font-family:Montserrat,sans-serif;min-width:190px;">'+
      '<div style="font-weight:700;font-size:13px;color:#09254f;margin-bottom:5px;">'+xe(r.first_name)+' '+xe(r.last_name)+'</div>'+
      '<div style="font-size:11px;color:#5a6b84;line-height:1.6;">'+
        (r.address?xe(r.address)+'<br>':'')+
        (r.city?xe(r.city)+', ':'')+xe(r.zip||'')+
        (r.parish?' &middot; '+xe(r.parish)+' Parish':'')+
      '</div>'+
      '<div style="margin-top:7px;font-size:11px;font-weight:600;color:#8fa7c8;">No sign requested</div>'+
      '</div>'
    );
    noSignLayers.addLayer(mk);
  });
}

var SIGN_DATA = [];
fetch('/admin/sign-map-data').then(function(r){return r.json();}).then(function(data){
  SIGN_DATA = data || [];
  buildStats(SIGN_DATA); buildMap(SIGN_DATA); buildZipGrid(SIGN_DATA); buildGaps(SIGN_DATA); buildSignList(SIGN_DATA);
});

// Per-person sign request list — shows EVERY requester (including off-map zips),
// with a delivered toggle that writes to the same endpoint the profile uses.
function buildSignList(data){
  var el = document.getElementById('sign-list');
  if(!el) return;
  if(!data.length){ el.innerHTML='<div style="font-size:12px;color:var(--muted);font-style:italic;">No sign requests yet.</div>'; return; }
  el.innerHTML = data.map(function(r){
    var del = r.yard_sign_delivered === 'Yes';
    var mapped = !!ZIP_COORDS[r.zip];
    var loc = [r.address, r.city, r.zip].filter(Boolean).map(xe).join(', ');
    if(r.parish && r.parish !== 'Jefferson') loc += (loc?' · ':'') + xe(r.parish) + ' Parish';
    return '<div class="sign-item">'+
      '<span class="sign-item-status '+(del?'del':'pen')+'">'+(del?'&#10003;':'&#9679;')+'</span>'+
      '<div class="sign-item-main">'+
        '<div class="sign-item-name">'+xe(r.first_name)+' '+xe(r.last_name)+
          (mapped?'':' <span class="sign-item-flag" title="Zip not in the parish map coordinates, so no pin appears">off-map</span>')+
        '</div>'+
        '<div class="sign-item-addr">'+(loc||'No address on file')+'</div>'+
      '</div>'+
      '<label class="tog" title="Mark delivered">'+
        '<input type="checkbox" '+(del?'checked':'')+' onchange="toggleSignDelivered('+r.id+',this.checked)">'+
        '<span class="tog-slider"></span>'+
      '</label>'+
    '</div>';
  }).join('');
}

function toggleSignDelivered(id, checked){
  fetch('/rsvp/'+id+'/sign',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({delivered:checked})})
    .then(function(r){return r.json();})
    .then(function(){
      var rec = SIGN_DATA.find(function(x){return x.id===id;});
      if(rec) rec.yard_sign_delivered = checked?'Yes':null;
      buildStats(SIGN_DATA); buildMap(SIGN_DATA); buildSignList(SIGN_DATA);
    })
    .catch(function(){ alert('Could not update delivery status. Please try again.'); });
}

function buildStats(data){
  var del=data.filter(function(r){return r.yard_sign_delivered==='Yes';}).length;
  var zips={}; data.forEach(function(r){if(r.zip&&ZIP_COORDS[r.zip])zips[r.zip]=true;});
  document.getElementById('ms-tot').textContent=data.length;
  document.getElementById('ms-del').textContent=del;
  document.getElementById('ms-zips').textContent=Object.keys(zips).length;
  var east=0,west=0;
  data.forEach(function(r){var i=ZIP_INFO[r.zip];if(i){if(i.bank==='East')east++;else west++;}});
  var tot=east+west||1;
  document.getElementById('eb-lbl').textContent=east+' signs ('+Math.round(east/tot*100)+'%)';
  document.getElementById('wb-lbl').textContent=west+' signs ('+Math.round(west/tot*100)+'%)';
  document.getElementById('eb-bar').style.width=Math.round(east/tot*100)+'%';
  document.getElementById('wb-bar').style.width=Math.round(west/tot*100)+'%';
}

function buildMap(data){
  layers.clearLayers();
  var zipCounts={};
  data.forEach(function(r){if(r.zip)zipCounts[r.zip]=(zipCounts[r.zip]||0)+1;});
  Object.keys(zipCounts).forEach(function(z){
    var c=ZIP_COORDS[z]; if(!c)return;
    L.circle(c,{radius:400,fillColor:'#78E0C4',fillOpacity:0.18,color:'#5fd4b0',weight:1.5}).addTo(layers);
  });
  var seed=42;
  function rnd(){seed=(seed*9301+49297)%233280;return seed/233280;}
  data.forEach(function(r){
    var c=ZIP_COORDS[r.zip]; if(!c)return;
    var lat=c[0]+(rnd()-0.5)*0.007;
    var lng=c[1]+(rnd()-0.5)*0.009;
    var del=r.yard_sign_delivered==='Yes';
    var mk=L.marker([lat,lng],{icon:pinIcon(del?'#5fd4b0':'#f5a623')});
    mk.bindPopup(
      '<div style="font-family:Montserrat,sans-serif;min-width:190px;">'+
      '<div style="font-weight:700;font-size:13px;color:#09254f;margin-bottom:5px;">'+xe(r.first_name)+' '+xe(r.last_name)+'</div>'+
      '<div style="font-size:11px;color:#5a6b84;line-height:1.6;">'+
        (r.address?xe(r.address)+'<br>':'')+
        (r.city?xe(r.city)+', ':'')+xe(r.zip||'')+
        (r.parish?' &middot; '+xe(r.parish)+' Parish':'')+
      '</div>'+
      '<div style="margin-top:7px;font-size:11px;font-weight:700;color:'+(del?'#2e9e7e':'#b07d10')+'">'+
        (del?'&#10003; Delivered':'&#9679; Pending')+
      '</div></div>'
    );
    layers.addLayer(mk);
  });
}

function buildZipGrid(data){
  var zipCounts={};
  data.forEach(function(r){if(r.zip)zipCounts[r.zip]=(zipCounts[r.zip]||0)+1;});
  var zips=Object.keys(ZIP_INFO).filter(function(z){return ZIP_INFO[z].tier<=2;});
  zips.sort(function(a,b){
    var d=ZIP_INFO[a].tier-ZIP_INFO[b].tier;
    return d!==0?d:(zipCounts[b]||0)-(zipCounts[a]||0);
  });
  document.getElementById('zip-grid').innerHTML=zips.map(function(z){
    var info=ZIP_INFO[z],cnt=zipCounts[z]||0,c=ZIP_COORDS[z];
    var fd=c?'data-lat="'+c[0]+'" data-lng="'+c[1]+'"':'';
    return '<div class="zip-row" '+fd+' onclick="flyTo(this)">'+
      '<div class="zip-dot '+(cnt?'has':'none')+'"></div>'+
      '<span class="zip-code">'+z+'</span>'+
      '<span class="zip-name">'+xe(info.name)+'</span>'+
      '<span class="tier-pill t'+info.tier+'">T'+info.tier+'</span>'+
      '<span class="zip-cnt'+(cnt?'':' z')+'">'+( cnt||'—')+'</span>'+
    '</div>';
  }).join('');
}

function buildGaps(data){
  var zipCounts={};
  data.forEach(function(r){if(r.zip)zipCounts[r.zip]=(zipCounts[r.zip]||0)+1;});
  var gaps=GAP_RECS.filter(function(g){return!zipCounts[g.zip];});
  if(!gaps.length){document.getElementById('gap-list').innerHTML='<div style="font-size:12px;color:var(--muted);font-style:italic;">All priority areas covered!</div>';return;}
  document.getElementById('gap-list').innerHTML=gaps.map(function(g){
    var c=ZIP_COORDS[g.zip];
    var fd=c?'data-lat="'+c[0]+'" data-lng="'+c[1]+'"':'';
    return '<div class="gap-item" '+fd+' onclick="flyTo(this)">'+
      '<div class="gap-hdr">'+
        '<span class="gap-zip">'+g.zip+'</span>'+
        '<span class="gap-name">'+xe(g.name)+'</span>'+
        '<span class="gap-badge '+(g.priority==='hi'?'hi':'md')+'">'+( g.priority==='hi'?'HIGH':'MED')+'</span>'+
      '</div>'+
      '<div class="gap-why">'+g.why+'</div>'+
    '</div>';
  }).join('');
}

function flyTo(el){
  var lat=parseFloat(el.getAttribute('data-lat'));
  var lng=parseFloat(el.getAttribute('data-lng'));
  if(!isNaN(lat))map.flyTo([lat,lng],14,{duration:1.2});
}
</script>
</body></html>`; }
