'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { baseUrl } = require('../src/venue-client');

test('venue base URLs are normalised before API paths are appended', () => {
  assert.equal(baseUrl('https://api.example.com.au///'), 'https://api.example.com.au');
});

