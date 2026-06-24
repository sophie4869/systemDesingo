// api/_lib/http.js
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body; // vercel pre-parsed
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (raw.length === 0) return {};
  if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) throw new HttpError(413, 'Payload too large');
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

export function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
}
