import type { APIRoute } from 'astro';

// Allow everything (including AI crawlers: the docs are meant to be read by agents too) and point
// to the sitemap at its real address under the GitHub Pages base path.
export const GET: APIRoute = ({ site }) => {
	const base = import.meta.env.BASE_URL.replace(/\/$/, '');
	const sitemap = new URL(`${base}/sitemap-index.xml`, site).href;
	return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${sitemap}\n`, {
		headers: { 'content-type': 'text/plain; charset=utf-8' },
	});
};
