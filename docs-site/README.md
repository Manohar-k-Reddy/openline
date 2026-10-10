# OpenLine docs

Starlight site for the OpenLine API, deployed to GitHub Pages by `.github/workflows/docs.yml`.

```bash
npm install
npm run dev      # http://localhost:4321/openline/
npm run build    # dist/, including llms.txt, llms-full.txt, llms-small.txt and openapi.yaml
```

- Pages: `src/content/docs/`
- API reference: generated from `public/openapi.yaml` (keep it in sync with `server/src/app.ts`)
- `SITE`, `BASE` and `REPO_URL` env vars set the published address (the workflow fills them in).
