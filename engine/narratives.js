'use strict';

/** Lightweight narrative/theme tagger for memecoins — free, local heuristics. */

const THEMES = [
  { id: 'ai', re: /\b(ai|gpt|claude|agent|neural|llm|grok|openai|agi)\b/i, hot: 1.2 },
  { id: 'animal', re: /\b(cat|dog|pepe|frog|wojak|inu|shib|bonk|pup|kitten|duck|goat|bear|bull)\b/i, hot: 1.05 },
  { id: 'political', re: /\b(trump|maga|biden|harris|vote| Liber|politic|president)\b/i, hot: 1.1 },
  { id: 'celeb', re: /\b(elon|musk|drake|kanye|taylor|rogan|mrbeast)\b/i, hot: 1.05 },
  { id: 'tech', re: /\b(sol|solana|pump|dex|defi|nft|layer|l2|depin)\b/i, hot: 0.95 },
  { id: 'meme', re: /\b(meme|coin|moon|chad|based|sigma|gigachad|copium)\b/i, hot: 1.0 },
];

function tagCoin({ symbol, name } = {}) {
  const text = `${symbol || ''} ${name || ''}`;
  const tags = [];
  for (const t of THEMES) {
    if (t.re.test(text)) tags.push(t.id);
  }
  if (!tags.length) tags.push('other');
  return tags;
}

function narrativeHeat(tags, heatMap = {}) {
  let heat = 1;
  for (const t of tags) {
    const theme = THEMES.find((x) => x.id === t);
    const live = heatMap[t] != null ? heatMap[t] : theme ? theme.hot : 1;
    heat = Math.max(heat, live);
  }
  return heat;
}

/** Update heat from recent scanned symbols (frequency). */
function updateHeatMap(scanned = []) {
  const counts = {};
  for (const c of scanned) {
    for (const t of tagCoin(c)) {
      counts[t] = (counts[t] || 0) + 1;
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const heat = {};
  for (const [k, v] of Object.entries(counts)) {
    heat[k] = 0.85 + Math.min(0.5, (v / total) * 2);
  }
  return heat;
}

function exposureByNarrative(positions = []) {
  const out = {};
  for (const p of positions) {
    const tags = p.narratives || tagCoin(p);
    const share = Number(p.markValue || p.amountUsd || 0);
    for (const t of tags) {
      out[t] = (out[t] || 0) + share / Math.max(tags.length, 1);
    }
  }
  return out;
}

module.exports = { THEMES, tagCoin, narrativeHeat, updateHeatMap, exposureByNarrative };
