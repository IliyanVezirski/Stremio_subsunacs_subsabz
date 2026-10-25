const { test } = require('node:test');
const assert = require('node:assert/strict');
const { movieMatch, queryVariants, yearsMatch } = require('../lib/titles');
test('movie matching rejects sequels and partial word overlap', () => {
    assert.equal(movieMatch('The Matrix 2', 'The Matrix', '1999').match, false);
    assert.equal(movieMatch('Lord of the Rings The Two Towers', 'Lord of the Rings The Return of the King', '2003').match, false);
    assert.equal(movieMatch('The Matrix 1999 1080p', 'The Matrix', '1999').match, true);
});
test('Roman sequel notation and apostrophes remain searchable', () => {
    assert.equal(movieMatch('The Godfather 2', 'The Godfather Part II', '1974').match, true);
    assert.ok(queryVariants('The Godfather Part II').includes('Godfather 2'));
    assert.equal(queryVariants("Schindler's List")[0], "Schindler's List");
});
test('adjacent premiere years are accepted, distinct remakes rejected', () => {
    assert.equal(yearsMatch('2000', '2001'), true);
    assert.equal(yearsMatch('1990', '2020'), false);
});
