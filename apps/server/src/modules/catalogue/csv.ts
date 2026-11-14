import { parse } from "csv-parse/sync"
import { csvHeaders, csvRowLimit, materialInputSchema } from "@rawmat/shared"
import { z } from "zod"

const csvRowSchema = materialInputSchema.omit({ categoryId: true, unitId: true, supplierId: true }).extend({
  category: z.string().trim().min(1).max(120),
  unit: z.string().trim().min(1).max(120),
  supplier: z.string().trim().max(120),
})
export type CsvRow = z.infer<typeof csvRowSchema>

export function readMaterialsCsv(body: Buffer) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body)
    const records: string[][] = parse(text, {
      trim: true, skip_empty_lines: true, max_record_size: 16_384, to: csvRowLimit + 2,
    })
    const [header, ...rows] = records
    if (!header || header.length !== csvHeaders.length || csvHeaders.some((value, index) => value !== header[index]) ||
      rows.length === 0 || rows.length > csvRowLimit) return undefined
    return rows.map(([name, category, unit, supplier, minimum, notes], index) => {
      const minimumQuantity = minimum && /^\d+(?:\.\d+)?$/.test(minimum) ? Number(minimum) : NaN
      const parsed = csvRowSchema.safeParse({ name, category, unit, supplier, minimumQuantity, notes })
      return { row: index + 2, input: parsed.success ? parsed.data : undefined }
    })
  } catch {
    return undefined
  }
}
