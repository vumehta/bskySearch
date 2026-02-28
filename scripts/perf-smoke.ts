import { deduplicatePosts, filterByDate, filterByLikes, sortPosts } from '../src/utils';
import type { BskyPost, SortMode } from '../src/types';
import { performance } from 'node:perf_hooks';

function createPost(uri: string, term: string, likeCount: number, indexedAtOffsetHours: number): BskyPost {
  const indexedAt = new Date(Date.now() - indexedAtOffsetHours * 3600000).toISOString();
  return {
    uri,
    matchedTerm: term,
    likeCount,
    indexedAt,
    author: { did: '', handle: 'perf-user' },
    record: { text: `text for ${term}` },
  };
}

function buildTermResults(termCount: number = 10, postsPerTerm: number = 160, overlapFactor: number = 0.35): BskyPost[][] {
  const results: BskyPost[][] = [];
  const sharedCount = Math.floor(postsPerTerm * overlapFactor);
  const sharedUris = Array.from({ length: sharedCount }, (_, i) => `at://shared/${i}`);

  for (let termIndex = 0; termIndex < termCount; termIndex += 1) {
    const term = `term-${termIndex}`;
    const posts: BskyPost[] = [];

    for (let postIndex = 0; postIndex < postsPerTerm; postIndex += 1) {
      const usesShared = postIndex < sharedCount;
      const uri = usesShared ? sharedUris[postIndex] : `at://${term}/${postIndex - sharedCount}`;
      posts.push(createPost(uri, term, (postIndex * 7 + termIndex) % 500, postIndex % 72));
    }

    results.push(posts);
  }

  return results;
}

function cloneResults(results: BskyPost[][]): BskyPost[][] {
  return results.map((posts) =>
    posts.map((post) => ({
      ...post,
      author: { ...post.author },
      record: { ...post.record },
    }))
  );
}

function legacyProgressiveMerge(results: BskyPost[][], hours: number = 24, minLikes: number = 10, sortMode: SortMode = 'top'): BskyPost[] {
  let allPosts: BskyPost[] = [];

  for (const termPosts of results) {
    let combined = deduplicatePosts([...allPosts, ...termPosts]);
    combined = filterByDate(combined, hours);
    combined = filterByLikes(combined, minLikes);
    allPosts = sortPosts(combined, sortMode);
  }

  return allPosts;
}

function mergeTermArrays(existingTerms: string[], incomingTerms: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  const add = (value: string): void => {
    if (!value) return;
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    merged.push(value);
  };

  existingTerms.forEach(add);
  incomingTerms.forEach(add);
  return merged;
}

function optimizedIngestThenDerive(results: BskyPost[][], hours: number = 24, minLikes: number = 10, sortMode: SortMode = 'top'): BskyPost[] {
  const store = new Map<string, BskyPost>();

  for (const termPosts of results) {
    for (const post of termPosts) {
      const existing = store.get(post.uri);
      if (!existing) {
        store.set(post.uri, {
          ...post,
          matchedTerms: post.matchedTerm ? [post.matchedTerm] : [],
        });
        continue;
      }

      const incomingTerms = post.matchedTerm ? [post.matchedTerm] : [];
      existing.matchedTerms = mergeTermArrays(existing.matchedTerms || [], incomingTerms);
    }
  }

  let derived = Array.from(store.values());
  derived = filterByDate(derived, hours);
  derived = filterByLikes(derived, minLikes);
  return sortPosts(derived, sortMode);
}

function createCachedHighlightMatcher(terms: string[]): (text: string) => number {
  const escapedTerms = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escapedTerms.join('|')})`, 'gi');
  const termSet = new Set(terms.map((term) => term.toLowerCase()));

  return (text: string): number => {
    const parts = text.split(regex);
    let hits = 0;
    for (const part of parts) {
      if (termSet.has(part.toLowerCase())) {
        hits += 1;
      }
    }
    return hits;
  };
}

function legacyHighlightMatch(text: string, terms: string[]): number {
  const escapedTerms = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escapedTerms.join('|')})`, 'gi');
  const parts = text.split(regex);
  let hits = 0;
  for (const part of parts) {
    if (terms.some((term) => part.toLowerCase() === term.toLowerCase())) {
      hits += 1;
    }
  }
  return hits;
}

function runOrderedPair(runIndex: number, legacyFn: () => void, optimizedFn: () => void): { legacyDuration: number; optimizedDuration: number } {
  let legacyDuration = 0;
  let optimizedDuration = 0;

  if (runIndex % 2 === 0) {
    let start = performance.now();
    legacyFn();
    legacyDuration = performance.now() - start;

    start = performance.now();
    optimizedFn();
    optimizedDuration = performance.now() - start;
  } else {
    let start = performance.now();
    optimizedFn();
    optimizedDuration = performance.now() - start;

    start = performance.now();
    legacyFn();
    legacyDuration = performance.now() - start;
  }

  return { legacyDuration, optimizedDuration };
}

function benchmarkSearchMerge(): { runs: number; avgLegacyMs: number; avgOptimizedMs: number; speedup: number } {
  const warmupRuns = 8;
  const runs = 50;
  const baseResults = buildTermResults();
  let legacyMs = 0;
  let optimizedMs = 0;

  for (let run = 0; run < warmupRuns; run += 1) {
    const legacyInput = cloneResults(baseResults);
    const optimizedInput = cloneResults(baseResults);
    runOrderedPair(
      run,
      () => legacyProgressiveMerge(legacyInput),
      () => optimizedIngestThenDerive(optimizedInput)
    );
  }

  for (let run = 0; run < runs; run += 1) {
    const legacyInput = cloneResults(baseResults);
    const optimizedInput = cloneResults(baseResults);
    const { legacyDuration, optimizedDuration } = runOrderedPair(
      run,
      () => legacyProgressiveMerge(legacyInput),
      () => optimizedIngestThenDerive(optimizedInput)
    );
    legacyMs += legacyDuration;
    optimizedMs += optimizedDuration;
  }

  return {
    runs,
    avgLegacyMs: legacyMs / runs,
    avgOptimizedMs: optimizedMs / runs,
    speedup: legacyMs / optimizedMs,
  };
}

function benchmarkHighlighting(): { runs: number; avgLegacyMs: number; avgCurrentMs: number; speedup: number } {
  const warmupRuns = 40;
  const runs = 500;
  const terms = Array.from({ length: 28 }, (_, index) => `term${index}`);
  const text = Array.from({ length: 120 }, (_, index) => `token${index % 25} term${index % 28}`).join(
    ' '
  );
  const cachedMatcher = createCachedHighlightMatcher(terms);
  let legacyMs = 0;
  let currentMs = 0;

  for (let run = 0; run < warmupRuns; run += 1) {
    runOrderedPair(
      run,
      () => legacyHighlightMatch(text, terms),
      () => cachedMatcher(text)
    );
  }

  for (let run = 0; run < runs; run += 1) {
    const { legacyDuration, optimizedDuration } = runOrderedPair(
      run,
      () => legacyHighlightMatch(text, terms),
      () => cachedMatcher(text)
    );
    legacyMs += legacyDuration;
    currentMs += optimizedDuration;
  }

  return {
    runs,
    avgLegacyMs: legacyMs / runs,
    avgCurrentMs: currentMs / runs,
    speedup: legacyMs / currentMs,
  };
}

function formatMs(value: number): string {
  return `${value.toFixed(3)}ms`;
}

function runSmokeCheck(): void {
  const searchMerge = benchmarkSearchMerge();
  const highlighting = benchmarkHighlighting();

  console.log('Performance smoke check');
  console.log('-----------------------');
  console.log(
    `Search merge: legacy ${formatMs(searchMerge.avgLegacyMs)} vs optimized ${formatMs(
      searchMerge.avgOptimizedMs
    )} (speedup ${searchMerge.speedup.toFixed(2)}x)`
  );
  console.log(
    `Highlighting: legacy ${formatMs(highlighting.avgLegacyMs)} vs optimized ${formatMs(
      highlighting.avgCurrentMs
    )} (speedup ${highlighting.speedup.toFixed(2)}x)`
  );

  const regressions: string[] = [];
  if (searchMerge.speedup < 1.1) {
    regressions.push('Search merge optimization is below expected speedup threshold (1.10x).');
  }
  if (highlighting.speedup < 1.1) {
    regressions.push('Highlight optimization is below expected speedup threshold (1.10x).');
  }

  if (regressions.length > 0) {
    regressions.forEach((message) => console.error(message));
    process.exitCode = 1;
    return;
  }

  console.log('Perf smoke check passed.');
}

runSmokeCheck();
