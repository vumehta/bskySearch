# CLAUDE.md

## Project Overview

bskySearch is a full-stack web application for searching Bluesky posts with advanced filtering. Vanilla JavaScript frontend, Vercel serverless backend.

## Build & Run

Deployed via Vercel—push to `main` and Vercel handles everything:
- Runs `npm run build` to minify JS/CSS
- Serves from `vercel.json` (routing, security headers)

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
- Map/Set for caches and tracking (didCache, searchCache, newPostUris)
- URL params encode search state for shareable links

### Backend (api/search.js)
- Proxies Bluesky API to handle authentication server-side
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

Backend requires (set in Vercel dashboard):
- `BSKY_HANDLE` - Bluesky account handle
- `BSKY_APP_PASSWORD` - App-specific password (not main password)

## Common Tasks

### Adding a new search filter
1. Add UI control in bluesky-term-search.html
2. Add state variable in src/state.mjs
3. Update search flow in src/search.mjs
4. If backend needs it, update api/search.js validation

### Adding a new theme color
1. Add CSS variable in `:root` in styles.css
2. Add dark mode override in `[data-theme="dark"]` section
3. Reference via `var(--your-variable)` where needed

## Testing

Run `npm test` for the Vitest suite, then verify manually:
1. Search with various terms
2. Test filters (likes, time range)
3. Test auto-refresh feature
4. Test quote finder with a real Bluesky post URL
5. Toggle themes (light/dark/system)

## Debugging

- 401 errors: Session expired, check `refreshOrCreateSession()` flow
- Duplicate posts: Check `deduplicatePosts()` and URI-based dedup logic
- Missing quotes: Verify `quoteSeenCursors` isn't blocking valid cursors
- Missing posts: Search API filters to English only (`lang: 'en'` in api/search.js)

## Git Workflow

- Branch naming: `vumehta/<descriptive-name>`
- Main branch: `main`
- Keep commits focused on single changes
- Minified files are gitignored—Vercel builds them

## Claude Code

Custom agents in `.claude/agents/`:
- `security-reviewer.md` — XSS and security audit for code changes

## Gotchas

- Strict CSP in vercel.json—no inline scripts/styles, limited connect-src (self + public.api.bsky.app only)
- The HTML references minified files, but dev changes go in source files (src/, styles.css)
- Session refresh has race condition protection via `sessionPromise`—don't bypass this pattern
- Auto-refresh timer uses setInterval; remember to clear on search changes
- Quote finder needs post URI, not post URL—conversion happens in `performQuoteSearch()`
- Search results are English-only due to hardcoded `lang: 'en'` parameter
