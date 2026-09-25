import { readFile } from 'node:fs/promises';
import { POST } from '../api/classify.mjs';
import { TOPIC_MENTION_THRESHOLD, TOPIC_SCORE_THRESHOLD } from '../src/constants.mjs';
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
    const answers = new Map();
    for (let start = 0; start < cases.length; start += TOPIC_LIMITS.maxItems) {
      for (const { id, scores: [score], mentionScores: [mention] } of await classifyBatch(cases.slice(start, start + TOPIC_LIMITS.maxItems))) {
        answers.set(id, { score, mention });
      }
    }
    const judge = (value, threshold) => (Number.isFinite(value) && value >= 0 && value <= 1 ? value >= threshold : null);
    const results = cases.map(({ id, keep, mention: expectMention }) => {
      const { score, mention } = answers.get(id) || {};
      const actual = judge(score, TOPIC_SCORE_THRESHOLD);
      const row = { case: id, expected: keep ? 'keep' : 'hide', score, actual: actual === null ? 'unscored' : actual ? 'keep' : 'hide', mention };
      if (typeof expectMention !== 'boolean') return { ...row, pass: actual === keep };
      return { ...row, mentionExpected: expectMention ? 'yes' : 'no', pass: actual === keep && judge(mention, TOPIC_MENTION_THRESHOLD) === expectMention };
    });
    console.table(results);
    const passed = results.filter(({ pass }) => pass).length;
    console.log(`${passed}/${results.length} examples match their labels (topic threshold ${TOPIC_SCORE_THRESHOLD}, mention threshold ${TOPIC_MENTION_THRESHOLD}).`);
    if (passed !== results.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
