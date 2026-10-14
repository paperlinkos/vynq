// Vercel routes every /api/* request through the same VYNQ server handler.
// Static files are served directly from dist/ by Vercel.
import { handleRequest } from '../lib/vynq-server.mjs';

export const config = { api: { bodyParser: false } };

export default async function handler(request, response) {
  return handleRequest(request, response);
}
