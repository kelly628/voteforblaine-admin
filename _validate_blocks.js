// Validate each <script> block in adminHTML separately
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync('server.js', 'utf8');

const fnStart = src.indexOf('function adminHTML(');
const templateStart = src.indexOf('return `', fnStart) + 7;
const templateEnd = src.lastIndexOf('`;\n}', src.indexOf('function constituentHTML'));
let rawTemplate = src.slice(templateStart + 1, templateEnd);

// Simulate template substitution
const PIPELINE_STAGES = [
  { key: 'new', label: 'New Contact', color: '#9aaabb' },
  { key: 'contacted', label: 'Contacted', color: '#3b82f6' },
  { key: 'engaged', label: 'In Conversation', color: '#8b5cf6' },
  { key: 'met', label: 'Meet with Team', color: '#fb923c' },
  { key: 'committed', label: 'Vote Committed', color: '#10b981' },
];
const PIPELINE_JSON = JSON.stringify(PIPELINE_STAGES);
rawTemplate = rawTemplate
  .replace(/\$\{PIPELINE_JSON\}/g, PIPELINE_JSON)
  .replace(/\$\{baseUrl \|\| process\.env\.PUBLIC_URL \|\| "http:\/\/localhost:3002"\}/g, 'http://localhost:3002')
  .replace(/\$\{[^}]+\}/g, '""');

// Process template literal escapes: \\ -> \
rawTemplate = rawTemplate.replace(/\\\\/g, '\x00BS\x00').replace(/\\\n/g, '').replace(/\x00BS\x00/g, '\\');

// Find and validate each script block separately
let pos = 0;
let scriptNum = 0;
let allOk = true;
while (true) {
  const start = rawTemplate.indexOf('<script>', pos);
  if (start === -1) break;
  const end = rawTemplate.indexOf('</script>', start);
  if (end === -1) break;
  scriptNum++;
  const script = rawTemplate.slice(start + 8, end);

  try {
    new vm.Script(script);
    console.log('Script block ' + scriptNum + ' (' + script.split('\n').length + ' lines): ✓ OK');
  } catch(e) {
    allOk = false;
    console.log('Script block ' + scriptNum + ' (' + script.split('\n').length + ' lines): ✗ ERROR - ' + e.message);
    const lines = script.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const chunk = lines.slice(0, i + 1).join('\n');
      try { new vm.Script(chunk); } catch(e2) {
        const msg = e2.message;
        if (!msg.includes('Unexpected end') && !msg.includes('missing') && msg !== e.message) {
          console.log('  Error first at script line ' + (i+1) + ': ' + msg);
          for (let j = Math.max(0,i-3); j <= Math.min(lines.length-1,i+4); j++) {
            console.log('  ' + (j===i?'>>>':'   ') + ' ' + (j+1) + ': ' + lines[j].substring(0,130));
          }
          break;
        }
      }
    }
  }
  pos = end + 9;
}
console.log('\nTotal script blocks found: ' + scriptNum);
if (allOk) console.log('ALL BLOCKS VALID');
