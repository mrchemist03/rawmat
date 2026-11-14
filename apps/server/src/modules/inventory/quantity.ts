import { Decimal } from "decimal.js"

// Preserve sums of accepted JSON numbers, including subnormal quantities.
export const Quantity = Decimal.clone({ precision: 350, rounding: Decimal.ROUND_HALF_UP })
