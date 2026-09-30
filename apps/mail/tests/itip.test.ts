import { simpleParser } from 'mailparser'
import { describe, expect, it } from 'vitest'
import { parseComponents } from '../src/main/pim/contentline'
import { parseIcs } from '../src/main/pim/ics'
import {
  applyPartstat,
  applyReply,
  buildReply,
  extractInvitation,
  stripMethod,
} from '../src/main/pim/itip'
import type { Invitation } from '../src/shared/pim'

process.env.TZ = 'Europe/Berlin'

const crlf = (lines: string[]): string => lines.join('\r\n') + '\r\n'
const b64 = (text: string, width = 76): string =>
  (
    Buffer.from(text, 'utf8')
      .toString('base64')
      .match(new RegExp(`.{1,${width}}`, 'g')) ?? []
  ).join('\r\n')

// ---- fixtures ----

const OUTLOOK_ICS = crlf([
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'PRODID:Microsoft Exchange Server 2010',
  'VERSION:2.0',
  'BEGIN:VTIMEZONE',
  'TZID:W. Europe Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16010101T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'ORGANIZER;CN="Schmidt, Anna":mailto:Anna.Schmidt@firma.de',
  'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN="Müller, Hans":',
  ' mailto:Hans.Mueller@firma.de',
  'ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Ben Weber:mai',
  ' lto:ben@firma.de',
  'ATTENDEE;CUTYPE=RESOURCE;ROLE=NON-PARTICIPANT;CN=Raum 4.12:mailto:raum412@fir',
  ' ma.de',
  'DESCRIPTION;LANGUAGE=de-DE:Hallo zusammen\\,\\n\\nwir besprechen den Stand. Bi',
  ' tte Unterlagen mitbringen.\\n',
  'UID:040000008200E00074C5B7101A82E00800000000A0B1C2D3E4F5A601000000000000000010',
  ' 000000F1E2D3C4B5A69788',
  'SUMMARY;LANGUAGE=de-DE:Projektstatus Q4',
  'DTSTART;TZID=W. Europe Standard Time:20261015T140000',
  'DTEND;TZID=W. Europe Standard Time:20261015T153000',
  'RRULE:FREQ=WEEKLY;UNTIL=20261210T130000Z;INTERVAL=1;BYDAY=TH;WKST=MO',
  'CLASS:PUBLIC',
  'PRIORITY:5',
  'DTSTAMP:20260930T081500Z',
  'TRANSP:OPAQUE',
  'STATUS:CONFIRMED',
  'SEQUENCE:2',
  'LOCATION;LANGUAGE=de-DE:Raum 4.12',
  'X-MICROSOFT-CDO-APPT-SEQUENCE:2',
  'X-MICROSOFT-CDO-OWNERAPPTID:2123456789',
  'X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE',
  'X-MICROSOFT-CDO-INTENDEDSTATUS:BUSY',
  'X-MICROSOFT-CDO-ALLDAYEVENT:FALSE',
  'X-MICROSOFT-CDO-IMPORTANCE:1',
  'X-MICROSOFT-CDO-INSTTYPE:1',
  'X-MICROSOFT-DONOTFORWARDMEETING:FALSE',
  'X-MICROSOFT-DISALLOW-COUNTER:FALSE',
  'BEGIN:VALARM',
  'DESCRIPTION:REMINDER',
  'TRIGGER;RELATED=START:-PT15M',
  'ACTION:DISPLAY',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
])

const OUTLOOK_UID =
  '040000008200E00074C5B7101A82E00800000000A0B1C2D3E4F5A601000000000000000010000000F1E2D3C4B5A69788'

const OUTLOOK_MAIL = crlf([
  'From: "Schmidt, Anna" <Anna.Schmidt@firma.de>',
  'To: "Müller, Hans" <Hans.Mueller@firma.de>, Ben Weber <ben@firma.de>',
  'Subject: Projektstatus Q4',
  'Date: Wed, 30 Sep 2026 10:15:00 +0200',
  'Message-ID: <DB9PR01MB1234@eurprd01.prod.exchangelabs.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="_000_outlook_"',
  '',
  '--_000_outlook_',
  'Content-Type: text/plain; charset="utf-8"',
  'Content-Transfer-Encoding: base64',
  '',
  b64('Hallo zusammen,\r\n\r\nwir besprechen den Stand.\r\n'),
  '',
  '--_000_outlook_',
  'Content-Type: text/html; charset="utf-8"',
  'Content-Transfer-Encoding: base64',
  '',
  b64('<html><body><p>Hallo zusammen,</p></body></html>'),
  '',
  '--_000_outlook_',
  'Content-Type: text/calendar; charset="utf-8"; method=REQUEST',
  'Content-Transfer-Encoding: base64',
  '',
  b64(OUTLOOK_ICS),
  '',
  '--_000_outlook_--',
])

const GOOGLE_ICS = crlf([
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'CALSCALE:GREGORIAN',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'DTSTART:20261020T080000Z',
  'DTEND:20261020T090000Z',
  'DTSTAMP:20260930T120000Z',
  'ORGANIZER;CN=Lisa Park:mailto:lisa.park@gmail.com',
  'UID:4k2j3h4g5f6d7s8a9@google.com',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE',
  ' ;CN=Lisa Park;X-NUM-GUESTS=0:mailto:lisa.park@gmail.com',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=',
  ' TRUE;CN=me@posteo.de;X-NUM-GUESTS=0:mailto:ME@posteo.de',
  'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij',
  'CREATED:20260930T115900Z',
  'DESCRIPTION:Kurzer Abgleich.\\n\\n-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~',
  ' :~:~:~:~:~:~:~:~::~:~::-\\nJoin with Google Meet: https://meet.google.com/abc',
  ' -defg-hij',
  'LAST-MODIFIED:20260930T120000Z',
  'LOCATION:',
  'SEQUENCE:0',
  'STATUS:CONFIRMED',
  'SUMMARY:Abgleich Website',
  'TRANSP:OPAQUE',
  'BEGIN:VALARM',
  'ACTION:EMAIL',
  'DESCRIPTION:This is an event reminder',
  'SUMMARY:Alarm notification',
  'ATTENDEE:mailto:me@posteo.de',
  'TRIGGER:-P0DT0H30M0S',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
])

const GOOGLE_MAIL = crlf([
  'From: Lisa Park <lisa.park@gmail.com>',
  'To: me@posteo.de',
  'Subject: Einladung: Abgleich Website - Di., 20. Okt. 2026 10:00 - 11:00 (MESZ)',
  'Date: Wed, 30 Sep 2026 14:00:00 +0200',
  'Message-ID: <calendar-1234@google.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="000000000000mixed"',
  '',
  '--000000000000mixed',
  'Content-Type: multipart/alternative; boundary="000000000000alt"',
  '',
  '--000000000000alt',
  'Content-Type: text/plain; charset="UTF-8"; format=flowed; delsp=yes',
  'Content-Transfer-Encoding: base64',
  '',
  b64('Sie wurden zu folgendem Termin eingeladen.\r\n'),
  '--000000000000alt',
  'Content-Type: text/html; charset="UTF-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<p>Sie wurden eingeladen.</p>',
  '--000000000000alt',
  'Content-Type: text/calendar; charset="UTF-8"; method=REQUEST',
  'Content-Transfer-Encoding: 7bit',
  '',
  GOOGLE_ICS,
  '--000000000000alt--',
  '',
  '--000000000000mixed',
  'Content-Type: application/ics; name="invite.ics"',
  'Content-Disposition: attachment; filename="invite.ics"',
  'Content-Transfer-Encoding: base64',
  '',
  b64(GOOGLE_ICS),
  '--000000000000mixed--',
])

const APPLE_ICS = crlf([
  'BEGIN:VCALENDAR',
  'CALSCALE:GREGORIAN',
  'VERSION:2.0',
  'PRODID:-//Apple Inc.//macOS 15.0//EN',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'TRANSP:TRANSPARENT',
  'DTEND;VALUE=DATE:20261103',
  'UID:6F1B3E2A-9C4D-4E8F-A1B2-C3D4E5F60718',
  'DTSTAMP:20260930T100000Z',
  'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
  'SEQUENCE:0',
  'SUMMARY:Betriebsausflug',
  'DTSTART;VALUE=DATE:20261102',
  'X-APPLE-CREATOR-IDENTITY:com.apple.mobilecal',
  'CREATED:20260930T095900Z',
  'ORGANIZER;CN="Jörg Köhler";EMAIL="joerg@icloud.com":mailto:joerg@icloud.com',
  'ATTENDEE;CN="Jörg Köhler";CUTYPE=INDIVIDUAL;EMAIL="joerg@icloud.com";PARTS',
  ' TAT=ACCEPTED;ROLE=CHAIR:mailto:joerg@icloud.com',
  'ATTENDEE;CN="me@posteo.de";CUTYPE=INDIVIDUAL;EMAIL="me@posteo.de";PARTSTAT',
  ' =NEEDS-ACTION;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:me@posteo.de',
  'END:VEVENT',
  'END:VCALENDAR',
])

const APPLE_MAIL = crlf([
  'From: =?utf-8?Q?J=C3=B6rg_K=C3=B6hler?= <joerg@icloud.com>',
  'To: me@posteo.de',
  'Subject: Einladung: Betriebsausflug',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="Apple-Mail=_1"',
  '',
  '--Apple-Mail=_1',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Einladung von J=C3=B6rg',
  '--Apple-Mail=_1',
  'Content-Type: text/calendar; charset=utf-8; method=REQUEST; name="iCal-20260930-100000.ics"',
  'Content-Disposition: attachment; filename="iCal-20260930-100000.ics"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  // quoted-printable with soft line breaks and encoded umlauts
  APPLE_ICS.replace(/=/g, '=3D').replace(/ö/g, '=C3=B6').replace(/\r\n/g, '=0D=0A=\r\n'),
  '--Apple-Mail=_1--',
])

const CANCEL_ICS = crlf([
  'BEGIN:VCALENDAR',
  'METHOD:CANCEL',
  'PRODID:Microsoft Exchange Server 2010',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'ORGANIZER;CN="Schmidt, Anna":mailto:Anna.Schmidt@firma.de',
  'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN="Müller, Hans":mailto:Hans.Mueller@firma.de',
  `UID:${OUTLOOK_UID}`,
  'RECURRENCE-ID:20261029T130000Z',
  'SUMMARY;LANGUAGE=de-DE:Abgesagt: Projektstatus Q4',
  'DTSTART:20261029T130000Z',
  'DTEND:20261029T143000Z',
  'DTSTAMP:20261001T090000Z',
  'STATUS:CANCELLED',
  'SEQUENCE:3',
  'END:VEVENT',
  'END:VCALENDAR',
])

const REPLY_ICS = crlf([
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'CALSCALE:GREGORIAN',
  'METHOD:REPLY',
  'BEGIN:VEVENT',
  'DTSTART:20261020T080000Z',
  'DTEND:20261020T090000Z',
  'DTSTAMP:20261001T070000Z',
  'ORGANIZER;CN=me@posteo.de:mailto:me@posteo.de',
  'UID:suite-7f3e2b1a@suite-office',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=DECLINED;CN=Lisa Pa',
  ' rk;X-NUM-GUESTS=0:mailto:lisa.park@gmail.com',
  'SEQUENCE:1',
  'SUMMARY:Abgleich Website',
  'END:VEVENT',
  'END:VCALENDAR',
])

/** the organizer's own stored copy of the meeting the REPLY answers */
const STORED_ORGANIZED = crlf([
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Suite Office//DE',
  'BEGIN:VEVENT',
  'UID:suite-7f3e2b1a@suite-office',
  'DTSTAMP:20260930T100000Z',
  'SEQUENCE:1',
  'SUMMARY:Abgleich Website',
  'DTSTART;TZID=Europe/Berlin:20261020T100000',
  'DTEND;TZID=Europe/Berlin:20261020T110000',
  'ORGANIZER;CN=Ich;SCHEDULE-AGENT=CLIENT:mailto:me@posteo.de',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Lisa Park;SCHEDULE-AGENT=CLIENT:mailto:Lisa.Park@gmail.com',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN="Weber, Ben";SCHEDULE-AGENT=CLIENT:mailto:ben@firma.de',
  'X-SUITE-NOTE:keep me',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:Erinnerung',
  'TRIGGER:-PT15M',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
])

function eventLines(
  ics: string,
): Array<{ name: string; value: string; params: Record<string, string[]> }> {
  const root = parseComponents(ics)[0]!
  const ev = root.children.find((c) => c.name === 'VEVENT')!
  return ev.props
}

function attendeeParams(ics: string, email: string): Record<string, string[]> | undefined {
  return eventLines(ics).find(
    (p) => p.name === 'ATTENDEE' && p.value.toLowerCase() === `mailto:${email.toLowerCase()}`,
  )?.params
}

// ---- extractInvitation ----

describe('extractInvitation', () => {
  it('reads an Outlook/Exchange invitation with a Windows zone', async () => {
    const parsed = await simpleParser(OUTLOOK_MAIL)
    const inv = extractInvitation(parsed)!
    expect(inv).toBeDefined()
    expect(inv.method).toBe('REQUEST')
    expect(inv.uid).toBe(OUTLOOK_UID)
    expect(inv.sequence).toBe(2)
    expect(inv.title).toBe('Projektstatus Q4')
    expect(inv.location).toBe('Raum 4.12')
    expect(inv.description).toContain('Hallo zusammen,\n\nwir besprechen')
    // 14:00 Berlin summer time
    expect(inv.start).toBe('2026-10-15T12:00:00.000Z')
    expect(inv.end).toBe('2026-10-15T13:30:00.000Z')
    expect(inv.allDay).toBe(false)
    expect(inv.rrule).toContain('FREQ=WEEKLY')
    expect(inv.organizer).toEqual({ name: 'Schmidt, Anna', email: 'Anna.Schmidt@firma.de' })
    expect(inv.attendees).toEqual([
      { name: 'Müller, Hans', email: 'Hans.Mueller@firma.de', status: 'needs-action' },
      { name: 'Ben Weber', email: 'ben@firma.de', status: 'needs-action', optional: true },
      { name: 'Raum 4.12', email: 'raum412@firma.de', status: 'needs-action' },
    ])
    expect(inv.replyStatus).toBeUndefined()
    expect(inv.existingEventId).toBeUndefined()
    expect(inv.ics).toBe(OUTLOOK_ICS)
  })

  it('reads a Google invitation and asks the calendar whether it is known', async () => {
    const parsed = await simpleParser(GOOGLE_MAIL)
    const asked: string[] = []
    const inv = extractInvitation(parsed, (uid) => {
      asked.push(uid)
      return 'caldav1:/calendars/me/work/'
    })!
    expect(asked).toEqual(['4k2j3h4g5f6d7s8a9@google.com'])
    expect(inv.existingEventId).toBe('caldav1:/calendars/me/work/')
    expect(inv.method).toBe('REQUEST')
    expect(inv.start).toBe('2026-10-20T08:00:00.000Z')
    expect(inv.end).toBe('2026-10-20T09:00:00.000Z')
    expect(inv.location).toBe('')
    expect(inv.organizer?.email).toBe('lisa.park@gmail.com')
    expect(inv.attendees.map((a) => [a.email, a.status])).toEqual([
      ['lisa.park@gmail.com', 'accepted'],
      ['ME@posteo.de', 'needs-action'],
    ])
  })

  it('reads an Apple all-day invitation sent as a quoted-printable attachment', async () => {
    const inv = extractInvitation(await simpleParser(APPLE_MAIL))!
    expect(inv.allDay).toBe(true)
    expect(inv.start).toBe('2026-11-02')
    expect(inv.end).toBe('2026-11-03')
    expect(inv.organizer).toEqual({ name: 'Jörg Köhler', email: 'joerg@icloud.com' })
    expect(inv.attendees[1]).toEqual({
      name: 'me@posteo.de',
      email: 'me@posteo.de',
      status: 'needs-action',
    })
    expect(inv.ics).toContain('Jörg Köhler')
  })

  it('reads a cancellation of one occurrence', async () => {
    const mail = crlf([
      'From: Anna.Schmidt@firma.de',
      'To: Hans.Mueller@firma.de',
      'Subject: Abgesagt: Projektstatus Q4',
      'MIME-Version: 1.0',
      'Content-Type: text/calendar; charset="utf-8"; method=CANCEL',
      'Content-Transfer-Encoding: 8bit',
      '',
      CANCEL_ICS,
    ])
    const inv = extractInvitation(await simpleParser(mail))!
    expect(inv.method).toBe('CANCEL')
    expect(inv.uid).toBe(OUTLOOK_UID)
    expect(inv.sequence).toBe(3)
    expect(inv.start).toBe('2026-10-29T13:00:00.000Z')
    expect(inv.rrule).toBeUndefined()
  })

  it("reads a REPLY and reports the replying attendee's answer", async () => {
    const mail = crlf([
      'From: Lisa Park <lisa.park@gmail.com>',
      'To: me@posteo.de',
      'Subject: Abgelehnt: Abgleich Website',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="b"',
      '',
      '--b',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'Lisa Park hat abgelehnt.',
      '--b',
      'Content-Type: text/calendar; charset=UTF-8; method=REPLY',
      '',
      REPLY_ICS,
      '--b--',
    ])
    const inv = extractInvitation(await simpleParser(mail), () => 'local:default')!
    expect(inv.method).toBe('REPLY')
    expect(inv.replyStatus).toBe('declined')
    expect(inv.existingEventId).toBe('local:default')
  })

  it('takes the METHOD from the content type when the file has none, and decodes Windows-1252', async () => {
    const ics = crlf([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:legacy-1',
      'DTSTART:20261105T090000Z',
      'SUMMARY:Übergabe',
      'ORGANIZER:mailto:a@b.de',
      'END:VEVENT',
      'END:VCALENDAR',
    ])
    const mail = Buffer.concat([
      Buffer.from(
        crlf([
          'From: a@b.de',
          'To: c@d.de',
          'Subject: x',
          'MIME-Version: 1.0',
          'Content-Type: text/calendar; charset=windows-1252; method=REQUEST',
          'Content-Transfer-Encoding: 8bit',
          '',
          '',
        ]),
      ),
      Buffer.from(ics, 'latin1'),
    ])
    const inv = extractInvitation(await simpleParser(mail))!
    expect(inv.method).toBe('REQUEST')
    expect(inv.title).toBe('Übergabe')
    // DTSTART without DTEND: a timed event lasts no time
    expect(inv.end).toBe(inv.start)
  })

  it('ignores mails without a usable calendar part', async () => {
    const plain = await simpleParser('From: a@b.de\r\nSubject: hi\r\n\r\nhello\r\n')
    expect(extractInvitation(plain)).toBeUndefined()
    const garbage = await simpleParser(
      crlf([
        'From: a@b.de',
        'MIME-Version: 1.0',
        'Content-Type: text/calendar; method=REQUEST',
        '',
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'DTSTART:not a date',
        'END:VCALENDAR',
      ]),
    )
    expect(() => extractInvitation(garbage)).not.toThrow()
    expect(extractInvitation(garbage)).toBeUndefined()
    // a whole calendar exported as .ics is not a meeting message
    const exported = crlf([
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:a',
      'DTSTART:20261001T080000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:b',
      'DTSTART:20261002T080000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ])
    const many = await simpleParser(
      crlf(['From: a@b.de', 'MIME-Version: 1.0', 'Content-Type: text/calendar', '', exported]),
    )
    expect(extractInvitation(many)).toBeUndefined()
  })

  it('survives a lookup that throws', async () => {
    const inv = extractInvitation(await simpleParser(GOOGLE_MAIL), () => {
      throw new Error('store not ready')
    })
    expect(inv?.uid).toBe('4k2j3h4g5f6d7s8a9@google.com')
    expect(inv?.existingEventId).toBeUndefined()
  })
})

// ---- buildReply ----

describe('buildReply', () => {
  const outlookInvitation = async (): Promise<Invitation> =>
    extractInvitation(await simpleParser(OUTLOOK_MAIL))!

  it('answers an Outlook invitation with the times and zone as received', async () => {
    const inv = await outlookInvitation()
    const reply = buildReply(
      inv,
      { name: 'Hans Müller', email: 'hans.mueller@FIRMA.de' },
      'accepted',
    )
    expect(reply.subject).toBe('Zugesagt: Projektstatus Q4')
    expect(reply.text).toContain('Hans Müller hat die Einladung angenommen.')
    expect(reply.text).toContain('Projektstatus Q4')

    const parsed = parseIcs(reply.ics)
    expect(parsed.method).toBe('REPLY')
    expect(parsed.events).toHaveLength(1)
    const ev = parsed.events[0]!
    expect(ev.uid).toBe(OUTLOOK_UID)
    expect(ev.sequence).toBe(2)
    expect(ev.summary).toBe('Projektstatus Q4')
    expect(ev.attendees).toHaveLength(1)
    expect(ev.attendees[0]).toMatchObject({
      name: 'Müller, Hans',
      email: 'Hans.Mueller@firma.de',
      partstat: 'ACCEPTED',
    })
    expect(ev.organizer).toEqual({ name: 'Schmidt, Anna', email: 'Anna.Schmidt@firma.de' })
    expect(reply.ics).toContain('DTSTART;TZID=W. Europe Standard Time:20261015T140000')
    expect(reply.ics).toContain('BEGIN:VTIMEZONE\r\nTZID:W. Europe Standard Time')
    const vevent = reply.ics.slice(reply.ics.indexOf('BEGIN:VEVENT'))
    expect(vevent).not.toMatch(/RSVP|VALARM|X-MICROSOFT|RRULE|DESCRIPTION/)
    expect(reply.ics).toMatch(/\r\nDTSTAMP:\d{8}T\d{6}Z\r\n/)
    // a CN with a comma stays one parameter
    expect(reply.ics.replace(/\r\n /g, '')).toContain('CN="Müller, Hans"')
    // every line folded to 75 octets
    for (const line of reply.ics.split('\r\n')) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75)
    }
  })

  it('replies as the user even when the invitation came through a list, in English', async () => {
    const inv = await outlookInvitation()
    const reply = buildReply(inv, { name: 'Team Lead', email: 'lead@firma.de' }, 'tentative', 'en')
    expect(reply.subject).toBe('Tentative: Projektstatus Q4')
    expect(reply.text).toContain('Team Lead has tentatively accepted the invitation.')
    const ev = parseIcs(reply.ics).events[0]!
    expect(ev.attendees).toEqual([
      {
        name: 'Team Lead',
        email: 'lead@firma.de',
        partstat: 'TENTATIVE',
        role: 'REQ-PARTICIPANT',
        rsvp: false,
      },
    ])
  })

  it('declines a Google invitation (UTC times, no VTIMEZONE needed)', async () => {
    const inv = extractInvitation(await simpleParser(GOOGLE_MAIL))!
    const reply = buildReply(inv, { name: '', email: 'me@posteo.de' }, 'declined')
    expect(reply.subject).toBe('Abgelehnt: Abgleich Website')
    expect(reply.text).toContain('me@posteo.de hat die Einladung abgelehnt.')
    expect(reply.ics).not.toContain('VTIMEZONE')
    expect(reply.ics).toContain('DTSTART:20261020T080000Z')
    const params = attendeeParams(reply.ics, 'ME@posteo.de')!
    expect(params.PARTSTAT).toEqual(['DECLINED'])
    expect(params['X-NUM-GUESTS']).toEqual(['0'])
    expect(params.RSVP).toBeUndefined()
  })

  it('names the occurrence (RECURRENCE-ID) when only one instance was sent', () => {
    const inv: Invitation = {
      method: 'REQUEST',
      uid: OUTLOOK_UID,
      sequence: 3,
      title: 'Projektstatus Q4',
      location: '',
      description: '',
      start: '2026-10-29T13:00:00.000Z',
      end: '2026-10-29T14:30:00.000Z',
      allDay: false,
      attendees: [],
      ics: CANCEL_ICS.replace('METHOD:CANCEL', 'METHOD:REQUEST'),
    }
    const reply = buildReply(inv, { name: 'Hans', email: 'hans.mueller@firma.de' }, 'accepted')
    expect(reply.ics).toContain('RECURRENCE-ID:20261029T130000Z')
    expect(parseIcs(reply.ics).events[0]!.sequence).toBe(3)
  })

  it('generates a VTIMEZONE when the invitation did not carry one', () => {
    const ics = crlf([
      'BEGIN:VCALENDAR',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:tz-1',
      'DTSTART;TZID=Europe/Berlin:20261201T090000',
      'DTEND;TZID=Europe/Berlin:20261201T100000',
      'ORGANIZER:mailto:o@x.de',
      'ATTENDEE:mailto:me@x.de',
      'END:VEVENT',
      'END:VCALENDAR',
    ])
    const inv = extractInvitation({ attachments: [calPart(ics)] } as never)!
    const reply = buildReply(inv, { name: 'Me', email: 'me@x.de' }, 'accepted')
    expect(reply.ics).toContain('BEGIN:VTIMEZONE\r\nTZID:Europe/Berlin')
  })

  it('falls back to the card data when the stored text is broken', () => {
    const inv: Invitation = {
      method: 'REQUEST',
      uid: 'broken-1',
      sequence: 1,
      title: 'Kaputt',
      location: '',
      description: '',
      start: '2026-10-01',
      end: '2026-10-02',
      allDay: true,
      organizer: { name: 'Org', email: 'org@x.de' },
      attendees: [],
      ics: 'nonsense',
    }
    const reply = buildReply(inv, { name: 'Me', email: 'me@x.de' }, 'accepted')
    const ev = parseIcs(reply.ics).events[0]!
    expect(ev.uid).toBe('broken-1')
    expect(ev.start).toEqual({ kind: 'date', date: '2026-10-01' })
    expect(ev.organizer?.email).toBe('org@x.de')
    expect(ev.attendees[0]?.partstat).toBe('ACCEPTED')
  })
})

function calPart(ics: string): unknown {
  return {
    contentType: 'text/calendar',
    headers: new Map([['content-type', { value: 'text/calendar', params: { method: 'REQUEST' } }]]),
    content: Buffer.from(ics, 'utf8'),
  }
}

// ---- storing ----

describe('stripMethod / applyPartstat', () => {
  it('removes only the top-level METHOD and leaves the rest byte for byte', () => {
    const stripped = stripMethod(OUTLOOK_ICS)
    expect(stripped).not.toContain('METHOD:')
    expect(stripped).toBe(OUTLOOK_ICS.replace('METHOD:REQUEST\r\n', ''))
    // already clean: returned unchanged
    expect(stripMethod(stripped)).toBe(stripped)
  })

  it('writes my PARTSTAT and keeps every other line', () => {
    const stored = applyPartstat(OUTLOOK_ICS, 'HANS.MUELLER@firma.de', 'accepted')
    expect(stored).not.toContain('METHOD:')
    expect(attendeeParams(stored, 'Hans.Mueller@firma.de')?.PARTSTAT).toEqual(['ACCEPTED'])
    expect(attendeeParams(stored, 'Hans.Mueller@firma.de')?.CN).toEqual(['Müller, Hans'])
    expect(attendeeParams(stored, 'ben@firma.de')?.PARTSTAT).toEqual(['NEEDS-ACTION'])
    for (const kept of [
      'X-MICROSOFT-CDO-OWNERAPPTID:2123456789',
      'TRIGGER;RELATED=START:-PT15M',
      'BEGIN:VTIMEZONE',
      'CLASS:PUBLIC',
      // untouched attendee lines stay folded exactly as received
      'ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Ben Weber:mai\r\n lto:ben@firma.de',
    ]) {
      expect(stored).toContain(kept)
    }
    const again = parseIcs(stored)
    expect(again.events[0]!.uid).toBe(OUTLOOK_UID)
    expect(again.events[0]!.start).toEqual(parseIcs(OUTLOOK_ICS).events[0]!.start)
  })

  it('updates the series and its changed occurrences, but not email alarms', () => {
    const ics = crlf([
      'BEGIN:VCALENDAR',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:s1',
      'DTSTART:20261001T080000Z',
      'RRULE:FREQ=DAILY;COUNT=3',
      'ORGANIZER:mailto:o@x.de',
      'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@x.de',
      'BEGIN:VALARM',
      'ACTION:EMAIL',
      'ATTENDEE:mailto:me@x.de',
      'TRIGGER:-PT5M',
      'END:VALARM',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:s1',
      'RECURRENCE-ID:20261002T080000Z',
      'DTSTART:20261002T100000Z',
      'ORGANIZER:mailto:o@x.de',
      'ATTENDEE;PARTSTAT=NEEDS-ACTION:MAILTO:ME@X.DE',
      'END:VEVENT',
      'END:VCALENDAR',
    ])
    const stored = applyPartstat(ics, 'me@x.de', 'tentative')
    expect(stored.match(/PARTSTAT=TENTATIVE/g)).toHaveLength(2)
    expect(stored).toContain('BEGIN:VALARM\r\nACTION:EMAIL\r\nATTENDEE:mailto:me@x.de\r\n')
    expect(stored).toContain('MAILTO:ME@X.DE')
  })

  it('adds me when I was invited through a list', () => {
    const stored = applyPartstat(GOOGLE_ICS, 'list-member@posteo.de', 'accepted')
    const params = attendeeParams(stored, 'list-member@posteo.de')
    expect(params?.PARTSTAT).toEqual(['ACCEPTED'])
    expect(parseIcs(stored).events[0]!.attendees).toHaveLength(3)
    // properties come before sub-components (RFC 5545 grammar)
    expect(stored).toMatch(
      /TRANSP:OPAQUE\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:list-member@posteo\.de\r\nBEGIN:VALARM/,
    )
  })
})

// ---- applyReply ----

describe('applyReply', () => {
  it("files the attendee's answer into the organizer's copy", () => {
    const merged = applyReply(STORED_ORGANIZED, REPLY_ICS)!
    expect(merged).not.toBeNull()
    const lisa = attendeeParams(merged, 'Lisa.Park@gmail.com')!
    expect(lisa.PARTSTAT).toEqual(['DECLINED'])
    // the organizer's scheduling hint and everything else stay
    expect(lisa['SCHEDULE-AGENT']).toEqual(['CLIENT'])
    expect(attendeeParams(merged, 'ben@firma.de')?.PARTSTAT).toEqual(['ACCEPTED'])
    expect(merged).toContain('X-SUITE-NOTE:keep me')
    expect(merged).toContain('TRIGGER:-PT15M')
    expect(merged).toContain('DTSTART;TZID=Europe/Berlin:20261020T100000')
    expect(merged).not.toContain('METHOD')
  })

  it('returns null for another meeting, an outdated answer, or nothing new', () => {
    expect(applyReply(GOOGLE_ICS, REPLY_ICS)).toBeNull()
    const merged = applyReply(STORED_ORGANIZED, REPLY_ICS)!
    // opening the same answer mail again changes nothing
    expect(applyReply(merged, REPLY_ICS)).toBeNull()
    const newer = STORED_ORGANIZED.replace('SEQUENCE:1', 'SEQUENCE:4')
    expect(applyReply(newer, REPLY_ICS)).toBeNull()
    expect(applyReply(STORED_ORGANIZED, 'garbage')).toBeNull()
    expect(applyReply('garbage', REPLY_ICS)).toBeNull()
  })

  it('trusts answers without a SEQUENCE and adds attendees who were invited through a list', () => {
    const reply = crlf([
      'BEGIN:VCALENDAR',
      'METHOD:REPLY',
      'BEGIN:VEVENT',
      'UID:suite-7f3e2b1a@suite-office',
      'DTSTAMP:20261001T070000Z',
      'ORGANIZER:mailto:me@posteo.de',
      'ATTENDEE;PARTSTAT=ACCEPTED;CN="Neu, Nora";RSVP=TRUE:mailto:nora@firma.de',
      'END:VEVENT',
      'END:VCALENDAR',
    ])
    const merged = applyReply(STORED_ORGANIZED.replace('SEQUENCE:1', 'SEQUENCE:5'), reply)!
    const nora = attendeeParams(merged, 'nora@firma.de')!
    expect(nora.PARTSTAT).toEqual(['ACCEPTED'])
    expect(nora.CN).toEqual(['Neu, Nora'])
    expect(nora.RSVP).toBeUndefined()
    // properties come before sub-components (RFC 5545 grammar)
    expect(merged).toMatch(/mailto:nora@firma\.de\r\nBEGIN:VALARM/)
  })

  it('applies an answer for one occurrence only to that occurrence', () => {
    const stored = crlf([
      'BEGIN:VCALENDAR',
      'BEGIN:VTIMEZONE',
      'TZID:W. Europe Standard Time',
      'BEGIN:STANDARD',
      'DTSTART:16010101T030000',
      'TZOFFSETFROM:+0200',
      'TZOFFSETTO:+0100',
      'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:16010101T020000',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0200',
      'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:weekly',
      'SEQUENCE:0',
      'DTSTART;TZID=W. Europe Standard Time:20261001T090000',
      'RRULE:FREQ=WEEKLY',
      'ORGANIZER:mailto:me@x.de',
      'ATTENDEE;PARTSTAT=ACCEPTED:mailto:a@x.de',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:weekly',
      'SEQUENCE:0',
      'RECURRENCE-ID;TZID=W. Europe Standard Time:20261008T090000',
      'DTSTART;TZID=W. Europe Standard Time:20261008T110000',
      'ORGANIZER:mailto:me@x.de',
      'ATTENDEE;PARTSTAT=ACCEPTED:mailto:a@x.de',
      'END:VEVENT',
      'END:VCALENDAR',
    ])
    // the same instant written in UTC by the attendee's client
    const reply = crlf([
      'BEGIN:VCALENDAR',
      'METHOD:REPLY',
      'BEGIN:VEVENT',
      'UID:weekly',
      'RECURRENCE-ID:20261008T070000Z',
      'ATTENDEE;PARTSTAT=DECLINED:mailto:A@x.de',
      'END:VEVENT',
      'END:VCALENDAR',
    ])
    const merged = applyReply(stored, reply)!
    const events = parseIcs(merged).events
    expect(events[0]!.attendees[0]!.partstat).toBe('ACCEPTED')
    expect(events[1]!.attendees[0]!.partstat).toBe('DECLINED')

    const unknown = reply.replace('20261008T070000Z', '20261015T070000Z')
    expect(applyReply(stored, unknown)).toBeNull()
  })
})
