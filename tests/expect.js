// A harness whose feature is missing from the build under test skips, so run-all stays usable on older lines. A gate for a
// line that must carry the feature says so, and the skip becomes a failure (tests/run-all.sh):
//   EXPECT_FEATURES=all                          every guarded harness must find its feature
//   EXPECT_FEATURES=crafted-credit,mastery-award  these ones must (harness names)
//   EXPECT_CRAFTED_CREDIT=1                      one, by the harness name in upper case with - as _
// Called just before a skip; returns only when the feature is not expected.
const expected = (name) => {
  const list = String(process.env.EXPECT_FEATURES || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes('all') || list.includes(name) || process.env[`EXPECT_${String(name).toUpperCase().replace(/-/g, '_')}`] === '1';
};
module.exports = (name, why) => {
  if (!expected(name)) return;
  console.log(`FAIL  ${name} is expected (EXPECT_FEATURES), but ${why}`);
  process.exit(1);
};
module.exports.expected = expected;
