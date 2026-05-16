import type { APIRoute } from 'astro';
import { runCheck, MAX_BYTES } from '../../lib/check';

export const prerender = false;

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }

  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const csv = typeof obj.csv === 'string' ? obj.csv : '';
  const fileName =
    typeof obj.fileName === 'string' && obj.fileName.trim() ? obj.fileName.trim() : 'catalog.csv';

  if (!csv.trim()) {
    return json({ error: 'The file is empty.' }, 400);
  }
  if (Buffer.byteLength(csv, 'utf8') > MAX_BYTES) {
    return json(
      { error: `File is too large. The limit is ${Math.round(MAX_BYTES / 1024 / 1024)} MB.` },
      400,
    );
  }

  try {
    const result = runCheck(csv, fileName);
    return json(result, 200);
  } catch (err) {
    const message =
      err instanceof Error && err.message ? err.message : 'Could not analyse that file.';
    return json({ error: message }, 422);
  }
};

export const ALL: APIRoute = () => json({ error: 'Use POST to check a catalog.' }, 405);
