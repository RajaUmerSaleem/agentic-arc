import { createApiApp } from '../server';

let appInstance: any | null = null;

function getApp() {
	if (!appInstance) {
		appInstance = createApiApp();
	}
	return appInstance;
}

export default function handler(req: any, res: any) {
	try {
		const app = getApp();
		return app(req, res);
	} catch (err: any) {
		console.error('[Vercel API Bootstrap Error]', err);
		const payload = {
			success: false,
			error: err?.message || 'Server initialization failed',
			demo: true,
			info: 'API entered fallback mode to avoid invocation crash.'
		};

		if (!res.headersSent) {
			res.statusCode = 500;
			res.setHeader('Content-Type', 'application/json');
		}
		res.end(JSON.stringify(payload));
	}
}

export const config = {
	runtime: 'nodejs'
};
