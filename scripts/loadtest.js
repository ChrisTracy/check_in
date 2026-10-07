// Load test with no dependencies: fires many concurrent check-ins at the API.
// Usage: node scripts/loadtest.js [url] [connections] [seconds] [distinctIds]
// Set API_KEY in the environment if the server requires one.
import http from 'node:http';
import https from 'node:https';

const base = new URL(process.argv[2] || 'http://localhost:3000');
const connections = Number(process.argv[3] || 500);
const duration = Number(process.argv[4] || 10);
const ids = Number(process.argv[5] || 5000);
const lib = base.protocol === 'https:' ? https : http;
const agent = new lib.Agent({ keepAlive: true, maxSockets: connections });
const headers = { 'content-type': 'application/json' };
if (process.env.API_KEY) headers['x-api-key'] = process.env.API_KEY;
const statuses = ['ok', 'warn', 'error', 'offline'];
const sites = ['Dallas', 'Austin', 'Chicago', 'Denver', 'Seattle'];

let total = 0;
let ok = 0;
let non2xx = 0;
let errors = 0;
const latencies = [];
const end = Date.now() + duration * 1000;

function once() {
  return new Promise((resolve) => {
    const n = Math.floor(Math.random() * ids);
    const body = JSON.stringify({
      id: `device-${n}`,
      status: statuses[n % 4 === 0 ? Math.floor(Math.random() * 4) : 0],
      site: sites[n % sites.length],
      cpu: Math.round(Math.random() * 100),
      version: `1.${n % 7}.0`,
    });
    const t0 = performance.now();
    const req = lib.request(new URL('/api/checkin', base), { method: 'POST', agent, headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, (res) => {
      res.resume();
      res.on('end', () => {
        latencies.push(performance.now() - t0);
        total++;
        if (res.statusCode >= 200 && res.statusCode < 300) ok++; else non2xx++;
        resolve();
      });
    });
    req.on('error', () => { total++; errors++; resolve(); });
    req.setTimeout(10_000, () => req.destroy());
    req.end(body);
  });
}

async function worker() {
  while (Date.now() < end) await once();
}

console.log(`POST ${base.origin}/api/checkin — ${connections} concurrent connections, ${duration}s, ${ids} distinct ids`);
const started = Date.now();
await Promise.all(Array.from({ length: connections }, worker));
const secs = (Date.now() - started) / 1000;
latencies.sort((a, b) => a - b);
const pct = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))].toFixed(1) : '0');
const avg = latencies.length ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1) : '0';
console.log(`\nRequests: ${total}  (${Math.round(total / secs)}/s avg)`);
console.log(`Latency:  avg ${avg} ms, p50 ${pct(0.5)} ms, p99 ${pct(0.99)} ms`);
console.log(`2xx: ${ok}   Non-2xx: ${non2xx}   Errors: ${errors}`);
agent.destroy();
if (non2xx && ok === 0) console.log('Every request failed. Is API_KEY set correctly?');
