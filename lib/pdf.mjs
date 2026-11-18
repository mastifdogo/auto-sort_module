// JPEG pages -> one PDF, without libraries: each page is the JPEG itself
// (DCTDecode), A4 wide. Used for scanner pages; the page's Scan tab does the
// same in the browser for camera photos.

/** A JPEG's size and colour components from its SOF marker, or null if it isn't a JPEG. */
export function jpegInfo(b) {
	if (!(b[0] === 0xff && b[1] === 0xd8)) return null;
	let i = 2;
	while (i + 9 < b.length) {
		if (b[i] !== 0xff) return null;
		const marker = b[i + 1];
		if (marker === 0xff) {
			i++; // fill byte
			continue;
		}
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			i += 2;
			continue;
		}
		const len = b.readUInt16BE(i + 2);
		// SOF0-3, 5-7, 9-11, 13-15 (not DHT C4, JPG C8, DAC CC)
		if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
			return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7), components: b[i + 9] };
		}
		if (marker === 0xda) return null; // image data before a frame header
		i += 2 + len;
	}
	return null;
}

/** pages: Buffer[] of JPEGs -> Buffer (PDF). */
export function jpegsToPdf(pages) {
	const parts = [];
	const offsets = [];
	let len = 0;
	const push = (x) => {
		const b = typeof x === "string" ? Buffer.from(x, "latin1") : x;
		parts.push(b);
		len += b.length;
	};
	const obj = (n, ...body) => {
		offsets[n] = len;
		push(`${n} 0 obj\n`);
		body.forEach(push);
		push("\nendobj\n");
	};
	const infos = pages.map((p, i) => {
		const info = jpegInfo(p);
		if (!info) throw new Error(`page ${i + 1} isn't a JPEG`);
		return info;
	});
	push("%PDF-1.4\n");
	push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
	obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
	obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ")}] /Count ${pages.length} >>`);
	pages.forEach((jpeg, i) => {
		const { width, height, components } = infos[i];
		const n = 3 + i * 3;
		const pw = 595.28;
		const ph = +((height * pw) / width).toFixed(2);
		const draw = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
		const space = components === 1 ? "/DeviceGray" : components === 4 ? "/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]" : "/DeviceRGB";
		obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
		obj(n + 1, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
		obj(n + 2, `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, "\nendstream");
	});
	const count = 3 + pages.length * 3;
	const xref = len;
	push(`xref\n0 ${count}\n0000000000 65535 f \n`);
	for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
	push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
	return Buffer.concat(parts, len);
}
