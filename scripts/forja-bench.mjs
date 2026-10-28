// Benchmark determinista de computeForja; correrlo al cambiar sus cálculos o fechas.
import { performance } from 'node:perf_hooks';

import { computeForja } from '../src/modules/forja/compute.js';

const NOW = new Date('2026-10-28T17:30:00.000Z');
const RUNS = 5;
const scenarios = [
  { name: '3×85', players: 3, prs: 85, budget: 20 },
  { name: '3×300', players: 3, prs: 300, budget: 50 },
  { name: '10×300', players: 10, prs: 300, budget: 150 },
];

function dataset(playerCount, prsPerPlayer) {
  const players = Array.from({ length: playerCount }, (_, index) => ({
    username: `player-${index + 1}`,
    login: `forja-player-${index + 1}`,
    displayName: `Jugador ${index + 1}`,
  }));
  const prsByUsername = new Map(players.map((player, playerIndex) => {
    const prs = Array.from({ length: prsPerPlayer }, (_, index) => {
      const mergedAt = new Date(Date.UTC(2025, 0, 1 + index, (index * 7 + playerIndex) % 24, index % 60));
      const createdAt = new Date(mergedAt.getTime() - ((index % 180) + 1) * 60_000);
      return {
        number: playerIndex * 10_000 + index + 1,
        title: index % 4 === 0 ? `TASK-${index + 1} Desk #${index + 100}` : `Cambio ${index + 1}`,
        mergedAt: mergedAt.toISOString(),
        createdAt: createdAt.toISOString(),
        additions: (index * 37 + playerIndex) % 2500,
        deletions: (index * 11 + playerIndex) % 700,
        headRefName: `feature/player-${playerIndex + 1}-${index + 1}`,
        url: `https://example.invalid/pull/${playerIndex * 10_000 + index + 1}`,
        playerLogin: player.login,
        attributedFrom: index % 9 === 0 ? 'bot-branch' : 'author',
      };
    });
    return [player.username, prs];
  }));
  return { players, prsByUsername };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure({ players: playerCount, prs: prsPerPlayer }) {
  const { players, prsByUsername } = dataset(playerCount, prsPerPlayer);
  computeForja(players, prsByUsername, { now: NOW });
  const durations = Array.from({ length: RUNS }, () => {
    const start = performance.now();
    computeForja(players, prsByUsername, { now: NOW });
    return performance.now() - start;
  });
  return median(durations);
}

const results = scenarios.map((scenario) => {
  const duration = measure(scenario);
  return { ...scenario, duration, ok: duration <= scenario.budget };
});

console.log('escenario | mediana ms | presupuesto ms | OK/EXCEDE');
console.log('----------|------------|----------------|----------');
for (const result of results) {
  console.log(`${result.name} | ${result.duration.toFixed(2)} | ${result.budget} | ${result.ok ? 'OK' : 'EXCEDE'}`);
}

if (!process.argv.includes('--no-fail') && results.some((result) => !result.ok)) {
  process.exitCode = 1;
}
