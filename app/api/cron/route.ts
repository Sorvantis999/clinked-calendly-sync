import { NextRequest, NextResponse } from 'next/server';
import { syncCalendlyToCliked } from '@/lib/sync';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  // Verify this is a legitimate Vercel cron call (or manual trigger)
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Sync events from the past 30 minutes (overlapping window = nothing missed)
    const since = new Date(Date.now() - 30 * 60 * 1000);
    const result = await syncCalendlyToCliked(since, true);

    console.log('Cron sync complete:', result);
    return NextResponse.json({ ok: true, ...result });
  } catch (err: any) {
    console.error('Cron sync error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
