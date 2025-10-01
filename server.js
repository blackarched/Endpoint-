'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const Ajv = require('ajv');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));
const limiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
app.use(limiter);

// In-memory stores (persisted to simple JSON files)
const DATA_DIR = path.join(__dirname, '.data');
const ANALYTICS_FILE = path.join(DATA_DIR, 'analytics.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const APIS_FILE = path.join(DATA_DIR, 'apis.json');

function ensureDataDir() {
	if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
}

function readJsonSafe(filePath, fallback) {
	try {
		if (!fs.existsSync(filePath)) return fallback;
		const raw = fs.readFileSync(filePath, 'utf8');
		return JSON.parse(raw || 'null') ?? fallback;
	} catch (e) {
		return fallback;
	}
}

function writeJsonSafe(filePath, data) {
	try {
		fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
		return true;
	} catch (e) {
		return false;
	}
}

ensureDataDir();

// Canonical API database persisted to disk; seed with curated subset if empty
const apiSeed = {
	openweather: { name: 'OpenWeatherMap', endpoint: 'api.openweathermap.org/data/2.5/weather', category: 'network', status: 'active', health: 'excellent', authentication: 'API Key', pricing: 'free' },
	shodan: { name: 'Shodan', endpoint: 'api.shodan.io/shodan/host/{ip}', category: 'network', status: 'active', health: 'excellent', authentication: 'API Key', pricing: 'freemium' },
	censys: { name: 'Censys', endpoint: 'search.censys.io/api/v2/hosts', category: 'network', status: 'active', health: 'good', authentication: 'API Key', pricing: 'paid' },
	ipinfo: { name: 'IPinfo.io', endpoint: 'ipinfo.io/{ip}', category: 'network', status: 'active', health: 'excellent', authentication: 'API Key', pricing: 'freemium' },
	github: { name: 'GitHub', endpoint: 'api.github.com/repos/{user}/{repo}', category: 'common', status: 'active', health: 'excellent', authentication: 'OAuth Token', pricing: 'free' },
	maps: { name: 'Google Maps', endpoint: 'maps.googleapis.com/maps/api/geocode/json', category: 'common', status: 'active', health: 'excellent', authentication: 'API Key', pricing: 'freemium' },
	stripe: { name: 'Stripe', endpoint: 'api.stripe.com/v1', category: 'common', status: 'active', health: 'excellent', authentication: 'API Key', pricing: 'paid' }
};
let apiDatabase = readJsonSafe(APIS_FILE, null);
if (!apiDatabase || typeof apiDatabase !== 'object' || Array.isArray(apiDatabase)) {
	apiDatabase = apiSeed;
	writeJsonSafe(APIS_FILE, apiDatabase);
}

// Load persisted state
let analytics = readJsonSafe(ANALYTICS_FILE, {});
let settings = readJsonSafe(SETTINGS_FILE, {
	theme: 'dark',
	autoRefresh: true,
	refreshInterval: 30000,
	healthMonitoring: true,
	statusNotifications: true,
	healthAlerts: true,
	holographicEffects: true,
	defaultExportFormat: 'json'
});
let apiKeys = readJsonSafe(KEYS_FILE, {});

// Helpers & security
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ajv = new Ajv({ useDefaults: true, removeAdditional: true });
const requireAuth = (req, res, next) => {
	if (!ADMIN_TOKEN) return next();
	const auth = req.headers['authorization'] || '';
	if (auth === `Bearer ${ADMIN_TOKEN}`) return next();
	return res.status(401).json({ error: 'Unauthorized' });
};

function getAesKey() {
	const k = process.env.SECRET_KEY ? Buffer.from(process.env.SECRET_KEY, 'base64') : null;
	if (k && k.length === 32) return k;
	return crypto.createHash('sha256').update('dev-secret').digest();
}

function encryptSecret(plain) {
	const key = getAesKey();
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
	const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return 'gcm:' + Buffer.concat([iv, enc, tag]).toString('base64');
}

function decryptSecret(stored) {
	if (!stored) return '';
	if (!stored.startsWith('gcm:')) {
		try { return Buffer.from(stored, 'base64').toString('utf8'); } catch (e) { return String(stored); }
	}
	const buf = Buffer.from(stored.slice(4), 'base64');
	const iv = buf.subarray(0, 12);
	const tag = buf.subarray(buf.length - 16);
	const enc = buf.subarray(12, buf.length - 16);
	const key = getAesKey();
	const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAuthTag(tag);
	const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
	return dec.toString('utf8');
}

const apiSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['name', 'endpoint', 'category', 'status', 'health', 'authentication', 'pricing'],
	properties: {
		name: { type: 'string', minLength: 1 },
		endpoint: { type: 'string', minLength: 1 },
		category: { type: 'string', minLength: 1 },
		status: { type: 'string' },
		health: { type: 'string' },
		authentication: { type: 'string' },
		pricing: { type: 'string' }
	}
};
const validateApi = ajv.compile(apiSchema);

const settingsSchema = {
	type: 'object',
	additionalProperties: true,
	properties: {
		theme: { type: 'string' },
		autoRefresh: { type: 'boolean' },
		refreshInterval: { type: 'number' },
		healthMonitoring: { type: 'boolean' },
		statusNotifications: { type: 'boolean' },
		healthAlerts: { type: 'boolean' },
		holographicEffects: { type: 'boolean' },
		defaultExportFormat: { type: 'string' }
	}
};
const validateSettings = ajv.compile(settingsSchema);
function trackApiUsage(apiName, success, responseTimeMs) {
	if (!analytics[apiName]) {
		analytics[apiName] = {
			calls: 0,
			successes: 0,
			failures: 0,
			totalResponseTime: 0,
			lastCalled: null,
			healthScore: 100
		};
	}
	const s = analytics[apiName];
	s.calls += 1;
	s.lastCalled = new Date().toISOString();
	if (success) {
		s.successes += 1;
		s.totalResponseTime += Math.max(0, Number(responseTimeMs) || 0);
		const successRate = (s.successes / s.calls) * 100;
		const avgResponse = s.successes > 0 ? s.totalResponseTime / s.successes : 0;
		const responseScore = Math.max(0, 100 - avgResponse / 10);
		s.healthScore = Math.round((successRate + responseScore) / 2);
	} else {
		s.failures += 1;
		s.healthScore = Math.max(0, s.healthScore - 10);
	}
	writeJsonSafe(ANALYTICS_FILE, analytics);
}

function calcOverallStats() {
	const apis = Object.keys(analytics);
	const totals = apis.reduce((acc, key) => {
		const s = analytics[key];
		acc.calls += s.calls;
		acc.successes += s.successes;
		acc.totalResponseTime += s.totalResponseTime;
		return acc;
	}, { calls: 0, successes: 0, totalResponseTime: 0 });
	return {
		totalCalls: totals.calls,
		successRate: totals.calls > 0 ? Number(((totals.successes / totals.calls) * 100).toFixed(1)) : 0,
		avgResponseTime: totals.successes > 0 ? Math.round(totals.totalResponseTime / totals.successes) : 0
	};
}

// Routes
app.get('/health', (req, res) => {
	res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// APIs list (single source of truth)
app.get('/api/apis', (req, res) => {
	res.json({ total: Object.keys(apiDatabase).length, apis: apiDatabase });
});
app.post('/api/apis', requireAuth, (req, res) => {
	const body = req.body || {};
	if (!validateApi(body)) return res.status(400).json({ error: 'Invalid API', details: validateApi.errors });
	const id = (body.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40) || `api_${Date.now()}`;
	if (apiDatabase[id]) return res.status(409).json({ error: 'API id already exists' });
	apiDatabase[id] = body;
	writeJsonSafe(APIS_FILE, apiDatabase);
	res.status(201).json({ id, api: body });
});
app.put('/api/apis/:id', requireAuth, (req, res) => {
	const { id } = req.params;
	if (!apiDatabase[id]) return res.status(404).json({ error: 'Not found' });
	const body = req.body || {};
	if (!validateApi(body)) return res.status(400).json({ error: 'Invalid API', details: validateApi.errors });
	apiDatabase[id] = body;
	writeJsonSafe(APIS_FILE, apiDatabase);
	res.json({ id, api: body });
});
app.delete('/api/apis/:id', requireAuth, (req, res) => {
	const { id } = req.params;
	if (!apiDatabase[id]) return res.status(404).json({ error: 'Not found' });
	delete apiDatabase[id];
	writeJsonSafe(APIS_FILE, apiDatabase);
	res.json({ ok: true });
});

// Simulate API test
app.post('/api/test/:api', (req, res) => {
	const { api } = req.params;
	const info = apiDatabase[api];
	if (!info) return res.status(404).json({ error: 'Unknown API' });

	const baseByHealth = { excellent: 50, good: 150, fair: 500, poor: 1500 };
	const base = baseByHealth[info.health] ?? 200;
	const simulated = Math.floor(base + Math.random() * 100);

	trackApiUsage(api, true, simulated);
	res.json({ api, name: info.name, responseTimeMs: simulated, success: true });
});

// Analytics
app.get('/api/analytics', (req, res) => {
	res.json({ timestamp: new Date().toISOString(), overall: calcOverallStats(), perApi: analytics });
});

// Export data
app.get('/api/export', (req, res) => {
	const format = (req.query.format || 'json').toString();
	const payload = {
		timestamp: new Date().toISOString(),
		totalApis: Object.keys(apiDatabase).length,
		overall: calcOverallStats(),
		apis: apiDatabase,
		analytics
	};

	if (format === 'csv') {
		const headers = ['Name', 'Endpoint', 'Category', 'Status', 'Health', 'Authentication', 'Pricing'];
		let csv = headers.join(',') + '\n';
		Object.values(apiDatabase).forEach(a => {
			csv += ['"' + a.name + '"', '"' + a.endpoint + '"', '"' + a.category + '"', '"' + a.status + '"', '"' + a.health + '"', '"' + a.authentication + '"', '"' + a.pricing + '"'].join(',') + '\n';
		});
		res.type('text/csv');
		return res.send(csv);
	}

	if (format === 'html') {
		const rows = Object.values(apiDatabase).map(a => `<tr class="${a.health}"><td>${a.name}</td><td>${a.endpoint}</td><td>${a.category}</td><td>${a.status}</td><td>${a.health}</td><td>${a.authentication}</td><td>${a.pricing}</td></tr>`).join('');
		const html = `<!doctype html><html><head><meta charset="utf-8"><title>API Export</title><style>body{font-family:Arial,sans-serif;margin:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f2f2f2}.excellent{background:#d4edda}.good{background:#d1ecf1}.fair{background:#fff3cd}.poor{background:#f8d7da}</style></head><body><h1>API Database Export</h1><p>Generated: ${new Date().toLocaleString()}</p><p>Total APIs: ${Object.keys(apiDatabase).length}</p><table><thead><tr><th>Name</th><th>Endpoint</th><th>Category</th><th>Status</th><th>Health</th><th>Authentication</th><th>Pricing</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
		res.type('text/html');
		return res.send(html);
	}

	res.json(payload);
});

// Settings
app.get('/api/settings', (req, res) => {
	res.json(settings);
});

app.put('/api/settings', requireAuth, (req, res) => {
	const incoming = req.body && typeof req.body === 'object' ? req.body : {};
	if (!validateSettings(incoming)) return res.status(400).json({ error: 'Invalid settings', details: validateSettings.errors });
	settings = { ...settings, ...incoming };
	writeJsonSafe(SETTINGS_FILE, settings);
	res.json({ ok: true, settings });
});

// API Keys (encrypted presence only on list)
app.get('/api/keys', (req, res) => {
	const presence = Object.fromEntries(Object.keys(apiKeys).map(k => [k, true]));
	res.json(presence);
});

app.put('/api/keys/:api', requireAuth, (req, res) => {
	const { api } = req.params;
	const { key } = req.body || {};
	if (!api || !key) return res.status(400).json({ error: 'api and key are required' });
	apiKeys[api] = encryptSecret(String(key));
	writeJsonSafe(KEYS_FILE, apiKeys);
	res.json({ ok: true });
});

app.delete('/api/keys/:api', requireAuth, (req, res) => {
	const { api } = req.params;
	delete apiKeys[api];
	writeJsonSafe(KEYS_FILE, apiKeys);
	res.json({ ok: true });
});

app.get('/api/keys/export', requireAuth, (req, res) => {
	res.json({ keys: apiKeys });
});
app.post('/api/keys/import', requireAuth, (req, res) => {
	const body = req.body || {};
	if (!body || typeof body !== 'object' || !body.keys || typeof body.keys !== 'object') {
		return res.status(400).json({ error: 'Invalid payload' });
	}
	apiKeys = body.keys;
	writeJsonSafe(KEYS_FILE, apiKeys);
	res.json({ ok: true, count: Object.keys(apiKeys).length });
});

// Upstream basic healthcheck
app.get('/api/healthcheck/:api', async (req, res) => {
	const { api } = req.params;
	const info = apiDatabase[api];
	if (!info) return res.status(404).json({ error: 'Unknown API' });
	try {
		const host = String(info.endpoint || '').replace(/^https?:\/\//, '').split('/')[0];
		if (!host) return res.status(400).json({ error: 'No host' });
		const url = 'https://' + host;
		const controller = new AbortController();
		const to = setTimeout(() => controller.abort(), 5000);
		const r = await fetch(url, { method: 'HEAD', signal: controller.signal });
		clearTimeout(to);
		const ok = r.ok;
		trackApiUsage(api, ok, 0);
		return res.json({ api, host, status: r.status, ok });
	} catch (e) {
		trackApiUsage(api, false, 0);
		return res.status(502).json({ api, error: 'Probe failed' });
	}
});

// Serve static files (the HTML dashboard)
app.use('/', express.static(__dirname));

app.listen(PORT, () => {
	console.log(`Server listening on http://localhost:${PORT}`);
});

