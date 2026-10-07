/** Public Markdown renderer limits, shared with the instructions that describe them. */
export const mermaidLimits = { sourceBytes: 16_384, edges: 300 } as const;
export const mathLimits = { sourceBytes: 16_384, svgBytes: 524_288, elements: 5000, pathBytes: 409_600, coordinate: 500_000, widthEx: 256, heightEx: 128 } as const;
export const svgLimits = { sourceBytes: 65_536, elements: 1500, depth: 32, expandedElements: 5000, geometryBytes: 65_536, expandedGeometryBytes: 262_144 } as const;

/** Pagination limits for participant tools and their shared data queries. */
export const participantListLimits = {
	defaultProfiles: 20, maximumProfiles: 50, maximumFollowers: 50,
	defaultActivity: 10, maximumActivity: 20, maximumNoteFilters: 10,
} as const;
