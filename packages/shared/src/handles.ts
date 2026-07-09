export function tombstoneHandle(id: string): string {
	return `deleted-${id.replace(/[^a-z0-9_-]/gi, "-").slice(0, 24)}`.slice(0, 32);
}
