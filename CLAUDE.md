# CLAUDE.md

## Project Overview

bskySearch is a full-stack web application for searching Bluesky posts with advanced filtering. Vanilla JavaScript frontend plus a server API route implemented as a Web-standard handler. This is a personal-use tool with at most 2–3 total users and never more than 2 concurrent users—no rate limiting is needed.

## Build & Run

Deployed via Vercel and/or Cloudflare Workers:
- `npm run build` to minify JS/CSS and stage deploy artifacts in `dist/`
- Vercel uses `vercel.json` for routing and headers
- Cloudflare Worker uses `worker.mjs` plus static assets from `dist/` via `wrangler.toml`

**Local development:** Run `npm install && npm run build` once to generate minified files, then open `bluesky-term-search.html` in browser. Re-run build after editing source files.

## Code Style

**Always prioritize long-term cleanliness over short-term convenience.** Avoid quick hacks, tech debt, and band-aid fixes. Write code that future maintainers will thank you for.

### JavaScript
- Use vanilla JavaScript (ES6+), no frameworks
- NEVER use innerHTML—use safe DOM methods (createElement, textContent) to prevent XSS
- Use async/await, avoid raw promises
- Debounce user input handlers
- Cache expensive API calls client-side (30s TTL pattern)

### CSS
- Use CSS variables defined in `:root` for colors/theming
- Support both light and dark themes via `[data-theme="dark"]` selector
- Theme colors have semantic names (--bg, --text, --muted, --surface, --accent)

### HTML
- Reference minified files (app.min.js, styles.min.css), not source files

## Architecture Decisions

### Frontend (src/ entry)
- ESM modules under src/ bundled via esbuild into app.min.js
- Build entry is src/app.mjs
- Central state object lives in src/state.mjs
- Shared helpers in src/utils.mjs (text formatting, safe DOM), constants in src/constants.mjs
- URL parsing and navigation in src/url.mjs, caching layer in src/cache.mjs
- Thread rendering in src/thread.mjs, test utilities in src/testing.mjs
- Map/Set for caches and tracking (didCache, searchCache, newPostUris)
- URL params encode search state for shareable links

### Backend (api/search.mjs + worker.mjs)
- Proxies Bluesky API to handle authentication server-side
- Shared Web-standard handler (`handleSearch(request, env) -> Response`) with host-specific adapters
- Vercel adapter: `GET(request, context)` in `api/search.mjs`
- Cloudflare Worker adapter: `fetch(request, env)` in `worker.mjs` routes `/api/search` to `handleSearch()`
- Session tokens cached with 2-hour TTL, auto-refresh on 401
- Session creation uses promise deduplication (`sessionPromise`) to prevent race conditions
- Response caching with 30s TTL

### Quote Finder (src/quotes.mjs)
- Separate state from main search: allQuotes, quoteCursor, quoteSeenCursors, activeQuoteUri
- Uses cursor deduplication via `trackQuoteCursor()` to prevent infinite loops
- Converts post URLs to AT URIs via `parseBlueskyPostUrl()` + `fetchDid()`

## API Endpoints

### GET /api/search
Query params:
- `term` (required) - Search query (max 500 chars)
- `cursor` (optional) - Pagination cursor (max 1000 chars)
- `sort` (optional) - "top" (default) or "latest"

Returns: Bluesky search response with `posts[]` and `cursor`

## Security Requirements

IMPORTANT: This codebase prioritizes XSS prevention.

- Always use `setText(element, text)` helper or `element.textContent = value`
- Validate URLs with `isValidBskyUrl()` before rendering as links
- Escape regex special chars in user input (see pattern in `createHighlightedText()`)
- Never construct HTML strings from user data

## Environment Variables

Backend requires:
- `BSKY_HANDLE` - Bluesky account handle
- `BSKY_APP_PASSWORD` - App-specific password (not main password)

Set these in:
- Vercel project environment variables
- Cloudflare Worker environment variables/secrets

## Common Tasks

### Adding a new search filter
1. Add UI control in bluesky-term-search.html
2. Add state variable in src/state.mjs
3. Update search flow in src/search.mjs
4. If backend needs it, update api/search.mjs validation

### Adding a new theme color
1. Add CSS variable in `:root` in styles.css
2. Add dark mode override in `[data-theme="dark"]` section
3. Reference via `var(--your-variable)` where needed

## Testing

Run `npm test` for the Vitest suite, or `npm run test:watch` for continuous mode. Run `npm run perf:smoke` for performance smoke tests. Then verify manually:
1. Search with various terms
2. Test filters (likes, time range)
3. Test auto-refresh feature
4. Test quote finder with a real Bluesky post URL
5. Toggle themes (light/dark/system)

## Debugging

- 401 errors: Session expired, check `refreshOrCreateSession()` flow
- Duplicate posts: Check `deduplicatePosts()` and URI-based dedup logic
- Missing quotes: Verify `quoteSeenCursors` isn't blocking valid cursors
- Missing posts: Search API filters to English only (`lang: 'en'` in api/search.mjs)

## Git Workflow

- Branch naming: `vumehta/<descriptive-name>`
- Main branch: `main`
- Keep commits focused on single changes
- Minified files are gitignored—deployment build generates them

## Claude Code

Custom agents in `.claude/agents/`:
- `security-reviewer.md` — XSS and security audit for code changes

## Gotchas

- Strict CSP is applied by `worker.mjs` and `vercel.json`—no inline scripts/styles, limited connect-src (self + public.api.bsky.app only)
- The HTML references minified files, but dev changes go in source files (src/, styles.css)
- Session refresh has race condition protection via `sessionPromise`—don't bypass this pattern
- Auto-refresh timer uses setInterval; remember to clear on search changes
- Quote finder needs post URI, not post URL—conversion happens in `performQuoteSearch()`
- Search results are English-only due to hardcoded `lang: 'en'` parameter
