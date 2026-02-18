# CLAUDE.md

## Project Overview

bskySearch is a full-stack web application for searching Bluesky posts with advanced filtering. React 19 + TypeScript + Tailwind 4 frontend built with Vite, plus a Vercel API route implemented as a Web-standard handler. This is a personal-use tool with at most 2-3 total users and never more than 2 concurrent users—no rate limiting is needed.

## Build & Run

Deployed via Vercel—push to `main` and Vercel handles everything:
- Runs `npm run build` (Vite build, output to `dist/`)
- Serves from `vercel.json` (routing, security headers)

**Local development:** `npm install && npm run dev` starts the Vite dev server with hot reload.

**Available scripts:**
- `npm run dev` — Vite dev server
- `npm run build` — Production build to `dist/`
- `npm run preview` — Preview production build locally
- `npm run typecheck` — TypeScript type checking (app + node configs)
- `npm test` — Vitest suite (109 tests)
- `npm run test:watch` — Continuous test mode
- `npm run perf:smoke` — Performance smoke tests (via `tsx`)

## Code Style

**Always prioritize long-term cleanliness over short-term convenience.** Avoid quick hacks, tech debt, and band-aid fixes. Write code that future maintainers will thank you for.

### TypeScript / React
- React 19 with TypeScript strict mode
- Functional components with hooks (`useState`, `useCallback`, `useMemo`, `useRef`)
- Use `useLatest(value)` custom hook (in `src/frontend/useLatest.ts`) to keep refs synced with state—avoids manual `useRef` + `useEffect` mirror boilerplate
- Use async/await, avoid raw promises
- Debounce user input handlers
- Cache expensive API calls client-side (30s TTL pattern)

### CSS / Tailwind
- Tailwind 4 with `@theme` block in `src/frontend/index.css` for semantic color tokens
- All color tokens use `--color-*` namespace (e.g., `--color-bg`, `--color-text`, `--color-accent`)
- Dark mode via `@custom-variant dark` mapped to `[data-theme="dark"]` data attribute
- Dark overrides in `[data-theme='dark']` override the `--color-*` variables directly
- Use clean Tailwind utilities (`bg-card-bg`, `text-text`, `border-border`), NOT `[var(--xxx)]` bracket syntax
- Quote-depth stripe colors use non-theme CSS variables (`--quote-depth-N`) in `:root`

## Architecture Decisions

### Frontend (src/frontend/)
- Vite + React 19 + TypeScript, entry point `src/frontend/main.tsx`
- Single-component app in `src/frontend/App.tsx` (~1600 lines)
- `utils.ts` — pure functions (filtering, sorting, dedup, URL parsing, formatting)
- `api.ts` — fetch wrappers with caching and in-flight deduplication (search, DID resolution, quotes, threads)
- `constants.ts` — shared configuration values and magic numbers
- `types.ts` — TypeScript interfaces (Post, SearchResponse, ThreadState, etc.)
- `useTheme.ts` — theme preference hook (light/dark/system with localStorage persistence)
- `useLatest.ts` — ref-mirroring hook for stale-closure prevention in timers/callbacks
- `index.css` — Tailwind imports, `@theme` tokens, custom CSS (search highlight, quote depth stripes)
- Map/Set for caches and tracking (didCache, searchCache, ingestedPosts)
- URL params encode search state for shareable links

### Backend (api/search.mjs)
- Proxies Bluesky API to handle authentication server-side
- Uses a Web-standard handler (`GET(request) -> Response`) with WHATWG URL parsing
- Session tokens cached with 2-hour TTL, auto-refresh on 401
- Session creation uses promise deduplication (`sessionPromise`) to prevent race conditions
- Response caching with 30s TTL

### Quote Finder
- Quote search state lives alongside main search state in `App.tsx`
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

- React's JSX escaping handles most XSS vectors—never bypass it with raw HTML injection
- Validate URLs with `isValidBskyUrl()` before rendering as links
- Escape regex special chars in user input (see pattern in `highlightText()`)
- Never construct HTML strings from user data

## Environment Variables

Backend requires (set in Vercel dashboard):
- `BSKY_HANDLE` - Bluesky account handle
- `BSKY_APP_PASSWORD` - App-specific password (not main password)

## Common Tasks

### Adding a new search filter
1. Add state variable in `App.tsx` (useState + useLatest if needed in callbacks)
2. Add UI control in the search form JSX
3. Wire filter logic into `recomputeDerivedPosts()` or `performSearch()`
4. If backend needs it, update `api/search.mjs` validation

### Adding a new theme color
1. Add `--color-*` token in `@theme` block in `src/frontend/index.css`
2. Add dark override in `[data-theme='dark']` section
3. Use the clean Tailwind utility in JSX (e.g., `bg-my-color`, `text-my-color`)

## Testing

Run `npm test` for the Vitest suite, or `npm run test:watch` for continuous mode. Run `npm run perf:smoke` for performance smoke tests. Then verify manually:
1. Search with various terms
2. Test filters (likes, time range)
3. Test auto-refresh feature
4. Test quote finder with a real Bluesky post URL
5. Toggle themes (light/dark/system)

Test configuration uses two Vitest projects:
- `node` environment — pure function tests (`tests/app.test.js`, `tests/search.test.js`)
- `jsdom` environment — React component tests (`tests/frontend/*.test.tsx`)

Cache internals are testable via `testUtils` export from `api.ts` (exposes `didCache`, `searchCache`, `getCachedDid`, `enforceSearchCacheLimit`, `enforceDidCacheLimit`).

## Debugging

- 401 errors: Session expired, check `refreshOrCreateSession()` flow in api/search.mjs
- Duplicate posts: Check `deduplicatePosts()` and URI-based dedup logic in utils.ts
- Missing quotes: Verify `quoteSeenCursorsRef` isn't blocking valid cursors in App.tsx
- Missing posts: Search API filters to English only (`lang: 'en'` in api/search.mjs)
- Stale closures: If timer/interval callbacks read stale state, ensure the value is passed through `useLatest()`

## Git Workflow

- Branch naming: `vumehta/<descriptive-name>`
- Main branch: `main`
- Keep commits focused on single changes
- Build output (`dist/`) is gitignored—Vercel builds on deploy

## Gotchas

- Strict CSP in vercel.json—no inline scripts/styles, limited connect-src (self + public.api.bsky.app only)
- Session refresh has race condition protection via `sessionPromise`—don't bypass this pattern
- Auto-refresh timer uses setInterval; remember to clear on search changes
- Quote finder needs post URI, not post URL—conversion happens in `performQuoteSearch()`
- Search results are English-only due to hardcoded `lang: 'en'` parameter
- `useLatest` uses synchronous ref assignment (not useEffect)—ensures ref is current before any effects run, but eager `ref.current = x` writes in callbacks are still needed for same-tick concurrent access
- `perf:smoke` runs via `npx tsx` to support TypeScript imports from `src/frontend/`
