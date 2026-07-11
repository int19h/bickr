declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {}
	export const env: ProvidedEnv;
}

declare module "*.sql?raw" {
	const content: string;
	export default content;
}

declare module "*.ts?raw" {
	const content: string;
	export default content;
}
