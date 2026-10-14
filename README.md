# n8n-nodes-ical-schedule

An n8n community node that reads an iCal (.ics) feed and returns the appointments for **today**, **tomorrow**, the **next N days**, or a custom range. Its output includes a sentence ready to be read aloud, which makes it a drop-in back end for an ElevenLabs agent tool.

The parser is a TypeScript port of the PHP iCal parser used by [trmnl-calendar](https://github.com/zoltanhosszu/trmnl-calendar/tree/main/server). That parser is itself based on [seebz's gist](https://gist.github.com/seebz/c00a38d9520e035a6a8c). The port also includes the day grouping from trmnl-calendar's `index.php`. It has **no runtime dependencies**.


## Using it

| Parameter | Notes |
|---|---|
| **Source** | *Feed URL* (https:// or webcal://) or *iCal Text* from an earlier node (defaults to `{{ $json.data }}`). |
| **Range** | Today · Tomorrow · Next X Days · Custom (start date + days). |
| **Output** | *Summary* (one item, ready for a voice agent) · *One Item per Day* (trmnl-calendar shape) · *One Item per Event*. |
| Options → **Time Zone** | Decides what "today" is and how times are shown. Empty = the workflow's time zone. |
| Options → Include All-Day Events, Skip Cancelled Events, Include Descriptions, Time Format (12h/24h) | |
| Options → **Timeout (ms)** | How long to wait for the feed (default 15000). For a feed that is sometimes slow, set a short timeout (e.g. 5000) and turn on Settings → Retry On Fail. |
| Options → **Match Original PHP Output Exactly** | Turns off every bug fix listed below. Only for comparing results. |

Summary output for "Today":

```json
{
  "timeZone": "America/New_York",
  "startDate": "2026-10-13",
  "days": 1,
  "count": 3,
  "date": "2026-10-13",
  "label": "today, Tuesday, October 13",
  "events": [
    { "title": "Weekly standup", "allDay": false, "time": "9:00 AM", "endTime": "9:30 AM",
      "start": "2026-10-13T09:00:00-04:00", "end": "2026-10-13T09:30:00-04:00", "uid": "..." }
  ],
  "summary": "3 appointments today, Tuesday, October 13: 9:00 AM, Weekly standup; 2:30 PM, Smith consult; 4:00 PM, Weekly review. All day: Office closed."
}
```

`count` is the number of timed appointments. All-day events are listed, but they aren't counted.

## ElevenLabs hookup

1. Import `examples/elevenlabs-todays-appointments.workflow.json` (Webhook → iCal Schedule → Respond to Webhook).
2. Webhook node: create a **Header Auth** credential, e.g. `X-Api-Key` with a long random value.
3. iCal Schedule node: paste your secret iCal URL and check the time zone.
4. Activate (publish) the workflow and copy the production URL.
5. In ElevenLabs, add a **server tool (webhook)**:
   - Name: `get_todays_appointments`
   - Method: POST; URL: the production URL
   - Header: `X-Api-Key` = an ElevenLabs secret (`{{secret__...}}`)
   - Description: "Returns today's appointments. Call it when the caller asks what's on the schedule today, whether a time is free today, or what's next."
6. System prompt: *"When asked about today's schedule, call get_todays_appointments and say the `summary` naturally. Don't read out JSON or end times unless asked."*

You can also use the same workflow to pre-load the schedule before a call starts and pass `summary` in as a dynamic variable.

## Fidelity to the PHP parser

The port follows `ical.php` method by method, and `index.php`'s getEvents for the day grouping. With **Match Original PHP Output Exactly** on, it was checked against the real PHP (PHP 8.3) on:

- the hand-written edge-case calendars
- 80 randomly generated calendars covering daily, weekly with BYDAY and INTERVAL, monthly BYDAY like `2TU`/`-1FR`, BYMONTHDAY, yearly, COUNT, UNTIL, EXDATE, same-day RECURRENCE-ID overrides, UTC and floating times, all-day and multi-day events
- 4 time zones and every day from Jan 2026 to Jan 2027

Result: 31,680 day checks and 58,240 event placements, all identical. Re-run it with `npm run test:parity` (needs php-cli; it downloads `ical.php` itself).

### Bugs fixed by default

Each of these was confirmed in the original PHP. Each is a no-op for calendars the PHP already handled correctly.

| # | PHP behaviour | Fixed behaviour |
|---|---|---|
| 1 | `TZID` ignored: a 3 PM Berlin event shows at 3 PM in New York. | Converted to your time zone (9 AM). |
| 2 | `EXDATE:a,b` only skips the first date. | All listed dates are skipped. |
| 3 | Never-ending rules stop after 500 occurrences (a daily series started more than 500 days ago disappears). | Expanded up to the requested range. |
| 4 | `UNTIL` is exclusive and compared against midnight, so the last instance is dropped or an extra one appears. | Inclusive, compared against the real start time (RFC 5545). |
| 5 | An instance moved to a **different** day also still shows on its original day. | The original slot is removed. |
| 6 | A recurring all-day event on a DST-change day becomes a "00:00–23:00" timed event, and multi-day all-day events lose their last day across DST. | Stays all-day. Timed events keep their real elapsed duration, as in PHP. |
| 7 | Monthly "last Friday"-style rules skip a month after a 29th–31st. | No skipped months. |
| 8 | Lines folded with LF-only or tabs aren't unfolded, and `\,` `\;` `\n` aren't unescaped. | Unfolded and unescaped. |
| 9 | No `DTEND` produces garbage dates. | All-day lasts one day; timed is zero-length. |
| 10 | `STATUS:CANCELLED` events are listed. | Skipped (an option). |

### Still not supported (same as the PHP)

These rule parts are not supported: `BYSETPOS`, yearly `BYMONTH`/`BYDAY` rules (e.g. "4th Thursday of November"), `HOURLY` and finer frequencies, `RDATE`, `WKST` (weeks start Monday), and `DURATION` instead of `DTEND`.

A timed event spanning several days is shown as all-day on each day except the last, exactly as trmnl-calendar does.

## Development

```bash
npm install
npm test               # build + targeted tests for each fix
npm run test:parity    # bug-for-bug comparison with the PHP original
npm pack               # produces the .tgz for Option B
```

## License

The parser is a derivative of `ical.php` from trmnl-calendar and seebz's gist. Neither states a license, so `package.json` says `UNLICENSED` for now. Before publishing publicly (Option A), check with those authors or keep the package private. Option B and a private registry are unaffected.
