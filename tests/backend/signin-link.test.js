// The sign-in text that carries a new person's app from the setup page to the app icon
// (docs/signin-link.js). Made-up addresses and codes only.
const test = require("node:test");
const assert = require("node:assert/strict");
const SigninLink = require("../../docs/signin-link.js");

const URL1 = "https://script.google.com/macros/s/AKfycbMadeUpAddressForTests1234567890/exec";
const CODE = "0123456789abcdef0123456789abcdef";

test("what is made can be read back", () => {
  const text = SigninLink.make(URL1, CODE);
  assert.ok(text.startsWith("ETSIGNIN1:"));
  assert.deepEqual(SigninLink.parse(text), { url: URL1, code: CODE });
});

test("the text survives what a phone does to pasted text: extra words, spaces, line wraps", () => {
  const text = SigninLink.make(URL1, CODE);
  assert.deepEqual(SigninLink.parse("  " + text + "\n"), { url: URL1, code: CODE });
  assert.deepEqual(SigninLink.parse("Here you go: " + text + " thanks"), { url: URL1, code: CODE });
  const wrapped = text.replace(/(.{40})/g, "$1\n");
  assert.deepEqual(SigninLink.parse(wrapped), { url: URL1, code: CODE });
});

test("anything that is not a sign-in gives null, never an error", () => {
  for (const bad of ["", null, undefined, "hello", "ETSIGNIN1:", "ETSIGNIN1:!!!", "ETSIGNIN1:aGVsbG8", 42, {}]) {
    assert.equal(SigninLink.parse(bad), null, String(bad));
  }
});

test("only a real Apps Script address is accepted (no other site can receive someone's code)", () => {
  const forge = (u, c) => "ETSIGNIN1:" + Buffer.from(JSON.stringify({ u, c })).toString("base64url");
  assert.equal(SigninLink.parse(forge("https://evil.example/macros/s/AKfycbMadeUpAddressForTests1234567890/exec", CODE)), null);
  assert.equal(SigninLink.parse(forge("http://script.google.com/macros/s/AKfycbMadeUpAddressForTests1234567890/exec", CODE)), null, "https only");
  assert.equal(SigninLink.parse(forge("https://script.google.com/macros/s/AKfycbMadeUpAddressForTests1234567890/exec?x=1", CODE)), null, "no extra query");
  assert.equal(SigninLink.parse(forge("https://script.google.com/macros/s/short/exec", CODE)), null);
  assert.deepEqual(SigninLink.parse(forge(URL1, CODE)), { url: URL1, code: CODE });
});

test("a code with spaces, markup or the wrong length is refused", () => {
  const forge = (c) => "ETSIGNIN1:" + Buffer.from(JSON.stringify({ u: URL1, c })).toString("base64url");
  for (const bad of ["short", "has space has space has space", "<script>alert(1)</script>0000", "a".repeat(65), ""]) {
    assert.equal(SigninLink.parse(forge(bad)), null, bad);
  }
});

test("localhost is accepted only when asked (the test server on the Mac)", () => {
  const local = SigninLink.make("http://localhost:4180/api", CODE);
  assert.equal(SigninLink.parse(local), null);
  assert.deepEqual(SigninLink.parse(local, { allowLocal: true }), { url: "http://localhost:4180/api", code: CODE });
});

test("making a sign-in from bad details throws, so the setup page can never copy a broken one", () => {
  assert.throws(() => SigninLink.make("https://evil.example/x", CODE));
  assert.throws(() => SigninLink.make(URL1, "short"));
});
