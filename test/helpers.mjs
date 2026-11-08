
export const PDF = Buffer.from("%PDF-1.4 fake pdf bytes \x00\x01\x02");

/** A bill email: multipart/alternative text + HTML, with a PDF attachment. */
export function sampleEmail({ subject = "Your Rogers bill", messageId = "abc@rogers.com", html = true } = {}) {
	const b64 = PDF.toString("base64");
	return Buffer.from(
		[
			"From: =?UTF-8?Q?Rogers_Billing?= <billing@rogers.com>",
			`Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
			"Date: Tue, 03 Mar 2026 10:00:00 -0500",
			`Message-ID: <${messageId}>`,
			"MIME-Version: 1.0",
			'Content-Type: multipart/mixed; boundary="outer"',
			"",
			"--outer",
			'Content-Type: multipart/alternative; boundary="inner"',
			"",
			"--inner",
			"Content-Type: text/plain; charset=utf-8",
			"Content-Transfer-Encoding: quoted-printable",
			"",
			"Amount due: $85.50 =E2=80=94 due March 20, 2026.=",
			" Thanks.",
			"--inner",
			"Content-Type: text/html; charset=utf-8",
			"",
			html ? "<html><body><p>Amount due: <b>$85.50</b></p></body></html>" : "",
			"--inner--",
			"--outer",
			'Content-Type: application/octet-stream; name="bill.pdf"',
			"Content-Disposition: attachment; filename*=utf-8''Rogers%20March.pdf",
			"Content-Transfer-Encoding: base64",
			"",
			b64.slice(0, 20),
			b64.slice(20),
			"--outer--",
			"",
		].join("\r\n"),
	);
}

/** A tiny IMAP server: one folder, messages by UID. Records every command. */
