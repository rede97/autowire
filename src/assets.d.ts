// Text-import declarations for embedded browser assets (src/web.ts).
// tsc has no attribute-driven module typing (`with { type: "text" }` is a Bun
// feature), so the two asset paths are declared here explicitly.

declare module "../web/aw.js" {
	const text: string;
	export default text;
}

declare module "../web/page.js" {
	const text: string;
	export default text;
}
