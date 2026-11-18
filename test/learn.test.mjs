import assert from "node:assert/strict";
import { test } from "node:test";
import { baseDomain, features, judge, learner, model, readTrainingFile, senderAddress, TRAINING_FORMAT } from "../lib/learn.mjs";

const news = { from: "Shop Deals <deals@e.shop.com>", subject: "Your weekly receipt of savings" };
const bill = { from: "Hydro One <bills@hydroone.com>", subject: "Your November bill is ready" };

test("features: sender, domain, subject and file name words, file type", () => {
	assert.equal(senderAddress("Hydro One <Bills@HydroOne.com>"), "bills@hydroone.com");
	assert.equal(baseDomain("mail.e.shop.com"), "shop.com");
	assert.equal(baseDomain("billing.bank.co.uk"), "bank.co.uk");
	const f = features(news, { name: "Weekly-Flyer_2026.pdf" });
	for (const x of ["from:deals@e.shop.com", "domain:shop.com", "s:weekly", "s:receipt", "s:savings", "ext:pdf", "a:weekly", "a:flyer"]) assert.ok(f.includes(x), x);
	assert.ok(!f.includes("s:your") && !f.includes("s:of"), "stop words and short words are left out");
	assert.deepEqual(features(bill, null).filter((x) => x.startsWith("kind:")), ["kind:email"]);
});

test("nothing learned: nothing skipped", () => {
	assert.equal(judge(model([]), features(news, { name: "flyer.pdf" })).skip, false);
});

test("one deletion from a sender skips the same kind of file from it, not other senders", () => {
	const m = model([{ label: -1, features: features(news, { name: "Weekly-Flyer.pdf" }) }]);
	const again = judge(m, features({ ...news, subject: "Your weekly savings are here" }, { name: "Weekly-Flyer.pdf" }));
	assert.equal(again.skip, true);
	assert.match(again.reason, /1 file you deleted from this sender/);
	// another sender with similar words isn't skipped: there's nothing deleted from it
	const other = judge(m, features({ from: "Costco <news@costco.ca>", subject: "Your weekly savings" }, { name: "Weekly-Flyer.pdf" }));
	assert.equal(other.skip, false);
	// the bill sender is untouched
	assert.equal(judge(m, features(bill, { name: "invoice-1102.pdf" })).skip, false);
});

test("files you kept from a sender outweigh a deletion of something else from it", () => {
	const ex = [{ label: -1, features: features(bill, { name: "terms-and-conditions.pdf" }) }];
	for (const month of ["September", "October", "November"]) ex.push({ label: 1, features: features({ ...bill, subject: `Your ${month} bill is ready` }, { name: `invoice-${month}.pdf` }) });
	const m = model(ex);
	const invoice = judge(m, features({ ...bill, subject: "Your December bill is ready" }, { name: "invoice-December.pdf" }));
	assert.equal(invoice.skip, false);
	assert.ok(invoice.p < 0.5, `p = ${invoice.p}`);
	// but the terms PDF that comes with each bill is learned: delete it twice and it's skipped
	ex.push({ label: -1, features: features({ ...bill, subject: "Your October bill is ready" }, { name: "terms-and-conditions.pdf" }) });
	const terms = judge(model(ex), features({ ...bill, subject: "Your December bill is ready" }, { name: "terms-and-conditions.pdf" }));
	assert.equal(terms.skip, true, `p = ${terms.p}`);
	assert.match(terms.reason, /file name word "(terms|conditions)"/);
});

test("training file: checked when loaded", () => {
	const ok = readTrainingFile({ format: TRAINING_FORMAT, examples: [{ label: -1, features: ["from:a@b.com", "s:sale"], sender: "A", source: "delete" }] });
	assert.deepEqual(ok[0], { label: -1, features: ["from:a@b.com", "s:sale"], sender: "A", subject: "", file_name: "", source: "delete" });
	assert.throws(() => readTrainingFile({ examples: [] }), /isn't an Import training file/);
	assert.throws(() => readTrainingFile({ format: TRAINING_FORMAT, examples: [{ label: 0, features: ["s:x"] }] }), /label must be/);
	assert.throws(() => readTrainingFile({ format: TRAINING_FORMAT, examples: [{ label: 1, features: ["no colon"] }] }), /features must be/);
});

test("deleting one sender's extra PDF doesn't skip its invoices", () => {
	const m = model([{ label: -1, features: features(bill, { name: "terms-and-conditions.pdf" }) }]);
	assert.equal(judge(m, features({ ...bill, subject: "Your December bill is ready" }, { name: "invoice-1203.pdf" })).skip, false);
	assert.equal(judge(m, features({ ...bill, subject: "Your December bill is ready" }, { name: "terms-and-conditions.pdf" })).skip, true);
});

test("a sender deleted three times and never kept is skipped whatever the file", () => {
	const ex = ["a.pdf", "b.pdf", "c.pdf"].map((n, i) => ({ label: -1, features: features({ ...news, subject: `Deal ${i} weekly savings` }, { name: n }) }));
	assert.equal(judge(model(ex), features({ ...news, subject: "Weekly savings inside" }, { name: "brand-new.pdf" })).skip, true);
});

test("each sender is judged on its own examples: a deletion elsewhere doesn't tilt it", () => {
	const ex = [
		{ label: -1, features: features(news, { name: "weekly-flyer.pdf" }) },
		{ label: -1, features: features({ ...bill, subject: "Your October bill" }, { name: "terms-and-conditions.pdf" }) },
		{ label: 1, features: features({ ...bill, subject: "Your October bill" }, { name: "invoice-1001.pdf" }) },
	];
	const l = learner(ex);
	assert.equal(l.judge(features({ ...bill, subject: "Your November bill" }, { name: "terms-and-conditions.pdf" })).skip, true);
	assert.equal(l.judge(features({ ...bill, subject: "Your November bill" }, { name: "invoice-1102.pdf" })).skip, false);
	assert.equal(l.judge(features({ from: "Rogers <billing@rogers.com>", subject: "Your invoice" }, { name: "weekly-flyer.pdf" })).skip, false);
});
