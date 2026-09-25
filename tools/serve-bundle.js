/* Serves the freshly built console bundle to the real Garena page so the new UI
 * can be exercised before the extension is reloaded in Chrome.
 *
 * Localhost only, CORS wide open, single file, no write surface: it exists for a
 * verification run and should never be part of the shipped product.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'dist', 'df-redeem.console.js');
const PORT = Number(process.argv[2] || 8749);

const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/bundle.js')) {
    res.writeHead(404).end('not found');
    return;
  }
  const body = fs.readFileSync(FILE);
  res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  });
  res.end(body);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${path.basename(FILE)} at http://127.0.0.1:${PORT}/bundle.js`);
});
