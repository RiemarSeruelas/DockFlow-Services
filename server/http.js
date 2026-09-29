import http from 'node:http';

export function send(response, status, payload) {
  const data = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(data);
}

export async function body(request, maximum = 64 * 1024 * 1024) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('Use application/json'), { status: 415 });
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximum) throw Object.assign(new Error('Request is too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

export function listen(port, handler) {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(error => {
      if (!response.headersSent) {
        send(response, Number(error.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 503, {
          error: String(error.message || 'Service unavailable').slice(0, 500),
          code: String(error.code || '').slice(0, 20),
        });
      } else response.destroy();
    });
  });
  server.requestTimeout = 65_000;
  server.listen(Number(port), '0.0.0.0');
}
