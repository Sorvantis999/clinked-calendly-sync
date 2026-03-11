import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

const CLINKED_CLIENT_ID = process.env.CLINKED_CLIENT_ID!;
const CLINKED_CLIENT_SECRET = process.env.CLINKED_CLIENT_SECRET!;
const CLINKED_ACCOUNT_ID = process.env.CLINKED_ACCOUNT_ID!;
const CALENDLY_SIGNING_KEY = process.env.CALENDLY_SIGNING_KEY!;

// --- Calendly signature verification ---
function verifyCalendlySignature(req: NextRequest, rawBody: string): boolean {
  if (!CALENDLY_SIGNING_KEY) return true; // skip in dev if not set
  const header = req.headers.get('calendly-webhook-signature');
  if (!header) return false;

  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')));
  const t = parts['t'];
  const v1 = parts['v1'];
  if (!t || !v1) return false;

  const expected = crypto
    .createHmac('sha256', CALENDLY_SIGNING_KEY)
    .update(`${t}.${rawBody}`)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expected, 'hex'));
}

// --- Clinked auth ---
async function getClinkedToken(): Promise<string> {
  const res = await fetch('https://api.clinked.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLINKED_CLIENT_ID,
      client_secret: CLINKED_CLIENT_SECRET,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Clinked auth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

// --- Find Clinked group by invitee email ---
async function findGroupForEmail(token: string, email: string): Promise<number | null> {
  const res = await fetch(
    `https://api.clinked.com/v3/accounts/${CLINKED_ACCOUNT_ID}/groups?pageSize=50`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
  );
  const data = await res.json();
  const groups = data.items || [];

  for (const group of groups) {
    const members: any[] = group.memberDetails || [];
    const match = members.find(
      (m: any) => m.user?.email?.toLowerCase() === email.toLowerCase()
    );
    if (match) return group.id;
  }
  return null;
}

// --- Create event in Clinked group ---
async function createClinkedEvent(
  token: string,
  groupId: number,
  payload: {
    name: string;
    startTime: string;
    endTime: string;
    description: string;
    location: string;
  }
) {
  const start = new Date(payload.startTime).getTime();
  const end = new Date(payload.endTime).getTime();

  const body = {
    name: payload.name,
    startDate: start,
    endDate: end,
    description: payload.description,
    location: payload.location,
    allDay: false,
  };

  const res = await fetch(
    `https://api.clinked.com/v3/groups/${groupId}/events`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Clinked event creation failed (${res.status}): ${err}`);
  }
  return res.json();
}

// --- Main webhook handler ---
export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  // Verify signature
  if (!verifyCalendlySignature(req, rawBody)) {
    console.error('Invalid Calendly signature');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const event = payload.event;
  const invitee = payload.payload?.invitee;
  const scheduledEvent = payload.payload?.event;

  console.log('Calendly webhook received:', event);

  // Only handle booking created events
  if (event !== 'invitee.created') {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const inviteeEmail = invitee?.email;
  const inviteeName = invitee?.name || inviteeEmail;
  const eventName = scheduledEvent?.name || 'Meeting';
  const startTime = scheduledEvent?.start_time;
  const endTime = scheduledEvent?.end_time;
  const location = scheduledEvent?.location?.join_url ||
    scheduledEvent?.location?.location ||
    scheduledEvent?.location?.type ||
    '';

  if (!inviteeEmail || !startTime || !endTime) {
    console.error('Missing required fields', { inviteeEmail, startTime, endTime });
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
  }

  try {
    const token = await getClinkedToken();
    const groupId = await findGroupForEmail(token, inviteeEmail);

    if (!groupId) {
      console.log(`No Clinked group found for ${inviteeEmail} — skipping`);
      return NextResponse.json({ ok: true, message: 'No matching client group found' });
    }

    const description = `Booked via Calendly\nClient: ${inviteeName} (${inviteeEmail})${location ? `\nLocation: ${location}` : ''}`;

    const result = await createClinkedEvent(token, groupId, {
      name: eventName,
      startTime,
      endTime,
      description,
      location,
    });

    console.log(`Created Clinked event ${result.id} in group ${groupId} for ${inviteeEmail}`);
    return NextResponse.json({ ok: true, clinkedEventId: result.id, groupId });

  } catch (err: any) {
    console.error('Sync error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
