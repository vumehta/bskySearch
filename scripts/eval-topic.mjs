import { readFile } from 'node:fs/promises';
import { POST } from '../api/classify.mjs';
import { TOPIC_SCORE_THRESHOLD } from '../src/constants.mjs';
import { TOPIC_LIMITS } from '../src/topic-context.mjs';

async function classifyBatch(batch) {
  const response = await POST(new Request('http://localhost/api/classify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: batch.map(({ id, keyword, context }) => ({ id, keywords: [keyword], context })),
    }),
  }));
  const payload = await response.json();
  if (!response.ok) throw new Error(`Evaluation failed (${response.status}): ${payload.error}`);
  return payload.results;
}

if (!process.env.TYPESAFE_API_KEY) {
  console.error('Set TYPESAFE_API_KEY in the environment to evaluate the topic filter with real Jev answers.');
  process.exitCode = 1;
} else {
  const cases = JSON.parse(await readFile(new URL('../tests/fixtures/topic-eval.json', import.meta.url), 'utf8'));
  console.log(`Evaluating ${cases.length} examples with ${process.env.TYPESAFE_MODEL || 'jev-latest'} (live API calls).`);
  try {
    const scores = new Map();
    for (let start = 0; start < cases.length; start += TOPIC_LIMITS.maxItems) {
      for (const { id, scores: [score] } of await classifyBatch(cases.slice(start, start + TOPIC_LIMITS.maxItems))) {
        scores.set(id, score);
      }
    }
    const results = cases.map(({ id, keep }) => {
      const score = scores.get(id);
      const usable = Number.isFinite(score) && score >= 0 && score <= 1;
      const actual = usable ? score >= TOPIC_SCORE_THRESHOLD : null;
      return { case: id, expected: keep ? 'keep' : 'hide', score, actual: actual === null ? 'unscored' : actual ? 'keep' : 'hide', pass: actual === keep };
    });
    console.table(results);
    const passed = results.filter(({ pass }) => pass).length;
    console.log(`${passed}/${results.length} examples match their labels at threshold ${TOPIC_SCORE_THRESHOLD}.`);
    if (passed !== results.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
