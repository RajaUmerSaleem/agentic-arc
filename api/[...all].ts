let appPromise: Promise<any> | null = null;

async function getApp() {
	if (!appPromise) {
		appPromise = import('../server').then((mod) => mod.createApiApp());
	}
	return appPromise;
}

export default async function handler(req: any, res: any) {
	try {
		const app = await getApp();
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
