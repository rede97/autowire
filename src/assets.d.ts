// Text-import declarations for embedded browser assets (src/web/server.ts).
// tsc has no attribute-driven module typing (`with { type: "text" }` is a Bun
// feature), so the two asset paths are declared here explicitly.

declare module "../../out/web/aw.js" {
	const text: string;
	export default text;
}

declare module "../../out/web/page.js" {
	const text: string;
	export default text;
}

// Browser runtime import of the built engine bundle (out/web/aw.js is served at
// /aw.js); the ambient module re-exports the engine's typed API so the page
// controller typechecks against src/core/aw.ts (single source of truth).
