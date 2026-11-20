// The live panel on stderr (spinners, build trees, progress bar): a frame
// redrawn in place below the scrolling output. Every frame line is cut to
// the terminal width minus one, so a frame line never wraps. A redraw moves
// the cursor up over the frame on screen and clears to the end of the
// screen. When the terminal shrinks it rewraps the rows already printed, so
// the frame's height is recomputed from each line's width at the current
// column count; while a resize is in progress (no resize event for 100 ms)
// drawing pauses and the last frame is drawn once at the final size.
// Lines printed above the panel (persist) go out unchanged, like echo.

const CSI = "\x1b[";
/** DEC synchronized output: the terminal shows the erase and the new frame
 *  together (ignored where unsupported). */
const SYNC_ON = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI colour sequences
const SGR = /\u001b\[[0-9;]*m/y;
const RESIZE_QUIET_MS = 100;

/** `line` cut to `width` visible columns (ANSI colour kept), with `…` when
 *  cut. */
export function fitWidth(line: string, width: number): string {
	if (Bun.stringWidth(line) <= width) return line;
	let out = "";
	let used = 0;
	let i = 0;
	while (i < line.length) {
		SGR.lastIndex = i;
		const sgr = SGR.exec(line);
		if (sgr) {
			out += sgr[0];
			i += sgr[0].length;
			continue;
		}
		const ch = String.fromCodePoint(line.codePointAt(i) as number);
		const w = Bun.stringWidth(ch);
		if (used + w > width - 1) break;
		out += ch;
		used += w;
		i += ch.length;
	}
	return `${out}…${CSI}0m`;
}

export class LivePanel {
	/** Visible width of each frame line on screen (empty: no frame). */
	private widths: number[] = [];
	private shown = "";
	private shownCols = 0;
	private pending?: string;
	private resizing?: Timer;
	private readonly onResize = (): void => {
		clearTimeout(this.resizing);
		this.resizing = setTimeout(() => {
			this.resizing = undefined;
			if (this.pending !== undefined) this.render(this.pending);
		}, RESIZE_QUIET_MS);
	};

	constructor(private readonly out: NodeJS.WriteStream = process.stderr) {
		out.on("resize", this.onResize);
	}

	/** Draw `text` (lines joined by "\n") as the frame. */
	render(text: string): void {
		this.pending = text;
		if (this.resizing) return;
		const cols = this.cols();
		if (text === this.shown && cols === this.shownCols) return;
		const rows = this.out.rows || 40;
		const lines = text
			.split("\n")
			.slice(0, Math.max(1, rows - 1))
			.map((l) => fitWidth(l, cols - 1));
		this.write(`${this.erase()}${lines.join("\n")}\n`);
		this.widths = lines.map((l) => Bun.stringWidth(l));
		this.shown = text;
		this.shownCols = cols;
	}

	/** Print `text` above the panel unchanged; the next render redraws the
	 *  frame below it. */
	persist(text: string): void {
		this.write(`${this.erase()}${text}\n`);
	}

	/** Remove the frame. */
	clear(): void {
		this.write(this.erase());
	}

	/** Remove the frame and stop listening for resizes. */
	stop(): void {
		clearTimeout(this.resizing);
		this.resizing = undefined;
		this.out.off("resize", this.onResize);
		this.clear();
	}

	private cols(): number {
		return Math.max(2, this.out.columns || 80);
	}

	/** Escape sequence that removes the frame on screen, at the current width. */
	private erase(): string {
		const cols = this.cols();
		const height = this.widths.reduce(
			(n, w) => n + Math.max(1, Math.ceil(w / cols)),
			0,
		);
		this.widths = [];
		this.shown = "";
		return height > 0 ? `\r${CSI}${height}A${CSI}J` : "";
	}

	private write(s: string): void {
		if (s) this.out.write(`${SYNC_ON}${s}${SYNC_OFF}`);
	}
}
