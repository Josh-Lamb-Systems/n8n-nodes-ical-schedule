// Random calendars using only features the PHP parser supports.
const fs = require('fs');
let seed = +process.argv[3] || 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['MO','TU','WE','TH','FR','SA','SU'];
function dt(y, m, d, h, i) { return `${y}${pad(m)}${pad(d)}T${pad(h)}${pad(i)}00`; }
function event(n) {
  const L = [];
  const uid = `ev${n}@test`;
  const y = 2026, m = int(1, 10), d = int(1, 28);
  const allDay = rnd() < 0.25;
  const utc = !allDay && rnd() < 0.25;
  const h = int(6, 21), i = pick([0, 15, 30, 45]);
  const durMin = pick([15, 30, 60, 90, 180, 600]);
  const startD = new Date(Date.UTC(y, m - 1, d, h, i));
  const endD = new Date(startD.getTime() + durMin * 60000);
  L.push('BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:Event ${n}`);
  if (rnd() < 0.3) L.push(`LOCATION:Room ${n}`);
  if (allDay) {
    const len = pick([1, 1, 1, 2, 3]);
    const e = new Date(Date.UTC(y, m - 1, d + len));
    L.push(`DTSTART;VALUE=DATE:${y}${pad(m)}${pad(d)}`, `DTEND;VALUE=DATE:${e.getUTCFullYear()}${pad(e.getUTCMonth()+1)}${pad(e.getUTCDate())}`);
  } else if (utc) {
    const f = (x) => `${x.getUTCFullYear()}${pad(x.getUTCMonth()+1)}${pad(x.getUTCDate())}T${pad(x.getUTCHours())}${pad(x.getUTCMinutes())}00Z`;
    L.push(`DTSTART:${f(startD)}`, `DTEND:${f(endD)}`);
  } else {
    const f = (x) => dt(x.getUTCFullYear(), x.getUTCMonth()+1, x.getUTCDate(), x.getUTCHours(), x.getUTCMinutes());
    L.push(`DTSTART;TZID=America/New_York:${f(startD)}`, `DTEND;TZID=America/New_York:${f(endD)}`);
  }
  const extras = [];
  if (rnd() < 0.75) {
    const freq = pick(['DAILY', 'WEEKLY', 'WEEKLY', 'WEEKLY', 'MONTHLY', 'MONTHLY', 'YEARLY']);
    const parts = [`FREQ=${freq}`];
    if (rnd() < 0.3) parts.push(`INTERVAL=${int(2, 3)}`);
    if (freq === 'WEEKLY' && rnd() < 0.6) {
      const n = int(1, 3); const s = new Set(); while (s.size < n) s.add(pick(DAYS));
      parts.push(`BYDAY=${[...s].join(',')}`);
    }
    if (freq === 'MONTHLY') {
      const r = rnd();
      if (r < 0.4) parts.push(`BYDAY=${pick(['1','2','3','4','-1'])}${pick(DAYS)}`);
      else if (r < 0.7) parts.push(`BYMONTHDAY=${int(1, 28)}`);
    }
    const end = rnd();
    if (end < 0.3) parts.push(`COUNT=${int(2, 30)}`);
    else if (end < 0.55) parts.push(`UNTIL=2026${pad(int(m, 12))}${pad(int(1, 28))}T235959Z`);
    // daily open-ended would hit the 500 cap only after 500 days; fine for 2026 starts
    L.push(`RRULE:${parts.join(';')}`);
    if (rnd() < 0.4) {
      const ex = new Date(startD.getTime() + int(1, 120) * 86400000);
      const exs = allDay ? `EXDATE;VALUE=DATE:${ex.getUTCFullYear()}${pad(ex.getUTCMonth()+1)}${pad(ex.getUTCDate())}`
        : `EXDATE;TZID=America/New_York:${dt(ex.getUTCFullYear(), ex.getUTCMonth()+1, ex.getUTCDate(), h, i)}`;
      L.push(exs);
    }
    if (!allDay && !utc && freq !== 'MONTHLY' && rnd() < 0.35) {
      // an override that stays on the same day (the case PHP handles)
      const o = new Date(startD.getTime() + int(1, 60) * 86400000);
      const oh = int(6, 20);
      extras.push(['BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:Event ${n} (moved)`,
        `RECURRENCE-ID;TZID=America/New_York:${dt(o.getUTCFullYear(), o.getUTCMonth()+1, o.getUTCDate(), h, i)}`,
        `DTSTART;TZID=America/New_York:${dt(o.getUTCFullYear(), o.getUTCMonth()+1, o.getUTCDate(), oh, 0)}`,
        `DTEND;TZID=America/New_York:${dt(o.getUTCFullYear(), o.getUTCMonth()+1, o.getUTCDate(), oh, 45)}`,
        'END:VEVENT']);
    }
  }
  L.push('END:VEVENT');
  return [L, ...extras].flat();
}
const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Fuzz'];
const n = int(5, 25);
for (let k = 0; k < n; k++) out.push(...event(k));
out.push('END:VCALENDAR');
fs.writeFileSync(process.argv[2], out.join('\r\n') + '\r\n');
