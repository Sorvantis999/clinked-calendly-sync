// Shared sync logic — used by both the webhook and the cron poller

const CLINKED_CLIENT_ID = process.env.CLINKED_CLIENT_ID!;
const CLINKED_CLIENT_SECRET = process.env.CLINKED_CLIENT_SECRET!;
const CLINKED_ACCOUNT_ID = process.env.CLINKED_ACCOUNT_ID!;
const CALENDLY_TOKEN = process.env.CALENDLY_TOKEN!;
const CALENDLY_ORG = process.env.CALENDLY_ORG!;
const CALENDLY_USER = process.env.CALENDLY_USER!;

// ─── Clinked ──────────────────────────────────────────────────────────────────

export async function getClinkedToken(): Promise<string> {
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

export async function getAllGroups(token: string): Promise<any[]> {
  const res = await fetch(
    `https://api.clinked.com/v3/accounts/${CLINKED_ACCOUNT_ID}/groups?pageSize=100`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
  );
  const data = await res.json();
  return data.items || [];
}

export async function findGroupForEmail(groups: any[], email: string): Promise<number | null> {
  for (const group of groups) {
    const members: any[] = group.memberDetails || [];
    if (members.some((m: any) => m.user?.email?.toLowerCase() === email.toLowerCase())) {
      return group.id;
    }
  }
  return null;
}

export async function createGroupForInvitee(
  token: string,
  name: string,
  email: string
): Promise<number> {
  // Create group
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const groupRes = await fetch(`https://api.clinked.com/v3/accounts/${CLINKED_ACCOUNT_ID}/groups`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      name: slug,
      friendlyName: name,
    }),
  });
  if (!groupRes.ok) {
    const err = await groupRes.text();
    throw new Error(`Failed to create group: ${err}`);
  }
  const group = await groupRes.json();
  const groupId = group.id;

  // Invite the member
  await fetch(`https://api.clinked.com/v3/accounts/${CLINKED_ACCOUNT_ID}/invites`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      targetName: email,
      type: 'ACCEPT_DECLINE',
      parameters: JSON.stringify({ mask: 4, groups: { [groupId]: 4 }, extras: {} }),
    }),
  });

  console.log(`Created new Clinked group "${name}" (${groupId}) for ${email}`);
  return groupId;
}

export async function getExistingClinkedEvents(token: string, groupId: number): Promise<any[]> {
  const res = await fetch(
    `https://api.clinked.com/v3/groups/${groupId}/events?pageSize=100`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data.items || data || [];
}

export async function createClinkedEvent(
  token: string,
  groupId: number,
  payload: { name: string; startTime: string; endTime: string; description: string; location: string }
) {
  const body = {
    name: payload.name,
    startDate: new Date(payload.startTime).getTime(),
    endDate: new Date(payload.endTime).getTime(),
    description: payload.description,
    location: payload.location,
    allDay: false,
  };

  const res = await fetch(`https://api.clinked.com/v3/groups/${groupId}/events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Clinked event creation failed (${res.status}): ${err}`);
  }
  return res.json();
}

// ─── Calendly ─────────────────────────────────────────────────────────────────

export async function getCalendlyEvents(minStartTime: string, maxStartTime?: string): Promise<any[]> {
  const params = new URLSearchParams({
    user: CALENDLY_USER,
    min_start_time: minStartTime,
    status: 'active',
    count: '100',
  });
  if (maxStartTime) params.set('max_start_time', maxStartTime);

  const res = await fetch(`https://api.calendly.com/scheduled_events?${params}`, {
    headers: { Authorization: `Bearer ${CALENDLY_TOKEN}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Calendly events fetch failed: ${res.status}`);
  const data = await res.json();
  return data.collection || [];
}

export async function getCalendlyInvitees(eventUri: string): Promise<any[]> {
  const uuid = eventUri.split('/').pop();
  const res = await fetch(`https://api.calendly.com/scheduled_events/${uuid}/invitees?count=100`, {
    headers: { Authorization: `Bearer ${CALENDLY_TOKEN}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.collection || [];
}

// ─── Core sync function ───────────────────────────────────────────────────────

export interface SyncResult {
  processed: number;
  created: number;
  skipped: number;
  newGroups: number;
  errors: string[];
}

export async function syncCalendlyToCliked(
  since: Date,
  autoCreateGroups = true
): Promise<SyncResult> {
  const result: SyncResult = { processed: 0, created: 0, skipped: 0, newGroups: 0, errors: [] };

  const token = await getClinkedToken();
  const groups = await getAllGroups(token);

  // Fetch Calendly events from the given window
  const events = await getCalendlyEvents(since.toISOString());
  console.log(`Fetched ${events.length} Calendly events since ${since.toISOString()}`);

  for (const event of events) {
    result.processed++;
    const invitees = await getCalendlyInvitees(event.uri);

    for (const invitee of invitees) {
      const email = invitee.email;
      const name = invitee.name || email;
      const eventName = event.name || 'Meeting';
      const startTime = event.start_time;
      const endTime = event.end_time;
      const location =
        event.location?.join_url || event.location?.location || event.location?.type || '';

      if (!email || !startTime) continue;

      try {
        let groupId = await findGroupForEmail(groups, email);

        if (!groupId) {
          if (!autoCreateGroups) {
            console.log(`No group for ${email}, skipping (autoCreate=false)`);
            result.skipped++;
            continue;
          }
          // Auto-create group for new invitee
          groupId = await createGroupForInvitee(token, name, email);
          // Add to local groups list so subsequent iterations find it
          groups.push({ id: groupId, memberDetails: [{ user: { email } }] });
          result.newGroups++;
        }

        // Deduplicate: check if an event with same name and start time already exists
        const existing = await getExistingClinkedEvents(token, groupId);
        const startMs = new Date(startTime).getTime();
        const duplicate = existing.some(
          (e: any) =>
            e.name === eventName &&
            Math.abs((e.startDate || 0) - startMs) < 60000 // within 1 min
        );

        if (duplicate) {
          console.log(`Duplicate event "${eventName}" for ${email}, skipping`);
          result.skipped++;
          continue;
        }

        const description = `Booked via Calendly\nClient: ${name} (${email})${location ? `\nLocation: ${location}` : ''}`;

        await createClinkedEvent(token, groupId, {
          name: eventName,
          startTime,
          endTime,
          description,
          location,
        });

        console.log(`Created event "${eventName}" in group ${groupId} for ${email}`);
        result.created++;
      } catch (err: any) {
        console.error(`Error processing ${email}:`, err.message);
        result.errors.push(`${email}: ${err.message}`);
      }
    }
  }

  return result;
}
