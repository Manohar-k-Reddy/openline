// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi';
import starlightLlmsTxt from 'starlight-llms-txt';

// GitHub Pages: the deploy workflow sets SITE (https://<user>.github.io) and BASE (/<repo>).
const site = process.env.SITE ?? 'https://manohar1404.github.io';
const base = process.env.BASE ?? '/openline';
const repo = process.env.REPO_URL ?? 'https://github.com/manohar1404/openline';

export default defineConfig({
	site,
	base,
	integrations: [
		starlight({
			title: 'OpenLine',
			description:
				'OpenLine is an open-source, self-hosted voice API and Twilio alternative: an Android phone places and answers real calls on its SIM, and your code or AI voice agent controls them and streams the audio.',
			logo: { src: './src/assets/logo.svg', replacesTitle: false },
			favicon: '/favicon.svg',
			// Social previews and search engines. Starlight already adds canonical, og:title/description and the sitemap.
			head: [
				{ tag: 'meta', attrs: { property: 'og:image', content: `${site}${base}/og.png` } },
				{ tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
				{ tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
				{ tag: 'meta', attrs: { property: 'og:image:alt', content: "OpenLine: your Android phone's SIM as a voice API for code and AI agents" } },
				{ tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
				{ tag: 'meta', attrs: { name: 'twitter:image', content: `${site}${base}/og.png` } },
				{ tag: 'meta', attrs: { name: 'theme-color', content: '#141619' } },
				{ tag: 'link', attrs: { rel: 'alternate', type: 'text/plain', title: 'llms.txt', href: `${base}/llms.txt` } },
			],
			social: [{ icon: 'github', label: 'GitHub', href: repo }],
			editLink: { baseUrl: `${repo}/edit/main/docs-site/` },
			lastUpdated: true,
			customCss: ['./src/styles/theme.css'],
			plugins: [
				starlightOpenAPI([
					{
						base: 'api',
						schema: './public/openapi.yaml',
						sidebar: { label: 'API reference', collapsed: false, operations: { badges: true } },
					},
				]),
				starlightLlmsTxt({
					projectName: 'OpenLine',
					description:
						'OpenLine is a self-hosted voice API (a small Twilio Voice alternative). An Android phone with a SIM runs the OpenLine app and connects to your OpenLine server; your code places, answers and controls real phone calls over REST, gets call events by webhook, and streams call audio over WebSockets, either joining the audio itself or letting the gateway connect the call to an AI agent (raw 16 kHz PCM or Twilio Media Streams format).',
					details: [
						'Key facts:',
						'',
						"- Base URL is the user's own server (often a Tailscale Funnel or Cloudflare Tunnel address). Authenticate with `Authorization: Bearer <api key>`.",
						'- To put an AI agent on a call, pass `stream: {url, format}` to `POST /v1/calls` or `POST /v1/calls/{id}/stream`; the gateway dials out to the agent WebSocket. Closing that socket hangs up.',
						'- Call audio: 16 kHz mono s16le, 20 ms frames (640 bytes). Twilio format: 8 kHz mu-law base64 JSON.',
						'- Calls go through states queued, dialing, ringing, active, held, ended, rejected, failed. Command endpoints return 202 when the phone received the command; the state change arrives later as a webhook.',
						'',
						'Most useful pages:',
						'',
						`- [Quickstart](${site}${base}/start/quickstart/): run the server, pair a phone, place a call`,
						`- [Connect an AI agent](${site}${base}/guides/agent-streams/): stream calls to your agent's WebSocket`,
						`- [Stream protocol](${site}${base}/reference/stream-protocol/): exact raw and Twilio messages`,
						`- [Webhooks](${site}${base}/guides/webhooks/): payload, signature verification, retries`,
						`- [Call states and events](${site}${base}/reference/call-states/)`,
						`- [OpenAPI spec](${site}${base}/openapi.yaml): every endpoint and schema`,
					].join('\n'),
					promote: ['index*', 'start/**', 'guides/agent-streams*'],
					demote: ['self-hosting/**'],
				}),
			],
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ label: 'Introduction', slug: 'start/introduction' },
						{ label: 'Quickstart', slug: 'start/quickstart' },
						{ label: 'Concepts', slug: 'start/concepts' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Connect an AI agent', slug: 'guides/agent-streams' },
						{ label: 'Place and control calls', slug: 'guides/calls' },
						{ label: 'Handle incoming calls', slug: 'guides/incoming-calls' },
						{ label: 'Webhooks', slug: 'guides/webhooks' },
						{ label: 'Join call audio yourself', slug: 'guides/media' },
						{ label: 'Built-in AI assistant', slug: 'guides/assistant' },
						{ label: 'Set up the phone', slug: 'guides/phone' },
					],
				},
				{
					label: 'Self-hosting',
					items: [
						{ label: 'Run the server', slug: 'self-hosting/server' },
						{ label: 'Public address', slug: 'self-hosting/tunnels' },
						{ label: 'Security', slug: 'self-hosting/security' },
						{ label: 'Troubleshooting', slug: 'self-hosting/troubleshooting' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Call states and events', slug: 'reference/call-states' },
						{ label: 'Stream protocol', slug: 'reference/stream-protocol' },
						{ label: 'Errors', slug: 'reference/errors' },
						{ label: 'For AI agents (llms.txt)', slug: 'reference/llms' },
					],
				},
				...openAPISidebarGroups,
			],
		}),
	],
});
