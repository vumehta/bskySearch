# CLAUDE.md

## Project Overview

bskySearch is a full-stack web application for searching Bluesky posts with advanced filtering. Vanilla JavaScript frontend, Vercel serverless backend.

## Build & Run

```bash
npm install                    # Install dev dependencies
npm run build                  # Minify JS and CSS for production
```

Deployed via Vercel—`vercel.json` controls routing and security headers. Minified files (app.min.js, styles.min.css) are built during Vercel deploy, not committed.

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

### Frontend (app.js)
- Single-file architecture—all UI logic lives in app.js
- Global state variables at module top (allPosts, currentCursors, etc.)
- Map/Set for caches and tracking (didCache, searchCache, newPostUris)
- URL params encode search state for shareable links

### Backend (api/search.js)
- Proxies Bluesky API to handle authentication server-side
- Session tokens cached with 2-hour TTL, auto-refresh on 401
- Session creation uses promise deduplication (`sessionPromise`) to prevent race conditions
- Response caching with 30s TTL

### Quote Finder (app.js)
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
2. Add state variable in app.js
3. Update `runSearch()` to include new parameter
4. If backend needs it, update api/search.js validation

### Adding a new theme color
1. Add CSS variable in `:root` in styles.css
2. Add dark mode override in `[data-theme="dark"]` section
3. Reference via `var(--your-variable)` where needed

## Testing

No test framework configured yet. Verify changes manually:
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

## Gotchas

- The HTML references minified files, but dev changes go in source files (app.js, styles.css)
- Session refresh has race condition protection via `sessionPromise`—don't bypass this pattern
- Auto-refresh timer uses setInterval; remember to clear on search changes
- Quote finder needs post URI, not post URL—conversion happens in `performQuoteSearch()`
- Search results are English-only due to hardcoded `lang: 'en'` parameter
