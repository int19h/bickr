/**
 * Attribute schema of the inline SVG policy. Each permitted attribute has one
 * namespace and one value rule, and the DOMPurify allowlist derives from the
 * same table, so the two lists cannot drift apart.
 *
 * A rule parses the whole value. It rejects syntax outside its grammar, such
 * as a unit that the attribute does not take, because the policy must know
 * what it passes on. It does not enforce the semantic range of a value, such
 * as a negative radius or an opacity above one. Browsers ignore or clamp such
 * a value on that one attribute, which is harmless, while a rejection hides
 * the whole drawing. Numeric bounds exist only to keep values finite and to
 * bound rendering cost.
 */
export const svgNamespace = "http://www.w3.org/2000/svg";
export const xlinkNamespace = "http://www.w3.org/1999/xlink";
const xmlNamespace = "http://www.w3.org/XML/1998/namespace";
const xmlnsNamespace = "http://www.w3.org/2000/xmlns/";

/** The magnitude ceiling of every number in a drawing. */
const valueBound = 1_000_000;

type Unit = "" | "px" | "%" | "em";
type Range = readonly [min: number, max: number];
type Units = Partial<Record<Unit, Range>>;

type ValueRule =
	| { kind: "length"; units: Units; keywords?: readonly string[] }
	/** A list counts as geometry when it can hold one item per character. */
	| { kind: "lengthList"; units: Units; maxItems: number; geometry: boolean; keywords?: readonly string[] }
	| { kind: "points" }
	| { kind: "viewBox" }
	| { kind: "keyword"; values: readonly string[]; caseInsensitive?: boolean }
	| { kind: "fontWeight" }
	| { kind: "paint" }
	| { kind: "color" }
	| { kind: "fragmentUrl" }
	| { kind: "href" }
	| { kind: "idList" }
	| { kind: "path" }
	| { kind: "transform" }
	| { kind: "fontFamily" }
	| { kind: "aspectRatio" }
	| { kind: "paintOrder" }
	| { kind: "namespaceDeclaration"; value: string }
	| { kind: "id" }
	| { kind: "text"; maxLength: number };

type AttributeSpec = {
	namespace: string | null;
	rule: ValueRule;
	/** The rule on `text` and `tspan`, where some attributes take a list. */
	textRule?: ValueRule;
};

const any: Range = [-valueBound, valueBound];
const coordinate: Units = { "": any, px: any, "%": any };
/** Text positions also take em, which spaces lines by the font size. */
const textPosition: Units = { ...coordinate, em: any };
const fraction: Units = { "": any, "%": any };
const plainNumber: Units = { "": any };
const spacing: Units = { "": any, px: any, em: any };
/**
 * Relative font sizes compound through nested groups, up to the depth limit.
 * A small cap keeps the computed size finite: 4^32 times the base size.
 */
const fontSize: Units = { ...coordinate, "%": [-400, 400], em: [-4, 4] };
const units = ["userSpaceOnUse", "objectBoundingBox"] as const;
const baselines = ["auto", "baseline", "alphabetic", "ideographic", "middle", "central", "mathematical", "hanging", "text-top", "text-bottom", "text-before-edge", "text-after-edge", "before-edge", "after-edge"] as const;

function spec(rule: ValueRule, textRule?: ValueRule): AttributeSpec { return { namespace: null, rule, ...(textRule ? { textRule } : {}) }; }
const length = (u: Units, keywords?: readonly string[]): AttributeSpec => spec({ kind: "length", units: u, ...(keywords ? { keywords } : {}) });
const keyword = (...values: string[]): AttributeSpec => spec({ kind: "keyword", values });
const textPositions = (u: Units, scalar: Units): AttributeSpec => spec({ kind: "length", units: scalar }, { kind: "lengthList", units: u, maxItems: 1024, geometry: true });

const attributes = {
	xmlns: { namespace: xmlnsNamespace, rule: { kind: "namespaceDeclaration", value: svgNamespace } },
	"xmlns:xlink": { namespace: xmlnsNamespace, rule: { kind: "namespaceDeclaration", value: xlinkNamespace } },
	"xml:space": { namespace: xmlNamespace, rule: { kind: "keyword", values: ["default", "preserve"] } },
	id: spec({ kind: "id" }),
	role: spec({ kind: "keyword", values: ["img"] }),
	"aria-label": spec({ kind: "text", maxLength: 1000 }),
	"aria-labelledby": spec({ kind: "idList" }),
	"aria-describedby": spec({ kind: "idList" }),
	viewBox: spec({ kind: "viewBox" }),
	preserveAspectRatio: spec({ kind: "aspectRatio" }),
	transform: spec({ kind: "transform" }),
	gradientTransform: spec({ kind: "transform" }),
	d: spec({ kind: "path" }),
	points: spec({ kind: "points" }),
	x: textPositions(textPosition, coordinate), y: textPositions(textPosition, coordinate),
	dx: textPositions(textPosition, coordinate), dy: textPositions(textPosition, coordinate),
	rotate: spec({ kind: "lengthList", units: plainNumber, maxItems: 1024, geometry: true }),
	x1: length(coordinate), y1: length(coordinate), x2: length(coordinate), y2: length(coordinate),
	cx: length(coordinate), cy: length(coordinate), r: length(coordinate), rx: length(coordinate, ["auto"]), ry: length(coordinate, ["auto"]),
	fx: length(coordinate), fy: length(coordinate), fr: length(coordinate),
	width: length(coordinate), height: length(coordinate),
	offset: length(fraction),
	opacity: length(fraction), "fill-opacity": length(fraction), "stroke-opacity": length(fraction), "stop-opacity": length(fraction),
	"stroke-width": length(coordinate), "stroke-dashoffset": length(coordinate),
	"stroke-miterlimit": length(plainNumber), pathLength: length(plainNumber),
	"stroke-dasharray": spec({ kind: "lengthList", units: { "": any, px: any, "%": any }, maxItems: 64, geometry: false, keywords: ["none"] }),
	"font-size": length(fontSize),
	textLength: length(coordinate),
	"letter-spacing": length(spacing, ["normal"]), "word-spacing": length(spacing, ["normal"]),
	"baseline-shift": length(coordinate, ["baseline", "sub", "super"]),
	fill: spec({ kind: "paint" }), stroke: spec({ kind: "paint" }),
	color: spec({ kind: "color" }), "stop-color": spec({ kind: "color" }),
	"clip-path": spec({ kind: "fragmentUrl" }), mask: spec({ kind: "fragmentUrl" }),
	href: spec({ kind: "href" }),
	"xlink:href": { namespace: xlinkNamespace, rule: { kind: "href" } },
	"font-family": spec({ kind: "fontFamily" }),
	"font-weight": spec({ kind: "fontWeight" }),
	"font-style": keyword("normal", "italic", "oblique"),
	"text-anchor": keyword("start", "middle", "end"),
	"dominant-baseline": keyword(...baselines),
	"alignment-baseline": keyword(...baselines),
	"text-decoration": keyword("none", "underline", "overline", "line-through"),
	direction: keyword("ltr", "rtl"),
	// SVG 1.1 spellings still render in current browsers.
	"writing-mode": keyword("horizontal-tb", "vertical-rl", "vertical-lr", "lr", "lr-tb", "rl", "rl-tb", "tb", "tb-rl"),
	"paint-order": spec({ kind: "paintOrder" }),
	"fill-rule": keyword("nonzero", "evenodd"), "clip-rule": keyword("nonzero", "evenodd"),
	"stroke-linecap": keyword("butt", "round", "square"), "stroke-linejoin": keyword("miter", "miter-clip", "round", "bevel", "arcs"),
	"shape-rendering": keyword("auto", "optimizeSpeed", "crispEdges", "geometricPrecision"),
	"vector-effect": keyword("none", "non-scaling-stroke"),
	"color-interpolation": keyword("auto", "sRGB", "linearRGB"),
	gradientUnits: keyword(...units), clipPathUnits: keyword(...units), maskUnits: keyword(...units), maskContentUnits: keyword(...units),
	spreadMethod: keyword("pad", "reflect", "repeat"),
	lengthAdjust: keyword("spacing", "spacingAndGlyphs"),
} satisfies Record<string, AttributeSpec>;

const specs: ReadonlyMap<string, AttributeSpec> = new Map(Object.entries(attributes));
export const svgAttributeNames: readonly string[] = [...specs.keys()];

/** Resolves the spec of an attribute node, or null when the policy forbids it. */
export function attributeSpec(attr: Attr): AttributeSpec | null {
	const found = specs.get(attr.name);
	return found && found.namespace === attr.namespaceURI ? found : null;
}

function ruleFor(found: AttributeSpec, element: Element): ValueRule {
	return found.textRule && (element.localName === "text" || element.localName === "tspan") ? found.textRule : found.rule;
}

export type ValueCheck =
	| { kind: "valid" }
	| { kind: "invalid"; reason: string }
	/**
	 * A local fragment reference. `drawsTarget` says whether the target adds
	 * its geometry where the reference appears, which labels do not.
	 */
	| { kind: "reference"; ids: readonly string[]; drawsTarget: boolean; rewrite: (prefixed: readonly string[]) => string };

/** XML whitespace. JavaScript `\s` also matches characters that SVG does not treat as separators. */
const ws = "[\\t\\n\\r ]";
const numberSource = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
const dimension = new RegExp(`^(${numberSource})(px|%|em)?$`, "i");
const separator = new RegExp(`${ws}*,${ws}*|${ws}+`);
const name = "[A-Za-z_][\\w.-]*";

function trimXml(value: string): string { return value.replace(new RegExp(`^${ws}+|${ws}+$`, "g"), ""); }

/** Splits an SVG list: items separated by whitespace or by one comma. */
function listItems(value: string): string[] | null {
	const trimmed = trimXml(value);
	if (!trimmed) return null;
	const items = trimmed.split(separator);
	return items.every(Boolean) ? items : null;
}

function finite(token: string, range: Range = any): boolean {
	const number = Number(token);
	return Number.isFinite(number) && number >= range[0] && number <= range[1];
}

function plainNumbers(value: string, range: Range = any): number[] | null {
	const items = listItems(value);
	if (!items?.every((item) => new RegExp(`^${numberSource}$`).test(item) && finite(item, range))) return null;
	return items.map(Number);
}

function lengthValue(value: string, allowed: Units): boolean {
	const match = dimension.exec(value);
	if (!match) return false;
	const range = allowed[(match[2]?.toLowerCase() ?? "") as Unit];
	return Boolean(range) && finite(match[1]!, range);
}

const namedColors = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent currentcolor").split(" "));

/**
 * CSS colors without CSS-wide keywords, variables or math: a named color,
 * `currentColor`, a hex color, or an rgb() or hsl() function in the comma or
 * the space syntax. `currentColor` reads the inherited page text color.
 */
function color(value: string): boolean {
	const trimmed = trimXml(value);
	// The earlier grammar accepted `inherit`, which only copies the parent value.
	if (trimmed === "inherit" || namedColors.has(trimmed.toLowerCase())) return true;
	if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(trimmed)) return true;
	const call = /^(rgba?|hsla?)\(([^()]*)\)$/i.exec(trimmed);
	if (!call) return false;
	const hue = call[1]!.toLowerCase().startsWith("h");
	const inner = trimXml(call[2]!);
	let channels: string[]; let alpha: string | undefined;
	if (inner.includes(",")) {
		const parts = inner.split(new RegExp(`${ws}*,${ws}*`));
		if (parts.length !== 3 && parts.length !== 4) return false;
		[channels, alpha] = [parts.slice(0, 3), parts[3]];
	} else {
		const [main, rest, ...extra] = inner.split(new RegExp(`${ws}*/${ws}*`));
		if (extra.length || main === undefined) return false;
		channels = main.split(new RegExp(`${ws}+`));
		if (channels.length !== 3) return false;
		alpha = rest;
	}
	const component = (token: string, units: Units) => token !== "" && lengthValue(token, units);
	const channelsValid = hue
		? component(channels[0]!.replace(/deg$/i, ""), plainNumber) && channels.slice(1).every((token) => component(token, { "%": any, "": any }))
		: channels.every((token) => component(token, fraction));
	return channelsValid && (alpha === undefined || component(alpha, fraction));
}

function fragment(value: string, pattern: RegExp): string | null {
	return pattern.exec(trimXml(value))?.[1] ?? null;
}
const urlReference = new RegExp(`^url\\(#(${name})\\)$`);
const hrefReference = new RegExp(`^#(${name})$`);

const transformArguments: Record<string, readonly number[]> = { matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1] };
const transformFunction = new RegExp(`^(matrix|translate|scale|rotate|skewX|skewY)${ws}*\\(([^()]*)\\)`);
/** Functions are separated by whitespace, by one comma, or by nothing. */
const transformSeparator = new RegExp(`^${ws}*,${ws}*|^${ws}*`);

function transformList(value: string): boolean {
	let rest = trimXml(value);
	for (;;) {
		const match = transformFunction.exec(rest);
		if (!match) return false;
		const args = plainNumbers(match[2]!);
		if (!args || !transformArguments[match[1]!]!.includes(args.length)) return false;
		rest = rest.slice(match[0].length);
		if (!rest) return true;
		// A separator must lead to another function.
		rest = rest.slice(transformSeparator.exec(rest)![0].length);
	}
}

const pathData = /^[MmZzLlHhVvCcSsQqTtAa\d\t\n\r .,eE+\-]*$/;
const numberTokens = new RegExp(numberSource, "g");

function check(rule: ValueRule, value: string): ValueCheck {
	const valid: ValueCheck = { kind: "valid" };
	const invalid = (reason: string): ValueCheck => ({ kind: "invalid", reason });
	const trimmed = trimXml(value);
	switch (rule.kind) {
		case "length":
			return rule.keywords?.includes(trimmed) || lengthValue(trimmed, rule.units) ? valid : invalid("must be a bounded number");
		case "lengthList": {
			if (rule.keywords?.includes(trimmed)) return valid;
			const items = listItems(value);
			return items && items.length <= rule.maxItems && items.every((item) => lengthValue(item, rule.units)) ? valid : invalid("must contain bounded numbers");
		}
		case "points": {
			const numbers = plainNumbers(value);
			return numbers && numbers.length % 2 === 0 ? valid : invalid("must contain coordinate pairs");
		}
		case "viewBox": {
			const numbers = plainNumbers(value);
			return numbers?.length === 4 && numbers[2]! > 0 && numbers[3]! > 0 ? valid : invalid("must contain four numbers with positive dimensions");
		}
		case "keyword":
			return rule.values.includes(trimmed) ? valid : invalid("value is not supported");
		case "fontWeight":
			return ["normal", "bold", "bolder", "lighter"].includes(trimmed) || (/^\d+(?:\.\d+)?$/.test(trimmed) && finite(trimmed, [1, 1000])) ? valid : invalid("value is not supported");
		case "color":
			return color(value) ? valid : invalid("must be a color");
		case "paint": {
			if (trimmed === "none" || color(value)) return valid;
			const id = fragment(value, urlReference);
			return id ? { kind: "reference", ids: [id], drawsTarget: true, rewrite: ([target]) => `url(#${target})` } : invalid("must be a color or a local gradient");
		}
		case "fragmentUrl": {
			if (trimmed === "none") return valid;
			const id = fragment(value, urlReference);
			return id ? { kind: "reference", ids: [id], drawsTarget: true, rewrite: ([target]) => `url(#${target})` } : invalid("must use a local fragment reference");
		}
		case "href": {
			const id = fragment(value, hrefReference);
			return id ? { kind: "reference", ids: [id], drawsTarget: true, rewrite: ([target]) => `#${target}` } : invalid("must use a local fragment reference");
		}
		case "idList": {
			const ids = trimmed.split(new RegExp(`${ws}+`));
			return ids.every((id) => new RegExp(`^${name}$`).test(id)) ? { kind: "reference", ids, drawsTarget: false, rewrite: (targets) => targets.join(" ") } : invalid("must list local IDs");
		}
		case "path":
			return pathData.test(value) && (value.match(numberTokens) ?? []).every((token) => finite(token)) ? valid : invalid("must be path data with bounded numbers");
		case "transform":
			return transformList(value) ? valid : invalid("must be a list of transform functions");
		case "fontFamily":
			return /^[\p{Letter}\p{Number}\s,'"_-]{1,150}$/u.test(value) ? valid : invalid("must be a list of font names");
		case "aspectRatio":
			return new RegExp(`^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?:${ws}+(?:meet|slice))?$`).test(trimmed) ? valid : invalid("must be an alignment keyword with optional meet or slice");
		case "paintOrder": {
			if (trimmed === "normal") return valid;
			const tokens = trimmed.split(new RegExp(`${ws}+`));
			return tokens.length <= 3 && new Set(tokens).size === tokens.length && tokens.every((token) => ["fill", "stroke", "markers"].includes(token)) ? valid : invalid("value is not supported");
		}
		case "namespaceDeclaration":
			return value === rule.value ? valid : invalid("must declare its standard namespace");
		case "id":
			return new RegExp(`^${name}$`).test(value) ? valid : invalid("must be a simple name");
		case "text":
			return value.length <= rule.maxLength ? valid : invalid("exceeds the rendering limit");
	}
}

export function checkAttribute(found: AttributeSpec, element: Element, value: string): ValueCheck {
	return check(ruleFor(found, element), value);
}

/**
 * Bytes of an element's attributes that scale with drawn geometry. The
 * source budget and the reference expansion budget both use this count.
 */
export function attributeGeometryBytes(element: Element): number {
	let bytes = 0;
	for (const attr of Array.from(element.attributes)) {
		const found = attributeSpec(attr);
		if (!found) continue;
		const rule = ruleFor(found, element);
		if (rule.kind === "path" || rule.kind === "points" || (rule.kind === "lengthList" && rule.geometry)) bytes += attr.value.length;
	}
	return bytes;
}
