const express  = require('express');
const { DatabaseSync } = require('node:sqlite');
const cors     = require('cors');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3002;

const PASSWORDS = {
  admin:     process.env.ADMIN_PASSWORD     || 'blaine2026',  // campaign staff — full view
  candidate: process.env.CANDIDATE_PASSWORD || 'judge2026'    // Blaine — no donation info
};

// ── Database ──────────────────────────────────────────────────────────
const fs      = require('fs');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'rsvp.db');
const dbDir   = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS rsvps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    first_name  TEXT,
    last_name   TEXT,
    email       TEXT,
    phone       TEXT,
    address     TEXT,
    zip         TEXT,
    guests      TEXT,
    guest_names TEXT,
    how_to_help TEXT,
    yard_sign   TEXT,
    endorse     TEXT,
    comment     TEXT,
    event       TEXT
  )
`);
// Migration: add address column if it doesn't exist yet
try { db.exec(`ALTER TABLE rsvps ADD COLUMN address TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE rsvps ADD COLUMN zip TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE rsvps ADD COLUMN guest_names TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE rsvps ADD COLUMN endorse TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE rsvps ADD COLUMN event TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE rsvps ADD COLUMN yard_sign_delivered TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE rsvps ADD COLUMN city TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE rsvps ADD COLUMN state TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE rsvps ADD COLUMN parish TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE rsvps ADD COLUMN role TEXT`); } catch(e) {}
db.prepare("UPDATE rsvps SET role='Voter' WHERE role IS NULL OR role=''").run();

// ── Backfill parish from zip for existing records ─────────────────────
{
  const BP = {"70001":"Jefferson","70002":"Jefferson","70003":"Jefferson","70004":"Jefferson","70005":"Jefferson","70006":"Jefferson","70009":"Jefferson","70010":"Jefferson","70011":"Jefferson","70031":"Jefferson","70033":"Jefferson","70036":"Jefferson","70037":"Jefferson","70047":"Jefferson","70053":"Jefferson","70055":"Jefferson","70056":"Jefferson","70057":"Jefferson","70058":"Jefferson","70059":"Jefferson","70060":"Jefferson","70062":"Jefferson","70063":"Jefferson","70064":"Jefferson","70065":"Jefferson","70067":"Jefferson","70072":"Jefferson","70073":"Jefferson","70094":"Jefferson","70112":"Orleans","70113":"Orleans","70114":"Orleans","70115":"Orleans","70116":"Orleans","70117":"Orleans","70118":"Orleans","70119":"Orleans","70121":"Orleans","70122":"Orleans","70123":"Orleans","70124":"Orleans","70125":"Orleans","70126":"Orleans","70127":"Orleans","70128":"Orleans","70129":"Orleans","70130":"Orleans","70131":"Orleans","70163":"Orleans","70032":"St. Bernard","70043":"St. Bernard","70044":"St. Bernard","70085":"St. Bernard","70086":"St. Bernard","70092":"St. Bernard","70040":"Plaquemines","70041":"Plaquemines","70050":"Plaquemines","70068":"Plaquemines","70069":"Plaquemines","70070":"Plaquemines","70071":"Plaquemines","70074":"Plaquemines","70075":"Plaquemines","70076":"Plaquemines","70082":"Plaquemines","70083":"Plaquemines","70084":"Plaquemines","70090":"Plaquemines","70030":"St. Charles","70039":"St. Charles","70052":"St. Charles","70079":"St. Charles","70087":"St. Charles","70433":"St. Tammany","70434":"St. Tammany","70435":"St. Tammany","70437":"St. Tammany","70444":"St. Tammany","70445":"St. Tammany","70446":"St. Tammany","70447":"St. Tammany","70448":"St. Tammany","70450":"St. Tammany","70452":"St. Tammany","70455":"St. Tammany","70456":"St. Tammany","70458":"St. Tammany","70459":"St. Tammany","70460":"St. Tammany","70461":"St. Tammany","70464":"St. Tammany","70466":"St. Tammany","70471":"St. Tammany","70401":"Tangipahoa","70402":"Tangipahoa","70403":"Tangipahoa","70404":"Tangipahoa","70420":"Tangipahoa","70422":"Tangipahoa","70426":"Tangipahoa","70427":"Tangipahoa","70428":"Tangipahoa","70429":"Tangipahoa","70430":"Tangipahoa","70436":"Tangipahoa","70443":"Tangipahoa","70451":"Tangipahoa","70454":"Tangipahoa","70463":"Tangipahoa","70301":"Terrebonne","70302":"Terrebonne","70310":"Terrebonne","70352":"Terrebonne","70355":"Terrebonne","70356":"Terrebonne","70359":"Terrebonne","70360":"Terrebonne","70361":"Terrebonne","70363":"Terrebonne","70364":"Terrebonne","70380":"Terrebonne","70340":"Lafourche","70341":"Lafourche","70343":"Lafourche","70344":"Lafourche","70345":"Lafourche","70346":"Lafourche","70353":"Lafourche","70354":"Lafourche","70357":"Lafourche","70358":"Lafourche","70373":"Lafourche","70374":"Lafourche","70377":"Lafourche","70501":"Lafayette","70503":"Lafayette","70504":"Lafayette","70505":"Lafayette","70506":"Lafayette","70507":"Lafayette","70508":"Lafayette","70509":"Lafayette"};
  const upd = db.prepare("UPDATE rsvps SET parish=? WHERE id=? AND (parish IS NULL OR parish='')");
  db.prepare("SELECT id, zip FROM rsvps WHERE zip IS NOT NULL AND zip != '' AND (parish IS NULL OR parish='')").all()
    .forEach(function(r){ if (BP[r.zip]) upd.run(BP[r.zip], r.id); });
}

// ── Middleware ────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── RSVP submission ───────────────────────────────────────────────────
app.post('/rsvp', (req, res) => {
  const { firstName, lastName, email, phone, address, city, state, zip, parish,
          guests, guestNames, howToHelp, yardSign, endorse, comment, event } = req.body;
  try {
    db.prepare(`
      INSERT INTO rsvps
        (first_name, last_name, email, phone, address, city, state, zip, parish, guests, guest_names, how_to_help, yard_sign, endorse, comment, event)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(firstName, lastName, email, phone, address, city, state, zip, parish, guests, guestNames, howToHelp, yardSign, endorse, comment, event);
    res.json({ result: 'success' });
  } catch (err) {
    console.error('DB error:', err.message);
    res.status(500).json({ result: 'error' });
  }
});

// ── Yard sign delivery toggle ─────────────────────────────────────────
app.patch('/rsvp/:id/sign', (req, res) => {
  const { delivered } = req.body;
  try {
    db.prepare('UPDATE rsvps SET yard_sign_delivered=? WHERE id=?')
      .run(delivered ? 'Yes' : null, req.params.id);
    res.json({ result: 'success' });
  } catch(err) {
    res.status(500).json({ result: 'error' });
  }
});

app.patch('/rsvp/:id/role', (req, res) => {
  const { role } = req.body;
  try {
    db.prepare('UPDATE rsvps SET role=? WHERE id=?').run(role, req.params.id);
    res.json({ result: 'success' });
  } catch(err) {
    res.status(500).json({ result: 'error' });
  }
});

app.patch('/rsvp/:id/endorse', (req, res) => {
  const { endorsed } = req.body;
  try {
    db.prepare('UPDATE rsvps SET endorse=? WHERE id=?')
      .run(endorsed ? 'Yes' : 'No', req.params.id);
    res.json({ result: 'success' });
  } catch(err) {
    res.status(500).json({ result: 'error' });
  }
});

// ── Manual constituent add ────────────────────────────────────────────
app.post('/admin/constituent', (req, res) => {
  const { first_name, last_name, email, phone, address, zip, how_to_help, yard_sign, endorse, comment, role } = req.body;
  try {
    db.prepare(`
      INSERT INTO rsvps (first_name, last_name, email, phone, address, zip, how_to_help, yard_sign, endorse, comment, role, event)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(first_name||'', last_name||'', email||'', phone||'', address||'', zip||'',
           how_to_help||'', yard_sign||'No', endorse||'No', comment||'', role||'Voter', 'Manual Entry');
    res.json({ result: 'success' });
  } catch(err) {
    console.error('DB error:', err.message);
    res.status(500).json({ result: 'error' });
  }
});

// ── Auth middleware factory ───────────────────────────────────────────
function auth(role) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
      const pass = Buffer.from(header.slice(6), 'base64').toString().split(':').slice(1).join(':');
      if (pass === PASSWORDS[role]) return next();
    }
    res.set('WWW-Authenticate', `Basic realm="${role === 'admin' ? 'Campaign Admin' : 'Candidate View'}"`);
    res.status(401).send('Unauthorized');
  };
}

// ── CSV export ────────────────────────────────────────────────────────
app.get('/admin/export.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM rsvps ORDER BY created_at DESC').all();
  const esc  = v => `"${(v || '').toString().replace(/"/g, '""')}"`;
  const hdrs = ['ID','Date','First Name','Last Name','Email','Phone','Address','City','State','Zip','Parish',
                'Guests','Guest Names','How to Help','Yard Sign','Endorse','Comment','Event'];
  const csv  = [
    hdrs.join(','),
    ...rows.map(r => [
      r.id, esc(r.created_at),
      esc(r.first_name), esc(r.last_name),
      esc(r.email),      esc(r.phone),
      esc(r.address),    esc(r.city), esc(r.state), esc(r.zip), esc(r.parish),
      esc(r.guests),     esc(r.guest_names),
      esc(r.how_to_help),esc(r.yard_sign),
      esc(r.endorse),    esc(r.comment),
      esc(r.event)
    ].join(','))
  ].join('\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="blaine-rsvps.csv"');
  res.send(csv);
});

// ── Admin data (full) ─────────────────────────────────────────────────
app.get('/admin/data', (req, res) => {
  res.json(db.prepare('SELECT * FROM rsvps ORDER BY created_at DESC').all());
});

// ── Candidate data (no how_to_help) ──────────────────────────────────
app.get('/candidate/data', (req, res) => {
  const rows = db.prepare(
    'SELECT id, created_at, first_name, last_name, guests, yard_sign FROM rsvps ORDER BY created_at DESC'
  ).all();
  res.json(rows);
});

// ── Public widget API: committee members ─────────────────────────────
// Used by the Duda embeddable widget at voteforblaine.com
app.get('/api/committee', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  const rows = db.prepare(
    "SELECT first_name, last_name FROM rsvps WHERE role LIKE '%Committee Member%' ORDER BY last_name, first_name"
  ).all();
  res.json(rows);
});

// ── Admin panel ───────────────────────────────────────────────────────
app.get('/admin', (req, res) => res.send(adminHTML()));
app.get('/',      (req, res) => res.redirect('/admin'));

// ── Candidate panel ───────────────────────────────────────────────────
app.get('/candidate', (req, res) => res.send(candidateHTML()));

// ── Constituent profile ───────────────────────────────────────────────
app.get('/admin/constituent/:id/data', (req, res) => {
  const row = db.prepare('SELECT * FROM rsvps WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.patch('/admin/constituent/:id', (req, res) => {
  const { first_name, last_name, email, phone, address, city, state, zip, parish,
          guests, guest_names, how_to_help, yard_sign, endorse, comment, role } = req.body;
  try {
    db.prepare(`UPDATE rsvps SET
      first_name=?, last_name=?, email=?, phone=?, address=?, city=?, state=?, zip=?, parish=?,
      guests=?, guest_names=?, how_to_help=?, yard_sign=?, endorse=?, comment=?, role=?
      WHERE id=?`)
      .run(first_name, last_name, email, phone, address, city, state, zip, parish,
           guests, guest_names, how_to_help, yard_sign, endorse, comment, role,
           req.params.id);
    res.json({ result: 'success' });
  } catch(err) {
    res.status(500).json({ result: 'error' });
  }
});

app.get('/admin/constituent/:id', (req, res) => res.send(constituentHTML(req.params.id)));

// ── Yard sign map ─────────────────────────────────────────────────────
app.get('/admin/map', (req, res) => res.send(mapHTML()));
app.get('/admin/sign-map-data', (req, res) => {
  const rows = db.prepare(
    "SELECT id, first_name, last_name, address, city, zip, parish, yard_sign_delivered FROM rsvps WHERE yard_sign='Yes' ORDER BY created_at DESC"
  ).all();
  res.json(rows);
});

app.get('/admin/no-sign-data', (req, res) => {
  const rows = db.prepare(
    "SELECT id, first_name, last_name, address, city, zip, parish FROM rsvps WHERE (yard_sign IS NULL OR yard_sign != 'Yes') AND zip IS NOT NULL AND zip != '' ORDER BY created_at DESC"
  ).all();
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
    padding: 0 32px;
    height: 64px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .hdr-logo { height: 28px; width: auto; display: block; }
  .hdr-right { display: flex; align-items: center; gap: 16px; }
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
    border-bottom: 1px solid var(--border);
  }
  .stat { background: var(--white); padding: 28px 32px; }
  .stat-lbl {
    font-size: 9px; letter-spacing: 2.5px; text-transform: uppercase;
    color: var(--dim); font-weight: 700; margin-bottom: 8px;
  }
  .stat-val {
    font-family: 'Playfair Display', Georgia, serif;
    font-size: 40px; color: var(--navy); line-height: 1;
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
  tbody tr:hover { background: #f7f9fc; }
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

  @media(max-width:900px){
    .stats { grid-template-columns: 1fr 1fr !important; }
    .hdr, .toolbar, .foot { padding-left: 16px; padding-right: 16px; }
  }
`;

// ════════════════════════════════════════════════════════════════════════
//  WIDGET GENERATOR — defined here so .toString() preserves escape seqs
// ════════════════════════════════════════════════════════════════════════
function generateWidget(label, displayDate, time, location) {
  var BM_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxBW4GzNFR9rb3kmqYjS93wxw43XH2q4c-kb-gqQBAuqQCIEgJHggtyNWp1Kvouured/exec';
  var BM_CRM_URL = 'http://localhost:3002';
  var safeLabel = label || 'New Event';
  var safeDate  = displayDate || '';
  var safeTime  = time || '';
  var safeLoc   = location || '';
  var eyebrow   = 'Join Us';
  var heading   = safeLabel;

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
'  .bm-rsvp-input, .bm-rsvp-select, .bm-rsvp-textarea { background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12); border-radius: 3px; padding: 12px 14px; font-size: 14px; color: #fff; font-family: \'Montserrat\', sans-serif; outline: none; transition: border-color 0.15s; width: 100%; }',
'  .bm-rsvp-input::placeholder, .bm-rsvp-textarea::placeholder { color: rgba(255,255,255,0.25); }',
'  .bm-rsvp-input:focus, .bm-rsvp-select:focus, .bm-rsvp-textarea:focus { border-color: #78E0C4; }',
'  .bm-rsvp-textarea { resize: vertical; min-height: 90px; line-height: 1.5; }',
'  .bm-rsvp-select { cursor: pointer; }',
'  .bm-rsvp-select option { background: #0E356C; color: #fff; }',
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
'  .bm-rsvp-success p { font-size: 14px; color: rgba(255,255,255,0.55); line-height: 1.6; margin: 0; }',
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
'      <div class="bm-rsvp-row">',
'        <div class="bm-rsvp-field">',
'          <label class="bm-rsvp-label" for="bm-first">First Name</label>',
'          <input class="bm-rsvp-input" type="text" id="bm-first" placeholder="First name"/>',
'        </div>',
'        <div class="bm-rsvp-field">',
'          <label class="bm-rsvp-label" for="bm-last">Last Name</label>',
'          <input class="bm-rsvp-input" type="text" id="bm-last" placeholder="Last name"/>',
'        </div>',
'      </div>',
'      <div class="bm-rsvp-row">',
'        <div class="bm-rsvp-field">',
'          <label class="bm-rsvp-label" for="bm-email">Email Address</label>',
'          <input class="bm-rsvp-input" type="email" id="bm-email" placeholder="your@email.com"/>',
'        </div>',
'        <div class="bm-rsvp-field">',
'          <label class="bm-rsvp-label" for="bm-phone">Cell Number</label>',
'          <input class="bm-rsvp-input" type="tel" id="bm-phone" placeholder="(504) 555-0000"/>',
'        </div>',
'      </div>',
'      <div class="bm-rsvp-row">',
'        <div class="bm-rsvp-field">',
'          <label class="bm-rsvp-label" for="bm-zip">Zip Code</label>',
'          <input class="bm-rsvp-input" type="text" id="bm-zip" placeholder="70001" maxlength="10" oninput="bmAutoParish(this.value)"/>',
'        </div>',
'        <div class="bm-rsvp-field">',
'          <label class="bm-rsvp-label" for="bm-guests">Number of Guests (including yourself)</label>',
'          <select class="bm-rsvp-select" id="bm-guests">',
'            <option value="1">1 — Just me</option>',
'            <option value="2">2</option>',
'            <option value="3">3</option>',
'            <option value="4">4</option>',
'            <option value="5+">5 or more</option>',
'          </select>',
'        </div>',
'      </div>',
'      <div class="bm-rsvp-field">',
'        <label class="bm-rsvp-label" for="bm-address">Street Address</label>',
'        <input class="bm-rsvp-input" type="text" id="bm-address" placeholder="123 Main St"/>',
'      </div>',
'      <div class="bm-rsvp-row">',
'        <div class="bm-rsvp-field">',
'          <label class="bm-rsvp-label" for="bm-city">City</label>',
'          <input class="bm-rsvp-input" type="text" id="bm-city" placeholder="Metairie"/>',
'        </div>',
'        <div class="bm-rsvp-field">',
'          <label class="bm-rsvp-label" for="bm-state">State</label>',
'          <input class="bm-rsvp-input" type="text" id="bm-state" placeholder="LA" maxlength="2" value="LA"/>',
'        </div>',
'      </div>',
'      <input type="hidden" id="bm-parish"/>',
'      <div class="bm-rsvp-help-group">',
'        <span class="bm-rsvp-help-group-label">How would you like to help? (select all that apply)</span>',
'        <div class="bm-rsvp-help-grid">',
'          <label class="bm-rsvp-help-option"><input type="checkbox" id="bm-yardsign"/><span class="bm-rsvp-help-option-text">Deliver me a yard sign</span></label>',
'          <label class="bm-rsvp-help-option"><input type="checkbox" id="bm-help-sign-location"/><span class="bm-rsvp-help-option-text">Provide a sign location</span></label>',
'          <label class="bm-rsvp-help-option"><input type="checkbox" id="bm-help-phone-calls"/><span class="bm-rsvp-help-option-text">Make phone calls</span></label>',
'          <label class="bm-rsvp-help-option"><input type="checkbox" id="bm-help-knock"/><span class="bm-rsvp-help-option-text">Knock on doors</span></label>',
'          <label class="bm-rsvp-help-option"><input type="checkbox" id="bm-help-sign-wave"/><span class="bm-rsvp-help-option-text">Sign Wave</span></label>',
'          <label class="bm-rsvp-help-option"><input type="checkbox" id="bm-help-errands"/><span class="bm-rsvp-help-option-text">Run errands for the committee</span></label>',
'          <label class="bm-rsvp-help-option"><input type="checkbox" id="bm-help-host-event"/><span class="bm-rsvp-help-option-text">Host a meet &amp; greet or other event</span></label>',
'          <label class="bm-rsvp-help-option"><input type="checkbox" id="bm-help-inkind"/><span class="bm-rsvp-help-option-text">In-kind contribution or venue space</span></label>',
'        </div>',
'      </div>',
'      <hr class="bm-rsvp-divider"/>',
'      <label class="bm-rsvp-checkbox-row">',
'        <input type="checkbox" id="bm-endorse"/>',
'        <span class="bm-rsvp-checkbox-label">I would like to officially endorse Blaine Benge Moncrief for Judge, Division H, 24th Judicial District Court.</span>',
'      </label>',
'      <div class="bm-rsvp-field">',
'        <label class="bm-rsvp-label" for="bm-comment">Comments or Questions</label>',
'        <textarea class="bm-rsvp-textarea" id="bm-comment" placeholder="Anything you\'d like us to know…"></textarea>',
'      </div>',
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
'  function bmSubmitRsvp() {',
'    var first    = document.getElementById(\'bm-first\').value.trim();',
'    var last     = document.getElementById(\'bm-last\').value.trim();',
'    var email    = document.getElementById(\'bm-email\').value.trim();',
'    var phone    = document.getElementById(\'bm-phone\').value.trim();',
'    var address  = document.getElementById(\'bm-address\').value.trim();',
'    var city     = document.getElementById(\'bm-city\').value.trim();',
'    var state    = document.getElementById(\'bm-state\').value.trim();',
'    var zip      = document.getElementById(\'bm-zip\').value.trim();',
'    var parish   = document.getElementById(\'bm-parish\').value;',
'    var guests   = document.getElementById(\'bm-guests\').value;',
'    var yardsign = document.getElementById(\'bm-yardsign\').checked ? \'Yes\' : \'No\';',
'    var endorse  = document.getElementById(\'bm-endorse\').checked ? \'Yes\' : \'No\';',
'    var comment  = document.getElementById(\'bm-comment\').value.trim();',
'    var helpOptions = [',
'      { id: \'bm-help-sign-location\', label: \'Provide Sign Location\' },',
'      { id: \'bm-help-phone-calls\',   label: \'Make Phone Calls\' },',
'      { id: \'bm-help-knock\',         label: \'Knock on Doors\' },',
'      { id: \'bm-help-sign-wave\',     label: \'Sign Wave\' },',
'      { id: \'bm-help-errands\',       label: \'Run Errands for Committee\' },',
'      { id: \'bm-help-host-event\',    label: \'Host a Meet & Greet or Event\' },',
'      { id: \'bm-help-inkind\',        label: \'In-Kind Contribution or Venue Space\' }',
'    ];',
'    var howToHelp = helpOptions',
'      .filter(function(o) { return document.getElementById(o.id).checked; })',
'      .map(function(o) { return o.label; })',
'      .join(\', \');',
'    if (!howToHelp) howToHelp = \'None selected\';',
'    if (!first || !last || !email) { alert(\'Please fill in your first name, last name, and email.\'); return; }',
'    var btn = document.getElementById(\'bmRsvpSubmit\');',
'    btn.disabled = true; btn.textContent = \'Submitting…\';',
'    var payload = { firstName: first, lastName: last, email: email, phone: phone, address: address, city: city, state: state, zip: zip, parish: parish, guests: guests, howToHelp: howToHelp, yardSign: yardsign, endorse: endorse, comment: comment, event: \'' + safeLabel.replace(/'/g, "\\'") + '\' };',
'    fetch(BM_CRM_URL + \'/rsvp\', { method: \'POST\', headers: { \'Content-Type\': \'application/json\' }, body: JSON.stringify(payload) }).catch(function() {});',
'    fetch(BM_SCRIPT_URL + \'?\' + new URLSearchParams(payload).toString())',
'      .then(function(r) { return r.json(); })',
'      .then(function(data) {',
'        if (data.result === \'success\') {',
'          document.getElementById(\'bmRsvpForm\').style.display = \'none\';',
'          document.getElementById(\'bmRsvpSuccess\').style.display = \'block\';',
'        } else { throw new Error(); }',
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
function adminHTML() { return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Campaign Admin — Blaine Moncrief</title>
<style>${BASE_CSS}
  .stats { grid-template-columns: repeat(4,1fr); }

  /* Donation section */
  .donation-section { padding: 28px 32px; background: var(--white); border-bottom: 1px solid var(--border); }
  .donation-hdr { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
  .donation-hdr-left { display: flex; align-items: center; gap: 14px; }
  .donation-hdr-title { font-size: 9px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--dim); font-weight: 700; }
  .donation-preview-badge { font-size: 9px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; background: rgba(120,224,196,.15); color: var(--mint-d); border: 1px solid rgba(120,224,196,.3); padding: 3px 10px; border-radius: 100px; }
  .donation-summary { display: flex; gap: 32px; margin-bottom: 20px; }
  .don-sum { }
  .don-sum-num { font-family: 'Playfair Display', Georgia, serif; font-size: 28px; color: var(--navy); line-height: 1; }
  .don-sum-num.accent { color: var(--mint-d); }
  .don-sum-lbl { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: var(--dim); font-weight: 700; margin-top: 5px; }
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

  /* Election Intelligence bar */
  .election-bar {
    background: var(--navy);
    padding: 20px 32px;
    display: flex;
    align-items: stretch;
    gap: 0;
  }
  .elec-block {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 0 24px 0 0;
    border-right: 1px solid rgba(255,255,255,.1);
    margin-right: 24px;
  }
  .elec-block:last-of-type { border-right: none; margin-right: 0; padding-right: 0; }
  .elec-lbl {
    font-size: 9px; letter-spacing: 2px; text-transform: uppercase;
    color: rgba(255,255,255,.4); font-weight: 700;
  }
  .elec-val {
    font-family: 'Montserrat', sans-serif; font-size: 22px; font-weight: 800;
    color: #fff; line-height: 1;
  }
  .elec-val.accent { color: var(--mint); }
  .elec-sub {
    font-size: 10px; color: rgba(255,255,255,.35); margin-top: 2px; line-height: 1.4;
  }
  .elec-title-block {
    display: flex; flex-direction: column; justify-content: center;
    padding-right: 28px; margin-right: 4px; border-right: 1px solid rgba(255,255,255,.1);
    min-width: 160px;
  }
  .elec-title-eyebrow {
    font-size: 9px; letter-spacing: 2px; text-transform: uppercase;
    color: var(--mint); font-weight: 700; margin-bottom: 4px;
  }
  .elec-title-name {
    font-size: 12px; font-weight: 700; color: #fff; line-height: 1.3;
  }
  .elec-source {
    font-size: 9px; color: rgba(255,255,255,.22); margin-top: 16px;
    align-self: flex-end; white-space: nowrap;
  }
  @media(max-width:900px){
    .election-bar { flex-wrap: wrap; gap: 16px; }
    .elec-block { border-right: none; margin-right: 0; }
    .elec-title-block { min-width: 100%; border-right: none; padding-right: 0; }
    .elec-source { margin-top: 8px; }
  }

  /* Event tabs */
  .evt-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); background: var(--white); padding: 0 32px; overflow-x: auto; }
  .evt-tab { padding: 12px 20px; font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; font-weight: 700; cursor: pointer; border-bottom: 2px solid transparent; color: var(--dim); white-space: nowrap; user-select: none; }
  .evt-tab.active { color: var(--navy); border-bottom-color: var(--navy); }
  .evt-tab:hover:not(.active) { color: var(--muted); }
  .evt-label { font-size: 10px; color: var(--dim); background: var(--bg); padding: 2px 7px; border-radius: 100px; margin-left: 6px; }

  /* New Event button */
  .new-evt-btn { font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: #fff; background: var(--navy); border: none; padding: 8px 16px; border-radius: 2px; cursor: pointer; transition: opacity .15s; }
  .new-evt-btn:hover { opacity: .85; }

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

  @media(max-width:900px){ .snapshot-grid{grid-template-columns:1fr} }
</style>
</head>
<body>

<header class="hdr">
  <a href="/admin" style="display:block;line-height:0;"><img class="hdr-logo" src="${LOGO_URL}" alt="Blaine Benge Moncrief"/></a>
  <div class="hdr-right">
    <span class="hdr-label">Campaign Staff</span>
    <div class="hdr-divider"></div>
    <a class="map-link" href="/admin/map">Sign Map</a>
    <button class="new-evt-btn" onclick="openAddPerson()">&#xff0b; Add Person</button>
    <button class="new-evt-btn" onclick="openModal()">&#xff0b; New Event</button>
    <a class="csv-btn" href="/admin/export.csv">Export CSV</a>
  </div>
</header>

<div class="stats">
  <div class="stat"><div class="stat-lbl">RSVPs</div><div class="stat-val" id="s-rsvp">—</div></div>
  <div class="stat stat-clickable" onclick="openSignsModal()" title="View yard sign tracker">
    <div class="stat-lbl">Yard Signs Requested</div>
    <div class="stat-val" id="s-signs">—</div>
    <div class="stat-sub" id="s-signs-del"></div>
  </div>
  <div class="stat"><div class="stat-lbl">Endorsements</div><div class="stat-val" id="s-endorse">—</div></div>
  <div class="stat stat-raised"><div class="stat-lbl">Total Raised</div><div class="stat-val">$2,000</div><div class="stat-sub" style="font-size:10px;color:var(--dim);margin-top:4px;">5 donors &nbsp;&middot;&nbsp; Preview</div></div>
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

<!-- ── Recent Donations ── -->
<div class="donation-section">
  <div class="donation-hdr">
    <div class="donation-hdr-left">
      <span class="donation-hdr-title">Recent Donations</span>
      <span class="donation-preview-badge">Preview — Anedot not yet connected</span>
    </div>
    <div class="donation-summary">
      <div class="don-sum"><div class="don-sum-num accent">$2,000</div><div class="don-sum-lbl">Total Raised</div></div>
      <div class="don-sum"><div class="don-sum-num">5</div><div class="don-sum-lbl">Donors</div></div>
      <div class="don-sum"><div class="don-sum-num">$400</div><div class="don-sum-lbl">Avg. Gift</div></div>
    </div>
  </div>
  <div class="don-table-wrap">
    <table>
      <thead><tr><th>Date</th><th>Donor</th><th>Amount</th><th>Source</th><th>Method</th></tr></thead>
      <tbody>
        <tr>
          <td style="color:var(--dim);font-size:12px;">May 20, 2026</td>
          <td><a href="/admin/constituent/1" style="color:var(--navy);font-weight:600;text-decoration:none;">Marie Thibodaux</a></td>
          <td><span class="don-amount">$250</span></td>
          <td><span class="don-badge">Kick-Off Party</span></td>
          <td><span class="don-method">Visa &#183;&#183;&#183;&#183; 4821</span></td>
        </tr>
        <tr>
          <td style="color:var(--dim);font-size:12px;">May 19, 2026</td>
          <td><a href="/admin/constituent/2" style="color:var(--navy);font-weight:600;text-decoration:none;">Claire Fontenot</a></td>
          <td><span class="don-amount">$500</span></td>
          <td><span class="don-badge">Online</span></td>
          <td><span class="don-method">Visa &#183;&#183;&#183;&#183; 3301</span></td>
        </tr>
        <tr>
          <td style="color:var(--dim);font-size:12px;">May 18, 2026</td>
          <td><a href="/admin/constituent/4" style="color:var(--navy);font-weight:600;text-decoration:none;">Susan Arceneaux</a></td>
          <td><span class="don-amount">$100</span></td>
          <td><span class="don-badge">Online</span></td>
          <td><span class="don-method">MC &#183;&#183;&#183;&#183; 9214</span></td>
        </tr>
        <tr>
          <td style="color:var(--dim);font-size:12px;">May 15, 2026</td>
          <td style="font-weight:600;">James Broussard</td>
          <td><span class="don-amount">$1,000</span></td>
          <td><span class="don-badge">Direct</span></td>
          <td><span class="don-method">Visa &#183;&#183;&#183;&#183; 7733</span></td>
        </tr>
        <tr>
          <td style="color:var(--dim);font-size:12px;">May 14, 2026</td>
          <td style="font-weight:600;">Patricia Morreau</td>
          <td><span class="don-amount">$150</span></td>
          <td><span class="don-badge">Kick-Off Party</span></td>
          <td><span class="don-method">MC &#183;&#183;&#183;&#183; 5501</span></td>
        </tr>
      </tbody>
    </table>
  </div>
</div>

<!-- ── Event Filter Tabs ── -->
<div class="evt-tabs" id="evt-tabs"></div>

<div class="toolbar">
  <div class="search">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    <input id="q" type="text" placeholder="Search name, email, zip…"/>
  </div>
  <span class="tally" id="tally"></span>
</div>

<div class="wrap">
<table>
  <thead><tr>
    <th>#</th><th>Date</th><th>Name</th><th>Phone</th><th>Address</th><th>Zip</th>
    <th>Guests</th><th>Guest Names</th><th>How to Help</th><th>Yard Sign</th><th>Endorsement</th><th>Comment</th>
  </tr></thead>
  <tbody id="tbody"></tbody>
</table>
<div class="empty" id="empty" style="display:none">No submissions yet — they'll appear here as RSVPs come in.</div>
</div>

<!-- ── Election Intelligence ── -->
<div class="election-bar">
  <div class="elec-title-block">
    <div class="elec-title-eyebrow">Election</div>
    <div class="elec-title-name">Judge, Div H<br>24th JDC &middot; Jefferson Parish</div>
  </div>
  <div class="elec-block">
    <div class="elec-lbl">Registered Voters</div>
    <div class="elec-val accent">272,489</div>
    <div class="elec-sub">Jefferson Parish electorate</div>
  </div>
  <div class="elec-block">
    <div class="elec-lbl">Est. Turnout (Nov General)</div>
    <div class="elec-val">~30&ndash;40%</div>
    <div class="elec-sub">~82k&ndash;109k votes expected</div>
  </div>
  <div class="elec-block">
    <div class="elec-lbl">Est. Votes to Win</div>
    <div class="elec-val accent">~41,000+</div>
    <div class="elec-sub">Majority of est. votes cast</div>
  </div>
  <div class="elec-block">
    <div class="elec-lbl">Election Day</div>
    <div class="elec-val">Nov 3</div>
    <div class="elec-sub">2026 General Election</div>
  </div>
  <div class="elec-source">Source: LA Secretary of State &nbsp;&middot;&nbsp; Oct 2024</div>
</div>

<footer class="foot">
  Paid for by The Committee to Elect Blaine Benge Moncrief, Judge &nbsp;&middot;&nbsp; Election Day Nov 3, 2026
</footer>

<!-- ── Drill-down Modal ── -->
<!-- ── Add Person Modal ── -->
<div class="modal-overlay" id="add-person-overlay" onclick="if(event.target===this)closeAddPerson()">
  <div class="modal" style="max-width:580px;">
    <button class="modal-close" onclick="closeAddPerson()">&#215;</button>
    <div class="modal-title">Add New Constituent</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px;">
      <div class="modal-field">
        <label class="modal-label" for="ap-first">First Name</label>
        <input class="modal-input" id="ap-first" type="text" placeholder="First name"/>
      </div>
      <div class="modal-field">
        <label class="modal-label" for="ap-last">Last Name *</label>
        <input class="modal-input" id="ap-last" type="text" placeholder="Last name"/>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px;">
      <div class="modal-field">
        <label class="modal-label" for="ap-email">Email</label>
        <input class="modal-input" id="ap-email" type="email" placeholder="email@example.com"/>
      </div>
      <div class="modal-field">
        <label class="modal-label" for="ap-phone">Phone</label>
        <input class="modal-input" id="ap-phone" type="tel" placeholder="(504) 555-0000"/>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px;">
      <div class="modal-field">
        <label class="modal-label" for="ap-address">Street Address</label>
        <input class="modal-input" id="ap-address" type="text" placeholder="123 Main St"/>
      </div>
      <div class="modal-field">
        <label class="modal-label" for="ap-zip">Zip Code</label>
        <input class="modal-input" id="ap-zip" type="text" placeholder="70001"/>
      </div>
    </div>
    <div class="modal-field">
      <label class="modal-label" for="ap-role">Role</label>
      <select class="modal-input" id="ap-role">
        <option value="Voter">Voter</option>
        <option value="Committee Member">Committee Member</option>
        <option value="Voter, Committee Member">Voter + Committee Member</option>
        <option value="Attorney">Attorney</option>
      </select>
    </div>
    <div class="modal-field">
      <label class="modal-label" for="ap-comment">Notes</label>
      <input class="modal-input" id="ap-comment" type="text" placeholder="Optional notes…"/>
    </div>
    <div id="ap-error" style="color:#f59e0b;font-size:12px;margin-bottom:12px;display:none;">Please enter at least a last name.</div>
    <button class="modal-copy" id="ap-submit" onclick="submitAddPerson()">Add to Database</button>
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
var all = [];
var activeEvent = null;

fetch('/admin/data').then(r=>r.json()).then(function(d){
  all = d;
  buildTabs(d);
  refresh();
});

var HELP_OPTIONS = [
  'Yard Sign',
  'Provide Sign Location',
  'Make Phone Calls',
  'Knock on Doors',
  'Sign Wave',
  'Run Errands for Committee',
  'Host a Meet & Greet or Event',
  'In-Kind Contribution or Venue Space'
];

function filtered() {
  if (!activeEvent) return all;
  return all.filter(function(r){ return r.event === activeEvent; });
}

function refresh() {
  var d = filtered();
  var q = document.getElementById('q').value.toLowerCase();
  var fd = q ? d.filter(function(r){
    return ['first_name','last_name','email','phone','zip','comment']
      .some(function(f){ return r[f]&&r[f].toLowerCase().includes(q); });
  }) : d;
  stats(d);
  snapshot(d);
  render(fd);
}

function buildTabs(d) {
  var events = [];
  var seen = {};
  d.forEach(function(r){
    if (r.event && !seen[r.event]) { seen[r.event]=true; events.push(r.event); }
  });

  var container = document.getElementById('evt-tabs');
  var allCount = d.length;
  var tabs = '<div class="evt-tab active" data-evt="" onclick="selectTab(this)">All Events<span class="evt-label">'+allCount+'</span></div>';
  events.forEach(function(ev){
    var n = d.filter(function(r){ return r.event===ev; }).length;
    tabs += '<div class="evt-tab" data-evt="'+x(ev)+'" onclick="selectTab(this)">'
          + x(ev) + '<span class="evt-label">'+n+'</span></div>';
  });
  container.innerHTML = tabs;
}

function selectTab(el) {
  document.querySelectorAll('.evt-tab').forEach(function(t){ t.classList.remove('active'); });
  el.classList.add('active');
  activeEvent = el.getAttribute('data-evt') || null;
  refresh();
}

function stats(d) {
  document.getElementById('s-rsvp').textContent    = d.length;
  document.getElementById('s-guests').textContent  = d.reduce(function(s,r){ return s+(parseInt(r.guests)||1); },0);
  var signReqs = d.filter(function(r){ return r.yard_sign==='Yes'; });
  var signDel  = signReqs.filter(function(r){ return r.yard_sign_delivered==='Yes'; });
  document.getElementById('s-signs').textContent   = signReqs.length;
  document.getElementById('s-signs-del').textContent = signDel.length + ' of ' + signReqs.length + ' delivered';
  document.getElementById('s-endorse').textContent = d.filter(function(r){ return r.endorse==='Yes'; }).length;
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
        if (helpCounts.hasOwnProperty(t)) helpCounts[t]++;
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
  if (!d.length) { tbody.innerHTML=''; empty.style.display='block'; return; }
  empty.style.display='none';
  tbody.innerHTML = d.map(function(r){
    var helps = (r.how_to_help && r.how_to_help!=='None selected')
      ? r.how_to_help.split(',').map(function(h){ return '<span class="tag">'+x(h.trim())+'</span>'; }).join('')
      : '<span class="tag-none">—</span>';
    var sign = r.yard_sign==='Yes'
      ? '<span class="badge badge-yes">Yes</span>'
      : '<span class="badge badge-no">No</span>';
    var date = (r.created_at||'').slice(0,10);
    return '<tr>'+
      '<td class="c-id">'+r.id+'</td>'+
      '<td class="c-date">'+date+'</td>'+
      '<td><a href="/admin/constituent/'+r.id+'" class="c-name" style="text-decoration:none;">'+x(r.first_name)+' '+x(r.last_name)+'</a>'+
          '<div class="c-sub">'+x(r.email)+'</div></td>'+
      '<td class="c-phone">'+fmtPhone(r.phone)+'</td>'+
      '<td class="c-sub" style="font-size:12px;color:var(--muted);">'+x(r.address)+(r.city?'<br>'+x(r.city)+', '+x(r.state||'')+(r.parish?' &nbsp;·&nbsp; '+x(r.parish)+' Parish':''):'')+'</td>'+
      '<td class="c-zip">'+x(r.zip)+'</td>'+
      '<td><span class="badge badge-guests">'+x(r.guests)+'</span></td>'+
      '<td class="c-sub" style="font-size:12px;color:var(--muted);max-width:160px;line-height:1.5;">'+x(r.guest_names)+'</td>'+
      '<td>'+helps+'</td>'+
      '<td>'+sign+'</td>'+
      '<td>'+(r.endorse==='Yes'?'<span class="badge badge-yes">Yes</span>':'<span class="badge badge-no">No</span>')+'</td>'+
      '<td class="c-comment">'+x(r.comment)+'</td>'+
    '</tr>';
  }).join('');
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
    var date  = (r.created_at||'').slice(0,10);
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

function drilldown(option) {
  drillOption = option;
  var d = filtered();
  if (option === 'Yard Sign') {
    drillData = d.filter(function(r){ return r.yard_sign === 'Yes'; });
  } else {
    drillData = d.filter(function(r){
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
      var date = (r.created_at||'').slice(0,10);
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

function x(s){ return s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):''; }
function fmtPhone(p){ if(!p) return ''; var d=String(p).replace(/\D/g,''); if(d.length===10) return d.slice(0,3)+'-'+d.slice(3,6)+'-'+d.slice(6); return p; }

document.getElementById('q').addEventListener('input',function(){
  refresh();
});

// ── Modal ──
function openAddPerson() {
  ['ap-first','ap-last','ap-email','ap-phone','ap-address','ap-zip','ap-comment'].forEach(function(id){ document.getElementById(id).value = ''; });
  document.getElementById('ap-role').value = 'Voter';
  document.getElementById('ap-error').style.display = 'none';
  document.getElementById('ap-submit').disabled = false;
  document.getElementById('ap-submit').textContent = 'Add to Database';
  document.getElementById('add-person-overlay').classList.add('open');
  document.getElementById('ap-first').focus();
}
function closeAddPerson() {
  document.getElementById('add-person-overlay').classList.remove('open');
}
function submitAddPerson() {
  var last = document.getElementById('ap-last').value.trim();
  if (!last) { document.getElementById('ap-error').style.display = 'block'; return; }
  document.getElementById('ap-error').style.display = 'none';
  var btn = document.getElementById('ap-submit');
  btn.disabled = true; btn.textContent = 'Saving…';
  fetch('/admin/constituent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      first_name: document.getElementById('ap-first').value.trim(),
      last_name:  last,
      email:      document.getElementById('ap-email').value.trim(),
      phone:      document.getElementById('ap-phone').value.trim(),
      address:    document.getElementById('ap-address').value.trim(),
      zip:        document.getElementById('ap-zip').value.trim(),
      role:       document.getElementById('ap-role').value,
      comment:    document.getElementById('ap-comment').value.trim()
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
</script>
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

<footer class="foot">
  Paid for by The Committee to Elect Blaine Benge Moncrief, Judge &nbsp;&middot;&nbsp; Election Day Nov 3, 2026
</footer>

<script>
var all = [];
fetch('/candidate/data').then(r=>r.json()).then(function(d){ all=d; stats(d); render(d); });

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
    var date = (r.created_at||'').slice(0,10);
    return '<tr>'+
      '<td class="c-id">'+r.id+'</td>'+
      '<td class="c-date">'+date+'</td>'+
      '<td class="c-name">'+x(r.first_name)+' '+x(r.last_name)+'</td>'+
      '<td><span class="badge badge-guests">'+x(r.guests)+'</span></td>'+
      '<td>'+sign+'</td>'+
    '</tr>';
  }).join('');
}

function x(s){ return s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):''; }

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
function constituentHTML(id) {
  const _row = db.prepare('SELECT * FROM rsvps WHERE id=?').get(id);
  const _data = JSON.stringify(_row || null);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Constituent Profile — Blaine Moncrief</title>
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
  .p-cards { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 20px; }
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
  .ct-val { font-size: 14px; color: var(--navy); font-weight: 500; min-height: 20px; }
  .ct-input { font-size: 14px; color: var(--navy); border: 1px solid var(--border); border-radius: 3px; padding: 8px 10px; font-family: 'Montserrat', sans-serif; width: 100%; background: #fff; outline: none; display: none; }
  .ct-input:focus { border-color: var(--mint); }
  .edit-row { display: flex; gap: 10px; align-items: center; margin-top: 20px; }
  .btn-main { background: var(--navy); color: #fff; border: none; padding: 9px 20px; border-radius: 3px; font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; cursor: pointer; font-family: 'Montserrat', sans-serif; transition: opacity .15s; }
  .btn-main:hover { opacity: .85; }
  .btn-save { background: var(--mint); color: var(--navy); border: none; padding: 9px 20px; border-radius: 3px; font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; cursor: pointer; font-family: 'Montserrat', sans-serif; display: none; }
  .btn-ghost { background: none; color: var(--dim); border: 1px solid var(--border); padding: 8px 16px; border-radius: 3px; font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; cursor: pointer; font-family: 'Montserrat', sans-serif; display: none; }
  .save-msg { font-size: 11px; color: #2e9e7e; font-weight: 600; display: none; }
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
  /* Donation history card */
  .don-hist-preview { display: inline-flex; align-items: center; gap: 6px; font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; background: rgba(120,224,196,.12); color: var(--mint-d); border: 1px solid rgba(120,224,196,.25); padding: 3px 10px; border-radius: 100px; margin-left: 10px; vertical-align: middle; }
  .don-hist-summary { display: flex; gap: 28px; margin-bottom: 20px; padding-bottom: 18px; border-bottom: 1px solid var(--border); }
  .don-hist-num { font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif; font-size: 26px; font-weight: 800; color: var(--navy); line-height: 1; }
  .don-hist-num.accent { color: var(--mint-d); }
  .don-hist-lbl { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: var(--dim); font-weight: 700; margin-top: 5px; }
  .don-row { display: flex; align-items: center; gap: 14px; padding: 10px 0; border-bottom: 1px solid #f0f2f5; }
  .don-row:last-child { border-bottom: none; }
  .don-row-date { font-size: 11px; color: var(--dim); min-width: 90px; }
  .don-row-amt { font-family: 'Playfair Display', Georgia, serif; font-size: 20px; color: var(--navy); min-width: 70px; }
  .don-row-badge { font-size: 10px; font-weight: 600; padding: 2px 9px; border-radius: 100px; background: rgba(120,224,196,.12); color: var(--navy); border: 1px solid rgba(120,224,196,.2); }
  .don-row-method { font-size: 11px; color: var(--dim); margin-left: auto; }
  @media(max-width:640px) { .p-cards{grid-template-columns:1fr 1fr;} .ct-grid{grid-template-columns:1fr;} .p-hero{padding:24px 20px; flex-direction:column;} .p-hero-map{width:100%; height:180px;} .page-body{padding:16px 16px 40px;} .edit-checks{grid-template-columns:1fr;} }
</style>
</head>
<body>

<header class="hdr">
  <a href="/admin" style="display:block;line-height:0;"><img src="${LOGO_URL}" class="hdr-logo" alt="Blaine Moncrief"/></a>
  <div class="hdr-right">
    <span class="hdr-label">Constituent Profile</span>
  </div>
</header>

<div class="page-body">

<a href="/admin" class="back-link">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
  All Constituents
</a>

<div class="p-hero">
  <div class="p-hero-left">
    <div class="p-eyebrow">Constituent Profile</div>
    <div class="p-name" id="p-name">Loading&#8230;</div>
    <div id="p-event" class="p-event-badge" style="display:none;"></div>
    <div id="p-role"></div>
  </div>
  <div class="p-hero-map" id="p-hero-map" style="display:none;">
    <div id="hero-tile-map" style="width:100%;height:100%;min-height:200px;"></div>
  </div>
</div>

<div class="p-cards">
  <div class="p-card">
    <div class="p-card-lbl">Total Giving</div>
    <div class="p-card-num" id="p-total-giving" style="font-size:26px;">&#8212;</div>
    <div class="giving-bar-wrap">
      <div class="giving-bar-meta">
        <span class="giving-bar-remaining" id="p-giving-remaining"></span>
        <span class="giving-bar-cap">$6,000 cap</span>
      </div>
      <div class="giving-bar-track">
        <div class="giving-bar-fill" id="p-giving-bar" style="width:0%;background:#78E0C4;"></div>
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
    <div class="ct-field">
      <div class="ct-lbl">Address</div>
      <div class="ct-val" id="v-address"></div>
      <input class="ct-input" id="i-address" type="text" placeholder="123 Main St"/>
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
  </div>
  <div class="edit-row">
    <button class="btn-main" id="btn-edit" onclick="startEdit()">Edit Profile</button>
    <button class="btn-save" id="btn-save" onclick="saveEdit()">Save Changes</button>
    <button class="btn-ghost" id="btn-cancel" onclick="cancelEdit()">Cancel</button>
    <span class="save-msg" id="save-msg">&#10003; Saved</span>
  </div>
</div>

<div class="s-card">
  <div class="s-label">How They Want to Help</div>
  <div class="tags" id="p-helps"></div>
  <div id="edit-helps-wrap" style="display:none;">
    <div class="edit-checks">
      <label class="edit-check-item"><input type="checkbox" id="eh-yardsign"/><span class="edit-check-label">Deliver me a yard sign</span></label>
      <label class="edit-check-item"><input type="checkbox" id="eh-location"/><span class="edit-check-label">Provide Sign Location</span></label>
      <label class="edit-check-item"><input type="checkbox" id="eh-calls"/><span class="edit-check-label">Make Phone Calls</span></label>
      <label class="edit-check-item"><input type="checkbox" id="eh-knock"/><span class="edit-check-label">Knock on Doors</span></label>
      <label class="edit-check-item"><input type="checkbox" id="eh-wave"/><span class="edit-check-label">Sign Wave</span></label>
      <label class="edit-check-item"><input type="checkbox" id="eh-errands"/><span class="edit-check-label">Run Errands for Committee</span></label>
      <label class="edit-check-item"><input type="checkbox" id="eh-host"/><span class="edit-check-label">Host a Meet &amp; Greet or Event</span></label>
      <label class="edit-check-item"><input type="checkbox" id="eh-inkind"/><span class="edit-check-label">In-Kind Contribution or Venue Space</span></label>
    </div>
  </div>
</div>

<div class="s-card">
  <div class="s-label">Comments</div>
  <div id="p-comment"></div>
  <textarea class="edit-textarea" id="i-comment" placeholder="Comments or questions…"></textarea>
</div>

  <div class="p-meta">Registered <strong id="p-date">&#8212;</strong> &nbsp;&middot;&nbsp; ID #<strong id="p-id">&#8212;</strong></div>
</div>

<div class="s-card" id="don-hist-card">
  <div class="s-label">
    Donation History
    <span class="don-hist-preview">Preview — Anedot not yet connected</span>
  </div>
  <div class="don-hist-summary">
    <div class="don-hist"><div class="don-hist-num accent" id="dh-total">—</div><div class="don-hist-lbl">Total Given</div></div>
    <div class="don-hist"><div class="don-hist-num" id="dh-count">—</div><div class="don-hist-lbl">Donations</div></div>
    <div class="don-hist"><div class="don-hist-num" id="dh-last">—</div><div class="don-hist-lbl">Last Gift</div></div>
  </div>
  <div id="dh-rows"></div>
</div>

<footer class="foot">Campaign Admin &nbsp;&middot;&nbsp; Blaine Benge Moncrief for Judge, Division H &nbsp;&middot;&nbsp; 24th JDC</footer>

<script>
var CID = ${id};
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
  if (el && (!el.value || ZIP_PARISH[zip])) el.value = p;
}

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
  document.getElementById("p-date").textContent  = (d.created_at||"").slice(0,10);
  document.getElementById("p-id").textContent    = d.id;
  if (d.event) {
    var eb = document.getElementById("p-event");
    eb.textContent  = d.event;
    eb.style.display = "inline-block";
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
    "<button class='role-pill attorney" + (isAttorney ? " active" : "") + "' onclick='setRole(this.dataset.r)' data-r='Attorney'>&#9878; Attorney</button>" +
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
  var helpMap = {
    "eh-location": "Provide Sign Location",
    "eh-calls":    "Make Phone Calls",
    "eh-knock":    "Knock on Doors",
    "eh-wave":     "Sign Wave",
    "eh-errands":  "Run Errands for Committee",
    "eh-host":     "Host a Meet & Greet or Event",
    "eh-inkind":   "In-Kind Contribution or Venue Space"
  };
  Object.keys(helpMap).forEach(function(k){
    document.getElementById(k).checked = helpLabels.indexOf(helpMap[k]) > -1;
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

  var FIELDS = ["first","last","email","phone","address","city","state","zip","parish"];
  var KEYS   = ["first_name","last_name","email","phone","address","city","state","zip","parish"];
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

  // Mock donation history — replace with live Anedot data after deployment
  var MOCK_GIFTS = {
    1:  [{ date:"May 20, 2026", amount:"$250", badge:"Kick-Off Party", method:"Visa ···· 4821" }],
    2:  [{ date:"May 19, 2026", amount:"$500", badge:"Online",         method:"Visa ···· 3301" },
         { date:"Apr 4,  2026",  amount:"$250", badge:"Direct",         method:"Visa ···· 3301" }],
    4:  [{ date:"May 18, 2026", amount:"$100", badge:"Online",         method:"MC ···· 9214" }]
  };
  var gifts = MOCK_GIFTS[d.id] || [];
  var total = gifts.reduce(function(s,g){ return s + parseFloat(g.amount.replace(/[$,]/g,"")); }, 0);
  document.getElementById("dh-total").textContent  = gifts.length ? ("$" + total.toLocaleString()) : "—";
  document.getElementById("dh-count").textContent  = gifts.length || "—";
  document.getElementById("dh-last").textContent   = gifts.length ? gifts[0].date : "—";
  document.getElementById("dh-rows").innerHTML = gifts.length
    ? gifts.map(function(g){
        return "<div class='don-row'>" +
          "<span class='don-row-date'>" + g.date + "</span>" +
          "<span class='don-row-amt'>" + g.amount + "</span>" +
          "<span class='don-row-badge'>" + g.badge + "</span>" +
          "<span class='don-row-method'>" + g.method + "</span>" +
          "</div>";
      }).join("")
    : "<div style='font-size:13px;color:var(--dim);font-style:italic;padding:4px 0;'>No donations on record.</div>";

  // Total Giving card — progress bar toward $6,000 cap
  var cap = 6000;
  var pct = total ? Math.min((total / cap) * 100, 100) : 0;
  var remaining = cap - total;
  document.getElementById("p-total-giving").textContent = total ? ("$" + total.toLocaleString()) : "$0";
  document.getElementById("p-giving-remaining").textContent = total
    ? ("$" + remaining.toLocaleString() + " remaining")
    : "No contributions yet";
  document.getElementById("p-giving-bar").style.width      = pct + "%";
  document.getElementById("p-giving-bar").style.background = pct >= 80 ? "#f59e0b" : "#78E0C4";
}

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

function saveEdit() {
  var helpKeys = [
    {id:"eh-location", label:"Provide Sign Location"},
    {id:"eh-calls",    label:"Make Phone Calls"},
    {id:"eh-knock",    label:"Knock on Doors"},
    {id:"eh-wave",     label:"Sign Wave"},
    {id:"eh-errands",  label:"Run Errands for Committee"},
    {id:"eh-host",     label:"Host a Meet & Greet or Event"},
    {id:"eh-inkind",   label:"In-Kind Contribution or Venue Space"}
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
    comment:     document.getElementById("i-comment").value.trim()
  };
  fetch("/admin/constituent/" + CID, {
    method: "PATCH",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(body)
  }).then(function(r){ return r.json(); }).then(function(res){
    if (res.result === "success") {
      Object.assign(rec, body);
      cancelEdit();
      paint(rec);
      var m = document.getElementById("save-msg");
      m.style.display = "inline";
      setTimeout(function(){ m.style.display = "none"; }, 2500);
    }
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
  .sb-stat-num { font-family: 'Playfair Display', Georgia, serif; font-size: 26px; color: var(--navy); line-height: 1; margin-bottom: 4px; }
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

  @media(max-width:900px) {
    html, body { overflow: auto; }
    .map-layout { flex-direction: column; height: auto; }
    .map-sidebar { width: 100%; }
    .map-main { height: 480px; }
  }
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
  "70094":[29.9072,-90.1450]
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

var map = L.map('lmap').setView([29.955,-90.130],12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
  attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom:19
}).addTo(map);
var layers = L.layerGroup().addTo(map);
var noSignLayers = L.layerGroup().addTo(map);
var noSignCache = null;

function pinIcon(color){
  return L.divIcon({className:'',
    html:'<div style="width:15px;height:15px;border-radius:50%;background:'+color+';border:2.5px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.4);"></div>',
    iconSize:[15,15],iconAnchor:[7,7],popupAnchor:[0,-9]});
}

function ringIcon(){
  return L.divIcon({className:'',
    html:'<div style="width:11px;height:11px;border-radius:50%;background:rgba(255,255,255,.85);border:2.5px solid #8fa7c8;box-shadow:0 1px 4px rgba(0,0,0,.3);"></div>',
    iconSize:[11,11],iconAnchor:[5,5],popupAnchor:[0,-7]});
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

fetch('/admin/sign-map-data').then(function(r){return r.json();}).then(function(data){
  buildStats(data); buildMap(data); buildZipGrid(data); buildGaps(data);
});

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
    L.circle(c,{radius:300,fillColor:'#78E0C4',fillOpacity:0.15,color:'#78E0C4',weight:1.5}).addTo(layers);
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
