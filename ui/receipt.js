// Finding a receipt in a photo, straightening it and cleaning it up, in the
// browser with a canvas (no libraries). Used by the Scan tab's camera.
//
//   Receipt.detect(canvas)            -> { corners: [tl, tr, br, bl], found } in canvas pixels
//   Receipt.warp(canvas, corners, max) -> a new canvas, the receipt seen straight on
//   Receipt.cleanUp(canvas)           -> the same canvas, black text on white paper
//
// detect(): receipts are paler than what they lie on. On a small copy of the
// photo: a light/dark threshold (Otsu's), the largest light region, its convex
// hull, and the four hull points enclosing the most area. A region too small,
// too large or not four-sided enough isn't trusted (found: false, corners =
// the whole photo), and the person drags the corners either way.
"use strict";
(function () {
	const SMALL = 320;

	function gray(data, n) {
		const g = new Float32Array(n);
		for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
		return g;
	}

	function otsu(g) {
		const hist = new Array(256).fill(0);
		for (const v of g) hist[Math.min(255, v | 0)]++;
		const total = g.length;
		let sum = 0;
		for (let i = 0; i < 256; i++) sum += i * hist[i];
		let sumB = 0, wB = 0, best = 0, t = 128;
		for (let i = 0; i < 256; i++) {
			wB += hist[i];
			if (!wB) continue;
			const wF = total - wB;
			if (!wF) break;
			sumB += i * hist[i];
			const mB = sumB / wB, mF = (sum - sumB) / wF;
			const between = wB * wF * (mB - mF) * (mB - mF);
			if (between > best) { best = between; t = i; }
		}
		return t;
	}

	/** The largest 4-connected region of mask (Uint8Array w*h) → Int32Array of pixel indexes. */
	function largestRegion(mask, w, h) {
		const seen = new Uint8Array(w * h);
		const stack = new Int32Array(w * h);
		let best = null;
		for (let start = 0; start < w * h; start++) {
			if (!mask[start] || seen[start]) continue;
			let top = 0, n = 0;
			const pixels = [];
			stack[top++] = start;
			seen[start] = 1;
			while (top) {
				const p = stack[--top];
				pixels.push(p);
				n++;
				const x = p % w, y = (p / w) | 0;
				if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[top++] = p - 1; }
				if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[top++] = p + 1; }
				if (y > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[top++] = p - w; }
				if (y < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[top++] = p + w; }
			}
			if (!best || n > best.length) best = pixels;
		}
		return best || [];
	}

	const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	function hull(points) {
		const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		const lower = [], upper = [];
		for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
		for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
		return lower.slice(0, -1).concat(upper.slice(0, -1));
	}
	const area = (q) => { let s = 0; for (let i = 0; i < q.length; i++) { const a = q[i], b = q[(i + 1) % q.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; };

	/** Four of the hull's points (in order) enclosing the most area. */
	function bestQuad(h) {
		let pts = h;
		if (pts.length > 48) { const step = pts.length / 48; pts = Array.from({ length: 48 }, (_, i) => h[Math.floor(i * step)]); }
		const n = pts.length;
		if (n < 4) return null;
		let best = null, bestArea = -1;
		for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) {
			const q = [pts[a], pts[b], pts[c], pts[d]];
			const s = area(q);
			if (s > bestArea) { bestArea = s; best = q; }
		}
		return best;
	}

	/** [tl, tr, br, bl] from four points in any order. */
	function order(q) {
		const bySum = q.slice().sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
		const tl = bySum[0], br = bySum[3];
		const rest = [bySum[1], bySum[2]].sort((a, b) => a[0] - a[1] - (b[0] - b[1]));
		return [tl, rest[1], br, rest[0]];
	}

	function detect(canvas) {
		const W = canvas.width, H = canvas.height;
		const whole = { corners: [[0, 0], [W, 0], [W, H], [0, H]], found: false };
		const k = Math.min(1, SMALL / Math.max(W, H));
		const w = Math.max(8, Math.round(W * k)), h = Math.max(8, Math.round(H * k));
		const c = document.createElement("canvas");
		c.width = w;
		c.height = h;
		const g2 = c.getContext("2d", { willReadFrequently: true });
		g2.drawImage(canvas, 0, 0, w, h);
		const g = gray(g2.getImageData(0, 0, w, h).data, w * h);
		const t = otsu(g);
		const mask = new Uint8Array(w * h);
		let light = 0;
		for (let i = 0; i < g.length; i++) if (g[i] > t) { mask[i] = 1; light++; }
		// Mostly light: the paper fills the photo, or the background is light too.
		if (light < 0.04 * w * h || light > 0.92 * w * h) return whole;
		const region = largestRegion(mask, w, h);
		if (region.length < 0.06 * w * h) return whole;
		// Only the region's outline matters for the hull: its pixels with a dark or edge neighbour.
		const edge = [];
		for (const p of region) {
			const x = p % w, y = (p / w) | 0;
			if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[p - 1] || !mask[p + 1] || !mask[p - w] || !mask[p + w]) edge.push([x, y]);
		}
		const q = bestQuad(hull(edge));
		if (!q) return whole;
		const qa = area(q);
		// Four-sided enough (the quad covers most of the region) and not the whole photo.
		if (qa < 0.75 * region.length || qa > 0.97 * w * h) return whole;
		const corners = order(q).map(([x, y]) => [Math.min(W, Math.max(0, (x + 0.5) / k)), Math.min(H, Math.max(0, (y + 0.5) / k))]);
		return { corners, found: true };
	}

	/** The 3x3 homography mapping the unit square's corners (0,0),(1,0),(1,1),(0,1) to q. */
	function squareToQuad(q) {
		const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
		const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
		const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
		const den = dx1 * dy2 - dx2 * dy1;
		const g = (dx3 * dy2 - dx2 * dy3) / den, hh = (dx1 * dy3 - dx3 * dy1) / den;
		return [x1 - x0 + g * x1, x3 - x0 + hh * x3, x0, y1 - y0 + g * y1, y3 - y0 + hh * y3, y0, g, hh, 1];
	}
	const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

	function warp(canvas, corners, maxSide = 2000) {
		const [tl, tr, br, bl] = corners;
		let w = Math.max(dist(tl, tr), dist(bl, br)), h = Math.max(dist(tl, bl), dist(tr, br));
		const k = Math.min(1, maxSide / Math.max(w, h));
		w = Math.max(1, Math.round(w * k));
		h = Math.max(1, Math.round(h * k));
		const src = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
		const S = src.data, SW = canvas.width, SH = canvas.height;
		const out = document.createElement("canvas");
		out.width = w;
		out.height = h;
		const og = out.getContext("2d");
		const img = og.createImageData(w, h);
		const D = img.data;
		const m = squareToQuad(corners);
		for (let y = 0; y < h; y++) {
			const v = (y + 0.5) / h;
			for (let x = 0; x < w; x++) {
				const u = (x + 0.5) / w;
				const z = m[6] * u + m[7] * v + m[8];
				let sx = (m[0] * u + m[1] * v + m[2]) / z - 0.5, sy = (m[3] * u + m[4] * v + m[5]) / z - 0.5;
				sx = Math.min(SW - 1.001, Math.max(0, sx));
				sy = Math.min(SH - 1.001, Math.max(0, sy));
				const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
				const i00 = (y0 * SW + x0) * 4, i10 = i00 + 4, i01 = i00 + SW * 4, i11 = i01 + 4;
				const o = (y * w + x) * 4;
				for (let c = 0; c < 3; c++) {
					const top = S[i00 + c] + (S[i10 + c] - S[i00 + c]) * fx;
					const bot = S[i01 + c] + (S[i11 + c] - S[i01 + c]) * fx;
					D[o + c] = top + (bot - top) * fy;
				}
				D[o + 3] = 255;
			}
		}
		og.putImageData(img, 0, 0);
		return out;
	}

	/** Grey, with the paper made white and the print dark: levels from the photo's own spread. */
	function cleanUp(canvas) {
		const g = canvas.getContext("2d", { willReadFrequently: true });
		const img = g.getImageData(0, 0, canvas.width, canvas.height);
		const D = img.data, n = canvas.width * canvas.height;
		const lum = gray(D, n);
		const hist = new Array(256).fill(0);
		for (const v of lum) hist[Math.min(255, v | 0)]++;
		const at = (frac) => { let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= frac * n) return i; } return 255; };
		const black = at(0.02), white = Math.max(black + 20, at(0.6)); // most of a receipt is paper
		for (let i = 0, j = 0; i < n; i++, j += 4) {
			let v = (lum[i] - black) / (white - black);
			v = Math.min(1, Math.max(0, v));
			v = Math.pow(v, 1.6) * 255; // darken faint thermal print
			D[j] = D[j + 1] = D[j + 2] = v;
		}
		g.putImageData(img, 0, 0);
		return canvas;
	}

	window.Receipt = { detect, warp, cleanUp };
})();
