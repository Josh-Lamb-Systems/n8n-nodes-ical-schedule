// Targeted tests for the bugs fixed relative to the PHP parser.
// Run: npm test   (after npm run build)
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSchedule } = require('../dist/ical/ICal.js');

const cal = (...events) =>
	['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flat(), 'END:VCALENDAR'].join('\r\n') + '\r\n';
const ev = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const day = (ics, date, opts = {}) =>
	buildSchedule(ics, { timeZone: 'America/New_York', startDate: date, days: 1, skipCancelled: true, ...opts }).get(date);
const titles = (list) => list.map((e) => `${e.start} ${e.title}`);

test('TZID: event defined in another zone is converted', () => {
	const ics = cal(ev('UID:a', 'SUMMARY:Berlin call', 'DTSTART;TZID=Europe/Berlin:20261013T150000', 'DTEND;TZID=Europe/Berlin:20261013T160000'));
	assert.deepEqual(titles(day(ics, '2026-10-13')), ['09:00 Berlin call']);
	assert.deepEqual(titles(day(ics, '2026-10-13', { phpCompat: true })), ['15:00 Berlin call']); // PHP bug
});

test('EXDATE: comma-separated lists are all honoured', () => {
	const ics = cal(ev('UID:b', 'SUMMARY:Standup', 'DTSTART;TZID=America/New_York:20261005T090000', 'DTEND;TZID=America/New_York:20261005T091500',
		'RRULE:FREQ=DAILY', 'EXDATE;TZID=America/New_York:20261012T090000,20261013T090000'));
	assert.deepEqual(day(ics, '2026-10-13'), []);
	assert.deepEqual(titles(day(ics, '2026-10-13', { phpCompat: true })), ['09:00 Standup']); // PHP bug
	assert.deepEqual(titles(day(ics, '2026-10-14')), ['09:00 Standup']);
});

test('Open-ended rules: a daily series started long ago still shows up', () => {
	const ics = cal(ev('UID:c', 'SUMMARY:Meds', 'DTSTART;TZID=America/New_York:20220101T080000', 'DTEND;TZID=America/New_York:20220101T081000', 'RRULE:FREQ=DAILY'));
	assert.deepEqual(titles(day(ics, '2026-10-13')), ['08:00 Meds']);
	assert.deepEqual(day(ics, '2026-10-13', { phpCompat: true }), []); // PHP stops after 500 days
});

test('UNTIL is inclusive (Apple/Outlook put UNTIL on the last start time)', () => {
	const ics = cal(ev('UID:d', 'SUMMARY:Class', 'DTSTART;TZID=America/New_York:20260915T180000', 'DTEND;TZID=America/New_York:20260915T190000',
		'RRULE:FREQ=DAILY;INTERVAL=7;UNTIL=20261013T220000Z'));
	assert.deepEqual(titles(day(ics, '2026-10-13')), ['18:00 Class']);
	assert.deepEqual(day(ics, '2026-10-20'), []);
	assert.deepEqual(day(ics, '2026-10-13', { phpCompat: true }), []); // PHP drops the last one
});

test('Moved instance: moving Tuesday to Wednesday removes Tuesday', () => {
	const ics = cal(
		ev('UID:e', 'SUMMARY:Review', 'DTSTART;TZID=America/New_York:20260707T110000', 'DTEND;TZID=America/New_York:20260707T120000', 'RRULE:FREQ=WEEKLY;BYDAY=TU'),
		ev('UID:e', 'SUMMARY:Review (moved)', 'RECURRENCE-ID;TZID=America/New_York:20261013T110000',
			'DTSTART;TZID=America/New_York:20261014T140000', 'DTEND;TZID=America/New_York:20261014T150000'),
	);
	assert.deepEqual(day(ics, '2026-10-13'), []);
	assert.deepEqual(titles(day(ics, '2026-10-14')), ['14:00 Review (moved)']);
	assert.deepEqual(titles(day(ics, '2026-10-13', { phpCompat: true })), ['11:00 Review']); // PHP shows both
});

test('All-day recurring event on the DST change day stays all-day', () => {
	const ics = cal(ev('UID:f', 'SUMMARY:Trash day', 'DTSTART;VALUE=DATE:20260104', 'DTEND;VALUE=DATE:20260105', 'RRULE:FREQ=WEEKLY'));
	const out = day(ics, '2026-11-01');
	assert.equal(out.length, 1);
	assert.equal(out[0].fullday, true);
	assert.equal(day(ics, '2026-11-01', { phpCompat: true })[0].fullday, false); // PHP: 00:00-23:00
});

test('Timed event crossing DST keeps its real duration (matches PHP)', () => {
	const ics = cal(ev('UID:g', 'SUMMARY:Night shift', 'DTSTART;TZID=America/New_York:20261003T190000', 'DTEND;TZID=America/New_York:20261004T050000', 'RRULE:FREQ=WEEKLY'));
	const fixed = day(ics, '2026-10-31')[0];
	const php = day(ics, '2026-10-31', { phpCompat: true })[0];
	assert.deepEqual([fixed.start, fixed.end], [php.start, php.end]);
	assert.deepEqual([fixed.start, fixed.end], ['19:00', '04:00']);
});

test('Monthly "last Friday" does not skip months', () => {
	const ics = cal(ev('UID:h', 'SUMMARY:Payroll', 'DTSTART;VALUE=DATE:20260130', 'DTEND;VALUE=DATE:20260131', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR'));
	for (const d of ['2026-02-27', '2026-03-27', '2026-04-24', '2026-05-29', '2026-06-26', '2026-07-31', '2026-10-30']) {
		assert.equal(day(ics, d).length, 1, d);
	}
});

test('Text: LF-only folding, tab folding and escapes', () => {
	const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:i', 'SUMMARY:Lunch with Smith\\, Jones', ' and Co.', 'LOCATION:Cafe\\; back room',
		'DTSTART;TZID=America/New_York:20261013T120000', 'DTEND;TZID=America/New_York:20261013T130000', 'END:VEVENT', 'END:VCALENDAR'].join('\n');
	const [e] = day(ics, '2026-10-13');
	assert.equal(e.title, 'Lunch with Smith, Jonesand Co.');
	assert.equal(e.location, 'Cafe; back room');
});

test('Missing DTEND: all-day lasts one day, timed is zero-length', () => {
	const ics = cal(
		ev('UID:j', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20261013'),
		ev('UID:k', 'SUMMARY:Reminder', 'DTSTART;TZID=America/New_York:20261013T100000'),
	);
	assert.deepEqual(day(ics, '2026-10-13').map((e) => [e.title, e.fullday, e.start, e.end]), [
		['Holiday', true, '2026-10-13', '2026-10-14'],
		['Reminder', false, '10:00', '10:00'],
	]);
	assert.deepEqual(day(ics, '2026-10-14'), []);
});

test('Cancelled events are skipped (configurable)', () => {
	const ics = cal(ev('UID:l', 'SUMMARY:Off', 'STATUS:CANCELLED', 'DTSTART;TZID=America/New_York:20261013T100000', 'DTEND;TZID=America/New_York:20261013T110000'));
	assert.deepEqual(day(ics, '2026-10-13'), []);
	assert.equal(day(ics, '2026-10-13', { skipCancelled: false }).length, 1);
});

test('Default "today" uses the time zone, not the server clock', () => {
	const ics = cal(ev('UID:m', 'SUMMARY:Late', 'DTSTART:20261014T023000Z', 'DTEND:20261014T030000Z'));
	// 2026-10-14 01:00 UTC is still Oct 13 in New York
	const m = buildSchedule(ics, { timeZone: 'America/New_York', days: 1, now: new Date('2026-10-14T01:00:00Z') });
	assert.deepEqual([...m.keys()], ['2026-10-13']);
	assert.deepEqual(titles(m.get('2026-10-13')), ['22:30 Late']);
});
