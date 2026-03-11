import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import {
  getClinkedToken,
  getAllGroups,
  findGroupForEmail,
  getPendingInviteMap,
  getExistingClinkedEvents,
  createClinkedEvent,
} from '@/lib/sync';

const CALENDLY_SIGNING_KEY = process.env.CALENDLY_SIGNING_KEY;

function verifyCalendlySignature(req: NextRequest, rawBody: string): boolean {
  if (!CALENDLY_SIGNING_KEY) return true;
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
  try {
    return crypto.timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  if (!verifyCalendlySignature(req, rawBody)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let payload: any;
  try { payload = JSON.parse(rawBody); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (payload.event !== 'invitee.created') {
    return NextResponse.json({ ok: true, skipped: true });
  }
  const invitee = payload.payload?.invitee;
  const scheduledEvent = payload.payload?.event;
  const email = invitee?.email;
  const name = invitee?.name || email;
  const eventName = scheduledEvent?.name || 'Meeting';
  const startTime = scheduledEvent?.start_time;
  const endTime = scheduledEvent?.end_time;
  const location = scheduledEvent?.location?.join_url || scheduledEvent?.location?.location || scheduledEvent?.location?.type || '';
  if (!email || !startTime || !endTime) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
  }
  try {
    const token = await getClinkedToken();
    const groups = await getAllGroups(token);
    const pendingInvites = await getPendingInviteMap(token);

    let groupId = await findGroupForEmail(groups, email);
    if (!groupId) groupId = pendingInvites.get(email.toLowerCase()) ?? null;

    if (!groupId) {
      console.log(`No Clinked group for ${email} — skipping (no auto-create)`);
      return NextResponse.json({ ok: true, skipped: true, reason: 'no_group' });
    }
    const existing = await getExistingClinkedEvents(token, groupId);
    const startMs = new Date(startTime).getTime();
    const duplicate = existing.some(
      (e: any) => e.name === eventName && Math.abs((e.startDate || 0) - startMs) < 60000
    );
    if (duplicate) return NextResponse.json({ ok: true, message: 'Duplicate, skipped' });
    const description = `Booked via Calendly\nClient: ${name} (${email})${location ? `\nLocation: ${location}` : ''}`;
    const result = await createClinkedEvent(token, groupId, { name: eventName, startTime, endTime, description, location });
    return NextResponse.json({ ok: true, clinkedEventId: result.id, groupId });
  } catch (err: any) {
    console.error('Webhook sync error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
