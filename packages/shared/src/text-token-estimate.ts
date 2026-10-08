/** Rough text estimate in UTF-16 code units, matching provider calibration samples.
 * Reported provider usage refines the ratio for every script. A fixed script
 * minimum would override those measurements after compaction changes history.
 */
export function approximateTextTokens(text: string, tokensPerCharacter = 0.25): number {
	return Math.max(1, Math.ceil(text.length * tokensPerCharacter));
}
