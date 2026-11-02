'use strict';

/**
 * Narrative engine — detect trending themes from coin names/tickers + X/Dex heat,
 * score fit to hot narratives, first-mover bonus. Feeds learner features.
 */

const THEMES = [
  { id: 'ai', re: /\b(ai|gpt|claude|agent|neural|llm|grok|openai|agi|chatgpt)\b/i, hot: 1.2 },
  { id: 'animal', re: /\b(cat|dog|pepe|frog|wojak|inu|shib|bonk|pup|kitten|duck|goat|bear|bull|hamster)\b/i, hot: 1.05 },
  { id: 'political', re: /\b(trump|maga|biden|harris|vote|election|politic|president|potus)\b/i, hot: 1.15 },
  { id: 'celeb', re: /\b(elon|musk|drake|kanye|taylor|rogan|mrbeast|celebrity)\b/i, hot: 1.1 },
  { id: 'tech', re: /\b(sol|solana|pump|dex|defi|nft|layer|l2|depin|robot)\b/i, hot: 0.95 },
  { id: 'meme', re: /\b(meme|coin|moon|chad|based|sigma|gigachad|copium|skibidi|rizz)\b/i, hot: 1.0 },
  { id: 'finance', re: /\b(bank|fed|rates|inflation|recession|tariff|crypto)\b/i, hot: 1.05 },
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

function updateHeatMap(scanned = []) {
  const counts = {};
  for (const c of scanned) {
    for (const t of tagCoin(c)) counts[t] = (counts[t] || 0) + 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const heat = {};
  for (const [k, v] of Object.entries(counts)) {
    heat[k] = 0.85 + Math.min(0.55, (v / total) * 2.2);
  }
  return heat;
}

function exposureByNarrative(positions = []) {
  const out = {};
  for (const p of positions) {
    const tags = p.narratives || tagCoin(p);
    const share = Number(p.markValue || p.amountUsd || 0);
    for (const t of tags) out[t] = (out[t] || 0) + share / Math.max(tags.length, 1);
  }
  return out;
}

/**
 * Cluster recent symbols into emergent topics (beyond fixed THEMES) by shared tokens.
 */
function detectClusters(scanned = [], { minSize = 3 } = {}) {
  const tokenToMints = new Map();
  for (const c of scanned) {
    const text = `${c.symbol || ''} ${c.name || ''}`.toLowerCase();
    const parts = text.split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && w.length <= 16);
    for (const w of parts) {
      if (!tokenToMints.has(w)) tokenToMints.set(w, new Set());
      if (c.mint) tokenToMints.get(w).add(c.mint);
      tokenToMints.get(w).add(`${c.symbol || ''}|${c.name || ''}`);
    }
  }
  const clusters = [];
  for (const [token, set] of tokenToMints) {
    if (set.size >= minSize) {
      clusters.push({
        topic: token,
        n: set.size,
        heat: 0.9 + Math.min(0.6, set.size / 12),
      });
    }
  }
  clusters.sort((a, b) => b.n - a.n);
  return clusters.slice(0, 12);
}

/**
 * Score coin fit to currently hot narratives / clusters.
 * firstMover: early in a rising theme.
 */
function scoreNarrativeFit(pair, { heatMap = {}, clusters = [], themeFirstSeen = {} } = {}) {
  const tags = tagCoin(pair);
  const heat = narrativeHeat(tags, heatMap);
  let fit = Math.round((heat - 1) * 20); // 0–11-ish
  let firstMover = 0;
  const text = `${pair.symbol || ''} ${pair.name || ''}`.toLowerCase();
  for (const cl of clusters) {
    if (text.includes(cl.topic)) {
      fit = Math.max(fit, Math.round((cl.heat - 0.9) * 25));
      const key = `cl:${cl.topic}`;
      if (!themeFirstSeen[key]) {
        themeFirstSeen[key] = { mint: pair.mint, ts: Date.now() };
        firstMover = 8;
      } else if (themeFirstSeen[key].mint === pair.mint) {
        firstMover = Math.max(firstMover, 6);
      } else {
        const age = Date.now() - themeFirstSeen[key].ts;
        if (age < 5 * 60e3) firstMover = Math.max(firstMover, 3);
      }
    }
  }
  for (const t of tags) {
    if (t === 'other') continue;
    const key = `th:${t}`;
    if (!themeFirstSeen[key]) {
      themeFirstSeen[key] = { mint: pair.mint, ts: Date.now() };
      firstMover = Math.max(firstMover, heat > 1.15 ? 7 : 4);
    }
  }
  return {
    tags,
    narrativeFit: Math.max(0, Math.min(18, fit + Math.round(firstMover * 0.3))),
    firstMover,
    heat,
    note: tags.join(',') + (firstMover ? `·fm${firstMover}` : ''),
  };
}

module.exports = {
  THEMES,
  tagCoin,
  narrativeHeat,
  updateHeatMap,
  exposureByNarrative,
  detectClusters,
  scoreNarrativeFit,
};
