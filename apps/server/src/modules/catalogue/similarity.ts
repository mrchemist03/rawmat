import type { SimilarityReport } from "@rawmat/shared"

export function normalizeMaterialName(value: string) {
  return value.normalize("NFKC").toLowerCase()
    .replace(/[\p{M}\u0640]/gu, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
    .replace(/[٠-٩۰-۹]/g, (digit) => String(digit.charCodeAt(0) & 15))
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}

export const defaultThresholds = { warning: 0.6, high: 0.85 }
export type SimilarityThresholds = typeof defaultThresholds
type Candidate = { id: string; name: string; code: string; nameNormalized: string; unitId: string; archived: boolean }

function features(normalized: string) {
  const tokens = new Set(normalized.split(" ").map((word) => word.length > 4 ? word.replace(/^ال/u, "") : word))
  const canonical = [...tokens].sort().join(" ")
  const letters = [...`  ${canonical}  `]
  const grams = new Set(letters.slice(0, -2).map((letter, index) => letter + letters[index + 1] + letters[index + 2]))
  return { tokens, grams, canonical }
}

export function similarityIndex(rows: Candidate[], thresholds: SimilarityThresholds) {
  const exact = new Map<string, Candidate[]>()
  const active: { row: Candidate; features: ReturnType<typeof features> }[] = []
  const byGram = new Map<string, number[]>()
  const byToken = new Map<string, number[]>()
  const exactKey = (normalized: string, unitId: string) => `${unitId}:${normalized}`
  function add(row: Candidate) {
    const key = exactKey(row.nameNormalized, row.unitId)
    const previous = exact.get(key) ?? []
    previous.push(row)
    exact.set(key, previous)
    if (row.archived || !row.nameNormalized) return
    const descriptor = features(row.nameNormalized)
    const position = active.push({ row, features: descriptor }) - 1
    for (const [lookup, values] of [[byGram, descriptor.grams], [byToken, descriptor.tokens]] as const) {
      for (const feature of values) {
        const positions = lookup.get(feature) ?? []
        positions.push(position)
        lookup.set(feature, positions)
      }
    }
  }
  for (const row of rows) add(row)
  return {
    add,
    check(normalized: string, unitId: string, exclude?: string): SimilarityReport {
      const duplicate = exact.get(exactKey(normalized, unitId))?.find((row) => row.id !== exclude)
      if (duplicate) {
        const { id, name, code, archived } = duplicate
        return { level: "exact", matches: [{ id, name, code, archived, score: 1 }] }
      }
      const descriptor = features(normalized)
      const candidates = new Map<number, { grams: number; tokens: number }>()
      for (const [lookup, values, field] of [
        [byGram, descriptor.grams, "grams"], [byToken, descriptor.tokens, "tokens"],
      ] as const) {
        for (const feature of values) {
          for (const position of lookup.get(feature) ?? []) {
            const hits = candidates.get(position) ?? { grams: 0, tokens: 0 }
            hits[field]++
            candidates.set(position, hits)
          }
        }
      }
      const matches: SimilarityReport["matches"] = []
      for (const [index, hits] of candidates) {
        const entry = active[index]
        if (!entry || entry.row.id === exclude) continue
        const gramScore = 2 * hits.grams / (descriptor.grams.size + entry.features.grams.size)
        const tokenScore = 2 * hits.tokens / (descriptor.tokens.size + entry.features.tokens.size)
        const score = descriptor.canonical === entry.features.canonical ? 1 :
          Math.max(gramScore, 0.55 * gramScore + 0.45 * tokenScore)
        if (score < thresholds.warning) continue
        const { id, name, code, archived } = entry.row
        matches.push({ id, name, code, archived, score })
      }
      matches.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code))
      const score = matches[0]?.score ?? 0
      return { level: score >= thresholds.high ? "high" : score >= thresholds.warning ? "warning" : "clear", matches: matches.slice(0, 5) }
    },
  }
}
