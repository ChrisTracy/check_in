import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (no dependency). Real environment variables win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv(path.join(ROOT, '.env'));

const int = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

function parseTrustProxy(v) {
  if (!v) return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

export const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  dbPath: path.resolve(ROOT, process.env.DB_PATH || 'data/checkin.db'),
  // Number of history entries kept per record. 0 = keep no history, -1 = unlimited.
  historyLimit: int(process.env.HISTORY_LIMIT, 100),
  // Seeds the API key on first start only; after that it is managed in the admin panel.
  apiKey: process.env.API_KEY || '',
  appSecret: process.env.APP_SECRET || '',
  sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 12),
  // 'auto' = Secure cookies when the request arrived over HTTPS
  cookieSecure: process.env.COOKIE_SECURE || 'auto',
  // Set when running behind a reverse proxy / load balancer (true, a hop count, or an IP list)
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  adminUsername: process.env.ADMIN_USERNAME || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // Testing / non-Entra providers only
  oidcIssuerOverride: process.env.OIDC_ISSUER_OVERRIDE || '',
  oidcAllowInsecure: process.env.OIDC_ALLOW_INSECURE === 'true',
  // Built-in HTTPS (turned on in Admin → HTTPS). Certificates are stored in TLS_DIR.
  httpsPort: int(process.env.HTTPS_PORT, 3443),
  tlsDir: path.resolve(ROOT, process.env.TLS_DIR || path.join(path.dirname(process.env.DB_PATH || 'data/checkin.db'), 'tls')),
  // Break-glass: force HTTP only, ignoring the saved HTTPS settings.
  tlsDisable: process.env.TLS_DISABLE === 'true',
  maxBatch: int(process.env.MAX_BATCH, 5000),
  maxFieldsPerRecord: int(process.env.MAX_FIELDS, 500),
  bodyLimitMb: int(process.env.BODY_LIMIT_MB, 10),
  importLimitMb: int(process.env.IMPORT_LIMIT_MB, 200),
  logLevel: process.env.LOG_LEVEL || 'warn',
  corsOrigin: process.env.CORS_ORIGIN || '',
};
