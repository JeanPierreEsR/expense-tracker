// The Projections drill-down computes ONE category (not all of them, for speed).
// Its numbers must be exactly the ones the category list shows for that category.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

for (const displayPeriodType of ["month", "year"]) {
  test(`detail of each category equals its row in the list (${displayPeriodType})`, () => {
    const { rt } = freshApp({ entries: 600 });
    const list = rt.api("listCategoryProjections", { displayPeriodType }).categories;
    assert.ok(list.length > 3, "the made-up data should give several categories");
    for (const row of list) {
      const detail = rt.api("getCategoryProjectionDetail", { categoryId: row.category_id, displayPeriodType });
      assert.deepEqual(detail.projection, row, row.category_name);
    }
  });
}

test("detail of a category with nothing to show still returns a zeroed shape", () => {
  const { rt } = freshApp({ entries: 50 });
  const detail = rt.api("getCategoryProjectionDetail", { categoryId: "no-such-category", displayPeriodType: "month" });
  assert.equal(detail.projection.totalPen, 0);
});
