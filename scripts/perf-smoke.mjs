import { deduplicatePosts, filterByDate, filterByLikes, sortPosts } from '../src/utils.mjs';
import { performance } from 'node:perf_hooks';

function createPost(uri, term, likeCount, indexedAtOffsetHours) {
  const indexedAt = new Date(Date.now() - indexedAtOffsetHours * 3600000).toISOString();
  return {
    uri,
    matchedTerm: term,
    likeCount,
    indexedAt,
    author: { handle: 'perf-user' },
    record: { text: `text for ${term}` },
  };
}

function buildTermResults(termCount = 10, postsPerTerm = 160, overlapFactor = 0.35) {
  const results = [];
  const sharedCount = Math.floor(postsPerTerm * overlapFactor);
  const sharedUris = Array.from({ length: sharedCount }, (_, i) => `at://shared/${i}`);

  for (let termIndex = 0; termIndex < termCount; termIndex += 1) {
    const term = `term-${termIndex}`;
    const posts = [];

    for (let postIndex = 0; postIndex < postsPerTerm; postIndex += 1) {
      const usesShared = postIndex < sharedCount;
      const uri = usesShared ? sharedUris[postIndex] : `at://${term}/${postIndex - sharedCount}`;
      posts.push(createPost(uri, term, (postIndex * 7 + termIndex) % 500, postIndex % 72));
    }

    results.push(posts);
  }

  return results;
}

function cloneResults(results) {
  return results.map((posts) =>
    posts.map((post) => ({
      ...post,
      author: { ...post.author },
      record: { ...post.record },
    }))
  );
}

function legacyProgressiveMerge(results, hours = 24, minLikes = 10, sortMode = 'top') {
  let allPosts = [];

  for (const termPosts of results) {
    let combined = deduplicatePosts([...allPosts, ...termPosts]);
    combined = filterByDate(combined, hours);
    combined = filterByLikes(combined, minLikes);
    allPosts = sortPosts(combined, sortMode);
  }

  return allPosts;
}

function mergeTermArrays(existingTerms, incomingTerms) {
  const seen = new Set();
  const merged = [];

  const add = (value) => {
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

function optimizedIngestThenDerive(results, hours = 24, minLikes = 10, sortMode = 'top') {
  const store = new Map();

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

function currentHighlightMatch(text, terms) {
  const escapedTerms = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escapedTerms.join('|')})`, 'gi');
  const termSet = new Set(terms.map((term) => term.toLowerCase()));
  const parts = text.split(regex);
  let hits = 0;
  for (const part of parts) {
    if (termSet.has(part.toLowerCase())) {
      hits += 1;
    }
  }
  return hits;
}

function legacyHighlightMatch(text, terms) {
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

function benchmarkSearchMerge() {
  const runs = 50;
  const baseResults = buildTermResults();
  let legacyMs = 0;
  let optimizedMs = 0;

  for (let run = 0; run < runs; run += 1) {
    const legacyInput = cloneResults(baseResults);
    const optimizedInput = cloneResults(baseResults);

    let start = performance.now();
    legacyProgressiveMerge(legacyInput);
    legacyMs += performance.now() - start;

    start = performance.now();
    optimizedIngestThenDerive(optimizedInput);
    optimizedMs += performance.now() - start;
  }

  return {
    runs,
    avgLegacyMs: legacyMs / runs,
    avgOptimizedMs: optimizedMs / runs,
    speedup: legacyMs / optimizedMs,
  };
}

function benchmarkHighlighting() {
  const runs = 500;
  const terms = Array.from({ length: 28 }, (_, index) => `term${index}`);
  const text = Array.from({ length: 120 }, (_, index) => `token${index % 25} term${index % 28}`).join(
    ' '
  );
  let legacyMs = 0;
  let currentMs = 0;

  for (let run = 0; run < runs; run += 1) {
    let start = performance.now();
    legacyHighlightMatch(text, terms);
    legacyMs += performance.now() - start;

    start = performance.now();
    currentHighlightMatch(text, terms);
    currentMs += performance.now() - start;
  }

  return {
    runs,
    avgLegacyMs: legacyMs / runs,
    avgCurrentMs: currentMs / runs,
    speedup: legacyMs / currentMs,
  };
}

function formatMs(value) {
  return `${value.toFixed(3)}ms`;
}

function runSmokeCheck() {
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

  const regressions = [];
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
