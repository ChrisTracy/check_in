// Seed the API with sample check-ins. Usage: node scripts/seed.js [url] [count]
const url = process.argv[2] || 'http://localhost:3000';
const count = Number(process.argv[3] || 2000);
const headers = { 'content-type': 'application/json' };
if (process.env.API_KEY) headers['x-api-key'] = process.env.API_KEY;
const sites = ['Dallas', 'Austin', 'Chicago', 'Denver', 'Seattle', 'Boston'];
const statuses = ['ok', 'ok', 'ok', 'ok', 'warn', 'error', 'offline'];
const roles = ['web', 'db', 'cache', 'worker', 'kiosk'];

const batch = [];
for (let i = 1; i <= count; i++) {
  batch.push({
    id: `host-${String(i).padStart(4, '0')}`,
    site: sites[i % sites.length],
    role: roles[i % roles.length],
    status: statuses[Math.floor(Math.random() * statuses.length)],
    cpu: Math.round(Math.random() * 100),
    mem_gb: +(Math.random() * 64).toFixed(1),
    version: `2.${i % 5}.${i % 3}`,
    ...(i % 4 === 0 ? { owner: ['alice', 'bob', 'carol'][i % 3] } : {}),
  });
}
// Send in bulk chunks of 500
for (let i = 0; i < batch.length; i += 500) {
  const res = await fetch(url + '/api/checkin', { method: 'POST', headers, body: JSON.stringify(batch.slice(i, i + 500)) });
  const j = await res.json();
  console.log(`chunk ${i / 500 + 1}: created ${j.created}, updated ${j.updated}`);
}
