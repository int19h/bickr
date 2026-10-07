/** A text estimate with a separate allowance for non-ASCII bytes.
 * Model calibration stays in tokens per UTF-16 code unit. A sample from English
 * cannot lower the non-ASCII allowance when the next prompt changes language.
 * Exact provider counts still take precedence over this estimate.
 */
export function textTokenWeight(text: string, tokensPerCharacter = 0.25): number {
	let weight = 0;
	for (const character of text) {
		const point = character.codePointAt(0)!;
		if (point < 0x80) weight += tokensPerCharacter;
		else {
			const bytes = point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
			weight += Math.max(character.length * tokensPerCharacter, bytes / 2);
		}
	}
	return weight;
}

export function approximateTextTokens(text: string, tokensPerCharacter = 0.25): number {
	return Math.max(1, Math.ceil(textTokenWeight(text, tokensPerCharacter)));
}
