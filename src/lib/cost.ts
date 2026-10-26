// Prices are entered by the user per target ($ per 1 million tokens),
// so cost tracking works for any model from any provider.
export function calcCost(
  inputTokens: number,
  outputTokens: number,
  inputPricePerM: number | null,
  outputPricePerM: number | null,
): number | null {
  if (inputPricePerM == null && outputPricePerM == null) return null;
  return (inputTokens * (inputPricePerM ?? 0) + outputTokens * (outputPricePerM ?? 0)) / 1_000_000;
}
