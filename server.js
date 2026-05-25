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
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'rsvp.db');
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
try { db.exec(`ALTER TABLE rsvps ADD COLUMN guest_names TEXT`); } catch(e) {}

// ── Middleware ────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── RSVP submission ───────────────────────────────────────────────────
app.post('/rsvp', (req, res) => {
  const { firstName, lastName, email, phone, address, zip,
          guests, guestNames, howToHelp, yardSign, endorse, comment, event } = req.body;
  try {
    db.prepare(`
      INSERT INTO rsvps
        (first_name, last_name, email, phone, address, zip, guests, guest_names, how_to_help, yard_sign, endorse, comment, event)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(firstName, lastName, email, phone, address, zip, guests, guestNames, howToHelp, yardSign, endorse, comment, event);
    res.json({ result: 'success' });
  } catch (err) {
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
  const hdrs = ['ID','Date','First Name','Last Name','Email','Phone','Address','Zip',
                'Guests','Guest Names','How to Help','Yard Sign','Endorse','Comment','Event'];
  const csv  = [
    hdrs.join(','),
    ...rows.map(r => [
      r.id, esc(r.created_at),
      esc(r.first_name), esc(r.last_name),
      esc(r.email),      esc(r.phone),
      esc(r.address),    esc(r.zip),
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

// ── Admin panel ───────────────────────────────────────────────────────
app.get('/admin', (req, res) => res.send(adminHTML()));
app.get('/',      (req, res) => res.redirect('/admin'));

// ── Candidate panel ───────────────────────────────────────────────────
app.get('/candidate', (req, res) => res.send(candidateHTML()));

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
//  ADMIN HTML — full view (campaign staff)
// ════════════════════════════════════════════════════════════════════════
function adminHTML() { return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Campaign Admin — Blaine Moncrief</title>
<style>${BASE_CSS}
  .stats { grid-template-columns: repeat(4,1fr); }

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
  <img class="hdr-logo" src="${LOGO_URL}" alt="Blaine Benge Moncrief"/>
  <div class="hdr-right">
    <span class="hdr-label">Campaign Staff</span>
    <div class="hdr-divider"></div>
    <button class="new-evt-btn" onclick="openModal()">&#xff0b; New Event</button>
    <a class="csv-btn" href="/admin/export.csv">Export CSV</a>
  </div>
</header>

<!-- ── Event Filter Tabs ── -->
<div class="evt-tabs" id="evt-tabs"></div>

<div class="stats">
  <div class="stat"><div class="stat-lbl">RSVPs</div><div class="stat-val" id="s-rsvp">—</div></div>
  <div class="stat"><div class="stat-lbl">Total Guests</div><div class="stat-val accent" id="s-guests">—</div></div>
  <div class="stat"><div class="stat-lbl">Yard Signs</div><div class="stat-val" id="s-signs">—</div></div>
  <div class="stat"><div class="stat-lbl">Endorsements</div><div class="stat-val" id="s-endorse">—</div></div>
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

<footer class="foot">
  Paid for by The Committee to Elect Blaine Benge Moncrief, Judge &nbsp;&middot;&nbsp; Election Day Nov 3, 2026
</footer>

<!-- ── Drill-down Modal ── -->
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
  var tabs = '<div class="evt-tab active" data-event="" onclick="selectTab(this,null)">All Events<span class="evt-label">'+allCount+'</span></div>';
  events.forEach(function(ev){
    var n = d.filter(function(r){ return r.event===ev; }).length;
    tabs += '<div class="evt-tab" data-event="'+x(ev)+'" onclick="selectTab(this,\''+x(ev).replace(/'/g,"\\'")+'\')">'
          + x(ev) + '<span class="evt-label">'+n+'</span></div>';
  });
  container.innerHTML = tabs;
}

function selectTab(el, evtName) {
  document.querySelectorAll('.evt-tab').forEach(function(t){ t.classList.remove('active'); });
  el.classList.add('active');
  activeEvent = evtName || null;
  refresh();
}

function stats(d) {
  document.getElementById('s-rsvp').textContent    = d.length;
  document.getElementById('s-guests').textContent  = d.reduce(function(s,r){ return s+(parseInt(r.guests)||1); },0);
  document.getElementById('s-signs').textContent   = d.filter(function(r){ return r.yard_sign==='Yes'; }).length;
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
    return '<div class="bar-row" onclick="drilldown(\''+safe+'\')" title="View people who selected this">'+
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
      '<td><div class="c-name">'+x(r.first_name)+' '+x(r.last_name)+'</div>'+
          '<div class="c-sub">'+x(r.email)+'</div></td>'+
      '<td class="c-phone">'+x(r.phone)+'</td>'+
      '<td class="c-sub" style="font-size:12px;color:var(--muted);">'+x(r.address)+'</td>'+
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
  var blob = new Blob([rows.join('\n')], {type:'text/csv'});
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

document.getElementById('q').addEventListener('input',function(){
  refresh();
});

// ── Modal ──
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
'          <input class="bm-rsvp-input" type="text" id="bm-zip" placeholder="70001" maxlength="10"/>',
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
'    var zip      = document.getElementById(\'bm-zip\').value.trim();',
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
'    var payload = { firstName: first, lastName: last, email: email, phone: phone, address: address, zip: zip, guests: guests, howToHelp: howToHelp, yardSign: yardsign, endorse: endorse, comment: comment, event: \'' + safeLabel.replace(/'/g, "\\'") + '\' };',
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
'        alert(\'Something went wrong. Please try again or email electblainemoncriefjudge@gmail.com\');',
'      });',
'  }',
'<\/script>'
  ].join('\n');
}
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
  <img class="hdr-logo" src="${LOGO_URL}" alt="Blaine Benge Moncrief"/>
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
